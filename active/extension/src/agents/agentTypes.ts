/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Platform-neutral agent abstractions. Active's orchestration only depends on
 * these; `museHost.ts` adapts Muse Code to them, so another agent platform can
 * be substituted by writing a new adapter.
 */

import type { AgentModelInfo } from '../shared/activeProtocol';
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
	/** A `subagent` item: a helper the coding agent spawned, with its own session. */
	readonly subagent?: AgentSubagentInfo;
}

export interface AgentSubagentInfo {
	readonly subagentId: string;
	readonly childSessionId?: string;
	readonly objective?: string;
	readonly role?: string;
	readonly agentPath?: string;
	/** Muse's child status (`running`, `resultReady`, `closed`, …). */
	readonly controlStatus?: string;
	readonly resultSummary?: string;
	readonly failureReason?: string;
	readonly depth?: number;
}

export interface AgentTodoItem {
	readonly text: string;
	readonly status: string;
}

export interface AgentUsage {
	readonly totalTokens: number;
	/** Estimated USD for the session so far, when the provider prices it. */
	readonly costUsd?: number;
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
	/** The agent's plan (replaced wholesale). */
	onTodo?(items: readonly AgentTodoItem[]): void;
	/** Running totals for the session. */
	onUsage?(usage: AgentUsage): void;
}

export interface AgentSession {
	readonly sessionId: string;
	/** Starts a turn; resolves with the turn id once the host admits it. `reasoningEffort` applies to this turn only. */
	startTurn(text: string, displayText?: string, reasoningEffort?: string): Promise<string>;
	/** Switches the model for the session's later model calls, when the provider supports it. */
	setModel?(modelId: string): Promise<void>;
	decideApproval(approvalId: string, choiceId: string): Promise<void>;
	listTasks(): Promise<AgentTask[]>;
	readOutput(itemId: string, outputRef: string, maxBytes?: number): Promise<string | undefined>;
	/** A short description of the signed-in account (e.g. a subscription tier), when the provider reports one. */
	accountSummary?(): Promise<string | undefined>;
	/** Stops a running turn, when the provider supports it. */
	interruptTurn?(turnId: string): Promise<void>;
	/** Sends a subagent this session spawned a message (while it runs) or a follow-up task (once it's finished). */
	messageSubagent?(subagentId: string, body: string, followUp: boolean): Promise<void>;
	/** Interrupts a subagent this session spawned. */
	stopSubagent?(subagentId: string): Promise<void>;
	/** Switches how the agent's actions are approved (Muse's `ApprovalMode`), when the provider supports it. */
	setApprovalMode?(mode: string): Promise<void>;
	/** Adds a message to the running turn `turnId` (the agent reads it at its next step), when the provider supports it. */
	steer?(turnId: string, text: string): Promise<void>;
}

export interface AgentSessionOptions {
	readonly workspaceRoot: string;
	readonly readOnly: boolean;
	readonly listener: AgentSessionListener;
	/** Tool servers (MCP over HTTP) for this session only, by name: e.g. an agent's debugger in its own folder. */
	readonly mcpServers?: Readonly<Record<string, SessionToolServer>>;
}

export interface SessionToolServer {
	readonly url: string;
	readonly headers?: Readonly<Record<string, string>>;
}

export interface AgentHost {
	readonly description: string;
	/** The models the agent offers, when the provider can list them. */
	listModels?(): Promise<AgentModelInfo[]>;
	startSession(options: AgentSessionOptions): Promise<AgentSession>;
	/** Reattaches to a stored session (for example the one open before a restart), when the provider supports it. */
	resumeSession?(sessionId: string, options: AgentSessionOptions): Promise<AgentSession>;
	readonly exited: Promise<string>;
	dispose(): Promise<void>;
	/** Whether sessions can be given their own tool servers (`AgentSessionOptions.mcpServers`); unknown when absent. */
	readonly sessionTools?: boolean;
	/**
	 * Follows a session Active didn't start (a subagent's), read-only: its items reach `listener`. Resolves with its
	 * worktree, when it runs in one.
	 */
	watchSession?(sessionId: string, listener: AgentSessionListener): Promise<{ readonly worktreeRoot?: string; dispose(): void }>;
}
