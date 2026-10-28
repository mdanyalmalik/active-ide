/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/active.css';
import * as dom from '../../../../base/browser/dom.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyChord, KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
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
import { ActiveEvent, WORKBENCH_EVENT_COMMAND } from '../common/activeProtocol.js';
import { ActiveChatInput, LearningProfileInput, WalkthroughInput } from './activeInputs.js';
import { ACTIVE_HISTORY_VIEW_ID, ActiveService, ActiveWalkthroughAvailable, ActiveWalkthroughFocus, IActiveService } from './activeService.js';
import { ActiveChatEditor } from './chatEditor.js';
import { explorerChangeCountsDescriptor } from './explorerStats.js';
import { ActiveHistoryView } from './historyView.js';
import { LearningProfileEditor } from './profileEditor.js';
import { ActiveCommandIds, WalkthroughCommandIds } from './walkthroughCommands.js';
import { WalkthroughEditor } from './walkthroughEditor.js';

registerSingleton(IActiveService, ActiveService, InstantiationType.Delayed);

// Extension → workbench events.
CommandsRegistry.registerCommand(WORKBENCH_EVENT_COMMAND, (accessor: ServicesAccessor, event: ActiveEvent) => accessor.get(IActiveService).handleEvent(event));

// ---------------------------------------------------------------- editors

const editorPanes = Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane);
editorPanes.registerEditorPane(EditorPaneDescriptor.create(ActiveChatEditor, ActiveChatEditor.ID, localize('activeChatEditor', "Active Chat")), [new SyncDescriptor(ActiveChatInput)]);
editorPanes.registerEditorPane(EditorPaneDescriptor.create(WalkthroughEditor, WalkthroughEditor.ID, localize('walkthroughEditor', "Active Walkthrough")), [new SyncDescriptor(WalkthroughInput)]);
editorPanes.registerEditorPane(EditorPaneDescriptor.create(LearningProfileEditor, LearningProfileEditor.ID, localize('profileEditor', "Learning Profile")), [new SyncDescriptor(LearningProfileInput)]);

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
			? localize('sessionUnavailable', "Muse Code is not connected.")
			: localize('sessionStatus', "Muse Code · {0}", agent.status);
		const button = (label: string, run: () => unknown, primary = false) => {
			const element = dom.append(this.content, dom.$(`button.${primary ? 'primary' : 'secondary'}`));
			element.textContent = label;
			this.bodyStore.add(dom.addDisposableListener(element, dom.EventType.CLICK, () => run()));
		};
		button(localize('openChatButton', "Open Chat"), () => this.activeService.openChat(false), true);
		if (this.activeService.player || this.activeService.offeredWalkthrough) {
			button(localize('resumeWalkthroughButton', "Resume Walkthrough"), () => this.activeService.resumeWalkthrough());
		}
		button(localize('profileButton', "Learning Profile"), () => this.activeService.openProfile());
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
		super({ id: ActiveCommandIds.OpenProfile, title: localize2('openProfile', "Open Learning Profile"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IActiveService).openProfile();
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
			message: localize('confirmDeleteAll', "Delete all saved Active history for this workspace?"),
			detail: localize('confirmDeleteAllDetail', "Chat, captured versions, narration scripts and scene references are removed. Project files are not affected."),
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

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'activeWorkbench',
	title: localize('activeConfigurationTitle', "Active"),
	type: 'object',
	properties: {
		'active.startWithChat': {
			type: 'boolean',
			default: true,
			scope: ConfigurationScope.APPLICATION,
			description: localize('startWithChat', "Open Active chat across the whole work area on startup."),
		},
	},
});

// ---------------------------------------------------------------- startup & status bar

/** Starts in chat mode: chat fills the work area inside the familiar shell. */
class ActiveStartup extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.activeStartup';

	constructor(
		@IActiveService activeService: IActiveService,
		@IEditorService editorService: IEditorService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IConfigurationService configurationService: IConfigurationService,
	) {
		super();
		void activeService.initialize();
		if (configurationService.getValue<boolean>('active.startWithChat') !== false) {
			layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			layoutService.setPartHidden(true, Parts.AUXILIARYBAR_PART);
			layoutService.setPartHidden(true, Parts.PANEL_PART);
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
		this._register(editorService.onDidActiveEditorChange(update));
	}

	private modeEntry() {
		const active = this.editorService.activeEditor;
		let text: string;
		if (active instanceof WalkthroughInput) {
			text = this.activeService.player?.playing ? localize('modeExplaining', "Auto · explaining") : localize('modeWalkthroughPaused', "Auto · walkthrough paused");
		} else if (active instanceof ActiveChatInput) {
			text = localize('modeChat', "Auto · chat open");
		} else {
			text = localize('modeAuto', "Auto");
		}
		return { name: localize('activeMode', "Active Mode"), text, ariaLabel: text, command: ActiveCommandIds.OpenChat };
	}

	private activityEntry() {
		const agent = this.activeService.agent;
		const status = this.activeService.walkthroughStatus;
		const offered = this.activeService.offeredWalkthrough;
		let text: string;
		let command: string | undefined;
		if (offered) {
			text = `$(play-circle) ${localize('walkthroughReadyStatus', "Walkthrough ready")}`;
			command = WalkthroughCommandIds.Resume;
		} else if (agent.status === 'running') {
			text = `$(loading~spin) ${localize('agentWorking', "Muse Code working")}${status?.stage === 'drafting' ? ` · ${localize('drafting', "drafting explanation")}` : ''}`;
		} else if (agent.backgroundTasks > 0) {
			text = localize('turnCompleteBackground', "Turn complete · background checks running");
		} else if (status && ['waitingForBackground', 'finalizing'].includes(status.stage)) {
			text = status.detail;
		} else if (agent.status === 'unavailable') {
			text = `$(warning) ${localize('museUnavailable', "Muse Code unavailable")}`;
			command = ActiveCommandIds.OpenChat;
		} else {
			text = localize('ready', "Ready for your task");
		}
		return { name: localize('activeActivity', "Active Activity"), text, ariaLabel: text, command };
	}

	private narrationEntry() {
		const narration = this.activeService.narration;
		const text = narration.available ? `$(unmute) ${localize('narrationReady', "Phonon 31M · on-device")}` : `$(mute) ${localize('narrationOff', "Narration unavailable")}`;
		return { name: localize('activeNarration', "Active Narration"), text, ariaLabel: text, tooltip: narration.detail, command: ActiveCommandIds.OpenProfile };
	}
}

registerWorkbenchContribution2(ActiveStartup.ID, ActiveStartup, WorkbenchPhase.AfterRestored);
registerWorkbenchContribution2(ActiveStatusBar.ID, ActiveStatusBar, WorkbenchPhase.AfterRestored);
