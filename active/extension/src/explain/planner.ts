/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { AgentItem, AgentSession } from '../agents/agentTypes';
import { CapturedFile, extractJsonObject, validateWalkthrough, WalkthroughDraft } from '../shared/activeProtocol';
import { diffLines, splitLines } from '../tracking/lineDiff';
import { MemoryInput, rememberOf } from './memory';
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
	/** Requests waiting for the session; urgent ones (the developer's questions) go ahead of background work. */
	private readonly waiting: Array<{ readonly run: () => Promise<void>; readonly urgent: boolean }> = [];
	private busy = false;
	private generation = 0;

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
		// A turn on the old host may never report back: don't let it hold up later requests.
		this.generation++;
		this.busy = false;
		this.pump();
	}

	private pump(): void {
		if (this.busy) {
			return;
		}
		const next = this.waiting.shift();
		if (!next) {
			return;
		}
		this.busy = true;
		const generation = this.generation;
		void next.run().finally(() => {
			if (generation === this.generation) {
				this.busy = false;
				this.pump();
			}
		});
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

	/**
	 * Sends one prompt and resolves with the final reply. Requests are serialized; `urgent` ones (a question
	 * or "More detail" the developer is waiting on) start before queued background work such as chapter checks.
	 */
	ask(prompt: string, onText?: (text: string) => void, urgent = false): Promise<string> {
		const turn = async () => {
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
		return new Promise<string>((resolve, reject) => {
			const run = () => turn().then(resolve, reject);
			const index = urgent ? this.waiting.findIndex(entry => !entry.urgent) : -1;
			this.waiting.splice(index < 0 ? this.waiting.length : index, 0, { run, urgent });
			this.pump();
		});
	}
}

export interface PlanResult {
	readonly draft?: WalkthroughDraft;
	/** The explainer chose not to make a walkthrough: nothing (`skip`) or a short note (shown in chat and inline at `at`). */
	readonly brief?: NoteBrief;
	readonly errors: readonly string[];
	readonly dropped: readonly string[];
	/** Notes the explainer asked to keep in its memory; saved only when this result is used. */
	readonly remember?: readonly MemoryInput[];
}

export interface NoteBrief {
	readonly format: 'skip' | 'note';
	readonly note?: string;
	readonly reason?: string;
	/** A short headline for the inline version of the note. */
	readonly title?: string;
	/** Where the note belongs in the code; checked against the captured files before use. */
	readonly at?: { readonly file: string; readonly focus: ReadonlyArray<{ readonly startLine: number; readonly endLine: number }>; readonly anchorLine?: number };
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
		let remember: MemoryInput[] = [];
		for (let attempt = 0; attempt < 3; attempt++) {
			const parsed = extractJsonObject(reply);
			// A repaired reply may leave out "remember": keep what the first one asked for.
			const asked = rememberOf(parsed);
			remember = asked.length ? asked : remember;
			const brief = briefOf(parsed);
			if (brief) {
				return { brief, errors: [], dropped: [], remember };
			}
			const result = validateWalkthrough(parsed, context.files, evidence);
			if (result.draft) {
				return { ...result, remember };
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

const NOTE_FOCUS_LINES = 15;

/**
 * The inline version of a short note: one scene on the lines it's about. Uses the explainer's location when
 * it checks out against the captured files, otherwise the largest change (preferring non-test files).
 */
export function noteDraft(brief: NoteBrief, files: Readonly<Record<string, CapturedFile>>): WalkthroughDraft | undefined {
	if (brief.format !== 'note' || !brief.note) {
		return undefined;
	}
	const note = brief.note;
	const sentences = note.split(/(?<=[.!?])\s+/).filter(Boolean);
	const narration = [];
	for (let index = 0; index < sentences.length; index += 2) {
		narration.push({ text: sentences.slice(index, index + 2).join(' ') });
	}
	for (const at of [brief.at, largestChange(files)]) {
		if (!at) {
			continue;
		}
		// Without a title of its own, the note's first sentence would just be repeated as its heading.
		const title = brief.title ?? `Note on ${at.file.split('/').pop()}`;
		const scene = { id: 'note', role: 'summary', label: 'Note', title, file: at.file, version: 'final', focus: at.focus, anchorLine: at.anchorLine ?? at.focus[at.focus.length - 1].endLine, narration };
		const result = validateWalkthrough({ title, summary: note, terms: [], scenes: [scene] }, files, new Set());
		if (result.draft) {
			return result.draft;
		}
	}
	return undefined;
}

function largestChange(files: Readonly<Record<string, CapturedFile>>): NoteBrief['at'] {
	const candidates = Object.values(files).filter(file => file.final !== null);
	const nonTest = candidates.filter(file => !/(^|\/)(tests?|__tests__|spec)\/|[._-](test|spec)\.[^/]+$/i.test(file.path));
	let best: { file: string; start: number; lines: number } | undefined;
	for (const file of nonTest.length ? nonTest : candidates) {
		const lineCount = splitLines(file.final).length;
		for (const hunk of diffLines(file.baseline, file.final)) {
			const start = Math.min(Math.max(hunk.newStart, 1), lineCount);
			if (!best || hunk.newLines > best.lines) {
				best = { file: file.path, start, lines: hunk.newLines };
			}
		}
	}
	if (!best) {
		return undefined;
	}
	const lineCount = splitLines(files[best.file].final).length;
	const end = Math.min(lineCount, best.start + Math.max(1, Math.min(best.lines, NOTE_FOCUS_LINES)) - 1);
	return { file: best.file, focus: [{ startLine: best.start, endLine: end }] };
}

function briefOf(parsed: unknown): PlanResult['brief'] {
	const value = parsed as { format?: unknown; note?: unknown; reason?: unknown; title?: unknown; at?: unknown } | undefined;
	if (value?.format !== 'skip' && value?.format !== 'note') {
		return undefined;
	}
	const text = (field: unknown) => typeof field === 'string' && field.trim() ? field.trim() : undefined;
	const note = text(value.note);
	// A note without text is no more than a skip.
	if (value.format !== 'note' || !note) {
		return { format: 'skip', note, reason: text(value.reason) };
	}
	const at = value.at as { file?: unknown; focus?: unknown; anchorLine?: unknown } | undefined;
	const focus = Array.isArray(at?.focus) ? at.focus.filter((range): range is { startLine: number; endLine: number } => typeof range?.startLine === 'number' && typeof range?.endLine === 'number') : [];
	const title = text(value.title);
	return {
		format: 'note',
		note,
		reason: text(value.reason),
		...(title ? { title } : {}),
		...(typeof at?.file === 'string' && focus.length ? { at: { file: at.file, focus, ...(typeof at.anchorLine === 'number' ? { anchorLine: at.anchorLine } : {}) } } : {}),
	};
}
