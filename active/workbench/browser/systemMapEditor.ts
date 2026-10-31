/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toAction } from '../../../../base/common/actions.js';
import { fromNow } from '../../../../base/common/date.js';
import { isMacintosh } from '../../../../base/common/platform.js';
import { DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ActiveSetting, type DiagramFolderMode, type MapSelection, type SystemComponent, type SystemConnection, type SystemFileRef, type SystemMapRevision } from '../common/activeProtocol.js';
import { SystemMapInput } from './activeInputs.js';
import { IActiveService } from './activeService.js';
import { connectionPath, layoutMap, MapPoint, mapBounds, NODE_HEIGHT, NODE_WIDTH } from './systemMapLayout.js';

const $ = dom.$;
const SVG_NS = 'http://www.w3.org/2000/svg';
const POSITIONS_KEY = 'active.systemMap.positions';
const MIN_SCALE = 0.2;
const MAX_SCALE = 2.5;
/** A press that moves less than this is a click, not a drag. */
const DRAG_THRESHOLD = 4;

type Selection = { readonly kind: 'component'; readonly id: string } | { readonly kind: 'connection'; readonly from: string; readonly to: string };

const selectionKey = (selection: Selection) => selection.kind === 'component' ? `c:${selection.id}` : `e:${selection.from}>${selection.to}`;

/**
 * The system map: components as boxes and their connections as arrows, on a canvas that the wheel zooms and a
 * drag pans. Boxes can be dragged (their places are remembered); clicking one opens its description with the
 * files it cites, which Explorer outlines. Older versions of the map can be looked at from History. ⌘-click
 * (Ctrl-click) or ⌘-drag picks several boxes and arrows; any pick can be asked about in chat.
 */
export class SystemMapEditor extends EditorPane {
	static readonly ID = 'workbench.editor.activeSystemMap';

	private root!: HTMLElement;
	private header!: HTMLElement;
	private viewport!: HTMLElement;
	private world!: HTMLElement;
	private edges!: SVGSVGElement;
	private overview!: HTMLElement;
	private popup!: HTMLElement;
	private selectionBar!: HTMLElement;
	private marquee!: HTMLElement;
	private state!: HTMLElement;
	private banner!: HTMLElement;
	private zoomLabel: HTMLElement | undefined;
	private readonly headerStore = this._register(new DisposableStore());
	private readonly bannerStore = this._register(new DisposableStore());
	private readonly stateStore = this._register(new DisposableStore());
	private readonly mapStore = this._register(new DisposableStore());
	private readonly popupStore = this._register(new DisposableStore());
	private readonly selectionBarStore = this._register(new DisposableStore());
	private readonly inputStore = this._register(new DisposableStore());

	/** The version on screen: the latest, unless an older one was picked from History. */
	private shown: SystemMapRevision | undefined;
	private viewingOld = false;
	private positions = new Map<string, MapPoint>();
	private readonly nodes = new Map<string, HTMLElement>();
	private readonly edgeElements: Array<{ connection: SystemConnection; path: SVGPathElement; hit: SVGPathElement; label: HTMLElement }> = [];
	/** What's picked: one box or arrow (shown in the popup), or several (⌘-click, ⌘-drag). */
	private picked: Selection[] = [];
	/** The popup is editing the picked box's or arrow's text. */
	private editing = false;
	private pan = { x: 40, y: 40 };
	private scale = 1;
	/** The view is fitted to the map the first time it has a size. */
	private fitted = false;
	/** The developer zoomed or panned since the last fit (a resize then keeps their view instead of refitting). */
	private viewMoved = false;
	private readonly frame = this._register(new MutableDisposable());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService private readonly storage: IStorageService,
		@IActiveService private readonly activeService: IActiveService,
		@IEditorService private readonly editorService: IEditorService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super(SystemMapEditor.ID, group, telemetryService, themeService, storage);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, $('.active-map'));
		this.root.tabIndex = 0;
		this.header = dom.append(this.root, $('.map-header'));
		this.banner = dom.append(this.root, $('.map-banner.hidden'));
		this.viewport = dom.append(this.root, $('.map-viewport'));
		this.world = dom.append(this.viewport, $('.map-world'));
		this.edges = this.world.ownerDocument.createElementNS(SVG_NS, 'svg');
		this.edges.classList.add('map-edges');
		// Arrowheads: one plain, one for highlighted connections.
		const defs = this.edges.appendChild(this.world.ownerDocument.createElementNS(SVG_NS, 'defs'));
		for (const id of ['active-map-arrow', 'active-map-arrow-hot']) {
			const marker = defs.appendChild(this.world.ownerDocument.createElementNS(SVG_NS, 'marker'));
			for (const [name, value] of [['id', id], ['viewBox', '0 0 10 10'], ['refX', '9'], ['refY', '5'], ['markerWidth', '7'], ['markerHeight', '7'], ['orient', 'auto-start-reverse']]) {
				marker.setAttribute(name, value);
			}
			marker.appendChild(this.world.ownerDocument.createElementNS(SVG_NS, 'path')).setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
		}
		this.world.appendChild(this.edges);
		this.overview = dom.append(this.viewport, $('.map-overview'));
		this.popup = dom.append(this.viewport, $('.map-popup.hidden'));
		this.selectionBar = dom.append(this.viewport, $('.map-selection-bar.hidden'));
		this.marquee = dom.append(this.viewport, $('.map-marquee.hidden'));
		this.state = dom.append(this.viewport, $('.map-state.hidden'));
		this.positions = this.loadPositions();

		this._register(this.activeService.onDidChangeDiagram(() => this.onDiagramChanged()));
		// The same map open side by side: a box dragged in one moves in the other.
		this._register(this.storage.onDidChangeValue(StorageScope.WORKSPACE, POSITIONS_KEY, this._store)(() => {
			const positions = this.loadPositions();
			if (JSON.stringify(Object.fromEntries(positions)) !== JSON.stringify(Object.fromEntries(this.positions))) {
				this.positions = positions;
				this.placeAll();
			}
		}));
		this.registerCanvasInput();
		this._register(dom.addStandardDisposableListener(this.root, dom.EventType.KEY_DOWN, event => {
			if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement || event.target instanceof HTMLTextAreaElement) {
				return;
			}
			if (event.browserEvent.key === 'Escape' && this.picked.length) {
				event.preventDefault();
				this.select(undefined);
			} else if (event.browserEvent.key === '0' || event.browserEvent.key === 'f') {
				this.fit(true);
			} else if (event.browserEvent.key === '+' || event.browserEvent.key === '=') {
				this.zoomBy(1.2);
			} else if (event.browserEvent.key === '-') {
				this.zoomBy(1 / 1.2);
			}
		}));
	}

	override async setInput(input: SystemMapInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputStore.clear();
		this.viewingOld = false;
		this.shown = this.activeService.diagram.current;
		this.renderAll();
	}

	override clearInput(): void {
		this.inputStore.clear();
		super.clearInput();
	}

	override focus(): void {
		this.root.focus();
	}

	override layout(dimension: dom.Dimension): void {
		const before = { width: this.viewport.clientWidth, height: this.viewport.clientHeight };
		this.root.style.width = `${dimension.width}px`;
		this.root.style.height = `${dimension.height}px`;
		// Side by side with other tabs: the header drops labels, then the status, to stay on one line.
		this.root.classList.toggle('narrow', dimension.width < 760);
		this.root.classList.toggle('very-narrow', dimension.width < 480);
		if (!this.fitted && this.nodes.size && this.viewport.clientWidth) {
			this.fit(false);
		} else if (this.nodes.size && before.width && (before.width !== this.viewport.clientWidth || before.height !== this.viewport.clientHeight)) {
			if (!this.viewMoved) {
				// Nobody has moved the view since it was fitted: fit it to the new size.
				this.fit(false);
			} else {
				// Keep what was in the middle in the middle.
				this.pan = { x: this.pan.x + (this.viewport.clientWidth - before.width) / 2, y: this.pan.y + (this.viewport.clientHeight - before.height) / 2 };
				this.applyView();
			}
		}
		this.placePopup();
	}

	private get input2(): SystemMapInput | undefined {
		return this.input instanceof SystemMapInput ? this.input : undefined;
	}

	private onDiagramChanged(): void {
		if (!this.viewingOld) {
			this.shown = this.activeService.diagram.current;
		}
		this.renderAll();
	}

	// ------------------------------------------------------------------ rendering

	private renderAll(): void {
		this.renderHeader();
		this.renderBanner();
		this.renderState();
		this.renderMap();
	}

	private renderHeader(): void {
		this.headerStore.clear();
		dom.clearNode(this.header);
		const diagram = this.activeService.diagram;
		const title = dom.append(this.header, $('.map-title'));
		dom.append(title, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.typeHierarchy));
		dom.append(title, $('span.name')).textContent = localize('systemMapTitle', "System Map");
		const current = diagram.current;
		if (current || diagram.folderMode) {
			this.renderUpdateMode();
		}
		const status = dom.append(this.header, $('.map-status'));
		if (diagram.status === 'building') {
			status.textContent = localize('mapBuilding', "Building the map…");
			status.classList.add('busy');
		} else if (diagram.status === 'updating') {
			status.textContent = diagram.detail ?? localize('mapUpdating', "Checking for changes…");
			status.classList.add('busy');
		} else if (diagram.status === 'failed') {
			status.textContent = diagram.detail ?? localize('mapFailed', "The last update failed");
			status.classList.add('warning');
		} else if (current) {
			status.textContent = current.turnIndex !== undefined
				? localize('mapUpdatedTurn', "Version {0} · turn {1} · {2}", current.version, current.turnIndex, fromNow(current.at, true))
				: localize('mapUpdatedAt', "Version {0} · {1}", current.version, fromNow(current.at, true));
		}
		const spacer = dom.append(this.header, $('.spacer'));
		void spacer;
		const button = (icon: ThemeIcon, label: string, title: string, run: () => void, disabled = false) => {
			const element = dom.append(this.header, $('button.map-action')) as HTMLButtonElement;
			dom.append(element, $('span')).classList.add(...ThemeIcon.asClassNameArray(icon));
			if (label) {
				dom.append(element, $('span.label')).textContent = label;
			}
			element.title = title;
			element.disabled = disabled;
			this.headerStore.add(dom.addDisposableListener(element, dom.EventType.CLICK, () => run()));
			return element;
		};
		if (diagram.history.length) {
			const history = dom.append(this.header, $('select.map-history')) as HTMLSelectElement;
			history.title = localize('mapHistoryTitle', "Earlier versions of the map");
			for (const revision of diagram.history) {
				const option = dom.append(history, $('option')) as HTMLOptionElement;
				option.value = String(revision.version);
				const when = revision.turnIndex !== undefined ? localize('mapHistoryTurn', "turn {0}", revision.turnIndex) : fromNow(revision.at, true);
				option.textContent = localize('mapHistoryItem', "v{0} · {1} · {2}", revision.version, when, revision.reason);
				option.selected = revision.version === (this.shown?.version ?? current?.version);
			}
			this.headerStore.add(dom.addDisposableListener(history, dom.EventType.CHANGE, () => void this.showVersion(Number(history.value))));
		}
		button(Codicon.zoomOut, '', localize('mapZoomOut', "Zoom Out (-)"), () => this.zoomBy(1 / 1.2));
		this.zoomLabel = dom.append(this.header, $('span.map-zoom'));
		this.updateZoomLabel();
		button(Codicon.zoomIn, '', localize('mapZoomIn', "Zoom In (+)"), () => this.zoomBy(1.2));
		button(Codicon.screenFull, localize('mapFit', "Fit"), localize('mapFitTitle', "Show the whole map (0)"), () => this.fit(true), !this.nodes.size);
		const busy = diagram.status === 'building' || diagram.status === 'updating';
		if (current) {
			button(Codicon.refresh, localize('mapCheck', "Check Now"), localize('mapCheckTitle', "Ask the diagram agent to look for changes now"), () => void this.activeService.updateDiagram(), busy || !this.activeService.diagramsEnabled);
			// Bigger changes are described in chat, where the diagram agent replies with what it did. (Names and
			// descriptions are edited in place, from a box's popup.)
			button(Codicon.editSparkle, localize('mapRestructure', "Restructure"), localize('mapRestructureTitle', "Describe bigger changes in chat (split or merge parts, regroup them, change the level of detail) and the diagram agent makes them. To rename a part or change its description, click it and use the pencil."), () => void this.activeService.editMapInChat(), !this.activeService.diagramsEnabled);
		}
	}

	/**
	 * Whether the map keeps itself up to date, always on screen next to the title: Auto-updating (with a live
	 * dot), Manual, or Off. Clicking it changes the mode for this folder.
	 */
	private renderUpdateMode(): void {
		const diagram = this.activeService.diagram;
		const enabled = this.activeService.diagramsEnabled;
		const mode: DiagramFolderMode = !enabled ? 'off' : diagram.folderMode ?? 'off';
		const minutes = Math.max(1, this.configurationService.getValue<number>(ActiveSetting.DiagramCheckMinutes) ?? 2);
		const looks: Record<DiagramFolderMode, { label: string; title: string }> = {
			auto: {
				label: localize('mapModeAuto', "Auto-updating"),
				title: localize('mapModeAutoTitle', "The diagram agent keeps this map up to date: it checks while the coding agent works (at most every {0} minutes) and when each task ends. Click to change.", minutes),
			},
			manual: {
				label: localize('mapModeManual', "Manual updates"),
				title: localize('mapModeManualTitle', "The map only changes when you click Check Now. Click to change."),
			},
			off: {
				label: enabled ? localize('mapModeOff', "Updates off") : localize('mapModeDisabled', "Diagrams off"),
				title: enabled ? localize('mapModeOffTitle', "The map isn't being updated. Click to change.") : localize('mapModeDisabledTitle', "System diagrams are turned off in Active's settings, so the map isn't being updated. Click to turn them on."),
			},
		};
		const busy = diagram.status === 'building' || diagram.status === 'updating';
		const button = dom.append(this.header, $('button.map-mode')) as HTMLButtonElement;
		button.classList.add(mode);
		button.classList.toggle('busy', mode === 'auto' && busy);
		dom.append(button, $('span.map-mode-dot'));
		dom.append(button, $('span.label')).textContent = looks[mode].label;
		dom.append(button, $('span.chevron')).classList.add(...ThemeIcon.asClassNameArray(Codicon.chevronDown));
		button.title = looks[mode].title;
		this.headerStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => {
			if (!enabled) {
				void this.activeService.setFeatures('both');
				return;
			}
			const choices: Array<{ id: DiagramFolderMode; label: string }> = [
				{ id: 'auto', label: localize('mapModeChoiceAuto', "Keep Updated Automatically") },
				{ id: 'manual', label: localize('mapModeChoiceManual', "Update Only When I Click Check Now") },
				{ id: 'off', label: localize('mapModeChoiceOff', "Stop Updating") },
			];
			this.contextMenuService.showContextMenu({
				getAnchor: () => button,
				getActions: () => choices.map(choice => toAction({
					id: `active.mapMode.${choice.id}`,
					label: choice.label,
					checked: choice.id === mode,
					run: () => this.activeService.setDiagramFolderMode(choice.id),
				})),
			});
		}));
	}

	private renderBanner(): void {
		this.bannerStore.clear();
		dom.clearNode(this.banner);
		const latest = this.activeService.diagram.current;
		const old = this.viewingOld && this.shown && latest && this.shown.version !== latest.version;
		this.banner.classList.toggle('hidden', !old);
		if (!old) {
			return;
		}
		dom.append(this.banner, $('span')).textContent = localize('mapOldVersion', "Version {0} of {1}: {2}", this.shown!.version, latest.version, this.shown!.reason);
		const back = dom.append(this.banner, $('button.link')) as HTMLButtonElement;
		back.textContent = localize('mapBackToLatest', "Back to Latest");
		this.bannerStore.add(dom.addDisposableListener(back, dom.EventType.CLICK, () => {
			this.viewingOld = false;
			this.shown = this.activeService.diagram.current;
			this.renderAll();
		}));
	}

	/** Shown over the canvas when there's no map to draw: turned off, not built yet, building, failed. */
	private renderState(): void {
		this.stateStore.clear();
		dom.clearNode(this.state);
		const diagram = this.activeService.diagram;
		const hasMap = !!this.shown;
		let title: string | undefined;
		let detail: string | undefined;
		let actions: Array<{ label: string; run: () => void; primary?: boolean }> = [];
		const folderChoices = () => [
			{ label: localize('mapChoiceAuto', "Generate and Keep Updated"), run: () => void this.activeService.setDiagramFolderMode('auto'), primary: true },
			{ label: localize('mapChoiceOnce', "Just Generate"), run: () => void this.activeService.setDiagramFolderMode('manual') },
		];
		if (!this.activeService.diagramsEnabled && !hasMap) {
			title = localize('mapOffTitle', "System diagrams are turned off");
			detail = localize('mapOffDetail', "Turn them on to have a diagram agent keep a map of the project's parts and how they connect.");
			actions = [{ label: localize('mapTurnOn', "Turn On System Diagrams"), run: () => void this.activeService.setFeatures('both'), primary: true }];
		} else if (!hasMap && diagram.status !== 'building' && diagram.folderMode !== 'auto' && diagram.folderMode !== 'manual') {
			title = diagram.folderMode === 'off' ? localize('mapFolderOffTitle', "No map for this folder") : localize('mapAskTitle', "Map this folder?");
			detail = localize('mapAskDetail', "A diagram agent reads the project and draws its parts and how they connect. It can keep the map up to date as the coding agent works, or build it once and update only when you ask.");
			actions = folderChoices();
		} else if (diagram.status === 'building') {
			title = localize('mapBuildingTitle', "Building the map");
			detail = localize('mapBuildingDetail', "The diagram agent is reading the project to find its parts and how they connect. This takes a minute or two.");
		} else if (!hasMap && diagram.status === 'failed') {
			title = localize('mapFailedTitle', "The map couldn't be built");
			detail = diagram.detail;
			actions = [{ label: localize('mapTryAgain', "Try Again"), run: () => void this.activeService.buildDiagram(), primary: true }];
		} else if (!hasMap) {
			title = localize('mapEmptyTitle', "No map yet");
			detail = localize('mapEmptyDetail', "The diagram agent reads the project and draws its parts and how they connect.");
			actions = [{ label: localize('mapBuild', "Build the Map"), run: () => void this.activeService.buildDiagram(), primary: true }];
		}
		this.state.classList.toggle('hidden', !title);
		if (!title) {
			return;
		}
		if (diagram.status === 'building') {
			dom.append(this.state, $('span.map-spinner')).classList.add(...ThemeIcon.asClassNameArray(Codicon.loading), 'codicon-modifier-spin');
		}
		dom.append(this.state, $('h2')).textContent = title;
		if (detail) {
			dom.append(this.state, $('p')).textContent = detail;
		}
		if (actions.length) {
			const row = dom.append(this.state, $('.map-state-actions'));
			for (const action of actions) {
				const button = dom.append(row, $(action.primary ? 'button.primary' : 'button.secondary')) as HTMLButtonElement;
				button.textContent = action.label;
				const run = action.run;
				this.stateStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => run()));
			}
		}
	}

	private renderMap(): void {
		this.mapStore.clear();
		for (const node of this.nodes.values()) {
			node.remove();
		}
		this.nodes.clear();
		for (const edge of this.edgeElements) {
			edge.path.remove();
			edge.hit.remove();
			edge.label.remove();
		}
		this.edgeElements.length = 0;
		const revision = this.shown;
		this.overview.textContent = revision?.map.overview ?? '';
		this.overview.classList.toggle('hidden', !revision?.map.overview);
		if (!revision) {
			this.select(undefined);
			return;
		}
		const map = revision.map;
		const placed = layoutMap(map.components.map(component => component.id), map.connections, this.positions);
		for (const [id, point] of placed) {
			this.positions.set(id, point);
		}
		if (!this.viewingOld) {
			// Remembered, so new versions (and reloads) keep every box where it was.
			this.savePositions();
		}
		const diagram = this.activeService.diagram;
		const touched = new Set(this.viewingOld ? [] : diagram.touched);
		const changed = new Set(revision.changed);
		for (const component of map.components) {
			const node = dom.append(this.world, $('.map-node'));
			node.dataset.id = component.id;
			dom.append(node, $('.name')).textContent = component.name;
			dom.append(node, $('.summary')).textContent = component.summary;
			const badges = dom.append(node, $('.badges'));
			if (changed.has(component.id) && revision.version > 1) {
				dom.append(badges, $('span.badge.changed')).textContent = localize('mapBadgeChanged', "updated in v{0}", revision.version);
			}
			if (touched.has(component.id)) {
				node.classList.add('touched');
				const badge = dom.append(badges, $('span.badge.touched'));
				badge.textContent = diagram.touchedTurnIndex !== undefined ? localize('mapBadgeTouched', "edited in turn {0}", diagram.touchedTurnIndex) : localize('mapBadgeTouchedRecently', "edited recently");
			}
			node.title = component.summary;
			this.nodes.set(component.id, node);
		}
		for (const connection of map.connections) {
			const hit = this.world.ownerDocument.createElementNS(SVG_NS, 'path');
			hit.classList.add('map-edge-hit');
			const path = this.world.ownerDocument.createElementNS(SVG_NS, 'path');
			path.classList.add('map-edge');
			path.setAttribute('marker-end', 'url(#active-map-arrow)');
			this.edges.appendChild(path);
			this.edges.appendChild(hit);
			const label = dom.append(this.world, $('.map-edge-label'));
			label.textContent = connection.label;
			label.classList.toggle('hidden', !connection.label);
			this.edgeElements.push({ connection, path, hit, label });
		}
		this.placeAll();
		// Keep whatever is picked that still exists in this version.
		this.setPicked(this.picked.filter(selection => selection.kind === 'component' ? this.nodes.has(selection.id) : map.connections.some(connection => connection.from === selection.from && connection.to === selection.to)));
		if (!this.fitted && this.viewport.clientWidth) {
			this.fit(false);
		}
		this.renderHeader();
	}

	/** Puts every box and arrow where it belongs (after a drag, or a new version). */
	private placeAll(): void {
		for (const [id, node] of this.nodes) {
			const point = this.positions.get(id);
			if (point) {
				node.style.transform = `translate(${point.x}px, ${point.y}px)`;
			}
		}
		for (const edge of this.edgeElements) {
			const from = this.positions.get(edge.connection.from);
			const to = this.positions.get(edge.connection.to);
			if (!from || !to) {
				continue;
			}
			const { path, middle } = connectionPath(from, to);
			edge.path.setAttribute('d', path);
			edge.hit.setAttribute('d', path);
			edge.label.style.transform = `translate(${middle.x}px, ${middle.y}px) translate(-50%, -50%)`;
		}
		this.applyView();
	}

	private applyView(): void {
		this.world.style.transform = `translate(${this.pan.x}px, ${this.pan.y}px) scale(${this.scale})`;
		this.updateZoomLabel();
		this.placePopup();
	}

	/** One picked box or arrow: the popup describes it. Several: the selection bar offers to ask about them. */
	private get selection(): Selection | undefined {
		return this.picked.length === 1 ? this.picked[0] : undefined;
	}

	private updateZoomLabel(): void {
		if (this.zoomLabel) {
			this.zoomLabel.textContent = `${Math.round(this.scale * 100)}%`;
		}
	}

	// ------------------------------------------------------------------ pan, zoom, drag

	private registerCanvasInput(): void {
		// The wheel zooms around the pointer (a pinch on a trackpad arrives as a wheel with ctrlKey too).
		this._register(dom.addDisposableListener(this.viewport, dom.EventType.MOUSE_WHEEL, (event: WheelEvent) => {
			if (this.popup.contains(event.target as Node)) {
				return; // the popup scrolls its own text
			}
			event.preventDefault();
			const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
			const factor = Math.exp(-delta * (event.ctrlKey ? 0.01 : 0.0015));
			const rect = this.viewport.getBoundingClientRect();
			this.zoomAt(factor, event.clientX - rect.left, event.clientY - rect.top);
		}, { passive: false }));

		this._register(dom.addDisposableListener(this.viewport, dom.EventType.POINTER_DOWN, (event: PointerEvent) => {
			if (event.button !== 0 || this.popup.contains(event.target as Node) || this.state.contains(event.target as Node)) {
				return;
			}
			if (this.selectionBar.contains(event.target as Node)) {
				return;
			}
			const target = event.target as Element;
			const node = target.closest<HTMLElement>('.map-node');
			const edge = this.edgeElements.find(candidate => candidate.hit === target || candidate.label === target);
			if (isMacintosh ? event.metaKey : event.ctrlKey) {
				this.pickWithModifier(event, node ? { kind: 'component', id: node.dataset.id! } : edge ? { kind: 'connection', from: edge.connection.from, to: edge.connection.to } : undefined);
				return;
			}
			const start = { x: event.clientX, y: event.clientY };
			const origin = node ? this.positions.get(node.dataset.id!) : { ...this.pan };
			let dragging = false;
			this.viewport.setPointerCapture(event.pointerId);
			this.root.focus();
			const move = dom.addDisposableListener(this.viewport, dom.EventType.POINTER_MOVE, (moveEvent: PointerEvent) => {
				const dx = moveEvent.clientX - start.x;
				const dy = moveEvent.clientY - start.y;
				if (!dragging && Math.hypot(dx, dy) < DRAG_THRESHOLD) {
					return;
				}
				dragging = true;
				if (node && origin) {
					// Dragging a box moves it (in map units, so it tracks the pointer at any zoom).
					node.classList.add('dragging');
					this.positions.set(node.dataset.id!, { x: origin.x + dx / this.scale, y: origin.y + dy / this.scale });
					this.placeAll();
				} else if (origin) {
					this.viewport.classList.add('panning');
					this.viewMoved = true;
					this.pan = { x: origin.x + dx, y: origin.y + dy };
					this.applyView();
				}
			});
			const end = () => {
				move.dispose();
				up.dispose();
				cancel.dispose();
				this.viewport.classList.remove('panning');
				node?.classList.remove('dragging');
				if (dragging) {
					if (node) {
						this.savePositions();
					}
					return;
				}
				// A click: on a box or an arrow selects it; on empty space clears the selection.
				if (node) {
					this.select({ kind: 'component', id: node.dataset.id! });
				} else if (edge) {
					this.select({ kind: 'connection', from: edge.connection.from, to: edge.connection.to });
				} else {
					this.select(undefined);
				}
			};
			const up = dom.addDisposableListener(this.viewport, dom.EventType.POINTER_UP, end);
			const cancel = dom.addDisposableListener(this.viewport, 'pointercancel', end);
		}));
		this._register(dom.addDisposableListener(this.viewport, dom.EventType.DBLCLICK, event => {
			if (!(event.target as Element).closest('.map-node, .map-popup, .map-state')) {
				this.fit(true);
			}
		}));
	}

	/**
	 * ⌘ held: a click adds the box or arrow under the pointer to what's picked (or takes it out); a drag draws a
	 * rectangle and adds every box and arrow it touches.
	 */
	private pickWithModifier(event: PointerEvent, under: Selection | undefined): void {
		const base = [...this.picked];
		const rect = this.viewport.getBoundingClientRect();
		const start = { x: event.clientX - rect.left, y: event.clientY - rect.top };
		let dragging = false;
		this.viewport.setPointerCapture(event.pointerId);
		this.root.focus();
		const move = dom.addDisposableListener(this.viewport, dom.EventType.POINTER_MOVE, (moveEvent: PointerEvent) => {
			const point = { x: moveEvent.clientX - rect.left, y: moveEvent.clientY - rect.top };
			if (!dragging && Math.hypot(point.x - start.x, point.y - start.y) < DRAG_THRESHOLD) {
				return;
			}
			dragging = true;
			const box = { left: Math.min(start.x, point.x), top: Math.min(start.y, point.y), right: Math.max(start.x, point.x), bottom: Math.max(start.y, point.y) };
			this.marquee.classList.remove('hidden');
			this.marquee.style.transform = `translate(${box.left}px, ${box.top}px)`;
			this.marquee.style.width = `${box.right - box.left}px`;
			this.marquee.style.height = `${box.bottom - box.top}px`;
			const known = new Set(base.map(selectionKey));
			this.setPicked([...base, ...this.itemsIn(box).filter(item => !known.has(selectionKey(item)))]);
		});
		const end = () => {
			move.dispose();
			up.dispose();
			cancel.dispose();
			this.marquee.classList.add('hidden');
			if (!dragging && under) {
				const key = selectionKey(under);
				this.setPicked(base.some(item => selectionKey(item) === key) ? base.filter(item => selectionKey(item) !== key) : [...base, under]);
			}
		};
		const up = dom.addDisposableListener(this.viewport, dom.EventType.POINTER_UP, end);
		const cancel = dom.addDisposableListener(this.viewport, 'pointercancel', end);
	}

	/** The boxes and arrows touching a rectangle given in viewport pixels. */
	private itemsIn(box: { left: number; top: number; right: number; bottom: number }): Selection[] {
		const toMap = (x: number, y: number) => ({ x: (x - this.pan.x) / this.scale, y: (y - this.pan.y) / this.scale });
		const a = toMap(box.left, box.top);
		const b = toMap(box.right, box.bottom);
		const inside = (point: { x: number; y: number }) => point.x >= a.x && point.x <= b.x && point.y >= a.y && point.y <= b.y;
		const items: Selection[] = [];
		for (const id of this.nodes.keys()) {
			const point = this.positions.get(id);
			if (point && point.x < b.x && point.x + NODE_WIDTH > a.x && point.y < b.y && point.y + NODE_HEIGHT > a.y) {
				items.push({ kind: 'component', id });
			}
		}
		for (const edge of this.edgeElements) {
			// An arrow counts when any part of its curve is inside.
			const length = edge.path.getTotalLength?.() ?? 0;
			let hit = false;
			for (let step = 0; step <= 12 && length && !hit; step++) {
				const point = edge.path.getPointAtLength(length * step / 12);
				hit = inside(point);
			}
			if (hit) {
				items.push({ kind: 'connection', from: edge.connection.from, to: edge.connection.to });
			}
		}
		return items;
	}

	private zoomBy(factor: number): void {
		this.zoomAt(factor, this.viewport.clientWidth / 2, this.viewport.clientHeight / 2);
	}

	/** Zooms keeping the map point under (x, y) (viewport pixels) where it is. */
	private zoomAt(factor: number, x: number, y: number): void {
		this.viewMoved = true;
		const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, this.scale * factor));
		const ratio = scale / this.scale;
		this.pan = { x: x - (x - this.pan.x) * ratio, y: y - (y - this.pan.y) * ratio };
		this.scale = scale;
		this.applyView();
	}

	/** Scales and centres the view on the whole map; `animate` eases into it. */
	private fit(animate: boolean): void {
		const bounds = mapBounds([...this.nodes.keys()].map(id => this.positions.get(id)!).filter(Boolean));
		const width = this.viewport.clientWidth;
		const height = this.viewport.clientHeight;
		if (!bounds.width || !width || !height) {
			return;
		}
		this.fitted = true;
		this.viewMoved = false;
		const margin = 48;
		const scale = Math.min(1.2, Math.max(MIN_SCALE, Math.min((width - margin * 2) / bounds.width, (height - margin * 2) / bounds.height)));
		this.scale = scale;
		this.pan = { x: (width - bounds.width * scale) / 2 - bounds.x * scale, y: (height - bounds.height * scale) / 2 - bounds.y * scale };
		this.world.classList.toggle('easing', animate);
		this.applyView();
		if (animate) {
			const timer = setTimeout(() => this.world.classList.remove('easing'), 320);
			this.frame.value = toDisposable(() => clearTimeout(timer));
		}
	}

	// ------------------------------------------------------------------ selection and the popup

	private select(selection: Selection | undefined): void {
		this.setPicked(selection ? [selection] : []);
	}

	private setPicked(picked: Selection[]): void {
		if (picked.map(selectionKey).join() !== this.picked.map(selectionKey).join()) {
			this.editing = false;
		}
		this.picked = picked;
		const selection = this.selection;
		const revision = this.shown;
		const pickedKeys = new Set(picked.map(selectionKey));
		// One box: it and its neighbours stay lit. Several things: what's picked, and the ends of picked arrows.
		const related = new Set<string>();
		for (const item of picked) {
			if (item.kind === 'component') {
				related.add(item.id);
				if (selection) {
					for (const connection of revision?.map.connections ?? []) {
						if (connection.from === item.id || connection.to === item.id) {
							related.add(connection.from);
							related.add(connection.to);
						}
					}
				}
			} else {
				related.add(item.from);
				related.add(item.to);
			}
		}
		const any = picked.length > 0;
		for (const [id, node] of this.nodes) {
			node.classList.toggle('selected', pickedKeys.has(`c:${id}`));
			node.classList.toggle('dim', any && !related.has(id));
		}
		for (const edge of this.edgeElements) {
			const { from, to } = edge.connection;
			const hot = pickedKeys.has(`e:${from}>${to}`) || (selection?.kind === 'component' && (from === selection.id || to === selection.id));
			edge.path.classList.toggle('hot', hot);
			edge.path.classList.toggle('dim', any && !hot);
			edge.label.classList.toggle('hot', hot);
			edge.label.classList.toggle('dim', any && !hot);
			edge.path.setAttribute('marker-end', hot ? 'url(#active-map-arrow-hot)' : 'url(#active-map-arrow)');
		}
		this.renderPopup();
		this.renderSelectionBar();
		// Explorer outlines the files everything picked cites.
		this.input2?.select(this.selectedFiles());
	}

	/** Several things picked: how many, and Ask About These. */
	private renderSelectionBar(): void {
		this.selectionBarStore.clear();
		dom.clearNode(this.selectionBar);
		const show = this.picked.length > 1;
		this.selectionBar.classList.toggle('hidden', !show);
		if (!show) {
			return;
		}
		const components = this.picked.filter(item => item.kind === 'component').length;
		const connections = this.picked.length - components;
		const parts = [
			components === 1 ? localize('mapPickedComponent', "1 component") : components ? localize('mapPickedComponents', "{0} components", components) : '',
			connections === 1 ? localize('mapPickedConnection', "1 connection") : connections ? localize('mapPickedConnections', "{0} connections", connections) : '',
		].filter(Boolean);
		dom.append(this.selectionBar, $('span.count')).textContent = parts.join(localize('mapPickedAnd', " and "));
		const ask = dom.append(this.selectionBar, $('button.primary')) as HTMLButtonElement;
		dom.append(ask, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.commentDiscussion));
		dom.append(ask, $('span')).textContent = localize('mapAskThese', "Ask About These");
		this.selectionBarStore.add(dom.addDisposableListener(ask, dom.EventType.CLICK, () => void this.askAboutPicked()));
		const clear = dom.append(this.selectionBar, $('button.secondary')) as HTMLButtonElement;
		clear.textContent = localize('mapClearPicked', "Clear");
		clear.title = localize('mapClearPickedTitle', "Clear the selection (Escape)");
		this.selectionBarStore.add(dom.addDisposableListener(clear, dom.EventType.CLICK, () => this.select(undefined)));
	}

	/** Opens chat set to ask about what's picked, named the way the developer sees it on the map. */
	private async askAboutPicked(): Promise<void> {
		const map = this.shown?.map;
		if (!map || !this.picked.length) {
			return;
		}
		const name = (id: string) => map.components.find(component => component.id === id)?.name ?? id;
		// Boxes first, then arrows, however they were picked.
		const ordered = [...this.picked.filter(item => item.kind === 'component'), ...this.picked.filter(item => item.kind === 'connection')];
		const names = ordered.map(item => item.kind === 'component' ? name(item.id) : localize('mapConnectionName', "{0} → {1}", name(item.from), name(item.to)));
		const title = names.length <= 3
			? (names.length === 1 ? names[0] : localize('mapNamesList', "{0} and {1}", names.slice(0, -1).join(', '), names[names.length - 1]))
			: localize('mapNamesMore', "{0} and {1} more", names.slice(0, 2).join(', '), names.length - 2);
		const selection: MapSelection = {
			components: this.picked.flatMap(item => item.kind === 'component' ? [item.id] : []),
			connections: this.picked.flatMap(item => item.kind === 'connection' ? [{ from: item.from, to: item.to }] : []),
			version: this.viewingOld ? this.shown?.version : undefined,
		};
		await this.activeService.askAboutMap(selection, title);
	}

	private selectedComponent(): SystemComponent | undefined {
		const selection = this.selection;
		return selection?.kind === 'component' ? this.shown?.map.components.find(component => component.id === selection.id) : undefined;
	}

	private selectedConnection(): SystemConnection | undefined {
		const selection = this.selection;
		return selection?.kind === 'connection' ? this.shown?.map.connections.find(connection => connection.from === selection.from && connection.to === selection.to) : undefined;
	}

	private selectedFiles(): string[] {
		const map = this.shown?.map;
		const refs = this.picked.flatMap(item => item.kind === 'component'
			? map?.components.find(component => component.id === item.id)?.files ?? []
			: map?.connections.find(connection => connection.from === item.from && connection.to === item.to)?.evidence ?? []);
		return [...new Set(refs.map(ref => ref.path))];
	}

	private renderPopup(): void {
		this.popupStore.clear();
		dom.clearNode(this.popup);
		const component = this.selectedComponent();
		const connection = this.selectedConnection();
		const map = this.shown?.map;
		this.popup.classList.toggle('hidden', !component && !connection);
		if (!map || (!component && !connection)) {
			return;
		}
		const name = (id: string) => map.components.find(candidate => candidate.id === id)?.name ?? id;
		const head = dom.append(this.popup, $('.popup-head'));
		const close = dom.append(head, $('button.popup-close')) as HTMLButtonElement;
		close.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
		close.title = localize('mapPopupClose', "Close (Escape)");
		this.popupStore.add(dom.addDisposableListener(close, dom.EventType.CLICK, () => this.select(undefined)));
		// Names and descriptions are the developer's to edit in place, on the latest version.
		if (!this.viewingOld) {
			const pencil = dom.append(head, $('button.popup-close.popup-edit')) as HTMLButtonElement;
			pencil.classList.add(...ThemeIcon.asClassNameArray(Codicon.edit));
			pencil.classList.toggle('active', this.editing);
			pencil.title = component ? localize('mapEditComponent', "Edit the name and description") : localize('mapEditConnection', "Edit the label and detail");
			this.popupStore.add(dom.addDisposableListener(pencil, dom.EventType.CLICK, () => {
				this.editing = !this.editing;
				this.renderPopup();
			}));
		}
		const body = dom.append(this.popup, $('.popup-body'));
		if (this.editing) {
			dom.append(head, $('h3')).textContent = component ? localize('mapEditingComponent', "Edit {0}", component.name) : localize('mapEditingConnection', "Edit {0} → {1}", name(connection!.from), name(connection!.to));
			this.renderEditForm(body, component, connection);
			this.placePopup();
			return;
		}
		if (component) {
			dom.append(head, $('h3')).textContent = component.name;
			if (component.summary) {
				dom.append(body, $('p.popup-summary')).textContent = component.summary;
			}
			for (const paragraph of component.description.split(/\n\s*\n/).map(part => part.trim()).filter(Boolean)) {
				dom.append(body, $('p')).textContent = paragraph;
			}
			this.renderFiles(body, localize('mapPopupFiles', "Code"), component.files);
			const links = map.connections.filter(candidate => candidate.from === component.id || candidate.to === component.id);
			if (links.length) {
				dom.append(body, $('.popup-section')).textContent = localize('mapPopupConnections', "Connections");
				const list = dom.append(body, $('ul.popup-links'));
				for (const link of links) {
					const item = dom.append(list, $('li'));
					const button = dom.append(item, $('button.link')) as HTMLButtonElement;
					const outgoing = link.from === component.id;
					button.textContent = outgoing
						? localize('mapLinkOut', "→ {0}", name(link.to))
						: localize('mapLinkIn', "← {0}", name(link.from));
					if (link.label) {
						dom.append(item, $('span.popup-link-label')).textContent = link.label;
					}
					this.popupStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.select({ kind: 'component', id: outgoing ? link.to : link.from })));
				}
			}
		} else if (connection) {
			dom.append(head, $('h3')).textContent = localize('mapConnectionTitle', "{0} → {1}", name(connection.from), name(connection.to));
			if (connection.label) {
				dom.append(body, $('p.popup-summary')).textContent = connection.label;
			}
			if (connection.detail) {
				dom.append(body, $('p')).textContent = connection.detail;
			}
			this.renderFiles(body, localize('mapPopupWhere', "Where in the code"), connection.evidence);
		}
		const actions = dom.append(this.popup, $('.popup-actions'));
		const ask = dom.append(actions, $('button.primary')) as HTMLButtonElement;
		dom.append(ask, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.commentDiscussion));
		dom.append(ask, $('span')).textContent = localize('mapAskThis', "Ask About This");
		ask.title = localize('mapAskThisTitle', "Ask about this in chat");
		this.popupStore.add(dom.addDisposableListener(ask, dom.EventType.CLICK, () => void this.askAboutPicked()));
		dom.append(actions, $('span.popup-hint')).textContent = isMacintosh
			? localize('mapMultiHintMac', "⌘-click or ⌘-drag to pick more")
			: localize('mapMultiHint', "Ctrl-click or Ctrl-drag to pick more");
		this.placePopup();
	}

	/**
	 * The popup's edit form: a box's name, summary and description, or an arrow's label and detail. Saving makes
	 * a new version straight away (the diagram agent isn't asked) that later updates keep.
	 */
	private renderEditForm(body: HTMLElement, component: SystemComponent | undefined, connection: SystemConnection | undefined): void {
		const form = dom.append(body, $('.popup-form'));
		const field = (label: string, value: string, multiline: boolean, max: number) => {
			const wrap = dom.append(form, $('label.popup-field'));
			dom.append(wrap, $('span')).textContent = label;
			const input = dom.append(wrap, $(multiline ? 'textarea' : 'input')) as HTMLInputElement | HTMLTextAreaElement;
			input.value = value;
			input.maxLength = max;
			if (input instanceof HTMLTextAreaElement) {
				input.rows = Math.min(10, Math.max(4, Math.ceil(value.length / 48)));
			}
			return input;
		};
		const inputs = component
			? { name: field(localize('mapFieldName', "Name"), component.name, false, 80), summary: field(localize('mapFieldSummary', "Summary (shown in the box)"), component.summary, false, 160), description: field(localize('mapFieldDescription', "Description"), component.description, true, 2000) }
			: { label: field(localize('mapFieldLabel', "Label"), connection!.label, false, 80), detail: field(localize('mapFieldDetail', "Detail"), connection!.detail ?? '', true, 1000) };
		const save = async () => {
			if (component) {
				const name = inputs.name!.value.trim();
				if (!name) {
					inputs.name!.focus();
					return;
				}
				await this.activeService.reviseDiagramText({ components: [{ id: component.id, name, summary: inputs.summary!.value, description: inputs.description!.value }] });
			} else if (connection) {
				await this.activeService.reviseDiagramText({ connections: [{ from: connection.from, to: connection.to, label: inputs.label!.value, detail: inputs.detail!.value }] });
			}
			this.editing = false;
			this.renderPopup();
		};
		const cancel = () => {
			this.editing = false;
			this.renderPopup();
			this.root.focus();
		};
		this.popupStore.add(dom.addDisposableListener(form, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Escape') {
				event.preventDefault();
				event.stopPropagation();
				cancel();
			} else if (event.key === 'Enter' && (event.target instanceof HTMLInputElement || event.metaKey || event.ctrlKey)) {
				// Enter saves from a one-line field; ⌘-Enter from the description.
				event.preventDefault();
				void save();
			}
		}));
		const actions = dom.append(form, $('.popup-form-actions'));
		const saveButton = dom.append(actions, $('button.primary')) as HTMLButtonElement;
		saveButton.textContent = localize('mapSave', "Save");
		this.popupStore.add(dom.addDisposableListener(saveButton, dom.EventType.CLICK, () => void save()));
		const cancelButton = dom.append(actions, $('button.secondary')) as HTMLButtonElement;
		cancelButton.textContent = localize('mapCancel', "Cancel");
		this.popupStore.add(dom.addDisposableListener(cancelButton, dom.EventType.CLICK, cancel));
		dom.append(actions, $('span.popup-hint')).textContent = localize('mapEditHint', "Restructuring (splitting, merging, regrouping) is in the header.");
		const first = Object.values(inputs)[0] as HTMLInputElement;
		setTimeout(() => { first.focus(); first.select(); }, 0);
	}

	private renderFiles(body: HTMLElement, title: string, refs: readonly SystemFileRef[]): void {
		if (!refs.length) {
			return;
		}
		dom.append(body, $('.popup-section')).textContent = title;
		const list = dom.append(body, $('ul.popup-files'));
		for (const ref of refs) {
			const item = dom.append(list, $('li'));
			const button = dom.append(item, $('button.link.file')) as HTMLButtonElement;
			const lines = ref.startLine ? (ref.endLine && ref.endLine !== ref.startLine ? `:${ref.startLine}-${ref.endLine}` : `:${ref.startLine}`) : '';
			button.textContent = `${ref.path}${lines}`;
			button.title = localize('mapOpenFile', "Open {0}", ref.path);
			if (ref.why) {
				dom.append(item, $('span.popup-file-why')).textContent = ref.why;
			}
			this.popupStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => void this.openFile(ref)));
		}
	}

	/** Next to the selected box (or arrow), on whichever side has room; it follows pans and zooms. */
	private placePopup(): void {
		if (this.popup.classList.contains('hidden') || !this.selection) {
			return;
		}
		const selection = this.selection;
		let anchor: { x: number; y: number; width: number; height: number } | undefined;
		if (selection.kind === 'component') {
			const point = this.positions.get(selection.id);
			anchor = point && { x: point.x, y: point.y, width: NODE_WIDTH, height: NODE_HEIGHT };
		} else {
			const from = this.positions.get(selection.from);
			const to = this.positions.get(selection.to);
			if (from && to) {
				const middle = connectionPath(from, to).middle;
				anchor = { x: middle.x, y: middle.y, width: 0, height: 0 };
			}
		}
		if (!anchor) {
			return;
		}
		const left = this.pan.x + anchor.x * this.scale;
		const top = this.pan.y + anchor.y * this.scale;
		const right = left + anchor.width * this.scale;
		const width = this.popup.offsetWidth || 340;
		const height = this.popup.offsetHeight || 200;
		const roomRight = this.viewport.clientWidth - right;
		let x = roomRight >= width + 16 ? right + 12 : left - width - 12;
		x = Math.max(8, Math.min(x, this.viewport.clientWidth - width - 8));
		const y = Math.max(8, Math.min(top, this.viewport.clientHeight - height - 8));
		this.popup.style.transform = `translate(${x}px, ${y}px)`;
	}

	private async openFile(ref: SystemFileRef): Promise<void> {
		const folder = this.workspaceService.getWorkspace().folders[0];
		if (!folder) {
			return;
		}
		const line = ref.startLine ?? 1;
		await this.editorService.openEditor({
			resource: folder.toResource(ref.path),
			options: { pinned: true, revealIfOpened: true, selection: { startLineNumber: line, startColumn: 1, endLineNumber: ref.endLine ?? line, endColumn: 1 } },
		});
	}

	private async showVersion(version: number): Promise<void> {
		const latest = this.activeService.diagram.current;
		if (latest && version === latest.version) {
			this.viewingOld = false;
			this.shown = latest;
		} else {
			const revision = await this.activeService.diagramRevision(version);
			if (!revision) {
				return;
			}
			this.viewingOld = true;
			this.shown = revision;
		}
		this.renderAll();
	}

	// ------------------------------------------------------------------ remembered box positions

	private loadPositions(): Map<string, MapPoint> {
		try {
			const raw = JSON.parse(this.storage.get(POSITIONS_KEY, StorageScope.WORKSPACE, '{}')) as Record<string, MapPoint>;
			return new Map(Object.entries(raw).filter(([, point]) => typeof point?.x === 'number' && typeof point.y === 'number'));
		} catch {
			return new Map();
		}
	}

	private savePositions(): void {
		this.storage.store(POSITIONS_KEY, JSON.stringify(Object.fromEntries(this.positions)), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}
}
