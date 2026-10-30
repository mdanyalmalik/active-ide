/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/active.css';
import './activeSettings.js';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ContextKeyExpr, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { ViewPaneContainer } from '../../../browser/parts/views/viewPaneContainer.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions } from '../../../common/editor.js';
import { Extensions as ViewExtensions, IViewContainersRegistry, IViewDescriptorService, IViewsRegistry, ViewContainerLocation } from '../../../common/views.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IWorkbenchLayoutService, Parts } from '../../../services/layout/browser/layoutService.js';
import { IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { ExplorerExtensions, IExplorerFileContributionRegistry } from '../../files/browser/explorerFileContrib.js';
import { ActiveEvent, ExplainMode, WORKBENCH_EVENT_COMMAND } from '../common/activeProtocol.js';
import { ActiveChatInput, KnowledgeProfileInput, WalkthroughInput } from './activeInputs.js';
import { ACTIVE_HISTORY_VIEW_ID, ActiveService, ActiveWalkthroughAvailable, ActiveWalkthroughFocus, IActiveService } from './activeService.js';
import { ActiveChatEditor } from './chatEditor.js';
import { ACTIVE_CHANGE_COUNTS_VIEW_ID, ChangeCountsBar, explorerChangeCountsDescriptor } from './explorerStats.js';
import { AgentDecorations, AgentQuickDiff } from './agentChanges.js';
import { VIEW_CONTAINER as EXPLORER_VIEW_CONTAINER } from '../../files/browser/explorerViewlet.js';
import { ActiveHistoryView } from './historyView.js';
import { KnowledgeProfileEditor } from './profileEditor.js';
import { ActiveCommandIds, WalkthroughCommandIds } from './walkthroughCommands.js';
import { WalkthroughEditor } from './walkthroughEditor.js';
import { ActiveWelcomeDialog } from './welcomeDialog.js';

registerSingleton(IActiveService, ActiveService, InstantiationType.Delayed);

// Extension → workbench events.
CommandsRegistry.registerCommand(WORKBENCH_EVENT_COMMAND, (accessor: ServicesAccessor, event: ActiveEvent) => accessor.get(IActiveService).handleEvent(event));

// ---------------------------------------------------------------- editors

const editorPanes = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane);
editorPanes.registerEditorPane(EditorPaneDescriptor.create(ActiveChatEditor, ActiveChatEditor.ID, localize('activeChatEditor', "Active Chat")), [new SyncDescriptor(ActiveChatInput)]);
editorPanes.registerEditorPane(EditorPaneDescriptor.create(WalkthroughEditor, WalkthroughEditor.ID, localize('walkthroughEditor', "Active Walkthrough")), [new SyncDescriptor(WalkthroughInput)]);
editorPanes.registerEditorPane(EditorPaneDescriptor.create(KnowledgeProfileEditor, KnowledgeProfileEditor.ID, localize('profileEditor', "Knowledge Profile")), [new SyncDescriptor(KnowledgeProfileInput)]);

// ---------------------------------------------------------------- views

const chatViewIcon = registerIcon('active-chat-view-icon', Codicon.commentDiscussion, localize('activeChatViewIcon', "View icon of the Active chat view."));
const historyViewIcon = registerIcon('active-history-view-icon', Codicon.history, localize('activeHistoryViewIcon', "View icon of the Active history view."));

const ACTIVE_SESSION_CONTAINER_ID = 'workbench.view.activeSessionContainer';
const ACTIVE_SESSION_VIEW_ID = 'workbench.view.activeSession';
const ACTIVE_HISTORY_CONTAINER_ID = 'workbench.view.activeHistoryContainer';

/** A small sidebar entry point for chat, walkthrough resume and personalization. */
class ActiveSessionView extends ViewPane {
	private content!: HTMLElement;
	private readonly bodyStore = this._register(new DisposableStore());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IActiveService private readonly activeService: IActiveService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.activeService.onDidChangeAgent(() => this.renderContent()));
		this._register(this.activeService.onDidChangePlayer(() => this.renderContent()));
		this._register(this.activeService.onDidChangeOffer(() => this.renderContent()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this.content = dom.append(container, dom.$('.active-session-view'));
		this.renderContent();
	}

	private renderContent(): void {
		if (!this.content) {
			return;
		}
		this.bodyStore.clear();
		dom.clearNode(this.content);
		const agent = this.activeService.agent;
		dom.append(this.content, dom.$('.status')).textContent = agent.status === 'unavailable'
			? localize('sessionUnavailable', "{0} is not connected.", agent.provider.name)
			: localize('sessionStatus', "{0} · {1}", agent.provider.name, agent.status);
		const button = (label: string, run: () => unknown, primary = false) => {
			const element = dom.append(this.content, dom.$(`button.${primary ? 'primary' : 'secondary'}`));
			element.textContent = label;
			this.bodyStore.add(dom.addDisposableListener(element, dom.EventType.CLICK, () => run()));
		};
		button(localize('openChatButton', "Open Chat"), () => this.activeService.openChat(false), true);
		if (this.activeService.player || this.activeService.offeredWalkthrough) {
			button(localize('resumeWalkthroughButton', "Resume Walkthrough"), () => this.activeService.resumeWalkthrough());
		}
		button(localize('profileButton', "Knowledge Profile"), () => this.activeService.openProfile());
	}
}

const viewContainers = Registry.as<IViewContainersRegistry>(ViewExtensions.ViewContainersRegistry);
const viewsRegistry = Registry.as<IViewsRegistry>(ViewExtensions.ViewsRegistry);

const sessionContainer = viewContainers.registerViewContainer({
	id: ACTIVE_SESSION_CONTAINER_ID,
	title: localize2('activeSession', "Active"),
	icon: chatViewIcon,
	order: 1,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ACTIVE_SESSION_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
}, ViewContainerLocation.Sidebar);
viewsRegistry.registerViews([{ id: ACTIVE_SESSION_VIEW_ID, name: localize2('activeSessionView', "Active"), ctorDescriptor: new SyncDescriptor(ActiveSessionView), canToggleVisibility: false, canMoveView: true, containerIcon: chatViewIcon }], sessionContainer);

const historyContainer = viewContainers.registerViewContainer({
	id: ACTIVE_HISTORY_CONTAINER_ID,
	title: localize2('activeHistory', "History"),
	icon: historyViewIcon,
	order: 2,
	ctorDescriptor: new SyncDescriptor(ViewPaneContainer, [ACTIVE_HISTORY_CONTAINER_ID, { mergeViewWithContainerWhenSingleView: true }]),
}, ViewContainerLocation.Sidebar);
viewsRegistry.registerViews([{ id: ACTIVE_HISTORY_VIEW_ID, name: localize2('activeHistoryView', "History"), ctorDescriptor: new SyncDescriptor(ActiveHistoryView), canToggleVisibility: false, canMoveView: true, containerIcon: historyViewIcon }], historyContainer);

Registry.as<IExplorerFileContributionRegistry>(ExplorerExtensions.FileContributionRegistry).register(explorerChangeCountsDescriptor);
// The switch between the counts sits in a one-line bar at the top of the Explorer.
viewsRegistry.registerViews([{ id: ACTIVE_CHANGE_COUNTS_VIEW_ID, name: localize2('changeCountsView', "Changes"), ctorDescriptor: new SyncDescriptor(ChangeCountsBar), order: -1, canToggleVisibility: true, canMoveView: false }], EXPLORER_VIEW_CONTAINER);

// ---------------------------------------------------------------- actions & configurable keybindings

const category = localize2('activeCategory', "Active");

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WalkthroughCommandIds.TogglePlayback,
			title: localize2('togglePlayback', "Pause or Resume Walkthrough"),
			category,
			f1: true,
			precondition: ActiveWalkthroughAvailable,
			keybinding: [
				{ primary: KeyCode.Space, when: ActiveWalkthroughFocus, weight: KeybindingWeight.EditorContrib + 10 },
				{ primary: KeyCode.KeyK, when: ActiveWalkthroughFocus, weight: KeybindingWeight.EditorContrib + 10 },
			],
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IActiveService).player?.toggle();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WalkthroughCommandIds.Rewind,
			title: localize2('rewind', "Rewind Walkthrough"),
			category,
			f1: true,
			precondition: ActiveWalkthroughAvailable,
			keybinding: [
				{ primary: KeyCode.LeftArrow, when: ActiveWalkthroughFocus, weight: KeybindingWeight.EditorContrib + 10 },
				{ primary: KeyCode.KeyJ, when: ActiveWalkthroughFocus, weight: KeybindingWeight.EditorContrib + 10 },
			],
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IActiveService).player?.rewind();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WalkthroughCommandIds.Advance,
			title: localize2('advance', "Advance Walkthrough"),
			category,
			f1: true,
			precondition: ActiveWalkthroughAvailable,
			keybinding: [
				{ primary: KeyCode.RightArrow, when: ActiveWalkthroughFocus, weight: KeybindingWeight.EditorContrib + 10 },
				{ primary: KeyCode.KeyL, when: ActiveWalkthroughFocus, weight: KeybindingWeight.EditorContrib + 10 },
			],
		});
	}
	run(accessor: ServicesAccessor): void {
		accessor.get(IActiveService).player?.advance();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WalkthroughCommandIds.OpenChat,
			title: localize2('openChatFromWalkthrough', "Open Chat About This Walkthrough"),
			category,
			f1: true,
			precondition: ActiveWalkthroughAvailable,
			keybinding: [
				{ primary: KeyCode.KeyC, when: ActiveWalkthroughFocus, weight: KeybindingWeight.EditorContrib + 10 },
				{ primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyC), when: ActiveWalkthroughAvailable, weight: KeybindingWeight.WorkbenchContrib },
			],
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IActiveService).openChat(true);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WalkthroughCommandIds.OpenFile,
			title: localize2('openFile', "Open Current Walkthrough File"),
			category,
			f1: true,
			precondition: ActiveWalkthroughAvailable,
			keybinding: { primary: KeyCode.KeyO, when: ActiveWalkthroughFocus, weight: KeybindingWeight.EditorContrib + 10 },
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IActiveService).openCurrentFile();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: WalkthroughCommandIds.Resume,
			title: localize2('resumeWalkthrough', "Return to Walkthrough"),
			category,
			f1: true,
			precondition: ActiveWalkthroughAvailable,
			keybinding: { primary: KeyChord(KeyMod.CtrlCmd | KeyCode.KeyK, KeyCode.KeyW), when: ContextKeyExpr.and(ActiveWalkthroughAvailable, ActiveWalkthroughFocus.negate()), weight: KeybindingWeight.WorkbenchContrib },
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IActiveService).resumeWalkthrough();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ActiveCommandIds.OpenChat,
			title: localize2('openChat', "Open Chat"),
			category,
			f1: true,
			keybinding: { primary: KeyMod.CtrlCmd | KeyMod.Alt | KeyCode.KeyI, weight: KeybindingWeight.WorkbenchContrib },
		});
	}
	run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IActiveService);
		const fromWalkthrough = accessor.get(IEditorService).activeEditor instanceof WalkthroughInput;
		return service.openChat(fromWalkthrough);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: ActiveCommandIds.OpenProfile, title: localize2('openProfile', "Open Knowledge Profile"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IActiveService).openProfile();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: ActiveCommandIds.PickVoice, title: localize2('pickVoice', "Choose Narration Voice"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IActiveService).pickVoice();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: ActiveCommandIds.PickExplainMode, title: localize2('pickExplainMode', "Change Explanation Mode"), category, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IActiveService);
		const quickInput = accessor.get(IQuickInputService);
		const items: Array<IQuickPickItem & { mode: ExplainMode }> = [
			{ mode: 'auto', label: localize('pickAuto', "Auto"), detail: localize('pickAutoDetail', "Explanations pop up as each piece of work is ready.") },
			{ mode: 'away', label: localize('pickAway', "Away"), detail: localize('pickAwayDetail', "Walkthroughs wait (short notes still go to chat); switching back shows a short briefing.") },
			{ mode: 'off', label: localize('pickOff', "Off"), detail: localize('pickOffDetail', "No explanations; tasks are still saved to history.") },
		];
		const picked = await quickInput.pick(items.map(item => ({ ...item, description: item.mode === service.mode ? localize('currentMode', "current") : undefined })), { title: localize('explainModeTitle', "Explanation Mode") });
		if (picked) {
			await service.setMode(picked.mode);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: ActiveCommandIds.CatchUp, title: localize2('catchUp', "Catch Me Up"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IActiveService).catchUp();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: ActiveCommandIds.NewChat, title: localize2('newChat', "New Chat"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IActiveService).newChat();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: ActiveCommandIds.ResumeChat, title: localize2('resumeChat', "Resume Chat"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IActiveService).pickChatToResume();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: ActiveCommandIds.OpenSettings, title: localize2('openActiveSettings', "Open Settings"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IActiveService).openSettings();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: ActiveCommandIds.PickCodingEffort, title: localize2('pickCodingEffort', "Change Coding Agent Effort"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IActiveService).pickCodingEffort();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: ActiveCommandIds.OpenRecentWalkthrough, title: localize2('openRecentWalkthrough', "Open Latest Walkthrough"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IActiveService).openRecentWalkthrough();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: ActiveCommandIds.WalkthroughHistory, title: localize2('walkthroughHistory', "Replay a Walkthrough from History"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IActiveService).pickFromHistory();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: ActiveCommandIds.SignIn, title: localize2('signInToAgent', "Sign In to Coding Agent"), category, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IActiveService);
		await service.setupRestart();
		await service.openChat(false);
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: ActiveCommandIds.DeleteAllHistory,
			title: localize2('deleteAllHistory', "Delete All Saved History"),
			category,
			f1: true,
			icon: Codicon.trash,
			menu: { id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', ACTIVE_HISTORY_VIEW_ID), group: 'navigation' },
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const { confirmed } = await accessor.get(IDialogService).confirm({
			message: localize('confirmDeleteAll', "Delete all Active history for this workspace?"),
			detail: localize('confirmDeleteAllDetail', "Project files aren't affected."),
			primaryButton: localize('deleteAll', "Delete All"),
		});
		if (confirmed) {
			await accessor.get(IActiveService).deleteHistory();
		}
	}
});

// ---------------------------------------------------------------- configuration

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'chat.disableAIFeatures': true,
		'workbench.secondarySideBar.defaultVisibility': 'hidden',
		'workbench.startupEditor': 'none',
		'workbench.tips.enabled': false,
		'workbench.welcomePage.walkthroughs.openOnInstall': false,
		'workbench.layoutControl.enabled': false,
	},
}]);


// ---------------------------------------------------------------- startup & status bar

const CHAT_LAYOUT_APPLIED_KEY = 'active.startup.chatLayoutApplied';

/**
 * Starts in chat mode: chat fills the work area inside the familiar shell. The side bars and panel are
 * hidden only the first time a folder opens; after that the layout the user left is restored as usual.
 */
class ActiveStartup extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.activeStartup';

	constructor(
		@IActiveService activeService: IActiveService,
		@IEditorService editorService: IEditorService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IConfigurationService configurationService: IConfigurationService,
		@IStorageService storageService: IStorageService,
	) {
		super();
		void activeService.initialize();
		if (configurationService.getValue<boolean>('active.startWithChat') !== false) {
			if (!storageService.getBoolean(CHAT_LAYOUT_APPLIED_KEY, StorageScope.WORKSPACE, false)) {
				layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
				layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
				layoutService.setPartHidden(true, Parts.PANEL_PART);
				storageService.store(CHAT_LAYOUT_APPLIED_KEY, true, StorageScope.WORKSPACE, StorageTarget.MACHINE);
			}
			void editorService.openEditor(new ActiveChatInput(), { pinned: true });
		}
	}
}

class ActiveStatusBar extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.activeStatusBar';

	private readonly mode: IStatusbarEntryAccessor;
	private readonly activity: IStatusbarEntryAccessor;
	private readonly narration: IStatusbarEntryAccessor;

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IActiveService private readonly activeService: IActiveService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this.mode = this._register(statusbarService.addEntry(this.modeEntry(), 'active.mode', StatusbarAlignment.LEFT, 10));
		this.activity = this._register(statusbarService.addEntry(this.activityEntry(), 'active.activity', StatusbarAlignment.LEFT, 9));
		this.narration = this._register(statusbarService.addEntry(this.narrationEntry(), 'active.narration', StatusbarAlignment.RIGHT, 100));
		const update = () => {
			this.mode.update(this.modeEntry());
			this.activity.update(this.activityEntry());
			this.narration.update(this.narrationEntry());
		};
		this._register(activeService.onDidChangeAgent(update));
		this._register(activeService.onDidChangeWalkthroughStatus(update));
		this._register(activeService.onDidChangePlayer(update));
		this._register(activeService.onDidChangePlayback(update));
		this._register(activeService.onDidChangeOffer(update));
		this._register(activeService.onDidChangeNarration(update));
		this._register(activeService.onDidChangeProfile(update));
		this._register(activeService.onDidChangeMode(update));
		this._register(editorService.onDidActiveEditorChange(update));
	}

	private modeEntry() {
		const active = this.editorService.activeEditor;
		const mode = this.activeService.mode;
		const name = mode === 'away' ? localize('modeAway', "Away") : mode === 'off' ? localize('modeOff', "Explanations off") : localize('modeAuto', "Auto");
		let text = name;
		if (active instanceof WalkthroughInput) {
			const player = this.activeService.player;
			text = player?.playing ? localize('modeExplaining', "{0} · explaining", name)
				: player?.state === 'ended' ? localize('modeWalkthroughDone', "{0} · walkthrough finished", name)
					: localize('modeWalkthroughPaused', "{0} · walkthrough paused", name);
		} else if (active instanceof ActiveChatInput) {
			text = localize('modeChat', "{0} · chat open", name);
		}
		return { name: localize('activeMode', "Active Mode"), text, ariaLabel: text, tooltip: localize('modeTooltip', "How explanations are delivered. Click to change."), command: ActiveCommandIds.PickExplainMode };
	}

	private activityEntry() {
		const agent = this.activeService.agent;
		const status = this.activeService.walkthroughStatus;
		const offered = this.activeService.offeredWalkthrough;
		let text: string;
		let command: string | undefined;
		if (agent.setup) {
			text = `$(rocket) ${localize('agentSetup', "Set up {0}", agent.provider.name)}`;
			command = ActiveCommandIds.OpenChat;
		} else if (offered) {
			text = `$(play-circle) ${localize('walkthroughReadyStatus', "Walkthrough ready")}`;
			command = WalkthroughCommandIds.Resume;
		} else if (agent.status === 'running') {
			text = `$(loading~spin) ${localize('agentWorking', "{0} working", agent.provider.name)}${status?.stage === 'drafting' ? ` · ${localize('drafting', "drafting explanation")}` : ''}`;
		} else if (agent.backgroundTasks > 0) {
			text = localize('turnCompleteBackground', "Turn complete · checks running");
		} else if (status && ['waitingForBackground', 'finalizing'].includes(status.stage)) {
			text = status.detail;
		} else if (agent.status === 'unavailable') {
			text = `$(warning) ${localize('agentUnavailable', "{0} unavailable", agent.provider.name)}`;
			command = ActiveCommandIds.OpenChat;
		} else {
			text = localize('ready', "Ready for your task");
		}
		return { name: localize('activeActivity', "Active Activity"), text, ariaLabel: text, command };
	}

	private narrationEntry() {
		const narration = this.activeService.narration;
		const voice = this.activeService.narrationVoice;
		const text = narration.available
			? `$(unmute) ${voice && voice !== 'default' ? localize('narrationReadyVoice', "Phonon 31M · {0}", voice) : localize('narrationReady', "Phonon 31M · on-device")}`
			: `$(mute) ${localize('narrationOff', "Narration unavailable")}`;
		const tooltip = narration.available ? localize('narrationTooltip', "{0}. Click to change the voice.", narration.detail) : narration.detail;
		return { name: localize('activeNarration', "Active Narration"), text, ariaLabel: text, tooltip, command: ActiveCommandIds.PickVoice };
	}
}

/**
 * Floating shortcuts over the editor area: Chat whenever chat isn't showing, and
 * Walkthrough (the latest explanation) whenever a walkthrough isn't showing.
 */
/**
 * One round button at the bottom right of the editor. Hovering (or focusing) it opens a small menu upwards:
 * Walkthrough from chat, Chat from a walkthrough, both anywhere else. With one choice, clicking the circle
 * runs it; with two, clicking opens the menu (for touch and keyboard).
 */
class ActiveFloatingButtons extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.activeFloatingButtons';

	private readonly stack: HTMLElement;
	private readonly menu: HTMLElement;
	private readonly main: HTMLButtonElement;
	private readonly mainIcon: HTMLElement;
	private readonly chat: HTMLButtonElement;
	private readonly walkthrough: HTMLButtonElement;

	constructor(
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IEditorService private readonly editorService: IEditorService,
		@IActiveService private readonly activeService: IActiveService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super();
		const host = layoutService.getContainer(mainWindow, Parts.EDITOR_PART) ?? layoutService.mainContainer;
		this.stack = dom.append(host, dom.$('.active-fab-stack'));
		this._register(toDisposable(() => this.stack.remove()));
		this.menu = dom.append(this.stack, dom.$('.active-fab-menu'));
		this.menu.setAttribute('role', 'menu');
		// Top to bottom: the walkthrough sits above chat, nearest the circle.
		this.walkthrough = this.item(Codicon.playCircle, localize('fabWalkthrough', "Walkthrough"), () => this.activeService.openRecentWalkthrough());
		this.chat = this.item(Codicon.commentDiscussion, localize('fabChat', "Chat"), () => this.activeService.openChat(this.editorService.activeEditor instanceof WalkthroughInput));
		this.main = dom.append(this.stack, dom.$('button.active-fab-main')) as HTMLButtonElement;
		this.main.setAttribute('aria-haspopup', 'menu');
		this.mainIcon = dom.append(this.main, dom.$('span.icon'));
		this._register(dom.addDisposableListener(this.main, dom.EventType.CLICK, () => {
			const choices = this.choices();
			if (choices.length === 1) {
				choices[0].click();
			} else {
				this.setOpen(!this.stack.classList.contains('open'));
			}
		}));
		this._register(dom.addDisposableListener(this.stack, dom.EventType.MOUSE_LEAVE, () => this.setOpen(false)));
		this._register(dom.addDisposableListener(this.stack, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				this.setOpen(false);
				this.main.blur();
			}
		}));
		const update = () => this.update();
		this._register(editorService.onDidActiveEditorChange(update));
		this._register(activeService.onDidChangeRecentWalkthrough(update));
		this._register(activeService.onDidChangePlayer(update));
		this._register(activeService.onDidChangeHandoff(update));
		this._register(keybindingService.onDidUpdateKeybindings(update));
		this._register(activeService.onDidChangeControlsHeight(update));
		this._register(layoutService.onDidLayoutMainContainer(update));
		this.update();
	}

	private item(icon: ThemeIcon, label: string, run: () => unknown): HTMLButtonElement {
		const element = dom.append(this.menu, dom.$('button.active-fab-item')) as HTMLButtonElement;
		element.setAttribute('role', 'menuitem');
		dom.append(element, dom.$('span.label')).textContent = label;
		dom.append(element, dom.$('span.icon')).classList.add(...ThemeIcon.asClassNameArray(icon));
		this._register(dom.addDisposableListener(element, dom.EventType.CLICK, () => {
			this.setOpen(false);
			run();
		}));
		return element;
	}

	private choices(): HTMLButtonElement[] {
		return [this.walkthrough, this.chat].filter(item => !item.classList.contains('hidden'));
	}

	private setOpen(open: boolean): void {
		this.stack.classList.toggle('open', open);
		this.main.setAttribute('aria-expanded', String(open));
	}

	private update(): void {
		const active = this.editorService.activeEditor;
		const onChat = !active || active instanceof ActiveChatInput;
		const onWalkthrough = active instanceof WalkthroughInput;
		this.chat.classList.toggle('hidden', onChat);
		this.walkthrough.classList.toggle('hidden', onWalkthrough || !!this.activeService.pendingHandoff || !this.activeService.hasRecentWalkthrough);
		const choices = this.choices();
		// The cascade runs from the item nearest the circle upwards.
		choices.forEach((item, index) => item.style.setProperty('--active-fab-index', String(choices.length - 1 - index)));
		this.stack.classList.toggle('hidden', choices.length === 0);
		// Over a walkthrough the circle sits just above its playback controls.
		this.stack.style.bottom = onWalkthrough && this.activeService.controlsHeight ? `${this.activeService.controlsHeight + 14}px` : '';
		const chatKey = this.keybindingService.lookupKeybinding(onWalkthrough ? WalkthroughCommandIds.OpenChat : ActiveCommandIds.OpenChat)?.getLabel();
		this.chat.title = onWalkthrough
			? localize('fabChatFromWalkthrough', "Pause and open chat{0}", chatKey ? ` (${chatKey})` : '')
			: localize('fabChatTitle', "Open chat{0}", chatKey ? ` (${chatKey})` : '');
		const player = this.activeService.player;
		this.walkthrough.title = player
			? localize('fabWalkthroughResume', "Return to the walkthrough: {0}", player.walkthrough.title)
			: localize('fabWalkthroughLatest', "Open the latest walkthrough");
		// The circle shows the one thing it leads to, or "more" when there's a choice.
		const icon = choices.length === 1 ? (choices[0] === this.chat ? Codicon.commentDiscussion : Codicon.playCircle) : Codicon.ellipsis;
		this.mainIcon.className = 'icon';
		this.mainIcon.classList.add(...ThemeIcon.asClassNameArray(icon));
		this.main.title = choices.length === 1 ? choices[0].title : localize('fabMore', "Chat and walkthrough");
		this.main.setAttribute('aria-label', choices.length === 1 ? choices[0].textContent ?? '' : localize('fabMoreLabel', "Open chat or the walkthrough"));
		this.setOpen(false);
	}
}

registerWorkbenchContribution2(ActiveStartup.ID, ActiveStartup, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ActiveFloatingButtons.ID, ActiveFloatingButtons, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ActiveWelcomeDialog.ID, ActiveWelcomeDialog, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ActiveStatusBar.ID, ActiveStatusBar, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(AgentQuickDiff.ID, AgentQuickDiff, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(AgentDecorations.ID, AgentDecorations, WorkbenchPhase.AfterRestored);
