/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import type { BreakpointSpec } from '../debug/debugRunner';
import { CodeTrace, DEFAULT_PROFILE, parseCodeTrace, traceStepStates } from '../shared/activeProtocol';
import { TraceBuilder, TraceRunner } from '../trace/traceBuilder';

const FILES: Record<string, string> = {
	'src/apiClient.js': Array.from({ length: 30 }, (_, i) => `line ${i + 1} of apiClient`).join('\n'),
	'src/limiter.js': Array.from({ length: 60 }, (_, i) => `line ${i + 1} of limiter`).join('\n'),
	'src/engine.py': 'def run():\n    return 1\n',
	'app/limits.py': Array.from({ length: 30 }, (_, i) => `line ${i + 1} of limits.py`).join('\n'),
};
const lineCount = (file: string) => FILES[file]?.split('\n').length;

const STEPS = [
	{ file: 'src/apiClient.js', startLine: 11, endLine: 19, symbol: 'ApiClient.request', summary: 'Waits for a token, then sends the request.', hop: { kind: 'await', label: 'awaits limiter.take()' }, probe: { line: 12, values: ['path'] } },
	{ file: 'src/limiter.js', startLine: 20, endLine: 34, symbol: 'RateLimiter.take', summary: 'Hands out a token, or sleeps until one is free.', hop: { kind: 'return', label: 'returns to request' }, probe: { line: 28, values: ['this.tokens', 'this.pausedUntil'] } },
	{ file: 'src/apiClient.js', startLine: 14, endLine: 17, symbol: 'ApiClient.request', summary: 'On a 429, pauses the limiter and retries.', probe: { line: 15, values: ['response.status'] } },
];

describe('Code trace validation', () => {
	test('good steps pass; missing files, bad ranges, long steps and steps without a summary are reported', () => {
		const errors: string[] = [];
		const parsed = parseCodeTrace({
			title: 'A 429', overview: 'It retries.',
			steps: [
				...STEPS,
				{ file: 'src/gone.js', startLine: 1, endLine: 2, summary: 'x' },
				{ file: 'src/apiClient.js', startLine: 25, endLine: 31, summary: 'past the end' },
				{ file: 'src/limiter.js', startLine: 1, endLine: 45, summary: 'too long' },
				{ file: 'src/apiClient.js', startLine: 1, endLine: 2 },
			],
			run: { command: 'node --test test/api.test.js', why: 'covers the retry' },
		}, lineCount, errors);
		assert.equal(errors.length, 4);
		assert.deepStrictEqual(parsed?.steps.map(step => [step.id, step.file, step.startLine, step.endLine, step.hop?.kind ?? null]), [['s1', 'src/apiClient.js', 11, 19, 'await'], ['s2', 'src/limiter.js', 20, 34, 'return'], ['s3', 'src/apiClient.js', 14, 17, null]]);
		assert.deepStrictEqual(parsed?.run, { command: 'node --test test/api.test.js', why: 'covers the retry' });
	});

	test('probes outside their step are dropped; probe values that call or assign are dropped', () => {
		const parsed = parseCodeTrace({ steps: [
			{ ...STEPS[0], probe: { line: 25, values: ['path'] } },
			{ ...STEPS[1], probe: { line: 28, values: ['this.tokens', 'this.take()', 'x = 1', 'items[0].id', 'n++'] } },
		] }, lineCount, []);
		assert.deepStrictEqual(parsed?.steps.map(step => step.probe ?? null), [null, { line: 28, values: ['this.tokens', 'items[0].id'] }]);
		assert.equal(parsed?.steps[1].hop, undefined, 'the last step has no hop');
	});
});

describe('Code trace shapes', () => {
	const FORKED = {
		title: 'A request that fails',
		steps: [
			STEPS[0],
			{ fork: {
				kind: 'either', label: 'on the response status',
				paths: [
					{ label: '429: wait, then retry', steps: [{ ...STEPS[2], hop: { kind: 'call', label: 'pauses the limiter' } }, { ...STEPS[1], repeats: 'once per retry' }] },
					{ label: 'other errors', ends: 'throws to the caller', steps: [{ file: 'src/apiClient.js', startLine: 20, endLine: 22, summary: 'Throws.', probe: { line: 21, values: [] } }] },
				],
			} },
			{ file: 'src/apiClient.js', startLine: 24, endLine: 26, summary: 'Returns the body.', probe: { line: 25, values: [] } },
		],
	};

	test('a fork\'s paths become steps on their paths, in reading order; the main line continues after them', () => {
		const errors: string[] = [];
		const parsed = parseCodeTrace(FORKED, lineCount, errors);
		assert.deepStrictEqual(errors, []);
		assert.deepStrictEqual(parsed?.steps.map(step => [step.id, step.branch ? `${step.branch.fork}/${step.branch.path}` : 'main', step.hop?.kind ?? null, step.repeats ?? null]), [
			['s1', 'main', 'await', null],
			['s2', 'f1/0', 'call', null],
			['s3', 'f1/0', null, 'once per retry'], // a path's last step has no hop
			['s4', 'f1/1', null, null],
			['s5', 'main', null, null],
		]);
		assert.deepStrictEqual(parsed?.forks, [{ id: 'f1', kind: 'either', label: 'on the response status', paths: [{ label: '429: wait, then retry' }, { label: 'other errors', ends: 'throws to the caller' }] }]);
	});

	test('bad forks are reported: an unknown kind, nesting, and a fork left with one path (its steps stay as plain steps)', () => {
		const errors: string[] = [];
		const parsed = parseCodeTrace({ steps: [
			{ fork: { kind: 'maybe', paths: [] } },
			{ fork: { kind: 'all', paths: [{ steps: [STEPS[0]] }, { steps: [{ file: 'src/gone.js', startLine: 1, summary: 'x' }] }] } },
			{ fork: { kind: 'either', paths: [{ steps: [STEPS[1], { fork: { kind: 'all', paths: [] } }] }, { steps: [STEPS[2]] }] } },
		] }, lineCount, errors);
		assert.equal(errors.length, 4, errors.join('\n'));
		assert.match(errors.join('\n'), /kind must be "either" or "all"[^]*doesn't exist[^]*at least two paths[^]*can't be nested/);
		assert.deepStrictEqual(parsed?.steps.map(step => step.branch?.fork ?? 'main'), ['main', 'f1', 'f1']);
		assert.deepStrictEqual(parsed?.forks.map(fork => [fork.id, fork.kind]), [['f1', 'either']]);
	});

	test('on an "either" fork, the paths that didn\'t run are "not taken", not missed; on an "all" fork, a path that didn\'t run is missed', () => {
		const parsed = parseCodeTrace(FORKED, lineCount, [])!;
		const observation = (hits: Record<string, number>) => ({ command: 'x', ranAt: 0, outcome: 'ran' as const, orderDiffers: false, output: [], steps: Object.fromEntries(Object.entries(hits).map(([id, count]) => [id, { hits: count, values: [] }])) });
		assert.deepStrictEqual(traceStepStates({ ...parsed, observation: observation({ s1: 1, s2: 1, s3: 0, s4: 0, s5: 1 }) }), { s1: 'observed', s2: 'observed', s3: 'notReached', s4: 'notTaken', s5: 'observed' });
		const all = parsed.forks.map(fork => ({ ...fork, kind: 'all' as const }));
		assert.deepStrictEqual(traceStepStates({ ...parsed, forks: all, observation: observation({ s1: 1, s2: 1, s3: 1, s4: 0, s5: 1 }) }).s4, 'notReached');
		// Nothing on the fork ran: that's a miss either way.
		assert.deepStrictEqual(traceStepStates({ ...parsed, observation: observation({ s1: 1, s2: 0, s3: 0, s4: 0, s5: 0 }) }).s4, 'notReached');
		assert.equal(traceStepStates({ ...parsed }).s1, 'inferred');
	});
});

describe('Building a code trace', () => {
	async function harness(replies: string[], run: Awaited<ReturnType<TraceRunner['observe']>>) {
		const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-trace-test-'));
		const asked: string[] = [];
		const observed: Array<{ command: string; points: readonly BreakpointSpec[] }> = [];
		const emitted: CodeTrace[] = [];
		const runner: TraceRunner = {
			checkPoint: async (file, line) => typeof file === 'string' && file.endsWith('.rb') ? 'Active\'s debugger works with JavaScript, TypeScript, Python, Go, C, C++ and Rust files, not this one.' : { file: String(file), line: Number(line) },
			observe: async (command, _cwd, points) => { observed.push({ command, points }); return run; },
		};
		const builder = new TraceBuilder({
			ask: async prompt => { asked.push(prompt.split('\n').find(line => line.startsWith('CODE TRACE')) ?? '?'); return replies.shift() ?? '{}'; },
			root: '/work/project', listFiles: async () => Object.keys(FILES), readFile: async file => FILES[file], runner, storeDir,
			emit: trace => emitted.push(trace), profile: () => DEFAULT_PROFILE, log: () => undefined, newId: () => 'trace-1',
		});
		const finished = () => new Promise<CodeTrace>(resolve => {
			const check = () => {
				const last = emitted.at(-1);
				if (last && (last.status === 'ready' || last.status === 'failed')) {
					resolve(last);
				} else {
					setTimeout(check, 5);
				}
			};
			check();
		});
		return { builder, asked, observed, emitted, finished, storeDir };
	}

	test('steps are captured with their code, then observed: which ran, how often, with what values, in what order', async () => {
		const h = await harness([JSON.stringify({ title: 'A request that gets a 429', overview: 'It pauses and retries.', steps: STEPS, run: { command: 'node --test test/api.test.js' } })], {
			// The limiter ran before request's logpoint (its line 12 comes after the await), and the retry ran once.
			hits: [{ index: 1, text: 'this.tokens=5 · this.pausedUntil=0' }, { index: 0, text: "path='/balance'" }, { index: 2, text: 'response.status=429' }, { index: 1, text: 'this.tokens=0 · this.pausedUntil=2000' }],
			output: ['✔ retries after 429'], exitCode: 0, timedOut: false,
		});
		assert.equal(await h.builder.build({ question: 'what happens when a request gets a 429' }), 'trace-1');
		const trace = await h.finished();
		assert.deepStrictEqual(h.emitted.map(entry => entry.status), ['tracing', 'observing', 'ready']);
		assert.deepStrictEqual(trace.snippets.s3, { firstLine: 14, lines: ['line 14 of apiClient', 'line 15 of apiClient', 'line 16 of apiClient', 'line 17 of apiClient'], languageId: 'javascript' });
		assert.deepStrictEqual(h.observed[0].points.map(point => [point.file, point.line, point.logMessage, point.maxHits]), [
			['src/apiClient.js', 12, 'path={path}', 10],
			['src/limiter.js', 28, 'this.tokens={this.tokens} · this.pausedUntil={this.pausedUntil}', 10],
			['src/apiClient.js', 15, 'response.status={response.status}', 10],
		]);
		assert.deepStrictEqual({ outcome: trace.observation?.outcome, orderDiffers: trace.observation?.orderDiffers, steps: trace.observation?.steps }, {
			outcome: 'ran',
			orderDiffers: true,
			steps: {
				s1: { hits: 1, values: ["path='/balance'"], order: 1 },
				s2: { hits: 2, values: ['this.tokens=5 · this.pausedUntil=0', 'this.tokens=0 · this.pausedUntil=2000'], order: 0 },
				s3: { hits: 1, values: ['response.status=429'], order: 2 },
			},
		});
		// Saved, so the tab comes back after a reload.
		assert.equal((await h.builder.get('trace-1'))?.title, 'A request that gets a 429');
		assert.equal(JSON.parse(await fs.readFile(path.join(h.storeDir, 'trace-1.json'), 'utf8')).observation.outcome, 'ran');
	});

	test('with no test to run, the explainer\'s driver script is written outside the project and run with node', async () => {
		const h = await harness([JSON.stringify({ title: 'T', steps: STEPS.slice(0, 1), run: { script: 'import x from "/work/project/src/apiClient.js";', why: 'no test sends a 429' } })], { hits: [], output: [], timedOut: false });
		await h.builder.build({ question: 'q' });
		const trace = await h.finished();
		const command = h.observed[0].command;
		assert.match(command, /^node ".*active-trace-[^/]+\/driver\.mjs"$/);
		assert.equal(await fs.readFile(JSON.parse(command.slice('node '.length)), 'utf8'), 'import x from "/work/project/src/apiClient.js";');
		assert.deepStrictEqual({ script: trace.observation?.script, why: trace.observation?.why, s1: trace.observation?.steps.s1 }, { script: 'import x from "/work/project/src/apiClient.js";', why: 'no test sends a 429', s1: { hits: 0, values: [] } });
	});

	test('a step in another language than the run\'s stays inferred; a broken trace goes back once for repair', async () => {
		const broken = JSON.stringify({ title: 'T', steps: [{ file: 'src/nope.js', startLine: 1, endLine: 2, summary: 'x' }] });
		const fixed = JSON.stringify({ title: 'T', steps: [STEPS[0], { file: 'src/engine.py', startLine: 1, endLine: 2, summary: 'Runs the engine.', probe: { line: 2, values: [] } }] });
		const h = await harness([broken, fixed], { hits: [{ index: 0, text: 'path=1' }], output: [], timedOut: false });
		await h.builder.build({ question: 'q', command: 'npm test' });
		const trace = await h.finished();
		assert.deepStrictEqual(h.asked, ['CODE TRACE', 'CODE TRACE REPAIR']);
		assert.deepStrictEqual(h.observed[0].points.map(point => point.file), ['src/apiClient.js']);
		assert.deepStrictEqual(Object.keys(trace.observation?.steps ?? {}), ['s1'], 'the Python step isn\'t observed by a JavaScript run, so it shows as inferred');
		assert.equal(h.observed[0].command, 'npm test');
	});

	test('paths of one fork have no order between them; steps elsewhere still must run in the order shown', async () => {
		const forked = { title: 'Fan-out', steps: [STEPS[0], { fork: { kind: 'all', label: 'listeners', paths: [{ label: 'a', steps: [STEPS[1]] }, { label: 'b', steps: [STEPS[2]] }] } }] };
		// The second path's step ran before the first path's: fine for an "all" fork.
		const h = await harness([JSON.stringify(forked)], { hits: [{ index: 0, text: 'path=1' }, { index: 2, text: 's=1' }, { index: 1, text: 't=1' }], output: [], timedOut: false });
		await h.builder.build({ question: 'q', command: 'npm test' });
		const trace = await h.finished();
		assert.equal(trace.observation?.orderDiffers, false);
		assert.deepStrictEqual(trace.forks?.map(fork => fork.kind), ['all']);
		// The step before the fork running last is out of order.
		const late = await harness([JSON.stringify(forked)], { hits: [{ index: 1, text: 't=1' }, { index: 0, text: 'path=1' }], output: [], timedOut: false });
		await late.builder.build({ question: 'q', command: 'npm test' });
		assert.equal((await late.finished()).observation?.orderDiffers, true);
	});

	test('the run observes one language: a Python driver script runs with python, and only the Python steps get logpoints', async () => {
		const steps = [{ file: 'app/limits.py', startLine: 3, endLine: 6, summary: 'Takes a token.', probe: { line: 4, values: ['self.tokens'] } }, STEPS[0]];
		const h = await harness([JSON.stringify({ title: 'T', steps, run: { script: 'import sys\nsys.path.insert(0, "/work/project")', language: 'python' } })], { hits: [{ index: 0, text: 'self.tokens=2' }], output: [], timedOut: false });
		await h.builder.build({ question: 'q' });
		const trace = await h.finished();
		assert.match(h.observed[0].command, /^python ".*active-trace-[^/]+\/driver\.py"$/);
		assert.deepStrictEqual(h.observed[0].points.map(point => point.file), ['app/limits.py']);
		assert.deepStrictEqual(Object.keys(trace.observation?.steps ?? {}), ['s1']);
		// A Go project has no driver scripts: it needs a test command.
		const go = await harness([JSON.stringify({ title: 'T', steps: [STEPS[0]], run: { script: 'package main' } })], { hits: [], output: [], timedOut: false });
		await go.builder.build({ question: 'q', command: 'go test ./x' });
		assert.match((await go.finished()).observation?.error ?? '', /None of the steps can be observed by running `go test \.\/x` \(it runs Go\)/);
	});

	test('the history lists saved traces and this session\'s unfinished ones, newest first; deleting forgets one', async () => {
		const h = await harness([JSON.stringify({ title: 'Older', steps: STEPS })], { hits: [], output: [], timedOut: false });
		await fs.writeFile(path.join(h.storeDir, 'old.json'), JSON.stringify({ id: 'old', question: 'q0', title: 'Saved earlier', createdAt: 1, status: 'ready', steps: [], snippets: {}, observation: { outcome: 'ran', steps: {} } }));
		await fs.writeFile(path.join(h.storeDir, 'broken.json'), '{');
		await h.builder.build({ question: 'q1', noRun: true });
		await h.finished();
		assert.deepStrictEqual((await h.builder.list()).map(entry => [entry.id, entry.title, entry.status, entry.evidence]), [['trace-1', 'Older', 'ready', 'inferred'], ['old', 'Saved earlier', 'ready', 'observed']]);
		await h.builder.delete('trace-1');
		assert.deepStrictEqual((await h.builder.list()).map(entry => entry.id), ['old']);
		assert.equal(await h.builder.get('trace-1'), undefined);
	});

	test('when asked not to run anything, the trace is ready from the source alone', async () => {
		const h = await harness([JSON.stringify({ title: 'T', steps: STEPS, run: { command: 'npm test' } })], { hits: [], output: [], timedOut: false });
		await h.builder.build({ question: 'q', noRun: true });
		const trace = await h.finished();
		assert.deepStrictEqual({ statuses: h.emitted.map(entry => entry.status), observation: trace.observation, ran: h.observed.length }, { statuses: ['tracing', 'ready'], observation: undefined, ran: 0 });
	});
});
