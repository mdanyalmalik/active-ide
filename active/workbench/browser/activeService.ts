/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { timeout } from '../../../../base/common/async.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
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
import { ActiveEvent, AgentState, AskRequest, ChatEntry, DEFAULT_PROFILE, ExtensionCommand, FileChangeStat, HistoryDetail, InitialState, LearningProfile, SynthesizeResult, TurnSummary, Walkthrough, WalkthroughStatus } from '../common/activeProtocol.js';
import { ActiveChatInput, LearningProfileInput, WalkthroughInput } from './activeInputs.js';
import { NarrationCache } from './narrationCache.js';
import { PlaybackPosition, WalkthroughPlayer } from './walkthroughPlayer.js';

export const ACTIVE_HISTORY_VIEW_ID = 'workbench.view.activeHistory';
export const ActiveWalkthroughFocus = new RawContextKey<boolean>('activeWalkthroughFocus', false, localize('activeWalkthroughFocus', "Whether the Active walkthrough editor has focus"));
export const ActiveWalkthroughAvailable = new RawContextKey<boolean>('activeWalkthroughAvailable', false, localize('activeWalkthroughAvailable', "Whether an Active walkthrough can be resumed"));

/** Where the user was in a walkthrough when they asked a question from it. */
export interface ChatContext {
	readonly walkthroughId: string;
	readonly sceneId: string;
	readonly sceneIndex: number;
	readonly segment: number;
	readonly title: string;
}

export const IActiveService = createDecorator<IActiveService>('activeService');

export interface IActiveService {
	readonly _serviceBrand: undefined;

	readonly agent: AgentState;
	readonly chat: readonly ChatEntry[];
	readonly profile: LearningProfile;
	readonly history: readonly TurnSummary[];
	readonly turnChanges: ReadonlyMap<string, FileChangeStat>;
	readonly narration: { readonly available: boolean; readonly detail: string };
	readonly walkthroughStatus: WalkthroughStatus | undefined;
	readonly player: WalkthroughPlayer | undefined;
	/** A finished walkthrough offered to the user (not yet shown because they had navigated elsewhere). */
	readonly offeredWalkthrough: Walkthrough | undefined;
	readonly chatContext: ChatContext | undefined;
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

	handleEvent(event: ActiveEvent): void;
	initialize(): Promise<void>;
	submitTask(text: string): Promise<void>;
	ask(request: AskRequest): Promise<void>;
	decideApproval(approvalId: string, choiceId: string): Promise<void>;
	synthesize(text: string): Promise<SynthesizeResult>;
	getHistory(turnId: string): Promise<HistoryDetail | undefined>;
	deleteHistory(turnId?: string): Promise<void>;
	saveProfile(profile: LearningProfile): Promise<void>;

	openChat(fromWalkthrough: boolean): Promise<void>;
	openWalkthrough(walkthrough: Walkthrough, start?: PlaybackPosition): Promise<void>;
	resumeWalkthrough(): Promise<void>;
	openProfile(): Promise<void>;
	openCurrentFile(): Promise<void>;
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
	private readonly _onDidChangeOffer = this._register(new Emitter<void>());
	readonly onDidChangeOffer = this._onDidChangeOffer.event;

	private _agent: AgentState = { status: 'starting', workspaceName: '', backgroundTasks: 0 };
	private readonly _chat: ChatEntry[] = [];
	private _profile: LearningProfile = DEFAULT_PROFILE;
	private _history: TurnSummary[] = [];
	private readonly _turnChanges = new Map<string, FileChangeStat>();
	private _narration = { available: false, detail: localize('narrationStarting', "Starting narration") };
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
		@IContextKeyService contextKeyService: IContextKeyService,
	) {
		super();
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
	get profile(): LearningProfile { return this._profile; }
	get history(): readonly TurnSummary[] { return this._history; }
	get turnChanges(): ReadonlyMap<string, FileChangeStat> { return this._turnChanges; }
	get narration() { return this._narration; }
	get walkthroughStatus(): WalkthroughStatus | undefined { return this._walkthroughStatus; }
	get player(): WalkthroughPlayer | undefined { return this.playerRef.value; }
	get offeredWalkthrough(): Walkthrough | undefined { return this._offered; }
	get chatContext(): ChatContext | undefined { return this._chatContext; }

	initialize(): Promise<void> {
		this.initialized ??= this.doInitialize();
		return this.initialized;
	}

	private async doInitialize(): Promise<void> {
		await this.trustService.workspaceTrustInitialized;
		if (this.needsTrust) {
			this._agent = { status: 'unavailable', blocker: localize('restricted', "This folder is open in Restricted Mode. Muse Code edits files and runs commands here, so Active starts it only in a trusted folder."), workspaceName: this.workspaceService.getWorkspace().folders[0]?.name ?? '', backgroundTasks: 0 };
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
		this._agent = { status: 'unavailable', blocker: localize('extensionMissing', "The Active agent services (built-in extension `active-agent`) did not start. Check the Active output channel."), workspaceName: '', backgroundTasks: 0 };
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
				break;
			case 'narration':
				this._narration = { available: event.available, detail: event.detail };
				this._onDidChangeNarration.fire();
				break;
			case 'profile':
				if (event.profile.voice !== this._profile.voice) {
					this.narrationCache.clear();
				}
				this._profile = event.profile;
				this._onDidChangeProfile.fire();
				this.player?.updateRate();
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
		const historyOpen = this.viewsService.isViewVisible(ACTIVE_HISTORY_VIEW_ID);
		const onChat = !active || active instanceof ActiveChatInput;
		const watchingOtherWalkthrough = active instanceof WalkthroughInput && this.player?.playing;
		if (onChat && !historyOpen && !watchingOtherWalkthrough && !this._chatContext) {
			await this.openWalkthrough(walkthrough);
			return;
		}
		this.offer(walkthrough);
		this.notificationService.prompt(Severity.Info, localize('walkthroughReady', "The walkthrough for \"{0}\" is ready.", walkthrough.title), [{
			label: localize('play', "Play Walkthrough"),
			run: () => this.openWalkthrough(walkthrough),
		}]);
	}

	private offer(walkthrough: Walkthrough | undefined): void {
		this._offered = walkthrough;
		this.availableKey.set(!!walkthrough || !!this.player);
		this._onDidChangeOffer.fire();
	}

	// ------------------------------------------------------------- extension calls

	async submitTask(text: string): Promise<void> {
		await this.commandService.executeCommand(ExtensionCommand.SubmitTask, text);
	}

	async ask(request: AskRequest): Promise<void> {
		await this.commandService.executeCommand(ExtensionCommand.Ask, request);
	}

	async decideApproval(approvalId: string, choiceId: string): Promise<void> {
		await this.commandService.executeCommand(ExtensionCommand.DecideApproval, { approvalId, choiceId });
	}

	async synthesize(text: string): Promise<SynthesizeResult> {
		return (await this.commandService.executeCommand<SynthesizeResult>(ExtensionCommand.Synthesize, { text, voice: this._profile.voice })) ?? { error: 'no response' };
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

	async saveProfile(profile: LearningProfile): Promise<void> {
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
		await this.withProgrammaticOpen(async () => {
			const chat = new ActiveChatInput();
			const active = this.editorService.activeEditor;
			if (active instanceof WalkthroughInput && this.editorService.activeEditorPane) {
				await this.editorService.replaceEditors([{ editor: active, replacement: chat }], this.editorService.activeEditorPane.group);
			} else {
				await this.editorService.openEditor(chat, { pinned: true });
			}
			this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
		});
	}

	async openWalkthrough(walkthrough: Walkthrough, start?: PlaybackPosition): Promise<void> {
		let input = this.inputs.get(walkthrough.id);
		if (!input) {
			input = new WalkthroughInput(walkthrough);
			this.inputs.set(walkthrough.id, input);
			this._register(input.onWillDispose(() => this.inputs.delete(walkthrough.id)));
		}
		if (this.player?.walkthrough.id !== walkthrough.id) {
			if (this.player) {
				this.positions.set(this.player.walkthrough.id, this.player.position);
			}
			const position = start ?? this.positions.get(walkthrough.id) ?? { scene: 0, segment: 0 };
			this.narrationCache.prefetchFrom(walkthrough, position);
			const player = new WalkthroughPlayer(walkthrough, position, this.narrationCache, () => this._profile.narrationRate);
			this.playerRef.value = player;
			this.playbackListener.value = player.onDidChange(() => this._onDidChangePlayback.fire());
		} else if (start) {
			this.player.seek(start);
		}
		if (this._offered?.id === walkthrough.id) {
			this._offered = undefined;
		}
		this._chatContext = undefined;
		this.offer(this._offered);
		// Explorer shows the counts of the turn being explained.
		this.setTurnChanges(Object.values(walkthrough.files).map(file => ({ path: file.path, added: file.added, removed: file.removed })));
		this._onDidChangePlayer.fire();
		await this.withProgrammaticOpen(async () => {
			const active = this.editorService.activeEditor;
			if (active instanceof ActiveChatInput && this.editorService.activeEditorPane) {
				await this.editorService.replaceEditors([{ editor: active, replacement: input }], this.editorService.activeEditorPane.group);
			} else {
				await this.editorService.openEditor(input, { pinned: true });
			}
			this.layoutService.setPartHidden(false, Parts.SIDEBAR_PART);
			await this.paneCompositeService.openPaneComposite(EXPLORER_VIEWLET_ID, ViewContainerLocation.Sidebar, false);
		});
		this.revealChangedFiles(walkthrough);
		this.player?.play();
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
		await this.editorService.openEditor(new LearningProfileInput(), { pinned: true });
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
				this.notificationService.info(localize('fileChanged', "{0} has changed since the captured version shown in the walkthrough.", scene.file));
			}
		} catch {
			this.notificationService.info(localize('fileMissing', "{0} no longer exists on disk; the walkthrough keeps its captured version.", scene.file));
		}
		this._onDidChangePlayer.fire();
	}
}
