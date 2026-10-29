/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { ICodeEditor, IViewZone } from '../../../../editor/browser/editorBrowser.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { EditorOption, IEditorOptions as ICodeEditorOptions } from '../../../../editor/common/config/editorOptions.js';
import { IRange, Range } from '../../../../editor/common/core/range.js';
import { ScrollType } from '../../../../editor/common/editorCommon.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { IModelDeltaDecoration, ITextModel, TrackedRangeStickiness } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ServiceCollection } from '../../../../platform/instantiation/common/serviceCollection.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import type { CapturedFile, DetailFeedback, PendingCheck, Scene, Walkthrough } from '../common/activeProtocol.js';
import { WalkthroughInput } from './activeInputs.js';
import { ActiveWalkthroughFocus, IActiveService } from './activeService.js';
import { WalkthroughCommandIds } from './walkthroughCommands.js';
import { WalkthroughPlayer } from './walkthroughPlayer.js';
import { renderVisual, visualKindLabel } from './walkthroughVisuals.js';

const $ = dom.$;
const SMALL_FILE_LINES = 45;
const CONTEXT_PADDING = 3;
const SYMBOL_PATTERN = /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+)*(?:async\s+)?(?:function\*?\s+|class\s+|interface\s+|def\s+|fn\s+|func\s+|type\s+|enum\s+)?(?<name>[A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*(?:\(|=\s*(?:async\s*)?\(|extends\b|implements\b|\{|:)/;
const DECLARATION_PATTERN = /^\s*(?:export\s+)?(?:default\s+)?(?:public\s+|private\s+|protected\s+|static\s+|readonly\s+)*(?:async\s+)?(?:function\*?|class|interface|def|fn|func|type|enum)\s+(?<name>[A-Za-z_$][\w$]*)/;
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'else', 'do', 'try', 'case', 'await', 'new', 'throw', 'const', 'let', 'var']);

function symbolNameAt(line: string): string | undefined {
	const declaration = DECLARATION_PATTERN.exec(line);
	if (declaration?.groups?.name) {
		return declaration.groups.name;
	}
	const method = SYMBOL_PATTERN.exec(line);
	const name = method?.groups?.name;
	return name && !CONTROL_WORDS.has(name) && /\)\s*(?::\s*[^=]+)?\s*\{?\s*$|=>\s*\{?\s*$|\{\s*$/.test(line) ? name : undefined;
}

/** Names of declarations inside a line range (for folded-region placeholders). */
function symbolsIn(model: ITextModel, startLine: number, endLine: number): string[] {
	const names: string[] = [];
	for (let line = startLine; line <= endLine && names.length < 3; line++) {
		const text = model.getLineContent(line);
		if (/^\s{0,4}\S/.test(text)) {
			const name = symbolNameAt(text);
			if (name && !names.includes(name)) {
				names.push(name);
			}
		}
	}
	return names;
}

/** Enclosing declarations for breadcrumbs, found by walking up by indentation. */
function enclosingSymbols(model: ITextModel, line: number): string[] {
	const result: string[] = [];
	let indent = Number.MAX_SAFE_INTEGER;
	for (let current = Math.min(line, model.getLineCount()); current >= 1 && result.length < 3; current--) {
		const text = model.getLineContent(current);
		if (!text.trim()) {
			continue;
		}
		const lineIndent = text.length - text.trimStart().length;
		if (lineIndent < indent) {
			const name = symbolNameAt(text);
			if (name) {
				result.unshift(name);
				indent = lineIndent;
			} else if (lineIndent === 0) {
				indent = 0;
			}
		}
	}
	return result;
}

/**
 * The inline walkthrough. Captured code is shown in a native, read-only code
 * editor bound to an immutable snapshot model; the explanation zone is an
 * editor view zone next to the relevant lines. Later edits to the project never
 * reach these models.
 */
export class WalkthroughEditor extends EditorPane {
	static readonly ID = 'workbench.editor.activeWalkthrough';

	private root!: HTMLElement;
	private header!: HTMLElement;
	private fileStrip!: HTMLElement;
	private breadcrumbs!: HTMLElement;
	private versionLabel!: HTMLElement;
	private editorHost!: HTMLElement;
	private footer!: HTMLElement;
	private codeEditor!: CodeEditorWidget;
	private readonly models = new Map<string, ITextModel>();
	private readonly inputStore = this._register(new DisposableStore());
	private readonly sceneStore = this._register(new MutableDisposable<DisposableStore>());
	private decorations: string[] = [];
	private zoneIds: string[] = [];
	private explanationZone: { id: string; zone: IViewZone; card: HTMLElement } | undefined;
	private renderedScene = -1;
	private renderedSegment = -1;
	private relayoutVisual: (() => void) | undefined;
	private focusKey!: IContextKey<boolean>;
	private player: WalkthroughPlayer | undefined;
	private revealedRanges = new Set<string>();
	private dimension: dom.Dimension | undefined;
	private headerActions!: HTMLElement;
	private pendingHost: HTMLElement | undefined;
	private deeperHost: HTMLElement | undefined;
	private moreDetailButton: HTMLButtonElement | undefined;
	private readonly deeperStore = this._register(new DisposableStore());
	/** Scenes whose deeper explanation is collapsed again after being shown. */
	private readonly collapsedDeeper = new Set<string>();
	/** Deeper explanations already read aloud once, by request id. */
	private readonly spokenDeeper = new Set<string>();
	private feedbackFor: string | undefined;
	private feedback: HTMLElement | undefined;
	private readonly feedbackStore = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IActiveService private readonly activeService: IActiveService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IKeybindingService private readonly keybindingService: IKeybindingService,
	) {
		super(WalkthroughEditor.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, $('.active-walkthrough'));
		this.root.tabIndex = -1;
		const scopedContextKeyService = this._register(this.contextKeyService.createScoped(this.root));
		this.focusKey = ActiveWalkthroughFocus.bindTo(scopedContextKeyService);
		const focusTracker = this._register(dom.trackFocus(this.root));
		this._register(focusTracker.onDidFocus(() => this.focusKey.set(true)));
		this._register(focusTracker.onDidBlur(() => this.focusKey.set(false)));

		const header = this.header = dom.append(this.root, $('.walkthrough-header'));
		const top = dom.append(header, $('.walkthrough-top'));
		this.fileStrip = dom.append(top, $('.walkthrough-files'));
		this.headerActions = dom.append(top, $('.walkthrough-actions'));
		this.renderHeaderActions();
		const crumbRow = dom.append(header, $('.walkthrough-crumbs'));
		this.breadcrumbs = dom.append(crumbRow, $('.breadcrumbs'));
		this.versionLabel = dom.append(crumbRow, $('.captured-version'));

		this.editorHost = dom.append(this.root, $('.walkthrough-code'));
		const scopedInstantiation = this._register(this.instantiationService.createChild(new ServiceCollection([IContextKeyService, scopedContextKeyService])));
		this.codeEditor = this._register(scopedInstantiation.createInstance(CodeEditorWidget, this.editorHost, this.editorOptions(), { isSimpleWidget: false, contributions: [] }));
		this._register(this.configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('editor')) {
				this.codeEditor.updateOptions(this.editorOptions());
			}
		}));
		this._register(this.codeEditor.onDidLayoutChange(() => this.layoutExplanationZone()));

		this.footer = dom.append(this.root, $('.walkthrough-controls'));
	}

	private editorOptions(): ICodeEditorOptions {
		const user = this.configurationService.getValue<ICodeEditorOptions>('editor') ?? {};
		return {
			fontFamily: user.fontFamily,
			fontSize: user.fontSize,
			fontLigatures: user.fontLigatures,
			lineHeight: user.lineHeight,
			readOnly: true,
			domReadOnly: true,
			minimap: { enabled: false },
			glyphMargin: false,
			folding: false,
			lineNumbersMinChars: 4,
			lineDecorationsWidth: 12,
			renderLineHighlight: 'none',
			scrollBeyondLastLine: false,
			overviewRulerLanes: 0,
			overviewRulerBorder: false,
			hideCursorInOverviewRuler: true,
			contextmenu: false,
			occurrencesHighlight: 'off',
			selectionHighlight: false,
			renderValidationDecorations: 'off',
			stickyScroll: { enabled: false },
			guides: { indentation: false },
			matchBrackets: 'never',
			padding: { top: 16, bottom: 32 },
			smoothScrolling: true,
			cursorStyle: 'line-thin',
			cursorBlinking: 'solid',
			wordWrap: 'off',
			fixedOverflowWidgets: true,
			scrollbar: { alwaysConsumeMouseWheel: false, verticalScrollbarSize: 10 },
		};
	}

	override async setInput(input: WalkthroughInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		// Ease the walkthrough in rather than swapping it in abruptly.
		this.root.classList.remove('entering');
		void this.root.offsetWidth;
		this.root.classList.add('entering');
		this.inputStore.clear();
		this.renderedScene = -1;
		this.renderedSegment = -1;
		this.revealedRanges.clear();
		this.disposeModels();
		this.bindPlayer();
		this.inputStore.add(this.activeService.onDidChangePlayer(() => this.bindPlayer()));
		this.inputStore.add(this.activeService.onDidChangeNarration(() => this.renderControls()));
		this.inputStore.add(this.activeService.onDidChangeAgent(() => this.renderControls()));
		this.inputStore.add(this.activeService.onDidChangeChecks(walkthroughId => walkthroughId === this.player?.walkthrough.id && this.renderPending()));
		this.inputStore.add(this.activeService.onDidChangeElaboration(elaboration => elaboration.walkthroughId === this.player?.walkthrough.id && this.renderDeeper()));
		this.inputStore.add(this.activeService.onDidChangeSpeaking(() => this.renderDeeper()));
		this.inputStore.add(this.activeService.onDidChangeHistory(() => this.renderHeaderActions()));
		this.hideFeedback();
		this.feedbackFor = undefined;
	}

	/** Top-right of the walkthrough: history and the editable file, for the whole panel rather than each card. */
	private readonly headerActionStore = this._register(new DisposableStore());

	private renderHeaderActions(): void {
		this.headerActionStore.clear();
		dom.clearNode(this.headerActions);
		const action = (icon: ThemeIcon, label: string, title: string, run: () => unknown) => {
			const element = dom.append(this.headerActions, $('button.walkthrough-action')) as HTMLButtonElement;
			dom.append(element, $('span')).classList.add(...ThemeIcon.asClassNameArray(icon));
			dom.append(element, $('span.label')).textContent = label;
			element.title = title;
			this.headerActionStore.add(dom.addDisposableListener(element, dom.EventType.CLICK, () => run()));
			return element;
		};
		const earlier = this.activeService.history.filter(turn => turn.walkthroughId).length;
		action(Codicon.history, earlier > 1 ? localize('historyCount', "History ({0})", earlier) : localize('history', "History"), localize('historyTitle', "Replay an earlier walkthrough"), () => this.activeService.pickFromHistory());
		action(Codicon.goToFile, localize('openFile', "Open File"), this.withKeybinding(localize('openFileTitle', "Pause and open the editable file at these lines"), WalkthroughCommandIds.OpenFile), () => this.activeService.openCurrentFile());
	}

	private readonly playerListener = this._register(new MutableDisposable());

	private bindPlayer(): void {
		const input = this.input as WalkthroughInput | undefined;
		const player = this.activeService.player;
		if (!input || !player || player.walkthrough.id !== input.walkthrough.id) {
			this.player = undefined;
			this.playerListener.clear();
			this.renderControls();
			return;
		}
		if (this.player !== player) {
			this.player = player;
			this.renderedScene = -1;
			this.playerListener.value = player.onDidChange(() => this.render());
		}
		this.render();
	}

	override clearInput(): void {
		this.player?.pause();
		this.activeService.stopSpeaking();
		this.hideFeedback();
		this.inputStore.clear();
		this.playerListener.clear();
		this.player = undefined;
		this.clearScene();
		this.codeEditor.setModel(null);
		this.disposeModels();
		super.clearInput();
	}

	protected override setEditorVisible(visible: boolean): void {
		super.setEditorVisible(visible);
		if (!visible) {
			// Leaving the walkthrough pauses only the explanation, never the coding agent.
			this.player?.pause();
			this.activeService.stopSpeaking();
		}
	}

	override focus(): void {
		super.focus();
		this.root.focus();
	}

	override layout(dimension: dom.Dimension): void {
		this.dimension = dimension;
		this.root.style.width = `${dimension.width}px`;
		this.root.style.height = `${dimension.height}px`;
		const chrome = this.header.offsetHeight + this.footer.offsetHeight;
		this.codeEditor.layout({ width: dimension.width, height: Math.max(100, dimension.height - chrome) });
		this.relayoutVisual?.();
	}

	private disposeModels(): void {
		for (const model of this.models.values()) {
			model.dispose();
		}
		this.models.clear();
	}

	private modelFor(walkthrough: Walkthrough, file: CapturedFile, version: 'baseline' | 'final'): ITextModel {
		const key = `${version}:${file.path}`;
		let model = this.models.get(key);
		if (!model) {
			const uri = URI.from({ scheme: 'active-snapshot', path: `/${walkthrough.id}/${version}/${file.path}` });
			this.modelService.getModel(uri)?.dispose();
			const text = (version === 'final' ? file.final : file.baseline) ?? '';
			model = this.modelService.createModel(text, this.languageService.createByFilepathOrFirstLine(URI.file(file.path), text.split('\n', 1)[0]), uri);
			this.models.set(key, model);
		}
		return model;
	}

	// ------------------------------------------------------------------ rendering

	private render(): void {
		const player = this.player;
		if (!player) {
			return;
		}
		const { scene: sceneIndex, segment } = player.position;
		if (sceneIndex !== this.renderedScene) {
			this.renderScene(player.walkthrough, sceneIndex);
			this.renderedSegment = -1;
		}
		if (segment !== this.renderedSegment) {
			this.applyCue();
			this.renderedSegment = segment;
		} else {
			this.updateNarrationText();
		}
		this.renderControls();
	}

	private clearScene(): void {
		this.codeEditor.changeViewZones(accessor => {
			for (const id of this.zoneIds) {
				accessor.removeZone(id);
			}
		});
		this.zoneIds = [];
		this.explanationZone = undefined;
		this.relayoutVisual = undefined;
		this.decorations = this.codeEditor.deltaDecorations(this.decorations, []);
		this.codeEditor.setHiddenAreas([], this);
		this.sceneStore.clear();
	}

	private visibleRange(scene: Scene, model: ITextModel): { start: number; end: number } {
		const lineCount = model.getLineCount();
		if (lineCount <= SMALL_FILE_LINES) {
			return { start: 1, end: lineCount };
		}
		const key = `${scene.id}`;
		if (this.revealedRanges.has(key)) {
			return { start: 1, end: lineCount };
		}
		const starts = scene.focus.map(range => range.startLine);
		const ends = scene.focus.map(range => range.endLine);
		let start = scene.context?.startLine ?? Math.min(...starts, scene.anchorLine || lineCount) - CONTEXT_PADDING;
		let end = scene.context?.endLine ?? Math.max(...ends, scene.anchorLine) + CONTEXT_PADDING;
		start = Math.max(1, Math.min(start, ...starts));
		end = Math.min(lineCount, Math.max(end, ...ends, scene.anchorLine));
		return { start, end };
	}

	private renderScene(walkthrough: Walkthrough, sceneIndex: number): void {
		this.clearScene();
		this.renderedScene = sceneIndex;
		const scene = walkthrough.scenes[sceneIndex];
		const file = walkthrough.files[scene.file];
		if (!file) {
			return;
		}
		(this.input as WalkthroughInput | undefined)?.setCurrentFile(scene.file);
		const model = this.modelFor(walkthrough, file, scene.version);
		if (this.codeEditor.getModel() !== model) {
			this.codeEditor.setModel(model);
		}
		const store = new DisposableStore();
		this.sceneStore.value = store;

		const lineCount = model.getLineCount();
		const visible = this.visibleRange(scene, model);
		const hidden: IRange[] = [];
		const placeholders: Array<{ after: number; start: number; end: number }> = [];
		if (visible.start > 1) {
			hidden.push(new Range(1, 1, visible.start - 1, 1));
			placeholders.push({ after: 0, start: 1, end: visible.start - 1 });
		}
		if (visible.end < lineCount) {
			hidden.push(new Range(visible.end + 1, 1, lineCount, 1));
			placeholders.push({ after: visible.end, start: visible.end + 1, end: lineCount });
		}
		this.codeEditor.setHiddenAreas(hidden, this);

		this.codeEditor.changeViewZones(accessor => {
			for (const placeholder of placeholders) {
				const node = $('.active-folded-region');
				const names = symbolsIn(model, placeholder.start, placeholder.end);
				const count = placeholder.end - placeholder.start + 1;
				node.textContent = names.length
					? localize('foldedNamed', "⋯ {0} ({1} lines)", names.join(' · '), count)
					: localize('folded', "⋯ {0} unchanged lines", count);
				node.title = localize('expandFolded', "Click to show the whole captured file");
				store.add(dom.addDisposableListener(node, dom.EventType.CLICK, () => {
					this.revealedRanges.add(scene.id);
					this.renderedScene = -1;
					this.render();
				}));
				const zone: IViewZone = { afterLineNumber: placeholder.after, heightInLines: 1.6, domNode: node, ordinal: placeholder.after === 0 ? 0 : 10_000, suppressMouseDown: false };
				this.zoneIds.push(accessor.addZone(zone));
			}
			const card = $('.active-explain-card');
			const wrapper = $('.active-explain-zone');
			wrapper.appendChild(card);
			const zone: IViewZone = { afterLineNumber: Math.min(Math.max(scene.anchorLine, visible.start - 1), visible.end), heightInPx: 260, domNode: wrapper, ordinal: 5_000, suppressMouseDown: false };
			const id = accessor.addZone(zone);
			this.zoneIds.push(id);
			this.explanationZone = { id, zone, card };
		});

		this.renderHeader(walkthrough, scene, model);
	}

	private renderHeader(walkthrough: Walkthrough, scene: Scene, model: ITextModel): void {
		dom.clearNode(this.fileStrip);
		const files = [...new Set(walkthrough.scenes.map(candidate => candidate.file))];
		for (const path of files) {
			const captured = walkthrough.files[path];
			const tab = dom.append(this.fileStrip, $('button.walkthrough-file-tab'));
			tab.classList.toggle('active', path === scene.file);
			dom.append(tab, $('span.name')).textContent = path.split('/').pop() ?? path;
			if (captured) {
				dom.append(tab, $('span.added')).textContent = `+${captured.added}`;
				dom.append(tab, $('span.removed')).textContent = `−${captured.removed}`;
			}
			tab.title = path;
			this.sceneStore.value?.add(dom.addDisposableListener(tab, dom.EventType.CLICK, () => {
				const target = walkthrough.scenes.findIndex(candidate => candidate.file === path);
				if (target >= 0) {
					this.player?.seek({ scene: target, segment: 0 });
				}
			}));
		}
		dom.clearNode(this.breadcrumbs);
		const firstFocus = scene.focus[0]?.startLine ?? scene.anchorLine;
		const symbols = scene.symbol ? scene.symbol.split(/\s*[›>.]\s*/).filter(Boolean) : enclosingSymbols(model, firstFocus);
		const segments = [...scene.file.split('/'), ...symbols];
		segments.forEach((segment, index) => {
			if (index > 0) {
				dom.append(this.breadcrumbs, $('span.separator')).textContent = '›';
			}
			dom.append(this.breadcrumbs, $('span.crumb')).textContent = segment;
		});
		this.relayoutChrome();
		this.versionLabel.textContent = scene.version === 'baseline'
			? localize('baselineVersion', "Before the change · turn {0}", walkthrough.turnIndex)
			: localize('capturedVersion', "Captured version · turn {0}", walkthrough.turnIndex);
	}

	/** Applies the current narration segment's cue: focus emphasis, diagram highlight, progressive reveal. */
	private applyCue(): void {
		const player = this.player;
		const zone = this.explanationZone;
		if (!player || !zone) {
			return;
		}
		const state = player.visual;
		const scene = state.scene;
		const model = this.codeEditor.getModel();
		if (!model) {
			return;
		}
		const lineCount = model.getLineCount();
		const decorations: IModelDeltaDecoration[] = [];
		const focusLines = new Set<number>();
		scene.focus.forEach((range, index) => {
			const current = state.focus === undefined || state.focus === index;
			for (let line = range.startLine; line <= Math.min(range.endLine, lineCount); line++) {
				focusLines.add(line);
			}
			decorations.push({
				range: new Range(range.startLine, 1, Math.min(range.endLine, lineCount), 1),
				options: { description: 'active-focus', isWholeLine: true, className: current ? 'active-focus-line' : 'active-focus-line-secondary', stickiness: TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges },
			});
		});
		if (focusLines.size) {
			for (let line = 1; line <= lineCount; line++) {
				if (!focusLines.has(line) && model.getLineLength(line) > 0) {
					decorations.push({ range: new Range(line, 1, line, model.getLineMaxColumn(line)), options: { description: 'active-dim', inlineClassName: 'active-dim-text' } });
				}
			}
		}
		this.decorations = this.codeEditor.deltaDecorations(this.decorations, decorations);
		this.renderCard(player.walkthrough, scene, state.nodes, state.reveal);
		this.revealFocus(scene, state.focus);
	}

	private renderCard(walkthrough: Walkthrough, scene: Scene, nodes: readonly string[], reveal: number | undefined): void {
		const zone = this.explanationZone!;
		const card = zone.card;
		dom.clearNode(card);
		const store = this.sceneStore.value!;
		const head = dom.append(card, $('.card-head'));
		dom.append(head, $('.eyebrow')).textContent = scene.label;
		const moreDetail = dom.append(head, $('button.more-detail')) as HTMLButtonElement;
		this.moreDetailButton = moreDetail;
		store.add(dom.addDisposableListener(moreDetail, dom.EventType.CLICK, () => this.toggleDeeper(walkthrough, scene)));
		dom.append(card, $('h2.title')).textContent = scene.title;
		const kind = visualKindLabel(scene.visual);
		if (kind) {
			const term = walkthrough.terms.find(candidate => scene.title.toLowerCase().includes(candidate.name.toLowerCase()) || scene.narration.some(segment => segment.text.toLowerCase().includes(candidate.name.toLowerCase())));
			dom.append(card, $('.subtitle')).textContent = term ? `${term.name} · ${kind}` : kind;
		}
		this.relayoutVisual = undefined;
		if (scene.visual) {
			const visualHost = dom.append(card, $('.visual'));
			const rendered = renderVisual(visualHost, scene.visual, walkthrough.files, { nodes, reveal }, this.languageService);
			this.relayoutVisual = rendered.layout;
			void rendered.ready.then(() => this.layoutExplanationZone());
			if (scene.visual.caption) {
				dom.append(card, $('.caption')).textContent = scene.visual.caption;
			}
		}
		const narration = dom.append(card, $('p.narration'));
		narration.setAttribute('aria-live', 'polite');
		this.updateNarrationText(narration);
		this.deeperHost = dom.append(card, $('.deeper'));
		this.pendingHost = dom.append(card, $('.pending'));
		this.renderDeeper();
		this.renderPending();
		this.layoutExplanationZone();
	}

	/** Checks that hadn't finished when the walkthrough was made; they update live as the tasks report back. */
	private renderPending(): void {
		const player = this.player;
		const host = this.pendingHost;
		if (!player || !host) {
			return;
		}
		dom.clearNode(host);
		const scene = player.walkthrough.scenes[player.position.scene];
		const checks = this.activeService.pendingChecks(player.walkthrough);
		const labels = [...(scene.pending ?? []), ...checks.map(check => check.label)].filter((value, index, all) => all.indexOf(value) === index);
		for (const label of labels) {
			const state: PendingCheck['state'] = checks.find(check => check.label === label)?.state ?? 'running';
			const pill = dom.append(host, $('span.pending-pill'));
			pill.classList.add(state);
			const icon = dom.append(pill, $('span'));
			if (state === 'finished') {
				icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.passFilled));
			} else if (state === 'failed') {
				icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.error));
			} else {
				icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.loading), 'codicon-modifier-spin');
			}
			dom.append(pill, $('span')).textContent = state === 'finished'
				? localize('checkFinished', "Finished: {0}", label)
				: state === 'failed'
					? localize('checkFailed', "Failed: {0}", label)
					: localize('pendingCheck', "Still running: {0}", label);
		}
		host.classList.toggle('hidden', labels.length === 0);
		this.layoutExplanationZone();
	}

	private toggleDeeper(walkthrough: Walkthrough, scene: Scene): void {
		const key = `${walkthrough.id}/${scene.id}`;
		const existing = this.activeService.elaboration(walkthrough.id, scene.id);
		if (existing && existing.status !== 'error' && !this.collapsedDeeper.has(key)) {
			this.collapsedDeeper.add(key);
			this.activeService.stopSpeaking();
		} else {
			this.collapsedDeeper.delete(key);
			this.player?.pause();
			this.activeService.elaborate(walkthrough.id, scene.id);
		}
		this.renderDeeper();
	}

	/** The deeper re-explanation of the current scene, streamed in and then read aloud. */
	private renderDeeper(): void {
		const player = this.player;
		const host = this.deeperHost;
		if (!player || !host) {
			return;
		}
		this.deeperStore.clear();
		dom.clearNode(host);
		const scene = player.walkthrough.scenes[player.position.scene];
		const key = `${player.walkthrough.id}/${scene.id}`;
		const elaboration = this.activeService.elaboration(player.walkthrough.id, scene.id);
		const open = !!elaboration && !this.collapsedDeeper.has(key);
		if (this.moreDetailButton) {
			dom.clearNode(this.moreDetailButton);
			dom.append(this.moreDetailButton, $('span')).classList.add(...ThemeIcon.asClassNameArray(open ? Codicon.chevronUp : Codicon.listTree));
			dom.append(this.moreDetailButton, $('span')).textContent = open ? localize('lessDetail', "Less detail") : localize('moreDetail', "More detail");
			this.moreDetailButton.title = open ? localize('lessDetailTitle', "Hide the deeper explanation") : localize('moreDetailTitle', "Pause and re-explain this part in greater depth");
		}
		host.classList.toggle('hidden', !open);
		if (!open || !elaboration) {
			this.layoutExplanationZone();
			return;
		}
		const head = dom.append(host, $('.deeper-head'));
		const icon = dom.append(head, $('span'));
		icon.classList.add(...ThemeIcon.asClassNameArray(elaboration.status === 'streaming' ? Codicon.loading : elaboration.status === 'error' ? Codicon.error : Codicon.lightbulb));
		if (elaboration.status === 'streaming') {
			icon.classList.add('codicon-modifier-spin');
		}
		dom.append(head, $('span')).textContent = elaboration.status === 'streaming' && !elaboration.text
			? localize('deeperLoading', "Working out a deeper explanation…")
			: localize('deeperTitle', "In more depth");
		const body = dom.append(host, $('.deeper-body'));
		for (const paragraph of elaboration.text.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean)) {
			dom.append(body, $('p')).textContent = paragraph;
		}
		const actions = dom.append(host, $('.deeper-actions'));
		const button = (label: string, run: () => void, primary = false) => {
			const element = dom.append(actions, $(primary ? 'button.primary' : 'button.secondary')) as HTMLButtonElement;
			element.textContent = label;
			this.deeperStore.add(dom.addDisposableListener(element, dom.EventType.CLICK, () => run()));
		};
		if (elaboration.status === 'error') {
			button(localize('deeperRetry', "Try Again"), () => this.toggleDeeper(player.walkthrough, scene));
		} else if (elaboration.status === 'done') {
			if (this.activeService.narration.available) {
				if (this.activeService.speaking) {
					button(localize('deeperStop', "Stop Reading"), () => this.activeService.stopSpeaking());
				} else {
					button(localize('deeperListen', "Read Aloud"), () => void this.activeService.speak(elaboration.text));
				}
				if (!this.spokenDeeper.has(elaboration.requestId)) {
					this.spokenDeeper.add(elaboration.requestId);
					void this.activeService.speak(elaboration.text);
				}
			}
			button(localize('deeperContinue', "Continue Walkthrough"), () => {
				this.activeService.stopSpeaking();
				this.collapsedDeeper.add(key);
				player.play();
				this.renderDeeper();
			}, true);
		}
		this.layoutExplanationZone();
	}

	// ------------------------------------------------------------------ detail feedback

	/** Occasionally asks, at the end of a walkthrough, whether the level of detail suited the learner. */
	private maybeAskForFeedback(): void {
		const player = this.player;
		if (!player || player.state !== 'ended' || this.feedbackFor === player.walkthrough.id) {
			return;
		}
		this.feedbackFor = player.walkthrough.id;
		if (this.activeService.shouldAskForFeedback(player.walkthrough)) {
			this.showFeedback(player.walkthrough);
		}
	}

	private showFeedback(walkthrough: Walkthrough): void {
		this.hideFeedback();
		const panel = dom.append(this.root, $('.detail-feedback'));
		this.feedback = panel;
		dom.append(panel, $('.feedback-question')).textContent = localize('feedbackQuestion', "How was the level of detail in this walkthrough?");
		const options = dom.append(panel, $('.feedback-options'));
		const choices: Array<[DetailFeedback, string]> = [
			['tooMuch', localize('feedbackTooMuch', "Too much")],
			['right', localize('feedbackRight', "About right")],
			['tooLittle', localize('feedbackTooLittle', "Too little")],
		];
		for (const [value, label] of choices) {
			const choice = dom.append(options, $('button.secondary')) as HTMLButtonElement;
			choice.textContent = label;
			this.feedbackStore.add(dom.addDisposableListener(choice, dom.EventType.CLICK, async () => {
				await this.activeService.recordDetailFeedback(walkthrough, value);
				const topics = walkthrough.terms.map(term => term.name).slice(0, 2);
				dom.clearNode(panel);
				dom.append(panel, $('.feedback-thanks')).textContent = value === 'right'
					? localize('feedbackThanksRight', "Thanks. Active will keep explaining at this level.")
					: value === 'tooMuch'
						? (topics.length ? localize('feedbackThanksLessTopic', "Thanks. Future walkthroughs will go a little lighter, especially on {0}.", topics.join(' and ')) : localize('feedbackThanksLess', "Thanks. Future walkthroughs will go a little lighter."))
						: (topics.length ? localize('feedbackThanksMoreTopic', "Thanks. Future walkthroughs will go a little deeper, especially on {0}.", topics.join(' and ')) : localize('feedbackThanksMore', "Thanks. Future walkthroughs will go a little deeper."));
				setTimeout(() => this.hideFeedback(), 3500);
			}));
		}
		const dismiss = dom.append(panel, $('button.feedback-dismiss')) as HTMLButtonElement;
		dismiss.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		dismiss.title = localize('feedbackDismiss', "Not now");
		this.feedbackStore.add(dom.addDisposableListener(dismiss, dom.EventType.CLICK, () => this.hideFeedback()));
	}

	private hideFeedback(): void {
		this.feedbackStore.clear();
		this.feedback?.remove();
		this.feedback = undefined;
	}

	private updateNarrationText(target?: HTMLElement): void {
		const player = this.player;
		// eslint-disable-next-line no-restricted-syntax
		const narration = target ?? this.explanationZone?.card.querySelector<HTMLElement>('p.narration') ?? undefined;
		if (!player || !narration) {
			return;
		}
		dom.clearNode(narration);
		const scene = player.walkthrough.scenes[player.position.scene];
		scene.narration.forEach((segment, index) => {
			const span = dom.append(narration, $('span.segment'));
			span.textContent = `${segment.text} `;
			span.classList.add(index < player.position.segment ? 'spoken' : index === player.position.segment ? 'current' : 'upcoming');
		});
	}

	private layoutExplanationZone(): void {
		const zone = this.explanationZone;
		if (!zone) {
			return;
		}
		const layoutInfo = this.codeEditor.getLayoutInfo();
		zone.card.style.width = `${Math.max(320, layoutInfo.contentWidth - 36)}px`;
		dom.scheduleAtNextAnimationFrame(dom.getWindow(this.root), () => {
			this.relayoutVisual?.();
			const height = zone.card.offsetHeight + 28;
			if (height > 28 && Math.abs((zone.zone.heightInPx ?? 0) - height) > 1) {
				zone.zone.heightInPx = height;
				this.codeEditor.changeViewZones(accessor => accessor.layoutZone(zone.id));
				dom.scheduleAtNextAnimationFrame(dom.getWindow(this.root), () => this.relayoutVisual?.());
			}
		});
	}

	private revealFocus(scene: Scene, focusIndex: number | undefined): void {
		const range = scene.focus[focusIndex ?? 0];
		const line = range ? range.startLine : Math.max(1, scene.anchorLine);
		const editor: ICodeEditor = this.codeEditor;
		const lineHeight = editor.getOption(EditorOption.lineHeight);
		dom.scheduleAtNextAnimationFrame(dom.getWindow(this.root), () => {
			const top = editor.getTopForLineNumber(line) - 2 * lineHeight;
			editor.setScrollTop(Math.max(0, top), ScrollType.Smooth);
		});
	}

	// ------------------------------------------------------------------ controls

	private withKeybinding(label: string, commandId: string): string {
		const keybinding = this.keybindingService.lookupKeybinding(commandId)?.getLabel();
		return keybinding ? `${label} (${keybinding})` : label;
	}

	private readonly controlsStore = this._register(new DisposableStore());

	private renderControls(): void {
		if (!this.footer) {
			return;
		}
		this.controlsStore.clear();
		dom.clearNode(this.footer);
		const player = this.player;
		const walkthrough = player?.walkthrough;
		const button = (label: string, commandId: string, title: string, run: () => void, classes = '') => {
			const element = dom.append(this.footer, $(`button.control${classes}`)) as HTMLButtonElement;
			element.textContent = label;
			element.title = this.withKeybinding(title, commandId);
			this.controlsStore.add(dom.addDisposableListener(element, dom.EventType.CLICK, () => {
				run();
				this.root.focus();
			}));
			return element;
		};
		const left = dom.append(this.footer, $('.spacer'));
		void left;
		const rewind = button(localize('rewind', "← Rewind"), WalkthroughCommandIds.Rewind, localize('rewindTitle', "Back to the previous narration step"), () => player?.rewind());
		rewind.disabled = !player || (player.position.scene === 0 && player.position.segment === 0);
		const playLabel = !player ? localize('play', "▶ Play") : player.state === 'ended' ? localize('replay', "↺ Replay") : player.playing ? localize('pause', "⏸ Pause") : localize('resume', "▶ Resume");
		const primary = button(playLabel, WalkthroughCommandIds.TogglePlayback, localize('toggleTitle', "Pause or resume the walkthrough (the coding agent keeps working)"), () => player?.toggle(), '.primary');
		primary.disabled = !player;
		const next = button(localize('next', "Next →"), WalkthroughCommandIds.Advance, localize('nextTitle', "Skip to the next idea"), () => player?.advance());
		next.disabled = !player || player.state === 'ended';
		const progress = dom.append(this.footer, $('.progress'));
		progress.textContent = walkthrough ? `${player!.position.scene + 1} / ${walkthrough.scenes.length}` : '';
		const status = dom.append(this.footer, $('.playback-status'));
		if (player?.narrationIssue) {
			status.textContent = localize('captionsOnly', "Captions only — {0}", player.narrationIssue);
			status.classList.add('warning');
		} else if (player?.state === 'loading') {
			status.textContent = localize('preparingNarration', "Preparing narration…");
		} else if (player?.state === 'ended') {
			status.textContent = localize('complete', "Walkthrough complete");
		}
		// Chat is one click away through the floating Chat button (and its keybinding).
		this.relayoutChrome();
		this.maybeAskForFeedback();
	}

	/** Header and footer heights depend on their content; keep the code editor sized to what remains. */
	private relayoutChrome(): void {
		if (this.dimension) {
			const chrome = this.header.offsetHeight + this.footer.offsetHeight;
			const height = Math.max(100, this.dimension.height - chrome);
			if (this.codeEditor.getLayoutInfo().height !== height) {
				this.codeEditor.layout({ width: this.dimension.width, height });
			}
		}
	}
}
