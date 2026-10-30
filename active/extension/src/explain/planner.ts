/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentItem, AgentSession } from '../agents/agentTypes';
import { CapturedFile, extractJsonObject, validateWalkthrough, WalkthroughDraft } from '../shared/activeProtocol';
import { buildCheckpointPrompt, buildPlanningPrompt, buildRepairPrompt, CheckpointContext, PlanningContext } from './prompts';

interface PendingTurn {
	readonly messages: string[];
	onText?: (text: string) => void;
	resolve(text: string): void;
	reject(error: Error): void;
}

/**
 * Wraps the read-only explanation session: one request at a time, each a turn
 * whose final agent message is the answer. It reads the live project under the
 * agent's read-only permission profile.
 */
export class ExplanationAgent {
	private session: AgentSession | undefined;
	private readonly turns = new Map<string, PendingTurn>();
	private early = new Map<string, { messages: string[]; terminal?: string; error?: string }>();
	private queue: Promise<unknown> = Promise.resolve();

	/**
	 * `turnTimeoutMs`: a turn that runs longer is interrupted, so one stuck reply can't hold up every later request.
	 * `reasoningEffort`: read for each request, so a settings change applies to the next one.
	 */
	constructor(
		private readonly openSession: (listener: ExplanationAgent) => Promise<AgentSession>,
		private readonly turnTimeoutMs = 5 * 60 * 1000,
		private readonly reasoningEffort: () => string | undefined = () => undefined,
	) { }

	/** The open session, if any (for applying a model change). */
	get currentSession(): AgentSession | undefined {
		return this.session;
	}

	/** Forgets the session (after a reconnect the old host is gone). */
	reset(): void {
		this.session = undefined;
		this.queue = Promise.resolve();
	}

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
				void session.startTurn(prompt, undefined, this.reasoningEffort()).then(turnId => {
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
					const timer = setTimeout(() => {
						if (this.turns.get(turnId) !== pending) {
							return;
						}
						this.turns.delete(turnId);
						void session.interruptTurn?.(turnId).catch(() => undefined);
						reject(new Error(`explanation turn took longer than ${Math.round(this.turnTimeoutMs / 1000)}s and was stopped`));
					}, this.turnTimeoutMs);
					const settle = <T>(done: (value: T) => void) => (value: T) => {
						clearTimeout(timer);
						done(value);
					};
					pending.resolve = settle(resolve);
					pending.reject = settle(reject);
				}, reject);
			});
		};
		const result = this.queue.then(run, run);
		this.queue = result.catch(() => undefined);
		return result;
	}
}

export interface PlanResult {
	readonly draft?: WalkthroughDraft;
	/** The explainer chose not to make a walkthrough: nothing (`skip`) or a short chat note. */
	readonly brief?: { readonly format: 'skip' | 'note'; readonly note?: string; readonly reason?: string };
	readonly errors: readonly string[];
	readonly dropped: readonly string[];
}

export type CheckpointDecision = { readonly decision: 'chapter' | 'wait'; readonly reason: string };

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
			const brief = briefOf(parsed);
			if (brief) {
				return { brief, errors: [], dropped: [] };
			}
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

	/** The cheap mid-turn question. Anything unparseable counts as "wait". */
	async checkpoint(context: CheckpointContext): Promise<CheckpointDecision> {
		const parsed = extractJsonObject(await this.agent.ask(buildCheckpointPrompt(context))) as { decision?: unknown; reason?: unknown } | undefined;
		return { decision: parsed?.decision === 'chapter' ? 'chapter' : 'wait', reason: typeof parsed?.reason === 'string' ? parsed.reason : '' };
	}

	/** Re-validates a draft against final captures (used when the net diff did not change since the draft). */
	reconcile(draft: WalkthroughDraft, files: Readonly<Record<string, CapturedFile>>, evidence: ReadonlySet<string>): PlanResult {
		return validateWalkthrough(draft, files, evidence);
	}
}

function briefOf(parsed: unknown): PlanResult['brief'] {
	const value = parsed as { format?: unknown; note?: unknown; reason?: unknown } | undefined;
	if (value?.format !== 'skip' && value?.format !== 'note') {
		return undefined;
	}
	const text = (field: unknown) => typeof field === 'string' && field.trim() ? field.trim() : undefined;
	const note = text(value.note);
	// A note without text is no more than a skip.
	return { format: value.format === 'note' && note ? 'note' : 'skip', note, reason: text(value.reason) };
}
