/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize, localize2 } from '../../../../nls.js';
import { Separator, SubmenuAction, toAction } from '../../../../base/common/actions.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ActiveSetting, REASONING_EFFORTS, type AgentInfo, type ChatEntry, type ExplainMode } from '../common/activeProtocol.js';
import { agentColor, agentOneLiner, agentStatus, agentStatusLabel, AgentGridView, approvalModeActions, explainModeActions, helperOf, shownAgents, formatCost, GRID_PRESETS, GridPreset, nestedUnder, OverscrollGesture, overlapMarkers, setPullProgress, topLevelOf, wheelPixels, DEFAULT_OVERSCROLL } from './agentGrid.js';
import { effortLabel } from './activeSettings.js';
import { ActiveChatInput } from './activeInputs.js';
import { DICTATE_COMMAND_ID, DictationTarget, IActiveDictationService, insertAtCursor } from './dictation.js';
import { IActiveService } from './activeService.js';
import { personColor, renderPresenceBadges, renderPresenceLegend } from './multiplayer/presence.js';
import { renderSetupPanel, SetupPanelViewState } from './setupPanel.js';

const $ = dom.$;

type ComposerMode = 'task' | 'ask';

const HANDOFF_SECONDS = 4;

/**
 * Full-work-area chat with the coding agent. Auto mode shows messages, compact tool
 * rows and approvals — never a scrolling reasoning trace.
 */
/** The chat's width from which agent cards sit in columns on both sides of the chat box. */
const SIDE_CARDS_MIN_WIDTH = 1340;

export class ActiveChatEditor extends EditorPane {
	static readonly ID = 'workbench.editor.activeChat';

	private root!: HTMLElement;
	private header!: HTMLElement;
	private scrollable!: DomScrollableElement;
	private content!: HTMLElement;
	private intro!: HTMLElement;
	private notices!: HTMLElement;
	private transcript!: HTMLElement;
	private working!: HTMLElement;
	private workingLabel!: HTMLElement;
	private workingTimer: ReturnType<typeof setInterval> | undefined;
	private runningSince: number | undefined;
	private stageLine!: HTMLElement;
	private composerContext!: HTMLElement;
	private textarea!: HTMLTextAreaElement;
	private effortButton!: HTMLButtonElement;
	private sendButton!: HTMLButtonElement;
	private micButton!: HTMLButtonElement;
	private micIcon!: HTMLElement;
	private micLabel!: HTMLElement;
	private modeLabel!: HTMLElement;
	private footerRow!: HTMLElement;
	private mode: ComposerMode = 'task';
	private readonly entryNodes = new Map<string, { node: HTMLElement; store: DisposableStore }>();
	private readonly inputStore = this._register(new DisposableStore());
	private readonly noticeStore = this._register(new DisposableStore());
	private readonly footerStore = this._register(new DisposableStore());
	private readonly handoffStore = this._register(new DisposableStore());
	private readonly headerStore = this._register(new DisposableStore());
	private readonly modeStore = this._register(new DisposableStore());
	private introLead!: HTMLElement;
	private readonly setupView: SetupPanelViewState = { showLog: false, apiKeyDraft: '' };
	private handoffCard!: HTMLElement;

	// Many agents: the list under the transcript, the grid it zooms out to, and who the composer sends to.
	private stage!: HTMLElement;
	private grid!: AgentGridView;
	private agentList!: HTMLElement;
	/** Wide screens: cards on both sides of the chat box (alternating, so both sides fill evenly). */
	private agentListRight!: HTMLElement;
	private sideBySide = false;
	private headerKey = '';
	private legend!: HTMLElement;
	private helperTimer: ReturnType<typeof setTimeout> | undefined;
	private leavingCards = new Set<string>();
	private chatPull!: HTMLElement;
	private chatPullLabel!: HTMLElement;
	private composerTarget!: HTMLButtonElement;
	private gridMode = false;
	private zooming = false;
	private readonly chatGesture = new OverscrollGesture();
	private chatPullTimer: ReturnType<typeof setTimeout> | undefined;
	private readonly agentListStore = this._register(new DisposableStore());
	/** Agents whose list row should pulse its walkthrough badge (once, as it arrives). */
	private readonly pulsing = new Set<string>();
	private targetShown: string | undefined;
	private agentListFrame: { dispose(): void } | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IActiveService private readonly activeService: IActiveService,
		@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService,
		@IOpenerService private readonly openerService: IOpenerService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@IActiveDictationService private readonly dictationService: IActiveDictationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super(ActiveChatEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, $('.active-chat'));
		this.header = dom.append(this.root, $('.active-chat-header'));
		// Multiplayer: who's in the session, in the header (it's re-placed whenever the header is redrawn).
		this.legend = $('.active-presence-legend.hidden');
		const renderLegend = () => renderPresenceLegend(this.legend, this.activeService);
		this._register(this.activeService.onDidChangePresence(renderLegend));
		this._register(this.activeService.onDidChangeAgents(renderLegend));
		renderLegend();
		this.content = $('.active-chat-content');
		this.scrollable = this._register(new DomScrollableElement(this.content, { vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Hidden, useShadows: true }));
		// The chat and the grid of all agents share the stage between the header and the dock, so zooming
		// between them never moves the composer.
		this.stage = dom.append(this.root, $('.active-chat-viewport'));
		dom.append(this.stage, this.scrollable.getDomNode()).classList.add('active-chat-scroll');
		this.grid = this._register(this.instantiationService.createInstance(AgentGridView, this.stage, {
			open: (agentId: string) => void this.zoomIn(agentId),
			layoutChanged: () => this.renderChrome(),
		}));
		this.chatPull = dom.append(this.stage, $('.active-agent-pull.bottom'));
		this.chatPull.setAttribute('aria-hidden', 'true');
		dom.append(this.chatPull, $('span.pull-icon')).classList.add(...ThemeIcon.asClassNameArray(Codicon.dashboard));
		this.chatPullLabel = dom.append(this.chatPull, $('span.pull-label'));
		this.chatPullLabel.textContent = localize('pullAllAgents', "Keep scrolling for all agents");
		dom.append(dom.append(this.chatPull, $('.pull-track')), $('.pull-bar'));
		this._register(dom.addDisposableListener(this.content, 'wheel', (event: WheelEvent) => this.onChatWheel(event), { passive: true }));
		this._register(toDisposable(() => {
			if (this.chatPullTimer !== undefined) {
				clearTimeout(this.chatPullTimer);
			}
			this.agentListFrame?.dispose();
		}));

		const column = dom.append(this.content, $('.active-chat-column'));
		this.intro = dom.append(column, $('.active-chat-intro'));
		dom.append(this.intro, $('.eyebrow')).textContent = localize('introEyebrow', "Your workspace, with Active");
		dom.append(this.intro, $('h1')).textContent = localize('introTitle', "What would you like to build?");
		this.introLead = dom.append(this.intro, $('p.lead'));
		this.notices = dom.append(column, $('.active-chat-notices'));
		this.transcript = dom.append(column, $('.active-chat-transcript'));
		// Shown while a reply is on its way and nothing else on screen says so.
		this.working = dom.append(column, $('.active-chat-working.hidden'));
		this.working.setAttribute('role', 'status');
		appendDots(this.working);
		this.workingLabel = dom.append(this.working, $('span.working-label'));
		this._register(toDisposable(() => this.stopWorkingTimer()));

		// The dock stays put below the scrolling transcript: walkthrough status, composer, actions.
		const dock = dom.append(dom.append(this.root, $('.active-chat-dock')), $('.active-chat-dock-column'));
		this.handoffCard = dom.append(dock, $('.active-chat-handoff.hidden'));
		this.stageLine = dom.append(dock, $('.active-chat-stage'));
		// The chat box and the agents: the agents sit under it, or to its left when there's room.
		const composerRow = dom.append(dock, $('.active-composer-row'));
		const composer = dom.append(composerRow, $('.active-chat-composer'));
		this.composerContext = dom.append(composer, $('.composer-context'));
		this.textarea = dom.append(composer, $('textarea')) as HTMLTextAreaElement;
		this.textarea.rows = 4;
		this._register(dom.addStandardDisposableListener(this.textarea, dom.EventType.KEY_DOWN, (event: StandardKeyboardEvent) => {
			if (event.keyCode === KeyCode.Enter && !event.shiftKey && !event.altKey) {
				event.preventDefault();
				void this.send();
			}
		}));
		this._register(dom.addDisposableListener(this.textarea, dom.EventType.INPUT, () => this.updateSendState()));
		const bar = dom.append(composer, $('.composer-bar'));
		const left = dom.append(bar, $('.composer-left'));
		// Who gets the message: always the highlighted agent. The label is all that changes between chat and grid.
		this.composerTarget = dom.append(left, $('button.composer-target.hidden')) as HTMLButtonElement;
		this._register(dom.addDisposableListener(this.composerTarget, dom.EventType.CLICK, () => this.showTargetMenu()));
		this.modeLabel = dom.append(left, $('.composer-mode'));
		this._register(this.activeService.onDidChangeMode(() => this.renderComposerContext()));
		// Joining or leaving a session, or a new role in one, changes the header and the chat box.
		this._register(this.activeService.onDidChangeRemote(() => {
			this.renderChrome();
			this.renderComposerContext();
		}));
		const tools = dom.append(bar, $('.composer-tools'));
		// The coding agent's model and effort, one click from where the task is typed.
		this.effortButton = dom.append(tools, $('button.composer-effort')) as HTMLButtonElement;
		this._register(dom.addDisposableListener(this.effortButton, dom.EventType.CLICK, () => this.showModelMenu()));
		this._register(this.activeService.onDidChangeModels(() => this.renderEffort()));
		const settings = dom.append(tools, $('button.composer-icon')) as HTMLButtonElement;
		settings.classList.add(...ThemeIcon.asClassNameArray(Codicon.settingsGear));
		settings.title = localize('chatSettings', "Active Settings: models, effort, voice");
		settings.setAttribute('aria-label', settings.title);
		this._register(dom.addDisposableListener(settings, dom.EventType.CLICK, () => this.activeService.openSettings()));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration(ActiveSetting.CodingEffort) || event.affectsConfiguration(ActiveSetting.CodingModel)) {
				this.renderEffort();
			}
		}));
		this.renderMicButton(tools);
		this.sendButton = dom.append(tools, $('button.send')) as HTMLButtonElement;
		this.sendButton.textContent = localize('send', "Send ↑");
		this._register(dom.addDisposableListener(this.sendButton, dom.EventType.CLICK, () => this.send()));

		// Every agent as a small card, under the chat box or to its left. Keep scrolling the chat for the full grid.
		this.agentList = dom.append(composerRow, $('.active-agent-list.left.hidden'));
		this.agentListRight = dom.append(composerRow, $('.active-agent-list.right.hidden'));
		this.footerRow = dom.append(dock, $('.active-chat-footer'));
		dom.append(this.intro, $('p.active-chat-tagline')).textContent = localize('tagline', "Code, visuals and narration, right in the editor.");

		this._register(this.activeService.onDidChangeChat(entry => {
			if (entry) {
				this.renderEntry(entry, true);
			} else {
				this.renderTranscript();
			}
			this.renderWorking();
		}));
		this._register(this.activeService.onDidChangeAgent(() => {
			this.renderChrome();
			this.renderWorking();
		}));
		this._register(this.activeService.onDidChangeProfile(() => this.renderNotices()));
		this._register(this.activeService.onDidChangeBriefing(() => this.renderNotices()));
		this._register(this.activeService.onDidChangeWalkthroughStatus(() => this.renderStage()));
		this._register(this.activeService.onDidChangeOffer(() => this.renderChrome()));
		this._register(this.activeService.onDidChangePlayer(() => this.renderChrome()));
		this._register(this.activeService.onDidChangeHandoff(() => this.renderHandoff()));
		// Asked from the system map: chat opens set to ask about what was picked.
		this._register(this.activeService.onDidRequestAsk(() => {
			if (this.activeService.chatContext) {
				this.mode = 'ask';
				this.renderComposerContext();
				this.textarea.focus();
			}
		}));
		this._register(toDisposable(() => this.stopCountdown()));

		this._register(this.activeService.onDidChangeAgents(() => this.scheduleAgentList()));
		this._register(this.activeService.onDidChangeAllBriefing(() => {
			if (this.gridMode) {
				this.renderChrome();
			}
		}));
		this._register(this.activeService.onDidChangeHighlight(() => {
			this.scheduleAgentList();
			this.renderComposerTarget();
		}));
		this._register(this.activeService.onDidReceiveWalkthrough(({ agentId }) => {
			this.pulsing.add(agentId);
			setTimeout(() => this.pulsing.delete(agentId), 1600);
			this.scheduleAgentList();
		}));
		// Something else asked for the grid (or for chat): follow it while showing.
		this._register(this.activeService.onDidChangeGridOpen(() => {
			if (!this.isVisible() || this.zooming) {
				return;
			}
			if (this.activeService.gridOpen && !this.gridMode) {
				void this.zoomOut();
			} else if (!this.activeService.gridOpen && this.gridMode) {
				void this.zoomIn(this.activeService.highlightedAgentId);
			}
		}));
	}

	override async setInput(input: ActiveChatInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputStore.clear();
		// Reopening chat always starts on a new coding task; asking about the walkthrough is one click away.
		this.mode = 'task';
		this.root.classList.remove('entering');
		void this.root.offsetWidth;
		this.root.classList.add('entering');
		this.renderTranscript();
		this.renderChrome();
		this.renderWorking();
		this.renderHandoff();
		this.renderAgentList();
		this.renderComposerTarget();
		// Opened by "Show All Agents": straight out to the grid once chat has laid out.
		if (this.activeService.gridOpen && !this.gridMode) {
			dom.scheduleAtNextAnimationFrame(dom.getWindow(this.root), () => void this.zoomOut());
		}
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (!visible && this.activeService.pendingHandoff) {
			// The user moved elsewhere during the countdown: offer the walkthrough instead.
			this.activeService.declineHandoff();
		}
		if (!visible && this.gridMode) {
			// Leaving (e.g. to play a walkthrough from a box) comes back to that agent's chat, not the grid.
			this.leaveGridNow();
		}
	}

	private countdownTimer: ReturnType<typeof setInterval> | undefined;
	private secondsLeft = 0;

	private stopCountdown(): void {
		if (this.countdownTimer !== undefined) {
			clearInterval(this.countdownTimer);
			this.countdownTimer = undefined;
		}
	}

	/** Announces a finished walkthrough and counts down before chat gives way to it. */
	private renderHandoff(): void {
		const walkthrough = this.activeService.pendingHandoff;
		this.handoffStore.clear();
		dom.clearNode(this.handoffCard);
		this.handoffCard.classList.toggle('hidden', !walkthrough);
		if (!walkthrough) {
			this.stopCountdown();
			this.relayoutScroll();
			return;
		}
		if (this.countdownTimer === undefined) {
			this.secondsLeft = HANDOFF_SECONDS;
			this.countdownTimer = setInterval(() => {
				if (this.textarea.value.trim()) {
					// Never interrupt someone who is typing.
					this.updateHandoffCountdown();
					return;
				}
				this.secondsLeft--;
				if (this.secondsLeft <= 0) {
					this.stopCountdown();
					void this.activeService.startHandoff();
				} else {
					this.updateHandoffCountdown();
				}
			}, 1000);
		}
		const icon = dom.append(this.handoffCard, $('span.handoff-icon'));
		icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.playCircle));
		const text = dom.append(this.handoffCard, $('.handoff-text'));
		dom.append(text, $('.handoff-title')).textContent = (walkthrough.chapter ? localize('handoffChapterTitle', "Chapter {0} ready: {1}", walkthrough.chapter, walkthrough.title) : localize('handoffTitle', "Walkthrough ready: {0}", walkthrough.title));
		dom.append(text, $('.handoff-detail'));
		const progress = dom.append(this.handoffCard, $('.handoff-progress'));
		dom.append(progress, $('.handoff-progress-bar'));
		const actions = dom.append(this.handoffCard, $('.handoff-actions'));
		const start = dom.append(actions, $('button.primary'));
		start.textContent = localize('startNow', "Start Now");
		const stay = dom.append(actions, $('button.secondary'));
		stay.textContent = localize('stayInChat', "Stay in Chat");
		this.handoffStore.add(dom.addDisposableListener(start, dom.EventType.CLICK, () => {
			this.stopCountdown();
			void this.activeService.startHandoff();
		}));
		this.handoffStore.add(dom.addDisposableListener(stay, dom.EventType.CLICK, () => {
			this.stopCountdown();
			this.activeService.declineHandoff();
		}));
		this.updateHandoffCountdown();
		this.relayoutScroll();
	}

	private updateHandoffCountdown(): void {
		// eslint-disable-next-line no-restricted-syntax
		const detail = this.handoffCard.querySelector<HTMLElement>('.handoff-detail');
		// eslint-disable-next-line no-restricted-syntax
		const bar = this.handoffCard.querySelector<HTMLElement>('.handoff-progress-bar');
		const typing = !!this.textarea.value.trim();
		if (detail) {
			detail.textContent = typing
				? localize('handoffPaused', "Paused while you type.")
				: localize('handoffCountdown', "Starting in {0}…", this.secondsLeft);
		}
		if (bar) {
			bar.style.width = `${typing ? 100 : Math.max(0, (this.secondsLeft / HANDOFF_SECONDS) * 100)}%`;
		}
		this.handoffCard.classList.toggle('paused', typing);
	}

	/** Re-measures the transcript viewport after the dock changes height. */
	private relayoutScroll(): void {
		dom.scheduleAtNextAnimationFrame(dom.getWindow(this.root), () => this.scrollable.scanDomNode());
	}

	override focus(): void {
		super.focus();
		this.textarea?.focus();
	}

	override layout(dimension: dom.Dimension): void {
		// Header and dock size themselves; the transcript viewport takes the rest (CSS flex).
		this.root.style.height = `${dimension.height}px`;
		this.root.style.width = `${dimension.width}px`;
		this.root.classList.toggle('compact', dimension.height < 560 || dimension.width < 640);
		// Room for a column of cards on each side of the (760px) chat box.
		const sideBySide = dimension.width >= SIDE_CARDS_MIN_WIDTH;
		if (sideBySide !== this.sideBySide) {
			this.sideBySide = sideBySide;
			this.root.classList.toggle('agent-cards-sides', sideBySide);
			this.renderAgentList();
		}
		this.scrollable.scanDomNode();
		this.grid.layout();
	}

	private renderChrome(): void {
		if (!this.root) {
			return;
		}
		const agent = this.activeService.agent;
		dom.clearNode(this.header);
		this.headerStore.clear();
		if (this.gridMode) {
			this.renderGridHeader();
		} else {
			this.renderChatHeader();
		}
		this.placeLegend();
		this.introLead.textContent = localize('introLead', "{0} writes the code. Active walks you through what changed.", agent.provider.name);
		this.renderNotices();
		this.renderStage();
		this.renderComposerContext();
		this.renderFooter();
		this.intro.classList.toggle('compact', this.activeService.chat.length > 0);
	}

	/** The session legend starts the header's right-hand group: before the status, or after the grid's spacer. */
	private placeLegend(): void {
		const status = this.header.querySelector(':scope > .agent-status');
		const spacer = this.header.querySelector(':scope > .header-spacer');
		if (status) {
			this.header.insertBefore(this.legend, status);
		} else if (spacer) {
			spacer.after(this.legend);
		} else {
			this.header.append(this.legend);
		}
	}

	private headerAction(icon: ThemeIcon, label: string, title: string, run: () => unknown, extraClass?: string): HTMLButtonElement {
		const button = dom.append(this.header, $('button.header-action')) as HTMLButtonElement;
		if (extraClass) {
			button.classList.add(extraClass);
		}
		dom.append(button, $('span')).classList.add(...ThemeIcon.asClassNameArray(icon));
		dom.append(button, $('span.label')).textContent = label;
		button.title = title;
		this.headerStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => run()));
		return button;
	}

	/** Starting another agent needs a git repository (for its worktree): otherwise disabled, saying why. */
	private newAgentButton(button: HTMLButtonElement): void {
		const blocker = this.activeService.multiAgentBlocker;
		button.disabled = !!blocker;
		button.title = blocker ?? localize('newAgentTitle', "Start another agent");
	}

	private renderChatHeader(): void {
		const agent = this.activeService.agent;
		const highlighted = this.activeService.highlightedAgent;
		// With several agents the header says whose chat this is.
		const many = this.activeService.agents.length > 1;
		dom.append(this.header, $('span.title')).textContent = many && highlighted
			? localize('headerTitleAgent', "{0} · {1}", highlighted.name, agent.provider.name)
			: localize('headerTitle', "{0} · {1}", agent.provider.name, agent.workspaceName || localize('noWorkspace', "no folder"));
		if (agent.account) {
			const account = dom.append(this.header, $('span.agent-account'));
			account.textContent = agent.account;
		}
		if (agent.host) {
			const host = dom.append(this.header, $('span.agent-host'));
			host.textContent = agent.host;
			host.classList.toggle('test-double', /test double/i.test(agent.host));
		}
		const status = dom.append(this.header, $(`span.agent-status.${agent.setup ? 'setup' : agent.status}`));
		status.textContent = agent.setup ? localize('statusSetup', "Setup needed") : {
			unavailable: localize('statusUnavailable', "Unavailable"),
			starting: localize('statusStarting', "Connecting…"),
			idle: localize('statusIdle', "Ready"),
			running: localize('statusRunning', "Working"),
			error: localize('statusError', "Error"),
		}[agent.status];
		// A guest is in someone else's session: say whose, and leave the host's controls to the host.
		const remote = this.activeService.remote;
		if (remote) {
			const session = dom.append(this.header, $('span.agent-session'));
			session.textContent = localize('guestSessionLabel', "{0}'s session · {1}", remote.hostName, remote.role);
			this.headerAction(Codicon.dashboard, localize('allAgents', "All Agents"), localize('allAgentsTitle', "Show all agents"), () => this.zoomOut(), 'collapsible');
			return;
		}
		// Chats are sessions: start a new one, or go back to an earlier one from this folder.
		this.headerAction(Codicon.history, localize('resumeChat', "Chats"), localize('resumeChatTitle', "Resume an earlier chat in this folder"), () => this.activeService.pickChatToResume(), 'collapsible');
		this.headerAction(Codicon.add, localize('newChat', "New Chat"), localize('newChatTitle', "Start a new chat (a new {0} session)", agent.provider.name), () => this.activeService.newChat(), 'collapsible');
		this.newAgentButton(this.headerAction(Codicon.personAdd, localize('newAgent', "New Agent"), '', () => this.activeService.newAgent(), 'collapsible'));
		this.headerAction(Codicon.dashboard, localize('allAgents', "All Agents"), localize('allAgentsTitle', "Show all agents"), () => this.zoomOut(), 'collapsible');
	}

	/** The grid's top bar: layout presets, the overflow toggle, catching up, new agents, and the way back. */
	private renderGridHeader(): void {
		const top = this.activeService.agents.filter(agent => !nestedUnder(agent));
		dom.append(this.header, $('span.title')).textContent = localize('gridTitle', "All Agents · {0}", top.length);
		const presets = dom.append(this.header, $('.agent-grid-presets'));
		presets.setAttribute('role', 'radiogroup');
		presets.setAttribute('aria-label', localize('gridPresets', "Grid layout"));
		const labels: Record<GridPreset, { label: string; title: string; icon: ThemeIcon }> = {
			auto: { label: localize('presetAuto', "Auto"), title: localize('presetAutoTitle', "Arrange boxes to fit"), icon: Codicon.editorLayout },
			columns: { label: localize('presetColumns', "Columns"), title: localize('presetColumnsTitle', "One column per agent"), icon: Codicon.splitHorizontal },
			rows: { label: localize('presetRows', "Rows"), title: localize('presetRowsTitle', "One row per agent"), icon: Codicon.splitVertical },
			focus: { label: localize('presetFocus', "Focus"), title: localize('presetFocusTitle', "Highlighted agent large"), icon: Codicon.layoutSidebarRight },
			custom: { label: localize('presetCustom', "Custom"), title: localize('presetCustomTitle', "Your arrangement: drag headers, resize from corners"), icon: Codicon.move },
		};
		for (const preset of GRID_PRESETS) {
			const button = dom.append(presets, $('button')) as HTMLButtonElement;
			dom.append(button, $('span')).classList.add(...ThemeIcon.asClassNameArray(labels[preset].icon));
			dom.append(button, $('span.label')).textContent = labels[preset].label;
			button.title = labels[preset].title;
			button.setAttribute('role', 'radio');
			button.setAttribute('aria-checked', String(this.grid.preset === preset));
			button.classList.toggle('selected', this.grid.preset === preset);
			button.disabled = preset === 'custom' && !this.grid.hasCustom;
			this.headerStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.grid.setPreset(preset)));
		}
		const overflow = this.headerAction(Codicon.arrowBoth, localize('gridOverflow', "Overflow"), this.grid.overflow
			? localize('gridOverflowOn', "Boxes extend off screen (Shift+scroll to pan). Click to fit all.")
			: localize('gridOverflowOff', "Boxes shrink to fit. Click to let them extend off screen."), () => this.grid.setOverflow(!this.grid.overflow), 'toggle');
		overflow.classList.toggle('on', this.grid.overflow);
		overflow.setAttribute('aria-pressed', String(this.grid.overflow));
		dom.append(this.header, $('span.header-spacer'));
		if (this.activeService.remote) {
			const name = this.activeService.highlightedAgent?.name;
			this.headerAction(Codicon.screenFull, name ? localize('openAgent', "Open {0}", name) : localize('backToChat', "Back to Chat"), localize('openAgentTitle', "Open the highlighted agent"), () => this.zoomIn(this.activeService.highlightedAgentId));
			return;
		}
		if (!this.activeService.allBriefing) {
			this.headerAction(Codicon.history, localize('catchUpAll', "Catch Me Up"), localize('catchUpAllTitle', "What every agent did"), () => this.activeService.catchUpAll(), 'collapsible');
		// Finished helpers fade out a few seconds after they're done; this keeps them.
		if (this.activeService.agents.some(agent => agent.kind === 'subagent' && agent.finished)) {
			const showing = this.activeService.showFinishedHelpers;
			const toggle = this.headerAction(showing ? Codicon.eye : Codicon.eyeClosed, showing ? localize('hideFinishedHelpers', "Hide Finished Helpers") : localize('showFinishedHelpers', "Show Finished Helpers"), '', () => this.activeService.setShowFinishedHelpers(!showing), 'collapsible');
			toggle.classList.toggle('active', showing);
		}
		}
		this.newAgentButton(this.headerAction(Codicon.add, localize('newAgent', "New Agent"), '', () => this.activeService.newAgent()));
		const name = this.activeService.highlightedAgent?.name;
		this.headerAction(Codicon.screenFull, name ? localize('openAgent', "Open {0}", name) : localize('backToChat', "Back to Chat"), localize('openAgentTitle', "Open the highlighted agent"), () => this.zoomIn(this.activeService.highlightedAgentId));
	}

	/** The return briefing: what happened while they were away, with the walkthroughs one click away. */
	private renderBriefing(): void {
		const state = this.activeService.briefing;
		if (!state) {
			return;
		}
		const card = dom.append(this.notices, $('.notice.briefing'));
		const hours = Math.floor(state.minutes / 60);
		const away = hours === 0
			? localize('briefingMinutes', "{0} min", state.minutes)
			: state.minutes % 60 === 0 || hours >= 6 ? localize('briefingHours', "{0} h", hours) : localize('briefingHoursMinutes', "{0} h {1} min", hours, state.minutes % 60);
		dom.append(card, $('.eyebrow')).textContent = localize('briefingEyebrow', "While you were away · {0}", away);
		const briefing = state.briefing;
		const title = dom.append(card, $('.notice-title'));
		if (!briefing) {
			const spinner = dom.append(title, $('span'));
			spinner.classList.add(...ThemeIcon.asClassNameArray(Codicon.loading), 'codicon-modifier-spin');
			dom.append(title, $('span')).textContent = localize('briefingLoading', "Catching you up…");
		} else {
			title.textContent = briefing.headline;
			const section = (label: string, items: readonly string[], kind: string) => {
				if (!items.length) {
					return;
				}
				const block = dom.append(card, $(`.briefing-section.${kind}`));
				dom.append(block, $('.briefing-label')).textContent = label;
				const list = dom.append(block, $('ul'));
				for (const item of items) {
					dom.append(list, $('li')).textContent = item;
				}
			};
			section(localize('briefingNeedsYou', "Needs you"), briefing.attention, 'attention');
			section(localize('briefingDone', "Done"), briefing.done, 'done');
			section(localize('briefingProblems', "Unresolved"), briefing.problems, 'problems');
			if (briefing.next) {
				const next = dom.append(card, $('.briefing-section.next'));
				dom.append(next, $('.briefing-label')).textContent = localize('briefingNext', "Next");
				dom.append(next, $('p')).textContent = briefing.next;
			}
		}
		if (state.items.length) {
			const list = dom.append(card, $('.briefing-walkthroughs'));
			dom.append(list, $('.briefing-label')).textContent = localize('briefingWalkthroughs', "Walkthroughs, if you want the detail");
			for (const item of state.items) {
				const row = dom.append(list, $('button.briefing-walkthrough')) as HTMLButtonElement;
				dom.append(row, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.playCircle));
				dom.append(row, $('span')).textContent = item.chapter ? localize('briefingChapter', "Chapter {0}: {1}", item.chapter, item.title) : item.title;
				row.title = item.task;
				this.noticeStore.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => this.activeService.playBriefing(item.recordId)));
			}
		}
		const actions = dom.append(card, $('.notice-actions'));
		if (state.items.length) {
			const all = dom.append(actions, $('button.primary')) as HTMLButtonElement;
			all.textContent = state.items.length === 1 ? localize('briefingPlayOne', "Play Walkthrough") : localize('briefingPlayAll', "Play All ({0})", state.items.length);
			this.noticeStore.add(dom.addDisposableListener(all, dom.EventType.CLICK, () => this.activeService.playBriefing()));
		}
		if (briefing && this.activeService.canSpeak) {
			const listen = dom.append(actions, $('button.secondary')) as HTMLButtonElement;
			const spoken = [briefing.headline, ...briefing.attention, ...briefing.done, ...briefing.problems, briefing.next].filter(Boolean).join('. ');
			// The button shows that it's reading, and stops it.
			const label = () => listen.textContent = this.activeService.speaking ? localize('briefingStopListening', "Stop Reading") : localize('briefingListen', "Read Aloud");
			label();
			this.noticeStore.add(this.activeService.onDidChangeSpeaking(label));
			this.noticeStore.add(dom.addDisposableListener(listen, dom.EventType.CLICK, () => {
				if (this.activeService.speaking) {
					this.activeService.stopSpeaking();
				} else {
					listen.textContent = localize('briefingPreparingSpeech', "Preparing…");
					void this.activeService.speak(spoken).finally(label);
				}
			}));
		}
		const dismiss = dom.append(actions, $('button.secondary')) as HTMLButtonElement;
		dismiss.textContent = localize('briefingDismiss', "Got It");
		this.noticeStore.add(dom.addDisposableListener(dismiss, dom.EventType.CLICK, () => this.activeService.dismissBriefing()));
	}

	private renderNotices(): void {
		this.noticeStore.clear();
		dom.clearNode(this.notices);
		this.renderBriefing();
		const agent = this.activeService.agent;
		if (agent.setup && !this.activeService.needsTrust) {
			renderSetupPanel(this.notices, agent.setup, agent.provider, this.setupView, () => this.renderNotices(), this.noticeStore, this.activeService, this.openerService);
		} else if (agent.status === 'unavailable' && agent.blocker) {
			const card = dom.append(this.notices, $('.notice.blocker'));
			dom.append(card, $('.notice-title')).textContent = localize('blockerTitle', "{0} is not connected", agent.provider.name);
			dom.append(card, $('pre.notice-detail')).textContent = agent.blocker;
			const actions = dom.append(card, $('.notice-actions'));
			if (this.activeService.needsTrust) {
				const trust = dom.append(actions, $('button.primary'));
				trust.textContent = localize('trustFolder', "Manage Workspace Trust");
				this.noticeStore.add(dom.addDisposableListener(trust, dom.EventType.CLICK, () => this.commandService.executeCommand('workbench.trust.manage')));
			}
			if (!this.activeService.needsTrust) {
				const reconnect = dom.append(actions, $('button.secondary'));
				reconnect.textContent = localize('reconnect', "Reconnect");
				this.noticeStore.add(dom.addDisposableListener(reconnect, dom.EventType.CLICK, () => this.activeService.reconnect()));
			}
		}
		// Until the saved profile has loaded it's the blank default: don't ask them to set up one they have.
		// (Walkthroughs aren't shared with guests, so a guest isn't asked.)
		if (this.activeService.stateLoaded && !this.activeService.profile.configured && !this.activeService.remote) {
			const card = dom.append(this.notices, $('.notice'));
			dom.append(card, $('.notice-title')).textContent = localize('profileNoticeTitle', "Personalize walkthroughs");
			dom.append(card, $('.notice-detail')).textContent = localize('profileDetail', "Tell Active what you know and how much detail you want.");
			const actions = dom.append(card, $('.notice-actions'));
			const setup = dom.append(actions, $('button.primary'));
			setup.textContent = localize('setupProfile', "Set Up Knowledge Profile");
			this.noticeStore.add(dom.addDisposableListener(setup, dom.EventType.CLICK, () => this.activeService.openProfile()));
		}
		// A paused walkthrough is reached from the floating Walkthrough button, so chat only announces new ones.
		const offered = this.activeService.offeredWalkthrough;
		if (offered) {
			const card = dom.append(this.notices, $('.notice.walkthrough'));
			dom.append(card, $('.notice-title')).textContent = offered.chapter
				? localize('chapterReadyTitle', "Chapter {0} ready: {1}", offered.chapter, offered.title)
				: localize('walkthroughReadyTitle', "Walkthrough ready: {0}", offered.title);
			const actions = dom.append(card, $('.notice-actions'));
			const play = dom.append(actions, $('button.primary'));
			play.textContent = localize('playWalkthrough', "Play Walkthrough");
			this.noticeStore.add(dom.addDisposableListener(play, dom.EventType.CLICK, () => this.activeService.openWalkthrough(offered)));
		}
		this.scrollable?.scanDomNode();
	}

	private renderStage(): void {
		const status = this.activeService.walkthroughStatus;
		const agent = this.activeService.agent;
		const parts: string[] = [];
		const quietlyWatching = status?.stage === 'collecting' && !/preparing|draft/i.test(status.detail);
		if (status && status.stage !== 'idle' && status.stage !== 'ready' && !quietlyWatching) {
			parts.push(status.detail);
		}
		if (agent.backgroundTasks > 0) {
			parts.push(localize('backgroundRunning', "{0} background task(s) still running", agent.backgroundTasks));
		}
		dom.clearNode(this.stageLine);
		const preparing = !!status && ['collecting', 'drafting', 'waitingForBackground', 'finalizing'].includes(status.stage) && (status.stage !== 'collecting' || /preparing|draft/i.test(status.detail));
		if (parts.length) {
			const icon = dom.append(this.stageLine, $('span.stage-icon'));
			icon.classList.add(...ThemeIcon.asClassNameArray(preparing ? Codicon.loading : Codicon.info));
			if (preparing) {
				icon.classList.add('codicon-modifier-spin');
			}
			const text = dom.append(this.stageLine, $('span.stage-text'));
			text.textContent = preparing ? localize('preparingWalkthrough', "Preparing a walkthrough · {0}", parts.join(' · ')) : parts.join(' · ');
		}
		this.stageLine.classList.toggle('preparing', preparing);
		this.stageLine.classList.toggle('hidden', parts.length === 0);
		this.relayoutScroll();
	}

	private renderComposerContext(): void {
		dom.clearNode(this.composerContext);
		const context = this.activeService.chatContext;
		this.composerContext.classList.toggle('hidden', !context);
		if (context) {
			const task = dom.append(this.composerContext, $('button.mode'));
			task.textContent = localize('taskMode', "New Coding Task");
			task.classList.toggle('selected', this.mode === 'task');
			const ask = dom.append(this.composerContext, $('button.mode'));
			ask.textContent = context.kind === 'mapEdit' ? localize('mapEditMode', "Describe Changes to the System Map")
				: context.kind === 'code' ? localize('askCodeMode', "Ask About {0}", context.title)
					: context.kind === 'change' ? localize('changeMode', "Request a Change · Using {0}", context.title)
						: localize('askMode', "Ask About “{0}”", context.title);
			if (context.kind === 'code' || context.kind === 'change') {
				ask.title = `${context.code.file}:${context.code.startLine}${context.code.endLine !== context.code.startLine ? `-${context.code.endLine}` : ''}`;
			}
			ask.classList.toggle('selected', this.mode === 'ask');
			this.inputStore.add(dom.addDisposableListener(ask, dom.EventType.CLICK, () => { this.mode = 'ask'; this.renderComposerContext(); }));
			this.inputStore.add(dom.addDisposableListener(task, dom.EventType.CLICK, () => { this.mode = 'task'; this.renderComposerContext(); }));
		} else {
			this.mode = 'task';
		}
		const kind = this.activeService.chatContext?.kind;
		this.sendButton.textContent = this.mode === 'ask' && kind !== 'mapEdit' && kind !== 'change' ? localize('askSend', "Ask ↑") : localize('send', "Send ↑");
		this.renderExplainMode();
		const highlighted = this.activeService.highlightedAgent;
		this.textarea.placeholder = this.mode !== 'ask' && highlighted?.kind === 'subagent' ? localize('subagentPlaceholder', "Message {0}…", highlighted.name)
			: this.mode !== 'ask' ? localize('taskPlaceholder', "Describe a coding task…")
			: kind === 'mapEdit' ? localize('mapEditPlaceholder', "Describe how to restructure the map: split or merge parts, regroup them, change the level of detail…")
				: kind === 'map' ? localize('askMapPlaceholder', "Ask about these parts of the system…")
					: kind === 'code' ? localize('askCodePlaceholder', "Ask about this code…")
						: kind === 'change' ? localize('changePlaceholder', "Describe a change: here, or elsewhere with this code as context…")
							: localize('askPlaceholder', "Ask about this part…");
		const remote = this.activeService.remote;
		if (remote?.role === 'viewer') {
			this.textarea.placeholder = localize('viewerPlaceholder', "You're watching {0}'s session. Ask them to make you a collaborator to send messages.", remote.hostName);
		}
		this.textarea.disabled = remote?.role === 'viewer';
		this.renderMicState();
		this.renderEffort();
		this.updateSendState();
	}

	/** Bottom left of the chat box: how explanations are delivered (Auto, Away, Off), changeable in place. */
	private renderExplainMode(): void {
		this.modeStore.clear();
		dom.clearNode(this.modeLabel);
		const kind = this.activeService.chatContext?.kind;
		// A subagent's work is explained as part of its parent's: no explanation mode to show. Guests get no explanations.
		if (this.activeService.highlightedAgent?.kind === 'subagent' || this.activeService.remote) {
			return;
		}
		// A change request is a coding task, so how its work gets explained still applies.
		if (this.mode === 'ask' && kind !== 'change') {
			this.modeLabel.textContent = kind === 'code' ? localize('codeQuestionSession', "Asking about code") : kind === 'mapEdit' ? localize('mapEditSession', "Changing the system map") : kind === 'map' ? localize('mapQuestionSession', "Asking about the system map") : localize('explanationSession', "Asking about the walkthrough");
			return;
		}
		const modes: Array<{ id: ExplainMode; label: string; detail: string; icon: ThemeIcon }> = [
			{ id: 'auto', label: localize('explainAuto', "Auto"), detail: localize('explainAutoDetail', "Explain as work finishes"), icon: Codicon.playCircle },
			{ id: 'away', label: localize('explainAway', "Away"), detail: localize('explainAwayDetail', "Hold walkthroughs and brief me when I'm back; short notes still go to chat"), icon: Codicon.history },
			{ id: 'off', label: localize('explainOff', "Off"), detail: localize('explainOffDetail', "Don't explain"), icon: Codicon.circleSlash },
		];
		const current = modes.find(mode => mode.id === this.activeService.mode) ?? modes[0];
		const button = dom.append(this.modeLabel, $('button.composer-explain-mode')) as HTMLButtonElement;
		button.classList.add(current.id);
		dom.append(button, $('span')).classList.add(...ThemeIcon.asClassNameArray(current.icon));
		// Labelled like the status bar's mode, since the chat box has other buttons now.
		dom.append(button, $('span')).textContent = localize('explainModeButton', "Explanations: {0}", current.label);
		dom.append(button, $('span.chevron')).classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));
		button.title = localize('explainModeTitle', "Explanations: {0}. Click to change.", current.detail);
		this.modeStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
			this.contextMenuService.showContextMenu({
				getAnchor: () => button,
				getActions: () => modes.map(mode => toAction({
					id: `active.explainMode.${mode.id}`,
					label: `${mode.label} — ${mode.detail}`,
					checked: mode.id === current.id,
					run: () => this.activeService.setMode(mode.id),
				})),
			});
		}));
	}

	/** The model button: the coding agent's model and effort. */
	private renderEffort(): void {
		const effort = this.activeService.codingEffort;
		const model = this.activeService.codingModel;
		dom.clearNode(this.effortButton);
		dom.append(this.effortButton, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.sparkle));
		dom.append(this.effortButton, $('span')).textContent = localize('modelButton', "{0} · {1}", model?.label ?? localize('defaultModelLabel', "Default model"), this.effortText(effort, model?.defaultEffort));
		dom.append(this.effortButton, $('span.chevron')).classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));
		this.effortButton.title = localize('modelTitle', "The model {0} writes code with and how much it reasons before acting. Click to change.", this.activeService.agent.provider.name);
		// These apply to coding tasks; questions use the explanation model's settings. A guest's tasks run with the host's.
		this.effortButton.classList.toggle('hidden', this.mode === 'ask' || !!this.activeService.remote);
	}

	private effortText(effort: string, modelDefault: string | undefined): string {
		return effort === 'default' && modelDefault ? localize('effortDefaultIs', "Default ({0})", effortLabel(modelDefault)) : effortLabel(effort);
	}

	/** Models with their prices, then an Effort submenu with the tiers the chosen model offers. */
	private showModelMenu(): void {
		const current = this.activeService.codingModel;
		const effort = this.activeService.codingEffort;
		const models = this.activeService.models.map(model => toAction({
			id: `active.codingModel.${model.id}`,
			label: model.inputCost && model.outputCost ? localize('modelMenuItem', "{0}  (${1} / ${2})", model.label, model.inputCost, model.outputCost) : model.label,
			tooltip: model.description,
			checked: model.id === current?.id,
			run: () => this.activeService.setCodingModel(model.id),
		}));
		const tiers = ['default', ...REASONING_EFFORTS.filter(tier => !current?.efforts.length || current.efforts.includes(tier))];
		const efforts = tiers.map(tier => toAction({
			id: `active.codingEffort.${tier}`,
			label: this.effortText(tier, current?.defaultEffort),
			checked: tier === effort,
			run: () => this.activeService.setCodingEffort(tier),
		}));
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.effortButton,
			getActions: () => [
				...models,
				new Separator(),
				new SubmenuAction('active.codingEffort', localize('effortMenu', "Effort: {0}", this.effortText(effort, current?.defaultEffort)), efforts),
			],
		});
	}

	private renderFooter(): void {
		this.footerStore.clear();
		dom.clearNode(this.footerRow);
		// The profile shapes walkthroughs, which guests don't get.
		if (this.activeService.remote) {
			return;
		}
		const profile = dom.append(this.footerRow, $('button.link'));
		profile.textContent = localize('knowledgeProfile', "Knowledge Profile");
		this.footerStore.add(dom.addDisposableListener(profile, dom.EventType.CLICK, () => this.activeService.openProfile()));
	}

	// ----------------------------------------------------------------- agents: list, target, grid

	private scheduleAgentList(): void {
		// Agents change with every background event: render the list (and the target label) once a frame at most.
		this.agentListFrame ??= dom.scheduleAtNextAnimationFrame(dom.getWindow(this.root), () => {
			this.agentListFrame = undefined;
			this.renderAgentList();
			this.renderComposerTarget();
			// The grid's top bar shows the agent count and the finished-helpers toggle: redo it when those change.
			const agents = this.activeService.agents;
			const headerKey = `${this.activeService.remote?.role ?? ''}/${agents.filter(agent => !nestedUnder(agent)).length}/${agents.some(agent => agent.kind === 'subagent' && agent.finished)}/${this.activeService.showFinishedHelpers}`;
			if (headerKey !== this.headerKey) {
				this.headerKey = headerKey;
				this.renderChrome();
			}
		});
	}

	/** One row per agent, nested ones indented under theirs; a click switches the chat in place. */
	private renderAgentList(): void {
		this.agentListStore.clear();
		dom.clearNode(this.agentList);
		dom.clearNode(this.agentListRight);
		// Compact: only with more than one agent, one short line each; finished helpers stay in the grid.
		// Every agent and subagent (subagents are agents you can open and message too); merged ones live in the grid.
		const all = this.activeService.agents;
		const { shown, leaving, next } = shownAgents(all, this.activeService.highlightedAgentId, this.activeService.showFinishedHelpers);
		const agents = shown.filter(agent => !agent.mergedInto);
		// Re-render when the next finished helper starts or finishes fading out.
		clearTimeout(this.helperTimer);
		if (next !== undefined) {
			this.helperTimer = setTimeout(() => this.scheduleAgentList(), Math.max(0, next - Date.now()) + 16);
		}
		this.agentList.classList.toggle('hidden', agents.length < 2);
		this.agentListRight.classList.toggle('hidden', agents.length < 2 || !this.sideBySide);
		if (this.agentList.classList.contains('hidden')) {
			return;
		}
		this.leavingCards = leaving;
		const highlighted = this.activeService.highlightedAgentId;
		// Side by side, each agent stays with its helpers: whole groups go to whichever side has fewer cards, so both
		// columns grow together.
		const groups: AgentInfo[][] = [];
		for (const agent of agents) {
			// (With one top-level agent its helpers are peers: each card counts on its own.)
			const group = agent.kind === 'subagent' && helperOf(agent, all) ? groups.find(candidate => candidate[0].id === agent.parentId) : undefined;
			if (group) {
				group.push(agent);
			} else {
				groups.push([agent]);
			}
		}
		let left = 0;
		let right = 0;
		for (const group of groups) {
			const toRight = this.sideBySide && right < left;
			for (const agent of group) {
				this.renderAgentRow(agent, all, highlighted === agent.id, toRight ? this.agentListRight : this.agentList);
			}
			if (toRight) {
				right += group.length;
			} else {
				left += group.length;
			}
		}
		// The highlighted agent's card stays in view when a column scrolls.
		const current = [this.agentList, this.agentListRight].map(list => list.querySelector<HTMLElement>('.active-agent-row.highlighted')).find(Boolean);
		current?.scrollIntoView({ block: 'nearest' });
		for (const list of [this.agentList, this.agentListRight]) {
			const mark = () => list.classList.toggle('overflowing', list.scrollTop > 2);
			mark();
			this.agentListStore.add(dom.addDisposableListener(list, dom.EventType.SCROLL, mark));
		}
		this.scrollable.scanDomNode();
	}

	private renderAgentRow(agent: AgentInfo, agents: readonly AgentInfo[], highlighted: boolean, list: HTMLElement): void {
		// With several top-level agents a subagent's card is marked as a helper; with one, it's just another agent.
		const nested = agent.kind === 'subagent' && !!helperOf(agent, agents);
		const row = dom.append(list, $('.active-agent-row'));
		row.tabIndex = 0;
		row.setAttribute('role', 'button');
		row.classList.toggle('nested', nested);
		row.classList.toggle('highlighted', highlighted);
		row.classList.toggle('leaving', this.leavingCards.has(agent.id));
		const status = agentStatus(agent);
		row.dataset.status = status;
		row.style.setProperty('--agent-color', agentColor(agent));
		dom.append(row, $('span.agent-dot'));
		dom.append(row, $('span.row-name')).textContent = agent.name;
		renderPresenceBadges(row, this.activeService, agent.id);
		const helper = helperOf(agent, agents);
		if (helper) {
			row.title = helper;
		}
		// Second line: what it's doing (or its status), and what it has cost.
		const line = agentOneLiner(agent) || agentStatusLabel(agent, agents, this.activeService.canApprove);
		const cost = formatCost(agent.cost);
		const lineNode = dom.append(row, $('span.row-line'));
		lineNode.textContent = cost ? `${line} · ${cost}` : line;
		lineNode.title = line;
		const meta = dom.append(row, $('.row-meta'));
		const ready = this.activeService.readyWalkthroughs(agent.id);
		if (ready.length) {
			const badge = dom.append(meta, $('button.agent-ready-badge')) as HTMLButtonElement;
			dom.append(badge, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.playCircle));
			dom.append(badge, $('span')).textContent = ready.length === 1 ? localize('rowReady', "Ready") : String(ready.length);
			badge.title = localize('rowReadyTitle', "Walkthrough ready: {0}. Click to play.", ready.map(walkthrough => walkthrough.title).join(', '));
			badge.classList.toggle('pulse', this.pulsing.has(agent.id));
			this.agentListStore.add(dom.addDisposableListener(badge, dom.EventType.CLICK, event => {
				event.stopPropagation();
				void this.activeService.playReady(agent.id);
			}));
		}
		for (const marker of overlapMarkers(agent.id, this.activeService.overlaps)) {
			const other = this.activeService.agentInfo(marker.otherId);
			const icon = dom.append(meta, $(`span.agent-row-overlap${marker.conflict ? '.conflict' : ''}`));
			icon.classList.add(...ThemeIcon.asClassNameArray(marker.conflict ? Codicon.warning : Codicon.gitCompare));
			icon.style.color = marker.conflict ? 'var(--vscode-editorWarning-foreground)' : agentColor(other);
			icon.title = `${marker.conflict ? localize('rowConflict', "Likely conflict with {0}", other?.name ?? marker.otherId) : localize('rowOverlap', "Also changed by {0}", other?.name ?? marker.otherId)}\n${marker.files.join('\n')}`;
		}
		row.setAttribute('aria-label', localize('rowAria', "{0}, {1}", agent.name, agentStatusLabel(agent, agents, this.activeService.canApprove)));
		const select = () => this.activeService.highlightAgent(agent.id);
		this.agentListStore.add(dom.addDisposableListener(row, dom.EventType.CLICK, select));
		// Right-click: this agent's explanation and approval modes (the host's to set).
		if (agent.kind === 'agent' && !this.activeService.remote) {
			this.agentListStore.add(dom.addDisposableListener(row, dom.EventType.CONTEXT_MENU, (event: MouseEvent) => {
				event.preventDefault();
				this.contextMenuService.showContextMenu({ getAnchor: () => ({ x: event.clientX, y: event.clientY }), getActions: () => [explainModeActions(this.activeService, agent.id), approvalModeActions(this.activeService, agent)] });
			}));
		}
		this.agentListStore.add(dom.addStandardDisposableListener(row, dom.EventType.KEY_DOWN, (event: StandardKeyboardEvent) => {
			if (event.keyCode === KeyCode.Enter || event.keyCode === KeyCode.Space) {
				event.preventDefault();
				select();
			}
		}));
	}

	/** "To: <agent>" in the composer, shown once there's more than one agent (or in the grid). */
	private renderComposerTarget(): void {
		const agent = this.activeService.highlightedAgent;
		const visible = !!agent && (this.gridMode || this.activeService.agents.length > 1);
		this.composerTarget.classList.toggle('hidden', !visible);
		if (!agent || !visible) {
			this.targetShown = undefined;
			return;
		}
		const changed = this.targetShown !== undefined && this.targetShown !== agent.id;
		this.targetShown = agent.id;
		dom.clearNode(this.composerTarget);
		this.composerTarget.style.setProperty('--agent-color', agentColor(agent));
		dom.append(this.composerTarget, $('span.target-to')).textContent = localize('composerTo', "To:");
		dom.append(this.composerTarget, $('span.agent-dot'));
		const name = dom.append(this.composerTarget, $('span.target-name'));
		name.textContent = agent.name;
		name.classList.toggle('changed', changed);
		dom.append(this.composerTarget, $('span.chevron')).classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));
		this.composerTarget.title = localize('composerToTitle', "Messages go to {0}", agent.name);
	}

	private showTargetMenu(): void {
		const agents = this.activeService.agents;
		this.contextMenuService.showContextMenu({
			getAnchor: () => this.composerTarget,
			getActions: () => agents.map(agent => toAction({
				id: `active.composerTarget.${agent.id}`,
				label: topLevelOf(agent, agents).id === agent.id ? agent.name : `    ${agent.name}`,
				checked: agent.id === this.activeService.highlightedAgentId,
				run: () => this.activeService.highlightAgent(agent.id),
			})),
		});
	}

	/** Past the end of the chat, more scrolling pulls out to the grid (never the momentum that reached the end). */
	private onChatWheel(event: WheelEvent): void {
		if (this.gridMode || this.zooming || event.shiftKey || Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
			return;
		}
		const { scrollTop } = this.scrollable.getScrollPosition();
		const { height, scrollHeight } = this.scrollable.getScrollDimensions();
		const step = this.chatGesture.wheel(wheelPixels(event, 'y'), scrollTop + height >= scrollHeight - 2, Date.now());
		this.setChatPull(step.progress);
		if (step.committed) {
			void this.zoomOut();
		}
	}

	private setChatPull(progress: number): void {
		setPullProgress(this.chatPull, progress);
		const scroll = this.scrollable.getDomNode();
		scroll.style.setProperty('--pull', String(progress));
		scroll.classList.toggle('pulling', progress > 0);
		scroll.classList.toggle('released', progress === 0);
		if (this.chatPullTimer !== undefined) {
			clearTimeout(this.chatPullTimer);
			this.chatPullTimer = undefined;
		}
		if (progress > 0 && progress < 1) {
			// Stopping short lets go: the indicator sinks back.
			this.chatPullTimer = setTimeout(() => this.setChatPull(this.chatGesture.idle(Date.now())), DEFAULT_OVERSCROLL.releaseMs + 20);
		}
	}

	/** Zoom out: the chat shrinks into its agent's box while the other boxes fade in around it. */
	private async zoomOut(): Promise<void> {
		if (this.gridMode || this.zooming) {
			return;
		}
		this.gridMode = true;
		this.activeService.setGridOpen(true);
		this.grid.show();
		this.grid.revealFocus();
		this.renderChrome();
		this.renderComposerTarget();
		const scroll = this.scrollable.getDomNode();
		// The pull's lean is the start of the zoom; drop it without a transition so the two don't fight.
		scroll.classList.remove('pulling', 'released');
		setPullProgress(this.chatPull, 0);
		await this.runZoom('out', () => this.root.classList.add('grid-mode'));
		this.grid.focus();
	}

	/** Zoom in: the reverse, from the agent's box to its full-screen chat. */
	private async zoomIn(agentId: string): Promise<void> {
		if (!this.gridMode || this.zooming) {
			return;
		}
		this.activeService.highlightAgent(agentId);
		this.grid.revealFocus();
		this.gridMode = false;
		await this.runZoom('in', () => {
			this.root.classList.remove('grid-mode');
			this.renderChrome();
			this.renderComposerTarget();
		});
		this.grid.hide();
		this.chatGesture.block(Date.now());
		// After the highlight, so opening an agent left alone for a while starts with its short catch-up.
		this.activeService.setGridOpen(false);
		this.textarea.focus();
	}

	/** Out of the grid at once (the editor is being hidden). */
	private leaveGridNow(): void {
		this.gridMode = false;
		this.root.classList.remove('grid-mode', 'zooming');
		this.grid.hide();
		this.activeService.setGridOpen(false);
		this.renderChrome();
		this.renderComposerTarget();
	}

	/**
	 * FLIP between the full-screen chat (the stage) and the highlighted agent's box: both get the same transform
	 * path, the chat fading out as the box fades in (or the reverse), the other boxes scaling in around it.
	 * Reduced motion: a cross-fade.
	 */
	private async runZoom(direction: 'in' | 'out', swap: () => void): Promise<void> {
		this.zooming = true;
		this.root.classList.add('zooming');
		const scroll = this.scrollable.getDomNode();
		const grid = this.grid.element;
		const target = this.grid.focusElement();
		const animations: Animation[] = [];
		const out = direction === 'out';
		const stage = this.stage.getBoundingClientRect();
		const box = target?.getBoundingClientRect();
		if (this.accessibilityService.isMotionReduced() || !target || !box || !box.width || !box.height || !stage.width || !stage.height) {
			const fade = { duration: 180, easing: 'ease', fill: 'both' as const };
			animations.push(scroll.animate({ opacity: out ? [1, 0] : [0, 1] }, fade));
			animations.push(grid.animate({ opacity: out ? [0, 1] : [1, 0] }, fade));
		} else {
			const duration = out ? 460 : 420;
			const easing = 'cubic-bezier(0.2, 0.7, 0.2, 1)';
			const tx = box.left - stage.left;
			const ty = box.top - stage.top;
			const sx = box.width / stage.width;
			const sy = box.height / stage.height;
			const shrunk = `translate(${tx}px, ${ty}px) scale(${sx}, ${sy})`;
			// The box's inverse: from its own top-left corner, scaled up to cover the stage.
			const grown = `translate(${-tx}px, ${-ty}px) scale(${1 / sx}, ${1 / sy})`;
			const move = { duration, easing, fill: 'both' as const };
			animations.push(scroll.animate({ transform: out ? ['none', shrunk] : [shrunk, 'none'], transformOrigin: ['0 0', '0 0'] }, move));
			animations.push(target.animate({ transform: out ? [grown, 'none'] : ['none', grown], transformOrigin: ['0 0', '0 0'] }, move));
			// Cross-fade the transcript and the box's compact content while they travel together.
			animations.push(scroll.animate({ opacity: out ? [1, 0] : [0, 1] }, { duration: duration * 0.6, delay: out ? duration * 0.1 : duration * 0.3, easing: 'ease', fill: 'both' }));
			animations.push(target.animate({ opacity: out ? [0, 1] : [1, 0] }, { duration: duration * 0.6, delay: out ? duration * 0.3 : 0, easing: 'ease', fill: 'both' }));
			// The other boxes scale and fade in around it, nearest first (or all out together).
			const centre = { x: box.left + box.width / 2, y: box.top + box.height / 2 };
			const others = this.grid.otherElements().map(node => {
				const rect = node.getBoundingClientRect();
				return { node, distance: Math.hypot(rect.left + rect.width / 2 - centre.x, rect.top + rect.height / 2 - centre.y) };
			}).sort((a, b) => a.distance - b.distance);
			others.forEach(({ node }, index) => animations.push(node.animate(
				{ opacity: out ? [0, 1] : [1, 0], transform: out ? ['scale(0.9)', 'none'] : ['none', 'scale(0.94)'] },
				{ duration: out ? 380 : 240, delay: out ? 90 + Math.min(index, 8) * 30 : 0, easing, fill: 'both' },
			)));
			const briefing = this.grid.briefingElement;
			if (briefing) {
				animations.push(briefing.animate({ opacity: out ? [0, 1] : [1, 0] }, { duration: 260, delay: out ? 200 : 0, fill: 'both' }));
			}
		}
		swap();
		await Promise.all(animations.map(animation => animation.finished.catch(() => undefined)));
		for (const animation of animations) {
			animation.cancel();
		}
		this.root.classList.remove('zooming');
		this.zooming = false;
	}

	/** Push-to-talk: press and hold to talk, or click to start and click again to stop. */
	private renderMicButton(tools: HTMLElement): void {
		this.micButton = dom.append(tools, $('button.composer-mic')) as HTMLButtonElement;
		this.micIcon = dom.append(this.micButton, $('span.mic-icon'));
		this.micLabel = dom.append(this.micButton, $('span.mic-label'));
		const target: DictationTarget = {
			window: dom.getWindow(this.root),
			canDictate: () => this.activeService.remote?.role !== 'viewer',
			isVisible: () => this.isVisible() && !this.gridMode,
			textBeforeCursor: () => this.textarea.value.slice(0, this.textarea.selectionStart),
			insert: text => this.insertDictation(text),
		};
		this._register(this.dictationService.registerTarget(target));
		this._register(dom.addDisposableListener(this.textarea, dom.EventType.FOCUS, () => this.dictationService.preferTarget(target)));
		let release: (() => void) | undefined;
		this._register(dom.addDisposableListener(this.micButton, dom.EventType.POINTER_DOWN, (event: PointerEvent) => {
			if (event.button !== 0 || this.micButton.disabled) {
				return;
			}
			event.preventDefault(); // keep the cursor where it is in the chat box
			this.micButton.setPointerCapture(event.pointerId);
			release = this.dictationService.press(target);
		}));
		const up = () => {
			release?.();
			release = undefined;
		};
		this._register(dom.addDisposableListener(this.micButton, dom.EventType.POINTER_UP, up));
		this._register(dom.addDisposableListener(this.micButton, 'pointercancel', up));
		// Keyboard (Enter or Space on the focused button): a click that toggles.
		this._register(dom.addDisposableListener(this.micButton, dom.EventType.CLICK, (event: MouseEvent) => {
			if (event.detail === 0) {
				this.dictationService.press(target);
			}
		}));
		this._register(this.dictationService.onDidChangeState(() => this.renderMicState()));
		this._register(this.keybindingService.onDidUpdateKeybindings(() => this.renderMicState()));
		this.renderMicState();
	}

	private renderMicState(): void {
		if (!this.micButton) {
			return;
		}
		const state = this.dictationService.state;
		const mine = this.dictationService.target?.isVisible() ?? false;
		const shown = mine ? state : 'idle';
		this.micIcon.className = `mic-icon ${ThemeIcon.asClassName(shown === 'transcribing' ? ThemeIcon.modify(Codicon.loading, 'spin') : shown === 'recording' ? Codicon.micFilled : Codicon.mic)}`;
		this.micLabel.textContent = shown === 'recording' ? localize('micListening', "Listening") : shown === 'transcribing' ? localize('micTranscribing', "Transcribing") : '';
		this.micButton.classList.toggle('recording', shown === 'recording');
		this.micButton.classList.toggle('transcribing', shown === 'transcribing');
		this.micButton.disabled = this.activeService.remote?.role === 'viewer' || shown === 'transcribing';
		const key = this.keybindingService.lookupKeybinding(DICTATE_COMMAND_ID)?.getLabel();
		this.micButton.title = shown === 'recording'
			? localize('micStopTitle', "Release or click to stop (Escape)")
			: key ? localize('micTitleKey', "Dictate: hold to talk, or click to start and stop ({0})", key) : localize('micTitle', "Dictate: hold to talk, or click to start and stop");
		this.micButton.setAttribute('aria-label', shown === 'recording' ? localize('micStopLabel', "Stop dictation") : localize('micLabel', "Dictate"));
		this.micButton.setAttribute('aria-pressed', String(shown === 'recording'));
	}

	private insertDictation(text: string): void {
		const { value, cursor } = insertAtCursor(this.textarea.value, this.textarea.selectionStart, this.textarea.selectionEnd, text);
		this.textarea.value = value;
		this.textarea.focus();
		this.textarea.setSelectionRange(cursor, cursor);
		this.updateSendState();
		this.updateHandoffCountdown();
	}

	private updateSendState(): void {
		const agent = this.activeService.agent;
		const empty = !this.textarea.value.trim();
		const codingTask = this.mode === 'task' || this.activeService.chatContext?.kind === 'change';
		this.sendButton.disabled = empty || this.activeService.remote?.role === 'viewer' || (codingTask && (agent.status === 'starting' || !!agent.setup));
	}

	private async send(): Promise<void> {
		const text = this.textarea.value.trim();
		if (!text) {
			return;
		}
		this.textarea.value = '';
		this.updateSendState();
		const context = this.activeService.chatContext;
		if (this.mode === 'ask' && context?.kind === 'mapEdit') {
			await this.activeService.editDiagram(text);
		} else if (this.mode === 'ask' && context?.kind === 'code') {
			await this.activeService.ask({ question: text, code: context.code });
		} else if (this.mode === 'ask' && context?.kind === 'change') {
			await this.activeService.submitTask({ text, code: context.code, ...(context.explanation ? { explanation: context.explanation } : {}) });
		} else if (this.mode === 'ask' && context?.kind === 'map') {
			await this.activeService.ask({ question: text, map: context.selection });
		} else if (this.mode === 'ask' && context?.kind === 'walkthrough') {
			await this.activeService.ask({ question: text, walkthroughId: context.walkthroughId, sceneId: context.sceneId, segment: context.segment });
		} else {
			await this.activeService.submitTask(text);
		}
	}

	// ----------------------------------------------------------------- transcript

	private renderTranscript(): void {
		for (const { store } of this.entryNodes.values()) {
			store.dispose();
		}
		this.entryNodes.clear();
		dom.clearNode(this.transcript);
		for (const entry of this.activeService.chat) {
			this.renderEntry(entry, false);
		}
		this.intro.classList.toggle('compact', this.activeService.chat.length > 0);
		this.revealBottom();
	}

	private renderEntry(entry: ChatEntry, reveal: boolean): void {
		let slot = this.entryNodes.get(entry.id);
		if (!slot) {
			slot = { node: dom.append(this.transcript, $('.entry')), store: new DisposableStore() };
			this.entryNodes.set(entry.id, slot);
			this._register(slot.store);
		}
		slot.store.clear();
		const node = slot.node;
		dom.clearNode(node);
		node.className = `entry ${entry.role}${entry.status ? ` status-${entry.status}` : ''}`;
		const eyebrow = (text: string) => { dom.append(node, $('.eyebrow')).textContent = text; };
		switch (entry.role) {
			case 'user':
				// In a session, a guest's message carries their name and colour.
				if (entry.author && entry.author.id !== this.activeService.presenceSelfId) {
					node.classList.add('by-person');
					node.style.setProperty('--person-color', personColor(entry.author.colorIndex));
					eyebrow(entry.status === 'queued' ? localize('personQueued', "{0} · queued", entry.author.name) : entry.author.name);
					dom.append(node, $('.text')).textContent = entry.text;
					break;
				}
				eyebrow(entry.about
					? (entry.status === 'queued' ? localize('youQueuedChange', "You · task using {0} · queued", entry.about) : localize('youChange', "You · task using {0}", entry.about))
					: entry.status === 'queued' ? localize('youQueued', "You · queued") : localize('you', "You"));
				dom.append(node, $('.text')).textContent = entry.text;
				break;
			case 'question':
				eyebrow(entry.mapEdit ? localize('youMapEdit', "You · change to the system map") : entry.about && entry.aboutCode ? localize('youAskCode', "You · about {0}", entry.about) : entry.about ? localize('youAskMap', "You · about {0} on the system map", entry.about) : localize('youAsk', "You · about the walkthrough"));
				dom.append(node, $('.text')).textContent = entry.text;
				break;
			case 'agent':
			case 'explainer': {
				// Notes are the explainer's short take on a small change, in place of a walkthrough.
				eyebrow(entry.role === 'agent' ? this.activeService.agent.provider.shortName : entry.id.startsWith('note') ? localize('explainerNote', "Active · note") : localize('explainer', "Active · explanation"));
				const body = dom.append(node, $('.text.markdown'));
				if (entry.text) {
					const rendered = slot.store.add(this.markdownRenderer.render(new MarkdownString(escapeIdentifierUnderscores(entry.text))));
					body.appendChild(rendered.element);
				} else if (entry.status === 'streaming') {
					appendDots(body);
				}
				if (entry.role === 'explainer' && entry.id.startsWith('note') && entry.text) {
					this.renderNoteActions(node, entry, slot.store);
				}
				break;
			}
			case 'tool': {
				const icon = dom.append(node, $('span.tool-icon'));
				const done = entry.status === 'completed';
				const failed = entry.status && TOOL_FAILED.includes(entry.status);
				icon.classList.add(...ThemeIcon.asClassNameArray(done ? Codicon.check : failed ? Codicon.error : entry.status === 'background' ? Codicon.clock : Codicon.loading));
				if (!done && !failed && entry.status !== 'background') {
					icon.classList.add('codicon-modifier-spin');
				}
				dom.append(node, $('span.tool-text')).textContent = entry.text;
				if (entry.status === 'background') {
					dom.append(node, $('span.tool-status')).textContent = localize('backgroundStatus', "running in background");
				}
				break;
			}
			case 'approval': {
				const approval = entry.approval;
				eyebrow(localize('approval', "{0} asks", this.activeService.agent.provider.name));
				dom.append(node, $('.text')).textContent = approval?.title ?? entry.text;
				if (approval?.detail) {
					dom.append(node, $('pre.detail')).textContent = approval.detail;
				}
				const actions = dom.append(node, $('.actions'));
				if (approval?.resolved) {
					dom.append(actions, $('span.resolved')).textContent = localize('resolved', "Decision: {0}", approval.resolved);
				} else if (!this.activeService.canApprove) {
					dom.append(actions, $('span.resolved')).textContent = localize('approvalWaitingHost', "Waiting for the host or a collaborator");
				} else {
					for (const choice of approval?.choices ?? []) {
						const button = dom.append(actions, $(`button.${choice.approves ? 'primary' : 'secondary'}`));
						button.textContent = choice.label;
						slot.store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.activeService.decideApproval(approval!.approvalId, choice.choiceId)));
					}
				}
				break;
			}
			case 'system':
				dom.append(node, $('.text')).textContent = entry.text;
				break;
			case 'diagram': {
				// The map changed: said here, one click away, without leaving chat.
				eyebrow(entry.mapVersion !== undefined ? localize('diagramUpdateVersion', "Active · system map v{0}", entry.mapVersion) : localize('diagramUpdate', "Active · system map"));
				dom.append(node, $('.text')).textContent = entry.text;
				if (entry.status === 'streaming') {
					break; // the diagram agent is still making a change; the link comes with its reply
				}
				const actions = dom.append(node, $('.note-actions'));
				const open = dom.append(actions, $('button.link')) as HTMLButtonElement;
				open.textContent = localize('openSystemMap', "Open System Map");
				slot.store.add(dom.addDisposableListener(open, dom.EventType.CLICK, () => void this.activeService.openSystemMap()));
				break;
			}
		}
		if (reveal) {
			this.intro.classList.toggle('compact', true);
			this.revealBottom();
		}
	}

	/** A note is also saved as a one-scene walkthrough at the change; it can be opened there or read aloud. */
	private renderNoteActions(node: HTMLElement, entry: ChatEntry, store: DisposableStore): void {
		const actions = dom.append(node, $('.note-actions'));
		if (entry.recordId) {
			const show = dom.append(actions, $('button.link')) as HTMLButtonElement;
			show.textContent = localize('noteShowInCode', "Show in Code");
			show.title = localize('noteShowInCodeTitle', "Open this note beside the lines it's about");
			const recordId = entry.recordId;
			store.add(dom.addDisposableListener(show, dom.EventType.CLICK, () => void this.activeService.openNote(recordId)));
		}
		if (this.activeService.canSpeak) {
			const listen = dom.append(actions, $('button.link')) as HTMLButtonElement;
			const label = () => listen.textContent = this.activeService.speakingText === entry.text ? localize('noteStopReading', "Stop Reading") : localize('noteReadAloud', "Read Aloud");
			label();
			store.add(this.activeService.onDidChangeSpeaking(label));
			store.add(dom.addDisposableListener(listen, dom.EventType.CLICK, () => {
				if (this.activeService.speakingText === entry.text) {
					this.activeService.stopSpeaking();
				} else {
					listen.textContent = localize('notePreparingSpeech', "Preparing…");
					void this.activeService.speak(entry.text).finally(label);
				}
			}));
		}
	}

	/**
	 * The waiting indicator: while the agent is working, unless something on screen already shows progress
	 * (text arriving, a tool's spinner) or the agent is waiting on the developer (an approval).
	 */
	private renderWorking(): void {
		const agent = this.activeService.agent;
		const running = agent.status === 'running';
		if (!running) {
			this.runningSince = undefined;
		} else if (this.runningSince === undefined) {
			this.runningSince = Date.now();
		}
		const last = this.activeService.chat.at(-1);
		const shownElsewhere = !!last && (
			(last.role === 'approval' && !last.approval?.resolved)
			|| ((last.role === 'agent' || last.role === 'explainer') && last.status === 'streaming')
			|| (last.role === 'tool' && !TOOL_SETTLED.includes(last.status ?? ''))
		);
		const visible = running && !shownElsewhere;
		const wasVisible = !this.working.classList.contains('hidden');
		this.working.classList.toggle('hidden', !visible);
		if (!visible) {
			this.stopWorkingTimer();
			return;
		}
		this.updateWorkingLabel();
		this.workingTimer ??= setInterval(() => this.updateWorkingLabel(), 1000);
		if (!wasVisible) {
			this.revealBottom();
		}
	}

	private updateWorkingLabel(): void {
		const seconds = Math.floor((Date.now() - (this.runningSince ?? Date.now())) / 1000);
		const name = this.activeService.agent.provider.shortName;
		// The time only appears once the wait is long enough to wonder about.
		this.workingLabel.textContent = seconds < 10
			? localize('agentWorking', "{0} is working", name)
			: localize('agentWorkingFor', "{0} is working · {1}", name, `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`);
	}

	private stopWorkingTimer(): void {
		if (this.workingTimer !== undefined) {
			clearInterval(this.workingTimer);
			this.workingTimer = undefined;
		}
	}

	private revealBottom(): void {
		this.scrollable.scanDomNode();
		dom.scheduleAtNextAnimationFrame(dom.getWindow(this.root), () => {
			this.scrollable.scanDomNode();
			this.scrollable.setScrollPosition({ scrollTop: this.content.scrollHeight });
		});
	}
}

const TOOL_FAILED = ['failed', 'rejected', 'timedOut', 'cancelled'];
/** Tool states without a spinner beside them. */
const TOOL_SETTLED = ['completed', 'background', ...TOOL_FAILED];

/** Three dots that pulse in turn: a reply is on its way. */
function appendDots(parent: HTMLElement): void {
	const dots = dom.append(parent, $('span.active-typing-dots'));
	dots.setAttribute('aria-hidden', 'true');
	for (let index = 0; index < 3; index++) {
		dom.append(dots, $('span'));
	}
}

/**
 * Agents often write Python-style names like `__repr__` or `__init__.py` without backticks,
 * which markdown would turn into bold text. Escapes the underscores of such names outside code.
 */
export function escapeIdentifierUnderscores(text: string): string {
	return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, index) => index % 2 ? part : part.replace(/(?<![\w\\])[\w.]*__\w*/g, name => name.replace(/_/g, '\\_'))).join('');
}

/** Out to the grid of every agent from anywhere (the chat's button and overscroll do the same). */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'active.agents.showAll',
			title: localize2('showAllAgents', "Show All Agents"),
			category: localize2('activeCategory', "Active"),
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IActiveService);
		// Chat follows the service: if it's showing it zooms out now, otherwise as soon as it opens.
		service.setGridOpen(true);
		await service.openChat(false);
	}
});
