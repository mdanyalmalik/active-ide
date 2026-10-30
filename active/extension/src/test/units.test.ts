/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import type { AgentSession } from '../agents/agentTypes';
import { ExplanationAgent, WalkthroughPlanner } from '../explain/planner';
import { buildBriefingPrompt, buildCheckpointPrompt, buildElaborationPrompt, buildPlanningPrompt } from '../explain/prompts';
import { assessWorthiness } from '../explain/worthiness';
import { HistoryStore } from '../history/historyStore';
import { applyDetailFeedback, applySkipSignal, CapturedFile, DEFAULT_PROFILE, extractJsonObject, KnowledgeProfile, validateWalkthrough, Walkthrough } from '../shared/activeProtocol';
import { ChangeTracker, NetFileChange } from '../tracking/changeTracker';
import { diffLines, diffStats, unifiedDiff } from '../tracking/lineDiff';
import { WorkspaceFiles } from '../tracking/workspaceFiles';

function change(path: string, baseline: string | null, final: string | null): NetFileChange {
	const stats = diffStats(baseline, final);
	return { path, baseline, final, ...stats, userOnly: false, userTouched: false, preexistingUserChanges: false };
}

describe('lineDiff', () => {
	test('reports hunks, stats and a unified diff', () => {
		const before = 'a\nb\nc\nd\n';
		const after = 'a\nB\nc\nd\ne\n';
		assert.deepStrictEqual(diffLines(before, after).map(hunk => [hunk.oldStart, hunk.oldLines, hunk.newStart, hunk.newLines]), [[2, 1, 2, 1], [5, 0, 5, 1]]);
		assert.deepStrictEqual(diffStats(before, after), { added: 2, removed: 1 });
		assert.match(unifiedDiff('x.txt', before, after), /^--- a\/x\.txt\n\+\+\+ b\/x\.txt\n@@ -1,4 \+1,5 @@\n a\n-b\n\+B\n c\n d\n\+e$/);
	});

	test('handles new and deleted files', () => {
		assert.deepStrictEqual(diffStats(null, 'x\ny\n'), { added: 2, removed: 0 });
		assert.deepStrictEqual(diffStats('x\n', null), { added: 0, removed: 1 });
	});
});

describe('meaningful-change filter', () => {
	// Only screens out changes with nothing to explain; whether to explain is the explanation model's call.
	test('whitespace-only, comment-only and lock-file changes are filtered out', () => {
		const before = 'function f(a) {\n\treturn a + 1;\n}\n';
		const after = '// adds one\nfunction f(a) {\n    return a + 1;\n}\n';
		assert.deepStrictEqual(
			[assessWorthiness([change('f.js', before, after)]).worthy, assessWorthiness([change('package-lock.json', '{}\n', '{"a":1}\n')]).worthy],
			[false, false],
		);
	});

	test('any real change, however small, goes to the explanation model', () => {
		assert.deepStrictEqual(
			[assessWorthiness([change('a.js', 'const x = 1;\n', 'const x = 8;\n')]).worthy, assessWorthiness([change('README.md', 'A tiny project\n', 'A small project\n')]).worthy],
			[true, true],
		);
	});
});

describe('walkthrough validation', () => {
	const files: Record<string, CapturedFile> = {
		'src/a.js': { path: 'src/a.js', baseline: 'const a = 1;\n', final: 'const a = 1;\nfunction add(x) {\n\treturn x + a;\n}\n', added: 3, removed: 0 },
		'src/reverted.js': { path: 'src/reverted.js', baseline: 'x\n', final: 'x\n', added: 0, removed: 0 },
	};
	const scene = (overrides: Record<string, unknown>) => ({ id: 's1', role: 'implementation', label: 'Implementation', title: 'Adds add()', file: 'src/a.js', version: 'final', focus: [{ startLine: 2, endLine: 4 }], anchorLine: 4, narration: [{ text: 'add uses a.' }], ...overrides });

	test('accepts a grounded walkthrough', () => {
		const result = validateWalkthrough({ title: 'T', summary: 'S', scenes: [scene({ quote: 'return x + a;' })] }, files, new Set());
		assert.deepStrictEqual(result.errors, []);
		assert.equal(result.draft?.scenes.length, 1);
	});

	test('reports structural problems for repair', () => {
		const result = validateWalkthrough({ title: 'T', summary: 'S', scenes: [scene({ file: 'nope.js' }), scene({ id: 's2', focus: [{ startLine: 3, endLine: 99 }] }), scene({ id: 's3', quote: 'return x * a;' })] }, files, new Set());
		assert.equal(result.draft, undefined);
		assert.equal(result.errors.length, 3);
	});

	test('drops scenes about reverted work', () => {
		const result = validateWalkthrough({ title: 'T', summary: 'S', scenes: [scene({}), scene({ id: 'gone', file: 'src/reverted.js', focus: [{ startLine: 1, endLine: 1 }], anchorLine: 1 })] }, files, new Set());
		assert.deepStrictEqual(result.dropped, ['gone']);
		assert.equal(result.draft?.scenes.length, 1);
	});

	test('observed charts without captured evidence become illustrative', () => {
		const chart = { type: 'chart', chart: 'bar', title: 't', xLabel: 'x', yLabel: 'y', source: 'observed', evidence: 'missing', series: [{ name: 'n', points: [{ x: 1, y: 2 }] }] };
		const result = validateWalkthrough({ title: 'T', summary: 'S', scenes: [scene({ visual: chart })] }, files, new Set(['tool-1']));
		const visual = result.draft?.scenes[0].visual;
		assert.equal(visual?.type === 'chart' && visual.source, 'illustrative');
	});

	test('narration may not mention internal tool ids', () => {
		const result = validateWalkthrough({ title: 'T', summary: 'S', scenes: [scene({ narration: [{ text: 'Tool outcome t31701 shows the tests passed.' }] }), scene({ id: 's2', narration: [{ text: 'Run t31701 passed.' }] })] }, files, new Set(['bridge-coding-x-t5-t31701']));
		assert.equal(result.errors.length, 2);
	});

	test('extracts fenced JSON', () => {
		assert.deepStrictEqual(extractJsonObject('Here:\n```json\n{"a": 1}\n```'), { a: 1 });
	});
});

async function tempWorkspace(files: Record<string, string>): Promise<string> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'active-ws-'));
	for (const [name, content] of Object.entries(files)) {
		await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
		await fs.writeFile(path.join(root, name), content);
	}
	execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: root });
	return root;
}

describe('change tracking', () => {
	test('captures shell-made edits, attributes user typing, and freezes the turn', async () => {
		const root = await tempWorkspace({ 'a.txt': 'one\n', 'b.txt': 'two\n' });
		let clock = 1_000_000;
		const tracker = new ChangeTracker(new WorkspaceFiles(root), () => clock);
		await tracker.beginTurn('t1');
		execSync('printf "one\\nmore\\n" > a.txt && printf "new\\n" > c.txt', { cwd: root });
		clock += 10_000;
		await tracker.rescan();
		tracker.noteUserTyping('b.txt');
		await fs.writeFile(path.join(root, 'b.txt'), 'two!\n');
		await tracker.observe('b.txt');
		const result = await tracker.endTurn();
		assert.deepStrictEqual(result?.changes.map(item => [item.path, item.added, item.removed, item.userOnly]), [['a.txt', 1, 0, false], ['b.txt', 1, 1, true], ['c.txt', 1, 0, false]]);
		assert.deepStrictEqual(result?.edits.map(edit => [edit.path, edit.source]).sort(), [['a.txt', 'agent'], ['b.txt', 'user'], ['c.txt', 'agent']]);
		// Later edits are not attributed to the finished turn.
		await fs.writeFile(path.join(root, 'a.txt'), 'changed later\n');
		assert.equal(await tracker.observe('a.txt'), undefined);
		assert.equal(result?.changes[0].final, 'one\nmore\n');
	});

	test('an earlier agent turn\'s uncommitted output is not mistaken for user changes', async () => {
		const root = await tempWorkspace({ 'a.txt': 'base\n' });
		const tracker = new ChangeTracker(new WorkspaceFiles(root));
		await tracker.beginTurn('t1');
		await fs.writeFile(path.join(root, 'a.txt'), 'base\nturn one\n');
		await tracker.observe('a.txt');
		await tracker.endTurn();
		await tracker.beginTurn('t2');
		await fs.writeFile(path.join(root, 'a.txt'), 'base\nturn one\nturn two\n');
		await tracker.observe('a.txt');
		const [net] = (await tracker.endTurn())!.changes;
		assert.deepStrictEqual([net.added, net.preexistingUserChanges], [1, false]);
	});

	test('excludes pre-existing user changes from the turn diff', async () => {
		const root = await tempWorkspace({ 'a.txt': 'base\n' });
		await fs.writeFile(path.join(root, 'a.txt'), 'base\nuser work\n');
		const tracker = new ChangeTracker(new WorkspaceFiles(root));
		await tracker.beginTurn('t1');
		await fs.writeFile(path.join(root, 'a.txt'), 'base\nuser work\nagent work\n');
		await tracker.observe('a.txt');
		const [net] = (await tracker.endTurn())!.changes;
		assert.deepStrictEqual([net.added, net.removed, net.preexistingUserChanges, net.baseline], [1, 0, true, 'base\nuser work\n']);
	});
});

describe('history store', () => {
	test('saves, rehydrates and deletes history without touching project files', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'active-history-'));
		const project = await tempWorkspace({ 'keep.txt': 'project file\n' });
		const store = new HistoryStore(path.join(root, 'history'));
		const files: CapturedFile[] = [{ path: 'keep.txt', baseline: 'a\n', final: 'b\n', added: 1, removed: 1 }];
		const summary = { sessionId: 's', turnId: 't1', index: 1, task: 'task', startedAt: 1, outcome: 'completed', explanationNote: 'n', files: [{ path: 'keep.txt', added: 1, removed: 1 }] };
		const walkthrough = { id: 'wt-t1', sessionId: 's', turnId: 't1', turnIndex: 1, task: 'task', title: 'W', summary: 'S', createdAt: 1, terms: [], pending: [], files: { 'keep.txt': files[0] }, scenes: [] };
		await store.save({ summary, chat: [], reasoningSummaries: ['why'], tools: [], edits: [], files, walkthrough });
		await store.save({ summary: { ...summary, turnId: 't2', index: 2, startedAt: 2 }, chat: [], reasoningSummaries: [], tools: [], edits: [], files: [] });
		assert.deepStrictEqual((await store.list()).map(turn => turn.turnId), ['t2', 't1']);
		const detail = await store.get('t1');
		assert.equal(detail?.walkthrough?.files['keep.txt'].final, 'b\n');
		const stored = await fs.readdir(path.join(root, 'history'), { recursive: true });
		assert.equal(stored.some(name => /\.(wav|mp3|ogg)$/.test(String(name))), false);
		await store.delete('t1');
		assert.deepStrictEqual((await store.list()).map(turn => turn.turnId), ['t2']);
		await store.delete();
		assert.deepStrictEqual(await store.list(), []);
		assert.equal(await fs.readFile(path.join(project, 'keep.txt'), 'utf8'), 'project file\n');
	});
});

describe('chapters and explainer-chosen length', () => {
	const files = { 'a.js': { path: 'a.js', baseline: 'x\n', final: 'y\n', added: 1, removed: 1 } };
	const context = { task: 'Build the queue', turnIndex: 3, files, agentMessages: [], reasoningSummaries: [], tools: [], pending: [], history: [], userNotes: [], final: false, preferNotes: true, profile: DEFAULT_PROFILE };

	test('a chapter prompt explains only what changed since the last chapter and lists earlier ones', () => {
		const prompt = buildPlanningPrompt({ ...context, chapter: { index: 2, earlier: [{ title: 'Heap ordering', summary: 'Jobs pop by priority.' }] } });
		assert.deepStrictEqual(
			[prompt.includes('CHAPTER 2'), prompt.includes('1. Heap ordering: Jobs pop by priority.'), prompt.includes('diffs are relative to the end of the previous chapter')],
			[true, true, true],
		);
		assert.equal(buildPlanningPrompt(context).includes('CHAPTER'), false);
	});

	test('the chapter check is small: progress and stats, no file contents', () => {
		const prompt = buildCheckpointPrompt({
			profile: DEFAULT_PROFILE, task: 'Build the queue', minutesSinceLastChapter: 12, progress: ['Tests pass; moving on to retries.'],
			files: [{ path: 'src/queue.ts', added: 120, removed: 4 }], tools: [{ id: 't', tool: 'bash', label: 'npm test', status: 'completed', command: 'npm test', background: false }],
			earlierChapters: [], preferNotes: true,
		});
		assert.deepStrictEqual(
			[prompt.startsWith('CHAPTER CHECK'), prompt.includes('- Tests pass; moving on to retries.'), prompt.includes('- src/queue.ts (+120 -4)'), prompt.includes('`npm test` → completed'), prompt.includes('CAPTURED FILES')],
			[true, true, true, true, false],
		);
	});

	test('the explainer can answer with a note or a skip instead of a walkthrough', async () => {
		const replies = ['```json\n{"format":"note","note":"The default is now 8.","reason":"one-line change"}\n```', '{"format":"skip","reason":"formatting only"}', '{"format":"note"}'];
		const agent = { ask: async () => replies.shift()! } as unknown as ExplanationAgent;
		const planner = new WalkthroughPlanner(agent, () => undefined);
		assert.deepStrictEqual(
			[(await planner.plan(context)).brief, (await planner.plan(context)).brief, (await planner.plan(context)).brief],
			[{ format: 'note', note: 'The default is now 8.', reason: 'one-line change' }, { format: 'skip', note: undefined, reason: 'formatting only' }, { format: 'skip', note: undefined, reason: undefined }],
		);
	});

	test('the chapter check reads "chapter" or "wait"; anything else waits', async () => {
		const replies = ['{"decision":"chapter","reason":"tests pass"}', 'not json'];
		const planner = new WalkthroughPlanner({ ask: async () => replies.shift()! } as unknown as ExplanationAgent, () => undefined);
		const input = { profile: DEFAULT_PROFILE, task: 't', minutesSinceLastChapter: 10, progress: [], files: [], tools: [], earlierChapters: [], preferNotes: true };
		assert.deepStrictEqual([await planner.checkpoint(input), await planner.checkpoint(input)], [{ decision: 'chapter', reason: 'tests pass' }, { decision: 'wait', reason: '' }]);
	});
});

describe('return briefing', () => {
	test('the briefing prompt carries outcomes, failures, pending checks and what is still running', () => {
		const prompt = buildBriefingPrompt({
			profile: DEFAULT_PROFILE, minutesAway: 42,
			turns: [{ task: 'Add retries', outcome: 'completed', explanation: 'Walkthrough: Retries', summary: 'Failed jobs retry with backoff.', finalMessage: 'Done.', notes: [], failedCommands: ['npm run lint'], pendingChecks: ['npm run bench'], files: [{ path: 'src/queue.ts', added: 30, removed: 2 }] }],
			running: { task: 'Add an HTTP API', progress: ['Server skeleton done.'] },
			waiting: ['Run a shell command: rm -rf dist'],
		});
		assert.deepStrictEqual(
			[prompt.startsWith('RETURN BRIEFING. The developer was away for 42 minutes'), prompt.includes('1. TASK: Add retries'), prompt.includes('failed commands: npm run lint'), prompt.includes('checks still pending: npm run bench'), prompt.includes('STILL RUNNING\nTASK: Add an HTTP API'), prompt.includes('- Run a shell command: rm -rf dist')],
			[true, true, true, true, true, true],
		);
	});
});

describe('personalization', () => {
	test('the learner profile shapes the planning prompt', () => {
		const files = { 'a.js': { path: 'a.js', baseline: 'x\n', final: 'y\n', added: 1, removed: 1 } };
		const context = { task: 't', turnIndex: 1, files, agentMessages: [], reasoningSummaries: ['exposed summary'], tools: [], pending: [{ id: 'p', label: 'npm test', state: 'running' as const }], history: [], userNotes: [], final: true, preferNotes: true };
		const novice = buildPlanningPrompt({ ...context, profile: { ...DEFAULT_PROFILE, depth: 'overview', math: 'avoid', glossOver: 'CSS', followClosely: 'async timing' } });
		const expert = buildPlanningPrompt({ ...context, preferNotes: false, profile: { ...DEFAULT_PROFILE, depth: 'deep', math: 'comfortable' } });
		assert.deepStrictEqual(
			[novice.includes('Avoid equations.'), novice.includes('Skim past: CSS'), novice.includes('Follow closely: async timing'), expert.includes('Avoid equations.'), novice.includes('- npm test'), novice.includes('exposed summary')],
			[true, true, true, false, true, true],
		);
		// The explainer chooses the format and length; no fixed scene count.
		assert.deepStrictEqual(
			[/Aim for \d/.test(novice), novice.includes('LENGTH (your decision)'), novice.includes('Lean toward "note"'), expert.includes('Lean toward "note"'), novice.includes('"format": "walkthrough"|"note"|"skip"')],
			[false, true, true, false, true],
		);
	});

	test('detail feedback nudges the detail preference slightly and topic knowledge more', () => {
		const start: KnowledgeProfile = { ...DEFAULT_PROFILE, concepts: [{ name: 'Token bucket', familiarity: 'some' }] };
		const lighter = applyDetailFeedback(start, 'tooMuch', ['token bucket', 'Retry-After']);
		assert.equal(lighter.detailBias, -0.2);
		assert.equal(lighter.depth, 'balanced');
		assert.deepStrictEqual(lighter.concepts, [
			{ name: 'Token bucket', familiarity: 'comfortable', level: 1.5 },
			{ name: 'Retry-After', familiarity: 'comfortable', level: 1.5 },
		]);
		// Repeated "too little" eventually moves to the next depth.
		let deeper = start;
		for (let i = 0; i < 5; i++) {
			deeper = applyDetailFeedback(deeper, 'tooLittle', []);
		}
		assert.deepStrictEqual([deeper.depth, deeper.detailBias], ['deep', 0]);
		assert.equal(applyDetailFeedback({ ...start, detailBias: 0.5 }, 'right', ['x']).detailBias, 0.4);
		assert.ok(buildPlanningPrompt({ task: 't', turnIndex: 1, files: {}, agentMessages: [], reasoningSummaries: [], tools: [], pending: [], history: [], userNotes: [], final: true, preferNotes: true, profile: lighter }).includes('lean slightly toward less detail'));
	});

	test('skipping a scene early nudges its topics very slightly', () => {
		const start: KnowledgeProfile = { ...DEFAULT_PROFILE, concepts: [{ name: 'unit table', familiarity: 'comfortable' }], detailBias: 0.3 };
		const after = applySkipSignal(start, ['Unit table', 'regex']);
		assert.deepStrictEqual(after.concepts, [
			{ name: 'unit table', familiarity: 'comfortable', level: 2.1 },
			{ name: 'regex', familiarity: 'some', level: 1.1 },
		]);
		assert.equal(after.detailBias, 0.3);
		assert.equal(applySkipSignal(start, []), start);
	});

	test('the deeper explanation prompt targets one scene', () => {
		const walkthrough = { id: 'wt-1', title: 'Rate limiting', summary: 's', task: 't', scenes: [{ id: 'model', title: 'Token bucket', file: 'a.js', version: 'final', anchorLine: 1, focus: [{ startLine: 1, endLine: 1 }], narration: [{ text: 'Tokens refill.' }] }], files: { 'a.js': { path: 'a.js', baseline: null, final: 'refill()\n', added: 1, removed: 0 } } } as unknown as Walkthrough;
		const prompt = buildElaborationPrompt(walkthrough, 'model', DEFAULT_PROFILE);
		assert.match(prompt, /QUESTION\nMORE DETAIL: Re-explain "Token bucket"/);
		assert.match(prompt, /THE DEVELOPER PAUSED ON: "Token bucket"/);
	});
});

describe('explanation agent', () => {
	test('a turn that never finishes is interrupted and the next request still runs', async () => {
		const interrupted: string[] = [];
		let turns = 0;
		let agent: ExplanationAgent;
		const session = {
			sessionId: 's',
			startTurn: async () => {
				const turnId = `t${++turns}`;
				if (turnId === 't2') {
					setTimeout(() => {
						agent.onItem({ id: 'm', turnId, kind: 'agentMessage', status: 'completed', text: 'second' }, true);
						agent.onTurnCompleted(turnId, 'completed');
					}, 5);
				}
				return turnId;
			},
			interruptTurn: async (turnId: string) => { interrupted.push(turnId); },
		} as unknown as AgentSession;
		agent = new ExplanationAgent(async () => session, 50);
		await assert.rejects(agent.ask('first'), /took longer than/);
		assert.deepEqual(interrupted, ['t1']);
		assert.equal(await agent.ask('second'), 'second');
	});
});
