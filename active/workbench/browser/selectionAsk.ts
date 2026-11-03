/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { extUriBiasedIgnorePathCase } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ContentWidgetPositionPreference, ICodeEditor, IContentWidget, IContentWidgetPosition } from '../../../../editor/browser/editorBrowser.js';
import { EditorContributionInstantiation, registerEditorContribution } from '../../../../editor/browser/editorExtensions.js';
import { Selection } from '../../../../editor/common/core/selection.js';
import { IEditorContribution } from '../../../../editor/common/editorCommon.js';
import { localize } from '../../../../nls.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { describeCodeSelection, type CodeSelection } from '../common/activeProtocol.js';
import { IActiveService, REMOTE_FILE_SCHEME } from './activeService.js';
import { onRightClickQuickPrompt, QuickPromptOptions, showsReceiver } from './quickPrompt.js';

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
		// A guest sees the host's files through the session (`active-remote:`), and only those go to the host's agents;
		// a viewer can't send anything.
		const remote = this.activeService.remote;
		if (this.editor.isSimpleWidget || (model.uri.scheme !== Schemas.file && model.uri.scheme !== Schemas.vscodeRemote && model.uri.scheme !== REMOTE_FILE_SCHEME) || remote?.role === 'viewer' || (remote && model.uri.scheme !== REMOTE_FILE_SCHEME)) {
			return;
		}
		const text = model.getValueInRange(selection);
		if (!text.trim()) {
			return;
		}
		// Guests don't get explanations, so they only get Request a change.
		const targets: Array<'ask' | 'change'> = remote ? ['change'] : ['ask', 'change'];
		this.widget.value = new SelectionAskWidget(this.editor, selection, targets, target => void this.open(target, selection, text), target => this.quickPrompt(target, selection, text), this.activeService.agent.provider.shortName);
	}

	/**
	 * The selected code and the agent it belongs to: whoever's worktree the file is in (the highlighted agent for
	 * files outside every agent's folder). The path is relative to that agent's folder, as the agent sees it.
	 */
	private codeFor(selection: Selection, text: string): { code: CodeSelection; agentId: string } | undefined {
		const model = this.editor.getModel();
		if (!model) {
			return undefined;
		}
		// A selection ending at the very start of a line doesn't include that line.
		const endLine = selection.endColumn === 1 && selection.endLineNumber > selection.startLineNumber ? selection.endLineNumber - 1 : selection.endLineNumber;
		const agentId = this.activeService.agentForResource(model.uri) ?? this.activeService.highlightedAgentId;
		const root = this.activeService.agentRoot(agentId);
		const folder = this.workspaceService.getWorkspaceFolder(model.uri)?.uri;
		const file = (root && extUriBiasedIgnorePathCase.relativePath(root, model.uri)) ?? (folder && extUriBiasedIgnorePathCase.relativePath(folder, model.uri)) ?? model.uri.fsPath;
		return { agentId, code: { file, startLine: selection.startLineNumber, endLine, text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}\n…` : text } };
	}

	private async open(target: 'ask' | 'change', selection: Selection, text: string): Promise<void> {
		const picked = this.codeFor(selection, text);
		if (!picked) {
			return;
		}
		this.widget.clear();
		await (target === 'ask' ? this.activeService.askAboutCode(picked.code, picked.agentId) : this.activeService.requestChange(picked.code, undefined, picked.agentId));
	}

	/** Right-click: type the question or change by the button and send it without opening chat. */
	private quickPrompt(target: 'ask' | 'change', selection: Selection, text: string): QuickPromptOptions | undefined {
		const picked = this.codeFor(selection, text);
		const remote = this.activeService.remote;
		// Viewers can't send; guests don't get explanations, so asking is the host's.
		if (!picked || remote?.role === 'viewer' || (target === 'ask' && remote)) {
			return undefined;
		}
		const { code, agentId } = picked;
		const where = describeCodeSelection(code);
		const shared = { agent: this.activeService.agentInfo(agentId), showAgent: showsReceiver(this.activeService.agents) };
		return target === 'ask'
			? { ...shared, title: localize('quickAskCode', "Ask about {0}", where), placeholder: localize('quickAskCodePlaceholder', "Ask about this code…"), send: question => this.activeService.ask({ question, code }, agentId) }
			: { ...shared, title: localize('quickChangeCode', "Request a change · {0}", where), placeholder: localize('quickChangePlaceholder', "Describe the change…"), send: change => this.activeService.submitTask({ text: change, code }, agentId, true) };
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

	constructor(private readonly editor: ICodeEditor, private readonly selection: Selection, targets: ReadonlyArray<'ask' | 'change'>, run: (target: 'ask' | 'change') => void, quick: (target: 'ask' | 'change') => QuickPromptOptions | undefined, agentName: string) {
		super();
		// Monaco sets the widget's own node to display: block, so the row is laid out inside it.
		this.node = dom.$('.active-selection-widget');
		this.row = dom.append(this.node, dom.$('.active-selection-actions'));
		if (targets.includes('ask')) {
			this.button(Codicon.commentDiscussion, localize('askAboutThis', "Ask about this"), localize('askAboutThisTitle', "Ask Active's explainer about the selected code, in chat. Right-click to type it here."), () => run('ask'), () => quick('ask'));
		}
		this.button(Codicon.editSparkle, localize('requestChangeHere', "Request a change"), localize('requestChangeHereTitle', "Ask {0} for a change in chat, with the selected code as context: a change to it, or elsewhere based on it. Right-click to type it here.", agentName), () => run('change'), () => quick('change'));
		editor.addContentWidget(this);
	}

	private button(icon: ThemeIcon, label: string, title: string, run: () => void, quick: () => QuickPromptOptions | undefined): void {
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
		this._register(onRightClickQuickPrompt(button, quick));
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
