/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import type { AgentApproval, AgentHost, AgentItem, AgentSession, AgentSessionListener } from './agents/agentTypes';
import { CONDENSE_TARGET_CHARS, condensedOf, ExplainerMemory, MemoryInput } from './explain/memory';
import { ExplanationAgent, NoteBrief, noteDraft, PlanResult, WalkthroughPlanner } from './explain/planner';
import { buildBriefingPrompt, buildCodeQuestionPrompt, buildElaborationPrompt, buildMapQuestionPrompt, composeCodeTask, buildMemoryCondensePrompt, buildQuestionPrompt, buildSpokenQuestionPrompt, BriefingTurn, PlanningContext } from './explain/prompts';
import { assessWorthiness, WorthinessVerdict } from './explain/worthiness';
import type { DiagramSnapshot } from './diagram/diagramAgent';
import { describeDebugCall } from './debug/debugTools';
import { debuggerSuggestion, stuckReason } from './debug/stuck';
import { HistoryStore } from './history/historyStore';
import { describeCodeSelection, extractJsonObject, REASONING_EFFORTS } from './shared/activeProtocol';
import type { ActiveEvent, Briefing, BriefingRequest, AgentModelInfo, AgentProviderInfo, AgentRunSettings, AgentState, AgentStatus, SetupState, AskRequest, CapturedFile, ChatEntry, ElaborateRequest, FileChangeStat, InitialState, KnowledgeProfile, MemoryNote, PendingCheck, ToolOutcome, ReasoningEffort, SystemMap, TaskRequest, TurnSummary, Walkthrough, WalkthroughDraft, WalkthroughStage } from './shared/activeProtocol';
import { ChangeTracker, NetFileChange, RecordedEdit } from './tracking/changeTracker';
import { diffStats } from './tracking/lineDiff';

export interface ControllerOptions {
	readonly workspaceName: string;
	readonly backgroundTimeoutMs: () => number;
	/** Minimum time between "chapter now, or wait?" questions during a turn. */
	readonly checkpointMs: () => number;
	/** Minimum time between chapters; a turn shorter than this gets one explanation at the end. */
	readonly chapterMs: () => number;
	/** Lean toward a short note for small changes and short requests. */
	readonly preferNotes: () => boolean;
	/** The explainer's own memory (independent of the coding agent's). */
	readonly memory?: ExplainerMemory;
	/** False in the "off" explanation mode: the explanation model isn't asked during or after turns. */
	readonly explanationsEnabled?: () => boolean;
	readonly profile: () => KnowledgeProfile;
	/** The system map version questions from the map are about (the latest, or the one they were picked from). */
	readonly systemMap?: (version?: number) => Promise<SystemMap | undefined>;
	readonly emit: (event: ActiveEvent) => void;
	readonly log: (line: string) => void;
	/** The coding agent platform in use (Muse Code by default). */
	readonly provider: AgentProviderInfo;
	/** First-run setup: whether the agent still needs installing or signing in, and its current state. */
	readonly needsSetup: () => boolean;
	readonly setupState: () => SetupState | undefined;
	readonly isAuthFailure: (errorKind: string | undefined, message: string | undefined) => boolean;
	readonly onAuthRequired: (reason: string | undefined) => void;
	/** How the user is signed in, when known without a model call (e.g. "API key"). */
	readonly accountHint: () => Promise<string | undefined>;
	/** Starts the coding agent host; throws with a human-readable blocker when unavailable. */
	readonly startCodingHost: () => Promise<AgentHost>;
	readonly startExplanationHost: () => Promise<AgentHost>;
	readonly workspaceRoot: string;
	/** The model and reasoning effort each session should use (from settings; read at use, so changes apply). */
	readonly runSettings: (role: 'coding' | 'explanation') => AgentRunSettings;
	/** The coding session last open in this folder, resumed on startup; and a way to record the current one. */
	readonly lastSessionId?: () => string | undefined;
	readonly rememberSession?: (sessionId: string) => void;
	/** The diagram agent hears about every checkpoint and the end of every turn (on its own timeline). */
	readonly onDiagramCheckpoint?: (snapshot: DiagramSnapshot) => void;
	/** The coding agent's debug tools (an Active MCP server on the coding host), when they're on. */
	readonly debugTools?: {
		/** The tools are on and the coding host was given them. */
		readonly available: () => boolean;
		/** Suggest them (once per turn) when the agent looks stuck. */
		readonly suggestWhenStuck: () => boolean;
		/** Ends any debug session the agent left open. */
		readonly stopAll: () => Promise<void>;
	};
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
	/** Whether the not-yet-explained changes contain anything meaningful (the cheap filter). */
	verdict?: WorthinessVerdict;
	/** The plan made early (on the agent's final answer), reused at the end if nothing changed since. */
	draft?: { signature: string; result: PlanResult };
	drafting?: Promise<void>;
	/** The final answer came while an early plan was running: plan once more after it. */
	redraft?: boolean;
	codingDone: boolean;
	stage: WalkthroughStage;
	/** Chapters already shown for this turn, oldest first. */
	readonly chapters: Walkthrough[];
	/** File contents at the end of the last chapter: the next one explains only what changed since. */
	readonly explained: Map<string, string | null>;
	lastChapterAt: number;
	lastCheckAt: number;
	messagesAtLastChapter: number;
	toolsAtLastChapter: number;
	/** A chapter question (and the chapter it may lead to) in progress. */
	checking?: Promise<void>;
	/** A checkpoint came while a question was running or too soon after the last: ask when allowed. */
	checkPending: boolean;
	checkTimer?: NodeJS.Timeout;
	/** Active already suggested the debugger this turn. */
	debugSuggested?: boolean;
}

/**
 * Identifies everything a walkthrough plan is based on: the captured files and the
 * evidence the planner sees (tool outcomes, agent messages, reasoning summaries).
 * A draft is reused only when none of it changed; a test run after the draft that
 * touched no tracked file must still reach the walkthrough.
 */
/**
 * What a draft depends on: the net code change and the tool results (tests are evidence).
 * The agent's messages and reasoning are left out: its closing message always arrives after the
 * last edit, and would otherwise make every draft stale at the end of the turn.
 */
/** Tools that run commands (shell, tests): finishing one is a checkpoint. */
const COMMAND_TOOLS = /bash|shell|exec|terminal|command/i;

/** Item kinds Muse emits for its own machinery; chat leaves them out. */
const INTERNAL_ITEM_KINDS = new Set(['reminderChild', 'earlierHistory', 'damagedRange', 'compaction', 'hookRun', 'overdueNotice']);

/** How many of a resumed session's most recent turns are put back in chat. */
const MAX_RESTORED_TURNS = 30;

function signatureOf(changes: readonly NetFileChange[], turn: LogicalTurn): string {
	const hash = createHash('sha1');
	for (const change of changes) {
		hash.update(change.path).update('\0').update(change.final ?? '\u0001').update('\0');
	}
	for (const tool of turn.tools.values()) {
		if (tool.status !== 'inProgress') {
			hash.update(`tool:${tool.id}:${tool.status}\0`);
		}
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
	/** Background checks that were still running when their walkthrough was prepared, by task id. */
	private readonly openChecks = new Map<string, { turnId: string; walkthroughId?: string; check: PendingCheck; result?: PendingCheck['state'] }>();
	private readonly walkthroughs = new Map<string, Walkthrough>();
	private connecting: Promise<void> | undefined;
	private turnCounter = 0;
	private models: readonly AgentModelInfo[] = [];
	/** The model each live session was last switched to, so a settings change only switches what changed. */
	private readonly appliedModels = new WeakMap<AgentSession, string>();
	/** Other read-only agents on the explanation host (the diagram agent), reset with it. */
	private readonly sideAgents: ExplanationAgent[] = [];

	constructor(private readonly options: ControllerOptions, private readonly tracker: ChangeTracker, private readonly history: HistoryStore) {
		this.explainer = new ExplanationAgent(async listener => {
			this.explanationHost ??= await options.startExplanationHost();
			// The explanation session reads the live project under Muse's read-only permission profile.
			const session = await this.explanationHost.startSession({ workspaceRoot: options.workspaceRoot, readOnly: true, listener });
			await this.applyModel(session, 'explanation');
			return session;
		}, undefined, () => this.effortFor('explanation'));
		this.planner = new WalkthroughPlanner(this.explainer, options.log);
	}

	// ---------------------------------------------------------------- state

	private account: string | undefined;

	private agentState(): AgentState {
		return {
			status: this.status,
			provider: this.options.provider,
			setup: this.options.setupState(),
			account: this.account,
			blocker: this.blocker,
			workspaceName: this.options.workspaceName,
			sessionId: this.coding?.sessionId,
			host: this.codingHost?.description,
			backgroundTasks: this.backgroundTasks,
		};
	}

	/** The coding session in use (tests). */
	get sessionIdForTest(): string | undefined {
		return this.coding?.sessionId;
	}

	/** Re-sends the agent state (for example after setup progress). */
	refreshAgentState(): void {
		this.options.emit({ type: 'agent', agent: this.agentState() });
	}

	/** Resumes `resumeId` when given (and its chat from history), otherwise starts a new session. */
	private async openCodingSession(resumeId: string | undefined): Promise<AgentSession> {
		const host = this.codingHost!;
		const options = { workspaceRoot: this.options.workspaceRoot, readOnly: false, listener: this };
		if (resumeId && host.resumeSession) {
			try {
				const session = await host.resumeSession(resumeId, options);
				this.options.log(`resumed coding session ${session.sessionId} on ${host.description}`);
				this.options.rememberSession?.(session.sessionId);
				await this.restoreChat(session.sessionId);
				return session;
			} catch (error) {
				this.options.log(`couldn't resume session ${resumeId} (${error instanceof Error ? error.message : String(error)}); starting a new one`);
			}
		}
		const session = await host.startSession(options);
		this.options.log(`coding session ${session.sessionId} on ${host.description}`);
		this.options.rememberSession?.(session.sessionId);
		return session;
	}

	/** Rebuilds a session's transcript from the turns history saved for it. */
	private async restoreChat(sessionId: string): Promise<void> {
		const turns = (await this.history.list()).filter(turn => turn.sessionId === sessionId).reverse().slice(-MAX_RESTORED_TURNS);
		const entries: ChatEntry[] = [];
		for (const turn of turns) {
			// Chats saved before Muse's bookkeeping was filtered out may still hold its "Reminder child session" rows.
			entries.push(...((await this.history.get(turn.turnId))?.chat ?? []).filter(entry => !(entry.role === 'tool' && /^Reminder child session/.test(entry.text))));
		}
		this.replaceChat(entries);
	}

	private replaceChat(entries: readonly ChatEntry[]): void {
		this.chat.length = 0;
		this.chatIndex.clear();
		this.itemEntries.clear();
		for (const entry of entries) {
			this.chat.push(entry);
			this.chatIndex.set(entry.id, entry);
		}
		this.options.emit({ type: 'chatReset', chat: this.chat });
	}

	/** Starts a fresh coding session (a new chat) in this folder. */
	async newSession(): Promise<void> {
		await this.switchSession(undefined);
	}

	/** Reattaches to an earlier coding session from this folder's history. */
	async resumeSession(sessionId: string): Promise<void> {
		await this.switchSession(sessionId);
	}

	private async switchSession(resumeId: string | undefined): Promise<void> {
		if (this.turn && !this.turn.codingDone) {
			this.system(`Wait for ${this.options.provider.name} to finish this task before switching chats.`, this.turn.id);
			return;
		}
		if (!this.codingHost) {
			await this.connect();
		}
		if (!this.codingHost || this.coding?.sessionId === resumeId) {
			return;
		}
		try {
			this.coding = await this.openCodingSession(resumeId);
			if (!resumeId || this.coding.sessionId !== resumeId) {
				this.replaceChat([]);
			}
			await this.applyModel(this.coding, 'coding');
			this.refreshAgentState();
		} catch (error) {
			this.system(`Couldn't open that chat: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Applies changed model settings to the live sessions; reasoning effort is read for every turn anyway. */
	async applyRunSettings(): Promise<void> {
		if (this.coding) {
			await this.applyModel(this.coding, 'coding');
		}
		const explanation = this.explainer.currentSession;
		if (explanation) {
			await this.applyModel(explanation, 'explanation');
		}
	}

	private async applyModel(session: AgentSession, role: 'coding' | 'explanation'): Promise<void> {
		// An empty setting means the agent's default model.
		const wanted = this.options.runSettings(role).model || this.models.find(model => model.isDefault)?.id;
		if (!wanted || !session.setModel || this.appliedModels.get(session) === wanted) {
			return;
		}
		if (!this.appliedModels.has(session) && !this.options.runSettings(role).model) {
			return; // a fresh session already runs the default
		}
		try {
			await session.setModel(wanted);
			this.appliedModels.set(session, wanted);
			this.options.log(`${role} session now uses ${wanted}`);
		} catch (error) {
			this.options.log(`couldn't switch the ${role} model to ${wanted}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** The configured effort, lowered to the closest tier the session's model supports. */
	private effortFor(role: 'coding' | 'explanation'): ReasoningEffort | undefined {
		const settings = this.options.runSettings(role);
		const effort = settings.reasoningEffort;
		if (!effort) {
			return undefined;
		}
		const modelId = settings.model || this.models.find(model => model.isDefault)?.id;
		const supported = this.models.find(model => model.id === modelId)?.efforts;
		if (!supported?.length || supported.includes(effort)) {
			return effort;
		}
		const lower = REASONING_EFFORTS.slice(0, REASONING_EFFORTS.indexOf(effort)).reverse().find(tier => supported.includes(tier));
		return lower ?? REASONING_EFFORTS.find(tier => supported.includes(tier));
	}

	/**
	 * Another agent with its own read-only session on the explanation host (the diagram agent), using the
	 * explanation model. Its session is dropped when the hosts restart.
	 */
	createSideAgent(): ExplanationAgent {
		const agent = new ExplanationAgent(async listener => {
			this.explanationHost ??= await this.options.startExplanationHost();
			const session = await this.explanationHost.startSession({ workspaceRoot: this.options.workspaceRoot, readOnly: true, listener });
			await this.applyModel(session, 'explanation');
			return session;
		}, undefined, () => this.effortFor('explanation'));
		this.sideAgents.push(agent);
		return agent;
	}

	/** A note in chat from the diagram agent: the map changed (one click opens it; nothing switches by itself). */
	diagramNote(text: string, mapVersion: number, turnId?: string): void {
		this.upsertChat({ id: entryId('diagram'), turnId, role: 'diagram', text, at: Date.now(), mapVersion });
	}

	/**
	 * The developer described a change to the system map in chat: their message, then the diagram agent's reply
	 * (the new version, or why it left the map alone) in place of a "changing the map" line.
	 */
	async editDiagram(request: string, edit: (request: string) => Promise<{ version?: number; reason: string }>): Promise<void> {
		this.upsertChat({ id: entryId('question'), role: 'question', text: request, at: Date.now(), mapEdit: true });
		const replyId = entryId('diagram');
		this.upsertChat({ id: replyId, role: 'diagram', text: 'Changing the map…', status: 'streaming', at: Date.now() });
		try {
			const result = await edit(request);
			this.upsertChat({ id: replyId, role: 'diagram', text: result.reason, status: 'done', at: Date.now(), mapVersion: result.version });
		} catch (error) {
			this.upsertChat({ id: replyId, role: 'diagram', text: `The diagram agent couldn't change the map: ${error instanceof Error ? error.message : String(error)}`, status: 'error', at: Date.now() });
		}
	}

	private tellDiagram(turn: LogicalTurn, changes: readonly NetFileChange[], final: boolean): void {
		this.options.onDiagramCheckpoint?.({
			turnId: turn.id,
			turnIndex: turn.index,
			task: turn.task,
			changes: changes.filter(change => !change.userOnly).map(change => ({ path: change.path, added: change.added, removed: change.removed, baseline: change.baseline, final: change.final })),
			progress: [...turn.agentMessages.values()],
			final,
		});
	}

	/** Restarts the agent hosts, e.g. after installing or signing in. */
	async reconnect(): Promise<void> {
		const hosts = [this.codingHost, this.explanationHost];
		this.coding = undefined;
		this.codingHost = undefined;
		this.explanationHost = undefined;
		this.explainer.reset();
		for (const agent of this.sideAgents) {
			agent.reset();
		}
		for (const host of hosts) {
			await host?.dispose().catch(() => undefined);
		}
		await this.connect();
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

	/** What the agent's last prompt that changed anything changed (the Explorer's "Agent" counts). */
	private agentChanges: FileChangeStat[] | undefined;
	/** Each of those files as it was before that prompt (`null`: it didn't exist), for the editor's "Agent" gutter. */
	private agentBaselines: Map<string, string | null> | undefined;

	private async lastAgentChanges(): Promise<FileChangeStat[]> {
		const live = this.tracker.currentStats();
		if (live.length) {
			return live;
		}
		if (!this.agentChanges) {
			// After a reload: the newest saved turn (not a chapter record) that changed files.
			const turn = (await this.history.list()).find(summary => summary.outcome !== 'chapter' && summary.files.length);
			const captured = turn ? (await this.history.get(turn.turnId))?.files ?? [] : [];
			const created = new Set(captured.filter(file => file.baseline === null).map(file => file.path));
			this.agentChanges = turn?.files.map(file => ({ ...file, ...(created.has(file.path) ? { created: true } : {}) })) ?? [];
			this.agentBaselines = new Map(captured.map(file => [file.path, file.baseline]));
		}
		return this.agentChanges;
	}

	/**
	 * A file as it was before the agent's last prompt that changed it, so the editor can mark what that prompt
	 * changed. `undefined` when that prompt didn't touch the file.
	 */
	async agentBaseline(path: string): Promise<{ readonly baseline: string | null } | undefined> {
		const live = this.tracker.currentNetChanges().find(change => change.path === path && !change.userOnly);
		if (live) {
			return { baseline: live.baseline };
		}
		await this.lastAgentChanges();
		return this.agentBaselines?.has(path) ? { baseline: this.agentBaselines.get(path)! } : undefined;
	}

	/** Uncommitted changes as git sees them (the Explorer's "Git" counts); `undefined` outside a repository. */
	gitChanges(): Promise<FileChangeStat[] | undefined> {
		return this.tracker.files.gitStats();
	}

	async initialState(): Promise<InitialState> {
		return {
			agent: this.agentState(),
			chat: this.chat,
			profile: this.options.profile(),
			history: await this.history.list(),
			turnChanges: await this.lastAgentChanges(),
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
			if (this.options.needsSetup()) {
				this.setStatus('unavailable', `Set up ${this.options.provider.name} to start.`);
				return;
			}
			this.codingHost = await this.options.startCodingHost();
			// Pick up where this folder left off: the last session open here, else the one its latest turn used.
			this.coding = await this.openCodingSession(this.options.lastSessionId?.() ?? history[0]?.sessionId);
			this.models = (await this.codingHost.listModels?.().catch(() => undefined)) ?? [];
			if (this.models.length) {
				this.options.emit({ type: 'models', models: this.models });
			}
			await this.applyModel(this.coding, 'coding');
			const host = this.codingHost;
			void host.exited.then(reason => {
				if (this.codingHost !== host) {
					return; // replaced by a reconnect
				}
				this.coding = undefined;
				this.codingHost = undefined;
				this.setStatus('unavailable', reason);
			});
			this.account = (await this.coding.accountSummary?.().catch(() => undefined)) ?? await this.options.accountHint();
			this.setStatus('idle');
		} catch (error) {
			this.coding = undefined;
			this.setStatus('unavailable', error instanceof Error ? error.message : String(error));
		}
	}

	// ---------------------------------------------------------------- user actions

	/** Starts a coding task; one about code the developer pointed at shows in chat as their words with what it's about. */
	async submitTask(request: string | TaskRequest): Promise<void> {
		const { text, code } = typeof request === 'string' ? { text: request, code: undefined } : request;
		if (!text.trim()) {
			return;
		}
		const task = typeof request === 'string' ? text.trim() : composeCodeTask(request);
		const shown: Pick<ChatEntry, 'text' | 'about' | 'aboutCode'> = code ? { text: text.trim(), about: describeCodeSelection(code), aboutCode: true } : { text: task };
		if (!this.coding) {
			await this.connect();
		}
		if (!this.coding) {
			this.system(`${this.options.provider.name} is not available: ${this.blocker ?? 'unknown error'}`);
			return;
		}
		if (this.turn && !this.turn.codingDone) {
			this.queuedTasks.push(task);
			this.upsertChat({ id: entryId('user'), role: 'user', ...shown, status: 'queued', at: Date.now() });
			return;
		}
		await this.beginLogicalTurn(task, false, shown);
	}

	private async beginLogicalTurn(task: string, agentInitiated = false, shown: Pick<ChatEntry, 'text' | 'about' | 'aboutCode'> = { text: task }): Promise<LogicalTurn> {
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
			chapters: [],
			explained: new Map(),
			lastChapterAt: Date.now(),
			lastCheckAt: 0,
			messagesAtLastChapter: 0,
			toolsAtLastChapter: 0,
			checkPending: false,
		};
		this.turn = turn;
		this.backgroundTasks = 0;
		if (!agentInitiated) {
			this.upsertChat({ id: entryId('user'), turnId: turn.id, role: 'user', ...shown, at: Date.now() });
		}
		// The Explorer keeps the last prompt's counts until this one changes something.
		await this.tracker.beginTurn(turn.id);
		this.setStage(turn, 'collecting', 'Watching changes');
		this.setStatus('running');
		if (!agentInitiated) {
			try {
				const protocolTurn = await this.coding!.startTurn(task, undefined, this.effortFor('coding'));
				turn.protocolTurns.add(protocolTurn);
			} catch (error) {
				this.system(`${this.options.provider.name} rejected the task: ${error instanceof Error ? error.message : String(error)}`, turn.id);
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
		const questionId = entryId('question');
		this.upsertChat({ id: questionId, role: 'question', text: request.question, at: Date.now() });
		const answerId = entryId('explainer');
		const update = (text: string, status: string) => this.upsertChat({ id: answerId, role: 'explainer', text, status, at: Date.now() });
		update('', 'streaming');
		const memory = await this.options.memory?.describe();
		const map = request.map && (await this.options.systemMap?.(request.map.version));
		const topic = request.code ? describeCodeSelection(request.code) : map && request.map
			? [...request.map.components.map(id => map.components.find(component => component.id === id)?.name ?? id), ...request.map.connections.map(link => [link.from, link.to].map(id => map.components.find(component => component.id === id)?.name ?? id).join(' → '))].join(', ')
			: walkthrough?.scenes.find(scene => scene.id === request.sceneId)?.title ?? walkthrough?.title;
		if ((map || request.code) && topic) {
			this.upsertChat({ id: questionId, role: 'question', text: request.question, at: Date.now(), about: topic, ...(request.code ? { aboutCode: true } : {}) });
		}
		void this.recordQuestion(request.question, topic);
		try {
			const prompt = request.code
				? buildCodeQuestionPrompt(request.question, request.code, this.options.profile(), memory)
				: map && request.map
				? buildMapQuestionPrompt(request.question, map, request.map, this.options.profile(), memory)
				: buildQuestionPrompt(request.question, walkthrough, request.sceneId, this.options.profile(), memory);
			const reply = await this.explainer.ask(prompt, text => update(text, 'streaming'), true);
			update(reply, 'done');
		} catch (error) {
			update(`The explanation session could not answer: ${error instanceof Error ? error.message : String(error)}`, 'error');
		}
	}

	/**
	 * Re-explains one scene in more depth, or answers a question asked from its card, through the read-only
	 * explanation session, streaming the text back. Goes ahead of queued background work.
	 */
	async elaborate(request: ElaborateRequest): Promise<void> {
		const emit = (text: string, status: 'streaming' | 'done' | 'error') => this.options.emit({ type: 'elaboration', requestId: request.requestId, text, status });
		const kind = request.question ? 'card question' : 'more detail';
		const started = Date.now();
		try {
			const walkthrough = this.walkthroughs.get(request.walkthroughId) ?? (await this.loadWalkthrough(request.walkthroughId));
			if (!walkthrough) {
				throw new Error('that walkthrough is no longer in history');
			}
			const memory = await this.options.memory?.describe();
			const sceneTitle = walkthrough.scenes.find(scene => scene.id === request.sceneId)?.title;
			void this.recordQuestion(request.question ?? 'wanted more detail', sceneTitle);
			const prompt = request.question
				? buildSpokenQuestionPrompt(request.question, walkthrough, request.sceneId, this.options.profile(), memory)
				: buildElaborationPrompt(walkthrough, request.sceneId, this.options.profile(), memory);
			const reply = await this.explainer.ask(prompt, text => emit(text, 'streaming'), true);
			this.options.log(`${kind} for ${request.walkthroughId}/${request.sceneId}: ${reply.length} chars in ${((Date.now() - started) / 1000).toFixed(1)}s`);
			emit(reply, 'done');
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.options.log(`${kind} for ${request.walkthroughId}/${request.sceneId} failed after ${((Date.now() - started) / 1000).toFixed(1)}s: ${message}`);
			emit(request.question ? `Couldn't answer that: ${message}` : `Couldn't get a deeper explanation: ${message}`, 'error');
		}
	}

	private async loadWalkthrough(walkthroughId: string): Promise<Walkthrough | undefined> {
		const recordId = walkthroughId.replace(/^wt-/, '');
		const saved = (await this.history.get(recordId))?.walkthrough;
		if (saved) {
			return saved;
		}
		// The last chapter of a turn is saved with the turn itself, not as its own chapter record.
		const turnRecord = (await this.history.get(recordId.replace(/-c\d+$/, '')))?.walkthrough;
		return turnRecord?.id === walkthroughId ? turnRecord : undefined;
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
		const stats = this.tracker.currentStats();
		if (stats.length) {
			this.agentChanges = stats;
			this.agentBaselines = new Map(this.tracker.currentNetChanges().filter(change => !change.userOnly).map(change => [change.path, change.baseline]));
			this.options.emit({ type: 'turnChanges', turnId: turn.id, files: stats });
		}
		// Only the cheap filter runs on edits; the explanation model is asked at checkpoints and at the end.
		const verdict = assessWorthiness(this.unexplainedChanges(turn));
		turn.verdict = verdict;
		turn.worthinessLog.push(`after edit #${edits[edits.length - 1].seq} (${edits.map(edit => edit.path).join(', ')}): ${verdict.reasons.join('; ')}`);
	}

	/** The turn's changes since the last chapter (all of them before the first). */
	private unexplainedChanges(turn: LogicalTurn, changes: readonly NetFileChange[] = this.tracker.currentNetChanges()): NetFileChange[] {
		return changes.flatMap(change => {
			if (!turn.explained.has(change.path)) {
				return [change];
			}
			const baseline = turn.explained.get(change.path) ?? null;
			if (baseline === change.final) {
				return [];
			}
			return [{ ...change, baseline, ...diffStats(baseline, change.final) }];
		});
	}

	// ---------------------------------------------------------------- chapters

	/**
	 * The agent reached a checkpoint (a progress message, a finished command). Ask whether the work
	 * since the last chapter is ready for one, at most once per `checkpointMs` and never before
	 * `chapterMs` has passed since the last chapter (or the start of the turn).
	 */
	private checkpoint(turn: LogicalTurn): void {
		if (!turn.codingDone && this.turn === turn) {
			this.tellDiagram(turn, this.tracker.currentNetChanges(), false);
		}
		if (turn.codingDone || this.turn !== turn || this.options.explanationsEnabled?.() === false) {
			return;
		}
		if (turn.checking) {
			turn.checkPending = true;
			return;
		}
		const allowedAt = Math.max(turn.lastChapterAt + this.options.chapterMs(), turn.lastCheckAt + this.options.checkpointMs());
		const wait = allowedAt - Date.now();
		if (wait > 0) {
			// Coalesce: one question when it's allowed, covering every checkpoint until then.
			turn.checkPending = true;
			if (!turn.checkTimer) {
				turn.checkTimer = setTimeout(() => {
					turn.checkTimer = undefined;
					if (turn.checkPending) {
						turn.checkPending = false;
						this.checkpoint(turn);
					}
				}, wait);
			}
			return;
		}
		turn.checkPending = false;
		turn.checking = this.askForChapter(turn).finally(() => {
			turn.checking = undefined;
			if (turn.checkPending) {
				turn.checkPending = false;
				this.checkpoint(turn);
			}
		});
	}

	private async askForChapter(turn: LogicalTurn): Promise<void> {
		const changes = this.unexplainedChanges(turn);
		if (!assessWorthiness(changes).worthy) {
			return; // nothing to ask about; doesn't count against the question interval
		}
		turn.lastCheckAt = Date.now();
		try {
			const decision = await this.planner.checkpoint({
				profile: this.options.profile(),
				task: turn.task,
				minutesSinceLastChapter: Math.round((Date.now() - turn.lastChapterAt) / 60000),
				progress: [...turn.agentMessages.values()].slice(turn.messagesAtLastChapter),
				files: changes.filter(change => !change.userOnly).map(change => ({ path: change.path, added: change.added, removed: change.removed })),
				tools: [...turn.tools.values()].slice(turn.toolsAtLastChapter),
				earlierChapters: turn.chapters.map(chapter => chapter.title),
				preferNotes: this.options.preferNotes(),
			});
			turn.worthinessLog.push(`chapter check: ${decision.decision}${decision.reason ? ` (${decision.reason})` : ''}`);
			this.options.log(`chapter check for turn ${turn.index}: ${decision.decision}${decision.reason ? ` (${decision.reason})` : ''}`);
			if (decision.decision === 'chapter' && !turn.codingDone) {
				await this.writeChapter(turn, changes);
			}
		} catch (error) {
			this.options.log(`chapter check failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Explains the work since the last chapter while the agent keeps going. */
	private async writeChapter(turn: LogicalTurn, changes: readonly NetFileChange[]): Promise<void> {
		const index = turn.chapters.length + 1;
		const files = this.capture(changes);
		this.setStage(turn, 'drafting', `Writing chapter ${index} while ${this.options.provider.name} works`);
		const result = await this.planner.plan(await this.planningContext(turn, changes, [], false, index));
		if (result.draft || result.brief) {
			await this.keepMemory(result.remember, result.draft?.title ?? result.brief?.title ?? turn.task);
		}
		const markExplained = () => {
			for (const change of changes) {
				turn.explained.set(change.path, change.final);
			}
			turn.lastChapterAt = Date.now();
			turn.messagesAtLastChapter = turn.agentMessages.size;
			turn.toolsAtLastChapter = turn.tools.size;
		};
		if (result.brief?.format === 'note') {
			markExplained();
			const inline = this.noteWalkthrough(turn, result.brief, files, index);
			if (inline) {
				turn.chapters.push(inline);
				await this.saveChapter(turn, inline, files);
				this.walkthroughs.set(inline.id, inline);
			}
			this.explainerNote(turn, result.brief.note!, inline && `${turn.id}-c${index}`);
			turn.worthinessLog.push(`chapter ${index}: note${inline ? ' (with inline version)' : ''}`);
		} else if (result.draft) {
			markExplained();
			const walkthrough = this.toWalkthrough(turn, result.draft, files, [], index);
			turn.chapters.push(walkthrough);
			turn.worthinessLog.push(`chapter ${index}: ${result.draft.scenes.length} scene${result.draft.scenes.length === 1 ? '' : 's'}`);
			await this.saveChapter(turn, walkthrough, files);
			this.walkthroughs.set(walkthrough.id, walkthrough);
			this.pendingWalkthrough = walkthrough;
			this.options.emit({ type: 'walkthroughReady', walkthrough });
		} else {
			turn.worthinessLog.push(`chapter ${index}: ${result.brief ? `skipped (${result.brief.reason ?? 'not worth it yet'})` : `planning failed: ${result.errors.join('; ')}`}`);
		}
		if (!turn.codingDone) {
			this.setStage(turn, 'collecting', result.draft ? `Chapter ${index} ready; ${this.options.provider.name} is still working` : 'Watching changes');
		}
	}

	/** A short explanation in chat instead of a walkthrough; `recordId` is the history record of its inline version. */
	private explainerNote(turn: LogicalTurn, text: string, recordId?: string): void {
		this.upsertChat({ id: entryId('note'), turnId: turn.id, role: 'explainer', text, at: Date.now(), recordId });
	}

	/** The note as a one-scene walkthrough at the change, for history and "Show in Code". */
	private noteWalkthrough(turn: LogicalTurn, brief: NoteBrief, files: Record<string, CapturedFile>, chapter: number | undefined): Walkthrough | undefined {
		const draft = noteDraft(brief, files);
		return draft && { ...this.toWalkthrough(turn, draft, files, [], chapter), note: true };
	}

	private toWalkthrough(turn: LogicalTurn, draft: WalkthroughDraft, files: Record<string, CapturedFile>, pending: readonly PendingCheck[], chapter: number | undefined): Walkthrough {
		return {
			id: `wt-${turn.id}${chapter ? `-c${chapter}` : ''}`,
			sessionId: this.coding?.sessionId ?? 'unknown',
			turnId: turn.id,
			turnIndex: turn.index,
			task: turn.task,
			title: draft.title,
			summary: draft.summary,
			createdAt: Date.now(),
			terms: draft.terms,
			scenes: draft.scenes,
			pending,
			files,
			chapter,
		};
	}

	/** Each mid-turn chapter is kept in history on its own, so it can be replayed like any walkthrough. */
	private async saveChapter(turn: LogicalTurn, walkthrough: Walkthrough, files: Record<string, CapturedFile>): Promise<void> {
		await this.history.save({
			summary: {
				sessionId: this.coding?.sessionId ?? 'unknown',
				turnId: `${turn.id}-c${walkthrough.chapter}`,
				index: turn.index,
				task: turn.task,
				startedAt: turn.startedAt,
				endedAt: Date.now(),
				outcome: 'chapter',
				walkthroughId: walkthrough.id,
				walkthroughTitle: walkthrough.title,
				walkthroughIsNote: walkthrough.note,
				explanationNote: `${walkthrough.note ? 'Note' : `Chapter ${walkthrough.chapter}`}: ${walkthrough.title}`,
				files: Object.values(files).map(file => ({ path: file.path, added: file.added, removed: file.removed })),
			},
			chat: [],
			reasoningSummaries: [],
			tools: [...turn.tools.values()],
			edits: [],
			files: Object.values(files),
			walkthrough,
			worthiness: [...turn.worthinessLog],
		}).catch(error => this.options.log(`history save failed: ${error}`));
		this.options.emit({ type: 'history', history: await this.history.list() });
	}

	/**
	 * Plans now, or right after the draft in flight. Called with `final` when the agent gives its final
	 * answer: Muse then spends a while on its own end-of-turn checks before the turn completes, and the
	 * walkthrough is planned meanwhile (it's reused at the end if nothing changed).
	 */
	private requestDraft(turn: LogicalTurn): void {
		if (this.options.explanationsEnabled?.() === false) {
			return;
		}
		if (turn.drafting) {
			turn.redraft = true;
			return;
		}
		turn.drafting = (async () => {
			try {
				// A chapter being written covers part of the change; plan the rest after it.
				await turn.checking;
				await this.draft(turn);
				while (turn.redraft && this.turn === turn) {
					turn.redraft = false;
					await this.draft(turn);
				}
			} finally {
				turn.drafting = undefined;
			}
		})();
	}

	private async draft(turn: LogicalTurn): Promise<void> {
		const changes = this.unexplainedChanges(turn);
		if (!assessWorthiness(changes).worthy) {
			return;
		}
		const signature = signatureOf(changes, turn);
		if (turn.draft?.signature === signature) {
			return;
		}
		this.setStage(turn, 'drafting', `Writing the explanation while ${this.options.provider.name} wraps up`);
		try {
			const chapter = turn.chapters.length ? turn.chapters.length + 1 : undefined;
			const result = await this.planner.plan(await this.planningContext(turn, changes, [], true, chapter), turn.draft?.result.draft);
			if (result.draft || result.brief) {
				turn.draft = { signature, result };
				turn.worthinessLog.push(result.draft ? `planned early: ${result.draft.scenes.length} scenes` : `planned early: ${result.brief!.format}`);
			}
			if (!turn.codingDone) {
				this.setStage(turn, 'collecting', `Explanation ready; ${this.options.provider.name} is finishing up`);
			}
		} catch (error) {
			this.options.log(`early plan failed: ${error instanceof Error ? error.message : String(error)}`);
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

	private async planningContext(turn: LogicalTurn, changes: readonly NetFileChange[], pending: readonly PendingCheck[], final: boolean, chapter?: number): Promise<PlanningContext> {
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
			preferNotes: this.options.preferNotes(),
			chapter: chapter ? { index: chapter, earlier: turn.chapters.map(entry => ({ title: entry.title, summary: entry.summary })) } : undefined,
			memory: await this.options.memory?.describe(),
		};
	}

	// ---------------------------------------------------------------- explainer memory

	/** Saves what the explainer asked to remember, once its explanation is actually used. */
	private async keepMemory(inputs: readonly MemoryInput[] | undefined, context: string): Promise<void> {
		if (!inputs?.length || !this.options.memory) {
			return;
		}
		try {
			if (await this.options.memory.add(inputs, context)) {
				this.options.emit({ type: 'memory', notes: await this.options.memory.list() });
				void this.condenseMemory();
			}
		} catch (error) {
			this.options.log(`couldn't save explainer memory: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private condensing: Promise<void> | undefined;

	/**
	 * Once memory is too long to keep passing in full, the explainer rewrites it as fewer, shorter notes.
	 * Runs in the background behind other explanation work, one at a time, and never when explanations are off.
	 */
	condenseMemory(): Promise<void> {
		this.condensing ??= this.runCondense().finally(() => this.condensing = undefined);
		return this.condensing;
	}

	private async runCondense(): Promise<void> {
		const memory = this.options.memory;
		if (!memory || this.options.explanationsEnabled?.() === false || !await memory.needsCondensing()) {
			return;
		}
		const notes = await memory.list();
		const size = await memory.size();
		try {
			const reply = await this.explainer.ask(buildMemoryCondensePrompt(await memory.describe(), size, CONDENSE_TARGET_CHARS));
			const condensed = condensedOf(extractJsonObject(reply));
			if (!condensed) {
				this.options.log('memory condensing returned no usable notes; memory left as it was');
				return;
			}
			await memory.condense(new Set(notes.map(note => note.id)), condensed, 'condensed');
			this.options.log(`memory condensed: ${notes.length} notes (${size} chars) → ${condensed.length} notes (${await memory.size()} chars now)`);
			this.options.emit({ type: 'memory', notes: await memory.list() });
		} catch (error) {
			this.options.log(`memory condensing failed: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private async recordQuestion(question: string, about: string | undefined): Promise<void> {
		if (!this.options.memory) {
			return;
		}
		try {
			await this.options.memory.recordQuestion(question, about);
			this.options.emit({ type: 'memory', notes: await this.options.memory.list() });
			void this.condenseMemory();
		} catch (error) {
			this.options.log(`couldn't save explainer memory: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	async memoryNotes(): Promise<readonly MemoryNote[]> {
		return this.options.memory?.list() ?? [];
	}

	async forget(id?: string): Promise<void> {
		await this.options.memory?.delete(id);
		this.options.emit({ type: 'memory', notes: await this.memoryNotes() });
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
					// Progress notes (`commentary`) are checkpoints; the final answer carries no such phase.
					if (item.phase === 'commentary') {
						this.checkpoint(turn);
					} else if (!turn.codingDone && turn.verdict?.worthy) {
						this.requestDraft(turn);
					}
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
				const label = describeDebugCall(item.tool ?? '', item.args) ?? item.label ?? (item.tool ? `${item.tool}${command ? ` ${command}` : ''}` : 'Tool');
				this.upsertAgentEntry(item.id, { role: 'tool', text: label, status: item.status === 'inProgress' && item.background ? 'background' : item.status, turnId });
				if (turn) {
					turn.tools.set(item.id, { id: item.id, tool: item.tool ?? 'tool', label, status: item.status, command, output: item.output?.slice(-4000), background: item.background === true });
				}
				if (item.status === 'inProgress' && !item.background) {
					this.tracker.setActiveTool(item.id);
				}
				if (completed && item.background) {
					this.resolveCheck([item.id], command, item.status);
				}
				if (completed || item.background) {
					void this.tracker.rescan().then(edits => {
						this.afterEdits(edits);
						// A finished command or test run is a checkpoint (after its edits are recorded); file edits aren't.
						if (completed && command && turn && COMMAND_TOOLS.test(item.tool ?? '')) {
							this.checkpoint(turn);
						}
						if (completed && turn && item.turnId) {
							this.maybeSuggestDebugger(turn, item.turnId);
						}
					});
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
				if (completion) {
					this.resolveCheck([completion.toolCallId, item.id], completion.command, completion.terminalStatus);
				}
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
				// Muse's own bookkeeping (its reminder helpers, history markers) isn't part of the conversation.
				if (completed && item.fallbackText && !INTERNAL_ITEM_KINDS.has(item.kind)) {
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

	onTurnCompleted(protocolTurnId: string, terminal: string, error?: string, errorKind?: string): void {
		const turn = this.turn;
		if (!turn || !turn.protocolTurns.has(protocolTurnId) || turn.codingDone) {
			return;
		}
		if (terminal === 'failed' && this.options.isAuthFailure(errorKind, error)) {
			this.system(`${this.options.provider.name} needs you to sign in before it can work on this.`, turn.id);
			this.options.onAuthRequired(error);
		} else if (error) {
			this.system(`${this.options.provider.name}: ${error}`, turn.id);
		}
		void this.finishCoding(turn, terminal);
	}

	// ---------------------------------------------------------------- end of turn

	/**
	 * When the coding agent looks stuck (the same test failing again, several failed runs, print statements added
	 * to see values) and hasn't used its debugger, Active suggests it, once per turn, into the running turn.
	 */
	private maybeSuggestDebugger(turn: LogicalTurn, protocolTurnId: string): void {
		const tools = this.options.debugTools;
		if (turn.debugSuggested || turn.codingDone || this.turn !== turn || !tools?.available() || !tools.suggestWhenStuck() || !this.coding?.steer) {
			return;
		}
		const reason = stuckReason([...turn.tools.values()], this.tracker.currentNetChanges().filter(change => !change.userOnly));
		if (!reason) {
			return;
		}
		turn.debugSuggested = true;
		this.options.log(`suggesting the debugger to the coding agent: ${reason}`);
		void this.coding.steer(protocolTurnId, debuggerSuggestion(reason)).then(() => {
			this.upsertChat({ id: entryId('tool'), turnId: turn.id, role: 'tool', text: `Active suggested the debugger to ${this.options.provider.shortName} (${reason})`, status: 'completed', at: Date.now() });
		}, error => this.options.log(`couldn't suggest the debugger: ${error instanceof Error ? error.message : String(error)}`));
	}

	private async finishCoding(turn: LogicalTurn, terminal: string): Promise<void> {
		turn.codingDone = true;
		// A debug session the agent left open doesn't outlive its turn.
		void this.options.debugTools?.stopAll();
		if (turn.checkTimer) {
			clearTimeout(turn.checkTimer);
			turn.checkTimer = undefined;
		}
		turn.checkPending = false;
		this.tracker.setActiveTool(undefined);
		// Freeze the turn's changes now: later edits belong to later turns and never alter this capture.
		const captured = await this.tracker.endTurn();
		const changes = captured?.changes ?? [];
		const edits = captured?.edits ?? [];
		const agentFiles = changes.filter(change => !change.userOnly).map(change => ({ path: change.path, added: change.added, removed: change.removed, ...(change.baseline === null ? { created: true } : {}) }));
		if (agentFiles.length) {
			this.agentChanges = agentFiles;
			this.agentBaselines = new Map(changes.filter(change => !change.userOnly).map(change => [change.path, change.baseline]));
			this.options.emit({ type: 'turnChanges', turnId: turn.id, files: agentFiles });
		}
		this.setStatus('idle');
		this.tellDiagram(turn, changes, true);

		const next = this.queuedTasks.shift();
		const files = this.capture(changes);
		// A chapter still being written covers part of the change: the rest is what's left to explain.
		await turn.checking;
		const remaining = this.unexplainedChanges(turn, changes);
		const verdict = assessWorthiness(remaining);
		turn.verdict = verdict;
		turn.worthinessLog.push(`final: ${verdict.reasons.join('; ')}`);
		const chapters = turn.chapters.length;

		let walkthrough: Walkthrough | undefined;
		let noteInline: Walkthrough | undefined;
		let note: string;
		let startedNext = false;
		if (terminal !== 'completed' && Object.keys(files).length === 0) {
			note = `Turn ${terminal}; no changes to explain.`;
			this.setStage(turn, 'notExplained', note);
		} else if (this.options.explanationsEnabled?.() === false) {
			note = 'Explanations are off. Saved to history.';
			this.setStage(turn, 'notExplained', note);
		} else if (!verdict.worthy) {
			note = chapters ? `Explained in ${chapters} chapter${chapters === 1 ? '' : 's'}.` : 'No code changes to explain.';
			this.setStage(turn, chapters ? 'ready' : 'notExplained', note);
		} else {
			// Start the queued task right away: the coding agent never waits for explanations.
			if (next) {
				startedNext = true;
				void this.beginLogicalTurn(next);
			}
			const pending = await this.waitForBackground(turn);
			for (const check of pending) {
				this.openChecks.set(check.id, { turnId: turn.id, check });
			}
			this.setStage(turn, 'finalizing', 'Finishing the explanation');
			let stage: WalkthroughStage = 'failed';
			try {
				const remainingFiles = this.capture(remaining);
				const outcome = await this.finalizeWalkthrough(turn, remainingFiles, remaining, pending);
				walkthrough = outcome.walkthrough;
				if (walkthrough) {
					note = `${walkthrough.chapter ? `Chapter ${walkthrough.chapter}` : 'Walkthrough'}: ${walkthrough.title}`;
					stage = 'ready';
				} else if (outcome.brief?.format === 'note') {
					// Saved like a walkthrough (History, Replay, questions) but shown as a note: it never pops up.
					noteInline = this.noteWalkthrough(turn, outcome.brief, remainingFiles, chapters ? chapters + 1 : undefined);
					this.explainerNote(turn, outcome.brief.note!, noteInline && turn.id);
					note = 'Explained in a short note.';
					stage = 'notExplained';
				} else if (outcome.brief) {
					note = `Not explained: ${outcome.brief.reason ?? 'not worth a walkthrough for you'}.`;
					stage = 'notExplained';
				} else {
					note = 'The explanation did not survive reconciliation with the final changes.';
				}
			} catch (error) {
				note = `Explanation failed: ${error instanceof Error ? error.message : String(error)}`;
			}
			this.setStage(turn, stage, note);
		}

		const summary: TurnSummary = {
			sessionId: this.coding?.sessionId ?? 'unknown',
			turnId: turn.id,
			index: turn.index,
			task: turn.task,
			startedAt: turn.startedAt,
			endedAt: Date.now(),
			outcome: terminal,
			walkthroughId: (walkthrough ?? noteInline)?.id,
			walkthroughTitle: (walkthrough ?? noteInline)?.title,
			walkthroughIsNote: !walkthrough && !!noteInline || undefined,
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
			walkthrough: walkthrough ?? noteInline,
			worthiness: turn.worthinessLog,
		}).catch(error => this.options.log(`history save failed: ${error}`));
		this.options.emit({ type: 'history', history: await this.history.list() });

		if (noteInline) {
			this.walkthroughs.set(noteInline.id, noteInline);
		}
		if (walkthrough) {
			this.walkthroughs.set(walkthrough.id, walkthrough);
			this.pendingWalkthrough = walkthrough;
			this.options.emit({ type: 'walkthroughReady', walkthrough });
		}
		for (const [taskId, open] of this.openChecks) {
			if (open.turnId !== turn.id) {
				continue;
			}
			if (!walkthrough) {
				this.openChecks.delete(taskId);
				continue;
			}
			open.walkthroughId = walkthrough.id;
			if (open.result) {
				// The task finished while the walkthrough was being written.
				void this.settleCheck(taskId, open.result);
			}
		}
		if (this.turn === turn) {
			this.turn = undefined;
		}
		if (next && !startedNext) {
			await this.beginLogicalTurn(next);
		}
	}

	/** A background task reported back: mark its pending check finished or failed. */
	private resolveCheck(ids: ReadonlyArray<string | undefined>, command: string | undefined, status: string | undefined): void {
		const state: PendingCheck['state'] = /fail|error|cancel|interrupt|kill/i.test(status ?? '') ? 'failed' : 'finished';
		for (const [taskId, open] of this.openChecks) {
			if (ids.includes(taskId) || (command && open.check.label === command)) {
				if (open.walkthroughId) {
					void this.settleCheck(taskId, state);
				} else {
					open.result = state;
				}
				return;
			}
		}
	}

	private async settleCheck(taskId: string, state: PendingCheck['state']): Promise<void> {
		const open = this.openChecks.get(taskId);
		if (!open?.walkthroughId) {
			return;
		}
		this.openChecks.delete(taskId);
		const check: PendingCheck = { ...open.check, state };
		const walkthrough = this.walkthroughs.get(open.walkthroughId);
		if (walkthrough) {
			const updated: Walkthrough = { ...walkthrough, pending: walkthrough.pending.map(candidate => candidate.id === taskId ? check : candidate) };
			this.walkthroughs.set(updated.id, updated);
			if (this.pendingWalkthrough?.id === updated.id) {
				this.pendingWalkthrough = updated;
			}
		}
		await this.history.updatePendingCheck(open.turnId, check).catch(error => this.options.log(`history update failed: ${error}`));
		this.options.emit({ type: 'checkUpdate', walkthroughId: open.walkthroughId, check });
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

	/** Plans what's left to explain at the end of the turn, reusing the early plan when nothing changed since. */
	private async finalizeWalkthrough(turn: LogicalTurn, files: Record<string, CapturedFile>, changes: readonly NetFileChange[], pending: readonly PendingCheck[]): Promise<{ walkthrough?: Walkthrough; brief?: PlanResult['brief'] }> {
		await turn.drafting?.catch(() => undefined);
		const signature = signatureOf(changes, turn);
		const evidence = new Set(turn.tools.keys());
		const chapter = turn.chapters.length ? turn.chapters.length + 1 : undefined;
		let result: PlanResult | undefined;
		const early = turn.draft?.signature === signature && pending.length === 0 ? turn.draft.result : undefined;
		if (early?.brief) {
			result = early;
		} else if (early?.draft) {
			result = { ...this.planner.reconcile(early.draft, files, evidence), remember: early.remember };
		}
		if (!result?.draft && !result?.brief) {
			result = await this.planner.plan(await this.planningContext(turn, changes, pending, true, chapter), turn.draft?.result.draft);
		}
		if (result.draft || result.brief) {
			await this.keepMemory(result.remember, result.draft?.title ?? result.brief?.title ?? turn.task);
		}
		if (result.brief) {
			turn.worthinessLog.push(`explainer chose ${result.brief.format}${result.brief.reason ? `: ${result.brief.reason}` : ''}`);
			return { brief: result.brief };
		}
		if (result.dropped.length) {
			turn.worthinessLog.push(`dropped scenes about reverted work: ${result.dropped.join(', ')}`);
		}
		if (!result.draft) {
			this.options.log(`walkthrough planning failed: ${result.errors.join('; ')}`);
			return {};
		}
		return { walkthrough: this.toWalkthrough(turn, result.draft, files, pending, chapter) };
	}

	// ---------------------------------------------------------------- away mode

	/**
	 * The return briefing: what happened since `since` (finished tasks, chapters, notes, failures,
	 * pending checks, anything waiting on the developer), condensed by the explanation model. Falls
	 * back to a plain summary when the model can't answer, so there's always something to show.
	 */
	async brief(request: BriefingRequest): Promise<Briefing> {
		const summaries = (await this.history.list()).filter(turn => (turn.endedAt ?? turn.startedAt) >= request.since).reverse();
		const turns: BriefingTurn[] = [];
		for (const summary of summaries) {
			const detail = await this.history.get(summary.turnId);
			const agentMessages = detail?.chat.filter(entry => entry.role === 'agent' && entry.phase !== 'commentary' && entry.text) ?? [];
			turns.push({
				task: summary.task,
				outcome: summary.outcome,
				explanation: summary.explanationNote,
				summary: detail?.walkthrough?.summary,
				finalMessage: agentMessages[agentMessages.length - 1]?.text,
				notes: detail?.chat.filter(entry => entry.role === 'explainer' && entry.id.startsWith('note')).map(entry => entry.text) ?? [],
				failedCommands: (detail?.tools ?? []).filter(tool => tool.command && /fail|error/i.test(tool.status)).map(tool => tool.command!),
				pendingChecks: (detail?.walkthrough?.pending ?? []).filter(check => check.state === 'running').map(check => check.label),
				files: summary.files,
			});
		}
		const turn = this.turn && !this.turn.codingDone ? this.turn : undefined;
		const running = turn ? { task: turn.task, progress: [...turn.agentMessages.values()].slice(-3) } : undefined;
		const waiting = this.chat.filter(entry => entry.approval && !entry.approval.resolved).map(entry => `${entry.approval!.title}: ${entry.approval!.detail}`.slice(0, 200));
		const minutesAway = Math.max(1, Math.round((Date.now() - request.since) / 60000));
		const fallback: Briefing = {
			headline: turns.length ? `${turns.length} task${turns.length === 1 ? '' : 's'} finished while you were away` : running ? `Still working on: ${running.task}` : 'Nothing new while you were away',
			done: turns.map(entry => `${entry.task.split('\n')[0].slice(0, 80)} — ${entry.explanation}`),
			attention: waiting,
			problems: turns.flatMap(entry => [...entry.failedCommands.map(command => `Failed: ${command}`), ...entry.pendingChecks.map(check => `Still running: ${check}`)]),
			next: running ? `${this.options.provider.name} is still working on "${running.task.split('\n')[0].slice(0, 80)}".` : '',
			fallback: true,
		};
		if (!turns.length && !running && !waiting.length) {
			return fallback;
		}
		try {
			const reply = await this.explainer.ask(buildBriefingPrompt({ profile: this.options.profile(), minutesAway, turns, running, waiting }));
			const parsed = extractJsonObject(reply) as Partial<Record<keyof Briefing, unknown>> | undefined;
			const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];
			if (!parsed || typeof parsed.headline !== 'string') {
				throw new Error('no headline in the reply');
			}
			return { headline: parsed.headline, done: list(parsed.done), attention: list(parsed.attention), problems: list(parsed.problems), next: typeof parsed.next === 'string' ? parsed.next : '' };
		} catch (error) {
			this.options.log(`return briefing failed: ${error instanceof Error ? error.message : String(error)}`);
			return fallback;
		}
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
