/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { DebugRunner, DebugToolResult } from './debugRunner';

/** An MCP tool: its name (Muse shows it as `mcp__active__<name>`), what it's for, and its JSON Schema input. */
export interface McpTool {
	readonly name: string;
	readonly description: string;
	readonly inputSchema: Record<string, unknown>;
}

/** The server name in Muse's settings, which prefixes the tools' names there. */
export const MCP_SERVER_NAME = 'active';
/** Muse's names for these tools start with this. */
export const DEBUG_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__debug_`;

const COMMAND = { type: 'string', description: 'The command that runs the code, usually a single test: e.g. "npm test -- test/limits.test.js" (JavaScript/TypeScript, any shell command), "pytest tests/test_limits.py -k retry" or "python -m app.cli" (Python), "go test ./internal/limits -run TestRetry" (Go, one package), "cargo test --lib retry" or a built program like "./build/tests" (C, C++, Rust). Outside JavaScript it must be one plain command (no pipes or &&). Run as narrow a test as you can.' };
const CWD = { type: 'string', description: 'Directory to run it in, relative to the project root. Defaults to the project root.' };
const FILE = { type: 'string', description: 'Path relative to the project root (a JavaScript, TypeScript, Python, Go, C, C++ or Rust file; all points in one run in the same language).' };
const LINE = { type: 'integer', minimum: 1, description: '1-based line number. Pick a line with a statement on it.' };
const TIMEOUT = { type: 'number', description: 'Seconds to wait before giving up (default 60, at most 300).' };
const SESSION = { type: 'string', description: 'The session id debug_start returned.' };

/**
 * The debugger as tools for the coding agent. The descriptions say when to reach for them, since that's what
 * the model reads when deciding what to call.
 */
export const DEBUG_TOOLS: readonly McpTool[] = [
	{
		name: 'debug_run_with_logpoints',
		description: [
			'Run a command (usually a failing test) under the debugger with temporary logpoints, and get back what each logpoint printed, in the order the lines actually ran, plus how often each ran and the program\'s output.',
			'Use this instead of adding console.log, print or printf statements: it shows real runtime values without editing any files, so there is nothing to clean up afterwards.',
			'Reach for it when a test fails and the cause isn\'t obvious from the error, when a fix didn\'t work, when you\'ve run the same test more than once without learning why it fails, or when you\'re unsure which path the code takes.',
			'Each message can include expressions in braces, e.g. "retries={retries} wait={opts.wait}". Only read values in them; don\'t call functions with side effects.',
			'Works with JavaScript, TypeScript, Python, Go, C, C++ and Rust. Not available while the developer is debugging.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				command: COMMAND,
				cwd: CWD,
				logpoints: {
					type: 'array',
					minItems: 1,
					maxItems: 20,
					items: {
						type: 'object',
						properties: {
							file: FILE,
							line: LINE,
							message: { type: 'string', description: 'What to print when the line runs, with {expressions} to show values, e.g. "token bucket: tokens={this.tokens} pausedUntil={this.pausedUntil}".' },
							maxHits: { type: 'integer', minimum: 1, maximum: 100, description: 'Stop printing after this many hits (default 20), for lines inside loops.' },
						},
						required: ['file', 'line', 'message'],
					},
				},
				timeoutSeconds: TIMEOUT,
			},
			required: ['command', 'logpoints'],
		},
	},
	{
		name: 'debug_start',
		description: [
			'Start a command under the debugger and pause at the first breakpoint it reaches. Returns where it paused, the call stack (including the async callers that scheduled it) and the local variables.',
			'Use it when you need to look around at a specific moment: read several values, follow a call step by step, or find out who called something. For most questions debug_run_with_logpoints is quicker.',
			'One session at a time; stop it with debug_stop when you\'re done. Works with JavaScript, TypeScript, Python, Go, C, C++ and Rust. Not available while the developer is debugging.',
		].join(' '),
		inputSchema: {
			type: 'object',
			properties: {
				command: COMMAND,
				cwd: CWD,
				breakpoints: {
					type: 'array',
					minItems: 1,
					maxItems: 20,
					items: {
						type: 'object',
						properties: {
							file: FILE,
							line: LINE,
							condition: { type: 'string', description: 'Only pause when this expression is true, e.g. "attempt === 3".' },
						},
						required: ['file', 'line'],
					},
				},
				timeoutSeconds: TIMEOUT,
			},
			required: ['command', 'breakpoints'],
		},
	},
	{
		name: 'debug_step',
		description: 'Move the paused program: "over" runs the current line, "into" enters the call on it, "out" finishes the current function, "continue" runs to the next breakpoint. Returns where it paused next (stack and locals), or that the program finished.',
		inputSchema: {
			type: 'object',
			properties: {
				session: SESSION,
				action: { type: 'string', enum: ['over', 'into', 'out', 'continue'] },
				timeoutSeconds: TIMEOUT,
			},
			required: ['action'],
		},
	},
	{
		name: 'debug_evaluate',
		description: 'Read the value of an expression in the paused program, e.g. "bucket.tokens" or "requests.length". Frame 0 is where it paused; higher numbers are its callers, as numbered in the call stack. Only read values; don\'t call functions with side effects.',
		inputSchema: {
			type: 'object',
			properties: {
				session: SESSION,
				expression: { type: 'string' },
				frame: { type: 'integer', minimum: 0, description: 'Which stack frame to evaluate in (default 0).' },
			},
			required: ['expression'],
		},
	},
	{
		name: 'debug_stop',
		description: 'End the debug session and remove its breakpoints. Returns the program\'s last output.',
		inputSchema: { type: 'object', properties: { session: SESSION } },
	},
];

/** Runs one of the debug tools. */
export async function callDebugTool(runner: DebugRunner, name: string, args: Record<string, unknown>): Promise<DebugToolResult> {
	switch (name) {
		case 'debug_run_with_logpoints': return runner.runWithLogpoints(args);
		case 'debug_start': return runner.start(args);
		case 'debug_step': return runner.step(args);
		case 'debug_evaluate': return runner.evaluate(args);
		case 'debug_stop': return runner.stop(args);
		default: return { text: `Unknown tool ${name}.`, isError: true };
	}
}

/** A one-line description of a debug tool call for chat, from its arguments (Muse's raw tool name otherwise). */
export function describeDebugCall(tool: string, rawArgs: string | undefined): string | undefined {
	if (!tool.startsWith(DEBUG_TOOL_PREFIX)) {
		return undefined;
	}
	let args: Record<string, unknown> = {};
	try {
		args = rawArgs ? JSON.parse(rawArgs) as Record<string, unknown> : {};
	} catch {
		args = {};
	}
	const count = (value: unknown) => Array.isArray(value) ? value.length : 0;
	const command = typeof args.command === 'string' ? `\`${args.command}\`` : 'a command';
	switch (tool.slice(DEBUG_TOOL_PREFIX.length - 'debug_'.length)) {
		case 'debug_run_with_logpoints': return `Debugging: ran ${command} with ${count(args.logpoints)} logpoint${count(args.logpoints) === 1 ? '' : 's'}`;
		case 'debug_start': return `Debugging: started ${command} with ${count(args.breakpoints)} breakpoint${count(args.breakpoints) === 1 ? '' : 's'}`;
		case 'debug_step': return `Debugging: step ${typeof args.action === 'string' ? args.action : ''}`.trim();
		case 'debug_evaluate': return `Debugging: read ${typeof args.expression === 'string' ? args.expression : 'a value'}`;
		case 'debug_stop': return 'Debugging: stopped the session';
		default: return 'Debugging';
	}
}
