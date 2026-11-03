/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { DomScrollableElement } from '../../../../base/browser/ui/scrollbar/scrollableElement.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ScrollbarVisibility } from '../../../../base/common/scrollable.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import type { HistoryDetail, TurnSummary } from '../common/activeProtocol.js';
import { agentLabel, IActiveService } from './activeService.js';

const $ = dom.$;

/** Session history: every turn, including ones that produced no walkthrough, with replay and deletion. */
export class ActiveHistoryView extends ViewPane {
	private list!: HTMLElement;
	private scrollable!: DomScrollableElement;
	private readonly listStore = this._register(new DisposableStore());
	private readonly expanded = new Map<string, HistoryDetail | 'loading'>();
	/** Relative times ("5 mins ago") on screen, refreshed every minute so they don't go stale. */
	private timeLabels: Array<{ element: HTMLElement; text: () => string }> = [];

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
		@IDialogService private readonly dialogService: IDialogService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.activeService.onDidChangeHistory(() => this.renderList()));
		const timer = setInterval(() => {
			if (this.isBodyVisible()) {
				this.timeLabels.forEach(label => label.element.textContent = label.text());
			}
		}, 60_000);
		this._register(toDisposable(() => clearInterval(timer)));
	}

	private timeLabel(element: HTMLElement, text: () => string): void {
		element.textContent = text();
		this.timeLabels.push({ element, text });
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		container.classList.add('active-history');
		this.list = $('.active-history-list');
		this.scrollable = this._register(new DomScrollableElement(this.list, { vertical: ScrollbarVisibility.Auto, horizontal: ScrollbarVisibility.Hidden }));
		container.appendChild(this.scrollable.getDomNode());
		this.renderList();
	}

	protected override layoutBody(height: number, width: number): void {
		super.layoutBody(height, width);
		this.scrollable.getDomNode().style.height = `${height}px`;
		this.scrollable.scanDomNode();
	}

	private renderList(): void {
		if (!this.list) {
			return;
		}
		this.listStore.clear();
		this.timeLabels = [];
		dom.clearNode(this.list);
		const history = this.activeService.history;
		if (!history.length) {
			dom.append(this.list, $('.empty')).textContent = localize('noHistory', "No turns yet. Every coding turn is saved here.");
			this.scrollable.scanDomNode();
			return;
		}
		// Turns are newest first; each run of turns from one chat gets a header saying when that chat began
		// (its first turn overall, as in the Chats picker, even if the chat was left and resumed later).
		const chatStart = new Map<string, number>();
		for (const turn of history) {
			chatStart.set(turn.sessionId, Math.min(turn.startedAt, chatStart.get(turn.sessionId) ?? Infinity));
		}
		history.forEach((turn, index) => {
			if (turn.sessionId !== history[index - 1]?.sessionId) {
				const started = chatStart.get(turn.sessionId)!;
				this.timeLabel(dom.append(this.list, $('.session')), () => localize('chatStarted', "Chat started {0}", fromNow(started, true)));
			}
			this.renderTurn(turn);
		});
		this.scrollable.scanDomNode();
	}

	private renderTurn(turn: TurnSummary): void {
		const item = dom.append(this.list, $('.turn'));
		const head = dom.append(item, $('.turn-head'));
		const owner = agentLabel(this.activeService, turn.agentId, turn.agentName);
		if (owner) {
			const chip = dom.append(head, $('span.active-agent-chip'));
			chip.style.setProperty('--agent-color', `var(--active-agent-${owner.colorIndex}, var(--vscode-charts-blue))`);
			chip.textContent = owner.name;
		}
		dom.append(head, $('span.index')).textContent = localize('turnIndex', "Turn {0}", turn.index);
		this.timeLabel(dom.append(head, $('span.when')), () => fromNow(turn.startedAt, true));
		dom.append(item, $('.task')).textContent = turn.task;
		const note = dom.append(item, $('.note'));
		note.textContent = !turn.walkthroughTitle ? turn.explanationNote
			: turn.walkthroughIsNote ? localize('noteEntry', "Note: {0}", turn.walkthroughTitle)
				: localize('walkthroughNote', "Walkthrough: {0}", turn.walkthroughTitle);
		note.classList.toggle('has-walkthrough', !!turn.walkthroughId);
		if (turn.files.length) {
			const files = dom.append(item, $('.files'));
			for (const file of turn.files) {
				const row = dom.append(files, $('span.file'));
				dom.append(row, $('span.name')).textContent = file.path;
				if (file.added) {
					dom.append(row, $('span.added')).textContent = ` +${file.added}`;
				}
				if (file.removed) {
					dom.append(row, $('span.removed')).textContent = ` −${file.removed}`;
				}
			}
		}
		const actions = dom.append(item, $('.actions'));
		if (turn.walkthroughId) {
			const replay = dom.append(actions, $('button.primary'));
			replay.textContent = localize('replay', "Replay");
			replay.title = localize('replayTitle', "Replay from the saved script");
			this.listStore.add(dom.addDisposableListener(replay, dom.EventType.CLICK, async () => {
				const detail = await this.activeService.getHistory(turn.turnId);
				if (detail?.walkthrough) {
					await this.activeService.openWalkthrough(detail.walkthrough, { scene: 0, segment: 0 });
				}
			}));
		}
		const details = dom.append(actions, $('button.secondary'));
		details.textContent = this.expanded.has(turn.turnId) ? localize('hide', "Hide Details") : localize('details', "Details");
		this.listStore.add(dom.addDisposableListener(details, dom.EventType.CLICK, async () => {
			if (this.expanded.has(turn.turnId)) {
				this.expanded.delete(turn.turnId);
			} else {
				this.expanded.set(turn.turnId, 'loading');
				const detail = await this.activeService.getHistory(turn.turnId);
				if (detail) {
					this.expanded.set(turn.turnId, detail);
				} else {
					this.expanded.delete(turn.turnId);
				}
			}
			this.renderList();
		}));
		const remove = dom.append(actions, $('button.secondary'));
		remove.textContent = localize('delete', "Delete");
		this.listStore.add(dom.addDisposableListener(remove, dom.EventType.CLICK, async () => {
			const { confirmed } = await this.dialogService.confirm({ message: localize('confirmDeleteTurn', "Delete history for turn {0}?", turn.index), detail: localize('confirmDeleteDetail', "Project files are not affected."), primaryButton: localize('deleteButton', "Delete") });
			if (confirmed) {
				await this.activeService.deleteHistory(turn.turnId);
			}
		}));
		const expanded = this.expanded.get(turn.turnId);
		if (expanded && expanded !== 'loading') {
			this.renderDetail(item, expanded);
		}
	}

	private renderDetail(container: HTMLElement, detail: HistoryDetail): void {
		const box = dom.append(container, $('.detail'));
		const section = (title: string, lines: string[]) => {
			if (!lines.length) {
				return;
			}
			dom.append(box, $('.detail-title')).textContent = title;
			for (const line of lines) {
				dom.append(box, $('.detail-line')).textContent = line;
			}
		};
		section(localize('chat', "Chat"), detail.chat.filter(entry => entry.role !== 'tool').map(entry => `${entry.role}: ${entry.text.slice(0, 280)}`));
		section(localize('summaries', "Exposed reasoning summaries"), detail.reasoningSummaries.map(summary => summary.slice(0, 400)));
		section(localize('tools', "Tool outcomes"), detail.tools.map(tool => `${tool.label} → ${tool.status}${tool.background ? ' (background)' : ''}`));
		section(localize('edits', "Captured edits"), detail.edits.map(edit => `#${edit.seq} ${edit.path} +${edit.added} −${edit.removed} (${edit.source})`));
		if (detail.walkthrough) {
			section(localize('script', "Narration script"), detail.walkthrough.scenes.map((scene, index) => `${index + 1}. ${scene.title} — ${scene.narration.map(segment => segment.text).join(' ')}`));
		}
	}
}
