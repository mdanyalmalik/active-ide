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
import { buildPlanningPrompt } from '../explain/prompts';
import { assessWorthiness } from '../explain/worthiness';
import { HistoryStore } from '../history/historyStore';
import { CapturedFile, DEFAULT_PROFILE, extractJsonObject, validateWalkthrough } from '../shared/activeProtocol';
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

describe('worthiness', () => {
	const options = { minMeaningfulLines: 8 };

	test('a one-line wording change is not explained', () => {
		const verdict = assessWorthiness([change('README.md', 'A tiny project\n', 'A small project\n')], options);
		assert.equal(verdict.worthy, false);
	});

	test('whitespace-only and comment-only changes are not meaningful', () => {
		const before = 'function f(a) {\n\treturn a + 1;\n}\n';
		const after = '// adds one\nfunction f(a) {\n    return a + 1;\n}\n';
		assert.equal(assessWorthiness([change('f.js', before, after)], options).meaningfulLines, 0);
	});

	test('new behavior with logic is explained', () => {
		const before = 'export function parse(t) {\n\treturn Number(t);\n}\n';
		const after = [
			'const UNITS = { s: 1000, m: 60000 };',
			'export function parse(t) {',
			'\tconst match = /^(\\d+)(s|m)$/.exec(t);',
			'\tif (!match) {',
			'\t\tthrow new Error(`bad ${t}`);',
			'\t}',
			'\tconst value = Number(match[1]) * UNITS[match[2]];',
			'\tif (value <= 0) {',
			'\t\tthrow new Error(`zero ${t}`);',
			'\t}',
			'\treturn value;',
			'}',
			'',
		].join('\n');
		assert.equal(assessWorthiness([change('parse.js', before, after)], options).worthy, true);
	});

	test('small changes in separate turns never accumulate', () => {
		const turns = [
			[change('a.js', 'const x = 1;\n', 'const x = 2;\n')],
			[change('b.js', 'let y = 1;\n', 'let y = 3;\n')],
			[change('c.js', 'if (a) {}\n', 'if (a && b) {}\n')],
		];
		assert.deepStrictEqual(turns.map(turn => assessWorthiness(turn, options).worthy), [false, false, false]);
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

describe('personalization', () => {
	test('the learner profile shapes the planning prompt', () => {
		const files = { 'a.js': { path: 'a.js', baseline: 'x\n', final: 'y\n', added: 1, removed: 1 } };
		const context = { task: 't', turnIndex: 1, files, agentMessages: [], reasoningSummaries: ['exposed summary'], tools: [], pending: [{ id: 'p', label: 'npm test', state: 'running' as const }], history: [], userNotes: [], final: true };
		const novice = buildPlanningPrompt({ ...context, profile: { ...DEFAULT_PROFILE, depth: 'overview', math: 'avoid', glossOver: 'CSS', wantToLearn: 'async timing' } });
		const expert = buildPlanningPrompt({ ...context, profile: { ...DEFAULT_PROFILE, depth: 'deep', math: 'comfortable' } });
		assert.deepStrictEqual(
			[novice.includes('Aim for 3-4 scenes'), novice.includes('Avoid equations.'), novice.includes('Gloss over: CSS'), novice.includes('Wants to learn: async timing'), expert.includes('Aim for 6-9 scenes'), expert.includes('Avoid equations.'), novice.includes('- npm test'), novice.includes('exposed summary')],
			[true, true, true, true, true, false, true, true],
		);
	});
});
