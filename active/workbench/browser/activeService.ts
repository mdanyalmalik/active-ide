/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { fromNow } from '../../../../base/common/date.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { effortDescription, effortLabel, updateModelChoices } from './activeSettings.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IQuickInputService, IQuickPickItem, IQuickPickSeparator } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { ViewContainerLocation } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IPaneCompositePartService } from '../../../services/panecomposite/browser/panecomposite.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IExplorerService } from '../../files/browser/files.js';
import { VIEWLET_ID as EXPLORER_VIEWLET_ID } from '../../files/common/files.js';
import { ActiveEvent, ActiveSetting, AgentModelInfo, AgentProviderInfo, AgentState, AskRequest, SignInMethod, ChatEntry, DEFAULT_PROFILE, DetailFeedback, ExtensionCommand, FileChangeStat, HistoryDetail, InitialState, KnowledgeProfile, NarrationStatus, PendingCheck, SynthesizeResult, TurnSummary, VoiceInfo, Walkthrough, WalkthroughStatus, REASONING_EFFORTS, applyDetailFeedback, applySkipSignal, sceneTopics } from '../common/activeProtocol.js';
import { ActiveChatInput, KnowledgeProfileInput, WalkthroughInput } from './activeInputs.js';
import { ClipPlayer } from './clipPlayer.js';
import { NarrationCache } from './narrationCache.js';
import { PlaybackPosition, WalkthroughPlayer } from './walkthroughPlayer.js';

export const ACTIVE_HISTORY_VIEW_ID = 'workbench.view.activeHistory';
export const ActiveWalkthroughFocus = new RawContextKey<boolean>('activeWalkthroughFocus', false, localize('activeWalkthroughFocus', "Whether the Active walkthrough editor has focus"));
export const ActiveWalkthroughAvailable = new RawContextKey<boolean>('activeWalkthroughAvailable', false, localize('activeWalkthroughAvailable', "Whether an Active walkthrough can be resumed"));

/** A deeper re-explanation of one scene, streamed from the explanation session. */
export interface Elaboration {
	readonly requestId: string;
	readonly walkthroughId: string;
	readonly sceneId: string;
	readonly text: string;
	readonly status: 'streaming' | 'done' | 'error';
}

const FEEDBACK_STORAGE_KEY = 'active.detailFeedback';

/** Where the user was in a walkthrough when they asked a question from it. */
export interface ChatContext {
	readonly walkthroughId: string;
	readonly sceneId: string;
	readonly sceneIndex: number;
	readonly segment: number;
	readonly title: string;
}

/** Shown until the agent services report which coding agent is configured. */
const DEFAULT_PROVIDER: AgentProviderInfo = { id: 'muse', name: 'Muse Code', shortName: 'Muse', devOnly: false };

export const IActiveService = createDecorator<IActiveService>('activeService');

export interface IActiveService {
	readonly _serviceBrand: undefined;

	readonly agent: AgentState;
	readonly chat: readonly ChatEntry[];
	readonly profile: KnowledgeProfile;
	readonly history: readonly TurnSummary[];
	readonly turnChanges: ReadonlyMap<string, FileChangeStat>;
	readonly narration: NarrationStatus;
	readonly walkthroughStatus: WalkthroughStatus | undefined;
	readonly player: WalkthroughPlayer | undefined;
	/** A finished walkthrough offered to the user (not yet shown because they had navigated elsewhere). */
	readonly offeredWalkthrough: Walkthrough | undefined;
	readonly chatContext: ChatContext | undefined;
	/** A finished walkthrough about to replace chat; chat shows a countdown and can start it or decline. */
	readonly pendingHandoff: Walkthrough | undefined;
	/** The folder is in Restricted Mode, so the agent services (which run code in it) are not started. */
	readonly needsTrust: boolean;

	readonly onDidChangeAgent: Event<void>;
	readonly onDidChangeChat: Event<ChatEntry | undefined>;
	readonly onDidChangeTurnChanges: Event<void>;
	readonly onDidChangeWalkthroughStatus: Event<void>;
	readonly onDidChangeHistory: Event<void>;
	readonly onDidChangeNarration: Event<void>;
	readonly onDidChangeProfile: Event<void>;
	readonly onDidChangePlayer: Event<void>;
	/** Playback state or position changed in the current walkthrough. */
	readonly onDidChangePlayback: Event<void>;
	readonly onDidChangeOffer: Event<void>;
	readonly onDidChangeHandoff: Event<void>;
	/** Fired just before chat is replaced by a walkthrough, so chat can fade out. */
	/** A pending check of some walkthrough finished or failed. */
	readonly onDidChangeChecks: Event<string>;
	readonly onDidChangeElaboration: Event<Elaboration>;
	/** Whether a walkthrough (current, offered, or in history) can be opened. */
	readonly hasRecentWalkthrough: boolean;
	readonly onDidChangeRecentWalkthrough: Event<void>;

	handleEvent(event: ActiveEvent): void;
	initialize(): Promise<void>;
	submitTask(text: string): Promise<void>;
	ask(request: AskRequest): Promise<void>;
	decideApproval(approvalId: string, choiceId: string): Promise<void>;
	synthesize(text: string, voice?: string): Promise<SynthesizeResult>;
	getHistory(turnId: string): Promise<HistoryDetail | undefined>;
	deleteHistory(turnId?: string): Promise<void>;
	saveProfile(profile: KnowledgeProfile): Promise<void>;

	/** First-run setup of the coding agent (provider-agnostic). */
	setupInstall(): Promise<void>;
	setupChooseMethod(method: SignInMethod): Promise<void>;
	setupSignIn(): Promise<void>;
	setupSaveApiKey(key: string): Promise<void>;
	setupCancel(): Promise<void>;
	/** Shows the sign-in choice again (switch account or method). */
	setupRestart(): Promise<void>;
	reconnect(): Promise<void>;
	/** Hands off from chat to the pending walkthrough now. */
	startHandoff(): Promise<void>;
	/** Keeps chat open; the walkthrough stays available to play later. */
	declineHandoff(): void;
	openChat(fromWalkthrough: boolean): Promise<void>;
	/** Makes `walkthrough` the one playing (its tab became active). */
	selectWalkthrough(walkthrough: Walkthrough): void;
	/** Opens Active's section of Settings. */
	openSettings(): Promise<void>;
	/** Starts a new chat (a new coding session) in this folder. */
	newChat(): Promise<void>;
	/** Lists this folder's earlier chats and resumes the chosen one. */
	pickChatToResume(): Promise<void>;
	/** The coding agent's reasoning effort setting (`default` or a tier). */
	readonly codingEffort: string;
	setCodingEffort(effort: string): Promise<void>;
	pickCodingEffort(): Promise<void>;
	/** Voice and speed come from settings. */
	readonly narrationVoice: string;
	readonly narrationSpeed: number;
	openWalkthrough(walkthrough: Walkthrough, start?: PlaybackPosition, playDelayMs?: number): Promise<void>;
	resumeWalkthrough(): Promise<void>;
	openProfile(): Promise<void>;
	openCurrentFile(): Promise<void>;

	/** A walkthrough's pending checks, including how those that have since finished turned out. */
	pendingChecks(walkthrough: Walkthrough): readonly PendingCheck[];
	elaborate(walkthroughId: string, sceneId: string): Elaboration;
	elaboration(walkthroughId: string, sceneId: string): Elaboration | undefined;
	/** Reads text aloud outside the walkthrough narration (deeper explanations, voice previews). */
	speak(text: string, voice?: string): Promise<void>;
	stopSpeaking(): void;
	readonly speaking: boolean;
	readonly onDidChangeSpeaking: Event<void>;
	/** Whether to ask how the level of detail was at the end of this walkthrough (occasionally, not every time). */
	shouldAskForFeedback(walkthrough: Walkthrough): boolean;
	recordDetailFeedback(walkthrough: Walkthrough, feedback: DetailFeedback): Promise<KnowledgeProfile>;
	setVoice(voice: string): Promise<void>;
	pickVoice(): Promise<void>;
	/** The walkthrough being watched, else the offered one, else the newest in history. */
	openRecentWalkthrough(): Promise<void>;
	pickFromHistory(): Promise<void>;
	/** Height of the walkthrough's playback controls, so floating buttons can sit above them. */
	readonly controlsHeight: number;
	readonly onDidChangeControlsHeight: Event<void>;
	setControlsHeight(height: number): void;
}

export class ActiveService extends Disposable implements IActiveService {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidChangeAgent = this._register(new Emitter<void>());
	readonly onDidChangeAgent = this._onDidChangeAgent.event;
	private readonly _onDidChangeChat = this._register(new Emitter<ChatEntry | undefined>());
	readonly onDidChangeChat = this._onDidChangeChat.event;
	private readonly _onDidChangeTurnChanges = this._register(new Emitter<void>());
	readonly onDidChangeTurnChanges = this._onDidChangeTurnChanges.event;
	private readonly _onDidChangeWalkthroughStatus = this._register(new Emitter<void>());
	readonly onDidChangeWalkthroughStatus = this._onDidChangeWalkthroughStatus.event;
	private readonly _onDidChangeHistory = this._register(new Emitter<void>());
	readonly onDidChangeHistory = this._onDidChangeHistory.event;
	private readonly _onDidChangeNarration = this._register(new Emitter<void>());
	readonly onDidChangeNarration = this._onDidChangeNarration.event;
	private readonly _onDidChangeProfile = this._register(new Emitter<void>());
	readonly onDidChangeProfile = this._onDidChangeProfile.event;
	private readonly _onDidChangePlayer = this._register(new Emitter<void>());
	readonly onDidChangePlayer = this._onDidChangePlayer.event;
	private readonly _onDidChangePlayback = this._register(new Emitter<void>());
	readonly onDidChangePlayback = this._onDidChangePlayback.event;
	private readonly playbackListener = this._register(new MutableDisposable());
	private readonly skipListener = this._register(new MutableDisposable());
	private readonly _onDidChangeOffer = this._register(new Emitter<void>());
	readonly onDidChangeOffer = this._onDidChangeOffer.event;
	private readonly _onDidChangeHandoff = this._register(new Emitter<void>());
	readonly onDidChangeHandoff = this._onDidChangeHandoff.event;
	private _pendingHandoff: Walkthrough | undefined;
	private readonly _onDidChangeChecks = this._register(new Emitter<string>());
	readonly onDidChangeChecks = this._onDidChangeChecks.event;
	private readonly _onDidChangeElaboration = this._register(new Emitter<Elaboration>());
	readonly onDidChangeElaboration = this._onDidChangeElaboration.event;
	private readonly _onDidChangeRecentWalkthrough = this._register(new Emitter<void>());
	readonly onDidChangeRecentWalkthrough = this._onDidChangeRecentWalkthrough.event;
	/** Checks that finished after their walkthrough was made, by walkthrough id then check id. */
	private readonly checkUpdates = new Map<string, Map<string, PendingCheck>>();
	private readonly elaborations = new Map<string, Elaboration>();
	private readonly clipPlayer = this._register(new ClipPlayer(() => this.narrationSpeed));
	private readonly askedFeedback = new Set<string>();
	private _controlsHeight = 0;
	private readonly _onDidChangeControlsHeight = this._register(new Emitter<void>());
	readonly onDidChangeControlsHeight = this._onDidChangeControlsHeight.event;

	private _agent: AgentState = { status: 'starting', provider: DEFAULT_PROVIDER, workspaceName: '', backgroundTasks: 0 };
	private readonly _chat: ChatEntry[] = [];
	private _profile: KnowledgeProfile = DEFAULT_PROFILE;
	private _models: readonly AgentModelInfo[] = [];
	private _history: TurnSummary[] = [];
	private readonly _turnChanges = new Map<string, FileChangeStat>();
	private _narration: NarrationStatus = { available: false, detail: localize('narrationStarting', "Starting narration") };
	private _walkthroughStatus: WalkthroughStatus | undefined;
	private readonly playerRef = this._register(new MutableDisposable<WalkthroughPlayer>());
	private readonly inputs = new Map<string, WalkthroughInput>();
	/** Saved positions so leaving and returning resumes where the user was. */
	private readonly positions = new Map<string, PlaybackPosition>();
	private _offered: Walkthrough | undefined;
	private _chatContext: ChatContext | undefined;
	private initialized: Promise<void> | undefined;
	private readonly availableKey: IContextKey<boolean>;
	private programmaticOpen = 0;
	/** Narration audio, pre-generated per walkthrough and kept in memory only. */
	private readonly narrationCache = this._register(new NarrationCache(text => this.synthesize(text)));

	constructor(
		@ICommandService private readonly commandService: ICommandService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IPaneCompositePartService private readonly paneCompositeService: IPaneCompositePartService,
		@IViewsService private readonly viewsService: IViewsService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@IWorkspaceTrustManagementService private readonly trustService: IWorkspaceTrustManagementService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IStorageService private readonly storageService: IStorageService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ActiveSetting.NarrationVoice)) {
				this.narrationCache.clear();
				this._onDidChangeNarration.fire();
			}
			if (event.affectsConfiguration(ActiveSetting.NarrationSpeed)) {
				this.player?.updateRate();
			}
		}));
		this.availableKey = ActiveWalkthroughAvailable.bindTo(contextKeyService);
		this._register(this.trustService.onDidChangeTrust(trusted => {
			if (trusted) {
				this.initialized = undefined;
				void this.initialize();
			}
		}));
	}

	get needsTrust(): boolean {
		return !this.trustService.isWorkspaceTrusted();
	}

	get agent(): AgentState { return this._agent; }
	get chat(): readonly ChatEntry[] { return this._chat; }
	get profile(): KnowledgeProfile { return this._profile; }
	get history(): readonly TurnSummary[] { return this._history; }
	get turnChanges(): ReadonlyMap<string, FileChangeStat> { return this._turnChanges; }
	get narration() { return this._narration; }
	get walkthroughStatus(): WalkthroughStatus | undefined { return this._walkthroughStatus; }
	get player(): WalkthroughPlayer | undefined { return this.playerRef.value; }
	get offeredWalkthrough(): Walkthrough | undefined { return this._offered; }
	get chatContext(): ChatContext | undefined { return this._chatContext; }
	get pendingHandoff(): Walkthrough | undefined { return this._pendingHandoff; }
	get controlsHeight(): number { return this._controlsHeight; }
	get speaking(): boolean { return this.clipPlayer.speaking; }
	get onDidChangeSpeaking(): Event<void> { return this.clipPlayer.onDidChange; }
	get hasRecentWalkthrough(): boolean { return !!this.player || !!this._offered || !!this._pendingHandoff || this._history.some(turn => !!turn.walkthroughId); }

	initialize(): Promise<void> {
		this.initialized ??= this.doInitialize();
		return this.initialized;
	}

	private async doInitialize(): Promise<void> {
		await this.trustService.workspaceTrustInitialized;
		if (this.needsTrust) {
			this._agent = { status: 'unavailable', provider: this._agent.provider, blocker: localize('restricted', "This folder is in Restricted Mode. {0} edits files and runs commands, so it only runs in trusted folders.", this._agent.provider.name), workspaceName: this.workspaceService.getWorkspace().folders[0]?.name ?? '', backgroundTasks: 0 };
			this._onDidChangeAgent.fire();
			return;
		}
		this._agent = { ...this._agent, status: 'starting' };
		this._onDidChangeAgent.fire();
		// The agent services live in the `active-agent` extension; wait for it to activate.
		for (let attempt = 0; attempt < 60; attempt++) {
			try {
				const state = await this.commandService.executeCommand<InitialState>(ExtensionCommand.Init);
				if (state) {
					this.applyInitialState(state);
					return;
				}
			} catch {
				// not registered yet
			}
			await timeout(500);
		}
		this._agent = { status: 'unavailable', provider: this._agent.provider, blocker: localize('extensionMissing', "Active's agent services didn't start. See the Active output channel."), workspaceName: '', backgroundTasks: 0 };
		this._onDidChangeAgent.fire();
	}

	private applyInitialState(state: InitialState): void {
		this._agent = state.agent;
		this._chat.splice(0, this._chat.length, ...state.chat);
		this._profile = state.profile;
		this._history = [...state.history];
		this._narration = state.narration;
		this.setTurnChanges(state.turnChanges);
		this._onDidChangeAgent.fire();
		this._onDidChangeChat.fire(undefined);
		this._onDidChangeProfile.fire();
		this._onDidChangeHistory.fire();
		this._onDidChangeNarration.fire();
		this._onDidChangeRecentWalkthrough.fire();
		if (state.pendingWalkthrough) {
			this.narrationCache.prefetchFrom(state.pendingWalkthrough, { scene: 0, segment: 0 });
			this.offer(state.pendingWalkthrough);
		}
	}

	handleEvent(event: ActiveEvent): void {
		switch (event.type) {
			case 'agent':
				this._agent = event.agent;
				this._onDidChangeAgent.fire();
				break;
			case 'chat': {
				const index = this._chat.findIndex(entry => entry.id === event.entry.id);
				if (index >= 0) {
					this._chat[index] = event.entry;
				} else {
					this._chat.push(event.entry);
				}
				this._onDidChangeChat.fire(event.entry);
				break;
			}
			case 'chatReset':
				this._chat.splice(0, this._chat.length, ...event.chat);
				this._onDidChangeChat.fire(undefined);
				break;
			case 'turnChanges':
				this.setTurnChanges(event.files);
				break;
			case 'walkthroughStatus':
				this._walkthroughStatus = event.status;
				this._onDidChangeWalkthroughStatus.fire();
				break;
			case 'walkthroughReady':
				// Start synthesizing the whole narration now, before (or instead of) handoff.
				this.narrationCache.prefetchFrom(event.walkthrough, { scene: 0, segment: 0 });
				void this.onWalkthroughReady(event.walkthrough);
				break;
			case 'history':
				this._history = [...event.history];
				this._onDidChangeHistory.fire();
				this._onDidChangeRecentWalkthrough.fire();
				break;
			case 'narration': {
				const { type: _type, ...status } = event;
				this._narration = status;
				this._onDidChangeNarration.fire();
				break;
			}
			case 'checkUpdate': {
				let checks = this.checkUpdates.get(event.walkthroughId);
				if (!checks) {
					checks = new Map();
					this.checkUpdates.set(event.walkthroughId, checks);
				}
				checks.set(event.check.id, event.check);
				this._onDidChangeChecks.fire(event.walkthroughId);
				break;
			}
			case 'elaboration': {
				const existing = [...this.elaborations.values()].find(candidate => candidate.requestId === event.requestId);
				if (existing) {
					const updated: Elaboration = { ...existing, text: event.text, status: event.status };
					this.elaborations.set(`${existing.walkthroughId}/${existing.sceneId}`, updated);
					this._onDidChangeElaboration.fire(updated);
				}
				break;
			}
			case 'profile':
				this._profile = event.profile;
				this._onDidChangeProfile.fire();
				break;
			case 'models':
				this._models = event.models;
				updateModelChoices(event.models);
				break;
		}
	}

	private setTurnChanges(files: readonly FileChangeStat[]): void {
		this._turnChanges.clear();
		for (const file of files) {
			this._turnChanges.set(file.path, file);
		}
		this._onDidChangeTurnChanges.fire();
	}

	/**
	 * Hands off from chat to the walkthrough, unless the user deliberately
	 * opened something else (a file, settings, history): then the walkthrough is
	 * offered instead of taking over.
	 */
	private async onWalkthroughReady(walkthrough: Walkthrough): Promise<void> {
		const active = this.editorService.activeEditor;
		// A chapter that arrives while the previous one is being watched waits its turn.
		const player = this.player;
		if (active instanceof WalkthroughInput && player && player.state !== 'ended' && player.walkthrough.id !== walkthrough.id && this.configurationService.getValue<boolean>('active.explain.queueChapters') !== false) {
			this.queuedWalkthroughs.push(walkthrough);
			this.offer(walkthrough);
			return;
		}
		const historyOpen = this.viewsService.isViewVisible(ACTIVE_HISTORY_VIEW_ID);
		const onChat = !active || active instanceof ActiveChatInput;
		const watchingOtherWalkthrough = active instanceof WalkthroughInput && this.player?.playing;
		if (onChat && !historyOpen && !watchingOtherWalkthrough && !this._chatContext) {
			if (active instanceof ActiveChatInput) {
				// Chat announces the walkthrough with a short countdown before handing off.
				this._pendingHandoff = walkthrough;
				this._onDidChangeHandoff.fire();
			} else {
				await this.openWalkthrough(walkthrough);
			}
			return;
		}
		this.offer(walkthrough);
		this.notificationService.prompt(Severity.Info, walkthrough.chapter
			? localize('chapterReady', "Chapter {0} is ready: \"{1}\".", walkthrough.chapter, walkthrough.title)
			: localize('walkthroughReady', "The walkthrough for \"{0}\" is ready.", walkthrough.title), [{
			label: localize('play', "Play Walkthrough"),
			run: () => this.openWalkthrough(walkthrough),
		}]);
	}

	/** Chapters queued while the previous one played: the next pops up once it ends. */
	private readonly queuedWalkthroughs: Walkthrough[] = [];
	private queuedTimer: ReturnType<typeof setTimeout> | undefined;

	private playNextQueued(): void {
		if (!this.queuedWalkthroughs.length || this.queuedTimer) {
			return;
		}
		// A moment to let the last line land before the next chapter starts.
		this.queuedTimer = setTimeout(() => {
			this.queuedTimer = undefined;
			const next = this.queuedWalkthroughs.shift();
			if (next) {
				void this.openWalkthrough(next, undefined, 650);
			}
		}, 1800);
	}

	async startHandoff(): Promise<void> {
		const walkthrough = this._pendingHandoff;
		if (!walkthrough) {
			return;
		}
		this._pendingHandoff = undefined;
		this._onDidChangeHandoff.fire();
		await this.openWalkthrough(walkthrough, undefined, 650);
	}

	declineHandoff(): void {
		const walkthrough = this._pendingHandoff;
		if (walkthrough) {
			this._pendingHandoff = undefined;
			this._onDidChangeHandoff.fire();
			this.offer(walkthrough);
		}
	}

	private offer(walkthrough: Walkthrough | undefined): void {
		this._offered = walkthrough;
		this.availableKey.set(!!walkthrough || !!this.player);
		this._onDidChangeOffer.fire();
		this._onDidChangeRecentWalkthrough.fire();
	}

	// ------------------------------------------------------------- extension calls

	async submitTask(text: string): Promise<void> {
		// A new coding task means the user has moved on from questions about an earlier
		// walkthrough, so that context must not stop the next walkthrough from taking over.
		if (this._chatContext) {
			this._chatContext = undefined;
			this._onDidChangePlayer.fire();
		}
		await this.commandService.executeCommand(ExtensionCommand.SubmitTask, text);
	}

	async ask(request: AskRequest): Promise<void> {
		await this.commandService.executeCommand(ExtensionCommand.Ask, request);
	}

	async decideApproval(approvalId: string, choiceId: string): Promise<void> {
		await this.commandService.executeCommand(ExtensionCommand.DecideApproval, { approvalId, choiceId });
	}

	async synthesize(text: string, voice = this.narrationVoice): Promise<SynthesizeResult> {
		return (await this.commandService.executeCommand<SynthesizeResult>(ExtensionCommand.Synthesize, { text, voice })) ?? { error: 'no response' };
	}

	getHistory(turnId: string): Promise<HistoryDetail | undefined> {
		return this.commandService.executeCommand<HistoryDetail>(ExtensionCommand.HistoryGet, turnId);
	}

	async deleteHistory(turnId?: string): Promise<void> {
		await this.commandService.executeCommand(ExtensionCommand.HistoryDelete, turnId);
		const removed = (walkthrough: Walkthrough | undefined) => walkthrough && (!turnId || walkthrough.turnId === turnId);
		if (removed(this._offered)) {
			this.offer(undefined);
		}
		if (removed(this.player?.walkthrough)) {
			const input = this.inputs.get(this.player!.walkthrough.id);
			this.playerRef.clear();
			if (input) {
				await this.editorService.closeEditor({ editor: input, groupId: this.editorService.activeEditorPane?.group.id ?? 0 }).catch(() => undefined);
			}
			this._onDidChangePlayer.fire();
		}
	}

	async setupInstall(): Promise<void> {
		await this.commandService.executeCommand(ExtensionCommand.SetupInstall);
	}

	async setupChooseMethod(method: SignInMethod): Promise<void> {
		await this.commandService.executeCommand(ExtensionCommand.SetupChooseMethod, method);
	}

	async setupSignIn(): Promise<void> {
		await this.commandService.executeCommand(ExtensionCommand.SetupSignIn);
	}

	async setupSaveApiKey(key: string): Promise<void> {
		await this.commandService.executeCommand(ExtensionCommand.SetupSaveApiKey, key);
	}

	async setupCancel(): Promise<void> {
		await this.commandService.executeCommand(ExtensionCommand.SetupCancel);
	}

	async setupRestart(): Promise<void> {
		if (this.needsTrust) {
			// The agent extension doesn't run in Restricted Mode; chat explains how to trust the folder.
			return;
		}
		await this.commandService.executeCommand(ExtensionCommand.SetupRestart);
	}

	async reconnect(): Promise<void> {
		await this.commandService.executeCommand(ExtensionCommand.Reconnect);
	}

	async saveProfile(profile: KnowledgeProfile): Promise<void> {
		await this.commandService.executeCommand(ExtensionCommand.ProfileSet, profile);
	}

	// ------------------------------------------------------------- navigation

	private async withProgrammaticOpen<T>(work: () => Promise<T>): Promise<T> {
		this.programmaticOpen++;
		try {
			return await work();
		} finally {
			this.programmaticOpen--;
		}
	}

	/** Opens chat across the whole work area. From a walkthrough it pauses playback and keeps its context for questions. */
	async openChat(fromWalkthrough: boolean): Promise<void> {
		const player = this.player;
		if (fromWalkthrough && player) {
			player.pause();
			const scene = player.walkthrough.scenes[player.position.scene];
			this.positions.set(player.walkthrough.id, player.position);
			this._chatContext = { walkthroughId: player.walkthrough.id, sceneId: scene.id, sceneIndex: player.position.scene, segment: player.position.segment, title: scene.title };
		} else if (!fromWalkthrough) {
			this._chatContext = undefined;
		}
		this._onDidChangePlayer.fire();
		// Chat and walkthroughs are ordinary tabs: open or reveal, never replace one another.
		await this.withProgrammaticOpen(() => this.editorService.openEditor(new ActiveChatInput(), { pinned: true, revealIfOpened: true }));
	}

	selectWalkthrough(walkthrough: Walkthrough): void {
		if (this.player?.walkthrough.id !== walkthrough.id) {
			this.activatePlayer(walkthrough);
			this._onDidChangePlayer.fire();
		}
	}

	private activatePlayer(walkthrough: Walkthrough, start?: PlaybackPosition): void {
		if (this.player?.walkthrough.id !== walkthrough.id) {
			if (this.player) {
				this.positions.set(this.player.walkthrough.id, this.player.position);
			}
			const position = start ?? this.positions.get(walkthrough.id) ?? { scene: 0, segment: 0 };
			this.narrationCache.prefetchFrom(walkthrough, position);
			const player = new WalkthroughPlayer(walkthrough, position, this.narrationCache, () => this.narrationSpeed);
			this.playerRef.value = player;
			this.skipListener.value = player.onDidSkipEarly(sceneIndex => void this.recordEarlySkip(walkthrough, sceneIndex));
			this.playbackListener.value = player.onDidChange(() => {
				if (player.playing) {
					// Walkthrough narration and a deeper explanation never talk over each other.
					this.clipPlayer.stop();
				}
				if (player.state === 'ended') {
					this.playNextQueued();
				}
				this._onDidChangePlayback.fire();
			});
		} else if (start) {
			this.player.seek(start);
		}
	}

	async openWalkthrough(walkthrough: Walkthrough, start?: PlaybackPosition, playDelayMs = 0): Promise<void> {
		const queued = this.queuedWalkthroughs.findIndex(candidate => candidate.id === walkthrough.id);
		if (queued >= 0) {
			this.queuedWalkthroughs.splice(queued, 1);
		}
		if (this._pendingHandoff?.id === walkthrough.id) {
			this._pendingHandoff = undefined;
			this._onDidChangeHandoff.fire();
		}
		let input = this.inputs.get(walkthrough.id);
		if (!input) {
			input = new WalkthroughInput(walkthrough);
			this.inputs.set(walkthrough.id, input);
			this._register(input.onWillDispose(() => this.inputs.delete(walkthrough.id)));
		}
		this.activatePlayer(walkthrough, start);
		if (this._offered?.id === walkthrough.id) {
			this._offered = undefined;
		}
		this._chatContext = undefined;
		this.offer(this._offered);
		// Explorer shows the counts of the turn being explained.
		this.setTurnChanges(Object.values(walkthrough.files).map(file => ({ path: file.path, added: file.added, removed: file.removed })));
		this._onDidChangePlayer.fire();
		await this.withProgrammaticOpen(async () => {
			await this.editorService.openEditor(input, { pinned: true, revealIfOpened: true });
			// Show Explorer (with change counts) only when the editor keeps enough room for the walkthrough.
			if (this.layoutService.mainContainerDimension.width >= 1000 || this.layoutService.isVisible(Parts.SIDEBAR_PART)) {
				this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
				await this.paneCompositeService.openPaneComposite(EXPLORER_VIEWLET_ID, ViewContainerLocation.Sidebar, false);
			}
		});
		this.revealChangedFiles(walkthrough);
		const player = this.player;
		if (playDelayMs > 0) {
			// Let the walkthrough settle on screen before narration starts.
			await timeout(playDelayMs);
		}
		if (player && player === this.player) {
			player.play();
		}
	}

	/** Expands Explorer to the files this walkthrough covers so their change counts are visible. */
	private revealChangedFiles(walkthrough: Walkthrough): void {
		const folder = this.workspaceService.getWorkspace().folders[0];
		if (!folder) {
			return;
		}
		const files = Object.keys(walkthrough.files).filter(path => walkthrough.files[path].final !== null);
		void (async () => {
			for (const path of files.reverse()) {
				await this.explorerService.select(folder.toResource(path), true).catch(() => undefined);
			}
		})();
	}

	async resumeWalkthrough(): Promise<void> {
		const target = this.player?.walkthrough ?? this._offered;
		if (target) {
			await this.openWalkthrough(target);
		}
	}

	async openProfile(): Promise<void> {
		await this.editorService.openEditor(new KnowledgeProfileInput(), { pinned: true });
	}

	/** Pauses the walkthrough and opens the editable file at the focused location. */
	async openCurrentFile(): Promise<void> {
		const player = this.player;
		const folder = this.workspaceService.getWorkspace().folders[0];
		if (!player || !folder) {
			return;
		}
		player.pause();
		this.positions.set(player.walkthrough.id, player.position);
		const scene = player.walkthrough.scenes[player.position.scene];
		const visual = player.visual;
		const range = scene.focus[visual.focus ?? 0] ?? { startLine: scene.anchorLine || 1, endLine: scene.anchorLine || 1 };
		const resource = folder.toResource(scene.file);
		await this.editorService.openEditor({ resource, options: { pinned: true, revealIfOpened: true, selection: { startLineNumber: range.startLine, startColumn: 1, endLineNumber: range.startLine, endColumn: 1 } } });
		const captured = player.walkthrough.files[scene.file]?.[scene.version];
		try {
			const current = (await this.fileService.readFile(resource)).value.toString();
			if (captured !== undefined && captured !== null && current !== captured) {
				this.notificationService.info(localize('fileChanged', "{0} has changed since this walkthrough was captured.", scene.file));
			}
		} catch {
			this.notificationService.info(localize('fileMissing', "{0} no longer exists. The walkthrough keeps its captured copy.", scene.file));
		}
		this._onDidChangePlayer.fire();
	}

	// ------------------------------------------------------------- explanations

	setControlsHeight(height: number): void {
		if (height !== this._controlsHeight) {
			this._controlsHeight = height;
			this._onDidChangeControlsHeight.fire();
		}
	}

	pendingChecks(walkthrough: Walkthrough): readonly PendingCheck[] {
		const updates = this.checkUpdates.get(walkthrough.id);
		return updates ? walkthrough.pending.map(check => updates.get(check.id) ?? check) : walkthrough.pending;
	}

	elaboration(walkthroughId: string, sceneId: string): Elaboration | undefined {
		return this.elaborations.get(`${walkthroughId}/${sceneId}`);
	}

	elaborate(walkthroughId: string, sceneId: string): Elaboration {
		const existing = this.elaboration(walkthroughId, sceneId);
		if (existing && existing.status !== 'error') {
			return existing;
		}
		const elaboration: Elaboration = { requestId: `elab-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, walkthroughId, sceneId, text: '', status: 'streaming' };
		this.elaborations.set(`${walkthroughId}/${sceneId}`, elaboration);
		this._onDidChangeElaboration.fire(elaboration);
		void this.commandService.executeCommand(ExtensionCommand.Elaborate, { requestId: elaboration.requestId, walkthroughId, sceneId }).then(undefined, error => {
			this.handleEvent({ type: 'elaboration', requestId: elaboration.requestId, text: String(error), status: 'error' });
		});
		return elaboration;
	}

	async speak(text: string, voice?: string): Promise<void> {
		this.player?.pause();
		await this.clipPlayer.play(() => this.synthesize(text, voice));
	}

	stopSpeaking(): void {
		this.clipPlayer.stop();
	}

	shouldAskForFeedback(walkthrough: Walkthrough): boolean {
		if (this.askedFeedback.has(walkthrough.id)) {
			return false;
		}
		this.askedFeedback.add(walkthrough.id);
		// Ask now and then, not after every walkthrough: never twice in a row, always by the fourth.
		const finishedSinceAsked = this.storageService.getNumber(FEEDBACK_STORAGE_KEY, StorageScope.PROFILE, 1) + 1;
		const ask = finishedSinceAsked >= 4 || (finishedSinceAsked >= 2 && Math.random() < 0.4);
		this.storageService.store(FEEDBACK_STORAGE_KEY, ask ? 0 : finishedSinceAsked, StorageScope.PROFILE, StorageTarget.MACHINE);
		return ask;
	}

	async recordDetailFeedback(walkthrough: Walkthrough, feedback: DetailFeedback): Promise<KnowledgeProfile> {
		const topics = walkthrough.terms.map(term => term.name).slice(0, 3);
		const updated = applyDetailFeedback(this._profile, feedback, topics);
		await this.saveProfile(updated);
		return updated;
	}

	/** A quick Next is a very slight hint that the developer already knew what the scene covered. */
	private async recordEarlySkip(walkthrough: Walkthrough, sceneIndex: number): Promise<void> {
		const topics = sceneTopics(walkthrough, sceneIndex);
		if (topics.length) {
			await this.saveProfile(applySkipSignal(this._profile, topics));
		}
	}

	get narrationVoice(): string {
		return this.configurationService.getValue<string>(ActiveSetting.NarrationVoice) || 'default';
	}

	get narrationSpeed(): number {
		const speed = this.configurationService.getValue<number>(ActiveSetting.NarrationSpeed);
		return typeof speed === 'number' && speed >= 0.5 && speed <= 2 ? speed : 1;
	}

	async setVoice(voice: string): Promise<void> {
		if (voice !== this.narrationVoice) {
			await this.configurationService.updateValue(ActiveSetting.NarrationVoice, voice === 'default' ? '' : voice, ConfigurationTarget.USER);
		}
	}

	get codingEffort(): string {
		return this.configurationService.getValue<string>(ActiveSetting.CodingEffort) || 'default';
	}

	async setCodingEffort(effort: string): Promise<void> {
		await this.configurationService.updateValue(ActiveSetting.CodingEffort, effort, ConfigurationTarget.USER);
	}

	async pickCodingEffort(): Promise<void> {
		const current = this.codingEffort;
		const modelId = this.configurationService.getValue<string>(ActiveSetting.CodingModel) || this._models.find(model => model.isDefault)?.id;
		const model = this._models.find(candidate => candidate.id === modelId);
		type EffortItem = IQuickPickItem & { effort: string };
		const tiers = ['default', ...REASONING_EFFORTS.filter(tier => !model?.efforts.length || model.efforts.includes(tier))];
		const items: EffortItem[] = tiers.map(effort => ({
			effort,
			label: effort === 'default' && model?.defaultEffort ? localize('effortDefaultIs', "Default ({0})", effortLabel(model.defaultEffort)) : effortLabel(effort),
			description: effort === current ? localize('currentEffort', "current") : undefined,
			detail: effortDescription(effort),
		}));
		const chosen = await this.quickInputService.pick(items, {
			title: localize('pickEffortTitle', "Coding Agent Effort"),
			placeHolder: localize('pickEffortPlaceholder', "How much {0} reasons before acting. Applies from the next task.", this._agent.provider.name),
			activeItem: items.find(item => item.effort === current),
		});
		if (chosen) {
			await this.setCodingEffort(chosen.effort);
		}
	}

	async newChat(): Promise<void> {
		await this.commandService.executeCommand(ExtensionCommand.NewSession);
		await this.openChat(false);
	}

	async pickChatToResume(): Promise<void> {
		// Chats are coding sessions; history records which session each turn ran in.
		const sessions = new Map<string, TurnSummary[]>();
		for (const turn of this._history) {
			sessions.set(turn.sessionId, [...(sessions.get(turn.sessionId) ?? []), turn]);
		}
		type ChatItem = IQuickPickItem & { sessionId: string };
		const current = this._agent.sessionId;
		const items: ChatItem[] = [...sessions.entries()].map(([sessionId, turns]) => {
			const latest = turns[0];
			const first = turns[turns.length - 1];
			return {
				sessionId,
				label: first.task.split('\n')[0].slice(0, 80),
				description: sessionId === current ? localize('currentChat', "current") : fromNow(latest.startedAt, true),
				detail: turns.length === 1 ? localize('oneTask', "1 task") : localize('tasks', "{0} tasks · latest: {1}", turns.length, latest.task.split('\n')[0].slice(0, 60)),
			};
		});
		if (!items.length) {
			this.notificationService.info(localize('noChats', "No earlier chats in this folder yet."));
			return;
		}
		const chosen = await this.quickInputService.pick(items, { title: localize('resumeChatTitle', "Resume a Chat"), placeHolder: localize('resumeChatPlaceholder', "Earlier chats in this folder, newest first"), matchOnDetail: true });
		if (chosen && chosen.sessionId !== current) {
			await this.commandService.executeCommand(ExtensionCommand.ResumeSession, chosen.sessionId);
		}
		await this.openChat(false);
	}

	async openSettings(): Promise<void> {
		await this.commandService.executeCommand('workbench.action.openSettings', '@tag:active');
	}

	async pickVoice(): Promise<void> {
		const voices: readonly VoiceInfo[] = this._narration.voices?.length ? this._narration.voices : [{ name: 'default', description: localize('builtInVoice', "Phonon's built-in voice") }];
		const current = this.narrationVoice;
		type VoiceItem = IQuickPickItem & { voice: string };
		const item = (voice: VoiceInfo): VoiceItem => ({
			voice: voice.name,
			label: voice.name === 'default' ? localize('defaultVoice', "Default") : voice.name,
			description: voice.name === current ? localize('currentVoice', "current") : undefined,
			detail: voice.description,
			buttons: [{ iconClass: 'codicon codicon-play', tooltip: localize('previewVoice', "Preview this voice") }],
		});
		const narrators = voices.filter(voice => !voice.character);
		const characters = voices.filter(voice => voice.character);
		const items: Array<VoiceItem | IQuickPickSeparator> = [
			{ type: 'separator', label: localize('narrators', "Narrators") },
			...narrators.map(item),
			...(characters.length ? [{ type: 'separator', label: localize('characters', "Character voices") } as IQuickPickSeparator, ...characters.map(item)] : []),
		];
		const picker = this.quickInputService.createQuickPick<VoiceItem>({ useSeparators: true });
		picker.title = localize('pickVoiceTitle', "Narration Voice");
		picker.placeholder = this._narration.available
			? localize('pickVoicePlaceholder', "Pick a voice. ▶ previews it.")
			: localize('pickVoiceUnavailable', "Narration is unavailable: {0}", this._narration.detail);
		picker.matchOnDetail = true;
		picker.items = items;
		picker.activeItems = picker.items.filter((candidate): candidate is VoiceItem => (candidate as VoiceItem).voice === current);
		const disposables = [
			picker.onDidTriggerItemButton(event => void this.speak(localize('voiceSample', "Hi, I'm {0}. This is how I'll sound.", event.item.voice === 'default' ? localize('phonon', "Phonon") : event.item.voice), event.item.voice)),
			picker.onDidAccept(() => {
				const chosen = picker.selectedItems[0];
				picker.hide();
				if (chosen) {
					void this.setVoice(chosen.voice);
				}
			}),
			picker.onDidHide(() => {
				this.clipPlayer.stop();
				disposables.forEach(disposable => disposable.dispose());
				picker.dispose();
			}),
		];
		picker.show();
	}

	async openRecentWalkthrough(): Promise<void> {
		const recent = this.player?.walkthrough ?? this._pendingHandoff ?? this._offered;
		if (recent) {
			await this.openWalkthrough(recent);
			return;
		}
		const turn = this._history.find(candidate => candidate.walkthroughId);
		const walkthrough = turn && (await this.getHistory(turn.turnId))?.walkthrough;
		if (walkthrough) {
			await this.openWalkthrough(walkthrough);
		}
	}

	async pickFromHistory(): Promise<void> {
		type TurnItem = IQuickPickItem & { turnId?: string };
		const currentId = this.player?.walkthrough.id;
		const items: TurnItem[] = this._history.filter(turn => turn.walkthroughId).map(turn => ({
			turnId: turn.turnId,
			label: turn.walkthroughTitle ?? turn.task,
			description: `${localize('turnNumber', "Turn {0}", turn.index)} · ${new Date(turn.endedAt ?? turn.startedAt).toLocaleString()}${turn.walkthroughId === currentId ? ` · ${localize('watchingNow', "watching now")}` : ''}`,
			detail: turn.task,
		}));
		items.push({ label: `$(history) ${localize('allHistory', "Show All History…")}`, detail: localize('allHistoryDetail', "Including turns without a walkthrough") });
		const picked = await this.quickInputService.pick(items, { title: localize('historyPickTitle', "Walkthrough History"), placeHolder: localize('historyPickPlaceholder', "Replay an earlier walkthrough"), matchOnDetail: true });
		if (!picked) {
			return;
		}
		if (!picked.turnId) {
			await this.viewsService.openView(ACTIVE_HISTORY_VIEW_ID, true);
			return;
		}
		const walkthrough = (await this.getHistory(picked.turnId))?.walkthrough;
		if (walkthrough) {
			await this.openWalkthrough(walkthrough, walkthrough.id === currentId ? undefined : { scene: 0, segment: 0 });
		}
	}
}
