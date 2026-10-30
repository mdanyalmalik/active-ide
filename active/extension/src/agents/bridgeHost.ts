/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * DEV ONLY. An agent host whose sessions are served by external agents (for
 * example Claude Code subagents) through a mailbox directory, so the rest of
 * Active (change capture, worthiness, planning, playback, history) can be
 * exercised end to end without Muse Code.
 *
 * Layout under `<bridgeDir>/<role>/` where role is `coding` or `explanation`:
 *   inbox/<seq>-<turnId>.json    written here: { turnId, sessionId, text, workspaceRoot, readOnly }
 *   outbox/<turnId>.jsonl        appended by the agent, one event per line:
 *     { "type": "message", "text": "...", "phase": "commentary" | "finalAnswer" }
 *     { "type": "reasoning", "summary": "..." }              (an exposed summary, not a trace)
 *     { "type": "tool", "id": "t1", "label": "...", "status": "inProgress" | "completed" | "failed", "command"?: "...", "output"?: "..." }
 *     { "type": "background", "id": "b1", "command": "...", "status": "inProgress" | "completed" | "failed", "output"?: "..." }
 *     { "type": "done" } | { "type": "failed", "error": "..." }
 * `active/extension/test-fixtures/bridge-agent.mjs` is the CLI agents use to read and write these.
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AgentHost, AgentItem, AgentSession, AgentSessionListener, AgentSessionOptions, AgentTask } from './agentTypes';

const POLL_MS = 300;

interface BridgeEvent {
	readonly type: string;
	readonly text?: string;
	readonly phase?: string;
	readonly summary?: string;
	readonly id?: string;
	readonly label?: string;
	readonly status?: string;
	readonly command?: string;
	readonly output?: string;
	readonly error?: string;
}

export class BridgeHost implements AgentHost {
	readonly description: string;
	private resolveExit!: (reason: string) => void;
	readonly exited = new Promise<string>(resolve => { this.resolveExit = resolve; });
	private readonly sessions: BridgeSession[] = [];

	constructor(private readonly bridgeDir: string, private readonly role: 'coding' | 'explanation') {
		this.description = `Claude Code subagent bridge · ${role} (dev only)`;
	}

	async startSession(options: AgentSessionOptions): Promise<AgentSession> {
		const dir = path.join(this.bridgeDir, this.role);
		await fs.mkdir(path.join(dir, 'inbox'), { recursive: true });
		await fs.mkdir(path.join(dir, 'outbox'), { recursive: true });
		const session = new BridgeSession(`bridge-${this.role}-${Date.now().toString(36)}`, dir, options);
		this.sessions.push(session);
		return session;
	}

	/** Bridge sessions hold no agent-side state, so resuming only reuses the id; turn ids get a fresh suffix so they never collide with claimed ones. */
	async resumeSession(sessionId: string, options: AgentSessionOptions): Promise<AgentSession> {
		if (!sessionId.startsWith(`bridge-${this.role}-`)) {
			throw new Error(`not a bridge ${this.role} session: ${sessionId}`);
		}
		const dir = path.join(this.bridgeDir, this.role);
		await fs.mkdir(path.join(dir, 'inbox'), { recursive: true });
		await fs.mkdir(path.join(dir, 'outbox'), { recursive: true });
		const session = new BridgeSession(sessionId, dir, options, `r${Date.now().toString(36)}`);
		this.sessions.push(session);
		return session;
	}

	async dispose(): Promise<void> {
		for (const session of this.sessions) {
			session.dispose();
		}
		this.resolveExit('bridge host disposed');
	}
}

class BridgeSession implements AgentSession {
	private seq = 0;
	private readonly timers = new Set<NodeJS.Timeout>();
	private readonly background = new Map<string, AgentTask>();

	constructor(readonly sessionId: string, private readonly dir: string, private readonly options: AgentSessionOptions, private readonly turnPrefix = '') { }

	private get listener(): AgentSessionListener {
		return this.options.listener;
	}

	async startTurn(text: string): Promise<string> {
		const turnId = `${this.sessionId}-${this.turnPrefix}t${++this.seq}`;
		const request = { turnId, sessionId: this.sessionId, text, workspaceRoot: this.options.workspaceRoot, readOnly: this.options.readOnly, at: Date.now() };
		const name = `${String(Date.now()).padStart(15, '0')}-${turnId}.json`;
		const target = path.join(this.dir, 'inbox', name);
		await fs.writeFile(`${target}.tmp`, JSON.stringify(request, null, '\t'));
		await fs.rename(`${target}.tmp`, target);
		setTimeout(() => {
			this.listener.onTurnStarted?.(turnId);
			this.follow(turnId);
		}, 0);
		return turnId;
	}

	/** Tails the turn's outbox file and turns its events into agent items. */
	private follow(turnId: string): void {
		const file = path.join(this.dir, 'outbox', `${turnId}.jsonl`);
		let offset = 0;
		let carry = '';
		let messageIndex = 0;
		let ended = false;
		const pendingBackground = () => [...this.background.keys()].some(id => id.startsWith(`${turnId}-`));
		const tick = async () => {
			let chunk = '';
			try {
				const handle = await fs.open(file, 'r');
				try {
					const stat = await handle.stat();
					if (stat.size > offset) {
						const buffer = Buffer.alloc(stat.size - offset);
						await handle.read(buffer, 0, buffer.length, offset);
						offset = stat.size;
						chunk = buffer.toString('utf8');
					}
				} finally {
					await handle.close();
				}
			} catch {
				// not created yet
			}
			const lines = (carry + chunk).split('\n');
			carry = lines.pop() ?? '';
			for (const line of lines) {
				if (!line.trim()) {
					continue;
				}
				let event: BridgeEvent;
				try {
					event = JSON.parse(line);
				} catch {
					continue;
				}
				if (ended && event.type !== 'background') {
					continue;
				}
				if (this.handle(turnId, event, messageIndex)) {
					ended = true;
				}
				if (event.type === 'message') {
					messageIndex++;
				}
			}
			// Keep tailing after the turn ends while its background tasks are still reporting.
			if (ended && !pendingBackground()) {
				return;
			}
			const timer = setTimeout(tick, POLL_MS);
			this.timers.add(timer);
		};
		void tick();
	}

	/** Returns true when the turn ended. */
	private handle(turnId: string, event: BridgeEvent, messageIndex: number): boolean {
		const item = (fields: Omit<AgentItem, 'turnId'>, completed: boolean) => this.listener.onItem?.({ ...fields, turnId }, completed);
		switch (event.type) {
			case 'message':
				item({ id: `${turnId}-m${messageIndex}`, kind: 'agentMessage', status: 'completed', text: event.text ?? '', phase: event.phase ?? 'commentary' }, true);
				return false;
			case 'reasoning':
				item({ id: `${turnId}-r${messageIndex}-${Date.now()}`, kind: 'reasoning', status: 'completed', reasoningSummary: [event.summary ?? ''] }, true);
				return false;
			case 'tool': {
				const status = event.status ?? 'completed';
				item({ id: `${turnId}-${event.id ?? 'tool'}`, kind: 'toolCall', status, tool: 'tool', label: event.label, args: event.command ? JSON.stringify({ command: event.command }) : undefined, output: event.output }, status !== 'inProgress');
				return false;
			}
			case 'background': {
				const id = `${turnId}-${event.id ?? 'bg'}`;
				if (event.status === 'inProgress' || !event.status) {
					this.background.set(id, { taskId: id, command: event.command, tool: 'shell', background: true });
					item({ id, kind: 'toolCall', status: 'inProgress', tool: 'shell', background: true, args: JSON.stringify({ command: event.command }) }, false);
				} else {
					this.background.delete(id);
					item({ id, kind: 'toolCall', status: event.status, tool: 'shell', background: true, args: JSON.stringify({ command: event.command }), output: event.output }, true);
					item({ id: `${id}-done`, kind: 'backgroundTerminalCompletion', status: 'completed', backgroundCompletion: { command: event.command ?? '', output: event.output ?? '', terminalStatus: event.status, toolCallId: id } }, true);
				}
				return false;
			}
			case 'done':
				this.listener.onTurnCompleted?.(turnId, 'completed');
				return true;
			case 'failed':
				this.listener.onTurnCompleted?.(turnId, 'failed', event.error ?? 'bridge agent reported failure');
				return true;
		}
		return false;
	}

	async decideApproval(): Promise<void> {
		// Bridge agents never request approvals.
	}

	async listTasks(): Promise<AgentTask[]> {
		return [...this.background.values()];
	}

	async readOutput(): Promise<string | undefined> {
		return undefined;
	}

	dispose(): void {
		for (const timer of this.timers) {
			clearTimeout(timer);
		}
	}
}
