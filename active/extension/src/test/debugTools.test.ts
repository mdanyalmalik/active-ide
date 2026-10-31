/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { BackendSession, BreakpointSpec, DebugBackend, DebugBackendEvent, DebugRunner } from '../debug/debugRunner';
import { callDebugTool, DEBUG_TOOLS, describeDebugCall } from '../debug/debugTools';
import { startMcpServer } from '../debug/mcpServer';
import type { LaunchPlan, Toolchain } from '../debug/languages';
import { debuggerSuggestion, stuckReason } from '../debug/stuck';
import type { ToolOutcome } from '../shared/activeProtocol';

const ROOT = '/work/project';

/** A stand-in for VS Code's debugger: plays a script of adapter events and answers requests from a table. */
class FakeBackend implements DebugBackend {
	developerDebugging = false;
	added: BreakpointSpec[][] = [];
	removed = 0;
	started: Array<{ command: string; cwd: string; language?: string }> = [];
	stopped = 0;
	requests: Array<{ target: string; command: string; args: Record<string, unknown> }> = [];
	emit: ((event: DebugBackendEvent) => void) | undefined;

	constructor(private readonly script: (emit: (event: DebugBackendEvent) => void, backend: FakeBackend) => void, private readonly answers: Record<string, Record<string, unknown>> = {}) { }

	developerIsDebugging(): boolean {
		return this.developerDebugging;
	}

	async addBreakpoints(points: readonly BreakpointSpec[]): Promise<() => Promise<void>> {
		this.added.push([...points]);
		return async () => { this.removed++; };
	}

	async start(options: { runId: string; command: string; plan: LaunchPlan; cwd: string }, onEvent: (event: DebugBackendEvent) => void): Promise<BackendSession> {
		this.started.push({ command: options.command, cwd: options.cwd, ...(options.plan.language !== 'javascript' ? { language: options.plan.language } : {}) });
		this.emit = onEvent;
		setTimeout(() => this.script(onEvent, this), 0);
		return {
			request: async (target, command, args) => {
				this.requests.push({ target, command, args });
				return this.answers[command];
			},
			stop: async () => {
				this.stopped++;
				onEvent({ kind: 'terminated' });
			},
		};
	}
}

export const FAKE_TOOLCHAIN: Toolchain = { python: async () => '/usr/bin/python3', dlv: async () => ({ path: '/go/bin/dlv' }), nativeDebugger: () => true, tempDir: async () => '/tmp/active-debug-1' };
const runnerWith = (backend: FakeBackend) => new DebugRunner({ backend, toolchain: FAKE_TOOLCHAIN, workspaceRoot: ROOT, fileExists: async file => !file.includes('missing'), directoryExists: async dir => dir === ROOT || dir === `${ROOT}/packages/api`, log: () => undefined });
const logpointMark = (backend: FakeBackend, index: number) => backend.added[0][index].logMessage!.split('#').slice(0, 2).join('#') + '#';

describe('Debug runner: logpoint runs', () => {
	test('reports what each logpoint printed, in the order the lines ran, which never ran, and the program output', async () => {
		const backend = new FakeBackend((emit, self) => {
			const mark = (index: number) => logpointMark(self, index);
			emit({ kind: 'output', target: 'c1', category: 'stdout', text: `${mark(0)}attempt=1\n` });
			emit({ kind: 'output', target: 'c1', category: 'stdout', text: 'not ok 1 - retries after 429\n' });
			emit({ kind: 'output', target: 'c1', category: 'stdout', text: `${mark(0)}attempt=2\n${mark(1)}wait=1000\n` });
			emit({ kind: 'exited', target: 'c1', exitCode: 1 });
			emit({ kind: 'terminated' });
		});
		const result = await runnerWith(backend).runWithLogpoints({
			command: 'node --test test/limits.test.js',
			logpoints: [
				{ file: 'src/apiClient.js', line: 42, message: 'attempt={attempt}' },
				{ file: './src/net/limiter.ts', line: 7, message: 'wait={wait}', maxHits: 5 },
				{ file: 'src/other.js', line: 3, message: 'here' },
			],
		});
		assert.equal(result.isError, undefined);
		const [head, ...rest] = result.text.split('\n');
		assert.match(head, /^Ran `node --test test\/limits\.test\.js` under the debugger \(exit code 1, /);
		assert.deepStrictEqual(rest, [
			'',
			'Logpoints hit, in the order the lines ran:',
			'1. src/apiClient.js:42  attempt=1',
			'2. src/apiClient.js:42  attempt=2',
			'3. src/net/limiter.ts:7  wait=1000',
			'',
			'Never hit: src/other.js:3',
			'',
			'Program output (last 1 lines):',
			'not ok 1 - retries after 429',
		]);
		assert.deepStrictEqual(backend.added[0].map(point => [point.file, point.line, point.maxHits]), [['src/apiClient.js', 42, 20], ['src/net/limiter.ts', 7, 5], ['src/other.js', 3, 20]]);
		assert.deepStrictEqual(backend.started, [{ command: 'node --test test/limits.test.js', cwd: ROOT }]);
		assert.equal(backend.removed, 1, 'the logpoints are removed afterwards');
	});

	test('a pause during a logpoint run (a debugger statement, an exception) is continued, not left hanging', async () => {
		const backend = new FakeBackend(emit => {
			emit({ kind: 'stopped', target: 'c2', threadId: 7, reason: 'exception' });
			emit({ kind: 'terminated' });
		});
		await runnerWith(backend).runWithLogpoints({ command: 'npm test', logpoints: [{ file: 'src/a.js', line: 1, message: 'x' }] });
		assert.deepStrictEqual(backend.requests, [{ target: 'c2', command: 'continue', args: { threadId: 7 } }]);
	});

	test('a run that outlasts its time limit is stopped, and its logpoints removed', async () => {
		const backend = new FakeBackend(() => undefined);
		const result = await runnerWith(backend).runWithLogpoints({ command: 'npm test', logpoints: [{ file: 'src/a.js', line: 1, message: 'x' }], timeoutSeconds: 0.05 });
		assert.match(result.text, /stopped it after 0s \(time limit\)/);
		assert.deepStrictEqual({ stopped: backend.stopped, removed: backend.removed }, { stopped: 1, removed: 1 });
	});

	test('bad requests are refused before anything runs: no command, files outside the project, missing files, other languages', async () => {
		const backend = new FakeBackend(() => undefined);
		const runner = runnerWith(backend);
		const refusals = await Promise.all([
			runner.runWithLogpoints({ logpoints: [{ file: 'src/a.js', line: 1 }] }),
			runner.runWithLogpoints({ command: 'npm test', logpoints: [{ file: '../elsewhere/a.js', line: 1 }] }),
			runner.runWithLogpoints({ command: 'npm test', logpoints: [{ file: 'src/missing.js', line: 1 }] }),
			runner.runWithLogpoints({ command: 'bundle exec rspec', logpoints: [{ file: 'app/main.rb', line: 1 }] }),
			runner.runWithLogpoints({ command: 'npm test', logpoints: [{ file: 'src/a.js', line: 0 }] }),
			runner.runWithLogpoints({ command: 'npm test', cwd: '../..', logpoints: [{ file: 'src/a.js', line: 1 }] }),
		]);
		assert.deepStrictEqual(refusals.map(result => result.isError), [true, true, true, true, true, true]);
		assert.match(refusals[3].text, /works with JavaScript, TypeScript, Python, Go, C, C\+\+ and Rust files, not this one/);
		assert.deepStrictEqual(backend.started, []);
	});

	test('each run uses one language\'s debugger: picked from the points\' files, and it must match what the command runs', async () => {
		const backend = new FakeBackend(emit => emit({ kind: 'terminated' }));
		const runner = runnerWith(backend);
		const python = await runner.runWithLogpoints({ command: 'pytest tests/test_limits.py -k retry', logpoints: [{ file: 'app/limits.py', line: 3, message: 'x={x}' }] });
		const go = await runner.runWithLogpoints({ command: 'go test ./limits -run TestRetry', logpoints: [{ file: 'limits/limits.go', line: 3, message: 'x={x}' }] });
		const mixed = await runner.runWithLogpoints({ command: 'pytest', logpoints: [{ file: 'app/limits.py', line: 3 }, { file: 'src/a.js', line: 1 }] });
		const mismatched = await runner.runWithLogpoints({ command: 'npm test', logpoints: [{ file: 'app/limits.py', line: 3 }] });
		const shell = await runner.runWithLogpoints({ command: 'pytest && echo done', logpoints: [{ file: 'app/limits.py', line: 3 }] });
		assert.equal(python.isError, undefined);
		assert.equal(go.isError, undefined);
		assert.deepStrictEqual(backend.started.map(start => start.language), ['python', 'go']);
		assert.match(mixed.text, /in Python and JavaScript\/TypeScript files/);
		assert.match(mismatched.text, /The points are in Python files, but `npm test` runs JavaScript\/TypeScript/);
		assert.match(shell.text, /needs a shell/);
	});

	test('a working folder of "null" (as models sometimes send) means the project root; a folder that doesn\'t exist is refused', async () => {
		const backend = new FakeBackend(emit => emit({ kind: 'terminated' }));
		const runner = runnerWith(backend);
		await runner.runWithLogpoints({ command: 'npm test', cwd: 'null', logpoints: [{ file: 'src/a.js', line: 1, message: 'x' }] });
		await runner.runWithLogpoints({ command: 'npm test', cwd: 'packages/api', logpoints: [{ file: 'src/a.js', line: 1, message: 'x' }] });
		const missing = await runner.runWithLogpoints({ command: 'npm test', cwd: 'packages/web', logpoints: [{ file: 'src/a.js', line: 1, message: 'x' }] });
		assert.deepStrictEqual(backend.started.map(start => start.cwd), [ROOT, `${ROOT}/packages/api`]);
		assert.match(missing.text, /packages\/web isn't a directory in the project/);
	});

	test('never runs while the developer is debugging (breakpoints are shared with their session)', async () => {
		const backend = new FakeBackend(() => undefined);
		backend.developerDebugging = true;
		const result = await runnerWith(backend).runWithLogpoints({ command: 'npm test', logpoints: [{ file: 'src/a.js', line: 1, message: 'x' }] });
		assert.deepStrictEqual({ isError: result.isError, started: backend.started.length, added: backend.added.length }, { isError: true, started: 0, added: 0 });
		assert.match(result.text, /developer is debugging/);
	});
});

describe('Debug runner: pausing and inspecting', () => {
	const answers = {
		stackTrace: { stackFrames: [
			{ id: 11, name: 'take', source: { path: `${ROOT}/src/net/limiter.js` }, line: 17 },
			{ id: -1, name: 'setTimeout', presentationHint: 'label' },
			{ id: 12, name: 'retry', source: { path: `${ROOT}/src/apiClient.js` }, line: 42 },
		] },
		scopes: { scopes: [{ name: 'Local', variablesReference: 5, expensive: false }] },
		variables: { variables: [{ name: 'tokens', value: '0' }, { name: 'pausedUntil', value: '1730' }] },
		evaluate: { result: '3', type: 'number' },
	};

	test('start pauses at a breakpoint and reports the stack (with async callers) and locals; evaluate and step use that pause; stop cleans up', async () => {
		const backend = new FakeBackend(emit => emit({ kind: 'stopped', target: 'child', threadId: 1, reason: 'breakpoint' }), answers);
		const runner = runnerWith(backend);
		const started = await runner.start({ command: 'npm test', breakpoints: [{ file: 'src/net/limiter.js', line: 17, condition: 'tokens === 0' }] });
		assert.deepStrictEqual(started.text.split('\n').slice(0, 11), [
			'Started `npm test` under the debugger (session d1).',
			'Paused (breakpoint) at take (src/net/limiter.js:17).',
			'',
			'Call stack (async callers included):',
			'#0 take (src/net/limiter.js:17)',
			'  ── async: setTimeout ──',
			'#1 retry (src/apiClient.js:42)',
			'',
			'Local variables:',
			'  tokens = 0',
			'  pausedUntil = 1730',
		]);
		assert.equal(backend.added[0][0].condition, 'tokens === 0');
		const value = await runner.evaluate({ session: 'd1', expression: 'attempts', frame: 1 });
		assert.equal(value.text, 'attempts = 3  (number)');
		assert.deepStrictEqual(backend.requests.at(-1), { target: 'child', command: 'evaluate', args: { expression: 'attempts', frameId: 12, context: 'watch' } });
		setTimeout(() => backend.emit!({ kind: 'terminated' }), 10);
		const stepped = await runner.step({ session: 'd1', action: 'continue' });
		assert.match(stepped.text, /^The program finished without pausing at a breakpoint\./);
		assert.deepStrictEqual(backend.requests.find(request => request.command === 'continue'), { target: 'child', command: 'continue', args: { threadId: 1 } });
		assert.equal(backend.removed, 1);
		assert.match((await runner.evaluate({ expression: 'x' })).text, /No debug session is open/);
	});

	test('Node.js internal frames collapse to one line (numbering still matches debug_evaluate frames), and debugger chatter stays out of the output', async () => {
		const internal = (id: number, name: string) => ({ id, name, source: { path: `${ROOT}/<node_internals>/internal/test_runner/${name}` }, line: 1 });
		const backend = new FakeBackend(emit => {
			emit({ kind: 'output', target: 'c', category: 'stderr', text: 'Debugger attached.\n/bin/zsh -c npm test\nreal output\nWaiting for the debugger to disconnect...\n' });
			emit({ kind: 'stopped', target: 'c', threadId: 1, reason: 'breakpoint', description: 'Paused on breakpoint' });
		}, {
			...answers,
			stackTrace: { stackFrames: [{ id: 1, name: 'parse', source: { path: `${ROOT}/src/d.js` }, line: 7 }, internal(2, 'run'), internal(3, 'start'), { id: 4, name: 'main', source: { path: `${ROOT}/test/d.test.js` }, line: 6 }] },
		});
		const runner = runnerWith(backend);
		const text = (await runner.start({ command: 'npm test', breakpoints: [{ file: 'src/d.js', line: 7 }] })).text;
		assert.deepStrictEqual(text.split('\n').slice(1, 7), ['Paused (breakpoint) at parse (src/d.js:7).', '', 'Call stack (async callers included):', '#0 parse (src/d.js:7)', '  … 2 Node.js internal frames', '#3 main (test/d.test.js:6)']);
		await runner.evaluate({ expression: 'x', frame: 3 });
		assert.equal(backend.requests.at(-1)?.args.frameId, 4);
		const stopped = await runner.stop({});
		assert.equal(stopped.text, 'Stopped debug session d1. Program output (last 1 lines):\nreal output');
	});

	test('one session at a time; stopAll (at the end of a turn) ends whatever is left', async () => {
		const backend = new FakeBackend(emit => emit({ kind: 'stopped', target: 'child', threadId: 1, reason: 'breakpoint' }), answers);
		const runner = runnerWith(backend);
		await runner.start({ command: 'npm test', breakpoints: [{ file: 'src/a.js', line: 1 }] });
		const second = await runner.runWithLogpoints({ command: 'npm test', logpoints: [{ file: 'src/a.js', line: 1, message: 'x' }] });
		assert.match(second.text, /Debug session d1 is still open/);
		await runner.stopAll();
		assert.deepStrictEqual({ stopped: backend.stopped, removed: backend.removed }, { stopped: 1, removed: 1 });
	});
});

describe('Debug tools over MCP', () => {
	test('the server answers initialize, lists the tools, runs calls, and refuses requests without the token', async () => {
		const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
		const server = await startMcpServer({ name: 'active', version: '1', tools: DEBUG_TOOLS, call: async (name, args) => { calls.push({ name, args }); return { text: 'ran' }; }, log: () => undefined });
		try {
			const post = (body: unknown, token = server.token) => fetch(server.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body) });
			const init = await (await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })).json() as { result: { protocolVersion: string; capabilities: unknown; serverInfo: { name: string } } };
			assert.deepStrictEqual({ version: init.result.protocolVersion, name: init.result.serverInfo.name, capabilities: init.result.capabilities }, { version: '2025-06-18', name: 'active', capabilities: { tools: { listChanged: false } } });
			assert.equal((await post({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
			const list = await (await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).json() as { result: { tools: Array<{ name: string }> } };
			assert.deepStrictEqual(list.result.tools.map(tool => tool.name), ['debug_run_with_logpoints', 'debug_start', 'debug_step', 'debug_evaluate', 'debug_stop']);
			const call = await (await post({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'debug_stop', arguments: { session: 'd1' } } })).json() as { result: unknown };
			assert.deepStrictEqual(call.result, { content: [{ type: 'text', text: 'ran' }], isError: false });
			assert.deepStrictEqual(calls, [{ name: 'debug_stop', args: { session: 'd1' } }]);
			const unknown = await (await post({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'rm_rf' } })).json() as { error: { code: number } };
			assert.equal(unknown.error.code, -32602);
			assert.equal((await post({ jsonrpc: '2.0', id: 5, method: 'tools/list' }, 'wrong')).status, 401);
		} finally {
			await server.close();
		}
	});

	test('tool calls reach the runner by name', async () => {
		const backend = new FakeBackend(() => undefined);
		const result = await callDebugTool(runnerWith(backend), 'debug_evaluate', { expression: 'x' });
		assert.match(result.text, /No debug session is open/);
	});

	test('chat describes debug calls in words, and leaves other tools alone', () => {
		assert.deepStrictEqual([
			describeDebugCall('mcp__active__debug_run_with_logpoints', JSON.stringify({ command: 'npm test', logpoints: [{}, {}] })),
			describeDebugCall('mcp__active__debug_start', JSON.stringify({ command: 'npm test', breakpoints: [{}] })),
			describeDebugCall('mcp__active__debug_evaluate', JSON.stringify({ expression: 'bucket.tokens' })),
			describeDebugCall('mcp__active__debug_step', '{"action":"over"}'),
			describeDebugCall('bash', '{"command":"npm test"}'),
		], [
			'Debugging: ran `npm test` with 2 logpoints',
			'Debugging: started `npm test` with 1 breakpoint',
			'Debugging: read bucket.tokens',
			'Debugging: step over',
			undefined,
		]);
	});
});

describe('Noticing the coding agent is stuck', () => {
	const run = (command: string, status: string, output = ''): ToolOutcome => ({ id: `${command}-${Math.random()}`, tool: 'bash', label: command, status, command, output, background: false });

	test('the same test failing twice, three failed runs, or print statements added', () => {
		assert.equal(stuckReason([run('npm test', 'completed', '# fail 1\n1 failing'), run('npm  test', 'failed')], []), '`npm test` has failed 2 times this turn');
		assert.equal(stuckReason([run('npm test -- a', 'failed'), run('npm test -- b', 'failed'), run('node x.js', 'completed', 'exited with code 2')], []), '3 commands have failed this turn');
		assert.equal(stuckReason([], [{ baseline: 'const a = 1;', final: 'const a = 1;\nconsole.log("a", a);' }]), 'you\'re adding print statements to see values');
	});

	test('one failure, passing runs, existing prints, or a debugger already used: not stuck', () => {
		assert.equal(stuckReason([run('npm test', 'failed'), run('npm run lint', 'completed', 'All good')], []), undefined);
		assert.equal(stuckReason([], [{ baseline: 'console.log(1);', final: 'console.log(1);\nconst b = 2;' }]), undefined);
		assert.equal(stuckReason([run('npm test', 'failed'), run('npm test', 'failed'), { ...run('x', 'completed'), tool: 'mcp__active__debug_run_with_logpoints' }], []), undefined);
	});

	test('the suggestion names the tools and asks to remove any print statements afterwards', () => {
		const text = debuggerSuggestion('`npm test` has failed 2 times this turn');
		assert.match(text, /^\[Active, the IDE you're running in\] `npm test` has failed 2 times this turn\./);
		assert.match(text, /mcp__active__debug_run_with_logpoints/);
		assert.match(text, /mcp__active__debug_start/);
		assert.match(text, /remove them once you're done/);
	});
});
