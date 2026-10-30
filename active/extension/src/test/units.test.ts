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
import { condensedOf, ExplainerMemory, rememberOf } from '../explain/memory';
import { ExplanationAgent, noteDraft, WalkthroughPlanner } from '../explain/planner';
import { buildBriefingPrompt, buildCheckpointPrompt, buildElaborationPrompt, buildMemoryCondensePrompt, buildPlanningPrompt, buildQuestionPrompt } from '../explain/prompts';
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

describe('git change counts', () => {
	const git = (cwd: string, command: string) => execSync(`git -c user.email=t@t -c user.name=t ${command}`, { cwd, stdio: 'pipe' });

	test('tracked changes against HEAD plus untracked files; binary and ignored files have no counts', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'active-git-'));
		await fs.writeFile(path.join(root, 'a.js'), 'one\ntwo\nthree\n');
		await fs.writeFile(path.join(root, 'gone.js'), 'x\n');
		git(root, 'init -q');
		git(root, 'add -A');
		git(root, 'commit -qm init');
		await fs.writeFile(path.join(root, 'a.js'), 'one\nTWO\nthree\nfour\n');
		await fs.rm(path.join(root, 'gone.js'));
		await fs.writeFile(path.join(root, 'new.js'), 'a\nb\n');
		await fs.writeFile(path.join(root, 'image.bin'), Buffer.from([0, 1, 2, 0]));
		await fs.mkdir(path.join(root, 'node_modules'));
		await fs.writeFile(path.join(root, 'node_modules', 'dep.js'), 'x\n');
		const stats = await new WorkspaceFiles(root).gitStats();
		assert.deepStrictEqual(stats?.sort((a, b) => a.path.localeCompare(b.path)), [
			{ path: 'a.js', added: 2, removed: 1 },
			{ path: 'gone.js', added: 0, removed: 1 },
			{ path: 'new.js', added: 2, removed: 0 },
		]);
	});

	test('before the first commit every file counts as added', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'active-git-'));
		git(root, 'init -q');
		await fs.writeFile(path.join(root, 'staged.js'), 'a\nb\nc\n');
		git(root, 'add staged.js');
		await fs.writeFile(path.join(root, 'loose.js'), 'a\n');
		const stats = await new WorkspaceFiles(root).gitStats();
		assert.deepStrictEqual(stats?.sort((a, b) => a.path.localeCompare(b.path)), [{ path: 'loose.js', added: 1, removed: 0 }, { path: 'staged.js', added: 3, removed: 0 }]);
	});

	test('a workspace inside a larger repository only counts its own files, relative to itself', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'active-git-'));
		await fs.mkdir(path.join(root, 'app'));
		git(root, 'init -q');
		await fs.writeFile(path.join(root, 'outside.js'), 'x\n');
		await fs.writeFile(path.join(root, 'app', 'inside.js'), 'y\n');
		assert.deepStrictEqual(await new WorkspaceFiles(path.join(root, 'app')).gitStats(), [{ path: 'inside.js', added: 1, removed: 0 }]);
	});

	test('outside a git repository there are no git counts', async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), 'active-nogit-'));
		await fs.writeFile(path.join(root, 'a.js'), 'x\n');
		assert.equal(await new WorkspaceFiles(root).gitStats(), undefined);
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

describe('notes shown beside the code', () => {
	const lines = (count: number, prefix: string) => Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).join('\n') + '\n';
	const file = (path: string, baseline: string | null, final: string | null): CapturedFile => ({ path, baseline, final, ...diffStats(baseline, final) });
	const src = file('src/limit.js', lines(30, 'a'), lines(30, 'a').replace('a10\n', 'b10\nb11\nb12\n'));
	const tests = file('test/limit.test.js', lines(5, 't'), lines(5, 't') + lines(20, 'n'));
	const files = { [src.path]: src, [tests.path]: tests };
	const note = { format: 'note' as const, note: 'The limit is now 8. Existing callers keep 1 until they opt in.' };

	test('the explainer\'s location is used when it exists in the captured files', () => {
		const draft = noteDraft({ ...note, title: 'Limit raised', at: { file: 'src/limit.js', focus: [{ startLine: 10, endLine: 12 }], anchorLine: 12 } }, files);
		assert.deepStrictEqual(
			[draft?.title, draft?.scenes.length, draft?.scenes[0].file, draft?.scenes[0].focus, draft?.scenes[0].anchorLine, draft?.scenes[0].narration.map(segment => segment.text)],
			['Limit raised', 1, 'src/limit.js', [{ startLine: 10, endLine: 12 }], 12, ['The limit is now 8. Existing callers keep 1 until they opt in.']],
		);
	});

	test('a missing, unknown or out-of-range location falls back to the largest non-test change', () => {
		for (const at of [undefined, { file: 'nope.js', focus: [{ startLine: 1, endLine: 1 }] }, { file: 'src/limit.js', focus: [{ startLine: 90, endLine: 95 }] }]) {
			const draft = noteDraft({ ...note, at }, files);
			assert.deepStrictEqual([draft?.scenes[0].file, draft?.scenes[0].focus], ['src/limit.js', [{ startLine: 10, endLine: 12 }]], JSON.stringify(at));
		}
	});

	test('without a title, it is named after the file rather than repeating the note', () => {
		assert.equal(noteDraft(note, files)?.title, 'Note on limit.js');
	});

	test('when only tests changed, the largest test change is used, capped to 15 lines', () => {
		const draft = noteDraft(note, { [tests.path]: tests });
		assert.deepStrictEqual([draft?.scenes[0].file, draft?.scenes[0].focus], ['test/limit.test.js', [{ startLine: 6, endLine: 20 }]]);
	});

	test('a new file is shown from its first line', () => {
		const created = file('src/new.js', null, lines(4, 'x'));
		assert.deepStrictEqual(noteDraft(note, { [created.path]: created })?.scenes[0].focus, [{ startLine: 1, endLine: 4 }]);
	});

	test('a turn that only deleted files has nowhere to show the note: chat only', () => {
		const deleted = file('src/old.js', lines(4, 'x'), null);
		assert.equal(noteDraft(note, { [deleted.path]: deleted }), undefined);
	});

	test('skips and empty notes have no inline version', () => {
		assert.deepStrictEqual([noteDraft({ format: 'skip', reason: 'x' }, files), noteDraft({ format: 'note' }, files)], [undefined, undefined]);
	});

	test('the explainer\'s location is read from its reply, and malformed ranges are ignored', async () => {
		const replies = [
			'{"format":"note","note":"n.","title":"T","at":{"file":"a.js","focus":[{"startLine":1,"endLine":1},{"startLine":"x"}],"anchorLine":1}}',
			'{"format":"note","note":"n.","at":{"file":"a.js","focus":[]}}',
		];
		const planner = new WalkthroughPlanner({ ask: async () => replies.shift()! } as unknown as ExplanationAgent, () => undefined);
		const context = { task: 't', turnIndex: 1, files: {}, agentMessages: [], reasoningSummaries: [], tools: [], pending: [], history: [], userNotes: [], final: true, preferNotes: true, profile: DEFAULT_PROFILE };
		assert.deepStrictEqual(
			[(await planner.plan(context)).brief, (await planner.plan(context)).brief],
			[{ format: 'note', note: 'n.', reason: undefined, title: 'T', at: { file: 'a.js', focus: [{ startLine: 1, endLine: 1 }], anchorLine: 1 } }, { format: 'note', note: 'n.', reason: undefined }],
		);
	});
});

describe('explainer memory', () => {
	let clock = 1000;
	async function store(): Promise<{ memory: ExplainerMemory; files: Record<'personal' | 'project', string> }> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-memory-'));
		const files = { personal: path.join(dir, 'personal.json'), project: path.join(dir, 'nested', 'project.json') };
		return { memory: new ExplainerMemory(files, () => clock++), files };
	}

	test('notes are kept per scope, in separate files, and survive a restart', async () => {
		const { memory, files } = await store();
		assert.equal(await memory.add([{ scope: 'personal', note: 'Knows async/await well.' }, { scope: 'project', note: 'Retries use a shared budget.' }], 'Retry budget'), true);
		const reloaded = new ExplainerMemory(files);
		assert.deepStrictEqual((await reloaded.list()).map(note => [note.scope, note.text, note.context, note.source]), [['personal', 'Knows async/await well.', 'Retry budget', 'explainer'], ['project', 'Retries use a shared budget.', 'Retry budget', 'explainer']]);
		assert.equal(JSON.parse(await fs.readFile(files.personal, 'utf8')).length, 1);
		assert.equal(JSON.parse(await fs.readFile(files.project, 'utf8')).length, 1);
	});

	test('repeats are dropped (ignoring case, spacing and punctuation), and "replaces" updates a note in place', async () => {
		const { memory } = await store();
		await memory.add([{ scope: 'project', note: 'Retries use a shared budget.' }]);
		const [first] = await memory.list();
		assert.equal(await memory.add([{ scope: 'project', note: '  retries USE a shared budget ' }]), false);
		await memory.add([{ scope: 'project', note: 'Retries use a per-host budget.', replaces: first.id }]);
		assert.deepStrictEqual((await memory.list()).map(note => [note.id, note.text]), [[first.id, 'Retries use a per-host budget.']]);
		// An unknown id is just a new note.
		await memory.add([{ scope: 'project', note: 'Timeouts are 30s.', replaces: 'm999' }]);
		assert.equal((await memory.list()).length, 2);
	});

	test('questions are recorded by Active, once each, and kept like any other note', async () => {
		const { memory } = await store();
		for (let index = 1; index <= 20; index++) {
			await memory.recordQuestion(`question ${index}?`, 'Retry budget');
		}
		await memory.recordQuestion('question 20?', 'Retry budget');
		const questions = (await memory.list()).filter(note => note.source === 'question');
		assert.deepStrictEqual([questions.length, questions[0].text, questions[0].scope], [20, 'Asked about "Retry budget": question 1?', 'project']);
	});

	test('nothing is dropped by count: memory only shrinks when it is condensed', async () => {
		const { memory } = await store();
		await memory.add(Array.from({ length: 120 }, (_, index) => ({ scope: 'personal' as const, note: `fact ${index}` })));
		assert.equal((await memory.list()).length, 120);
	});

	test('forgetting one note, or everything', async () => {
		const { memory } = await store();
		await memory.add([{ scope: 'personal', note: 'a' }, { scope: 'project', note: 'b' }]);
		const [first] = await memory.list();
		await memory.delete(first.id);
		assert.deepStrictEqual((await memory.list()).map(note => note.text), ['b']);
		await memory.delete();
		assert.deepStrictEqual(await memory.list(), []);
	});

	test('the prompt carries every note, oldest first, with ids, scopes and questions marked', async () => {
		const { memory } = await store();
		await memory.add([{ scope: 'personal', note: 'Knows SQL.' }]);
		await memory.recordQuestion('why a mutex?', 'Locking');
		assert.deepStrictEqual((await memory.describe()).split('\n'), ['- [m1] (personal) Knows SQL.', '- [m2] (project, their question) Asked about "Locking": why a mutex?']);
	});

	test('it needs condensing past 6,000 characters; past 12,000 the prompt keeps the newest notes as a safety net', async () => {
		const { memory } = await store();
		const long = (index: number) => ({ scope: 'project' as const, note: `${index} ${'x'.repeat(280)}` });
		await memory.add(Array.from({ length: 15 }, (_, index) => long(index)));
		assert.equal(await memory.needsCondensing(), false);
		await memory.add(Array.from({ length: 10 }, (_, index) => long(100 + index)));
		assert.equal(await memory.needsCondensing(), true);
		await memory.add(Array.from({ length: 30 }, (_, index) => long(200 + index)));
		const described = await memory.describe();
		assert.ok(described.length <= 12000);
		assert.match(described.split('\n').at(-1)!, /^- \[m55\] \(project\) 229 /);
	});

	test('condensing replaces only the notes it was given; a note added meanwhile is kept', async () => {
		const { memory } = await store();
		await memory.add([{ scope: 'personal', note: 'a' }, { scope: 'project', note: 'b' }]);
		const condensedIds = new Set((await memory.list()).map(note => note.id));
		await memory.recordQuestion('added while condensing?');
		await memory.condense(condensedIds, [{ scope: 'project', note: 'a and b, merged' }, { scope: 'project', note: '  a AND b merged ' }], 'condensed');
		assert.deepStrictEqual((await memory.list()).map(note => [note.text, note.source, note.context]).sort(), [['Asked: added while condensing?', 'question', undefined], ['a and b, merged', 'explainer', 'condensed']]);
	});

	test('a condensed reply is read as notes; anything unusable leaves memory alone', () => {
		assert.deepStrictEqual(condensedOf({ notes: [{ scope: 'personal', note: 'a' }, { note: 'b' }, { note: '' }, 7] }), [{ scope: 'personal', note: 'a' }, { scope: 'project', note: 'b' }]);
		assert.deepStrictEqual([condensedOf(undefined), condensedOf({ notes: [] }), condensedOf({ notes: 'x' })], [undefined, undefined, undefined]);
	});

	test('the condensing prompt gives the size, the target and what must survive', () => {
		const prompt = buildMemoryCondensePrompt('- [m1] (project) a', 6400, 3000);
		assert.deepStrictEqual(
			[prompt.startsWith('MEMORY CONDENSING'), prompt.includes('6400 characters'), prompt.includes('under 3000 characters'), /what you've already explained to them/.test(prompt), prompt.includes('- [m1] (project) a'), prompt.includes('{"notes"')],
			[true, true, true, true, true, true],
		);
	});

	test('"remember" is read from a reply; malformed entries are ignored and at most 5 are taken', () => {
		assert.deepStrictEqual(rememberOf({ remember: [{ scope: 'personal', note: 'a' }, { note: 'b' }, { scope: 'x', note: 'c', replaces: 'm1' }, { note: '' }, 'junk', { note: 'd' }, { note: 'e' }] }), [
			{ scope: 'personal', note: 'a' }, { scope: 'project', note: 'b' }, { scope: 'project', note: 'c', replaces: 'm1' },
		]);
		assert.deepStrictEqual([rememberOf(undefined), rememberOf({ remember: 'no' })], [[], []]);
	});

	test('plans carry "remember" for every format, and a repaired reply keeps the first one\'s notes', async () => {
		const files = { 'a.js': { path: 'a.js', baseline: 'x\n', final: 'y\n', added: 1, removed: 1 } };
		const context = { task: 't', turnIndex: 1, files, agentMessages: [], reasoningSummaries: [], tools: [], pending: [], history: [], userNotes: [], final: true, preferNotes: true, profile: DEFAULT_PROFILE };
		const scene = { id: 's', role: 'implementation', label: 'L', title: 'T', file: 'a.js', version: 'final', focus: [{ startLine: 1, endLine: 1 }], anchorLine: 1, narration: [{ text: 'It changed.' }] };
		const replies = [
			'{"format":"skip","reason":"r","remember":[{"scope":"personal","note":"skip note"}]}',
			JSON.stringify({ format: 'walkthrough', title: 'T', summary: 'S', terms: [], scenes: [{ ...scene, file: 'missing.js' }], remember: [{ scope: 'project', note: 'kept' }] }),
			JSON.stringify({ format: 'walkthrough', title: 'T', summary: 'S', terms: [], scenes: [scene] }),
		];
		const planner = new WalkthroughPlanner({ ask: async () => replies.shift()! } as unknown as ExplanationAgent, () => undefined);
		assert.deepStrictEqual((await planner.plan(context)).remember, [{ scope: 'personal', note: 'skip note' }]);
		const repaired = await planner.plan(context);
		assert.ok(repaired.draft);
		assert.deepStrictEqual(repaired.remember, [{ scope: 'project', note: 'kept' }]);
	});

	test('prompts: plans get memory, the no-repeat rule and "remember"; questions get memory but are always answered', () => {
		const context = { task: 't', turnIndex: 1, files: {}, agentMessages: [], reasoningSummaries: [], tools: [], pending: [], history: [], userNotes: [], final: true, preferNotes: true, profile: DEFAULT_PROFILE };
		const plan = buildPlanningPrompt({ ...context, memory: '- [m1] (project) Retries use a shared budget.' });
		const empty = buildPlanningPrompt(context);
		const question = buildQuestionPrompt('why?', undefined, undefined, DEFAULT_PROFILE, '- [m1] (project) Retries use a shared budget.');
		assert.deepStrictEqual(
			[plan.includes('- [m1] (project) Retries use a shared budget.'), /don't explain again what these notes say/.test(plan), plan.includes('"remember"'), plan.includes('"replaces"')],
			[true, true, true, true],
		);
		assert.deepStrictEqual([empty.includes('MEMORY\n(empty)'), /Add to it with "remember"/.test(empty)], [true, true]);
		assert.deepStrictEqual([question.includes('Retries use a shared budget.'), /answer what they ask even if it was covered before/.test(question), /Add to it with "remember"/.test(question)], [true, true, false]);
		assert.equal(buildQuestionPrompt('why?', undefined, undefined, DEFAULT_PROFILE).includes('MEMORY'), false);
	});
});

describe('explanation agent', () => {
	/** A session whose turns finish only when the test says so, recording the order prompts were started in. */
	function manualSession() {
		const started: string[] = [];
		const finish: Array<(reply: string) => void> = [];
		let agent!: ExplanationAgent;
		const session = {
			sessionId: 's',
			startTurn: async (prompt: string) => {
				const turnId = `t${started.length + 1}`;
				started.push(prompt);
				finish.push(reply => {
					agent.onItem({ id: `m${turnId}`, turnId, kind: 'agentMessage', status: 'completed', text: reply }, true);
					agent.onTurnCompleted(turnId, 'completed');
				});
				return turnId;
			},
		} as unknown as AgentSession;
		agent = new ExplanationAgent(async () => session);
		return { agent, started, finish: (index: number, reply: string) => finish[index](reply) };
	}
	const tick = () => new Promise(resolve => setTimeout(resolve, 0));

	test('requests run one at a time, in order', async () => {
		const { agent, started, finish } = manualSession();
		const first = agent.ask('plan');
		const second = agent.ask('check');
		await tick();
		assert.deepStrictEqual(started, ['plan']);
		finish(0, 'one');
		assert.equal(await first, 'one');
		await tick();
		assert.deepStrictEqual(started, ['plan', 'check']);
		finish(1, 'two');
		assert.equal(await second, 'two');
	});

	test('the developer\'s questions go ahead of queued background work, but never interrupt the running turn', async () => {
		const { agent, started, finish } = manualSession();
		const replies = [agent.ask('plan'), agent.ask('chapter check'), agent.ask('briefing'), agent.ask('more detail', undefined, true), agent.ask('question', undefined, true)];
		await tick();
		assert.deepStrictEqual(started, ['plan'], 'the running turn is not interrupted');
		for (let index = 0; index < 5; index++) {
			finish(index, `r${index}`);
			await tick();
			await tick();
		}
		assert.deepStrictEqual(started, ['plan', 'more detail', 'question', 'chapter check', 'briefing'], 'urgent requests keep their own order');
		assert.deepStrictEqual(await Promise.all(replies), ['r0', 'r3', 'r4', 'r1', 'r2']);
	});

	test('a request that fails doesn\'t block the next', async () => {
		let agent!: ExplanationAgent;
		let turns = 0;
		const session = {
			sessionId: 's',
			startTurn: async () => {
				const turnId = `t${++turns}`;
				setTimeout(() => {
					if (turnId === 't1') {
						agent.onTurnCompleted(turnId, 'failed', 'boom');
					} else {
						agent.onItem({ id: 'm', turnId, kind: 'agentMessage', status: 'completed', text: 'ok' }, true);
						agent.onTurnCompleted(turnId, 'completed');
					}
				}, 1);
				return turnId;
			},
		} as unknown as AgentSession;
		agent = new ExplanationAgent(async () => session);
		const failed = agent.ask('first');
		const next = agent.ask('second');
		await assert.rejects(failed, /boom/);
		assert.equal(await next, 'ok');
	});


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
