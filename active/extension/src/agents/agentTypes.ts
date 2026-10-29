/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Platform-neutral agent abstractions. Active's orchestration only depends on
 * these; `museHost.ts` adapts Muse Code to them, so another agent platform can
 * be substituted by writing a new adapter.
 */

export interface AgentItem {
	readonly id: string;
	readonly turnId?: string | null;
	/** `userMessage`, `agentMessage`, `reasoning`, `toolCall`, `backgroundTerminalCompletion`, ... (open). */
	readonly kind: string;
	readonly status: string;
	readonly text?: string;
	readonly phase?: string;
	readonly tool?: string;
	readonly args?: string;
	readonly label?: string;
	readonly output?: string;
	readonly outputRef?: string;
	readonly reasoningSummary?: readonly string[];
	readonly background?: boolean;
	readonly failureReason?: string;
	readonly patch?: { readonly added: number; readonly removed: number; readonly files: number };
	readonly backgroundCompletion?: { readonly command: string; readonly output: string; readonly terminalStatus: string; readonly toolCallId: string };
	readonly callId?: string;
	readonly fallbackText?: string;
}

export interface AgentApproval {
	readonly approvalId: string;
	readonly turnId: string;
	readonly itemId: string;
	readonly toolName: string;
	readonly title: string;
	readonly detail: string;
	readonly choices: ReadonlyArray<{ readonly choiceId: string; readonly label: string; readonly approves: boolean }>;
}

export interface AgentTask {
	readonly taskId: string;
	readonly tool?: string;
	readonly command?: string;
	readonly background: boolean;
}

export interface AgentSessionListener {
	onTurnStarted?(turnId: string): void;
	onItem?(item: AgentItem, completed: boolean): void;
	onDelta?(itemId: string, field: string, delta: string): void;
	/** `errorKind` is the provider's failure class (e.g. Muse's `authRequired`), when it reports one. */
	onTurnCompleted?(turnId: string, terminal: string, error?: string, errorKind?: string): void;
	onApproval?(approval: AgentApproval): void;
	onApprovalResolved?(approvalId: string, decision: string): void;
}

export interface AgentSession {
	readonly sessionId: string;
	/** Starts a turn; resolves with the turn id once the host admits it. */
	startTurn(text: string, displayText?: string): Promise<string>;
	decideApproval(approvalId: string, choiceId: string): Promise<void>;
	listTasks(): Promise<AgentTask[]>;
	readOutput(itemId: string, outputRef: string, maxBytes?: number): Promise<string | undefined>;
	/** A short description of the signed-in account (e.g. a subscription tier), when the provider reports one. */
	accountSummary?(): Promise<string | undefined>;
}

export interface AgentSessionOptions {
	readonly workspaceRoot: string;
	readonly readOnly: boolean;
	readonly listener: AgentSessionListener;
}

export interface AgentHost {
	readonly description: string;
	startSession(options: AgentSessionOptions): Promise<AgentSession>;
	readonly exited: Promise<string>;
	dispose(): Promise<void>;
}
