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
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IMarkdownRendererService } from '../../../../platform/markdown/browser/markdownRenderer.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import type { ChatEntry } from '../common/activeProtocol.js';
import { ActiveChatInput } from './activeInputs.js';
import { IActiveService } from './activeService.js';

const $ = dom.$;
const INSTALL_COMMAND = 'curl -fsSL https://dev.meta.ai/install.sh | sh';

type ComposerMode = 'task' | 'ask';

/**
 * Full-work-area chat with Muse Code. Auto mode shows messages, compact tool
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
	private sendButton!: HTMLButtonElement;
	private modeLabel!: HTMLElement;
	private footerRow!: HTMLElement;
	private mode: ComposerMode = 'task';
	private readonly entryNodes = new Map<string, { node: HTMLElement; store: DisposableStore }>();
	private readonly inputStore = this._register(new DisposableStore());
	private readonly noticeStore = this._register(new DisposableStore());
	private readonly footerStore = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IActiveService private readonly activeService: IActiveService,
		@IMarkdownRendererService private readonly markdownRenderer: IMarkdownRendererService,
		@IClipboardService private readonly clipboardService: IClipboardService,
		@ICommandService private readonly commandService: ICommandService,
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
		dom.append(this.intro, $('p.lead')).textContent = localize('introLead', "Work with Muse Code, then follow a walkthrough shaped around what you know and want to learn.");
		this.notices = dom.append(column, $('.active-chat-notices'));
		this.transcript = dom.append(column, $('.active-chat-transcript'));
		this.stageLine = dom.append(column, $('.active-chat-stage'));

		const composer = dom.append(column, $('.active-chat-composer'));
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
		this.sendButton = dom.append(bar, $('button.send')) as HTMLButtonElement;
		this.sendButton.textContent = localize('send', "Send ↑");
		this._register(dom.addDisposableListener(this.sendButton, dom.EventType.CLICK, () => this.send()));

		this.footerRow = dom.append(column, $('.active-chat-footer'));
		dom.append(column, $('p.active-chat-tagline')).textContent = localize('tagline', "Code, visuals, and narration unfold together inside the editor.");

		this._register(this.activeService.onDidChangeChat(entry => entry ? this.renderEntry(entry, true) : this.renderTranscript()));
		this._register(this.activeService.onDidChangeAgent(() => this.renderChrome()));
		this._register(this.activeService.onDidChangeProfile(() => this.renderNotices()));
		this._register(this.activeService.onDidChangeWalkthroughStatus(() => this.renderStage()));
		this._register(this.activeService.onDidChangeOffer(() => this.renderChrome()));
		this._register(this.activeService.onDidChangePlayer(() => this.renderChrome()));
	}

	override async setInput(input: ActiveChatInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputStore.clear();
		this.mode = this.activeService.chatContext ? 'ask' : 'task';
		this.renderTranscript();
		this.renderChrome();
	}

	override focus(): void {
		super.focus();
		this.textarea?.focus();
	}

	override layout(dimension: dom.Dimension): void {
		this.root.style.height = `${dimension.height}px`;
		this.root.style.width = `${dimension.width}px`;
		this.scrollable.getDomNode().style.height = `${Math.max(0, dimension.height - this.header.offsetHeight)}px`;
		this.scrollable.scanDomNode();
	}

	private renderChrome(): void {
		if (!this.root) {
			return;
		}
		const agent = this.activeService.agent;
		dom.clearNode(this.header);
		dom.append(this.header, $('span.title')).textContent = localize('headerTitle', "Muse Code · {0}", agent.workspaceName || localize('noWorkspace', "no folder"));
		if (agent.host) {
			const host = dom.append(this.header, $('span.agent-host'));
			host.textContent = agent.host;
			host.classList.toggle('test-double', /test double/i.test(agent.host));
		}
		const status = dom.append(this.header, $(`span.agent-status.${agent.status}`));
		status.textContent = {
			unavailable: localize('statusUnavailable', "Unavailable"),
			starting: localize('statusStarting', "Connecting…"),
			idle: localize('statusIdle', "Ready"),
			running: localize('statusRunning', "Working"),
			error: localize('statusError', "Error"),
		}[agent.status];
		this.renderNotices();
		this.renderStage();
		this.renderComposerContext();
		this.renderFooter();
		this.intro.classList.toggle('compact', this.activeService.chat.length > 0);
	}

	private renderNotices(): void {
		this.noticeStore.clear();
		dom.clearNode(this.notices);
		const agent = this.activeService.agent;
		if (agent.status === 'unavailable' && agent.blocker) {
			const card = dom.append(this.notices, $('.notice.blocker'));
			dom.append(card, $('.notice-title')).textContent = localize('blockerTitle', "Muse Code is not connected");
			dom.append(card, $('pre.notice-detail')).textContent = agent.blocker;
			const actions = dom.append(card, $('.notice-actions'));
			if (this.activeService.needsTrust) {
				const trust = dom.append(actions, $('button.primary'));
				trust.textContent = localize('trustFolder', "Manage Workspace Trust");
				this.noticeStore.add(dom.addDisposableListener(trust, dom.EventType.CLICK, () => this.commandService.executeCommand('workbench.trust.manage')));
			}
			if (!this.activeService.needsTrust && /not found|install/i.test(agent.blocker)) {
				const copy = dom.append(actions, $('button.secondary'));
				copy.textContent = localize('copyInstall', "Copy Install Command");
				this.noticeStore.add(dom.addDisposableListener(copy, dom.EventType.CLICK, () => this.clipboardService.writeText(INSTALL_COMMAND)));
			}
		}
		if (!this.activeService.profile.configured) {
			const card = dom.append(this.notices, $('.notice'));
			dom.append(card, $('.notice-title')).textContent = localize('profileTitle', "Shape walkthroughs around you");
			dom.append(card, $('.notice-detail')).textContent = localize('profileDetail', "Tell Active what you already know, what you want to learn, and how you like explanations. You can change it any time.");
			const actions = dom.append(card, $('.notice-actions'));
			const setup = dom.append(actions, $('button.primary'));
			setup.textContent = localize('setupProfile', "Set Up Learning Profile");
			this.noticeStore.add(dom.addDisposableListener(setup, dom.EventType.CLICK, () => this.activeService.openProfile()));
		}
		const player = this.activeService.player;
		const offered = this.activeService.offeredWalkthrough;
		if (offered || player) {
			const card = dom.append(this.notices, $('.notice.walkthrough'));
			const target = offered ?? player!.walkthrough;
			const context = this.activeService.chatContext;
			dom.append(card, $('.notice-title')).textContent = offered
				? localize('walkthroughReadyTitle', "Walkthrough ready: {0}", target.title)
				: localize('walkthroughPausedTitle', "Walkthrough paused: {0}", target.title);
			if (!offered && player) {
				dom.append(card, $('.notice-detail')).textContent = context
					? localize('pausedAtScene', "Paused at {0} of {1}: “{2}”. Questions you ask here use this explanation as context.", context.sceneIndex + 1, player.walkthrough.scenes.length, context.title)
					: localize('pausedAt', "Paused at idea {0} of {1}.", player.position.scene + 1, player.walkthrough.scenes.length);
			}
			const actions = dom.append(card, $('.notice-actions'));
			const resume = dom.append(actions, $('button.primary'));
			resume.textContent = offered ? localize('playWalkthrough', "Play Walkthrough") : localize('returnToWalkthrough', "Return to Walkthrough");
			this.noticeStore.add(dom.addDisposableListener(resume, dom.EventType.CLICK, () => offered ? this.activeService.openWalkthrough(offered) : this.activeService.resumeWalkthrough()));
		}
		this.scrollable?.scanDomNode();
	}

	private renderStage(): void {
		const status = this.activeService.walkthroughStatus;
		const agent = this.activeService.agent;
		const parts: string[] = [];
		if (status && status.stage !== 'idle' && status.stage !== 'ready') {
			parts.push(status.detail);
		}
		if (agent.backgroundTasks > 0) {
			parts.push(localize('backgroundRunning', "{0} background task(s) still running", agent.backgroundTasks));
		}
		this.stageLine.textContent = parts.join(' · ');
		this.stageLine.classList.toggle('hidden', parts.length === 0);
	}

	private renderComposerContext(): void {
		dom.clearNode(this.composerContext);
		const context = this.activeService.chatContext;
		this.composerContext.classList.toggle('hidden', !context);
		if (context) {
			const ask = dom.append(this.composerContext, $('button.mode'));
			ask.textContent = localize('askMode', "Ask About “{0}”", context.title);
			ask.classList.toggle('selected', this.mode === 'ask');
			const task = dom.append(this.composerContext, $('button.mode'));
			task.textContent = localize('taskMode', "New Coding Task");
			task.classList.toggle('selected', this.mode === 'task');
			this.inputStore.add(dom.addDisposableListener(ask, dom.EventType.CLICK, () => { this.mode = 'ask'; this.renderComposerContext(); }));
			this.inputStore.add(dom.addDisposableListener(task, dom.EventType.CLICK, () => { this.mode = 'task'; this.renderComposerContext(); }));
		} else {
			this.mode = 'task';
		}
		this.modeLabel.textContent = this.mode === 'ask' ? localize('explanationSession', "Explanation session (read-only)") : localize('museCode', "Muse Code");
		this.textarea.placeholder = this.mode === 'ask' ? localize('askPlaceholder', "Ask about this part of the walkthrough…") : localize('taskPlaceholder', "Describe a coding task…");
		this.updateSendState();
	}

	private renderFooter(): void {
		this.footerStore.clear();
		dom.clearNode(this.footerRow);
		const profile = dom.append(this.footerRow, $('button.link'));
		profile.textContent = localize('learningProfile', "Learning Profile");
		this.footerStore.add(dom.addDisposableListener(profile, dom.EventType.CLICK, () => this.activeService.openProfile()));
	}

	private updateSendState(): void {
		const agent = this.activeService.agent;
		const empty = !this.textarea.value.trim();
		this.sendButton.disabled = empty || (this.mode === 'task' && agent.status === 'starting');
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
				eyebrow(entry.role === 'agent' ? localize('muse', "Muse") : localize('explainer', "Active · explanation"));
				const body = dom.append(node, $('.text.markdown'));
				if (entry.text) {
					const rendered = slot.store.add(this.markdownRenderer.render(new MarkdownString(entry.text)));
					body.appendChild(rendered.element);
				} else if (entry.status === 'streaming') {
					body.textContent = '…';
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
				eyebrow(localize('approval', "Muse Code asks"));
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

	private revealBottom(): void {
		this.scrollable.scanDomNode();
		dom.scheduleAtNextAnimationFrame(dom.getWindow(this.root), () => {
			this.scrollable.scanDomNode();
			this.scrollable.setScrollPosition({ scrollTop: this.content.scrollHeight });
		});
	}
}
