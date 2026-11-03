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
import { ActiveWalkthroughFocus, agentLabel, Elaboration, IActiveService } from './activeService.js';
import { WalkthroughCommandIds } from './walkthroughCommands.js';
import { WalkthroughPlayer } from './walkthroughPlayer.js';
import { isRedundantVisual, LineChanges, lineChanges, RenderedVisual, renderVisual, visualKindLabel } from './walkthroughVisuals.js';

const $ = dom.$;
const SMALL_FILE_LINES = 45;
const CONTEXT_PADDING = 3;
/** Focus ranges closer than this share one visible piece; farther apart, the lines between fold away. */
const MERGE_GAP_LINES = 6;
/** How long after a cue the view keeps re-fitting while the card settles into its final size. */
const REVEAL_SETTLE_MS = 2500;
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
	private scenePieces: Array<{ start: number; end: number }> = [];
	/** What changed in the shown version of the scene's file (none when showing the version before the change). */
	private sceneChanges: LineChanges | undefined;
	private sceneNewFile = false;
	private renderedScene = -1;
	private renderedSegment = -1;
	private relayoutVisual: (() => void) | undefined;
	/** The current scene's card is built once and then updated in place, so its transitions can play. */
	private cardVisual: RenderedVisual | undefined;
	private cardBuilt = false;
	private feedbackAnswered = false;
	private focusKey!: IContextKey<boolean>;
	private player: WalkthroughPlayer | undefined;
	private revealedRanges = new Set<string>();
	private dimension: dom.Dimension | undefined;
	private headerActions!: HTMLElement;
	private pendingHost: HTMLElement | undefined;
	private deeperHost: HTMLElement | undefined;
	private moreDetailButton: HTMLButtonElement | undefined;
	private askButton: HTMLButtonElement | undefined;
	private readonly deeperStore = this._register(new DisposableStore());
	/** Scenes whose deeper explanation is collapsed again after being shown. */
	private readonly collapsedDeeper = new Set<string>();
	/** Deeper explanations and answers already read aloud once, by request id. */
	private readonly spokenDeeper = new Set<string>();
	/** Requests made while narration was playing: the walkthrough carries on once they've been read aloud. */
	private readonly resumeAfterDeeper = new Set<string>();
	/** Why an answer couldn't be read aloud, by request id. */
	private readonly speechErrors = new Map<string, string>();
	/** The scene whose question box is open, and whether narration was playing when it opened. */
	private asking: { readonly key: string; readonly resume: boolean; draft: string } | undefined;
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
		// Scrolling by hand ends automatic repositioning until the narration moves on.
		this._register(this.codeEditor.onMouseWheel(() => { this.reveal = undefined; }));

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
		// Each walkthrough has its own tab; switching tabs switches which one plays.
		this.activeService.selectWalkthrough(input.walkthrough);
		this.bindPlayer();
		this.inputStore.add(this.activeService.onDidChangePlayer(() => this.bindPlayer()));
		this.inputStore.add(this.activeService.onDidChangeNarration(() => {
			this.renderControls();
			// Audio turned off or on: the highlighting switches between following the voice and the whole scene.
			this.applyCue();
		}));
		this.inputStore.add(this.activeService.onDidChangeAgent(() => this.renderControls()));
		this.inputStore.add(this.activeService.onDidChangeChecks(walkthroughId => walkthroughId === this.player?.walkthrough.id && this.renderPending()));
		this.inputStore.add(this.activeService.onDidChangeElaboration(elaboration => {
			if (elaboration.walkthroughId === this.player?.walkthrough.id) {
				this.renderDeeper();
				this.maybeSpeakDeeper();
			}
		}));
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
		action(Codicon.goToFile, localize('openFile', "Open File"), this.withKeybinding(localize('openFileTitle', "Pause and open this file at these lines"), WalkthroughCommandIds.OpenFile), () => this.activeService.openCurrentFile());
		action(Codicon.settingsGear, localize('settings', "Settings"), localize('settingsTitle', "Active Settings: models, effort, voice"), () => this.activeService.openSettings());
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
			this.playerListener.value = player.onDidChange(() => {
				this.render();
				// A deeper explanation waits for the sentence being read to finish.
				this.maybeSpeakDeeper();
			});
		}
		this.render();
	}

	override clearInput(): void {
		this.activeService.setControlsHeight(0);
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
		if (this.isVisible()) {
			this.activeService.setControlsHeight(this.footer.offsetHeight);
		}
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
		this.cardVisual = undefined;
		this.cardBuilt = false;
		this.decorations = this.codeEditor.deltaDecorations(this.decorations, []);
		this.codeEditor.setHiddenAreas([], this);
		this.sceneStore.clear();
	}

	/**
	 * The parts of the file a scene shows: each focus range with a little context. Distant ranges stay
	 * separate (the lines between them fold away), so the card is never far from the code it's about.
	 */
	private visiblePieces(scene: Scene, model: ITextModel): Array<{ start: number; end: number }> {
		const lineCount = model.getLineCount();
		if (lineCount <= SMALL_FILE_LINES || this.revealedRanges.has(scene.id)) {
			return [{ start: 1, end: lineCount }];
		}
		const ranges = (scene.focus.length ? scene.focus : [{ startLine: scene.anchorLine || 1, endLine: scene.anchorLine || 1 }])
			.map(range => ({ start: Math.max(1, range.startLine - CONTEXT_PADDING), end: Math.min(lineCount, range.endLine + CONTEXT_PADDING) }))
			.sort((a, b) => a.start - b.start);
		const pieces: Array<{ start: number; end: number }> = [];
		for (const range of ranges) {
			const last = pieces[pieces.length - 1];
			if (last && range.start - last.end <= MERGE_GAP_LINES + 1) {
				last.end = Math.max(last.end, range.end);
			} else {
				pieces.push({ ...range });
			}
		}
		// The planner's context may widen the outer edges a little, but never bridges a gap.
		if (scene.context) {
			pieces[0].start = Math.max(1, Math.min(pieces[0].start, Math.max(scene.context.startLine, pieces[0].start - MERGE_GAP_LINES)));
			const last = pieces[pieces.length - 1];
			last.end = Math.min(lineCount, Math.max(last.end, Math.min(scene.context.endLine, last.end + MERGE_GAP_LINES)));
		}
		return pieces;
	}

	/** The card follows the piece holding the focus being narrated (the first one by default). */
	private cardLineFor(scene: Scene, focusIndex: number | undefined): number {
		const pieces = this.scenePieces;
		const focus = scene.focus[focusIndex ?? 0];
		const line = focus ? focus.endLine : scene.anchorLine;
		const piece = pieces.find(candidate => line >= candidate.start && line <= candidate.end) ?? pieces[pieces.length - 1];
		return piece ? piece.end : line;
	}

	/** Moves the card when the narration moves to a focus in another part of the file. */
	private placeCard(scene: Scene, focusIndex: number | undefined): void {
		const zone = this.explanationZone;
		if (!zone) {
			return;
		}
		const line = this.cardLineFor(scene, focusIndex);
		if (zone.zone.afterLineNumber === line) {
			return;
		}
		this.codeEditor.changeViewZones(accessor => {
			accessor.removeZone(zone.id);
			this.zoneIds = this.zoneIds.filter(id => id !== zone.id);
			zone.zone.afterLineNumber = line;
			zone.id = accessor.addZone(zone.zone);
			this.zoneIds.push(zone.id);
		});
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
		const pieces = this.scenePieces = this.visiblePieces(scene, model);
		// A brand-new file is all new: say so once instead of marking every line.
		this.sceneNewFile = scene.version === 'final' && file.baseline === null;
		this.sceneChanges = scene.version === 'final' && !this.sceneNewFile ? lineChanges(file) : undefined;
		const hidden: IRange[] = [];
		const placeholders: Array<{ after: number; start: number; end: number }> = [];
		let next = 1;
		for (const piece of [...pieces, { start: lineCount + 1, end: lineCount + 1 }]) {
			if (piece.start > next) {
				hidden.push(new Range(next, 1, piece.start - 1, 1));
				placeholders.push({ after: next - 1, start: next, end: piece.start - 1 });
			}
			next = piece.end + 1;
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
				// Monaco hides a zone when the line after it is hidden; these sit right next to hidden ranges.
				const zone: IViewZone = { afterLineNumber: placeholder.after, heightInLines: 1.6, domNode: node, ordinal: placeholder.after === 0 ? 0 : 10_000, suppressMouseDown: false, showInHiddenAreas: true };
				this.zoneIds.push(accessor.addZone(zone));
			}
			const card = $('.active-explain-card');
			const wrapper = $('.active-explain-zone');
			wrapper.appendChild(card);
			const zone: IViewZone = { afterLineNumber: this.cardLineFor(scene, undefined), heightInPx: 260, domNode: wrapper, ordinal: 5_000, suppressMouseDown: false, showInHiddenAreas: true };
			const id = accessor.addZone(zone);
			this.zoneIds.push(id);
			this.explanationZone = { id, zone, card };
		});
		// The card grows after it's laid out (highlighted code, KaTeX, streamed detail): keep its zone the same height.
		const observer = store.add(new dom.DisposableResizeObserver('activeExplainCard', () => this.fitZoneToCard(), dom.getWindow(this.root)));
		store.add(observer.observe(this.explanationZone!.card));

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
			// A zero count is implied, so only non-zero counts are shown.
			if (captured?.added) {
				dom.append(tab, $('span.added')).textContent = `+${captured.added}`;
			}
			if (captured?.removed) {
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
		const version = scene.version === 'baseline'
			? localize('baselineVersion', "Before the change · turn {0}", walkthrough.turnIndex)
			: walkthrough.chapter
				? localize('capturedChapter', "Chapter {0} · turn {1}", walkthrough.chapter, walkthrough.turnIndex)
				: localize('capturedVersion', "Captured version · turn {0}", walkthrough.turnIndex);
		dom.clearNode(this.versionLabel);
		// With several agents, every explanation says whose work it is.
		const owner = agentLabel(this.activeService, walkthrough.agentId, walkthrough.agentName);
		if (owner) {
			const chip = dom.append(this.versionLabel, $('span.active-agent-chip'));
			chip.style.setProperty('--agent-color', `var(--active-agent-${owner.colorIndex}, var(--vscode-charts-blue))`);
			chip.textContent = owner.name;
			chip.title = localize('agentWork', "This explains {0}'s work", owner.name);
		}
		dom.append(this.versionLabel, $('span')).textContent = version;
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
		// Thin gutter marks, like source control's: new lines, changed lines, and where lines were removed.
		const changes = this.sceneChanges;
		if (changes) {
			const mark = (line: number, className: string, hover: string) => decorations.push({
				range: new Range(line, 1, line, 1),
				options: { description: 'active-change', linesDecorationsClassName: className, linesDecorationsTooltip: hover },
			});
			for (const line of changes.added) {
				if (line <= lineCount) {
					mark(line, 'active-line-added', localize('lineAdded', "New in this change"));
				}
			}
			for (const line of changes.modified) {
				if (line <= lineCount) {
					mark(line, 'active-line-modified', localize('lineModified', "Changed in this change"));
				}
			}
			for (const line of changes.removedAfter) {
				mark(Math.min(Math.max(line, 1), lineCount), line === 0 ? 'active-line-removed-above' : 'active-line-removed-below', localize('lineRemoved', "Lines removed here"));
			}
		}
		if (focusLines.size) {
			for (let line = 1; line <= lineCount; line++) {
				if (!focusLines.has(line) && model.getLineLength(line) > 0) {
					decorations.push({ range: new Range(line, 1, line, model.getLineMaxColumn(line)), options: { description: 'active-dim', inlineClassName: 'active-dim-text' } });
				}
			}
		}
		this.decorations = this.codeEditor.deltaDecorations(this.decorations, decorations);
		this.renderCard(player.walkthrough, scene, state.nodes, state.reveal);
		this.placeCard(scene, state.focus);
		this.revealFocus(scene, state.focus);
	}

	private renderCard(walkthrough: Walkthrough, scene: Scene, nodes: readonly string[], reveal: number | undefined): void {
		const zone = this.explanationZone!;
		const card = zone.card;
		if (this.cardBuilt) {
			// Same scene, next narration segment: move highlights and text in place.
			if (scene.visual && !this.cardVisual?.update && !isRedundantVisual(scene, walkthrough.files)) {
				// eslint-disable-next-line no-restricted-syntax
				const host = card.querySelector<HTMLElement>('.visual');
				if (host) {
					dom.clearNode(host);
					this.cardVisual = renderVisual(host, scene.visual, walkthrough.files, { nodes, reveal }, this.languageService);
					this.relayoutVisual = this.cardVisual.layout;
					void this.cardVisual.ready.then(() => this.layoutExplanationZone());
				}
			} else {
				this.cardVisual?.update?.({ nodes, reveal });
			}
			this.updateNarrationText();
			this.layoutExplanationZone();
			return;
		}
		this.cardBuilt = true;
		dom.clearNode(card);
		const store = this.sceneStore.value!;
		const head = dom.append(card, $('.card-head'));
		const eyebrow = dom.append(head, $('.eyebrow'));
		dom.append(eyebrow, $('span')).textContent = scene.label;
		this.renderChangeSummary(eyebrow, scene);
		const headActions = dom.append(head, $('.card-actions'));
		// Back to chat, to ask the coding agent for a change, with what this card explains as context.
		const change = dom.append(headActions, $('button.more-detail.request-change')) as HTMLButtonElement;
		dom.append(change, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.editSparkle));
		dom.append(change, $('span')).textContent = localize('requestChange', "Request a change");
		change.title = localize('requestChangeTitle', "Ask {0} for a change in chat, with this part of the walkthrough as context: a change to this code, or elsewhere based on it", this.activeService.agent.provider.shortName);
		store.add(dom.addDisposableListener(change, dom.EventType.CLICK, () => void this.requestChange(walkthrough, scene)));
		const ask = dom.append(headActions, $('button.more-detail.ask')) as HTMLButtonElement;
		this.askButton = ask;
		store.add(dom.addDisposableListener(ask, dom.EventType.CLICK, () => this.openAsk(walkthrough, scene)));
		const moreDetail = dom.append(headActions, $('button.more-detail')) as HTMLButtonElement;
		this.moreDetailButton = moreDetail;
		store.add(dom.addDisposableListener(moreDetail, dom.EventType.CLICK, () => this.toggleDeeper(walkthrough, scene)));
		dom.append(card, $('h2.title')).textContent = scene.title;
		const kind = isRedundantVisual(scene, walkthrough.files) ? '' : visualKindLabel(scene.visual);
		if (kind) {
			const term = walkthrough.terms.find(candidate => scene.title.toLowerCase().includes(candidate.name.toLowerCase()) || scene.narration.some(segment => segment.text.toLowerCase().includes(candidate.name.toLowerCase())));
			dom.append(card, $('.subtitle')).textContent = term ? `${term.name} · ${kind}` : kind;
		}
		this.relayoutVisual = undefined;
		// The words being read come first, right under the code they're about; the visual follows.
		const narration = dom.append(card, $('p.narration'));
		narration.setAttribute('aria-live', 'polite');
		this.updateNarrationText(narration);
		if (scene.visual && !isRedundantVisual(scene, walkthrough.files)) {
			const visualHost = dom.append(card, $('.visual'));
			const rendered = renderVisual(visualHost, scene.visual, walkthrough.files, { nodes, reveal }, this.languageService);
			this.cardVisual = rendered;
			this.relayoutVisual = rendered.layout;
			void rendered.ready.then(() => this.layoutExplanationZone());
			if (scene.visual.caption) {
				dom.append(card, $('.caption')).textContent = scene.visual.caption;
			}
		}
		this.deeperHost = dom.append(card, $('.deeper'));
		this.pendingHost = dom.append(card, $('.pending'));
		this.renderDeeper();
		this.renderPending();
		this.layoutExplanationZone();
	}

	/** "12 new · 3 changed" for the highlighted lines, keyed to the gutter marks. */
	private renderChangeSummary(parent: HTMLElement, scene: Scene): void {
		if (this.sceneNewFile) {
			dom.append(dom.append(parent, $('span.change-summary')), $('span.change-chip.added')).textContent = localize('newFile', "New file");
			return;
		}
		const changes = this.sceneChanges;
		if (!changes) {
			return;
		}
		let added = 0;
		let modified = 0;
		for (const range of scene.focus) {
			for (let line = range.startLine; line <= range.endLine; line++) {
				added += changes.added.has(line) ? 1 : 0;
				modified += changes.modified.has(line) ? 1 : 0;
			}
		}
		if (!added && !modified) {
			dom.append(parent, $('span.change-summary.unchanged')).textContent = localize('unchangedLines', "Existing code");
			return;
		}
		const summary = dom.append(parent, $('span.change-summary'));
		if (added) {
			dom.append(summary, $('span.change-chip.added')).textContent = localize('addedLines', "{0} new", added);
		}
		if (modified) {
			dom.append(summary, $('span.change-chip.modified')).textContent = localize('modifiedLines', "{0} changed", modified);
		}
		summary.title = localize('changeSummaryTitle', "Lines in the highlighted code that this change added or modified. The same colors mark them in the gutter.");
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
		if (existing && !existing.question && existing.status !== 'error' && !this.collapsedDeeper.has(key)) {
			this.collapsedDeeper.add(key);
			this.resumeAfterDeeper.delete(existing.requestId);
			this.activeService.stopSpeaking();
		} else {
			this.request(walkthrough, scene, undefined, !!this.player?.playing);
		}
		this.renderDeeper();
	}

	/**
	 * Asks for "More detail" (no question) or answers a question about the scene. Narration that is playing
	 * finishes its sentence first; the answer is then read aloud and, if narration was playing, the walkthrough
	 * carries on after it.
	 */
	private request(walkthrough: Walkthrough, scene: Scene, question: string | undefined, resume: boolean): void {
		this.collapsedDeeper.delete(`${walkthrough.id}/${scene.id}`);
		this.player?.pauseAfterSegment();
		const elaboration = this.activeService.elaborate(walkthrough.id, scene.id, question);
		if (resume) {
			this.resumeAfterDeeper.add(elaboration.requestId);
		}
		this.maybeSpeakDeeper();
	}

	/** Context for a change request: the code a card explains (its highlighted lines, or the whole captured file) and what it says. */
	private async requestChange(walkthrough: Walkthrough, scene: Scene): Promise<void> {
		const lines = (walkthrough.files[scene.file]?.final ?? '').split(/\r?\n/).length;
		const startLine = scene.focus.length ? Math.min(...scene.focus.map(range => range.startLine)) : 1;
		const endLine = scene.focus.length ? Math.max(...scene.focus.map(range => range.endLine)) : lines;
		await this.activeService.requestChange({ file: scene.file, startLine, endLine }, { title: scene.title, text: scene.narration.map(segment => segment.text).join(' ') });
	}

	private openAsk(walkthrough: Walkthrough, scene: Scene): void {
		const key = `${walkthrough.id}/${scene.id}`;
		if (this.asking?.key === key) {
			this.closeAsk(true);
			return;
		}
		// Hold the narration (after this sentence) while they type.
		const resume = !!this.player?.playing || (!!this.asking?.resume);
		this.player?.pauseAfterSegment();
		this.activeService.stopSpeaking();
		this.asking = { key, resume, draft: '' };
		this.renderDeeper();
	}

	private closeAsk(resumeIfHeld: boolean): void {
		const asking = this.asking;
		this.asking = undefined;
		if (resumeIfHeld && asking?.resume) {
			this.player?.play();
		}
		this.renderDeeper();
	}

	/** Reads a finished deeper explanation or answer aloud, once narration has stopped. */
	private maybeSpeakDeeper(): void {
		const player = this.player;
		if (!player || player.playing || !this.activeService.canSpeak) {
			return;
		}
		const scene = player.walkthrough.scenes[player.position.scene];
		const key = `${player.walkthrough.id}/${scene.id}`;
		const elaboration = this.activeService.elaboration(player.walkthrough.id, scene.id);
		if (!elaboration || elaboration.status !== 'done' || this.collapsedDeeper.has(key) || this.spokenDeeper.has(elaboration.requestId) || this.asking?.key === key) {
			return;
		}
		this.spokenDeeper.add(elaboration.requestId);
		void this.activeService.speak(elaboration.text).then(outcome => {
			if (outcome.kind === 'failed') {
				this.speechErrors.set(elaboration.requestId, outcome.error);
				this.renderDeeper();
				return;
			}
			const resume = this.resumeAfterDeeper.delete(elaboration.requestId);
			const current = this.player;
			const stillHere = current === player && current.walkthrough.scenes[current.position.scene]?.id === scene.id && !current.playing && current.state !== 'ended';
			if (outcome.kind === 'ended' && resume && stillHere && !this.collapsedDeeper.has(key) && this.asking === undefined) {
				this.collapsedDeeper.add(key);
				current.play();
				this.renderDeeper();
			}
		});
	}

	/** The deeper re-explanation or answer for the current scene, streamed in and then read aloud; and the question box. */
	private renderDeeper(): void {
		const player = this.player;
		const host = this.deeperHost;
		if (!player || !host) {
			return;
		}
		this.deeperStore.clear();
		dom.clearNode(host);
		const walkthrough = player.walkthrough;
		const scene = walkthrough.scenes[player.position.scene];
		const key = `${walkthrough.id}/${scene.id}`;
		const elaboration = this.activeService.elaboration(walkthrough.id, scene.id);
		const open = !!elaboration && !this.collapsedDeeper.has(key);
		const deeperOpen = open && !elaboration.question;
		const askOpen = this.asking?.key === key;
		if (this.moreDetailButton) {
			dom.clearNode(this.moreDetailButton);
			dom.append(this.moreDetailButton, $('span')).classList.add(...ThemeIcon.asClassNameArray(deeperOpen ? Codicon.chevronUp : Codicon.listTree));
			dom.append(this.moreDetailButton, $('span')).textContent = deeperOpen ? localize('lessDetail', "Less detail") : localize('moreDetail', "More detail");
			this.moreDetailButton.title = deeperOpen ? localize('lessDetailTitle', "Hide the deeper explanation") : localize('moreDetailTitle', "Explain this part in more depth (after the current sentence)");
		}
		if (this.askButton) {
			dom.clearNode(this.askButton);
			dom.append(this.askButton, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.question));
			dom.append(this.askButton, $('span')).textContent = open ? localize('askAnother', "Ask another question") : localize('askQuestion', "Ask a question");
			this.askButton.title = localize('askTitle', "Ask about this part; the answer appears here and is read aloud");
			this.askButton.classList.toggle('active', askOpen);
		}
		host.classList.toggle('hidden', !open && !askOpen);
		if (open && elaboration) {
			this.renderAnswer(host, walkthrough, scene, key, elaboration);
		}
		if (askOpen) {
			this.renderAskBox(host, walkthrough, scene);
		}
		this.layoutExplanationZone();
	}

	private renderAnswer(host: HTMLElement, walkthrough: Walkthrough, scene: Scene, key: string, elaboration: Elaboration): void {
		const player = this.player!;
		const head = dom.append(host, $('.deeper-head'));
		const icon = dom.append(head, $('span'));
		icon.classList.add(...ThemeIcon.asClassNameArray(elaboration.status === 'streaming' ? Codicon.loading : elaboration.status === 'error' ? Codicon.error : elaboration.question ? Codicon.commentDiscussion : Codicon.lightbulb));
		if (elaboration.status === 'streaming') {
			icon.classList.add('codicon-modifier-spin');
		}
		dom.append(head, $('span')).textContent = elaboration.status === 'streaming' && !elaboration.text
			? (elaboration.question ? localize('answerLoading', "Thinking about your question…") : localize('deeperLoading', "Working out a deeper explanation…"))
			: (elaboration.question ? localize('answerTitle', "Your question") : localize('deeperTitle', "In more depth"));
		if (elaboration.question) {
			dom.append(host, $('.deeper-question')).textContent = elaboration.question;
		}
		const body = dom.append(host, $('.deeper-body'));
		for (const paragraph of elaboration.text.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean)) {
			dom.append(body, $('p')).textContent = paragraph;
		}
		const speechError = this.speechErrors.get(elaboration.requestId);
		if (speechError) {
			dom.append(host, $('.deeper-note')).textContent = localize('speechFailed', "Couldn't read this aloud: {0}", speechError);
		}
		const actions = dom.append(host, $('.deeper-actions'));
		const button = (label: string, run: () => void, primary = false) => {
			const element = dom.append(actions, $(primary ? 'button.primary' : 'button.secondary')) as HTMLButtonElement;
			element.textContent = label;
			this.deeperStore.add(dom.addDisposableListener(element, dom.EventType.CLICK, () => run()));
		};
		if (elaboration.status === 'error') {
			button(localize('deeperRetry', "Try Again"), () => this.request(walkthrough, scene, elaboration.question, this.resumeAfterDeeper.has(elaboration.requestId)));
		} else if (elaboration.status === 'done') {
			if (this.activeService.speaking) {
				button(localize('deeperStop', "Stop Reading"), () => this.activeService.stopSpeaking());
			} else if (this.activeService.canSpeak) {
				button(localize('deeperListen', "Read Aloud"), () => {
					this.speechErrors.delete(elaboration.requestId);
					void this.activeService.speak(elaboration.text).then(outcome => {
						if (outcome.kind === 'failed') {
							this.speechErrors.set(elaboration.requestId, outcome.error);
							this.renderDeeper();
						}
					});
				});
			}
		}
		if (elaboration.status !== 'streaming') {
			button(localize('askAnotherButton', "Ask Another Question"), () => this.openAsk(walkthrough, scene));
		}
		button(localize('deeperContinue', "Continue Walkthrough"), () => {
			this.activeService.stopSpeaking();
			this.resumeAfterDeeper.delete(elaboration.requestId);
			this.collapsedDeeper.add(key);
			this.asking = undefined;
			player.play();
			this.renderDeeper();
		}, true);
	}

	private renderAskBox(host: HTMLElement, walkthrough: Walkthrough, scene: Scene): void {
		const box = dom.append(host, $('.ask-box'));
		const input = dom.append(box, $('input.ask-input')) as HTMLInputElement;
		input.type = 'text';
		input.placeholder = localize('askPlaceholder', "Ask about \"{0}\"…", scene.title);
		input.setAttribute('aria-label', localize('askLabel', "Question about this part of the walkthrough"));
		// The card re-renders while an earlier answer streams in: keep what they've typed.
		input.value = this.asking?.draft ?? '';
		this.deeperStore.add(dom.addDisposableListener(input, dom.EventType.INPUT, () => {
			if (this.asking) {
				this.asking.draft = input.value;
			}
		}));
		const submit = () => {
			const question = input.value.trim();
			if (!question) {
				return;
			}
			const resume = this.asking?.resume ?? false;
			this.asking = undefined;
			this.activeService.stopSpeaking();
			this.request(walkthrough, scene, question, resume);
			this.renderDeeper();
		};
		const askButton = dom.append(box, $('button.primary')) as HTMLButtonElement;
		askButton.textContent = localize('askSubmit', "Ask");
		const cancel = dom.append(box, $('button.secondary')) as HTMLButtonElement;
		cancel.textContent = localize('askCancel', "Cancel");
		// Typing here must not trigger the walkthrough's single-key shortcuts (Space, J/K/L, C, O).
		this.deeperStore.add(dom.addDisposableListener(input, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			event.stopPropagation();
			if (event.key === 'Enter' && !event.isComposing) {
				event.preventDefault();
				submit();
			} else if (event.key === 'Escape') {
				event.preventDefault();
				this.closeAsk(true);
			}
		}));
		this.deeperStore.add(dom.addDisposableListener(input, dom.EventType.MOUSE_DOWN, (event: MouseEvent) => event.stopPropagation()));
		this.deeperStore.add(dom.addDisposableListener(askButton, dom.EventType.CLICK, submit));
		this.deeperStore.add(dom.addDisposableListener(cancel, dom.EventType.CLICK, () => this.closeAsk(true)));
		dom.scheduleAtNextAnimationFrame(dom.getWindow(input), () => input.focus());
	}

	// ------------------------------------------------------------------ detail feedback

	/** Occasionally asks, at the end of a walkthrough, whether the level of detail suited them. */
	private maybeAskForFeedback(): void {
		const player = this.player;
		if (player && player.state !== 'ended' && this.feedback && !this.feedbackAnswered) {
			// They went back into the walkthrough: the question can wait.
			this.hideFeedback();
		}
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
		this.feedbackAnswered = false;
		const panel = dom.append(this.root, $('.detail-feedback'));
		this.feedback = panel;
		dom.append(panel, $('.feedback-question')).textContent = localize('feedbackQuestion', "How was the level of detail?");
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
				this.feedbackAnswered = true;
				await this.activeService.recordDetailFeedback(walkthrough, value);
				const topics = walkthrough.terms.map(term => term.name).slice(0, 2);
				dom.clearNode(panel);
				dom.append(panel, $('.feedback-thanks')).textContent = value === 'right'
					? localize('feedbackThanksRight', "Thanks. Active will keep this level.")
					: value === 'tooMuch'
						? (topics.length ? localize('feedbackThanksLessTopic', "Thanks. Future walkthroughs will be a bit lighter, especially on {0}.", topics.join(' and ')) : localize('feedbackThanksLess', "Thanks. Future walkthroughs will be a bit lighter."))
						: (topics.length ? localize('feedbackThanksMoreTopic', "Thanks. Future walkthroughs will go a bit deeper, especially on {0}.", topics.join(' and ')) : localize('feedbackThanksMore', "Thanks. Future walkthroughs will go a bit deeper."));
				setTimeout(() => this.hideFeedback(), 3500);
			}));
		}
		const dismiss = dom.append(panel, $('button.feedback-dismiss')) as HTMLButtonElement;
		dom.append(dismiss, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
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
		const scene = player.walkthrough.scenes[player.position.scene];
		const existing = narration.children;
		if (existing.length !== scene.narration.length) {
			dom.clearNode(narration);
			for (const segment of scene.narration) {
				dom.append(narration, $('span.segment')).textContent = `${segment.text} `;
			}
		}
		// Only classes change from segment to segment, so the text eases between states. With audio off there's
		// no voice to follow: the whole text reads evenly.
		const silent = player.silent;
		[...narration.children].forEach((span, index) => {
			span.classList.toggle('spoken', !silent && index < player.position.segment);
			span.classList.toggle('current', silent || index === player.position.segment);
			span.classList.toggle('upcoming', !silent && index > player.position.segment);
		});
	}

	private layoutExplanationZone(): void {
		const zone = this.explanationZone;
		if (!zone) {
			return;
		}
		const layoutInfo = this.codeEditor.getLayoutInfo();
		zone.card.style.width = `${Math.max(220, layoutInfo.contentWidth - 36)}px`;
		dom.scheduleAtNextAnimationFrame(dom.getWindow(this.root), () => {
			this.relayoutVisual?.();
			this.fitZoneToCard();
		});
	}

	/** Sizes the card's view zone to the card, so it never overlaps the code below or gets cut off. */
	private fitZoneToCard(): void {
		const zone = this.explanationZone;
		if (!zone) {
			return;
		}
		const height = zone.card.offsetHeight + 28;
		if (height > 28 && Math.abs((zone.zone.heightInPx ?? 0) - height) > 1) {
			zone.zone.heightInPx = height;
			this.codeEditor.changeViewZones(accessor => accessor.layoutZone(zone.id));
			dom.scheduleAtNextAnimationFrame(dom.getWindow(this.root), () => {
				this.relayoutVisual?.();
				// The card grew (highlighted code, a diagram): fit it on screen again.
				this.applyReveal();
			});
		}
	}

	/** What the view should show for the narrated focus; re-applied while the card settles into its size. */
	private reveal: { scene: Scene; focusIndex: number | undefined; until: number } | undefined;

	private revealFocus(scene: Scene, focusIndex: number | undefined): void {
		this.reveal = { scene, focusIndex, until: Date.now() + REVEAL_SETTLE_MS };
		dom.scheduleAtNextAnimationFrame(dom.getWindow(this.root), () => this.applyReveal());
	}

	/**
	 * Scrolls so the highlighted code and the whole card are on screen together. When they don't fit,
	 * the card wins (it holds the words being read), with as much of the code above it as fits.
	 */
	private applyReveal(): void {
		const reveal = this.reveal;
		if (!reveal || Date.now() > reveal.until) {
			return;
		}
		const editor: ICodeEditor = this.codeEditor;
		const lineHeight = editor.getOption(EditorOption.lineHeight);
		const viewport = editor.getLayoutInfo().height;
		const range = reveal.scene.focus[reveal.focusIndex ?? 0];
		const focusTop = editor.getTopForLineNumber(range ? range.startLine : Math.max(1, reveal.scene.anchorLine));
		let top = focusTop - 2 * lineHeight;
		const zone = this.explanationZone;
		if (zone && zone.zone.afterLineNumber > 0) {
			const cardTop = editor.getBottomForLineNumber(zone.zone.afterLineNumber);
			const cardBottom = cardTop + (zone.zone.heightInPx ?? 0);
			if (cardBottom > focusTop) {
				if (cardBottom - focusTop + lineHeight <= viewport) {
					top = focusTop - Math.min(2 * lineHeight, viewport - (cardBottom - focusTop));
				} else if (cardBottom - cardTop <= viewport - 3 * lineHeight) {
					top = cardBottom - viewport + lineHeight;
				} else {
					top = cardTop - 3 * lineHeight;
				}
			}
		}
		editor.setScrollTop(Math.max(0, top), ScrollType.Smooth);
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
		if (player?.silent) {
			// Audio off: the walkthrough is read, a whole scene at a time.
			const previous = button(localize('previousScene', "← Previous"), WalkthroughCommandIds.Rewind, localize('previousSceneTitle', "Back to the previous idea"), () => player.rewind());
			previous.disabled = player.position.scene === 0;
			const next = button(localize('nextScene', "Next →"), WalkthroughCommandIds.Advance, localize('nextSceneTitle', "On to the next idea"), () => player.advance(), '.primary');
			next.disabled = player.position.scene >= player.walkthrough.scenes.length - 1;
		} else {
			const rewind = button(localize('rewind', "← Rewind"), WalkthroughCommandIds.Rewind, localize('rewindTitle', "Back to the previous narration step"), () => player?.rewind());
			rewind.disabled = !player || (player.position.scene === 0 && player.position.segment === 0);
			const playLabel = !player ? localize('play', "▶ Play") : player.state === 'ended' ? localize('replay', "↺ Replay") : player.playing ? localize('pause', "⏸ Pause") : localize('resume', "▶ Resume");
			const primary = button(playLabel, WalkthroughCommandIds.TogglePlayback, localize('toggleTitle', "Pause or resume (the coding agent keeps working)"), () => player?.toggle(), '.primary');
			primary.disabled = !player;
			const next = button(localize('next', "Next →"), WalkthroughCommandIds.Advance, localize('nextTitle', "Skip to the next idea"), () => player?.advance());
			next.disabled = !player || player.state === 'ended';
		}
		const progress = dom.append(this.footer, $('.progress'));
		progress.textContent = walkthrough ? `${player!.position.scene + 1} / ${walkthrough.scenes.length}` : '';
		const status = dom.append(this.footer, $('.playback-status'));
		if (player?.silent) {
			// Nothing to report: no narration is wanted.
		} else if (player?.narrationIssue) {
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
		// Floating buttons sit just above the playback controls, however many rows they wrap to.
		if (this.isVisible()) {
			this.activeService.setControlsHeight(this.footer.offsetHeight);
		}
		if (this.dimension) {
			const chrome = this.header.offsetHeight + this.footer.offsetHeight;
			const height = Math.max(100, this.dimension.height - chrome);
			if (this.codeEditor.getLayoutInfo().height !== height) {
				this.codeEditor.layout({ width: this.dimension.width, height });
			}
		}
	}
}

