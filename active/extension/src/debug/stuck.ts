/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ToolOutcome } from '../shared/activeProtocol';
import { DEBUG_TOOL_PREFIX } from './debugTools';

/** Tools that run commands (the controller uses the same test for checkpoints). */
const COMMAND_TOOLS = /bash|shell|exec|terminal|command/i;
/** How a test run or command reports failing, in the common runners' words. */
const FAILURE_OUTPUT = /\b\d+ (?:failing|failed)\b|^\s*FAIL\b|\bnot ok \d|AssertionError|Test failed|exit(?:ed)? (?:with )?code [1-9]|exit status [1-9]/im;
/** A line added to print values while debugging. */
const DEBUG_PRINT = /console\.(?:log|debug|trace|dir)\(|^\s*print\(|\bdebugger;|System\.out\.println\(|fmt\.Print(?:ln|f)?\(|\bdbg!\(/gm;

/**
 * Whether the coding agent looks stuck in a way the debugger would help with, judged from the turn so far
 * without asking any model: the same command failing again, several failed runs, or print statements being added
 * to see values. Returns the reason, in words for the agent, or `undefined`. Never fires once the agent has used
 * the debug tools this turn.
 */
export function stuckReason(tools: readonly ToolOutcome[], changes: ReadonlyArray<{ readonly baseline: string | null; readonly final: string | null }>): string | undefined {
	if (tools.some(tool => tool.tool.startsWith(DEBUG_TOOL_PREFIX))) {
		return undefined;
	}
	const failures = new Map<string, number>();
	let failed = 0;
	for (const tool of tools) {
		if (!COMMAND_TOOLS.test(tool.tool) || !tool.command || tool.status === 'inProgress') {
			continue;
		}
		if (tool.status === 'failed' || FAILURE_OUTPUT.test(tool.output ?? '')) {
			failed++;
			const command = tool.command.trim().replace(/\s+/g, ' ');
			failures.set(command, (failures.get(command) ?? 0) + 1);
		}
	}
	const repeated = [...failures].find(([, count]) => count >= 2);
	if (repeated) {
		return `\`${repeated[0].slice(0, 120)}\` has failed ${repeated[1]} times this turn`;
	}
	if (failed >= 3) {
		return `${failed} commands have failed this turn`;
	}
	const prints = (text: string | null) => text?.match(DEBUG_PRINT)?.length ?? 0;
	if (changes.some(change => prints(change.final) > prints(change.baseline))) {
		return 'you\'re adding print statements to see values';
	}
	return undefined;
}

/** What Active tells the coding agent (once per turn) when it looks stuck. */
export function debuggerSuggestion(reason: string): string {
	return [
		`[Active, the IDE you're running in] ${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`,
		'You have a debugger available as tools: mcp__active__debug_run_with_logpoints runs a test with temporary logpoints and returns the values in the order the lines ran, without editing any files (so there\'s no console.log to add or remove).',
		'mcp__active__debug_start pauses at breakpoints so you can read the stack, including async callers, and variables.',
		'Consider using it to find the cause before trying another fix. If you added print statements to debug, remove them once you\'re done.',
	].join(' ');
}
