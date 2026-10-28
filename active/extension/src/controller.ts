/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import type { AgentApproval, AgentHost, AgentItem, AgentSession, AgentSessionListener } from './agents/agentTypes';
import { ExplanationAgent, WalkthroughPlanner } from './explain/planner';
import { buildQuestionPrompt } from './explain/prompts';
import { assessWorthiness, WorthinessVerdict } from './explain/worthiness';
import { HistoryStore } from './history/historyStore';
import type { ActiveEvent, AgentState, AgentStatus, AskRequest, CapturedFile, ChatEntry, InitialState, LearningProfile, PendingCheck, ToolOutcome, TurnSummary, Walkthrough, WalkthroughDraft, WalkthroughStage } from './shared/activeProtocol';
import { ChangeTracker, NetFileChange, RecordedEdit } from './tracking/changeTracker';

export interface ControllerOptions {
	readonly workspaceName: string;
	readonly backgroundTimeoutMs: () => number;
	readonly minMeaningfulLines: () => number;
	readonly draftQuietMs: () => number;
	readonly profile: () => LearningProfile;
	readonly emit: (event: ActiveEvent) => void;
	readonly log: (line: string) => void;
	/** Starts the coding agent host; throws with a human-readable blocker when unavailable. */
	readonly startCodingHost: () => Promise<AgentHost>;
	readonly startExplanationHost: () => Promise<AgentHost>;
	readonly explanationWorkspace: string;
	readonly workspaceRoot: string;
}

interface LogicalTurn {
	readonly id: string;
	readonly index: number;
	readonly task: string;
	readonly startedAt: number;
	readonly protocolTurns: Set<string>;
	readonly chat: ChatEntry[];
	readonly reasoning: Map<string, string[]>;
	readonly agentMessages: Map<string, string>;
	readonly tools: Map<string, ToolOutcome>;
	readonly worthinessLog: string[];
	verdict?: WorthinessVerdict;
	draft?: { signature: string; draft: WalkthroughDraft };
	drafting?: Promise<void>;
	draftTimer?: NodeJS.Timeout;
	codingDone: boolean;
	stage: WalkthroughStage;
}

/**
 * Identifies everything a walkthrough plan is based on: the captured files and the
 * evidence the planner sees (tool outcomes, agent messages, reasoning summaries).
 * A draft is reused only when none of it changed; a test run after the draft that
 * touched no tracked file must still reach the walkthrough.
 */
function signatureOf(changes: readonly NetFileChange[], turn: LogicalTurn): string {
	const hash = createHash('sha1');
	for (const change of changes) {
		hash.update(change.path).update('\0').update(change.final ?? '\u0001').update('\0');
	}
	for (const tool of turn.tools.values()) {
		hash.update(`tool:${tool.id}:${tool.status}:${tool.output?.length ?? 0}\0`);
	}
	for (const message of turn.agentMessages.values()) {
		hash.update(`message:${message}\0`);
	}
	for (const parts of turn.reasoning.values()) {
		hash.update(`reasoning:${parts.join('\n')}\0`);
	}
	return hash.digest('hex');
}

function toolCommand(item: AgentItem): string | undefined {
	if (!item.args) {
		return undefined;
	}
	try {
		const args = JSON.parse(item.args) as Record<string, unknown>;
		for (const key of ['command', 'cmd', 'script']) {
			const value = args[key];
			if (typeof value === 'string') {
				return value;
			}
			if (Array.isArray(value)) {
				return value.join(' ');
			}
		}
		for (const key of ['path', 'file_path', 'filePath', 'file']) {
			if (typeof args[key] === 'string') {
				return args[key] as string;
			}
		}
	} catch {
		// verbatim, model-authored arguments may not be JSON
	}
	return undefined;
}

let entrySeq = 0;
function entryId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${(entrySeq++).toString(36)}`;
}

/**
 * Active's orchestration. The coding agent is never paused: nothing the
 * explanation side does (planning, playback, the user opening
 * files) touches the coding session. Explanations are evaluated per turn only.
 */
export class ActiveController implements AgentSessionListener {
	private codingHost: AgentHost | undefined;
	private coding: AgentSession | undefined;
	private explanationHost: AgentHost | undefined;
	private readonly explainer: ExplanationAgent;
	private readonly planner: WalkthroughPlanner;
	private status: AgentStatus = 'starting';
	private blocker: string | undefined;
	private turn: LogicalTurn | undefined;
	private readonly queuedTasks: string[] = [];
	private readonly chat: ChatEntry[] = [];
	private readonly chatIndex = new Map<string, ChatEntry>();
	private readonly itemEntries = new Map<string, string>();
	private backgroundTasks = 0;
	private pendingWalkthrough: Walkthrough | undefined;
	private readonly walkthroughs = new Map<string, Walkthrough>();
	private connecting: Promise<void> | undefined;
	private turnCounter = 0;

	constructor(private readonly options: ControllerOptions, private readonly tracker: ChangeTracker, private readonly history: HistoryStore) {
		this.explainer = new ExplanationAgent(async listener => {
			this.explanationHost ??= await options.startExplanationHost();
			return this.explanationHost.startSession({ workspaceRoot: options.explanationWorkspace, readOnly: true, listener });
		}, options.explanationWorkspace);
		this.planner = new WalkthroughPlanner(this.explainer, options.log);
	}

	// ---------------------------------------------------------------- state

	private agentState(): AgentState {
		return { status: this.status, blocker: this.blocker, workspaceName: this.options.workspaceName, sessionId: this.coding?.sessionId, host: this.codingHost?.description, backgroundTasks: this.backgroundTasks };
	}

	private setStatus(status: AgentStatus, blocker?: string): void {
		this.status = status;
		this.blocker = blocker;
		this.options.emit({ type: 'agent', agent: this.agentState() });
	}

	private upsertChat(entry: ChatEntry): void {
		if (!this.chatIndex.has(entry.id)) {
			this.chat.push(entry);
		} else {
			const index = this.chat.findIndex(candidate => candidate.id === entry.id);
			this.chat[index] = entry;
		}
		this.chatIndex.set(entry.id, entry);
		if (entry.turnId && this.turn?.id === entry.turnId) {
			const index = this.turn.chat.findIndex(candidate => candidate.id === entry.id);
			if (index >= 0) {
				this.turn.chat[index] = entry;
			} else {
				this.turn.chat.push(entry);
			}
		}
		this.options.emit({ type: 'chat', entry });
	}

	private system(text: string, turnId?: string): void {
		this.upsertChat({ id: entryId('system'), role: 'system', text, turnId, at: Date.now() });
	}

	private setStage(turn: LogicalTurn, stage: WalkthroughStage, detail: string): void {
		turn.stage = stage;
		this.options.emit({ type: 'walkthroughStatus', status: { turnId: turn.id, stage, detail } });
	}

	async initialState(): Promise<InitialState> {
		return {
			agent: this.agentState(),
			chat: this.chat,
			profile: this.options.profile(),
			history: await this.history.list(),
			turnChanges: this.tracker.currentStats(),
			narration: { available: false, detail: '' },
			pendingWalkthrough: this.pendingWalkthrough,
		};
	}

	// ---------------------------------------------------------------- connection

	connect(): Promise<void> {
		this.connecting ??= this.doConnect().finally(() => { this.connecting = undefined; });
		return this.connecting;
	}

	private async doConnect(): Promise<void> {
		this.setStatus('starting');
		try {
			const history = await this.history.list();
			this.turnCounter = history.reduce((max, turn) => Math.max(max, turn.index), 0);
			// Remember what earlier agent turns wrote, oldest first so the latest content wins.
			for (const summary of [...history].reverse()) {
				for (const file of (await this.history.get(summary.turnId))?.files ?? []) {
					this.tracker.noteAgentAuthored(file.path, file.final);
				}
			}
			await this.tracker.refresh();
			this.codingHost = await this.options.startCodingHost();
			this.coding = await this.codingHost.startSession({ workspaceRoot: this.options.workspaceRoot, readOnly: false, listener: this });
			this.options.log(`coding session ${this.coding.sessionId} on ${this.codingHost.description}`);
			void this.codingHost.exited.then(reason => {
				this.coding = undefined;
				this.codingHost = undefined;
				this.setStatus('unavailable', reason);
			});
			this.setStatus('idle');
		} catch (error) {
			this.coding = undefined;
			this.setStatus('unavailable', error instanceof Error ? error.message : String(error));
		}
	}

	// ---------------------------------------------------------------- user actions

	async submitTask(text: string): Promise<void> {
		const task = text.trim();
		if (!task) {
			return;
		}
		if (!this.coding) {
			await this.connect();
		}
		if (!this.coding) {
			this.system(`Muse Code is not available: ${this.blocker ?? 'unknown error'}`);
			return;
		}
		if (this.turn && !this.turn.codingDone) {
			this.queuedTasks.push(task);
			this.upsertChat({ id: entryId('user'), role: 'user', text: task, status: 'queued', at: Date.now() });
			return;
		}
		await this.beginLogicalTurn(task);
	}

	private async beginLogicalTurn(task: string, agentInitiated = false): Promise<LogicalTurn> {
		const turn: LogicalTurn = {
			id: `turn-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`,
			index: ++this.turnCounter,
			task,
			startedAt: Date.now(),
			protocolTurns: new Set(),
			chat: [],
			reasoning: new Map(),
			agentMessages: new Map(),
			tools: new Map(),
			worthinessLog: [],
			codingDone: false,
			stage: 'collecting',
		};
		this.turn = turn;
		this.backgroundTasks = 0;
		if (!agentInitiated) {
			this.upsertChat({ id: entryId('user'), turnId: turn.id, role: 'user', text: task, at: Date.now() });
		}
		await this.tracker.beginTurn(turn.id);
		this.options.emit({ type: 'turnChanges', turnId: turn.id, files: [] });
		this.setStage(turn, 'collecting', 'Watching changes');
		this.setStatus('running');
		if (!agentInitiated) {
			try {
				const protocolTurn = await this.coding!.startTurn(task);
				turn.protocolTurns.add(protocolTurn);
			} catch (error) {
				this.system(`Muse Code rejected the task: ${error instanceof Error ? error.message : String(error)}`, turn.id);
				await this.finishCoding(turn, 'failed');
			}
		}
		return turn;
	}

	async decideApproval(approvalId: string, choiceId: string): Promise<void> {
		await this.coding?.decideApproval(approvalId, choiceId);
	}

	async ask(request: AskRequest): Promise<void> {
		const walkthrough = request.walkthroughId ? this.walkthroughs.get(request.walkthroughId) ?? (await this.loadWalkthrough(request.walkthroughId)) : undefined;
		this.upsertChat({ id: entryId('question'), role: 'question', text: request.question, at: Date.now() });
		const answerId = entryId('explainer');
		const update = (text: string, status: string) => this.upsertChat({ id: answerId, role: 'explainer', text, status, at: Date.now() });
		update('', 'streaming');
		try {
			if (walkthrough) {
				await this.syncExplanationWorkspace(walkthrough);
			}
			const reply = await this.explainer.ask(buildQuestionPrompt(request.question, walkthrough, request.sceneId, this.options.profile()), text => update(text, 'streaming'));
			update(reply, 'done');
		} catch (error) {
			update(`The explanation session could not answer: ${error instanceof Error ? error.message : String(error)}`, 'error');
		}
	}

	private async loadWalkthrough(walkthroughId: string): Promise<Walkthrough | undefined> {
		const turnId = walkthroughId.replace(/^wt-/, '');
		return (await this.history.get(turnId))?.walkthrough;
	}

	private async syncExplanationWorkspace(walkthrough?: Walkthrough): Promise<void> {
		const files = this.tracker.snapshotAll();
		if (walkthrough) {
			// Questions about a captured walkthrough see the captured versions, not later edits.
			for (const file of Object.values(walkthrough.files)) {
				if (file.final !== null) {
					files.set(file.path, file.final);
				}
			}
		}
		await this.explainer.syncWorkspace(files);
	}

	// ---------------------------------------------------------------- change tracking

	async onFileChanged(path: string): Promise<void> {
		const edit = await this.tracker.observe(path);
		if (edit) {
			this.afterEdits([edit]);
		}
	}

	noteUserTyping(path: string): void {
		this.tracker.noteUserTyping(path);
	}

	private afterEdits(edits: readonly RecordedEdit[]): void {
		const turn = this.turn;
		if (!turn || turn.codingDone || !edits.length) {
			return;
		}
		this.options.emit({ type: 'turnChanges', turnId: turn.id, files: this.tracker.currentStats() });
		// Re-evaluate the whole turn so far after every concrete change.
		const verdict = assessWorthiness(this.tracker.currentNetChanges(), { minMeaningfulLines: this.options.minMeaningfulLines() });
		const changed = verdict.worthy !== turn.verdict?.worthy;
		turn.verdict = verdict;
		turn.worthinessLog.push(`after edit #${edits[edits.length - 1].seq} (${edits.map(edit => edit.path).join(', ')}): ${verdict.worthy ? 'worth explaining' : 'not yet'} — ${verdict.reasons.join('; ')}`);
		if (changed) {
			this.setStage(turn, 'collecting', verdict.worthy ? 'Enough coherent work to explain; preparing a draft' : 'Watching changes');
		}
		if (verdict.worthy) {
			this.scheduleDraft(turn);
		}
	}

	private scheduleDraft(turn: LogicalTurn): void {
		if (turn.draftTimer) {
			clearTimeout(turn.draftTimer);
		}
		turn.draftTimer = setTimeout(() => {
			turn.draftTimer = undefined;
			if (turn.codingDone || turn.drafting || this.turn !== turn) {
				return;
			}
			turn.drafting = this.draft(turn).finally(() => { turn.drafting = undefined; });
		}, this.options.draftQuietMs());
	}

	private async draft(turn: LogicalTurn): Promise<void> {
		const changes = this.tracker.currentNetChanges();
		const signature = signatureOf(changes, turn);
		if (turn.draft?.signature === signature) {
			return;
		}
		this.setStage(turn, 'drafting', 'Drafting the walkthrough while Muse Code works');
		try {
			await this.syncExplanationWorkspace();
			const result = await this.planner.plan(await this.planningContext(turn, changes, [], false), turn.draft?.draft);
			if (result.draft) {
				turn.draft = { signature, draft: result.draft };
				turn.worthinessLog.push(`draft prepared with ${result.draft.scenes.length} scenes`);
			}
			if (!turn.codingDone) {
				this.setStage(turn, 'collecting', result.draft ? 'Draft ready; will reconcile when the turn finishes' : 'Draft failed validation; will retry at the end of the turn');
			}
		} catch (error) {
			this.options.log(`draft failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private capture(changes: readonly NetFileChange[]): Record<string, CapturedFile> {
		const files: Record<string, CapturedFile> = {};
		for (const change of changes) {
			if (change.userOnly) {
				continue;
			}
			files[change.path] = { path: change.path, baseline: change.baseline, final: change.final, added: change.added, removed: change.removed };
		}
		return files;
	}

	private async planningContext(turn: LogicalTurn, changes: readonly NetFileChange[], pending: readonly PendingCheck[], final: boolean) {
		const files = this.capture(changes);
		const userNotes = changes.filter(change => change.userOnly || change.userTouched || change.preexistingUserChanges).map(change => change.userOnly
			? `- ${change.path}: edited only by the user during this turn`
			: change.userTouched ? `- ${change.path}: the user also edited this file during the turn` : `- ${change.path}: had uncommitted user changes before the turn (excluded from the diff)`);
		return {
			task: turn.task,
			turnIndex: turn.index,
			profile: this.options.profile(),
			files,
			agentMessages: [...turn.agentMessages.values()],
			reasoningSummaries: [...turn.reasoning.values()].map(parts => parts.join('\n')).filter(Boolean),
			tools: [...turn.tools.values()],
			pending,
			history: await this.history.recentContext(5),
			userNotes,
			final,
		};
	}

	// ---------------------------------------------------------------- coding session listener

	onTurnStarted(turnId: string): void {
		if (this.turn?.protocolTurns.has(turnId)) {
			return;
		}
		if (this.turn && !this.turn.codingDone) {
			this.turn.protocolTurns.add(turnId);
			return;
		}
		// A turn the agent started on its own (for example after a background task finished).
		void this.beginLogicalTurn('Agent follow-up', true).then(turn => turn.protocolTurns.add(turnId));
	}

	onItem(item: AgentItem, completed: boolean): void {
		const turn = this.turn;
		const turnId = turn?.id;
		switch (item.kind) {
			case 'agentMessage': {
				if (completed && item.text && turn) {
					turn.agentMessages.set(item.id, item.text);
				}
				this.upsertAgentEntry(item.id, { role: 'agent', text: item.text ?? '', phase: item.phase, status: completed ? 'done' : 'streaming', turnId });
				break;
			}
			case 'reasoning': {
				// Exposed reasoning summaries feed the explainer; auto mode never shows a reasoning trace.
				if (turn && item.reasoningSummary?.length) {
					turn.reasoning.set(item.id, [...item.reasoningSummary]);
				}
				break;
			}
			case 'toolCall': {
				const command = toolCommand(item);
				const label = item.label ?? (item.tool ? `${item.tool}${command ? ` ${command}` : ''}` : 'Tool');
				this.upsertAgentEntry(item.id, { role: 'tool', text: label, status: item.status === 'inProgress' && item.background ? 'background' : item.status, turnId });
				if (turn) {
					turn.tools.set(item.id, { id: item.id, tool: item.tool ?? 'tool', label, status: item.status, command, output: item.output?.slice(-4000), background: item.background === true });
				}
				if (item.status === 'inProgress' && !item.background) {
					this.tracker.setActiveTool(item.id);
				}
				if (completed || item.background) {
					void this.tracker.rescan().then(edits => this.afterEdits(edits));
					if (completed && turn && item.outputRef && !item.output) {
						void this.coding?.readOutput(item.id, item.outputRef, 16 * 1024).then(output => {
							const existing = turn.tools.get(item.id);
							if (existing && output) {
								turn.tools.set(item.id, { ...existing, output: output.slice(-4000) });
							}
						});
					}
				}
				break;
			}
			case 'backgroundTerminalCompletion': {
				const completion = item.backgroundCompletion;
				if (completion && turn) {
					for (const [id, tool] of turn.tools) {
						if (tool.background && (tool.command === completion.command || id === completion.toolCallId)) {
							turn.tools.set(id, { ...tool, status: completion.terminalStatus, output: completion.output.slice(-4000) });
						}
					}
					turn.tools.set(item.id, { id: item.id, tool: 'background', label: completion.command, status: completion.terminalStatus, command: completion.command, output: completion.output.slice(-4000), background: true });
				}
				this.upsertAgentEntry(item.id, { role: 'tool', text: `Background: ${completion?.command ?? ''}`, status: completion?.terminalStatus ?? item.status, turnId });
				break;
			}
			case 'userMessage':
				break;
			default:
				if (completed && item.fallbackText) {
					this.upsertAgentEntry(item.id, { role: 'tool', text: item.fallbackText, status: item.status, turnId });
				}
		}
	}

	onDelta(itemId: string, field: string, text: string): void {
		if (field !== 'text') {
			return;
		}
		const id = this.itemEntries.get(itemId);
		const entry = id ? this.chatIndex.get(id) : undefined;
		if (entry && entry.role === 'agent') {
			this.upsertChat({ ...entry, text, status: 'streaming' });
		}
	}

	private upsertAgentEntry(itemId: string, fields: Omit<ChatEntry, 'id' | 'at'>): void {
		let id = this.itemEntries.get(itemId);
		if (!id) {
			id = entryId(fields.role);
			this.itemEntries.set(itemId, id);
		}
		const existing = this.chatIndex.get(id);
		if (fields.role === 'agent' && !fields.text && existing?.text) {
			fields = { ...fields, text: existing.text };
		}
		this.upsertChat({ id, at: existing?.at ?? Date.now(), ...fields });
	}

	onApproval(approval: AgentApproval): void {
		this.upsertChat({
			id: `approval-${approval.approvalId}`,
			turnId: this.turn?.id,
			role: 'approval',
			text: approval.title,
			approval: { approvalId: approval.approvalId, title: approval.title, detail: approval.detail, choices: approval.choices },
			at: Date.now(),
		});
	}

	onApprovalResolved(approvalId: string, decision: string): void {
		const entry = this.chatIndex.get(`approval-${approvalId}`);
		if (entry?.approval) {
			this.upsertChat({ ...entry, approval: { ...entry.approval, resolved: decision || 'resolved' } });
		}
	}

	onTurnCompleted(protocolTurnId: string, terminal: string, error?: string): void {
		const turn = this.turn;
		if (!turn || !turn.protocolTurns.has(protocolTurnId) || turn.codingDone) {
			return;
		}
		if (error) {
			this.system(`Muse Code: ${error}`, turn.id);
		}
		void this.finishCoding(turn, terminal);
	}

	// ---------------------------------------------------------------- end of turn

	private async finishCoding(turn: LogicalTurn, terminal: string): Promise<void> {
		turn.codingDone = true;
		if (turn.draftTimer) {
			clearTimeout(turn.draftTimer);
		}
		this.tracker.setActiveTool(undefined);
		// Freeze the turn's changes now: later edits belong to later turns and never alter this capture.
		const captured = await this.tracker.endTurn();
		const changes = captured?.changes ?? [];
		const edits = captured?.edits ?? [];
		this.options.emit({ type: 'turnChanges', turnId: turn.id, files: changes.filter(change => !change.userOnly).map(change => ({ path: change.path, added: change.added, removed: change.removed })) });
		this.setStatus('idle');

		const next = this.queuedTasks.shift();
		const files = this.capture(changes);
		const verdict = assessWorthiness(changes, { minMeaningfulLines: this.options.minMeaningfulLines() });
		turn.verdict = verdict;
		turn.worthinessLog.push(`final: ${verdict.worthy ? 'worth explaining' : 'not explained'} — ${verdict.reasons.join('; ')}`);

		let walkthrough: Walkthrough | undefined;
		let note: string;
		if (terminal !== 'completed' && Object.keys(files).length === 0) {
			note = `Turn ${terminal}; no changes to explain.`;
			this.setStage(turn, 'notExplained', note);
		} else if (!verdict.worthy) {
			note = verdict.reasons.join('; ');
			this.setStage(turn, 'notExplained', note);
		} else {
			// Start the queued task right away: the coding agent never waits for explanations.
			if (next) {
				void this.beginLogicalTurn(next);
			}
			const pending = await this.waitForBackground(turn);
			this.setStage(turn, 'finalizing', 'Reconciling the explanation with the final changes');
			try {
				walkthrough = await this.finalizeWalkthrough(turn, files, changes, pending);
				note = walkthrough ? `Walkthrough: ${walkthrough.title}` : 'The explanation did not survive reconciliation with the final changes.';
			} catch (error) {
				note = `Explanation failed: ${error instanceof Error ? error.message : String(error)}`;
			}
			this.setStage(turn, walkthrough ? 'ready' : 'failed', note);
		}

		const summary: TurnSummary = {
			sessionId: this.coding?.sessionId ?? 'unknown',
			turnId: turn.id,
			index: turn.index,
			task: turn.task,
			startedAt: turn.startedAt,
			endedAt: Date.now(),
			outcome: terminal,
			walkthroughId: walkthrough?.id,
			walkthroughTitle: walkthrough?.title,
			explanationNote: note,
			files: Object.values(files).map(file => ({ path: file.path, added: file.added, removed: file.removed })),
		};
		await this.history.save({
			summary,
			chat: turn.chat,
			reasoningSummaries: [...turn.reasoning.values()].map(parts => parts.join('\n')),
			tools: [...turn.tools.values()],
			edits: edits.map(edit => ({ seq: edit.seq, path: edit.path, source: edit.source, added: edit.added, removed: edit.removed, at: edit.at, toolItemId: edit.toolItemId, before: edit.before, after: edit.after })),
			files: Object.values(files),
			walkthrough,
			worthiness: turn.worthinessLog,
		}).catch(error => this.options.log(`history save failed: ${error}`));
		this.options.emit({ type: 'history', history: await this.history.list() });

		if (walkthrough) {
			this.walkthroughs.set(walkthrough.id, walkthrough);
			this.pendingWalkthrough = walkthrough;
			this.options.emit({ type: 'walkthroughReady', walkthrough });
		}
		if (this.turn === turn) {
			this.turn = undefined;
		}
		if (next && !verdict.worthy) {
			await this.beginLogicalTurn(next);
		}
	}

	/** Waits up to the configured timeout for background tasks; unfinished ones become pending checks. They keep running. */
	private async waitForBackground(turn: LogicalTurn): Promise<PendingCheck[]> {
		const session = this.coding;
		if (!session) {
			return [];
		}
		const deadline = Date.now() + this.options.backgroundTimeoutMs();
		let running = await session.listTasks().catch(() => []);
		running = running.filter(task => task.background);
		if (running.length) {
			this.backgroundTasks = running.length;
			this.options.emit({ type: 'agent', agent: this.agentState() });
			this.setStage(turn, 'waitingForBackground', `Waiting for ${running.length} background task${running.length === 1 ? '' : 's'}`);
		}
		while (running.length && Date.now() < deadline) {
			await new Promise(resolve => setTimeout(resolve, 1500));
			running = (await session.listTasks().catch(() => [])).filter(task => task.background);
		}
		this.backgroundTasks = running.length;
		this.options.emit({ type: 'agent', agent: this.agentState() });
		return running.map(task => {
			const tool = turn.tools.get(task.taskId);
			return { id: task.taskId, label: task.command ?? tool?.command ?? tool?.label ?? task.tool ?? 'background task', state: 'running' as const };
		});
	}

	private async finalizeWalkthrough(turn: LogicalTurn, files: Record<string, CapturedFile>, changes: readonly NetFileChange[], pending: readonly PendingCheck[]): Promise<Walkthrough | undefined> {
		await turn.drafting?.catch(() => undefined);
		const signature = signatureOf(changes, turn);
		const evidence = new Set(turn.tools.keys());
		let result;
		if (turn.draft && turn.draft.signature === signature && pending.length === 0) {
			result = this.planner.reconcile(turn.draft.draft, files, evidence);
		}
		if (!result?.draft) {
			await this.syncExplanationWorkspace();
			result = await this.planner.plan(await this.planningContext(turn, changes, pending, true), turn.draft?.draft);
		}
		if (result.dropped.length) {
			turn.worthinessLog.push(`dropped scenes about reverted work: ${result.dropped.join(', ')}`);
		}
		if (!result.draft) {
			this.options.log(`walkthrough planning failed: ${result.errors.join('; ')}`);
			return undefined;
		}
		return {
			id: `wt-${turn.id}`,
			sessionId: this.coding?.sessionId ?? 'unknown',
			turnId: turn.id,
			turnIndex: turn.index,
			task: turn.task,
			title: result.draft.title,
			summary: result.draft.summary,
			createdAt: Date.now(),
			terms: result.draft.terms,
			scenes: result.draft.scenes,
			pending,
			files,
		};
	}

	// ---------------------------------------------------------------- history

	async historyGet(turnId: string) {
		const detail = await this.history.get(turnId);
		if (detail?.walkthrough) {
			this.walkthroughs.set(detail.walkthrough.id, detail.walkthrough);
		}
		return detail;
	}

	async historyDelete(turnId?: string): Promise<void> {
		await this.history.delete(turnId);
		if (!turnId) {
			this.walkthroughs.clear();
			this.pendingWalkthrough = undefined;
		} else if (this.pendingWalkthrough?.turnId === turnId) {
			this.pendingWalkthrough = undefined;
		}
		this.options.emit({ type: 'history', history: await this.history.list() });
	}

	async dispose(): Promise<void> {
		await this.codingHost?.dispose();
		await this.explanationHost?.dispose();
	}
}
