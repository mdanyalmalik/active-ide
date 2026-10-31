/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceSet } from '../../../../base/common/map.js';
import { URI } from '../../../../base/common/uri.js';
import { IAccessibilityService } from '../../../../platform/accessibility/common/accessibility.js';
import { IUriIdentityService } from '../../../../platform/uriIdentity/common/uriIdentity.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { IExplorerService } from '../../files/browser/files.js';
import { ExplorerView } from '../../files/browser/views/explorerView.js';
import { ExplorerDelegate } from '../../files/browser/views/explorerViewer.js';
import { VIEW_ID as EXPLORER_VIEW_ID } from '../../files/common/files.js';
import { ExplorerItem } from '../../files/common/explorerModel.js';
import { SystemMapInput, WalkthroughInput } from './activeInputs.js';
import { IActiveService } from './activeService.js';

type ExplorerTree = ExplorerView['activeTree'];

const EASE = 'cubic-bezier(0.2, 0.8, 0.2, 1)';
const MOVE_MS = 200;
/** How long a folder that is still loading its children may take for them to slide in as its opening. */
const LOADING_GRACE_MS = 3000;
/** How long the rows captured just before a click stay usable for a closing folder's fade-out. */
const SNAPSHOT_MS = 1500;
/** Between opening one folder and the next one inside it, so each opening can be followed. */
const CASCADE_MS = 110;
const SCROLL_MS = 320;
/** Between closing folders and opening others, so the two don't play over each other. */
const CLOSE_MS = MOVE_MS;

export type Animate = (element: HTMLElement, keyframes: Keyframe[], options: KeyframeAnimationOptions) => void;

interface CapturedRow {
	readonly index: number;
	readonly level: number;
	readonly top: number;
	readonly clone: HTMLElement;
}

interface Toggle {
	readonly index: number;
	readonly level: number;
	readonly expanded: boolean;
}

/**
 * Animates a tree's folders opening and closing, whoever opens them (a click, the keyboard, the walkthrough).
 * It watches the list's rows: when a folder's row flips `aria-expanded`, the rows below slide to their new
 * place, the folder's children fade in, and (on closing) copies of the rows that went away fade out.
 */
export class TreeMotion extends Disposable {
	private captured: { readonly rows: readonly CapturedRow[]; readonly at: number } | undefined;
	private loading: (Toggle & { readonly at: number }) | undefined;
	private twistieTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly rows: HTMLElement,
		private readonly reduced: () => boolean,
		private readonly animate: Animate = (element, keyframes, options) => { element.animate(keyframes, options); },
		private readonly now: () => number = Date.now,
	) {
		super();
		const observer = new (dom.getWindow(rows).MutationObserver)(records => this.onMutations(records));
		observer.observe(rows, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['style', 'data-index', 'aria-expanded'] });
		this._register(toDisposable(() => {
			observer.disconnect();
			clearTimeout(this.twistieTimer);
		}));
	}

	/** Copies the rows on screen: called just before something may close a folder, so its rows can fade out. */
	capture(): void {
		this.captured = {
			at: this.now(),
			rows: this.currentRows().map(row => {
				const clone = row.cloneNode(true) as HTMLElement;
				clone.removeAttribute('id');
				clone.setAttribute('aria-hidden', 'true');
				clone.classList.add('active-tree-ghost');
				return { index: indexOf(row), level: levelOf(row), top: topOf(row), clone };
			}),
		};
	}

	private currentRows(): HTMLElement[] {
		return [...this.rows.children].filter((node): node is HTMLElement => isRow(node));
	}

	private onMutations(records: MutationRecord[]): void {
		const oldTop = new Map<HTMLElement, number>();
		const oldIndex = new Map<HTMLElement, number>();
		const added = new Set<HTMLElement>();
		const flipped: Array<{ row: HTMLElement; was: string }> = [];
		for (const record of records) {
			if (record.type === 'childList') {
				if (record.target === this.rows) {
					record.addedNodes.forEach(node => isRow(node) && added.add(node));
				}
				continue;
			}
			const target = record.target as HTMLElement;
			if (record.attributeName === 'aria-expanded') {
				const row = target.closest<HTMLElement>('.monaco-list-row');
				if (row && isRow(row) && record.oldValue !== null) {
					flipped.push({ row, was: record.oldValue });
				}
			} else if (isRow(target) && record.oldValue !== null) {
				if (record.attributeName === 'style' && !oldTop.has(target)) {
					const top = /top:\s*(-?[\d.]+)px/.exec(record.oldValue);
					if (top) {
						oldTop.set(target, Number(top[1]));
					}
				} else if (record.attributeName === 'data-index' && !oldIndex.has(target)) {
					oldIndex.set(target, Number(record.oldValue));
				}
			}
		}
		// A toggle: a row that stayed in place changed state. A row that also moved is either a folder further
		// down that changed too (Collapse All) or a row element reused for another item; told apart below.
		const toggles: Toggle[] = [];
		const moved: Array<{ readonly row: HTMLElement; readonly shift: number }> = [];
		for (const { row, was } of flipped) {
			const expanded = row.querySelector('[aria-expanded]')?.getAttribute('aria-expanded') ?? row.getAttribute('aria-expanded');
			const index = indexOf(row);
			const before = oldIndex.get(row) ?? index;
			if (expanded === was || added.has(row)) {
				continue;
			}
			if (before !== index) {
				moved.push({ row, shift: index - before });
			} else if (!toggles.some(toggle => toggle.index === index)) {
				toggles.push({ index, level: levelOf(row), expanded: expanded === 'true' });
			}
		}
		if (toggles.length > 1 || this.reduced()) {
			// Many folders at once (a refresh, Collapse All): no animation.
			this.loading = undefined;
			return;
		}
		if (toggles.length) {
			this.turnTwisties();
		}
		let toggle: Toggle | undefined = toggles[0];
		if (!toggle && this.loading && this.now() - this.loading.at < LOADING_GRACE_MS) {
			// A folder opened before its children had loaded: they arrive now.
			toggle = this.loading;
		}
		if (!toggle) {
			return;
		}
		const shift = shiftOf(this.currentRows(), oldIndex, toggle);
		if (moved.some(flip => flip.shift === shift)) {
			// A folder below moved with the rest and changed as well: several folders changed at once.
			this.loading = undefined;
			return;
		}
		if (!shift) {
			this.loading = toggle.expanded ? { ...toggle, at: this.now() } : undefined;
			return;
		}
		this.loading = undefined;
		this.play(toggle, shift, oldTop, oldIndex, added);
	}

	private play(toggle: Toggle, shift: number, oldTop: Map<HTMLElement, number>, oldIndex: Map<HTMLElement, number>, added: Set<HTMLElement>): void {
		const height = this.rowHeight();
		for (const row of this.currentRows()) {
			const index = indexOf(row);
			const top = topOf(row);
			const before = oldTop.get(row);
			if (shift > 0 && index > toggle.index && index <= toggle.index + shift) {
				this.unfold(row, (index - toggle.index - 1) * height, shift * height);
			} else if (before !== undefined && oldIndex.get(row) !== undefined && index - oldIndex.get(row)! === shift && before !== top) {
				this.cancel(row);
				this.animate(row, [{ transform: `translateY(${before - top}px)` }, { transform: 'translateY(0)' }], { duration: MOVE_MS, easing: EASE });
			} else if (added.has(row) || (before !== undefined && before !== top)) {
				// A row that scrolled into view, or a row element reused for another item.
				this.enter(row);
			}
		}
		if (shift < 0) {
			this.foldClosed(toggle, -shift, height);
		}
	}

	private rowHeight(): number {
		return this.currentRows().map(row => parseFloat(row.style.height)).find(height => height > 0) ?? 22;
	}

	/** A row that scrolled into view, or a row element reused for another item: it just fades in. */
	private enter(row: HTMLElement): void {
		this.cancel(row);
		this.animate(row, [{ opacity: 0 }, { opacity: 1 }], { duration: MOVE_MS, easing: EASE });
	}

	/**
	 * A child of a folder that opened, `offset` px below the folder: it slides out from under the folder's row,
	 * in step with the rows below moving down `distance` px, and is only seen below the folder's row.
	 */
	private unfold(row: HTMLElement, offset: number, distance: number): void {
		this.cancel(row);
		const keyframes: Keyframe[] = [{ offset: 0, transform: `translateY(${-distance}px)`, clipPath: `inset(${distance - offset}px 0 0 0)` }];
		if (offset > 0) {
			keyframes.push({ offset: 1 - offset / distance, clipPath: 'inset(0px 0 0 0)' });
		}
		keyframes.push({ offset: 1, transform: 'translateY(0)', clipPath: 'inset(0px 0 0 0)' });
		this.animate(row, keyframes, { duration: MOVE_MS, easing: EASE });
	}

	/**
	 * The closed folder's rows are gone already: copies captured just before slide up under the folder's row,
	 * in step with the rows below, so the two never overlap.
	 */
	private foldClosed(toggle: Toggle, count: number, height: number): void {
		const captured = this.captured;
		this.captured = undefined;
		if (!captured || this.now() - captured.at > SNAPSHOT_MS) {
			return;
		}
		const distance = count * height;
		for (const row of captured.rows) {
			if (row.index > toggle.index && row.index <= toggle.index + count && row.level > toggle.level) {
				const offset = (row.index - toggle.index - 1) * height;
				const ghost = row.clone;
				ghost.style.top = `${row.top}px`;
				this.rows.prepend(ghost);
				const keyframes: Keyframe[] = [{ offset: 0, transform: 'translateY(0)', clipPath: 'inset(0px 0 0 0)' }];
				if (offset > 0) {
					keyframes.push({ offset: offset / distance, clipPath: 'inset(0px 0 0 0)' });
				}
				keyframes.push({ offset: 1, transform: `translateY(${-distance}px)`, clipPath: `inset(${distance - offset}px 0 0 0)` });
				this.animate(ghost, keyframes, { duration: MOVE_MS, easing: EASE, fill: 'forwards' });
				setTimeout(() => ghost.remove(), MOVE_MS + 20);
			}
		}
	}

	/** The arrow beside a folder turns instead of jumping (only while a folder is toggled, not as rows scroll). */
	private turnTwisties(): void {
		this.rows.classList.add('active-tree-animating');
		clearTimeout(this.twistieTimer);
		this.twistieTimer = setTimeout(() => this.rows.classList.remove('active-tree-animating'), 400);
	}

	private cancel(row: HTMLElement): void {
		for (const animation of row.getAnimations?.() ?? []) {
			animation.cancel();
		}
	}
}

function isRow(node: Node): node is HTMLElement {
	return dom.isHTMLElement(node) && node.classList.contains('monaco-list-row') && !node.classList.contains('active-tree-ghost');
}

function indexOf(row: HTMLElement): number {
	return Number(row.getAttribute('data-index'));
}

function levelOf(row: HTMLElement): number {
	return Number(row.getAttribute('aria-level') ?? 0);
}

function topOf(row: HTMLElement): number {
	return parseFloat(row.style.top) || 0;
}

/**
 * How far the rows after the toggled folder moved (in rows): the change most of them agree on, down when it
 * opened and up when it closed (rows reused for other items move every which way).
 */
function shiftOf(rows: HTMLElement[], oldIndex: Map<HTMLElement, number>, toggle: Toggle): number {
	const toggled = toggle.index;
	const votes = new Map<number, number>();
	for (const row of rows) {
		const before = oldIndex.get(row);
		if (before !== undefined && before > toggled) {
			const shift = indexOf(row) - before;
			if (toggle.expanded ? shift > 0 : shift < 0) {
				votes.set(shift, (votes.get(shift) ?? 0) + 1);
			}
		}
	}
	let best = 0;
	let bestVotes = 0;
	for (const [shift, count] of votes) {
		if (count > bestVotes) {
			best = shift;
			bestVotes = count;
		}
	}
	if (best || !toggle.expanded) {
		return best;
	}
	// Nothing below the folder is on screen: count its children right after it instead.
	const level = levelOf(rows.find(row => indexOf(row) === toggled) ?? rows[0]);
	let children = 0;
	for (const row of [...rows].sort((a, b) => indexOf(a) - indexOf(b))) {
		if (indexOf(row) === toggled + children + 1 && levelOf(row) > level) {
			children++;
		}
	}
	return children;
}

/** The outline on the Explorer row of the file the walkthrough is showing; it slides from file to file. */
class FileOutline extends Disposable {
	private readonly element: HTMLElement;
	private shown = false;

	constructor(private readonly rows: HTMLElement) {
		super();
		this.element = dom.append(rows, dom.$('.active-explorer-outline'));
		this.element.setAttribute('aria-hidden', 'true');
		this._register(toDisposable(() => this.element.remove()));
	}

	show(top: number, height: number): void {
		if (this.element.parentElement !== this.rows) {
			this.rows.appendChild(this.element);
		}
		this.element.style.height = `${height}px`;
		if (!this.shown) {
			// Appears where the file is, rather than sliding in from the last place it was.
			this.element.classList.add('placing');
			this.element.style.transform = `translateY(${top}px)`;
			void this.element.offsetHeight;
			this.element.classList.remove('placing');
			this.element.classList.add('visible');
			this.shown = true;
		} else {
			this.element.style.transform = `translateY(${top}px)`;
		}
	}

	hide(): void {
		this.element.classList.remove('visible');
		this.shown = false;
	}
}

/** What the guide keeps for the Explorer tree it is attached to. */
class Attachment extends Disposable {
	readonly motion: TreeMotion;
	/** One outline per file being shown (a walkthrough shows one; a system map component can cite several). */
	private readonly outlines: FileOutline[] = [];

	constructor(readonly tree: ExplorerTree, readonly view: ExplorerView, private readonly rows: HTMLElement, reduced: () => boolean) {
		super();
		this.motion = this._register(new TreeMotion(rows, reduced));
	}

	outline(index: number): FileOutline {
		while (this.outlines.length <= index) {
			this.outlines.push(this._register(new FileOutline(this.rows)));
		}
		return this.outlines[index];
	}

	/** Hides the outlines from `from` on. */
	hideOutlines(from = 0): void {
		this.outlines.slice(from).forEach(outline => outline.hide());
	}
}

/**
 * While a walkthrough is the active editor, Explorer outlines the file it is showing. Folders on the way to the
 * file are opened (and closed again once the walkthrough no longer needs them, unless the developer has
 * since used them), and the list scrolls to the file. The developer always comes first: clicking in Explorer
 * stops whatever the guide is doing and pauses the narration.
 */
export class ExplorerGuide extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.activeExplorerGuide';

	private readonly attachment = this._register(new MutableDisposable<Attachment>());
	private readonly attachmentListeners = this._register(new DisposableStore());
	private readonly inputListener = this._register(new MutableDisposable());
	private readonly playerListener = this._register(new MutableDisposable());
	private wasPlaying = false;
	private input: WalkthroughInput | undefined;
	/** The files Explorer outlines: the walkthrough's file, or the files of the system map's selected component. */
	private targets: readonly URI[] = [];
	private mapInput: SystemMapInput | undefined;
	/** Bumped by every new target and every click in Explorer: older guide work stops at its next step. */
	private generation = 0;
	/** Folders the guide opened, to close again when they're no longer needed. */
	private readonly opened = new ResourceSet();
	private toggling: ExplorerItem | undefined;
	private scroll: { readonly window: Window; frame: number } | undefined;
	/** The last guide couldn't reach the file (Explorer hidden, or its folders not loaded yet): try again. */
	private incomplete = false;
	/** While the guide opens and closes folders on the way, the outline waits where it is, then slides. */
	private moving = 0;
	private readonly retry = this._register(new RunOnceScheduler(() => this.incomplete && this.targets.length && void this.guide(this.targets), 150));

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IViewsService private readonly viewsService: IViewsService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IExplorerService private readonly explorerService: IExplorerService,
		@IActiveService private readonly activeService: IActiveService,
		@IAccessibilityService private readonly accessibilityService: IAccessibilityService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
	) {
		super();
		this._register(this.editorService.onDidActiveEditorChange(() => this.update()));
		this._register(this.viewsService.onDidChangeViewVisibility(event => event.id === EXPLORER_VIEW_ID && this.update()));
		this._register(toDisposable(() => this.stopScroll()));
		this._register(this.activeService.onDidChangePlayer(() => this.watchPlayer()));
		this.watchPlayer();
		this.update();
	}

	/**
	 * When narration resumes, the file is shown again: folders the developer closed meanwhile (hiding it) reopen,
	 * and close again once the walkthrough no longer needs them.
	 */
	private watchPlayer(): void {
		const player = this.activeService.player;
		this.wasPlaying = !!player?.playing;
		this.playerListener.value = player?.onDidChange(() => {
			const playing = player.playing;
			if (playing && !this.wasPlaying && this.input?.walkthrough.id === player.walkthrough.id) {
				this.update();
			}
			this.wasPlaying = playing;
		});
	}

	private update(): void {
		const active = this.editorService.activeEditor;
		const input = active instanceof WalkthroughInput ? active : undefined;
		const mapInput = active instanceof SystemMapInput ? active : undefined;
		if (input !== this.input || mapInput !== this.mapInput) {
			this.input = input;
			this.mapInput = mapInput;
			this.inputListener.value = input?.onDidChangeFile(() => this.update()) ?? mapInput?.onDidChangeSelection(() => this.update());
		}
		const folder = this.workspaceService.getWorkspace().folders[0];
		const files = input?.file ? [input.file] : mapInput?.selectedFiles ?? [];
		void this.guide(folder ? files.map(file => folder.toResource(file)) : []);
	}

	private explorer(): Attachment | undefined {
		const view = this.viewsService.getViewWithId<ExplorerView>(EXPLORER_VIEW_ID);
		const tree = view instanceof ExplorerView ? view.activeTree : undefined;
		if (!view || !tree) {
			this.attachment.clear();
			return undefined;
		}
		if (this.attachment.value?.tree !== tree) {
			const rows = tree.getHTMLElement().querySelector<HTMLElement>('.monaco-list-rows');
			if (!rows) {
				return undefined;
			}
			this.attachmentListeners.clear();
			const attachment = this.attachment.value = new Attachment(tree, view, rows, () => this.accessibilityService.isMotionReduced());
			// Capture: before the tree acts on the click or key, so a closing folder's rows can still be copied.
			this.attachmentListeners.add(dom.addDisposableListener(view.element, dom.EventType.POINTER_DOWN, () => this.onDeveloperAction(attachment), true));
			this.attachmentListeners.add(dom.addDisposableListener(tree.getHTMLElement(), dom.EventType.KEY_DOWN, () => this.onDeveloperAction(attachment), true));
			this.attachmentListeners.add(dom.addDisposableListener(tree.getHTMLElement(), dom.EventType.MOUSE_WHEEL, () => this.stopScroll(), { passive: true }));
			this.attachmentListeners.add(tree.onDidChangeCollapseState(event => {
				const item = event.node.element?.element;
				if (item instanceof ExplorerItem && item !== this.toggling) {
					// The developer opened or closed it: it's theirs now, the guide won't close it later.
					this.opened.delete(item.resource);
				}
				this.placeOutline();
			}));
			this.attachmentListeners.add(tree.onDidChangeContentHeight(() => {
				this.placeOutline();
				if (this.incomplete) {
					this.retry.schedule();
				}
			}));
			this.attachmentListeners.add(view.onDidChangeBodyVisibility(() => this.retry.schedule()));
		}
		return this.attachment.value;
	}

	private onDeveloperAction(attachment: Attachment): void {
		attachment.motion.capture();
		if (!this.input && !this.mapInput) {
			return;
		}
		this.generation++;
		this.incomplete = false;
		this.retry.cancel();
		this.stopScroll();
		const player = this.activeService.player;
		if (player && player.walkthrough.id === this.input?.walkthrough.id && (player.state === 'speaking' || player.state === 'loading')) {
			player.pause();
		}
	}

	private async guide(targets: readonly URI[]): Promise<void> {
		const generation = ++this.generation;
		this.targets = targets;
		this.incomplete = targets.length > 0;
		const attachment = this.explorer();
		if (!attachment) {
			return;
		}
		const visible = attachment.view.isBodyVisible();
		if (!targets.length || !visible) {
			attachment.hideOutlines();
			if (!targets.length) {
				await this.closeUnneeded(attachment, undefined, generation);
			}
			return;
		}
		const extUri = this.uriIdentityService.extUri;
		const needed = new ResourceSet();
		for (const target of targets) {
			for (let folder = extUri.dirname(target); !extUri.isEqual(folder, extUri.dirname(folder)); folder = extUri.dirname(folder)) {
				needed.add(folder);
			}
		}
		let item: ExplorerItem | undefined;
		this.moving++;
		try {
			const closed = await this.closeUnneeded(attachment, needed, generation);
			if (closed && !this.accessibilityService.isMotionReduced()) {
				// Let the closing finish first: rows fading out and in at once read as a jumble.
				await new Promise(resolve => setTimeout(resolve, CLOSE_MS));
			}
			if (generation !== this.generation) {
				return;
			}
			for (const target of targets) {
				const found = await this.openTo(attachment.tree, target, generation);
				if (generation !== this.generation) {
					return;
				}
				item ??= found;
			}
		} finally {
			this.moving--;
			if (generation !== this.generation) {
				// Stopped (a click, or a newer file): put the outline where things stand now.
				this.placeOutline();
			}
		}
		if (generation !== this.generation) {
			return;
		}
		if (!item) {
			attachment.hideOutlines();
			return;
		}
		this.incomplete = false;
		this.scrollTo(attachment.tree, item);
		this.placeOutline();
	}

	/** Opens the folders on the way to `target`, remembering the ones that were closed. */
	private async openTo(tree: ExplorerTree, target: URI, generation: number): Promise<ExplorerItem | undefined> {
		const extUri = this.uriIdentityService.extUri;
		let item: ExplorerItem | undefined = this.explorerService.findClosestRoot(target) ?? undefined;
		let opened = false;
		while (item && !extUri.isEqual(item.resource, target)) {
			if (item !== tree.getInput() && tree.hasNode(item) && tree.isCollapsed(item)) {
				if (opened) {
					await new Promise(resolve => setTimeout(resolve, this.accessibilityService.isMotionReduced() ? 0 : CASCADE_MS));
					if (generation !== this.generation) {
						return undefined;
					}
				}
				this.opened.add(item.resource);
				await this.toggle(tree, item, true);
				opened = true;
				if (generation !== this.generation) {
					return undefined;
				}
			}
			item = [...item.children.values()].find(child => extUri.isEqualOrParent(target, child.resource));
		}
		if (item?.nestedParent && tree.hasNode(item.nestedParent) && tree.isCollapsed(item.nestedParent)) {
			this.opened.add(item.nestedParent.resource);
			await this.toggle(tree, item.nestedParent, true);
		}
		return item;
	}

	/**
	 * Closes the folders the guide opened that `needed` doesn't include (all of them without a target). A folder stays open if the developer has since closed it themselves, selected something in it,
	 * or has a file from it open.
	 */
	private async closeUnneeded(attachment: Attachment, needed: ResourceSet | undefined, generation: number): Promise<number> {
		const extUri = this.uriIdentityService.extUri;
		const tree = attachment.tree;
		// Outermost first: a folder inside one that just closed is out of sight, so it closes without a second animation.
		const doomed = [...this.opened].filter(folder => !needed?.has(folder)).sort((a, b) => a.path.length - b.path.length);
		const inUse = [...tree.getSelection().map(item => item.resource)];
		const activeFile = this.editorService.activeEditor?.resource;
		if (activeFile && activeFile.scheme !== 'active') {
			inUse.push(activeFile);
		}
		let closed = 0;
		for (const folder of doomed) {
			if (generation !== this.generation) {
				return closed;
			}
			this.opened.delete(folder);
			const item = this.explorerService.findClosest(folder);
			if (!item || !extUri.isEqual(item.resource, folder) || !tree.hasNode(item) || tree.isCollapsed(item)) {
				continue;
			}
			if (inUse.some(resource => extUri.isEqualOrParent(resource, folder) && !extUri.isEqual(resource, folder))) {
				continue;
			}
			attachment.motion.capture();
			await this.toggle(tree, item, false);
			closed++;
		}
		return closed;
	}

	private async toggle(tree: ExplorerTree, item: ExplorerItem, expand: boolean): Promise<void> {
		this.toggling = item;
		try {
			if (expand) {
				await tree.expand(item);
			} else {
				tree.collapse(item);
			}
		} catch {
			// The item left the tree meanwhile (deleted, or Explorer refreshed): nothing to do.
		} finally {
			this.toggling = undefined;
		}
	}

	/** Puts the outline on the target's row, or hides it when the row isn't in the list (a folder above it closed). */
	private placeOutline(): void {
		const attachment = this.attachment.value;
		if (!attachment) {
			return;
		}
		this.targets.forEach((target, index) => {
			const item = this.explorerService.findClosest(target);
			const top = item && this.uriIdentityService.extUri.isEqual(item.resource, target) && attachment.tree.hasNode(item) ? attachment.tree.getElementTop(item) : undefined;
			if (top === undefined && this.moving) {
				return;
			}
			if (top === undefined || !attachment.view.isBodyVisible()) {
				attachment.outline(index).hide();
			} else {
				attachment.outline(index).show(top, ExplorerDelegate.ITEM_HEIGHT);
			}
		});
		attachment.hideOutlines(this.targets.length);
	}

	/** Scrolls the file into the middle of the list if it's out of view, smoothly unless motion is reduced. */
	private scrollTo(tree: ExplorerTree, item: ExplorerItem): void {
		const top = tree.getElementTop(item);
		if (top === undefined) {
			return;
		}
		const height = ExplorerDelegate.ITEM_HEIGHT;
		// Room for the folder names that stick to the top while scrolling.
		const margin = height * 2;
		if (top >= tree.scrollTop + margin && top + height <= tree.scrollTop + tree.renderHeight - height) {
			return;
		}
		const destination = Math.max(0, Math.min(top - (tree.renderHeight - height) / 2, tree.scrollHeight - tree.renderHeight));
		this.stopScroll();
		if (this.accessibilityService.isMotionReduced()) {
			tree.scrollTop = destination;
			return;
		}
		const window = dom.getWindow(tree.getHTMLElement());
		const start = tree.scrollTop;
		const began = Date.now();
		const step = () => {
			const progress = Math.min(1, (Date.now() - began) / SCROLL_MS);
			const eased = progress < 0.5 ? 2 * progress * progress : 1 - Math.pow(-2 * progress + 2, 2) / 2;
			tree.scrollTop = start + (destination - start) * eased;
			if (progress < 1 && this.scroll) {
				this.scroll.frame = window.requestAnimationFrame(step);
			} else {
				this.scroll = undefined;
			}
		};
		this.scroll = { window, frame: window.requestAnimationFrame(step) };
	}

	private stopScroll(): void {
		if (this.scroll) {
			this.scroll.window.cancelAnimationFrame(this.scroll.frame);
			this.scroll = undefined;
		}
	}
}
