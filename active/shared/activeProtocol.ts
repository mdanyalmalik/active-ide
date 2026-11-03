/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The contract between Active's node-side services (the `active-agent` built-in
 * extension) and the Active workbench contribution. This file has no imports so
 * it can be compiled into both projects unchanged; `scripts/sync.sh` copies it.
 */

// ---------------------------------------------------------------------------
// Knowledge profile
// ---------------------------------------------------------------------------

export type Familiarity = 'new' | 'some' | 'comfortable' | 'expert';
export type ExplanationDepth = 'overview' | 'balanced' | 'deep';
export type MathComfort = 'avoid' | 'light' | 'comfortable';
export type VisualKind = 'code' | 'diff' | 'equation' | 'diagram' | 'chart';

export interface KnowledgeProfile {
	readonly version: 1;
	readonly configured: boolean;
	readonly background: string;
	readonly yearsProgramming: number;
	readonly languages: ReadonlyArray<{ readonly name: string; readonly familiarity: Familiarity }>;
	readonly concepts: ReadonlyArray<ConceptKnowledge>;
	readonly followClosely: string;
	readonly glossOver: string;
	readonly depth: ExplanationDepth;
	/** Fine-tuning within `depth` adjusted from feedback: -1 (less detail) to 1 (more detail). */
	readonly detailBias: number;
	readonly math: MathComfort;
	readonly preferredVisuals: ReadonlyArray<VisualKind>;
	readonly notes: string;
	/** @deprecated Moved to the `active.narration.speed` setting; read only to migrate older profiles. */
	readonly narrationRate?: number;
	/** @deprecated Moved to the `active.narration.voice` setting; read only to migrate older profiles. */
	readonly voice?: string;
}

export interface ConceptKnowledge {
	readonly name: string;
	readonly familiarity: Familiarity;
	/** Continuous level behind `familiarity` (0 new … 3 expert), nudged by feedback. */
	readonly level?: number;
}

export const DEFAULT_PROFILE: KnowledgeProfile = {
	version: 1,
	configured: false,
	background: '',
	yearsProgramming: 3,
	languages: [],
	concepts: [],
	followClosely: '',
	glossOver: '',
	depth: 'balanced',
	detailBias: 0,
	math: 'light',
	preferredVisuals: ['code', 'diff', 'diagram', 'equation', 'chart'],
	notes: '',
};

export type DetailFeedback = 'tooMuch' | 'right' | 'tooLittle';

const FAMILIARITY_ORDER: readonly Familiarity[] = ['new', 'some', 'comfortable', 'expert'];
const DEPTH_ORDER: readonly ExplanationDepth[] = ['overview', 'balanced', 'deep'];
/** How far one answer moves the general detail preference (a full step is 1). */
export const DETAIL_FEEDBACK_STEP = 0.2;
/** How far one answer moves knowledge of the walkthrough's topics (a familiarity step is 1). */
export const TOPIC_FEEDBACK_STEP = 0.5;

/**
 * Applies "was that too much / about right / too little detail?" to the profile:
 * the general detail preference moves slightly, and knowledge of the topics the
 * explanation covered moves more (too much detail suggests the developer already
 * knows them better than assumed). Crossing a full step changes `depth`.
 */
export function applyDetailFeedback(profile: KnowledgeProfile, feedback: DetailFeedback, topics: readonly string[]): KnowledgeProfile {
	if (feedback === 'right') {
		// Confirms the current setting: settle the fine-tuning a little toward neutral.
		return { ...profile, detailBias: Math.round(profile.detailBias * 0.8 * 100) / 100 };
	}
	const direction = feedback === 'tooMuch' ? -1 : 1;
	let depth = profile.depth;
	let bias = (profile.detailBias ?? 0) + direction * DETAIL_FEEDBACK_STEP;
	const depthIndex = DEPTH_ORDER.indexOf(depth);
	if (bias >= 1 && depthIndex < DEPTH_ORDER.length - 1) {
		depth = DEPTH_ORDER[depthIndex + 1];
		bias -= 1;
	} else if (bias <= -1 && depthIndex > 0) {
		depth = DEPTH_ORDER[depthIndex - 1];
		bias += 1;
	}
	bias = Math.max(-1, Math.min(1, Math.round(bias * 100) / 100));
	const concepts = [...profile.concepts];
	for (const topic of topics.map(name => name.trim()).filter(Boolean)) {
		const index = concepts.findIndex(concept => concept.name.toLowerCase() === topic.toLowerCase());
		const existing = index >= 0 ? concepts[index] : undefined;
		const current = existing ? existing.level ?? FAMILIARITY_ORDER.indexOf(existing.familiarity) : 1;
		const level = Math.max(0, Math.min(3, Math.round((current - direction * TOPIC_FEEDBACK_STEP) * 100) / 100));
		const updated: ConceptKnowledge = { name: existing?.name ?? topic, familiarity: FAMILIARITY_ORDER[Math.round(level)], level };
		if (index >= 0) {
			concepts[index] = updated;
		} else {
			concepts.push(updated);
		}
	}
	return { ...profile, depth, detailBias: bias, concepts };
}

/** How far skipping a scene early moves knowledge of its topics: a very slight signal. */
export const SKIP_SIGNAL_STEP = 0.1;

/**
 * Skipping a scene before much of it was narrated hints, very slightly, that the
 * developer already knew its topics. Only familiarity moves; the detail
 * preference is left alone.
 */
export function applySkipSignal(profile: KnowledgeProfile, topics: readonly string[]): KnowledgeProfile {
	if (!topics.length) {
		return profile;
	}
	const concepts = [...profile.concepts];
	for (const topic of topics.map(name => name.trim()).filter(Boolean)) {
		const index = concepts.findIndex(concept => concept.name.toLowerCase() === topic.toLowerCase());
		const existing = index >= 0 ? concepts[index] : undefined;
		const current = existing ? existing.level ?? FAMILIARITY_ORDER.indexOf(existing.familiarity) : 1;
		const level = Math.min(3, Math.round((current + SKIP_SIGNAL_STEP) * 100) / 100);
		const updated: ConceptKnowledge = { name: existing?.name ?? topic, familiarity: FAMILIARITY_ORDER[Math.round(level)], level };
		if (index >= 0) {
			concepts[index] = updated;
		} else {
			concepts.push(updated);
		}
	}
	return { ...profile, concepts };
}

/** The walkthrough's declared terms that a scene talks about. */
export function sceneTopics(walkthrough: Walkthrough, sceneIndex: number): string[] {
	const scene = walkthrough.scenes[sceneIndex];
	if (!scene) {
		return [];
	}
	const text = `${scene.title} ${scene.narration.map(segment => segment.text).join(' ')}`.toLowerCase();
	return walkthrough.terms.map(term => term.name).filter(name => text.includes(name.toLowerCase())).slice(0, 3);
}

// ---------------------------------------------------------------------------
// Walkthrough
// ---------------------------------------------------------------------------

export interface LineRange {
	/** 1-based, inclusive. */
	readonly startLine: number;
	/** 1-based, inclusive. */
	readonly endLine: number;
}

export type CapturedVersion = 'baseline' | 'final';

export interface CapturedFile {
	readonly path: string;
	readonly languageHint?: string;
	/** `null` when the file did not exist at the start of the turn. */
	readonly baseline: string | null;
	/** `null` when the turn deleted the file. */
	readonly final: string | null;
	readonly added: number;
	readonly removed: number;
}

export interface Term {
	/** The single name used for this idea in narration, diagrams, equations and code callouts. */
	readonly name: string;
	readonly meaning: string;
	/** The identifier in code this term corresponds to, when there is one. */
	readonly codeSymbol?: string;
}

export interface CodeVisual {
	readonly type: 'code';
	readonly file: string;
	readonly version: CapturedVersion;
	readonly range: LineRange;
	readonly caption?: string;
}

export interface DiffVisual {
	readonly type: 'diff';
	readonly file: string;
	/** Lines of the final version whose surrounding hunks to show. */
	readonly range: LineRange;
	readonly caption?: string;
}

export interface EquationVisual {
	readonly type: 'equation';
	/** KaTeX-compatible LaTeX. */
	readonly latex: string;
	readonly legend?: ReadonlyArray<{ readonly symbol: string; readonly term: string }>;
	readonly caption?: string;
}

export interface DiagramNode {
	readonly id: string;
	readonly label: string;
	readonly detail?: string;
	/** Nodes sharing a column. Lower columns render to the left. */
	readonly column?: number;
}

export interface DiagramEdge {
	readonly from: string;
	readonly to: string;
	readonly label?: string;
}

export interface DiagramVisual {
	readonly type: 'diagram';
	readonly nodes: ReadonlyArray<DiagramNode>;
	readonly edges: ReadonlyArray<DiagramEdge>;
	/** Illustrative diagrams depict a model of the behavior rather than something observed. */
	readonly illustrative: boolean;
	readonly caption?: string;
}

export interface ChartVisual {
	readonly type: 'chart';
	readonly chart: 'bar' | 'line';
	readonly title: string;
	readonly xLabel: string;
	readonly yLabel: string;
	readonly series: ReadonlyArray<{ readonly name: string; readonly points: ReadonlyArray<{ readonly x: string | number; readonly y: number }> }>;
	/** `observed` charts must cite tool evidence; everything else is `illustrative`. */
	readonly source: 'observed' | 'illustrative';
	/** Evidence id (a tool outcome id) backing an observed chart. */
	readonly evidence?: string;
	readonly caption?: string;
}

export type SceneVisual = CodeVisual | DiffVisual | EquationVisual | DiagramVisual | ChartVisual;

export interface Cue {
	/** Index into the scene's `focus` ranges to emphasize while this segment plays. */
	readonly focus?: number;
	/** Diagram node ids to highlight. */
	readonly nodes?: ReadonlyArray<string>;
	/** Reveal the visual progressively up to this step (diagram columns, chart points, diff hunks). */
	readonly reveal?: number;
}

export interface NarrationSegment {
	readonly text: string;
	readonly cue?: Cue;
}

export type SceneRole = 'problem' | 'intuition' | 'model' | 'implementation' | 'behavior' | 'evidence' | 'tradeoff' | 'summary';

export interface Scene {
	readonly id: string;
	readonly role: SceneRole;
	/** Small uppercase eyebrow, e.g. "Underlying concept". */
	readonly label: string;
	readonly title: string;
	/** The captured file shown in the editor for this scene. */
	readonly file: string;
	readonly version: CapturedVersion;
	/** Ranges in `file@version` highlighted during the scene. */
	readonly focus: ReadonlyArray<LineRange>;
	/** The region kept fully visible. Code outside is deemphasized or folded. */
	readonly context?: LineRange;
	/** The explanation zone is inserted after this line. */
	readonly anchorLine: number;
	/** The enclosing symbol, for breadcrumbs. */
	readonly symbol?: string;
	readonly visual?: SceneVisual;
	readonly narration: ReadonlyArray<NarrationSegment>;
	/** Optional verbatim code the scene claims exists in `file@version`. */
	readonly quote?: string;
	/** Checks or results this scene mentions that had not finished. */
	readonly pending?: ReadonlyArray<string>;
}

export interface PendingCheck {
	readonly id: string;
	readonly label: string;
	/** `running` until the background task reports back; it keeps running after the walkthrough starts. */
	readonly state: 'running' | 'unknown' | 'finished' | 'failed';
}

export interface ToolOutcome {
	readonly id: string;
	readonly tool: string;
	readonly label: string;
	readonly status: string;
	readonly command?: string;
	readonly output?: string;
	readonly background: boolean;
}

export interface Walkthrough {
	readonly id: string;
	readonly sessionId: string;
	/** The top-level agent whose work this explains (absent: made before multi-agent support). */
	readonly agentId?: string;
	readonly agentName?: string;
	readonly turnId: string;
	readonly turnIndex: number;
	readonly task: string;
	readonly title: string;
	readonly summary: string;
	readonly createdAt: number;
	readonly terms: ReadonlyArray<Term>;
	readonly scenes: ReadonlyArray<Scene>;
	readonly pending: ReadonlyArray<PendingCheck>;
	readonly files: Readonly<Record<string, CapturedFile>>;
	/** Long turns are explained in chapters (1-based); each covers the changes since the previous one. */
	readonly chapter?: number;
	/** The inline version of a short note: one scene at the change. It's saved to history but never pops up. */
	readonly note?: boolean;
}

// ---------------------------------------------------------------------------
// Chat, turns and state
// ---------------------------------------------------------------------------

export type AgentStatus = 'unavailable' | 'starting' | 'idle' | 'running' | 'error';

export type SignInMethod = 'subscription' | 'apiKey';

/** First-run setup of the coding agent: install, choose how to sign in, sign in. */
export interface SetupState {
	readonly step: 'install' | 'chooseMethod' | 'signIn' | 'done';
	readonly install: {
		readonly status: 'idle' | 'running' | 'done' | 'failed';
		/** The command Active will run, shown before the user agrees. */
		readonly command?: string;
		readonly scriptUrl?: string;
		readonly line?: string;
		readonly log: readonly string[];
		readonly error?: string;
		/** Active cannot install this agent on this platform. */
		readonly unavailable?: string;
	};
	readonly methods: ReadonlyArray<{ readonly id: SignInMethod; readonly label: string; readonly description: string; readonly unavailable?: string }>;
	readonly method?: SignInMethod;
	readonly signIn: {
		readonly status: 'idle' | 'running' | 'waitingForBrowser' | 'done' | 'failed';
		readonly message?: string;
		readonly url?: string;
		/** Device code the user should see on the sign-in page. */
		readonly code?: string;
	};
	readonly apiKeyEnvVar?: string;
	readonly apiKeyHelpUrl?: string;
	/** Why setup is showing again, e.g. the agent reported it needs sign-in. */
	readonly reason?: string;
}

export interface AgentProviderInfo {
	readonly id: string;
	readonly name: string;
	readonly shortName: string;
	readonly devOnly: boolean;
}

export interface AgentState {
	readonly status: AgentStatus;
	readonly provider: AgentProviderInfo;
	/** Present while the agent still needs installing or signing in. */
	readonly setup?: SetupState;
	/** A short account description once known, e.g. "Pro plan" or "API key". */
	readonly account?: string;
	/** A human-readable integration blocker, when the agent cannot run. */
	readonly blocker?: string;
	readonly workspaceName: string;
	readonly sessionId?: string;
	/** The connected agent host as it identifies itself (e.g. the `muse serve` server name and version). */
	readonly host?: string;
	readonly backgroundTasks: number;
}

export interface ApprovalRequest {
	readonly approvalId: string;
	readonly title: string;
	readonly detail: string;
	/** The narration model, e.g. "MMS English" or "Phonon 31M". */
	readonly model?: string;
	readonly choices: ReadonlyArray<{ readonly choiceId: string; readonly label: string; readonly approves: boolean }>;
	readonly resolved?: string;
}

export interface ChatEntry {
	readonly id: string;
	readonly turnId?: string;
	readonly role: 'user' | 'agent' | 'tool' | 'approval' | 'system' | 'explainer' | 'question' | 'diagram';
	readonly text: string;
	readonly status?: string;
	readonly phase?: string;
	readonly approval?: ApprovalRequest;
	readonly at: number;
	/** For a note: the history record holding its inline version (a one-scene walkthrough at the change). */
	readonly recordId?: string;
	/** For a system map update: the map version it produced. */
	readonly mapVersion?: number;
	/** What a question or task is about when it isn't a walkthrough: parts of the system map, or code ("client.js loc 3–8"). */
	readonly about?: string;
	/** `about` names code (selected in the editor or shown by an explanation card), not parts of the system map. */
	readonly aboutCode?: boolean;
	/** The developer's message describes a change to the system map. */
	readonly mapEdit?: boolean;
	/** Multiplayer: who sent this message, when it wasn't the host. */
	readonly author?: SessionAuthor;
}

/** A person in a multiplayer session, as messages name them. */
export interface SessionAuthor {
	readonly id: string;
	readonly name: string;
	readonly colorIndex: number;
}

export type WalkthroughStage = 'idle' | 'collecting' | 'drafting' | 'waitingForBackground' | 'finalizing' | 'ready' | 'notExplained' | 'failed';

export interface WalkthroughStatus {
	readonly turnId: string;
	readonly stage: WalkthroughStage;
	readonly detail: string;
	/** The narration model, e.g. "MMS English" or "Phonon 31M". */
	readonly model?: string;
}

export interface FileChangeStat {
	readonly path: string;
	readonly added: number;
	readonly removed: number;
	/** The file didn't exist before (the agent created it). */
	readonly created?: boolean;
}

export interface TurnSummary {
	readonly sessionId: string;
	/** The top-level agent that did this turn (absent: made before multi-agent support). */
	readonly agentId?: string;
	readonly agentName?: string;
	readonly turnId: string;
	readonly index: number;
	readonly task: string;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly outcome: string;
	readonly walkthroughId?: string;
	readonly walkthroughTitle?: string;
	/** The walkthrough is the inline version of a short note. */
	readonly walkthroughIsNote?: boolean;
	readonly explanationNote: string;
	readonly files: ReadonlyArray<FileChangeStat>;
}

export interface InitialState {
	readonly agent: AgentState;
	readonly chat: ReadonlyArray<ChatEntry>;
	readonly profile: KnowledgeProfile;
	readonly history: ReadonlyArray<TurnSummary>;
	readonly turnChanges: ReadonlyArray<FileChangeStat>;
	readonly narration: NarrationStatus;
	readonly pendingWalkthrough?: Walkthrough;
	readonly diagram?: DiagramState;
	/** Every agent (top-level and nested) with its own initial state, when multi-agent support is on. */
	readonly agents?: ReadonlyArray<AgentInfo>;
	readonly overlaps?: ReadonlyArray<AgentOverlap>;
	/** Per-agent state for agents other than the main one (the main one's is above). */
	readonly agentStates?: ReadonlyArray<AgentInitialState>;
	/** Why other agents can't be started here (e.g. the folder isn't a git repository). */
	readonly multiAgentBlocker?: string;
}

// ---------------------------------------------------------------------------
// Multi-agent
// ---------------------------------------------------------------------------

/** The id of the agent working in the developer's own folder (the first one). */
export const MAIN_AGENT_ID = 'main';

/** How many agent colours there are (`--active-agent-0` … in CSS). */
export const AGENT_COLORS = 8;

/**
 * How an agent's actions get approved. `auto`: Muse's sandbox, with its AI judge deciding what it can and asking you
 * the rest (Muse's default). `ask`: asks about anything no saved rule allows. `allowAll`: approves everything.
 */
export type AgentApprovalMode = 'auto' | 'ask' | 'allowAll';

export interface AgentTodo {
	readonly text: string;
	readonly status: 'pending' | 'inProgress' | 'done';
}

/** One agent, as the agent list and the grid show it. */
export interface AgentInfo {
	readonly id: string;
	readonly name: string;
	readonly colorIndex: number;
	/**
	 * `agent`: one the developer started (its own worktree, or their folder). `subagent`: one the coding agent spawned
	 * (Muse's own), shown nested under `parentId`. An agent merged into another is shown nested too (`mergedInto`).
	 */
	readonly kind: 'agent' | 'subagent';
	readonly parentId?: string;
	/** The folder it works in (absolute). */
	readonly root: string;
	/** True for the agent that works in the developer's own folder. Only the Explorer needs to show this. */
	readonly inMainFolder: boolean;
	/** Its git branch, when it has one. */
	readonly branch?: string;
	/** Subagent worktrees are Muse's: shown read-only. */
	readonly readOnly?: boolean;
	readonly sessionId?: string;
	readonly status: AgentStatus;
	readonly waitingForApproval: boolean;
	/** One line on what it's doing now. */
	readonly activity?: string;
	/** The latest reasoning summary. */
	readonly reasoning?: string;
	/** Its plan, when it keeps one. */
	readonly todo?: ReadonlyArray<AgentTodo>;
	/** Estimated spend so far, in USD, when the agent reports it: coding plus its explanations, map and traces. */
	readonly cost?: number;
	/** What `cost` is made of. */
	readonly costBreakdown?: { readonly coding: number; readonly explanations: number };
	/** The current (or last) task. */
	readonly task?: string;
	readonly explainMode: ExplainMode;
	readonly approvalMode: AgentApprovalMode;
	readonly createdAt: number;
	/** It finished its work and was merged into another agent (now shown nested under that one). */
	readonly mergedInto?: string;
	/** A subagent finished, or an agent was merged: nothing more will happen in it. */
	readonly finished?: boolean;
	/** When a subagent finished (it fades out of the list and grid shortly after). */
	readonly finishedAt?: number;
}

/** Two top-level agents changed the same files (`sameLines`: the same lines, a likely merge conflict). */
export interface AgentOverlap {
	readonly agents: readonly [string, string];
	readonly files: ReadonlyArray<{ readonly path: string; readonly sameLines: boolean }>;
}

/** The parts of `InitialState` that are per agent. */
export interface AgentInitialState {
	readonly agentId: string;
	readonly agent: AgentState;
	readonly chat: ReadonlyArray<ChatEntry>;
	readonly turnChanges: ReadonlyArray<FileChangeStat>;
	readonly pendingWalkthrough?: Walkthrough;
	readonly diagram?: DiagramState;
}

export interface NewAgentRequest {
	/** Starts it on this task straight away. */
	readonly task?: string | TaskRequest;
	readonly name?: string;
}

export interface MergeAgentsRequest {
	/** The agent dragged… */
	readonly sourceId: string;
	/** …onto this one, which takes its work as if it had been its subagent. */
	readonly targetId: string;
	/** Commit the dragged agent's work on its branch first, and keep that branch. */
	readonly commit?: boolean;
}

export interface MergeAgentsResult {
	readonly ok: boolean;
	readonly message: string;
	readonly files?: number;
	readonly conflicts?: readonly string[];
}

/** Setting ids shared by the workbench (which registers them) and the extension (which applies them). */
export const enum ActiveSetting {
	CodingModel = 'active.coding.model',
	CodingEffort = 'active.coding.reasoningEffort',
	ExplanationModel = 'active.explanation.model',
	ExplanationEffort = 'active.explanation.reasoningEffort',
	NarrationVoice = 'active.narration.voice',
	NarrationSpeed = 'active.narration.speed',
	/** `mms` (the default for the hackathon) or `phonon`. */
	NarrationEngine = 'active.narration.engine',
	/** The MMS checkpoint: a Hugging Face id or a local folder (a fine-tune from active/tts-finetune). */
	NarrationMmsModel = 'active.narration.mmsModel',
	ExplainMode = 'active.explain.mode',
	/** What Active does around the coding agent: walkthroughs, the system map, or both. */
	Features = 'active.features',
	DebugAgentTools = 'active.debug.agentTools',
	DebugSuggestWhenStuck = 'active.debug.suggestWhenStuck',
	DiagramCheckMinutes = 'active.diagram.checkMinutes',
	/** Dictation: tidy the transcript with a cheap model (fillers, punctuation, self-corrections, identifiers). */
	DictationCleanup = 'active.dictation.cleanup',
	/** Dictation: the model that tidies it; empty picks the cheapest one offered. */
	DictationCleanupModel = 'active.dictation.cleanupModel',
	/** Dictation: names, jargon and identifiers to spell the developer's way. */
	DictationDictionary = 'active.dictation.dictionary',
}

export type ActiveFeatures = 'both' | 'explanations' | 'diagrams';

/** `auto`: explanations pop up when ready; `away`: they wait for a return briefing; `off`: none are made. */
export type ExplainMode = 'auto' | 'away' | 'off';

/** Reasoning effort tiers, lowest first. `default` in a setting means the agent's own default for the model. */
export const REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ReasoningEffort = typeof REASONING_EFFORTS[number];

/** A model the coding agent offers (Muse's `model/list`). */
export interface AgentModelInfo {
	readonly id: string;
	readonly label: string;
	readonly description?: string;
	/** USD per million tokens, as the agent reports them. */
	readonly inputCost?: string;
	readonly outputCost?: string;
	readonly isDefault?: boolean;
	readonly efforts: readonly string[];
	readonly defaultEffort?: string;
}

/** Which model and effort a session should use; absent fields leave the agent's defaults. */
export interface AgentRunSettings {
	readonly model?: string;
	readonly reasoningEffort?: ReasoningEffort;
}

export interface VoiceInfo {
	readonly name: string;
	readonly description?: string;
	/** Character voices (storytelling) are listed separately from everyday narrators. */
	readonly character?: boolean;
}

export interface NarrationStatus {
	readonly available: boolean;
	readonly detail: string;
	/** The narration model, e.g. "MMS English" or "Phonon 31M". */
	readonly model?: string;
	/** Voices the narrator offers; `default` is the model's built-in voice. */
	readonly voices?: ReadonlyArray<VoiceInfo>;
}

/** `personal`: about the developer, across projects; `project`: about this folder. */
export type MemoryScope = 'personal' | 'project';

/** A note in the explainer's own memory (kept by Active, separate from the coding agent's). */
export interface MemoryNote {
	readonly id: string;
	readonly scope: MemoryScope;
	readonly text: string;
	readonly at: number;
	/** `explainer`: the explanation model chose to remember it; `question`: a question the developer asked. */
	readonly source: 'explainer' | 'question';
	/** What it came from, e.g. the walkthrough title. */
	readonly context?: string;
}

export interface ElaborateRequest {
	readonly requestId: string;
	readonly walkthroughId: string;
	readonly sceneId: string;
	/** A question the developer asked from the scene's card; without one, the scene is re-explained in more depth. */
	readonly question?: string;
}

/**
 * Events from the extension. Per-agent events carry `agentId` (absent: the main agent). The agent list itself is
 * the `agents` event.
 */
export type ActiveEvent = (
	| { readonly type: 'agent'; readonly agent: AgentState }
	| { readonly type: 'agents'; readonly agents: ReadonlyArray<AgentInfo>; readonly overlaps: ReadonlyArray<AgentOverlap> }
	| { readonly type: 'chat'; readonly entry: ChatEntry }
	| { readonly type: 'turnChanges'; readonly turnId: string; readonly files: ReadonlyArray<FileChangeStat> }
	| { readonly type: 'walkthroughStatus'; readonly status: WalkthroughStatus }
	| { readonly type: 'walkthroughReady'; readonly walkthrough: Walkthrough }
	| { readonly type: 'history'; readonly history: ReadonlyArray<TurnSummary> }
	| ({ readonly type: 'narration' } & NarrationStatus)
	| { readonly type: 'checkUpdate'; readonly walkthroughId: string; readonly check: PendingCheck }
	| { readonly type: 'elaboration'; readonly requestId: string; readonly text: string; readonly status: 'streaming' | 'done' | 'error' }
	| { readonly type: 'profile'; readonly profile: KnowledgeProfile }
	| { readonly type: 'models'; readonly models: ReadonlyArray<AgentModelInfo> }
	| { readonly type: 'memory'; readonly notes: ReadonlyArray<MemoryNote> }
	| { readonly type: 'diagram'; readonly state: DiagramState }
	| { readonly type: 'trace'; readonly trace: CodeTrace }
	/** The whole transcript changed (a session was resumed or a new one started). */
	| { readonly type: 'chatReset'; readonly chat: ReadonlyArray<ChatEntry> }
) & { readonly agentId?: string };

/** Command ids the extension registers. */
export const enum ExtensionCommand {
	Init = 'active.ext.init',
	SubmitTask = 'active.ext.submitTask',
	Ask = 'active.ext.ask',
	DecideApproval = 'active.ext.decideApproval',
	Synthesize = 'active.ext.synthesize',
	HistoryGet = 'active.ext.historyGet',
	HistoryDelete = 'active.ext.historyDelete',
	ProfileSet = 'active.ext.profileSet',
	SetupInstall = 'active.ext.setupInstall',
	SetupChooseMethod = 'active.ext.setupChooseMethod',
	SetupSignIn = 'active.ext.setupSignIn',
	SetupSaveApiKey = 'active.ext.setupSaveApiKey',
	SetupCancel = 'active.ext.setupCancel',
	SetupRestart = 'active.ext.setupRestart',
	Reconnect = 'active.ext.reconnect',
	Elaborate = 'active.ext.elaborate',
	NewSession = 'active.ext.newSession',
	ResumeSession = 'active.ext.resumeSession',
	Brief = 'active.ext.brief',
	/** Uncommitted changes as git sees them, per file (`undefined` outside a git repository). */
	GitChanges = 'active.ext.gitChanges',
	/** A file as it was before the agent's last prompt that changed it: `{baseline}` (`null` if new), or `undefined`. */
	AgentBaseline = 'active.ext.agentBaseline',
	MemoryGet = 'active.ext.memoryGet',
	/** Forgets one note (by id), or all of them when called without one. */
	MemoryDelete = 'active.ext.memoryDelete',
	/** Builds the system map (the first time, or again from scratch). */
	DiagramBuild = 'active.ext.diagramBuild',
	/** Asks the diagram agent to look for changes now. */
	DiagramUpdate = 'active.ext.diagramUpdate',
	/** One saved version of the system map: `SystemMapRevision`, or `undefined`. */
	DiagramRevision = 'active.ext.diagramRevision',
	/** Records this folder's choice (`DiagramFolderMode`); `auto` and `manual` build the map if there isn't one. */
	DiagramSetFolderMode = 'active.ext.diagramSetFolderMode',
	/** The developer described a change to the system map (a string); the diagram agent makes it and replies in chat. */
	DiagramEdit = 'active.ext.diagramEdit',
	/** The developer edited text on the map themselves (`SystemMapTextEdit`); saved as a new version, no model involved. */
	DiagramReviseText = 'active.ext.diagramReviseText',
	/** Traces how a behavior flows through the code (`TraceRequest`); resolves with the trace id at once and reports progress as `trace` events. */
	TraceBuild = 'active.ext.traceBuild',
	/** A saved trace by id: `CodeTrace`, or `undefined`. */
	TraceGet = 'active.ext.traceGet',
	/** Past traces, newest first: `TraceSummary[]`. */
	TraceList = 'active.ext.traceList',
	/** Forgets a saved trace (its id). */
	TraceDelete = 'active.ext.traceDelete',
	/** The agent the developer has highlighted (its id): requests without an agent go to it. */
	AgentFocus = 'active.ext.agentFocus',
	/** Starts another top-level agent in its own worktree (`NewAgentRequest`); resolves with its id, or an error message. */
	AgentNew = 'active.ext.agentNew',
	/** Merges one agent's work into another (`MergeAgentsRequest`): `MergeAgentsResult`. */
	AgentMerge = 'active.ext.agentMerge',
	/** Stops an agent and removes its worktree (its id). Its history stays. */
	AgentClose = 'active.ext.agentClose',
	AgentRename = 'active.ext.agentRename',
	/** One agent's explanation mode: `{ agentId, mode }`. */
	AgentSetMode = 'active.ext.agentSetMode',
	/** One agent's approval mode: `{ agentId, mode: AgentApprovalMode }`. */
	AgentSetApprovalMode = 'active.ext.agentSetApprovalMode',
	/** Interrupts an agent's running turn (its id). */
	AgentInterrupt = 'active.ext.agentInterrupt',
	/** All agents' state (`AgentInitialState[]`), e.g. after the agent list changes. */
	AgentStates = 'active.ext.agentStates',
	/** Dictation (`TranscribeRequest`): `TranscribeResult`. Always runs in this window, with this developer's own Muse. */
	Transcribe = 'active.ext.transcribe',
}

/** Command id the workbench registers for extension → workbench events. */
export const WORKBENCH_EVENT_COMMAND = '_active.workbench.event';

/** What happened while the developer was away, condensed for their return. */
export interface Briefing {
	readonly headline: string;
	/** Meaningful outcomes. */
	readonly done: readonly string[];
	/** Decisions or questions that need the developer. */
	readonly attention: readonly string[];
	/** Unresolved problems: failing checks, errors, unfinished work. */
	readonly problems: readonly string[];
	/** Where to pick up. */
	readonly next: string;
	/** Set when the explanation model couldn't write it and this is the plain fallback. */
	readonly fallback?: boolean;
	/** An all-agents briefing: the same, per agent (the lists above then hold what spans agents, e.g. overlaps). */
	readonly agents?: ReadonlyArray<{ readonly agentId: string; readonly name: string; readonly headline: string; readonly done: readonly string[]; readonly attention: readonly string[]; readonly problems: readonly string[] }>;
}

export interface BriefingRequest {
	/** Cover turns that ended (and chapters made) at or after this time. */
	readonly since: number;
	/** Brief on one agent only (default: the highlighted one), or on every agent, grouped. */
	readonly agentId?: string;
	readonly allAgents?: boolean;
	/** Very short: for opening an agent the developer hasn't looked at for a while. */
	readonly short?: boolean;
}

export interface AskRequest {
	readonly question: string;
	readonly walkthroughId?: string;
	readonly sceneId?: string;
	readonly segment?: number;
	/** Asked from the system map about these boxes and arrows. */
	readonly map?: MapSelection;
	/** Asked about code selected in the editor. */
	readonly code?: CodeSelection;
}

/** Lines of a file the developer picked (selected in the editor, or shown by an explanation card). */
export interface CodeSelection {
	/** Workspace-relative path (absolute when the file is outside the workspace). */
	readonly file: string;
	readonly startLine: number;
	readonly endLine: number;
	/** The selected text, when it was a selection (capped). */
	readonly text?: string;
}

/** How chat names a code selection: "client.js loc 3–8". */
export function describeCodeSelection(code: CodeSelection): string {
	const name = code.file.split(/[\\/]/).pop() || code.file;
	return code.startLine === code.endLine ? `${name} loc ${code.startLine}` : `${name} loc ${code.startLine}–${code.endLine}`;
}

/** A coding task, optionally about code the developer pointed at (with the explanation they were reading). */
export interface TaskRequest {
	readonly text: string;
	readonly code?: CodeSelection;
	/** The explanation card the change was requested from: its title and what it said. */
	readonly explanation?: { readonly title: string; readonly text: string };
	/** Multiplayer: a guest sent it (shown with their name). */
	readonly author?: SessionAuthor;
}

/** Boxes and arrows picked on the system map (at least one). */
export interface MapSelection {
	readonly components: readonly string[];
	readonly connections: ReadonlyArray<{ readonly from: string; readonly to: string }>;
	/** The map version they were picked from. */
	readonly version?: number;
}

export interface SynthesizeResult {
	/** Base64 WAV (24 kHz mono). Never persisted. */
	readonly wav?: string;
	readonly error?: string;
}

export interface TranscribeRequest {
	/** Base64 WAV (16 kHz mono PCM16). Never persisted. */
	readonly wav: string;
	/** Tidy the transcript with a cheap model; absent: the raw transcript. */
	readonly cleanup?: DictationCleanupRequest;
}

export interface DictationCleanupRequest {
	readonly model?: string;
	/** Names the developer may say: open files, recently changed files, identifiers on screen (only those the transcript seems to mention are sent). */
	readonly vocabulary: readonly string[];
	/** The developer's own dictionary (always sent). */
	readonly dictionary: readonly string[];
	/** The text just before the cursor, for continuing a sentence. */
	readonly before?: string;
}

/** `signedOut`: Muse has no credentials; `empty`: no words were heard; `unavailable`: Muse isn't installed. */
export type TranscribeErrorKind = 'signedOut' | 'empty' | 'unavailable' | 'failed';

export interface TranscribeResult {
	readonly text?: string;
	/** What was heard, before cleanup. */
	readonly raw?: string;
	/** Whether `text` is the cleaned-up version (false: cleanup was off, failed or too slow). */
	readonly cleaned?: boolean;
	readonly error?: string;
	readonly errorKind?: TranscribeErrorKind;
}

export interface HistoryDetail {
	readonly turn: TurnSummary;
	readonly chat: ReadonlyArray<ChatEntry>;
	readonly reasoningSummaries: ReadonlyArray<string>;
	readonly tools: ReadonlyArray<ToolOutcome>;
	readonly edits: ReadonlyArray<{ readonly seq: number; readonly path: string; readonly source: 'agent' | 'user'; readonly added: number; readonly removed: number; readonly at: number }>;
	readonly walkthrough?: Walkthrough;
	/** Every file the turn changed, as captured (including turns without a walkthrough). */
	readonly files: ReadonlyArray<CapturedFile>;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

const SCENE_ROLES: ReadonlyArray<SceneRole> = ['problem', 'intuition', 'model', 'implementation', 'behavior', 'evidence', 'tradeoff', 'summary'];

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isString(value: unknown, max = 4000): value is string {
	return typeof value === 'string' && value.trim().length > 0 && value.length <= max;
}

function lineCount(text: string): number {
	return text.length === 0 ? 1 : text.split('\n').length;
}

function readRange(value: unknown, path: string, maxLine: number, errors: string[]): LineRange | undefined {
	if (!isObject(value) || typeof value.startLine !== 'number' || typeof value.endLine !== 'number') {
		errors.push(`${path}: expected {startLine, endLine}`);
		return undefined;
	}
	const startLine = Math.floor(value.startLine);
	const endLine = Math.floor(value.endLine);
	if (startLine < 1 || endLine < startLine || endLine > maxLine) {
		errors.push(`${path}: range ${startLine}-${endLine} is outside 1-${maxLine}`);
		return undefined;
	}
	return { startLine, endLine };
}

export interface WalkthroughDraft {
	readonly title: string;
	readonly summary: string;
	readonly terms: ReadonlyArray<Term>;
	readonly scenes: ReadonlyArray<Scene>;
}

export interface ValidationResult {
	readonly draft?: WalkthroughDraft;
	readonly errors: ReadonlyArray<string>;
	/** Scenes dropped because they referenced code that is no longer part of the turn. */
	readonly dropped: ReadonlyArray<string>;
}

/** Finds tool-outcome ids or similar internal names in user-facing text. */
function internalReference(text: string, evidenceIds: ReadonlySet<string>): string | undefined {
	const phrase = /\btool outcomes?\b/i.exec(text);
	if (phrase) {
		return phrase[0];
	}
	for (const id of evidenceIds) {
		for (const token of [id, id.split('-').pop() ?? '']) {
			if (token.length >= 4 && new RegExp(`(^|[^\\w-])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\w-])`).test(text)) {
				return token;
			}
		}
	}
	return undefined;
}

function versionText(file: CapturedFile, version: CapturedVersion): string | null {
	return version === 'baseline' ? file.baseline : file.final;
}

function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * Validates a model-produced walkthrough against the captured files and tool
 * outcomes. Structural problems are returned as errors (so the planner can ask
 * the model to repair them); scenes about files the turn no longer changes are
 * dropped (reverted or superseded work).
 */
export function validateWalkthrough(raw: unknown, files: Readonly<Record<string, CapturedFile>>, evidenceIds: ReadonlySet<string>): ValidationResult {
	const errors: string[] = [];
	const dropped: string[] = [];
	if (!isObject(raw)) {
		return { errors: ['walkthrough: expected a JSON object'], dropped };
	}
	if (!isString(raw.title, 200)) {
		errors.push('title: expected a short string');
	}
	if (!isString(raw.summary, 2000)) {
		errors.push('summary: expected a string');
	}
	const terms: Term[] = [];
	if (raw.terms !== undefined) {
		if (!Array.isArray(raw.terms)) {
			errors.push('terms: expected an array');
		} else {
			raw.terms.forEach((term, index) => {
				if (!isObject(term) || !isString(term.name, 120) || !isString(term.meaning, 600)) {
					errors.push(`terms[${index}]: expected {name, meaning}`);
					return;
				}
				terms.push({ name: term.name, meaning: term.meaning, codeSymbol: isString(term.codeSymbol, 200) ? term.codeSymbol : undefined });
			});
		}
	}
	if (!Array.isArray(raw.scenes) || raw.scenes.length === 0) {
		errors.push('scenes: expected a non-empty array');
		return { errors, dropped };
	}
	if (raw.scenes.length > 14) {
		errors.push('scenes: at most 14 scenes');
	}
	const scenes: Scene[] = [];
	const ids = new Set<string>();
	raw.scenes.forEach((value, index) => {
		const path = `scenes[${index}]`;
		const sceneErrors: string[] = [];
		if (!isObject(value)) {
			errors.push(`${path}: expected an object`);
			return;
		}
		const id = isString(value.id, 80) ? value.id : `scene-${index + 1}`;
		if (ids.has(id)) {
			sceneErrors.push(`${path}.id: duplicate id ${id}`);
		}
		ids.add(id);
		const role = SCENE_ROLES.includes(value.role as SceneRole) ? value.role as SceneRole : undefined;
		if (!role) {
			sceneErrors.push(`${path}.role: expected one of ${SCENE_ROLES.join(', ')}`);
		}
		if (!isString(value.label, 60)) {
			sceneErrors.push(`${path}.label: expected a short string`);
		}
		if (!isString(value.title, 160)) {
			sceneErrors.push(`${path}.title: expected a short string`);
		}
		const version: CapturedVersion = value.version === 'baseline' ? 'baseline' : 'final';
		const fileName = typeof value.file === 'string' ? value.file : '';
		const file = files[fileName];
		if (!file) {
			sceneErrors.push(`${path}.file: "${fileName}" is not one of the captured files (${Object.keys(files).join(', ')})`);
			errors.push(...sceneErrors);
			return;
		}
		const text = versionText(file, version);
		if (text === null) {
			if (file.final === null && file.baseline === null) {
				dropped.push(id);
				return;
			}
			sceneErrors.push(`${path}.version: ${fileName} has no ${version} version`);
			errors.push(...sceneErrors);
			return;
		}
		if (file.added === 0 && file.removed === 0 && role === 'implementation') {
			// The turn ended with no net change to this file: the work was reverted.
			dropped.push(id);
			return;
		}
		const maxLine = lineCount(text);
		const focus: LineRange[] = [];
		if (!Array.isArray(value.focus)) {
			sceneErrors.push(`${path}.focus: expected an array of ranges`);
		} else {
			value.focus.forEach((range, rangeIndex) => {
				const parsed = readRange(range, `${path}.focus[${rangeIndex}]`, maxLine, sceneErrors);
				if (parsed) {
					focus.push(parsed);
				}
			});
		}
		const context = value.context === undefined ? undefined : readRange(value.context, `${path}.context`, maxLine, sceneErrors);
		let anchorLine = typeof value.anchorLine === 'number' ? Math.floor(value.anchorLine) : (focus.length ? focus[focus.length - 1].endLine : 1);
		if (anchorLine < 0 || anchorLine > maxLine) {
			anchorLine = Math.min(Math.max(anchorLine, 0), maxLine);
		}
		const narration: NarrationSegment[] = [];
		if (!Array.isArray(value.narration) || value.narration.length === 0) {
			sceneErrors.push(`${path}.narration: expected a non-empty array of {text, cue?}`);
		} else {
			value.narration.forEach((segment, segmentIndex) => {
				if (!isObject(segment) || !isString(segment.text, 1200)) {
					sceneErrors.push(`${path}.narration[${segmentIndex}]: expected {text}`);
					return;
				}
				let cue: Cue | undefined;
				if (isObject(segment.cue)) {
					const focusIndex = typeof segment.cue.focus === 'number' && segment.cue.focus >= 0 && segment.cue.focus < focus.length ? Math.floor(segment.cue.focus) : undefined;
					const nodes = Array.isArray(segment.cue.nodes) ? segment.cue.nodes.filter((node): node is string => typeof node === 'string') : undefined;
					const reveal = typeof segment.cue.reveal === 'number' && segment.cue.reveal >= 0 ? Math.floor(segment.cue.reveal) : undefined;
					cue = { focus: focusIndex, nodes, reveal };
				}
				narration.push({ text: segment.text.trim(), cue });
			});
		}
		const visual = value.visual === undefined || value.visual === null ? undefined : validateVisual(value.visual, `${path}.visual`, files, evidenceIds, sceneErrors);
		if (visual?.type === 'diagram') {
			for (const segment of narration) {
				const unknown = segment.cue?.nodes?.filter(node => !visual.nodes.some(candidate => candidate.id === node));
				if (unknown?.length) {
					sceneErrors.push(`${path}.narration cue references unknown diagram nodes: ${unknown.join(', ')}`);
				}
			}
		}
		let quote: string | undefined;
		if (isString(value.quote, 2000)) {
			if (!normalizeWhitespace(text).includes(normalizeWhitespace(value.quote))) {
				sceneErrors.push(`${path}.quote: the quoted code does not appear in ${fileName}@${version}`);
			} else {
				quote = value.quote;
			}
		}
		const leaked = internalReference([value.title, ...narration.map(segment => segment.text)].filter((text): text is string => typeof text === 'string').join(' '), evidenceIds);
		if (leaked) {
			sceneErrors.push(`${path}: the title or narration mentions "${leaked}", an internal reference the user never sees; describe the evidence in plain words`);
		}
		const pending = Array.isArray(value.pending) ? value.pending.filter((item): item is string => isString(item, 300)) : undefined;
		if (sceneErrors.length) {
			errors.push(...sceneErrors);
			return;
		}
		scenes.push({
			id,
			role: role!,
			label: value.label as string,
			title: value.title as string,
			file: fileName,
			version,
			focus,
			context,
			anchorLine,
			symbol: isString(value.symbol, 200) ? value.symbol : undefined,
			visual,
			narration,
			quote,
			pending,
		});
	});
	if (errors.length) {
		return { errors, dropped };
	}
	if (scenes.length === 0) {
		return { errors: [], dropped };
	}
	return { draft: { title: raw.title as string, summary: raw.summary as string, terms, scenes }, errors, dropped };
}

function validateVisual(value: unknown, path: string, files: Readonly<Record<string, CapturedFile>>, evidenceIds: ReadonlySet<string>, errors: string[]): SceneVisual | undefined {
	if (!isObject(value)) {
		errors.push(`${path}: expected an object`);
		return undefined;
	}
	const caption = isString(value.caption, 600) ? value.caption : undefined;
	switch (value.type) {
		case 'code':
		case 'diff': {
			const fileName = typeof value.file === 'string' ? value.file : '';
			const file = files[fileName];
			if (!file) {
				errors.push(`${path}.file: "${fileName}" is not a captured file`);
				return undefined;
			}
			const version: CapturedVersion = value.type === 'diff' ? 'final' : value.version === 'baseline' ? 'baseline' : 'final';
			const text = versionText(file, version) ?? (value.type === 'diff' ? file.baseline : null);
			if (text === null) {
				errors.push(`${path}: ${fileName} has no ${version} version`);
				return undefined;
			}
			const range = readRange(value.range, `${path}.range`, lineCount(text), errors);
			if (!range) {
				return undefined;
			}
			return value.type === 'code' ? { type: 'code', file: fileName, version, range, caption } : { type: 'diff', file: fileName, range, caption };
		}
		case 'equation': {
			if (!isString(value.latex, 1000)) {
				errors.push(`${path}.latex: expected LaTeX`);
				return undefined;
			}
			const legend = Array.isArray(value.legend) ? value.legend.filter(isObject).filter(item => isString(item.symbol, 80) && isString(item.term, 200)).map(item => ({ symbol: item.symbol as string, term: item.term as string })) : undefined;
			return { type: 'equation', latex: value.latex, legend, caption };
		}
		case 'diagram': {
			if (!Array.isArray(value.nodes) || value.nodes.length === 0 || value.nodes.length > 16) {
				errors.push(`${path}.nodes: expected 1-16 nodes`);
				return undefined;
			}
			const nodes: DiagramNode[] = [];
			for (const node of value.nodes) {
				if (!isObject(node) || !isString(node.id, 60) || !isString(node.label, 80)) {
					errors.push(`${path}.nodes: each node needs {id, label}`);
					return undefined;
				}
				nodes.push({ id: node.id, label: node.label, detail: isString(node.detail, 160) ? node.detail : undefined, column: typeof node.column === 'number' ? Math.max(0, Math.floor(node.column)) : undefined });
			}
			const edges: DiagramEdge[] = [];
			for (const edge of Array.isArray(value.edges) ? value.edges : []) {
				if (!isObject(edge) || !nodes.some(node => node.id === edge.from) || !nodes.some(node => node.id === edge.to)) {
					errors.push(`${path}.edges: each edge needs {from, to} naming existing nodes`);
					return undefined;
				}
				edges.push({ from: edge.from as string, to: edge.to as string, label: isString(edge.label, 60) ? edge.label : undefined });
			}
			return { type: 'diagram', nodes, edges, illustrative: value.illustrative !== false, caption };
		}
		case 'chart': {
			const chart = value.chart === 'line' ? 'line' : 'bar';
			if (!Array.isArray(value.series) || value.series.length === 0) {
				errors.push(`${path}.series: expected at least one series`);
				return undefined;
			}
			const series = [];
			for (const item of value.series) {
				if (!isObject(item) || !isString(item.name, 80) || !Array.isArray(item.points) || item.points.length === 0 || item.points.length > 40) {
					errors.push(`${path}.series: each series needs {name, points: [{x, y}]} with 1-40 points`);
					return undefined;
				}
				const points = [];
				for (const point of item.points) {
					if (!isObject(point) || (typeof point.x !== 'string' && typeof point.x !== 'number') || typeof point.y !== 'number' || !Number.isFinite(point.y)) {
						errors.push(`${path}.series: points need a string/number x and a finite numeric y`);
						return undefined;
					}
					points.push({ x: point.x, y: point.y });
				}
				series.push({ name: item.name, points });
			}
			let source: 'observed' | 'illustrative' = value.source === 'observed' ? 'observed' : 'illustrative';
			const evidence = typeof value.evidence === 'string' ? value.evidence : undefined;
			if (source === 'observed' && (!evidence || !evidenceIds.has(evidence))) {
				// An observed chart must cite captured evidence; otherwise it is only an illustration.
				source = 'illustrative';
			}
			return {
				type: 'chart',
				chart,
				title: isString(value.title, 160) ? value.title : '',
				xLabel: isString(value.xLabel, 60) ? value.xLabel : '',
				yLabel: isString(value.yLabel, 60) ? value.yLabel : '',
				series,
				source,
				evidence: source === 'observed' ? evidence : undefined,
				caption,
			};
		}
		default:
			errors.push(`${path}.type: expected code, diff, equation, diagram or chart`);
			return undefined;
	}
}

/** Extracts the first JSON object from a model reply (fenced or bare). */
export function extractJsonObject(text: string): unknown {
	const fenced = /```(?:json)?\s*\n(?<body>[\s\S]*?)\n```/.exec(text);
	const candidates = fenced?.groups ? [fenced.groups.body, text] : [text];
	for (const candidate of candidates) {
		const start = candidate.indexOf('{');
		const end = candidate.lastIndexOf('}');
		if (start >= 0 && end > start) {
			try {
				return JSON.parse(candidate.slice(start, end + 1));
			} catch {
				// try the next candidate
			}
		}
	}
	return undefined;
}

// ------------------------------------------------------------------ system map

/** A file (or lines of one) that a component or connection lives in. */
export interface SystemFileRef {
	readonly path: string;
	readonly startLine?: number;
	readonly endLine?: number;
	/** What this file contributes, in a few words. */
	readonly why?: string;
}

/** One part of the system, as the diagram agent sees it. */
export interface SystemComponent {
	readonly id: string;
	readonly name: string;
	/** One line, shown in the box. */
	readonly summary: string;
	/** A short explanation, shown when the box is clicked. */
	readonly description: string;
	readonly files: ReadonlyArray<SystemFileRef>;
}

/** How two components relate (calls, data, events...). */
export interface SystemConnection {
	readonly from: string;
	readonly to: string;
	readonly label: string;
	readonly detail?: string;
	/** Where in the code the connection is made. */
	readonly evidence: ReadonlyArray<SystemFileRef>;
}

export interface SystemMap {
	/** A sentence or two on what the system is. */
	readonly overview: string;
	readonly components: ReadonlyArray<SystemComponent>;
	readonly connections: ReadonlyArray<SystemConnection>;
}

/** A saved version of the map and why it changed. */
export interface SystemMapRevision {
	readonly version: number;
	readonly at: number;
	readonly turnId?: string;
	readonly turnIndex?: number;
	/** What changed, in a sentence (the first version says it was built). */
	readonly reason: string;
	/** Components added or changed by this version. */
	readonly changed: readonly string[];
	readonly map: SystemMap;
	/** The developer's description, when this version is a change they asked for. */
	readonly request?: string;
	/** The developer edited the map's text themselves. */
	readonly manual?: boolean;
}

/** Names, summaries, descriptions and labels the developer typed on the map. Absent fields stay as they are. */
export interface SystemMapTextEdit {
	readonly components?: ReadonlyArray<{ readonly id: string; readonly name?: string; readonly summary?: string; readonly description?: string }>;
	readonly connections?: ReadonlyArray<{ readonly from: string; readonly to: string; readonly label?: string; readonly detail?: string }>;
}

export type DiagramStatus = 'off' | 'empty' | 'building' | 'updating' | 'ready' | 'failed';

/** This folder's choice: build the map and keep it updated, build it and update only on request, or no map. */
export type DiagramFolderMode = 'auto' | 'manual' | 'off';

export interface DiagramState {
	readonly status: DiagramStatus;
	readonly detail?: string;
	readonly current?: SystemMapRevision;
	/** Every saved version, newest first (without the maps). */
	readonly history: ReadonlyArray<Omit<SystemMapRevision, 'map'>>;
	/** Components whose files the latest turn changed (found from the files alone, no model involved). */
	readonly touched: readonly string[];
	readonly touchedTurnIndex?: number;
	/** `undefined` until the developer has been asked in this folder. */
	readonly folderMode?: DiagramFolderMode;
}

/**
 * Checks a system map from the diagram agent: ids are unique and well formed, connections join components
 * that exist, every component cites at least one file. `fileExists` checks cited paths. Errors explain each
 * problem so the agent can repair its answer; usable parts are kept.
 */
export function parseSystemMap(value: unknown, fileExists: (path: string) => boolean, errors: string[]): SystemMap | undefined {
	const input = value as { overview?: unknown; components?: unknown; connections?: unknown } | undefined;
	if (!input || typeof input !== 'object' || !Array.isArray(input.components)) {
		errors.push('expected {"overview", "components": [...], "connections": [...]}');
		return undefined;
	}
	const refs = (raw: unknown, path: string): SystemFileRef[] => {
		if (!Array.isArray(raw)) {
			return [];
		}
		return raw.flatMap((entry, index) => {
			const item = (typeof entry === 'string' ? { path: entry } : entry) as { path?: unknown; startLine?: unknown; endLine?: unknown; why?: unknown };
			const file = typeof item?.path === 'string' ? item.path.replace(/^\.\//, '').trim() : '';
			if (!file) {
				errors.push(`${path}[${index}].path: expected a workspace-relative file path`);
				return [];
			}
			if (!fileExists(file)) {
				errors.push(`${path}[${index}].path: ${file} doesn't exist`);
				return [];
			}
			const start = typeof item.startLine === 'number' && item.startLine >= 1 ? Math.floor(item.startLine) : undefined;
			const end = typeof item.endLine === 'number' && start !== undefined && item.endLine >= start ? Math.floor(item.endLine) : start;
			return [{ path: file, ...(start !== undefined ? { startLine: start, endLine: end } : {}), ...(isString(item.why, 160) && item.why.trim() ? { why: item.why.trim() } : {}) }];
		});
	};
	const components: SystemComponent[] = [];
	const ids = new Set<string>();
	input.components.forEach((entry, index) => {
		const item = entry as { id?: unknown; name?: unknown; summary?: unknown; description?: unknown; files?: unknown };
		const path = `components[${index}]`;
		const id = typeof item?.id === 'string' ? item.id.trim() : '';
		if (!/^[a-z0-9][a-z0-9-_.]{0,60}$/i.test(id)) {
			errors.push(`${path}.id: expected a short id (letters, digits, - _ .)`);
			return;
		}
		if (ids.has(id)) {
			errors.push(`${path}.id: ${id} is used twice`);
			return;
		}
		if (!isString(item.name, 80) || !item.name.trim()) {
			errors.push(`${path}.name: expected a short name`);
			return;
		}
		const files = refs(item.files, `${path}.files`);
		if (!files.length) {
			errors.push(`${path}.files: cite at least one existing file`);
			return;
		}
		ids.add(id);
		components.push({
			id,
			name: item.name.trim(),
			summary: isString(item.summary, 200) ? item.summary.trim() : '',
			description: isString(item.description, 2000) ? item.description.trim() : '',
			files,
		});
	});
	const connections: SystemConnection[] = [];
	(Array.isArray(input.connections) ? input.connections : []).forEach((entry, index) => {
		const item = entry as { from?: unknown; to?: unknown; label?: unknown; detail?: unknown; evidence?: unknown };
		const path = `connections[${index}]`;
		if (typeof item?.from !== 'string' || !ids.has(item.from) || typeof item.to !== 'string' || !ids.has(item.to)) {
			errors.push(`${path}: from and to must be ids of components in the map`);
			return;
		}
		if (item.from === item.to) {
			errors.push(`${path}: a connection joins two different components`);
			return;
		}
		if (connections.some(connection => connection.from === item.from && connection.to === item.to)) {
			errors.push(`${path}: ${item.from} → ${item.to} is listed twice (merge them)`);
			return;
		}
		connections.push({
			from: item.from,
			to: item.to,
			label: isString(item.label, 60) ? item.label.trim() : '',
			...(isString(item.detail, 600) && item.detail.trim() ? { detail: item.detail.trim() } : {}),
			evidence: refs(item.evidence, `${path}.evidence`),
		});
	});
	if (!components.length) {
		errors.push('the map has no usable components');
		return undefined;
	}
	return { overview: isString(input.overview, 600) ? input.overview.trim() : '', components, connections };
}

// ---------------------------------------------------------------------------
// Code traces
// ---------------------------------------------------------------------------

/** How one step of a trace leads to the next. */
export type TraceHopKind = 'call' | 'await' | 'return' | 'callback' | 'event' | 'state' | 'throw' | 'other';
export const TRACE_HOP_KINDS: readonly TraceHopKind[] = ['call', 'await', 'return', 'callback', 'event', 'state', 'throw', 'other'];

export interface TraceStep {
	readonly id: string;
	/** Workspace-relative path. */
	readonly file: string;
	readonly startLine: number;
	readonly endLine: number;
	/** The function or method it's in, e.g. "ApiClient.request". */
	readonly symbol?: string;
	/** One sentence: what happens here. */
	readonly summary: string;
	readonly detail?: string;
	/** How this step leads to the next one (absent on the last). */
	readonly hop?: { readonly kind: TraceHopKind; readonly label: string };
	/** Where a logpoint goes to observe this step, and the values it prints. */
	readonly probe?: { readonly line: number; readonly values: readonly string[] };
	/** The step runs repeatedly on this path, e.g. "once per retry" or "for each listener". */
	readonly repeats?: string;
	/** The step is on one path of a fork (`forks`), not the main line. */
	readonly branch?: { readonly fork: string; readonly path: number };
}

/**
 * Where the path divides. `either`: one of the paths runs, depending on a condition (if/else, switch, try/catch,
 * an early return). `all`: every path runs (several listeners for one event, Promise.all, fan-out). A fork's steps
 * sit together in `steps`, path by path, right after the step before the fork; the main line continues after them.
 */
export interface TraceFork {
	readonly id: string;
	readonly kind: 'either' | 'all';
	/** What decides it, or what fans out, e.g. "on the response status" or "the 'saved' event's listeners". */
	readonly label: string;
	readonly paths: ReadonlyArray<{
		readonly label: string;
		/** The flow ends on this path instead of continuing after the fork, e.g. "throws to the caller". */
		readonly ends?: string;
	}>;
}

/** How a step fared in the run: ran, its line never ran, on a fork path that wasn't taken, or not observed. */
export type TraceStepState = 'observed' | 'notReached' | 'notTaken' | 'inferred';

/**
 * Each step's state from the observation. On an `either` fork, when some path ran, the steps of the paths that
 * didn't run weren't taken (that's expected, not a miss).
 */
export function traceStepStates(trace: Pick<CodeTrace, 'steps' | 'forks' | 'observation'>): Record<string, TraceStepState> {
	const seen = trace.observation?.outcome !== 'failed' ? trace.observation?.steps : undefined;
	const states: Record<string, TraceStepState> = {};
	for (const step of trace.steps) {
		const observed = seen?.[step.id];
		states[step.id] = !observed ? 'inferred' : observed.hits > 0 ? 'observed' : 'notReached';
	}
	for (const fork of trace.forks ?? []) {
		if (fork.kind !== 'either') {
			continue;
		}
		const pathRan = fork.paths.map((_, index) => trace.steps.some(step => step.branch?.fork === fork.id && step.branch.path === index && states[step.id] === 'observed'));
		if (pathRan.some(Boolean)) {
			for (const step of trace.steps) {
				if (step.branch?.fork === fork.id && !pathRan[step.branch.path] && states[step.id] === 'notReached') {
					states[step.id] = 'notTaken';
				}
			}
		}
	}
	return states;
}

/** The code of a step as it was when the trace was made (`lines[0]` is line `firstLine`). */
export interface TraceSnippet {
	readonly firstLine: number;
	readonly lines: readonly string[];
	readonly languageId?: string;
}

/** What running the code showed about one step. */
export interface TraceStepObservation {
	readonly hits: number;
	/** Position of its first hit among all steps' first hits (0 = ran first), when it ran. */
	readonly order?: number;
	/** What its logpoint printed, first few hits. */
	readonly values: readonly string[];
}

export interface TraceObservation {
	/** What was run: a test command, or a driver script the explainer wrote (shown in full). */
	readonly command: string;
	readonly script?: string;
	readonly why?: string;
	readonly ranAt: number;
	readonly outcome: 'ran' | 'timedOut' | 'failed';
	/** Why it couldn't run (`failed`). */
	readonly error?: string;
	readonly steps: Readonly<Record<string, TraceStepObservation>>;
	/** The steps that ran, in the order they first ran, differ from the order the trace shows. */
	readonly orderDiffers: boolean;
	readonly output: readonly string[];
}

export type TraceStatus = 'tracing' | 'observing' | 'ready' | 'failed';

export interface CodeTrace {
	readonly id: string;
	readonly question: string;
	readonly createdAt: number;
	readonly status: TraceStatus;
	/** What's happening, or why it failed. */
	readonly detail?: string;
	readonly title: string;
	readonly overview: string;
	readonly steps: readonly TraceStep[];
	/** Where the path divides (absent: it's one line). */
	readonly forks?: readonly TraceFork[];
	readonly snippets: Readonly<Record<string, TraceSnippet>>;
	readonly observation?: TraceObservation;
	/** The agent whose folder it follows (its steps' paths are relative to that folder). Absent: the main agent. */
	readonly agentId?: string;
}

/** A past trace in the history list. */
export interface TraceSummary {
	readonly id: string;
	readonly question: string;
	readonly title: string;
	readonly createdAt: number;
	readonly status: TraceStatus;
	/** For a ready trace: whether running it confirmed the path (`observed`), or it's from the source alone. */
	readonly evidence?: 'observed' | 'inferred';
	readonly agentId?: string;
}

export function summarizeTrace(trace: CodeTrace): TraceSummary {
	const observed = trace.observation && trace.observation.outcome !== 'failed';
	return { id: trace.id, question: trace.question, title: trace.title, createdAt: trace.createdAt, status: trace.status, ...(trace.status === 'ready' ? { evidence: observed ? 'observed' as const : 'inferred' as const } : {}), ...(trace.agentId ? { agentId: trace.agentId } : {}) };
}

export interface TraceRequest {
	readonly question: string;
	/** A command to observe it with (otherwise the explainer suggests one, or writes a driver script). */
	readonly command?: string;
	/** Don't run anything: the trace stays inferred from the source. */
	readonly noRun?: boolean;
}

/** How the explainer proposes running the path: an existing test (`command`) or a small driver script. */
export interface TraceRunPlan {
	readonly command?: string;
	readonly script?: string;
	/** The driver script's language (JavaScript when not given). */
	readonly language?: 'javascript' | 'python';
	readonly why?: string;
}

const TRACE_MAX_STEPS = 24;
const TRACE_MAX_FORK_PATHS = 4;
const TRACE_MAX_PATH_STEPS = 6;

/**
 * Checks a trace from the explainer: steps cite files that exist, with real line ranges (at most 40 lines);
 * probes sit inside their step and only read values; forks have 2 to 4 paths of up to 6 steps, one level deep.
 * `lineCount` gives a file's length (`undefined`: missing). Bad steps are dropped with an error each; probes that
 * don't fit are dropped silently.
 */
export function parseCodeTrace(value: unknown, lineCount: (path: string) => number | undefined, errors: string[]): { title: string; overview: string; steps: TraceStep[]; forks: TraceFork[]; run?: TraceRunPlan } | undefined {
	if (!isObject(value)) {
		errors.push('the reply is not a JSON object');
		return undefined;
	}
	const steps: TraceStep[] = [];
	const forks: TraceFork[] = [];
	const parseStep = (entry: unknown, where: string, branch?: TraceStep['branch']): TraceStep | undefined => {
		if (!isObject(entry)) {
			errors.push(`${where} is not an object`);
			return undefined;
		}
		const file = isString(entry.file, 400) ? entry.file.trim().replace(/^\.\//, '') : '';
		const lines = file ? lineCount(file) : undefined;
		if (lines === undefined) {
			errors.push(`${where}.file: ${file || '(missing)'} doesn't exist`);
			return undefined;
		}
		const start = typeof entry.startLine === 'number' ? Math.floor(entry.startLine) : NaN;
		const end = typeof entry.endLine === 'number' ? Math.floor(entry.endLine) : start;
		if (!(start >= 1 && end >= start && end <= lines)) {
			errors.push(`${where}: lines ${entry.startLine}-${entry.endLine} aren't in ${file} (it has ${lines} lines)`);
			return undefined;
		}
		if (end - start > 40) {
			errors.push(`${where}: ${end - start + 1} lines is too long for one step (at most 40)`);
			return undefined;
		}
		if (!isString(entry.summary, 400) || !entry.summary.trim()) {
			errors.push(`${where}.summary is missing`);
			return undefined;
		}
		const hop = isObject(entry.hop) && TRACE_HOP_KINDS.includes(entry.hop.kind as TraceHopKind)
			? { kind: entry.hop.kind as TraceHopKind, label: isString(entry.hop.label, 120) ? entry.hop.label.trim() : '' }
			: undefined;
		let probe: TraceStep['probe'];
		if (isObject(entry.probe) && typeof entry.probe.line === 'number') {
			const line = Math.floor(entry.probe.line);
			// Values are read when the logpoint fires: plain reads only, nothing that calls code.
			const values = (Array.isArray(entry.probe.values) ? entry.probe.values : [])
				.filter((expression): expression is string => typeof expression === 'string' && !!expression.trim() && expression.length <= 80 && !/[()=;`{}]|\+\+|--/.test(expression))
				.slice(0, 4);
			if (line >= start && line <= end) {
				probe = { line, values };
			}
		}
		return {
			id: `s${steps.length + 1}`,
			file,
			startLine: start,
			endLine: end,
			...(isString(entry.symbol, 120) && entry.symbol.trim() ? { symbol: entry.symbol.trim() } : {}),
			summary: entry.summary.trim(),
			...(isString(entry.detail, 800) && entry.detail.trim() ? { detail: entry.detail.trim() } : {}),
			...(hop ? { hop } : {}),
			...(probe ? { probe } : {}),
			...(isString(entry.repeats, 80) && entry.repeats.trim() ? { repeats: entry.repeats.trim() } : {}),
			...(branch ? { branch } : {}),
		};
	};
	const withoutHop = (step: TraceStep): TraceStep => {
		const { hop: _hop, ...rest } = step;
		return rest;
	};
	const raw = Array.isArray(value.steps) ? value.steps : [];
	raw.forEach((entry, index) => {
		if (steps.length >= TRACE_MAX_STEPS) {
			return;
		}
		if (!isObject(entry) || !isObject(entry.fork)) {
			const step = parseStep(entry, `steps[${index}]`);
			if (step) {
				steps.push(step);
			}
			return;
		}
		const fork = entry.fork;
		const where = `steps[${index}].fork`;
		const kind = fork.kind === 'all' ? 'all' : fork.kind === 'either' ? 'either' : undefined;
		if (!kind) {
			errors.push(`${where}.kind must be "either" or "all"`);
			return;
		}
		const id = `f${forks.length + 1}`;
		const paths: Array<TraceFork['paths'][number]> = [];
		(Array.isArray(fork.paths) ? fork.paths : []).slice(0, TRACE_MAX_FORK_PATHS).forEach((rawPath, pathIndex) => {
			if (!isObject(rawPath) || !Array.isArray(rawPath.steps)) {
				errors.push(`${where}.paths[${pathIndex}] needs "steps"`);
				return;
			}
			if (isObject(rawPath.fork) || rawPath.steps.some(inner => isObject(inner) && isObject(inner.fork))) {
				errors.push(`${where}.paths[${pathIndex}]: forks can't be nested; follow one path further instead`);
			}
			const pathSteps: TraceStep[] = [];
			rawPath.steps.slice(0, TRACE_MAX_PATH_STEPS).forEach((inner, stepIndex) => {
				if (isObject(inner) && isObject(inner.fork) || steps.length + pathSteps.length >= TRACE_MAX_STEPS) {
					return;
				}
				const step = parseStep(inner, `${where}.paths[${pathIndex}].steps[${stepIndex}]`, { fork: id, path: paths.length });
				if (step) {
					pathSteps.push({ ...step, id: `s${steps.length + pathSteps.length + 1}` });
				}
			});
			if (!pathSteps.length) {
				return;
			}
			// A path's last step leads nowhere inside the path (the fork's end does the joining).
			pathSteps[pathSteps.length - 1] = withoutHop(pathSteps[pathSteps.length - 1]);
			steps.push(...pathSteps);
			paths.push({
				label: isString(rawPath.label, 120) && rawPath.label.trim() ? rawPath.label.trim() : `Path ${paths.length + 1}`,
				...(isString(rawPath.ends, 120) && rawPath.ends.trim() ? { ends: rawPath.ends.trim() } : {}),
			});
		});
		if (paths.length < 2) {
			errors.push(`${where} needs at least two paths with usable steps (otherwise make them plain steps)`);
			// Keep what was usable, as plain steps on the main line.
			for (let i = 0; i < steps.length; i++) {
				if (steps[i].branch?.fork === id) {
					const { branch: _branch, ...rest } = steps[i];
					steps[i] = rest;
				}
			}
			return;
		}
		forks.push({ id, kind, label: isString(fork.label, 160) ? fork.label.trim() : '', paths });
	});
	if (!steps.length) {
		errors.push('the trace has no usable steps');
		return undefined;
	}
	if (!steps[steps.length - 1].branch) {
		steps[steps.length - 1] = withoutHop(steps[steps.length - 1]);
	}
	const run: TraceRunPlan | undefined = isObject(value.run) ? {
		...(isString(value.run.command, 400) && value.run.command.trim() ? { command: value.run.command.trim() } : {}),
		...(isString(value.run.script, 6000) && value.run.script.trim() ? { script: value.run.script } : {}),
		...(value.run.language === 'python' || value.run.language === 'javascript' ? { language: value.run.language as 'python' | 'javascript' } : {}),
		...(isString(value.run.why, 300) && value.run.why.trim() ? { why: value.run.why.trim() } : {}),
	} : undefined;
	return {
		title: isString(value.title, 160) && value.title.trim() ? value.title.trim() : 'Code trace',
		overview: isString(value.overview, 800) ? value.overview.trim() : '',
		steps,
		forks,
		...(run && (run.command || run.script) ? { run } : {}),
	};
}
