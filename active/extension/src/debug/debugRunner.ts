/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

/** What the debugger reports about a run, from the debug adapter's events. `target` is the (child) session it came from. */
export type DebugBackendEvent =
	| { readonly kind: 'stopped'; readonly target: string; readonly threadId: number; readonly reason: string; readonly description?: string }
	| { readonly kind: 'output'; readonly target: string; readonly category: string; readonly text: string }
	| { readonly kind: 'exited'; readonly target: string; readonly exitCode: number }
	| { readonly kind: 'terminated' };

/** A breakpoint or logpoint, at a 1-based line of a file inside the project. */
export interface BreakpointSpec {
	readonly file: string;
	readonly line: number;
	readonly condition?: string;
	readonly logMessage?: string;
	/** Logpoints only: stop logging after this many hits. */
	readonly maxHits?: number;
}

export interface BackendSession {
	/** Sends a Debug Adapter Protocol request to the session (or child session) `target`. */
	request(target: string, command: string, args: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
	stop(): Promise<void>;
}

/** The part of VS Code's debugger the runner drives (the real one is `VscodeDebugBackend`; tests use a fake). */
export interface DebugBackend {
	/** The developer has a debug session of their own running. */
	developerIsDebugging(): boolean;
	/** Adds the breakpoints; resolves with a function that removes exactly these again. */
	addBreakpoints(points: readonly BreakpointSpec[]): Promise<() => Promise<void>>;
	/** Runs `command` in `cwd` under the debugger, reporting its events. */
	start(options: { readonly runId: string; readonly command: string; readonly cwd: string }, onEvent: (event: DebugBackendEvent) => void): Promise<BackendSession>;
}

export interface DebugRunnerOptions {
	readonly backend: DebugBackend;
	readonly workspaceRoot: string;
	readonly fileExists: (absolute: string) => Promise<boolean>;
	readonly directoryExists: (absolute: string) => Promise<boolean>;
	readonly log: (line: string) => void;
	readonly now?: () => number;
}

export interface DebugToolResult {
	readonly text: string;
	readonly isError?: boolean;
}

/** Files the built-in JavaScript debugger can set breakpoints in. Other languages need their own debug adapter (not wired up yet). */
const SUPPORTED_FILE = /\.(?:[cm]?[jt]sx?)$/i;
const MAX_LOGPOINTS = 20;
const DEFAULT_MAX_HITS = 20;
const MAX_LOG_LINES = 200;
const MAX_OUTPUT_LINES = 40;
const DEFAULT_TIMEOUT_S = 60;
const MAX_TIMEOUT_S = 300;
/** An interactive session left alone this long is stopped. */
const IDLE_LIMIT_MS = 3 * 60_000;
/** Lines the debugger itself prints into the program's output (attaching, its bootloader, the launch line). */
const DEBUGGER_NOISE = /^(?:Debugger attached\.|Debugger listening on |Waiting for the debugger to disconnect|For help, see: https:\/\/nodejs\.org\/en\/docs\/inspector|Error in the js-debug bootloader|js-debug\/|\(node:\d+\) Warning: Using the inspector with --test|\(Use `node --trace-warnings)/;
/** Marks logpoint output so it can be told apart from the program's own. */
const MARK = '⁣ACTIVE#';

interface OpenSession {
	readonly id: string;
	readonly command: string;
	readonly session: BackendSession;
	readonly removeBreakpoints: () => Promise<void>;
	/** Events not yet consumed by a wait. */
	readonly queue: DebugBackendEvent[];
	wake: (() => void) | undefined;
	stoppedAt: { target: string; threadId: number; frames: Array<{ id: number; label: string }> } | undefined;
	output: string[];
	exitCode: number | undefined;
	ended: boolean;
	idleTimer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Runs the coding agent's debugging: commands under VS Code's debugger with temporary logpoints or breakpoints,
 * hidden from the developer's debug UI. One session at a time; never while the developer is debugging (breakpoints
 * are shared across sessions); everything it adds is removed afterwards, and `stopAll` ends whatever is left when a
 * turn ends.
 */
export class DebugRunner {
	private open: OpenSession | undefined;
	private nextId = 1;

	constructor(private readonly options: DebugRunnerOptions) { }

	/** Runs a command with logpoints and reports what they printed, in the order the lines ran. */
	async runWithLogpoints(args: { command?: unknown; cwd?: unknown; logpoints?: unknown; timeoutSeconds?: unknown }): Promise<DebugToolResult> {
		const command = typeof args.command === 'string' ? args.command.trim() : '';
		if (!command) {
			return error('Give the command to run, e.g. "npm test -- test/limits.test.js".');
		}
		const raw = Array.isArray(args.logpoints) ? args.logpoints : [];
		if (!raw.length) {
			return error('Give at least one logpoint: {"file": "src/x.js", "line": 12, "message": "count={count}"}.');
		}
		if (raw.length > MAX_LOGPOINTS) {
			return error(`At most ${MAX_LOGPOINTS} logpoints per run.`);
		}
		const points: BreakpointSpec[] = [];
		for (const [index, entry] of raw.entries()) {
			const point = entry as { file?: unknown; line?: unknown; message?: unknown; maxHits?: unknown };
			const message = typeof point.message === 'string' && point.message.trim() ? point.message.trim() : 'hit';
			const checked = await this.checkLocation(point.file, point.line);
			if (typeof checked === 'string') {
				return error(`Logpoint ${index + 1}: ${checked}`);
			}
			const maxHits = typeof point.maxHits === 'number' && point.maxHits > 0 ? Math.min(100, Math.floor(point.maxHits)) : DEFAULT_MAX_HITS;
			points.push({ file: checked.file, line: checked.line, logMessage: `${MARK}${index}#${message}`, maxHits });
		}
		const refused = this.refusal();
		if (refused) {
			return refused;
		}
		const cwd = await this.resolveCwd(args.cwd);
		if (typeof cwd !== 'string') {
			return cwd;
		}
		const started = this.now();
		const timeoutMs = timeout(args.timeoutSeconds);
		const open = await this.begin(command, cwd, points);
		if (!open.ok) {
			return open.result;
		}
		const session = open.session;
		const hits: Array<{ index: number; text: string }> = [];
		let timedOut = false;
		try {
			const deadline = started + timeoutMs;
			for (; ;) {
				// Everything queued is read, even after the program ends, so late logpoint lines aren't lost.
				const event = await this.next(session, deadline - this.now());
				if (!event) {
					timedOut = !session.ended;
					break;
				}
				if (event.kind === 'output') {
					for (const line of event.text.split('\n')) {
						const marked = line.indexOf(MARK);
						if (marked >= 0) {
							const rest = line.slice(marked + MARK.length);
							const index = Number(rest.slice(0, rest.indexOf('#')));
							if (hits.length < MAX_LOG_LINES) {
								hits.push({ index, text: rest.slice(rest.indexOf('#') + 1).trim() });
							}
						} else if (line.trim() && event.category !== 'telemetry' && !this.isNoise(session, line)) {
							pushCapped(session.output, line, MAX_OUTPUT_LINES);
						}
					}
				} else if (event.kind === 'stopped') {
					// Logpoints never stop; a `debugger;` statement or an exception might. Keep going.
					await session.session.request(event.target, 'continue', { threadId: event.threadId }).catch(() => undefined);
				}
			}
		} finally {
			await this.end(session);
		}
		const seconds = ((this.now() - started) / 1000).toFixed(1);
		const lines = [timedOut
			? `Ran \`${command}\` under the debugger and stopped it after ${Math.round(timeoutMs / 1000)}s (time limit).`
			: `Ran \`${command}\` under the debugger (${session.exitCode === undefined ? 'finished' : `exit code ${session.exitCode}`}, ${seconds}s).`];
		if (hits.length) {
			lines.push('', 'Logpoints hit, in the order the lines ran:');
			hits.forEach((hit, order) => lines.push(`${order + 1}. ${points[hit.index] ? `${points[hit.index].file}:${points[hit.index].line}` : '?'}  ${hit.text}`));
			if (hits.length >= MAX_LOG_LINES) {
				lines.push(`(stopped listing after ${MAX_LOG_LINES} lines)`);
			}
		} else {
			lines.push('', 'No logpoint was hit.');
		}
		const missed = points.filter((_, index) => !hits.some(hit => hit.index === index));
		if (missed.length && hits.length) {
			lines.push('', `Never hit: ${missed.map(point => `${point.file}:${point.line}`).join(', ')}`);
		}
		if (session.output.length) {
			lines.push('', `Program output (last ${session.output.length} lines):`, ...session.output);
		}
		return { text: lines.join('\n') };
	}

	/** Starts a command under the debugger and waits for the first breakpoint to pause it. */
	async start(args: { command?: unknown; cwd?: unknown; breakpoints?: unknown; timeoutSeconds?: unknown }): Promise<DebugToolResult> {
		const command = typeof args.command === 'string' ? args.command.trim() : '';
		if (!command) {
			return error('Give the command to run, e.g. "npm test -- test/limits.test.js".');
		}
		const raw = Array.isArray(args.breakpoints) ? args.breakpoints : [];
		if (!raw.length || raw.length > MAX_LOGPOINTS) {
			return error(`Give between 1 and ${MAX_LOGPOINTS} breakpoints: {"file": "src/x.js", "line": 12, "condition": "count > 2"}.`);
		}
		const points: BreakpointSpec[] = [];
		for (const [index, entry] of raw.entries()) {
			const point = entry as { file?: unknown; line?: unknown; condition?: unknown };
			const checked = await this.checkLocation(point.file, point.line);
			if (typeof checked === 'string') {
				return error(`Breakpoint ${index + 1}: ${checked}`);
			}
			points.push({ ...checked, ...(typeof point.condition === 'string' && point.condition.trim() ? { condition: point.condition.trim() } : {}) });
		}
		const refused = this.refusal();
		if (refused) {
			return refused;
		}
		const cwd = await this.resolveCwd(args.cwd);
		if (typeof cwd !== 'string') {
			return cwd;
		}
		const open = await this.begin(command, cwd, points);
		if (!open.ok) {
			return open.result;
		}
		const description = await this.waitForStop(open.session, timeout(args.timeoutSeconds));
		return { text: `Started \`${command}\` under the debugger (session ${open.session.id}).\n${description}` };
	}

	/** Steps or continues the paused session, then reports where it paused next (or that it finished). */
	async step(args: { session?: unknown; action?: unknown; timeoutSeconds?: unknown }): Promise<DebugToolResult> {
		const session = this.find(args.session);
		if (typeof session === 'string') {
			return error(session);
		}
		const action = typeof args.action === 'string' ? args.action : 'continue';
		const request = ({ over: 'next', into: 'stepIn', out: 'stepOut', continue: 'continue' } as Record<string, string>)[action];
		if (!request) {
			return error('action is one of "over", "into", "out" or "continue".');
		}
		const stopped = session.stoppedAt;
		if (!stopped) {
			return error(session.ended ? 'The program has finished. Start it again to debug further.' : 'The program is running, not paused. Use action "continue" with a breakpoint ahead, or wait for one.');
		}
		session.stoppedAt = undefined;
		await session.session.request(stopped.target, request, { threadId: stopped.threadId });
		return { text: await this.waitForStop(session, timeout(args.timeoutSeconds)) };
	}

	/** Reads an expression in a frame of the paused program (0 is where it stopped). */
	async evaluate(args: { session?: unknown; expression?: unknown; frame?: unknown }): Promise<DebugToolResult> {
		const session = this.find(args.session);
		if (typeof session === 'string') {
			return error(session);
		}
		const expression = typeof args.expression === 'string' ? args.expression.trim() : '';
		if (!expression) {
			return error('Give an expression to read, e.g. "bucket.tokens".');
		}
		const stopped = session.stoppedAt;
		if (!stopped) {
			return error('The program isn\'t paused, so there is nothing to read. Pause it at a breakpoint first.');
		}
		const index = typeof args.frame === 'number' ? Math.max(0, Math.floor(args.frame)) : 0;
		const frame = stopped.frames.filter(candidate => candidate.id >= 0)[index];
		if (!frame) {
			return error(`There is no frame ${index}; the stack has ${stopped.frames.filter(candidate => candidate.id >= 0).length}.`);
		}
		try {
			const result = await session.session.request(stopped.target, 'evaluate', { expression, frameId: frame.id, context: 'watch' });
			return { text: `${expression} = ${clip(String(result?.result ?? 'undefined'), 2000)}${result?.type ? `  (${String(result.type)})` : ''}` };
		} catch (failure) {
			return error(`Couldn't read ${expression}: ${message(failure)}`);
		}
	}

	async stop(args: { session?: unknown }): Promise<DebugToolResult> {
		const session = this.find(args.session);
		if (typeof session === 'string') {
			return error(session);
		}
		await this.end(session);
		return { text: `Stopped debug session ${session.id}${session.output.length ? `. Program output (last ${session.output.length} lines):\n${session.output.join('\n')}` : '.'}` };
	}

	/** Ends whatever is still running (at the end of every coding turn, and on shutdown). */
	async stopAll(): Promise<void> {
		if (this.open) {
			this.options.log(`debug: stopping session ${this.open.id} (turn ended)`);
			await this.end(this.open);
		}
	}

	// ------------------------------------------------------------------ internals

	private async begin(command: string, cwd: string, points: readonly BreakpointSpec[]): Promise<{ ok: true; session: OpenSession } | { ok: false; result: DebugToolResult }> {
		const id = `d${this.nextId++}`;
		let removeBreakpoints: () => Promise<void> = async () => undefined;
		try {
			removeBreakpoints = await this.options.backend.addBreakpoints(points);
			const pending: DebugBackendEvent[] = [];
			let holder: OpenSession | undefined;
			const session = await this.options.backend.start({ runId: id, command, cwd }, event => {
				const target = holder;
				if (!target) {
					pending.push(event);
					return;
				}
				this.receive(target, event);
			});
			holder = { id, command, session, removeBreakpoints, queue: [], wake: undefined, stoppedAt: undefined, output: [], exitCode: undefined, ended: false, idleTimer: undefined };
			this.open = holder;
			for (const event of pending) {
				this.receive(holder, event);
			}
			this.touch(holder);
			this.options.log(`debug: started ${id}: ${command} (${points.length} point(s))`);
			return { ok: true, session: holder };
		} catch (failure) {
			await removeBreakpoints().catch(() => undefined);
			return { ok: false, result: error(`The debugger couldn't start \`${command}\`: ${message(failure)}`) };
		}
	}

	private receive(session: OpenSession, event: DebugBackendEvent): void {
		if (event.kind === 'exited') {
			session.exitCode = event.exitCode;
		}
		if (event.kind === 'terminated') {
			session.ended = true;
		}
		session.queue.push(event);
		session.wake?.();
	}

	/** The next event, or `undefined` if none arrives within `ms` (or the run already ended with nothing queued). */
	private async next(session: OpenSession, ms: number): Promise<DebugBackendEvent | undefined> {
		while (!session.queue.length) {
			if (session.ended || ms <= 0) {
				return undefined;
			}
			const started = this.now();
			await new Promise<void>(resolve => {
				const timer = setTimeout(resolve, ms);
				session.wake = () => {
					clearTimeout(timer);
					resolve();
				};
			});
			session.wake = undefined;
			ms -= this.now() - started;
		}
		return session.queue.shift();
	}

	/** Waits for a pause (described with its stack and locals), the end of the program, or the time limit. */
	private async waitForStop(session: OpenSession, timeoutMs: number): Promise<string> {
		const deadline = this.now() + timeoutMs;
		this.touch(session);
		for (; ;) {
			const event = await this.next(session, deadline - this.now());
			if (!event) {
				if (session.ended) {
					const output = session.output.length ? `\nProgram output (last ${session.output.length} lines):\n${session.output.join('\n')}` : '';
					await this.end(session);
					return `The program finished${session.exitCode === undefined ? '' : ` (exit code ${session.exitCode})`} without pausing at a breakpoint.${output}`;
				}
				return `Still running after ${Math.round(timeoutMs / 1000)}s without pausing. Call debug_step with action "continue" to keep waiting, or debug_stop.`;
			}
			if (event.kind === 'output') {
				for (const line of event.text.split('\n').filter(text => text.trim() && !this.isNoise(session, text))) {
					pushCapped(session.output, line, MAX_OUTPUT_LINES);
				}
			} else if (event.kind === 'stopped') {
				return this.describeStop(session, event);
			}
		}
	}

	/** The debugger's own lines, and the shell echoing the command, aren't the program's output. */
	private isNoise(session: OpenSession, line: string): boolean {
		return DEBUGGER_NOISE.test(line.trim()) || line.trim().endsWith(` -c ${session.command}`);
	}

	private async describeStop(session: OpenSession, event: Extract<DebugBackendEvent, { kind: 'stopped' }>): Promise<string> {
		const relative = (file: unknown) => typeof file === 'string' ? path.relative(this.options.workspaceRoot, file) || file : undefined;
		const frames: Array<{ id: number; label: string }> = [];
		let internals: { id: number; label: string } | undefined;
		let internalCount = 0;
		try {
			const trace = await session.session.request(event.target, 'stackTrace', { threadId: event.threadId, startFrame: 0, levels: 15 });
			for (const frame of (trace?.stackFrames as Array<Record<string, unknown>> | undefined) ?? []) {
				const source = frame.source as { path?: unknown; name?: unknown } | undefined;
				const file = typeof source?.path === 'string' ? source.path : '';
				if (frame.presentationHint === 'label') {
					// The async boundary js-debug reports between frames (an await, a timer, a promise).
					frames.push({ id: -1, label: `  ── async: ${String(frame.name ?? '')} ──` });
					internals = undefined;
					internalCount = 0;
				} else if (file.includes('<node_internals>') || file.includes('node:internal')) {
					// Node's own frames say little about the program: a run of them is counted on one line (each keeps
					// its number, so debug_evaluate's frame numbers still match).
					if (!internals) {
						internals = { id: -2, label: '' };
						frames.push(internals);
					}
					internalCount++;
					internals.label = `  … ${internalCount} Node.js internal frame${internalCount === 1 ? '' : 's'}`;
					frames.push({ id: Number(frame.id), label: '' });
				} else {
					const where = relative(source?.path) ?? (typeof source?.name === 'string' ? source.name : '?');
					frames.push({ id: Number(frame.id), label: `${String(frame.name || '(anonymous)')} (${where}:${String(frame.line ?? '?')})` });
					internals = undefined;
					internalCount = 0;
				}
			}
		} catch (failure) {
			this.options.log(`debug: stack trace failed: ${message(failure)}`);
		}
		session.stoppedAt = { target: event.target, threadId: event.threadId, frames };
		const top = frames.find(frame => frame.id >= 0 && frame.label);
		const locals: string[] = [];
		if (top) {
			try {
				const scopes = await session.session.request(event.target, 'scopes', { frameId: top.id });
				const scope = ((scopes?.scopes as Array<Record<string, unknown>> | undefined) ?? []).find(candidate => !candidate.expensive);
				if (scope) {
					const variables = await session.session.request(event.target, 'variables', { variablesReference: scope.variablesReference, count: 25 });
					for (const variable of ((variables?.variables as Array<Record<string, unknown>> | undefined) ?? []).slice(0, 25)) {
						locals.push(`  ${String(variable.name)} = ${clip(String(variable.value ?? ''), 160)}`);
					}
				}
			} catch (failure) {
				this.options.log(`debug: reading locals failed: ${message(failure)}`);
			}
		}
		let index = 0;
		const stack = frames.flatMap(frame => frame.id >= 0 ? (frame.label ? [`#${index++} ${frame.label}`] : (index++, [])) : [frame.label]);
		return [
			`Paused (${event.reason}) at ${top?.label ?? 'an unknown location'}.`,
			'', 'Call stack (async callers included):', ...stack,
			...(locals.length ? ['', 'Local variables:', ...locals] : []),
			'', `Next: debug_evaluate to read values, debug_step to move (over, into, out, continue), debug_stop when done (session ${session.id}).`,
		].join('\n');
	}

	private async end(session: OpenSession): Promise<void> {
		if (this.open === session) {
			this.open = undefined;
		}
		clearTimeout(session.idleTimer);
		if (!session.ended) {
			session.ended = true;
			await session.session.stop().catch(failure => this.options.log(`debug: stopping ${session.id} failed: ${message(failure)}`));
		}
		await session.removeBreakpoints().catch(failure => this.options.log(`debug: removing breakpoints failed: ${message(failure)}`));
		session.wake?.();
	}

	/** An interactive session nobody has used for a while is stopped, so it can't linger. */
	private touch(session: OpenSession): void {
		clearTimeout(session.idleTimer);
		session.idleTimer = setTimeout(() => {
			this.options.log(`debug: stopping idle session ${session.id}`);
			void this.end(session);
		}, IDLE_LIMIT_MS);
	}

	private find(id: unknown): OpenSession | string {
		const session = this.open;
		if (!session) {
			return 'No debug session is open. Start one with debug_start.';
		}
		if (typeof id === 'string' && id && id !== session.id) {
			return `Session ${id} is no longer open; the open one is ${session.id}.`;
		}
		this.touch(session);
		return session;
	}

	private refusal(): DebugToolResult | undefined {
		if (this.options.backend.developerIsDebugging()) {
			return error('The developer is debugging right now, and breakpoints are shared with their session, so the debugger isn\'t available. Continue without it (or try again later).');
		}
		if (this.open) {
			return error(`Debug session ${this.open.id} is still open (\`${this.open.command}\`). Stop it with debug_stop first.`);
		}
		return undefined;
	}

	private async checkLocation(file: unknown, line: unknown): Promise<{ file: string; line: number } | string> {
		if (typeof file !== 'string' || !file.trim()) {
			return 'give "file" as a path relative to the project root.';
		}
		if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) {
			return 'give "line" as a 1-based line number.';
		}
		const absolute = path.resolve(this.options.workspaceRoot, file.trim());
		const relative = path.relative(this.options.workspaceRoot, absolute);
		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			return `${file} is outside the project.`;
		}
		if (!SUPPORTED_FILE.test(relative)) {
			return `${relative}: only JavaScript and TypeScript files can be debugged so far.`;
		}
		if (!(await this.options.fileExists(absolute))) {
			return `${relative} doesn't exist.`;
		}
		return { file: relative, line };
	}

	private async resolveCwd(cwd: unknown): Promise<string | DebugToolResult> {
		// Models sometimes send "null" or "." for "the default".
		if (typeof cwd !== 'string' || !cwd.trim() || ['null', 'undefined', '.', './'].includes(cwd.trim())) {
			return this.options.workspaceRoot;
		}
		const absolute = path.resolve(this.options.workspaceRoot, cwd.trim());
		const relative = path.relative(this.options.workspaceRoot, absolute);
		if (relative.startsWith('..') || path.isAbsolute(relative)) {
			return error(`${cwd} is outside the project.`);
		}
		return (await this.options.directoryExists(absolute)) ? absolute : error(`${relative} isn't a directory in the project.`);
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}
}

function timeout(seconds: unknown): number {
	const value = typeof seconds === 'number' && seconds > 0 ? seconds : DEFAULT_TIMEOUT_S;
	return Math.min(MAX_TIMEOUT_S, value) * 1000;
}

function pushCapped(lines: string[], line: string, cap: number): void {
	lines.push(clip(line, 300));
	if (lines.length > cap) {
		lines.shift();
	}
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function error(text: string): DebugToolResult {
	return { text, isError: true };
}

function message(failure: unknown): string {
	return failure instanceof Error ? failure.message : String(failure);
}
