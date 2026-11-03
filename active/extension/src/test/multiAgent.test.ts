/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, describe, test } from 'node:test';
import { AgentManager, toolFiles } from '../agents/agentManager';
import { branchSlug, parseChangedRanges, rangesOverlap, runGit, WorktreeManager } from '../agents/worktrees';
import { ExplainerGate } from '../explain/planner';
import { agentSection, buildBriefingPrompt } from '../explain/prompts';
import { subagentLines, workflowInputs } from '../controller';
import { DEFAULT_PROFILE } from '../shared/activeProtocol';

const scratch: string[] = [];
after(async () => {
	for (const dir of scratch) {
		await fs.rm(dir, { recursive: true, force: true });
	}
});

async function repo(): Promise<{ root: string; worktrees: WorktreeManager }> {
	const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'active-wt-test-')));
	scratch.push(dir);
	const root = path.join(dir, 'project');
	await fs.mkdir(root);
	await runGit(root, ['init', '--quiet', '-b', 'main']);
	await fs.writeFile(path.join(root, 'a.js'), 'one\ntwo\nthree\nfour\nfive\n');
	await fs.writeFile(path.join(root, 'b.js'), 'export const b = 1;\n');
	await runGit(root, ['add', '-A']);
	await runGit(root, ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '--quiet', '-m', 'start']);
	return { root, worktrees: new WorktreeManager(root, path.join(dir, 'worktrees'), () => undefined) };
}

describe('agent worktrees', () => {
	test('a new agent starts from the folder as the developer sees it, uncommitted and untracked files included', async () => {
		const { root, worktrees } = await repo();
		await fs.writeFile(path.join(root, 'b.js'), 'export const b = 2;\n');
		await fs.writeFile(path.join(root, 'notes.txt'), 'draft\n');
		const worktree = await worktrees.create('a1xyz', 'Agent 2');
		assert.match(worktree.branch, /^active\/agent-2-/);
		assert.equal(await fs.readFile(path.join(worktree.root, 'b.js'), 'utf8'), 'export const b = 2;\n');
		assert.equal(await fs.readFile(path.join(worktree.root, 'notes.txt'), 'utf8'), 'draft\n');
		// The developer's folder is untouched and nothing is committed on their branch.
		assert.equal((await runGit(root, ['rev-list', '--count', 'HEAD'])).stdout.trim(), '1');
		assert.deepEqual(await worktrees.changes(worktree.root, worktree.base), []);
		await worktrees.remove(worktree);
		await assert.rejects(fs.stat(worktree.root));
	});

	test('merging writes clean changes, and leaves conflict markers where both sides changed the same lines', async () => {
		const { root, worktrees } = await repo();
		const second = await worktrees.create('a2xyz', 'Agent 2');
		await fs.writeFile(path.join(second.root, 'a.js'), 'one\nTWO\nthree\nfour\nfive\n');
		await fs.writeFile(path.join(second.root, 'c.js'), 'new file\n');
		await fs.writeFile(path.join(root, 'a.js'), 'one\ntwo\nthree\nfour\nFIVE\n');
		const clean = await worktrees.merge({ root: second.root, base: second.base, name: 'Agent 2' }, { root, name: 'Agent 1' });
		assert.deepEqual([...clean.files].sort(), ['a.js', 'c.js']);
		assert.deepEqual(clean.conflicts, []);
		assert.equal(await fs.readFile(path.join(root, 'a.js'), 'utf8'), 'one\nTWO\nthree\nfour\nFIVE\n');
		assert.equal(await fs.readFile(path.join(root, 'c.js'), 'utf8'), 'new file\n');

		const third = await worktrees.create('a3xyz', 'Agent 3');
		await fs.writeFile(path.join(third.root, 'b.js'), 'export const b = 3;\n');
		await fs.writeFile(path.join(root, 'b.js'), 'export const b = 4;\n');
		const clash = await worktrees.merge({ root: third.root, base: third.base, name: 'Agent 3' }, { root, name: 'Agent 1' });
		assert.deepEqual(clash.conflicts, ['b.js']);
		const merged = await fs.readFile(path.join(root, 'b.js'), 'utf8');
		assert.match(merged, /<<<<<<< Agent 1\nexport const b = 4;\n=======\nexport const b = 3;\n>>>>>>> Agent 3/);
	});

	test('changed line ranges say whether two agents touched the same lines', async () => {
		const { root, worktrees } = await repo();
		const second = await worktrees.create('a4xyz', 'Agent 2');
		await fs.writeFile(path.join(second.root, 'a.js'), 'one\nTWO\nthree\nfour\nfive\n');
		await fs.writeFile(path.join(root, 'a.js'), 'one\ntwo\nthree\nfour\nFIVE\n');
		const mine = await worktrees.changedRanges(root, 'HEAD');
		const theirs = await worktrees.changedRanges(second.root, second.base);
		assert.deepEqual(mine.get('a.js'), [[5, 5]]);
		assert.deepEqual(theirs.get('a.js'), [[2, 2]]);
		assert.equal(rangesOverlap(mine.get('a.js')!, theirs.get('a.js')!), false);
		assert.equal(rangesOverlap([[2, 4]], [[4, 9]]), true);
		assert.equal(rangesOverlap([[2, 2]], [[3, 3]]), true, 'adjacent lines conflict in a merge too');
	});

	test('diff hunks parse into old-side ranges; insertions (and new files) mark their boundary', () => {
		const ranges = parseChangedRanges('--- a/x.js\n+++ b/x.js\n@@ -3,2 +3,3 @@\n@@ -10,0 +12,2 @@\n--- /dev/null\n+++ b/new.js\n@@ -0,0 +1,4 @@\n');
		assert.deepEqual(ranges.get('x.js'), [[3, 4], [10, 10]]);
		assert.deepEqual(ranges.get('new.js'), [[0, 0]], 'two agents creating the same file overlap at its start');
		assert.equal(branchSlug('Fix the Retry Logic!'), 'fix-the-retry-logic');
	});
});

describe('several agents sharing the explainer', () => {
	test('one request at a time: the developer\'s questions first, then the highlighted agent\'s work, then the rest in order', async () => {
		let focused = 'b';
		const gate = new ExplainerGate(() => 1, () => focused);
		const order: string[] = [];
		const hold = await gate.acquire('a', false);
		const waiting = [
			gate.acquire('a', false).then(release => { order.push('a background'); release(); }),
			gate.acquire('c', false).then(release => { order.push('c background'); release(); }),
			gate.acquire('b', false).then(release => { order.push('b background'); release(); }),
			gate.acquire('c', true).then(release => { order.push('c question'); release(); }),
		];
		focused = 'b';
		hold();
		await Promise.all(waiting);
		assert.deepEqual(order, ['c question', 'b background', 'a background', 'c background']);
	});
});

describe('explaining work from several agents', () => {
	test('a single agent with no helpers adds nothing to the prompt', () => {
		assert.equal(agentSection(undefined), '');
	});

	test('the planner hears whose work it is, what subagents did, what was merged in (not to explain) and overlaps', () => {
		const section = agentSection({
			name: 'Agent 2',
			subagents: [{ name: 'tester', objective: 'Write tests for the retry logic', status: 'resultReady', result: 'Added 4 tests', files: ['test/retry.test.js'] }],
			mergedIn: [{ from: 'Agent 3', task: 'Add caching', files: ['cache.js'], conflicts: ['client.js'] }],
			overlaps: [{ agent: 'Agent 1', path: 'client.js', sameLines: true }],
		});
		assert.match(section, /This work was done by Agent 2/);
		assert.match(section, /SUBAGENTS[\s\S]*tester: "Write tests for the retry logic" \(resultReady\); touched test\/retry\.test\.js; reported: Added 4 tests/);
		assert.match(section, /a subagent wrote these tests/);
		assert.match(section, /MERGED IN \(not Agent 2's work, and already explained separately: do NOT explain these changes/);
		assert.match(section, /From Agent 3 \("Add caching"\): cache\.js; conflicts in client\.js/);
		assert.match(section, /client\.js: also Agent 1 \(the same lines: likely to conflict on merge\)/);
	});

	test('briefings: a very short one for one agent, and one across all agents grouped by agent', () => {
		const turn = { agent: 'Agent 2', task: 'Add caching', outcome: 'completed', explanation: 'Walkthrough: Caching', notes: [], failedCommands: [], pendingChecks: [], files: [] };
		const short = buildBriefingPrompt({ profile: DEFAULT_PROFILE, minutesAway: 9, turns: [turn], waiting: [], short: true });
		assert.match(short, /SHORT CATCH-UP[\s\S]*at most three short lines/);
		const all = buildBriefingPrompt({ profile: DEFAULT_PROFILE, minutesAway: 30, turns: [turn], waiting: [], allAgents: [{ agentId: 'a1', name: 'Agent 2', waiting: ['Run a shell command: npm test'] }], overlaps: ['Agent 1 and Agent 2 both changed client.js'] });
		assert.match(all, /ALL-AGENTS BRIEFING[\s\S]*grouped by agent/);
		assert.match(all, /\[Agent 2\] TASK: Add caching/);
		assert.match(all, /Agent 2 \(agentId a1\); waiting on the developer: Run a shell command: npm test/);
		assert.match(all, /OVERLAPS\n- Agent 1 and Agent 2 both changed client\.js/);
	});

	test('a helper\'s lines are found in the final file, even after the parent changed some of them', () => {
		const before = 'import x;\n\ntest(\'a\', () => {});\n';
		const after = 'import x;\n\ntest(\'a\', () => {});\ntest(\'b\', () => {\n\tassert.equal(f(2), 4);\n});\n';
		const intact = subagentLines(new Map([['t.js', { before, after }]]), { 't.js': { path: 't.js', baseline: before, final: after, added: 3, removed: 0 } });
		assert.deepEqual(intact, [{ path: 't.js', ranges: '4-6', intact: true }]);
		// The parent rewrote the assertion afterwards: that line is no longer the helper's.
		const final = 'import x;\n\ntest(\'a\', () => {});\ntest(\'b\', () => {\n\tassert.equal(f(2), 5);\n});\n';
		const changed = subagentLines(new Map([['t.js', { before, after }]]), { 't.js': { path: 't.js', baseline: before, final, added: 3, removed: 0 } });
		assert.deepEqual(changed, [{ path: 't.js', ranges: '4-6', intact: false }]);
		assert.deepEqual(subagentLines(undefined, {}), []);
	});

	test('helpers\' real tasks are read from the workflow script that started them', () => {
		const script = 'export default async function workflow(host) {\n  const a = host.agent({ input: "In test/x.js, add tests for \\"limit\\"." });\n  const b = host.agent({ input: `Document the units in README.md` });\n  return {};\n}';
		assert.deepEqual(workflowInputs(JSON.stringify({ script })), ['In test/x.js, add tests for "limit".', 'Document the units in README.md']);
		assert.deepEqual(workflowInputs(script), ['In test/x.js, add tests for "limit".', 'Document the units in README.md']);
		assert.deepEqual(workflowInputs(undefined), []);
	});

	test('the files a subagent\'s tool call touched are read from its arguments', () => {
		assert.deepEqual(toolFiles('{"path":"src/a.js","content":"x"}'), ['src/a.js']);
		assert.deepEqual(toolFiles('{"files":["a.js","b.js"]}'), ['a.js', 'b.js']);
		assert.deepEqual(toolFiles('not json'), []);
	});
});

describe('the agent manager', () => {
	/** A controller stand-in: enough for creating, routing and merging. */
	function fakeController(root: string, log: string[]) {
		return {
			busy: false,
			lastTask: undefined as string | undefined,
			currentState: () => ({ status: 'idle', provider: { id: 'muse', name: 'Muse Code', shortName: 'Muse', devOnly: false }, workspaceName: path.basename(root), backgroundTasks: 0 }),
			connect: async () => undefined,
			submitTask: async (request: unknown) => { log.push(`task ${root}: ${String(request)}`); },
			interrupt: async () => undefined,
			initialState: async () => ({ agent: {}, chat: [], turnChanges: [] }),
			noteSubagentFiles: () => undefined,
			receiveMerge: async (_from: unknown, apply: () => Promise<unknown>) => apply(),
			applyApprovalMode: async () => { log.push(`approvals ${root}`); },
			codingHostForWatching: undefined,
		};
	}

	test('agents start in their own worktrees; overlaps are found; a merge moves the work and nests the source', async () => {
		const { root, worktrees } = await repo();
		const events: string[] = [];
		let saved: unknown[] = [];
		const manager = new AgentManager({
			mainRoot: root,
			worktrees,
			createRuntime: spec => ({ controller: fakeController(spec.root, events) as never, dispose: () => events.push(`disposed ${spec.name}`) }),
			load: () => saved as never,
			save: specs => { saved = [...specs]; },
			emit: event => { if (event.type === 'agents') { events.push(`agents: ${event.agents.map(agent => agent.name).join(', ')}`); } },
			log: () => undefined,
			maxAgents: () => 3,
		});
		await manager.start();
		const created = await manager.create({});
		assert.ok(created.id, created.error);
		const second = manager.spec(created.id!)!;
		assert.equal(second.name, 'Agent 2');
		assert.equal(second.inMainFolder, false);
		assert.ok(second.root.includes('worktrees'));
		assert.equal(manager.controllerFor(created.id) === manager.main, false, 'requests for Agent 2 go to its own controller');
		manager.focus(created.id!);
		assert.equal(manager.controllerFor(), manager.controllerFor(created.id), 'requests without an agent go to the focused one');

		await fs.writeFile(path.join(second.root, 'a.js'), 'one\nTWO\nthree\nfour\nfive\n');
		await fs.writeFile(path.join(root, 'a.js'), 'ONE\ntwo\nthree\nfour\nfive\n');
		await manager.computeOverlaps();
		assert.deepEqual(manager.overlapLines(), ['Agent 1 and Agent 2 both changed a.js (the same lines: likely to conflict when merged)']);

		const result = await manager.merge(created.id!, 'main');
		assert.equal(result.ok, true, result.message);
		assert.deepEqual(result.conflicts, ['a.js'], 'adjacent lines conflict, as the overlap check predicted');
		assert.match(await fs.readFile(path.join(root, 'a.js'), 'utf8'), /^<<<<<<< Agent 1\nONE\ntwo\n=======\none\nTWO\n>>>>>>> Agent 2\n/);
		const info = manager.infos().find(agent => agent.id === created.id)!;
		assert.equal(info.mergedInto, 'main');
		assert.equal(info.finished, true);
		await assert.rejects(fs.stat(second.root), 'the merged agent\'s worktree is removed');
		assert.ok(events.includes('disposed Agent 2'));
		assert.equal(manager.focused, 'main', 'focus moves to the agent it was merged into');
		manager.dispose();
	});

	test('each agent has its own approval mode, applied to its session when changed', async () => {
		const { root, worktrees } = await repo();
		const log: string[] = [];
		let saved: unknown[] = [];
		const manager = new AgentManager({ mainRoot: root, worktrees, createRuntime: spec => ({ controller: fakeController(spec.root, log) as never, dispose: () => undefined }), load: () => saved as never, save: specs => { saved = [...specs]; }, emit: () => undefined, log: () => undefined, maxAgents: () => 0 });
		await manager.start();
		const second = (await manager.create({})).id!;
		assert.equal(manager.infos().find(agent => agent.id === second)!.approvalMode, 'auto', 'Muse\'s default unless changed');
		await manager.setApprovalMode(second, 'allowAll');
		assert.equal(manager.infos().find(agent => agent.id === second)!.approvalMode, 'allowAll');
		assert.equal(manager.infos().find(agent => agent.id === 'main')!.approvalMode, 'auto', 'other agents keep theirs');
		assert.ok(log.some(line => line.startsWith('approvals ') && line.includes('worktrees')));
		assert.equal((saved as Array<{ id: string; approvalMode?: string }>).find(spec => spec.id === second)?.approvalMode, 'allowAll', 'remembered across reloads');
		manager.dispose();
	});

	test('commit before merging commits each agent\'s work on its own branch and keeps the dragged one\'s', async () => {
		const { root, worktrees } = await repo();
		let saved: unknown[] = [];
		const manager = new AgentManager({ mainRoot: root, worktrees, createRuntime: spec => ({ controller: fakeController(spec.root, []) as never, dispose: () => undefined }), load: () => saved as never, save: specs => { saved = [...specs]; }, emit: () => undefined, log: () => undefined, maxAgents: () => 0 });
		await manager.start();
		const id = (await manager.create({})).id!;
		const second = manager.spec(id)!;
		await fs.writeFile(path.join(second.root, 'b.js'), 'export const b = 2;\n');
		await fs.writeFile(path.join(root, 'a.js'), 'one\ntwo\nthree\nfour\nFIVE\n');
		const result = await manager.merge(id, 'main', { commit: true });
		assert.equal(result.ok, true, result.message);
		assert.match(result.message, /committed on active\/agent-2-/);
		assert.match(result.message, /Agent 1's on your branch/);
		assert.equal((await runGit(root, ['log', '-1', '--format=%s %an'])).stdout.trim(), "Agent 1's work Active", 'the target\'s work is committed on its branch');
		assert.equal((await runGit(root, ['log', '-1', '--format=%s', second.branch!])).stdout.trim(), "Agent 2's work", 'the dragged agent\'s branch is kept with its commit');
		assert.equal(await fs.readFile(path.join(root, 'b.js'), 'utf8'), 'export const b = 2;\n', 'its work still arrives, uncommitted');
		assert.match((await runGit(root, ['status', '--short'])).stdout, /M b\.js/);
		manager.dispose();

		// A reload's cleanup keeps that branch, but removes an abandoned agent's leftovers.
		await runGit(root, ['branch', 'active/stray-agent-ab12']);
		await runGit(root, ['branch', 'active/mine']);
		await fs.mkdir(path.join(path.dirname(second.root), 'stray-ab12'), { recursive: true });
		const reloaded = new AgentManager({ mainRoot: root, worktrees, createRuntime: spec => ({ controller: fakeController(spec.root, []) as never, dispose: () => undefined }), load: () => saved as never, save: specs => { saved = [...specs]; }, emit: () => undefined, log: () => undefined, maxAgents: () => 0 });
		await reloaded.start();
		const branches = (await runGit(root, ['branch', '--list', 'active/*', '--format=%(refname:short)'])).stdout.split('\n').filter(Boolean).sort();
		assert.deepEqual(branches, [second.branch!, 'active/mine'].sort(), 'the kept branch and other branches stay; the stray agent branch goes');
		await assert.rejects(fs.stat(path.join(path.dirname(second.root), 'stray-ab12')));
		reloaded.dispose();
	});

	test('closing can commit the agent\'s work and keep its branch, or delete both', async () => {
		const { root, worktrees } = await repo();
		let saved: unknown[] = [];
		const manager = new AgentManager({ mainRoot: root, worktrees, createRuntime: spec => ({ controller: fakeController(spec.root, []) as never, dispose: () => undefined }), load: () => saved as never, save: specs => { saved = [...specs]; }, emit: () => undefined, log: () => undefined, maxAgents: () => 0 });
		await manager.start();
		const keep = manager.spec((await manager.create({})).id!)!;
		const drop = manager.spec((await manager.create({})).id!)!;
		await fs.writeFile(path.join(keep.root, 'kept.js'), 'kept\n');
		const kept = await manager.close(keep.id, { keep: true });
		assert.match(kept.message, /its work is committed on active\/agent-2-/);
		assert.equal((await runGit(root, ['show', `${keep.branch}:kept.js`])).stdout, 'kept\n');
		await manager.close(drop.id);
		const branches = (await runGit(root, ['branch', '--list', 'active/*', '--format=%(refname:short)'])).stdout.split('\n').filter(Boolean);
		assert.deepEqual(branches, [keep.branch!]);
		assert.deepEqual(manager.infos().map(agent => agent.id), ['main'], 'closed agents leave the list');
		await assert.rejects(fs.stat(keep.root));
		manager.dispose();
	});

	test('uncommitted work an agent started from isn\'t counted as the other agent\'s change', async () => {
		const { root, worktrees } = await repo();
		await fs.writeFile(path.join(root, 'a.js'), 'ONE\ntwo\nthree\nfour\nfive\n');
		let saved: unknown[] = [];
		const manager = new AgentManager({ mainRoot: root, worktrees, createRuntime: spec => ({ controller: fakeController(spec.root, []) as never, dispose: () => undefined }), load: () => saved as never, save: specs => { saved = [...specs]; }, emit: () => undefined, log: () => undefined, maxAgents: () => 3 });
		await manager.start();
		const second = manager.spec((await manager.create({})).id!)!;
		await fs.writeFile(path.join(second.root, 'a.js'), 'One!\ntwo\nthree\nfour\nfive\n');
		await manager.computeOverlaps();
		assert.deepEqual(manager.overlapLines(), []);
		manager.dispose();
	});

	test('two worktree agents are each measured from their own start, not one another\'s', async () => {
		const { root, worktrees } = await repo();
		let saved: unknown[] = [];
		const manager = new AgentManager({ mainRoot: root, worktrees, createRuntime: spec => ({ controller: fakeController(spec.root, []) as never, dispose: () => undefined }), load: () => saved as never, save: specs => { saved = [...specs]; }, emit: () => undefined, log: () => undefined, maxAgents: () => 0 });
		await manager.start();
		const early = manager.spec((await manager.create({})).id!)!;
		// The main folder changes b.js after the first agent started; a later agent starts from that.
		await fs.writeFile(path.join(root, 'b.js'), 'export const b = 9;\n');
		const late = manager.spec((await manager.create({})).id!)!;
		await fs.writeFile(path.join(early.root, 'a.js'), 'one\nTWO\nthree\nfour\nfive\n');
		await fs.writeFile(path.join(late.root, 'a.js'), 'one\ntwo\nthree\nfour\nFIVE\n');
		await manager.computeOverlaps();
		const between = manager.overlapLines().filter(line => line.includes('Agent 2') && line.includes('Agent 3'));
		assert.deepEqual(between, ['Agent 2 and Agent 3 both changed a.js'], 'b.js (changed in the folder, not by either) isn\'t theirs; a.js is, on different lines');
		manager.dispose();
	});

	test('a third agent is refused past the limit, and nothing starts outside a git repository', async () => {
		const { root, worktrees } = await repo();
		let saved: unknown[] = [];
		const manager = new AgentManager({ mainRoot: root, worktrees, createRuntime: spec => ({ controller: fakeController(spec.root, []) as never, dispose: () => undefined }), load: () => saved as never, save: specs => { saved = [...specs]; }, emit: () => undefined, log: () => undefined, maxAgents: () => 2 });
		await manager.start();
		assert.ok((await manager.create({})).id);
		assert.match((await manager.create({})).error ?? '', /At most 2 agents/);
		manager.dispose();

		const plain = await fs.mkdtemp(path.join(os.tmpdir(), 'active-plain-'));
		scratch.push(plain);
		const outside = new AgentManager({ mainRoot: plain, worktrees: new WorktreeManager(plain, path.join(plain, '.wt'), () => undefined), createRuntime: spec => ({ controller: fakeController(spec.root, []) as never, dispose: () => undefined }), load: () => [], save: () => undefined, emit: () => undefined, log: () => undefined, maxAgents: () => 3 });
		await outside.start();
		assert.match(outside.multiAgentBlocker ?? '', /git repository/);
		assert.match((await outside.create({})).error ?? '', /git repository/);
		outside.dispose();
	});
});
