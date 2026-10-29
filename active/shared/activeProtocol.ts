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
// Learning profile
// ---------------------------------------------------------------------------

export type Familiarity = 'new' | 'some' | 'comfortable' | 'expert';
export type ExplanationDepth = 'overview' | 'balanced' | 'deep';
export type MathComfort = 'avoid' | 'light' | 'comfortable';
export type VisualKind = 'code' | 'diff' | 'equation' | 'diagram' | 'chart';

export interface LearningProfile {
	readonly version: 1;
	readonly configured: boolean;
	readonly background: string;
	readonly yearsProgramming: number;
	readonly languages: ReadonlyArray<{ readonly name: string; readonly familiarity: Familiarity }>;
	readonly concepts: ReadonlyArray<ConceptKnowledge>;
	readonly wantToLearn: string;
	readonly glossOver: string;
	readonly depth: ExplanationDepth;
	/** Fine-tuning within `depth` learned from feedback: -1 (less detail) to 1 (more detail). */
	readonly detailBias: number;
	readonly math: MathComfort;
	readonly preferredVisuals: ReadonlyArray<VisualKind>;
	/** Narration playback rate, 0.75–1.75. */
	readonly narrationRate: number;
	readonly voice: string;
	readonly notes: string;
}

export interface ConceptKnowledge {
	readonly name: string;
	readonly familiarity: Familiarity;
	/** Continuous level behind `familiarity` (0 new … 3 expert), nudged by feedback. */
	readonly level?: number;
}

export const DEFAULT_PROFILE: LearningProfile = {
	version: 1,
	configured: false,
	background: '',
	yearsProgramming: 3,
	languages: [],
	concepts: [],
	wantToLearn: '',
	glossOver: '',
	depth: 'balanced',
	detailBias: 0,
	math: 'light',
	preferredVisuals: ['code', 'diff', 'diagram', 'equation', 'chart'],
	narrationRate: 1,
	voice: 'default',
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
 * explanation covered moves more (too much detail suggests the learner already
 * knows them better than assumed). Crossing a full step changes `depth`.
 */
export function applyDetailFeedback(profile: LearningProfile, feedback: DetailFeedback, topics: readonly string[]): LearningProfile {
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
	readonly choices: ReadonlyArray<{ readonly choiceId: string; readonly label: string; readonly approves: boolean }>;
	readonly resolved?: string;
}

export interface ChatEntry {
	readonly id: string;
	readonly turnId?: string;
	readonly role: 'user' | 'agent' | 'tool' | 'approval' | 'system' | 'explainer' | 'question';
	readonly text: string;
	readonly status?: string;
	readonly phase?: string;
	readonly approval?: ApprovalRequest;
	readonly at: number;
}

export type WalkthroughStage = 'idle' | 'collecting' | 'drafting' | 'waitingForBackground' | 'finalizing' | 'ready' | 'notExplained' | 'failed';

export interface WalkthroughStatus {
	readonly turnId: string;
	readonly stage: WalkthroughStage;
	readonly detail: string;
}

export interface FileChangeStat {
	readonly path: string;
	readonly added: number;
	readonly removed: number;
}

export interface TurnSummary {
	readonly sessionId: string;
	readonly turnId: string;
	readonly index: number;
	readonly task: string;
	readonly startedAt: number;
	readonly endedAt?: number;
	readonly outcome: string;
	readonly walkthroughId?: string;
	readonly walkthroughTitle?: string;
	readonly explanationNote: string;
	readonly files: ReadonlyArray<FileChangeStat>;
}

export interface InitialState {
	readonly agent: AgentState;
	readonly chat: ReadonlyArray<ChatEntry>;
	readonly profile: LearningProfile;
	readonly history: ReadonlyArray<TurnSummary>;
	readonly turnChanges: ReadonlyArray<FileChangeStat>;
	readonly narration: NarrationStatus;
	readonly pendingWalkthrough?: Walkthrough;
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
	/** Voices the narrator offers; `default` is the model's built-in voice. */
	readonly voices?: ReadonlyArray<VoiceInfo>;
}

export interface ElaborateRequest {
	readonly requestId: string;
	readonly walkthroughId: string;
	readonly sceneId: string;
}

export type ActiveEvent =
	| { readonly type: 'agent'; readonly agent: AgentState }
	| { readonly type: 'chat'; readonly entry: ChatEntry }
	| { readonly type: 'turnChanges'; readonly turnId: string; readonly files: ReadonlyArray<FileChangeStat> }
	| { readonly type: 'walkthroughStatus'; readonly status: WalkthroughStatus }
	| { readonly type: 'walkthroughReady'; readonly walkthrough: Walkthrough }
	| { readonly type: 'history'; readonly history: ReadonlyArray<TurnSummary> }
	| ({ readonly type: 'narration' } & NarrationStatus)
	| { readonly type: 'checkUpdate'; readonly walkthroughId: string; readonly check: PendingCheck }
	| { readonly type: 'elaboration'; readonly requestId: string; readonly text: string; readonly status: 'streaming' | 'done' | 'error' }
	| { readonly type: 'profile'; readonly profile: LearningProfile };

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
}

/** Command id the workbench registers for extension → workbench events. */
export const WORKBENCH_EVENT_COMMAND = '_active.workbench.event';

export interface AskRequest {
	readonly question: string;
	readonly walkthroughId?: string;
	readonly sceneId?: string;
	readonly segment?: number;
}

export interface SynthesizeResult {
	/** Base64 WAV (24 kHz mono). Never persisted. */
	readonly wav?: string;
	readonly error?: string;
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

/** Finds tool-outcome ids or similar internal names in learner-facing text. */
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
			sceneErrors.push(`${path}: the title or narration mentions "${leaked}", an internal reference the learner never sees; describe the evidence in plain words`);
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
