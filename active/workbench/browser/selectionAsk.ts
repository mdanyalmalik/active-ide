/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ContentWidgetPositionPreference, ICodeEditor, IContentWidget, IContentWidgetPosition } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { localize } from '../../../../nls.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import type { CodeSelection } from '../common/activeProtocol.js';
import { IActiveService } from './activeService.js';

/** How long the selection has to stay put before the button shows (so it doesn't flicker while dragging). */
const SHOW_DELAY_MS = 180;
/** Room the buttons need above the selection's first line to sit there. */
const ROOM_NEEDED_PX = 30;
/** Selected text sent along with the question, at most. */
const MAX_TEXT = 6000;

/**
 * Two small buttons by any selection in a file's editor: "Ask about this" opens chat set to ask the explainer about
 * those lines ("Ask About client.js loc 3–8"); "Request a change" opens it set to ask the coding agent for a change with them as context (to those lines, or elsewhere based on them).
 */
class SelectionAskContribution extends Disposable implements IEditorContribution {
	static readonly ID = 'editor.contrib.activeSelectionAsk';

	private readonly widget = this._register(new MutableDisposable<SelectionAskWidget>());
	private readonly scheduler = this._register(new RunOnceScheduler(() => this.update(), SHOW_DELAY_MS));
	private mouseDown = false;

	constructor(
		private readonly editor: ICodeEditor,
		@IActiveService private readonly activeService: IActiveService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super();
		this._register(editor.onDidChangeCursorSelection(() => {
			// Hidden straight away when the selection changes; shown again once it settles.
			this.widget.clear();
			this.scheduler.schedule();
		}));
		this._register(editor.onMouseDown(() => { this.mouseDown = true; }));
		this._register(editor.onMouseUp(() => {
			this.mouseDown = false;
			this.scheduler.schedule();
		}));
		this._register(editor.onDidChangeModel(() => this.widget.clear()));
		this._register(editor.onDidChangeModelContent(() => this.widget.clear()));
		this._register(editor.onDidBlurEditorWidget(() => this.widget.clear()));
	}

	private update(): void {
		const selection = this.editor.getSelection();
		const model = this.editor.getModel();
		if (this.mouseDown || !selection || selection.isEmpty() || !model || !this.editor.hasWidgetFocus()) {
			return;
		}
		if (this.editor.isSimpleWidget || (model.uri.scheme !== Schemas.file && model.uri.scheme !== Schemas.vscodeRemote)) {
			return;
		}
		const text = model.getValueInRange(selection);
		if (!text.trim()) {
			return;
		}
		this.widget.value = new SelectionAskWidget(this.editor, selection, target => void this.open(target, selection, text), this.activeService.agent.provider.shortName);
	}

	private async open(target: 'ask' | 'change', selection: Selection, text: string): Promise<void> {
		const model = this.editor.getModel();
		if (!model) {
			return;
		}
		// A selection ending at the very start of a line doesn't include that line.
		const endLine = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
		const folder = this.workspaceService.getWorkspaceFolder(model.uri);
		const file = folder ? model.uri.path.slice(folder.uri.path.replace(/\/$/, '').length + 1) : model.uri.fsPath;
		const code: CodeSelection = { file, startLine: selection.startLineNumber, endLine, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…` : text };
		this.widget.clear();
		await (target === 'ask' ? this.activeService.askAboutCode(code) : this.activeService.requestChange(code));
	}
}

/**
 * The buttons: above the selection's first line, from where its text ends (clear of Code OSS's lightbulb, which
 * sits at the start of a line), or below its last line when there's no room above.
 */
class SelectionAskWidget extends Disposable implements IContentWidget {
	private static nextId = 0;
	readonly allowEditorOverflow = false;
	readonly suppressMouseDown = true;
	private readonly id = `active.selectionAsk.${SelectionAskWidget.nextId++}`;
	private readonly node: HTMLElement;
	private readonly row: HTMLElement;

	constructor(private readonly editor: ICodeEditor, private readonly selection: Selection, run: (target: 'ask' | 'change') => void, agentName: string) {
		super();
		// Monaco sets the widget's own node to display: block, so the row is laid out inside it.
		this.node = dom.$('.active-selection-widget');
		this.row = dom.append(this.node, dom.$('.active-selection-actions'));
		this.button(Codicon.commentDiscussion, localize('askAboutThis', "Ask about this"), localize('askAboutThisTitle', "Ask Active's explainer about the selected code, in chat"), () => run('ask'));
		this.button(Codicon.editSparkle, localize('requestChangeHere', "Request a change"), localize('requestChangeHereTitle', "Ask {0} for a change in chat, with the selected code as context: a change to it, or elsewhere based on it", agentName), () => run('change'));
		editor.addContentWidget(this);
	}

	private button(icon: ThemeIcon, label: string, title: string, run: () => void): void {
		const button = dom.append(this.row, dom.$('button.active-selection-ask'));
		button.setAttribute('type', 'button');
		dom.append(button, dom.$('span.icon')).classList.add(...ThemeIcon.asClassNameArray(icon));
		dom.append(button, dom.$('span')).textContent = label;
		button.title = title;
		// Clicking mustn't move the editor's focus or selection first.
		this._register(dom.addDisposableListener(button, dom.EventType.MOUSE_DOWN, event => {
			event.preventDefault();
			event.stopPropagation();
		}));
		this._register(dom.addDisposableListener(button, dom.EventType.CLICK, event => {
			event.preventDefault();
			event.stopPropagation();
			run();
		}));
	}

	getId(): string {
		return this.id;
	}

	getDomNode(): HTMLElement {
		return this.node;
	}

	getPosition(): IContentWidgetPosition {
		const model = this.editor.getModel();
		const first = this.selection.startLineNumber;
		const last = this.selection.endColumn === 1 && this.selection.endLineNumber > first ? this.selection.endLineNumber - 1 : this.selection.endLineNumber;
		const end = (line: number) => ({ lineNumber: line, column: model ? model.getLineMaxColumn(line) : 1 });
		// Monaco would put a widget that doesn't fit above the first line just below that line, over the selected
		// code; it goes below the selection's last line instead.
		const roomAbove = this.editor.getTopForLineNumber(first) - this.editor.getScrollTop();
		return roomAbove >= ROOM_NEEDED_PX
			? { position: end(first), preference: [ContentWidgetPositionPreference.ABOVE] }
			: { position: end(last), preference: [ContentWidgetPositionPreference.BELOW] };
	}

	override dispose(): void {
		this.editor.removeContentWidget(this);
		super.dispose();
	}
}

registerEditorContribution(SelectionAskContribution.ID, SelectionAskContribution, EditorContributionInstantiation.AfterFirstRender);
