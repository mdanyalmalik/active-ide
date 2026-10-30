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
import { localize } from '../../../../nls.js';
import { toAction } from '../../../../base/common/actions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ActiveSetting, type ChatEntry, type ExplainMode } from '../common/activeProtocol.js';
import { effortLabel } from './activeSettings.js';
import { ActiveChatInput } from './activeInputs.js';
import { IActiveService } from './activeService.js';
import { renderSetupPanel, SetupPanelViewState } from './setupPanel.js';

const $ = dom.$;

type ComposerMode = 'task' | 'ask';

const HANDOFF_SECONDS = 4;

/**
 * Full-work-area chat with the coding agent. Auto mode shows messages, compact tool
 * rows and approvals — never a scrolling reasoning trace.
 */
export class ActiveChatEditor extends EditorPane {
	static readonly ID = 'workbench.editor.activeChat';

	private root!: HTMLElement;
	private header!: HTMLElement;
	private scrollable!: DomScrollableElement;
	private content!: HTMLElement;
	private intro!: HTMLElement;
	private notices!: HTMLElement;
	private transcript!: HTMLElement;
	private stageLine!: HTMLElement;
	private composerContext!: HTMLElement;
	private textarea!: HTMLTextAreaElement;
	private effortButton!: HTMLButtonElement;
	private sendButton!: HTMLButtonElement;
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
	) {
		super(ActiveChatEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, $('.active-chat'));
		this.header = dom.append(this.root, $('.active-chat-header'));
		this.content = $('.active-chat-content');
		this.scrollable = this._register(new DomScrollableElement(this.content, { vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Hidden, useShadows: true }));
		dom.append(this.root, this.scrollable.getDomNode()).classList.add('active-chat-scroll');

		const column = dom.append(this.content, $('.active-chat-column'));
		this.intro = dom.append(column, $('.active-chat-intro'));
		dom.append(this.intro, $('.eyebrow')).textContent = localize('introEyebrow', "Your workspace, with Active");
		dom.append(this.intro, $('h1')).textContent = localize('introTitle', "What would you like to build?");
		this.introLead = dom.append(this.intro, $('p.lead'));
		this.notices = dom.append(column, $('.active-chat-notices'));
		this.transcript = dom.append(column, $('.active-chat-transcript'));

		// The dock stays put below the scrolling transcript: walkthrough status, composer, actions.
		const dock = dom.append(dom.append(this.root, $('.active-chat-dock')), $('.active-chat-dock-column'));
		this.handoffCard = dom.append(dock, $('.active-chat-handoff.hidden'));
		this.stageLine = dom.append(dock, $('.active-chat-stage'));
		const composer = dom.append(dock, $('.active-chat-composer'));
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
		this.modeLabel = dom.append(bar, $('.composer-mode'));
		this._register(this.activeService.onDidChangeMode(() => this.renderComposerContext()));
		const tools = dom.append(bar, $('.composer-tools'));
		// The coding agent's effort, one click from where the task is typed.
		this.effortButton = dom.append(tools, $('button.composer-effort')) as HTMLButtonElement;
		this._register(dom.addDisposableListener(this.effortButton, dom.EventType.CLICK, () => this.activeService.pickCodingEffort()));
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
		this.sendButton = dom.append(tools, $('button.send')) as HTMLButtonElement;
		this.sendButton.textContent = localize('send', "Send ↑");
		this._register(dom.addDisposableListener(this.sendButton, dom.EventType.CLICK, () => this.send()));

		this.footerRow = dom.append(dock, $('.active-chat-footer'));
		dom.append(this.intro, $('p.active-chat-tagline')).textContent = localize('tagline', "Code, visuals and narration, right in the editor.");

		this._register(this.activeService.onDidChangeChat(entry => entry ? this.renderEntry(entry, true) : this.renderTranscript()));
		this._register(this.activeService.onDidChangeAgent(() => this.renderChrome()));
		this._register(this.activeService.onDidChangeProfile(() => this.renderNotices()));
		this._register(this.activeService.onDidChangeBriefing(() => this.renderNotices()));
		this._register(this.activeService.onDidChangeWalkthroughStatus(() => this.renderStage()));
		this._register(this.activeService.onDidChangeOffer(() => this.renderChrome()));
		this._register(this.activeService.onDidChangePlayer(() => this.renderChrome()));
		this._register(this.activeService.onDidChangeHandoff(() => this.renderHandoff()));
		this._register(toDisposable(() => this.stopCountdown()));
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
		this.renderHandoff();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (!visible && this.activeService.pendingHandoff) {
			// The user moved elsewhere during the countdown: offer the walkthrough instead.
			this.activeService.declineHandoff();
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
		this.scrollable.scanDomNode();
	}

	private renderChrome(): void {
		if (!this.root) {
			return;
		}
		const agent = this.activeService.agent;
		dom.clearNode(this.header);
		dom.append(this.header, $('span.title')).textContent = localize('headerTitle', "{0} · {1}", agent.provider.name, agent.workspaceName || localize('noWorkspace', "no folder"));
		this.introLead.textContent = localize('introLead', "{0} writes the code. Active walks you through what changed.", agent.provider.name);
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
		// Chats are sessions: start a new one, or go back to an earlier one from this folder.
		this.headerStore.clear();
		const headerAction = (icon: ThemeIcon, label: string, title: string, run: () => unknown) => {
			const button = dom.append(this.header, $('button.header-action')) as HTMLButtonElement;
			dom.append(button, $('span')).classList.add(...ThemeIcon.asClassNameArray(icon));
			dom.append(button, $('span.label')).textContent = label;
			button.title = title;
			this.headerStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => run()));
		};
		headerAction(Codicon.history, localize('resumeChat', "Chats"), localize('resumeChatTitle', "Resume an earlier chat in this folder"), () => this.activeService.pickChatToResume());
		headerAction(Codicon.add, localize('newChat', "New Chat"), localize('newChatTitle', "Start a new chat (a new {0} session)", agent.provider.name), () => this.activeService.newChat());
		this.renderNotices();
		this.renderStage();
		this.renderComposerContext();
		this.renderFooter();
		this.intro.classList.toggle('compact', this.activeService.chat.length > 0);
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
		if (briefing && this.activeService.narration.available) {
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
		if (this.activeService.stateLoaded && !this.activeService.profile.configured) {
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
			ask.textContent = localize('askMode', "Ask About “{0}”", context.title);
			ask.classList.toggle('selected', this.mode === 'ask');
			this.inputStore.add(dom.addDisposableListener(ask, dom.EventType.CLICK, () => { this.mode = 'ask'; this.renderComposerContext(); }));
			this.inputStore.add(dom.addDisposableListener(task, dom.EventType.CLICK, () => { this.mode = 'task'; this.renderComposerContext(); }));
		} else {
			this.mode = 'task';
		}
		this.sendButton.textContent = this.mode === 'ask' ? localize('askSend', "Ask ↑") : localize('send', "Send ↑");
		this.renderExplainMode();
		this.textarea.placeholder = this.mode === 'ask' ? localize('askPlaceholder', "Ask about this part…") : localize('taskPlaceholder', "Describe a coding task…");
		this.renderEffort();
		this.updateSendState();
	}

	/** Bottom left of the chat box: how explanations are delivered (Auto, Away, Off), changeable in place. */
	private renderExplainMode(): void {
		this.modeStore.clear();
		dom.clearNode(this.modeLabel);
		if (this.mode === 'ask') {
			this.modeLabel.textContent = localize('explanationSession', "Asking about the walkthrough");
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
		dom.append(button, $('span')).textContent = current.label;
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

	private renderEffort(): void {
		const effort = this.activeService.codingEffort;
		dom.clearNode(this.effortButton);
		dom.append(this.effortButton, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.lightbulb));
		dom.append(this.effortButton, $('span')).textContent = localize('effortButton', "Effort: {0}", effortLabel(effort));
		this.effortButton.title = localize('effortTitle', "How much {0} reasons before acting. Higher is slower and costs more.", this.activeService.agent.provider.name);
		// Effort applies to coding tasks; questions use the explanation model's setting.
		this.effortButton.classList.toggle('hidden', this.mode === 'ask');
	}

	private renderFooter(): void {
		this.footerStore.clear();
		dom.clearNode(this.footerRow);
		const profile = dom.append(this.footerRow, $('button.link'));
		profile.textContent = localize('knowledgeProfile', "Knowledge Profile");
		this.footerStore.add(dom.addDisposableListener(profile, dom.EventType.CLICK, () => this.activeService.openProfile()));
	}

	private updateSendState(): void {
		const agent = this.activeService.agent;
		const empty = !this.textarea.value.trim();
		this.sendButton.disabled = empty || (this.mode === 'task' && (agent.status === 'starting' || !!agent.setup));
	}

	private async send(): Promise<void> {
		const text = this.textarea.value.trim();
		if (!text) {
			return;
		}
		this.textarea.value = '';
		this.updateSendState();
		const context = this.activeService.chatContext;
		if (this.mode === 'ask' && context) {
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
				eyebrow(entry.status === 'queued' ? localize('youQueued', "You · queued") : localize('you', "You"));
				dom.append(node, $('.text')).textContent = entry.text;
				break;
			case 'question':
				eyebrow(localize('youAsk', "You · about the walkthrough"));
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
					body.textContent = '…';
				}
				if (entry.role === 'explainer' && entry.id.startsWith('note') && entry.text) {
					this.renderNoteActions(node, entry, slot.store);
				}
				break;
			}
			case 'tool': {
				const icon = dom.append(node, $('span.tool-icon'));
				const done = entry.status === 'completed';
				const failed = entry.status && ['failed', 'rejected', 'timedOut', 'cancelled'].includes(entry.status);
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
		if (this.activeService.narration.available) {
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

	private revealBottom(): void {
		this.scrollable.scanDomNode();
		dom.scheduleAtNextAnimationFrame(dom.getWindow(this.root), () => {
			this.scrollable.scanDomNode();
			this.scrollable.setScrollPosition({ scrollTop: this.content.scrollHeight });
		});
	}
}

/**
 * Agents often write Python-style names like `__repr__` or `__init__.py` without backticks,
 * which markdown would turn into bold text. Escapes the underscores of such names outside code.
 */
export function escapeIdentifierUnderscores(text: string): string {
	return text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/).map((part, index) => index % 2 ? part : part.replace(/(?<![\w\\])[\w.]*__\w*/g, name => name.replace(/_/g, '\\_'))).join('');
}
