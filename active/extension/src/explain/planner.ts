/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { AgentItem, AgentSession } from '../agents/agentTypes';
import { CapturedFile, extractJsonObject, validateWalkthrough, WalkthroughDraft } from '../shared/activeProtocol';
import { buildPlanningPrompt, buildRepairPrompt, PlanningContext } from './prompts';

interface PendingTurn {
	readonly messages: string[];
	onText?: (text: string) => void;
	resolve(text: string): void;
	reject(error: Error): void;
}

/**
 * Wraps the read-only explanation session: one request at a time, each a turn
 * whose final agent message is the answer. Its workspace is a snapshot
 * directory, never the project.
 */
export class ExplanationAgent {
	private session: AgentSession | undefined;
	private readonly turns = new Map<string, PendingTurn>();
	private early = new Map<string, { messages: string[]; terminal?: string; error?: string }>();
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly openSession: (listener: ExplanationAgent) => Promise<AgentSession>, readonly workspace: string) { }

	private async ensureSession(): Promise<AgentSession> {
		this.session ??= await this.openSession(this);
		return this.session;
	}

	// AgentSessionListener
	onItem(item: AgentItem, completed: boolean): void {
		if (item.kind !== 'agentMessage' || !item.turnId) {
			return;
		}
		const pending = this.turns.get(item.turnId);
		if (completed && item.text) {
			if (pending) {
				pending.messages.push(item.text);
			} else {
				const early = this.early.get(item.turnId) ?? { messages: [] };
				early.messages.push(item.text);
				this.early.set(item.turnId, early);
			}
		}
	}

	onDelta(itemId: string, field: string, text: string): void {
		if (field !== 'text') {
			return;
		}
		for (const pending of this.turns.values()) {
			pending.onText?.(text);
		}
		void itemId;
	}

	onTurnCompleted(turnId: string, terminal: string, error?: string): void {
		const pending = this.turns.get(turnId);
		if (!pending) {
			const early = this.early.get(turnId) ?? { messages: [] };
			early.terminal = terminal;
			early.error = error;
			this.early.set(turnId, early);
			return;
		}
		this.turns.delete(turnId);
		if (terminal === 'completed' && pending.messages.length) {
			pending.resolve(pending.messages[pending.messages.length - 1]);
		} else {
			pending.reject(new Error(error ?? `explanation turn ended: ${terminal}`));
		}
	}

	/** Sends one prompt and resolves with the final reply. Requests are serialized. */
	ask(prompt: string, onText?: (text: string) => void): Promise<string> {
		const run = async () => {
			const session = await this.ensureSession();
			return new Promise<string>((resolve, reject) => {
				void session.startTurn(prompt).then(turnId => {
					const pending: PendingTurn = { messages: [], onText, resolve, reject };
					const early = this.early.get(turnId);
					this.early.delete(turnId);
					if (early) {
						pending.messages.push(...early.messages);
						if (early.terminal) {
							if (early.terminal === 'completed' && pending.messages.length) {
								resolve(pending.messages[pending.messages.length - 1]);
							} else {
								reject(new Error(early.error ?? `explanation turn ended: ${early.terminal}`));
							}
							return;
						}
					}
					this.turns.set(turnId, pending);
				}, reject);
			});
		};
		const result = this.queue.then(run, run);
		this.queue = result.catch(() => undefined);
		return result;
	}

	/** Mirrors the captured project files into the explanation workspace (the only place it can read). */
	async syncWorkspace(files: Map<string, string>): Promise<void> {
		for (const [relative, content] of files) {
			const target = path.join(this.workspace, ...relative.split('/'));
			let existing: string | undefined;
			try {
				existing = await fs.readFile(target, 'utf8');
			} catch {
				existing = undefined;
			}
			if (existing !== content) {
				await fs.mkdir(path.dirname(target), { recursive: true });
				await fs.writeFile(target, content, 'utf8');
			}
		}
	}
}

export interface PlanResult {
	readonly draft?: WalkthroughDraft;
	readonly errors: readonly string[];
	readonly dropped: readonly string[];
}

/**
 * Asks the explanation model for a structured walkthrough and validates it
 * against the captured files; invalid output is sent back for repair.
 */
export class WalkthroughPlanner {
	constructor(private readonly agent: ExplanationAgent, private readonly log: (line: string) => void) { }

	async plan(context: PlanningContext, previous?: WalkthroughDraft): Promise<PlanResult> {
		const evidence = new Set(context.tools.map(tool => tool.id));
		let reply = await this.agent.ask(buildPlanningPrompt(context, previous));
		let errors: readonly string[] = [];
		for (let attempt = 0; attempt < 3; attempt++) {
			const parsed = extractJsonObject(reply);
			const result = validateWalkthrough(parsed, context.files, evidence);
			if (result.draft) {
				return result;
			}
			errors = result.errors.length ? result.errors : ['no scenes remained after reconciling with the final changes'];
			if (!result.errors.length) {
				return { errors, dropped: result.dropped };
			}
			this.log(`walkthrough validation failed (attempt ${attempt + 1}): ${errors.join('; ')}`);
			if (attempt < 2) {
				reply = await this.agent.ask(buildRepairPrompt(errors));
			}
		}
		return { errors, dropped: [] };
	}

	/** Re-validates a draft against final captures (used when the net diff did not change since the draft). */
	reconcile(draft: WalkthroughDraft, files: Readonly<Record<string, CapturedFile>>, evidence: ReadonlySet<string>): PlanResult {
		return validateWalkthrough(draft, files, evidence);
	}
}
