/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/agentGrid.css';
import * as dom from '../../../../base/browser/dom.js';
import { Separator, SubmenuAction, toAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable, DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { AGENT_COLORS, type AgentApprovalMode, type AgentInfo, type AgentOverlap, type ChatEntry, type ExplainMode } from '../common/activeProtocol.js';
import { IActiveService } from './activeService.js';
import { renderPresenceBadges } from './multiplayer/presence.js';

const $ = dom.$;

// ===================================================================== layout (pure)

export type GridPreset = 'auto' | 'columns' | 'rows' | 'focus' | 'custom';
export const GRID_PRESETS: readonly GridPreset[] = ['auto', 'columns', 'rows', 'focus', 'custom'];

export interface GridRect {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface GridLayoutInput {
	/** Top-level boxes, in order. */
	readonly ids: readonly string[];
	readonly preset: GridPreset;
	/** The space the boxes may use (the viewport, without its padding). */
	readonly width: number;
	readonly height: number;
	/** Boxes keep a comfortable size and the grid extends past the viewport, instead of shrinking to fit. */
	readonly overflow: boolean;
	/** The large box in Focus. */
	readonly focusId?: string;
	/** Positions and sizes for Custom (unscaled). */
	readonly custom?: Readonly<Record<string, GridRect>>;
}

export interface GridLayout {
	/** Where each box goes, already scaled. */
	readonly rects: ReadonlyMap<string, GridRect>;
	/** The size of everything laid out (can exceed the viewport with overflow on). */
	readonly width: number;
	readonly height: number;
	/** Custom without overflow is shrunk to fit; positions on screen are `custom * scale`. */
	readonly scale: number;
}

export const GRID_GAP = 12;
/** Smallest comfortable box: with overflow on, boxes don't shrink below this. */
export const COMFORT_BOX = { width: 340, height: 240 };
/** Smallest box the user can resize to. */
export const MIN_BOX = { width: 220, height: 150 };
/** Width over height that boxes look best at (enough lines to read, enough width for a sentence). */
const BOX_ASPECT = 1.5;

function rect(x: number, y: number, width: number, height: number): GridRect {
	return { x: Math.round(x), y: Math.round(y), width: Math.max(0, Math.round(width)), height: Math.max(0, Math.round(height)) };
}

function split(total: number, count: number): number {
	return count <= 0 ? 0 : (total - GRID_GAP * (count - 1)) / count;
}

/** Columns for `count` boxes in `width` × `height` so they're as large as possible at a readable shape. */
export function bestColumns(count: number, width: number, height: number): number {
	let best = 1;
	let bestScore = -Infinity;
	for (let columns = 1; columns <= Math.max(1, count); columns++) {
		const rows = Math.ceil(count / columns);
		const cellWidth = split(width, columns);
		const cellHeight = split(height, rows);
		// The width of the largest BOX_ASPECT box that fits a cell; empty cells cost a little.
		const score = Math.min(cellWidth, cellHeight * BOX_ASPECT) - (columns * rows - count) * 4;
		if (score > bestScore) {
			bestScore = score;
			best = columns;
		}
	}
	return best;
}

/** A regular grid in an area: row by row, or (extending sideways) column by column. */
function gridIn(ids: readonly string[], x: number, y: number, width: number, height: number, overflow: boolean, out: Map<string, GridRect>): { width: number; height: number } {
	const count = ids.length;
	if (!count) {
		return { width: 0, height: 0 };
	}
	const columns = bestColumns(count, width, height);
	const rows = Math.ceil(count / columns);
	const cellWidth = split(width, columns);
	const cellHeight = split(height, rows);
	if (!overflow || (cellWidth >= COMFORT_BOX.width && cellHeight >= COMFORT_BOX.height)) {
		ids.forEach((id, index) => out.set(id, rect(x + (index % columns) * (cellWidth + GRID_GAP), y + Math.floor(index / columns) * (cellHeight + GRID_GAP), cellWidth, cellHeight)));
		return { width, height };
	}
	// Too many to fit comfortably: keep the rows that fit, extend to the right. Column by column, so a new agent
	// lands at the end instead of reshuffling everyone.
	const fitRows = Math.max(1, Math.min(count, Math.floor((height + GRID_GAP) / (COMFORT_BOX.height + GRID_GAP))));
	const fitColumns = Math.ceil(count / fitRows);
	const boxHeight = split(height, fitRows);
	const boxWidth = Math.max(COMFORT_BOX.width, split(width, fitColumns));
	ids.forEach((id, index) => out.set(id, rect(x + Math.floor(index / fitRows) * (boxWidth + GRID_GAP), y + (index % fitRows) * (boxHeight + GRID_GAP), boxWidth, boxHeight)));
	return { width: fitColumns * boxWidth + (fitColumns - 1) * GRID_GAP, height };
}

/** Where a box without a custom place goes: the first free cell, scanning like Auto would, else after everything. */
export function placeNewRect(taken: readonly GridRect[], width: number, height: number): GridRect {
	const size = { width: COMFORT_BOX.width, height: COMFORT_BOX.height };
	const overlaps = (candidate: GridRect) => taken.some(other => candidate.x < other.x + other.width + GRID_GAP / 2 && other.x < candidate.x + candidate.width + GRID_GAP / 2
		&& candidate.y < other.y + other.height + GRID_GAP / 2 && other.y < candidate.y + candidate.height + GRID_GAP / 2);
	const columns = Math.max(1, Math.floor((width + GRID_GAP) / (size.width + GRID_GAP)));
	const rows = Math.max(1, Math.floor((height + GRID_GAP) / (size.height + GRID_GAP)));
	for (let row = 0; row < rows; row++) {
		for (let column = 0; column < columns; column++) {
			const candidate = rect(column * (size.width + GRID_GAP), row * (size.height + GRID_GAP), size.width, size.height);
			if (!overlaps(candidate)) {
				return candidate;
			}
		}
	}
	const right = taken.reduce((max, other) => Math.max(max, other.x + other.width), 0);
	return rect(right + GRID_GAP, 0, size.width, size.height);
}

export function computeGridLayout(input: GridLayoutInput): GridLayout {
	const { ids, overflow } = input;
	const width = Math.max(1, input.width);
	const height = Math.max(1, input.height);
	const rects = new Map<string, GridRect>();
	let used = { width, height };
	let scale = 1;
	switch (input.preset) {
		case 'auto':
			used = gridIn(ids, 0, 0, width, height, overflow, rects);
			break;
		case 'columns': {
			const columnWidth = overflow ? Math.max(COMFORT_BOX.width, split(width, ids.length)) : split(width, ids.length);
			ids.forEach((id, index) => rects.set(id, rect(index * (columnWidth + GRID_GAP), 0, columnWidth, height)));
			used = { width: Math.max(width, ids.length * columnWidth + (ids.length - 1) * GRID_GAP), height };
			break;
		}
		case 'rows': {
			// Rows are full width, so with overflow on the extra ones continue below rather than to the side.
			const rowHeight = overflow ? Math.max(COMFORT_BOX.height * 0.75, split(height, ids.length)) : split(height, ids.length);
			ids.forEach((id, index) => rects.set(id, rect(0, index * (rowHeight + GRID_GAP), width, rowHeight)));
			used = { width, height: Math.max(height, ids.length * rowHeight + (ids.length - 1) * GRID_GAP) };
			break;
		}
		case 'focus': {
			const focusId = input.focusId && ids.includes(input.focusId) ? input.focusId : ids[0];
			const others = ids.filter(id => id !== focusId);
			if (!focusId) {
				break;
			}
			if (!others.length) {
				rects.set(focusId, rect(0, 0, width, height));
				break;
			}
			const mainWidth = Math.max(Math.min(width * 0.62, width - MIN_BOX.width - GRID_GAP), Math.min(width, overflow ? COMFORT_BOX.width * 1.4 : MIN_BOX.width));
			rects.set(focusId, rect(0, 0, mainWidth, height));
			const sideX = mainWidth + GRID_GAP;
			const sideWidth = Math.max(overflow ? MIN_BOX.width : 1, width - sideX);
			if (!overflow) {
				gridIn(others, sideX, 0, sideWidth, height, false, rects);
				break;
			}
			// The others stack beside the big one; columns of them continue to the right.
			const perColumn = Math.max(1, Math.floor((height + GRID_GAP) / (MIN_BOX.height + GRID_GAP)));
			const stack = Math.min(perColumn, others.length);
			const boxHeight = split(height, stack);
			others.forEach((id, index) => rects.set(id, rect(sideX + Math.floor(index / stack) * (sideWidth + GRID_GAP), (index % stack) * (boxHeight + GRID_GAP), sideWidth, boxHeight)));
			const columns = Math.ceil(others.length / stack);
			used = { width: Math.max(width, sideX + columns * sideWidth + (columns - 1) * GRID_GAP), height };
			break;
		}
		case 'custom': {
			const placed: GridRect[] = [];
			for (const id of ids) {
				const saved = input.custom?.[id];
				const box = saved ? rect(Math.max(0, saved.x), Math.max(0, saved.y), Math.max(MIN_BOX.width, saved.width), Math.max(MIN_BOX.height, saved.height)) : placeNewRect(placed, width, height);
				placed.push(box);
				rects.set(id, box);
			}
			const right = placed.reduce((max, box) => Math.max(max, box.x + box.width), 0);
			const bottom = placed.reduce((max, box) => Math.max(max, box.y + box.height), 0);
			if (!overflow && (right > width || bottom > height)) {
				// Overflow off means everything is on screen: shrink the whole arrangement (keeping it) to fit.
				scale = Math.min(width / right, height / bottom);
				for (const [id, box] of rects) {
					rects.set(id, rect(box.x * scale, box.y * scale, box.width * scale, box.height * scale));
				}
			}
			used = { width: Math.max(width, Math.round(right * scale)), height: Math.max(height, Math.round(bottom * scale)) };
			break;
		}
	}
	return { rects, width: Math.round(used.width), height: Math.round(used.height), scale };
}

/** Where a dragged box would go when dropped with the pointer at `point`: merged into another box, swapped with it, or moved. */
export function dropTargetAt(point: { x: number; y: number }, rects: ReadonlyMap<string, GridRect>, draggedId: string): { kind: 'merge' | 'swap'; id: string } | undefined {
	for (const [id, box] of rects) {
		if (id === draggedId || point.x < box.x || point.x > box.x + box.width || point.y < box.y || point.y > box.y + box.height) {
			continue;
		}
		// The middle of a box merges into it; its rim only swaps places, so rearranging a full grid stays possible.
		const insetX = box.width * 0.22;
		const insetY = box.height * 0.22;
		const inner = point.x > box.x + insetX && point.x < box.x + box.width - insetX && point.y > box.y + insetY && point.y < box.y + box.height - insetY;
		return { kind: inner ? 'merge' : 'swap', id };
	}
	return undefined;
}

// ===================================================================== overscroll gesture (pure)

export interface OverscrollOptions {
	/** How much wheel delta past the edge commits. */
	readonly threshold: number;
	/** Wheel events closer together than this are one gesture: momentum from the scroll that reached the edge doesn't count. */
	readonly pauseMs: number;
	/** A pause this long lets an unfinished pull go back to nothing. */
	readonly releaseMs: number;
	/** No single event moves the pull more than this (a fast flick shouldn't commit in one go). */
	readonly maxStep: number;
}

export const DEFAULT_OVERSCROLL: OverscrollOptions = { threshold: 420, pauseMs: 250, releaseMs: 450, maxStep: 90 };

export interface OverscrollStep {
	/** 0…1: how far the pull indicator is. */
	readonly progress: number;
	readonly committed: boolean;
}

/**
 * Pulling past the end of a scrolling view. Wheel delta only counts once the view is at its edge and a fresh
 * gesture starts there (a pause since the last wheel event); the momentum that carried the view to the edge
 * never does, so the zoom isn't triggered by accident.
 */
export class OverscrollGesture {
	private accumulated = 0;
	private armed = false;
	private lastAt = -Infinity;

	constructor(private readonly options: OverscrollOptions = DEFAULT_OVERSCROLL) { }

	get progress(): number {
		return Math.min(1, this.accumulated / this.options.threshold);
	}

	/**
	 * `delta`: wheel movement, positive towards the edge being pulled past. `atEdge`: the view can't scroll that way
	 * any more (measured before this event scrolls it).
	 */
	wheel(delta: number, atEdge: boolean, now: number): OverscrollStep {
		const gap = now - this.lastAt;
		this.lastAt = now;
		if (delta <= 0 || !atEdge) {
			// Scrolling within the view, or back: start over, and wait for a fresh gesture at the edge.
			this.accumulated = 0;
			this.armed = false;
			return { progress: 0, committed: false };
		}
		if (!this.armed) {
			if (gap < this.options.pauseMs) {
				return { progress: 0, committed: false };
			}
			this.armed = true;
		}
		if (gap >= this.options.releaseMs) {
			this.accumulated = 0;
		}
		this.accumulated += Math.min(delta, this.options.maxStep);
		if (this.accumulated >= this.options.threshold) {
			this.accumulated = 0;
			this.armed = false;
			return { progress: 1, committed: true };
		}
		return { progress: this.progress, committed: false };
	}

	/** The pull after no wheel events until `now`: a pause releases it. */
	idle(now: number): number {
		if (now - this.lastAt >= this.options.releaseMs) {
			this.accumulated = 0;
		}
		return this.progress;
	}

	/** After switching views: whatever momentum follows belongs to the switch, not to a new pull. */
	block(now: number): void {
		this.accumulated = 0;
		this.armed = false;
		this.lastAt = now;
	}
}

/** Wheel delta in pixels, whatever unit the event uses. */
export function wheelPixels(event: WheelEvent, axis: 'x' | 'y'): number {
	const delta = axis === 'x' ? event.deltaX : event.deltaY;
	return event.deltaMode === 1 ? delta * 16 : event.deltaMode === 2 ? delta * 400 : delta;
}

// ===================================================================== shared agent helpers

/** The CSS colour of an agent (`--active-agent-N`). */
export function agentColor(agent: AgentInfo | undefined): string {
	return `var(--active-agent-${((agent?.colorIndex ?? 0) % AGENT_COLORS + AGENT_COLORS) % AGENT_COLORS})`;
}

/** The box an agent shows in: itself when top level, else the top-level agent it's nested under. */
export function topLevelOf(agent: AgentInfo, agents: readonly AgentInfo[]): AgentInfo {
	let current = agent;
	const seen = new Set<string>();
	while (!seen.has(current.id)) {
		seen.add(current.id);
		const parentId = nestedUnder(current);
		const parent = parentId ? agents.find(other => other.id === parentId) : undefined;
		if (!parent) {
			return current;
		}
		current = parent;
	}
	return current;
}

/** The agent this one shows nested under: Muse's subagents under their parent, merged agents under their target. */
/** A finished helper stays this long, then fades out over `HELPER_LEAVE_MS`. */
export const HELPER_LINGER_MS = 4000;
export const HELPER_LEAVE_MS = 450;

/**
 * Which agents the list and grid show: finished helpers go a few seconds after finishing (unless highlighted, or
 * the developer chose to keep them). `leaving` ones are mid-animation; `next` is when the next one changes state.
 */
export function shownAgents(agents: readonly AgentInfo[], highlightedId: string, showFinished: boolean, now = Date.now()): { shown: AgentInfo[]; leaving: Set<string>; next: number | undefined } {
	const leaving = new Set<string>();
	let next: number | undefined;
	const shown = agents.filter(agent => {
		if (agent.kind !== 'subagent' || !agent.finished || showFinished || agent.id === highlightedId) {
			return true;
		}
		const at = agent.finishedAt ?? 0;
		const leaveAt = at + HELPER_LINGER_MS;
		const goneAt = leaveAt + HELPER_LEAVE_MS;
		if (now >= goneAt) {
			return false;
		}
		if (now >= leaveAt) {
			leaving.add(agent.id);
		}
		const upcoming = now < leaveAt ? leaveAt : goneAt;
		next = next === undefined ? upcoming : Math.min(next, upcoming);
		return true;
	});
	return { shown, leaving, next };
}

/** Only agents merged into another show inside its box; subagents get boxes (and cards) of their own. */
export function nestedUnder(agent: AgentInfo): string | undefined {
	return agent.mergedInto;
}

const OVERLAP_GAP = 12;

/**
 * Pushes boxes that overlap `fixedId` (and then each other) down below what they collide with, keeping their size
 * and column, until nothing overlaps. `fixedId` stays where the developer put it.
 */
export function resolveOverlaps(rects: Record<string, GridRect>, fixedId: string): void {
	const overlaps = (a: GridRect, b: GridRect) => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
	const placed = [fixedId];
	const others = Object.keys(rects).filter(id => id !== fixedId).sort((a, b) => rects[a].y - rects[b].y || rects[a].x - rects[b].x);
	for (const id of others) {
		const rect = rects[id];
		for (let guard = 0; guard < 50; guard++) {
			const hit = placed.map(other => rects[other]).find(other => overlaps(rect, other));
			if (!hit) {
				break;
			}
			rects[id] = { ...rects[id], y: hit.y + hit.height + OVERLAP_GAP };
			Object.assign(rect, rects[id]);
		}
		placed.push(id);
	}
}

/** "Helper of Agent 2" for a subagent, when there's more than one top-level agent to tell apart (else it's just a peer). */
export function helperOf(agent: AgentInfo, agents: readonly AgentInfo[]): string | undefined {
	if (agent.kind !== 'subagent' || agents.filter(other => other.kind === 'agent' && !other.mergedInto).length < 2) {
		return undefined;
	}
	const parent = agents.find(other => other.id === agent.parentId);
	return parent ? localize('helperOf', "helper of {0}", parent.name) : undefined;
}

export type AgentStatusKind = 'approval' | 'running' | 'starting' | 'error' | 'merged' | 'finished' | 'idle' | 'unavailable';

export function agentStatus(agent: AgentInfo): AgentStatusKind {
	if (agent.mergedInto) {
		return 'merged';
	}
	if (agent.waitingForApproval) {
		return 'approval';
	}
	if (agent.finished) {
		return 'finished';
	}
	return agent.status === 'running' ? 'running' : agent.status === 'starting' ? 'starting' : agent.status === 'error' ? 'error' : agent.status === 'unavailable' ? 'unavailable' : 'idle';
}

/** `canApprove`: false for a viewer in someone's session, who sees that an approval is pending but can't answer it. */
export function agentStatusLabel(agent: AgentInfo, agents: readonly AgentInfo[], canApprove = true): string {
	switch (agentStatus(agent)) {
		case 'merged': return localize('agentMerged', "Merged into {0}", agents.find(other => other.id === agent.mergedInto)?.name ?? '');
		case 'approval': return canApprove ? localize('agentApproval', "Needs your approval") : localize('agentApprovalOther', "Waiting for approval");
		case 'finished': return localize('agentFinished', "Finished");
		case 'running': return localize('agentRunning', "Working");
		case 'starting': return localize('agentStarting', "Starting…");
		case 'error': return localize('agentError', "Error");
		case 'unavailable': return localize('agentUnavailable', "Unavailable");
		default: return agent.task ? localize('agentDone', "Done") : localize('agentReady', "Ready");
	}
}

/** One line on what an agent is up to, for list rows and nested boxes. */
export function agentOneLiner(agent: AgentInfo): string {
	return agent.activity || agent.reasoning || agent.task || '';
}

export interface OverlapMarker {
	readonly otherId: string;
	readonly conflict: boolean;
	readonly files: readonly string[];
}

/** The other agents that changed the same files as `agentId`. */
export function overlapMarkers(agentId: string, overlaps: readonly AgentOverlap[]): OverlapMarker[] {
	const markers: OverlapMarker[] = [];
	for (const overlap of overlaps) {
		const index = overlap.agents.indexOf(agentId);
		if (index < 0) {
			continue;
		}
		markers.push({ otherId: overlap.agents[1 - index], conflict: overlap.files.some(file => file.sameLines), files: overlap.files.map(file => file.path) });
	}
	// Likely conflicts first.
	return markers.sort((a, b) => Number(b.conflict) - Number(a.conflict));
}

export function formatCost(cost: number | undefined): string | undefined {
	return cost === undefined ? undefined : cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`;
}

/** Markdown reduced to readable plain text for a few lines in a box. */
export function plainText(markdown: string): string {
	return markdown
		.replace(/```[\s\S]*?(```|$)/g, ' [code] ')
		.replace(/`([^`]*)`/g, '$1')
		.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
		.replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
		// Bold and italics only with asterisks: underscores are too often part of names (snake_case, __init__).
		.replace(/\*\*(\S[^*]*?)\*\*|\*(\S[^*]*?)\*/g, (_, bold, italic) => bold ?? italic)
		.replace(/\s+/g, ' ')
		.trim();
}

const EXPLAIN_MODES: ReadonlyArray<{ id: ExplainMode; label: () => string; icon: ThemeIcon }> = [
	{ id: 'auto', label: () => localize('boxModeAuto', "Auto: explain as work finishes"), icon: Codicon.playCircle },
	{ id: 'away', label: () => localize('boxModeAway', "Away: hold walkthroughs for a briefing"), icon: Codicon.history },
	{ id: 'off', label: () => localize('boxModeOff', "Off: don't explain this agent's work"), icon: Codicon.circleSlash },
];

export function explainModeIcon(mode: ExplainMode): ThemeIcon {
	return EXPLAIN_MODES.find(entry => entry.id === mode)?.icon ?? Codicon.playCircle;
}

export function explainModeActions(service: IActiveService, agentId: string): SubmenuAction {
	const current = service.modeOf(agentId);
	return new SubmenuAction('active.agentMode', localize('boxModeMenu', "Explanations"), EXPLAIN_MODES.map(mode => toAction({
		id: `active.agentMode.${mode.id}`,
		label: mode.label(),
		checked: mode.id === current,
		run: () => service.setAgentMode(agentId, mode.id),
	})));
}

const APPROVAL_MODES: ReadonlyArray<{ readonly id: AgentApprovalMode; readonly label: () => string }> = [
	{ id: 'auto', label: () => localize('approvalAuto', "Auto: sandbox, the AI judge asks you when unsure") },
	{ id: 'ask', label: () => localize('approvalAsk', "Ask more: anything not already allowed") },
	{ id: 'allowAll', label: () => localize('approvalAllowAll', "Allow everything") },
];

export function approvalModeActions(service: IActiveService, agent: AgentInfo): SubmenuAction {
	return new SubmenuAction('active.agentApprovals', localize('boxApprovalMenu', "Approvals"), APPROVAL_MODES.map(mode => toAction({
		id: `active.agentApprovals.${mode.id}`,
		label: mode.label(),
		checked: mode.id === agent.approvalMode,
		run: () => service.setAgentApprovalMode(agent.id, mode.id),
	})));
}

// ===================================================================== the grid view

const LAYOUT_KEY = 'active.agentGrid.layout';
const PAD = 16;

interface StoredLayout {
	preset: GridPreset;
	overflow: boolean;
	custom: Record<string, GridRect>;
}

interface BoxSlot {
	readonly node: HTMLElement;
	readonly store: DisposableStore;
	/** Nested boxes inside, by agent id (FLIP needs their rects). */
	readonly nested: Map<string, HTMLElement>;
}

export interface AgentGridHost {
	/** Open an agent full screen (double-click, Enter, or pulling up at the top). */
	open(agentId: string): void;
	/** The layout preset or overflow changed: the top bar shows them. */
	layoutChanged(): void;
}

interface DragState {
	readonly id: string;
	readonly mode: 'move' | 'resize';
	readonly pointerId: number;
	readonly startX: number;
	readonly startY: number;
	/** The box's rect when the drag started, in unscaled custom units. */
	readonly origin: GridRect;
	started: boolean;
	current: GridRect;
	target?: { kind: 'merge' | 'swap'; id: string };
	/** The layout before the drag made it Custom: a drag that ends in a merge puts it back. */
	before?: StoredLayout;
	/** The grid's horizontal scroll when the drag began (it auto-scrolls near the edges). */
	startScroll?: number;
	/** The last pointer event, replayed while auto-scrolling. */
	last?: PointerEvent;
}

/** How close to the grid's left or right edge a drag starts scrolling it, and how fast (px per frame at the edge). */
const AUTO_SCROLL_EDGE = 56;
const AUTO_SCROLL_SPEED = 18;

/**
 * All agents at once: one box per top-level agent with a live tail of what it's doing, nested boxes for its
 * subagents (and agents merged into it). Boxes can be moved, resized, swapped and dropped onto each other to merge.
 */
export class AgentGridView extends Disposable {
	readonly element: HTMLElement;
	private readonly briefing: HTMLElement;
	private readonly viewport: HTMLElement;
	private readonly canvas: HTMLElement;
	private readonly pull: HTMLElement;
	private readonly pullLabel: HTMLElement;
	private readonly edgeLeft: HTMLElement;
	private readonly edgeRight: HTMLElement;
	private readonly empty: HTMLElement;
	private readonly slots = new Map<string, BoxSlot>();
	private readonly briefingStore = this._register(new DisposableStore());
	private readonly dirty = new Set<string>();
	private renderAll = false;
	private frame: { dispose(): void } | undefined;
	private readonly pulsing = new Set<string>();
	private layoutState: StoredLayout;
	private current: GridLayout | undefined;
	private visible = false;
	private drag: DragState | undefined;
	private readonly gesture = new OverscrollGesture();
	private pullTimer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		parent: HTMLElement,
		private readonly host: AgentGridHost,
		@IActiveService private readonly activeService: IActiveService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IDialogService private readonly dialogService: IDialogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IStorageService private readonly storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this.layoutState = this.loadLayout();
		this.element = dom.append(parent, $('.active-agent-grid'));
		this.element.setAttribute('aria-label', localize('gridLabel', "All agents"));
		this.briefing = dom.append(this.element, $('.agent-grid-briefing.hidden'));
		this.viewport = dom.append(this.element, $('.agent-grid-viewport'));
		this.viewport.tabIndex = 0;
		this.viewport.setAttribute('role', 'listbox');
		this.canvas = dom.append(this.viewport, $('.agent-grid-canvas'));
		this.empty = dom.append(this.element, $('.agent-grid-empty.hidden'));
		this.edgeLeft = dom.append(this.element, $('button.agent-grid-edge.left.hidden'));
		this.edgeRight = dom.append(this.element, $('button.agent-grid-edge.right.hidden'));
		this.pull = dom.append(this.element, $('.active-agent-pull.top'));
		this.pull.setAttribute('aria-hidden', 'true');
		dom.append(this.pull, $('span.pull-icon')).classList.add(...ThemeIcon.asClassNameArray(Codicon.screenFull));
		this.pullLabel = dom.append(this.pull, $('span.pull-label'));
		dom.append(dom.append(this.pull, $('.pull-track')), $('.pull-bar'));

		this._register(this.activeService.onDidChangeAgents(() => this.schedule()));
		this._register({ dispose: () => clearTimeout(this.helperTimer) });
		this._register(this.activeService.onDidChangeHighlight(() => this.schedule()));
		this._register(this.activeService.onDidChangeAgentChat(({ agentId }) => this.schedule(this.boxIdOf(agentId))));
		this._register(this.activeService.onDidChangeAllBriefing(() => this.renderBriefing()));
		this._register(this.activeService.onDidReceiveWalkthrough(({ agentId }) => {
			// The badge pulses once, on arrival only (not on every later re-render).
			this.pulsing.add(agentId);
			setTimeout(() => this.pulsing.delete(agentId), 1600);
			this.schedule();
		}));
		this._register(dom.addDisposableListener(this.viewport, dom.EventType.SCROLL, () => this.updateEdges()));
		this._register(dom.addDisposableListener(this.viewport, 'wheel', (event: WheelEvent) => this.onWheel(event), { passive: false }));
		this._register(dom.addDisposableListener(this.viewport, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => this.onKey(event)));
		this._register(dom.addDisposableListener(this.edgeLeft, dom.EventType.CLICK, () => this.viewport.scrollBy({ left: -this.viewport.clientWidth * 0.8, behavior: 'smooth' })));
		this._register(dom.addDisposableListener(this.edgeRight, dom.EventType.CLICK, () => this.viewport.scrollBy({ left: this.viewport.clientWidth * 0.8, behavior: 'smooth' })));
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.POINTER_MOVE, (event: PointerEvent) => this.onPointerMove(event)));
		this._register(dom.addDisposableListener(this.canvas, dom.EventType.POINTER_UP, (event: PointerEvent) => this.onPointerUp(event)));
		this._register({ dispose: () => clearInterval(this.autoScrollTimer) });
		this._register(dom.addDisposableListener(this.canvas, 'pointercancel', (event: PointerEvent) => this.cancelDrag(event)));
		this._register(toDisposable(() => {
			this.frame?.dispose();
			if (this.pullTimer !== undefined) {
				clearTimeout(this.pullTimer);
			}
			for (const slot of this.slots.values()) {
				slot.store.dispose();
			}
		}));
	}

	// ----------------------------------------------------------------- state

	get preset(): GridPreset { return this.layoutState.preset; }
	get overflow(): boolean { return this.layoutState.overflow; }
	get hasCustom(): boolean { return Object.keys(this.layoutState.custom).length > 0; }

	setPreset(preset: GridPreset): void {
		if (preset === 'custom' && !this.hasCustom) {
			return;
		}
		this.layoutState.preset = preset;
		this.saveLayout();
		this.relayout(true);
		this.host.layoutChanged();
	}

	setOverflow(overflow: boolean): void {
		this.layoutState.overflow = overflow;
		this.saveLayout();
		this.relayout(true);
		this.host.layoutChanged();
	}

	private loadLayout(): StoredLayout {
		const fallback: StoredLayout = { preset: 'auto', overflow: false, custom: {} };
		try {
			const stored = JSON.parse(this.storageService.get(LAYOUT_KEY, StorageScope.WORKSPACE, 'null')) as Partial<StoredLayout> | null;
			if (!stored) {
				return fallback;
			}
			return {
				preset: GRID_PRESETS.includes(stored.preset as GridPreset) ? stored.preset as GridPreset : 'auto',
				overflow: !!stored.overflow,
				custom: stored.custom && typeof stored.custom === 'object' ? stored.custom : {},
			};
		} catch {
			return fallback;
		}
	}

	private saveLayout(): void {
		// Forget places of agents that are gone, so the stored layout doesn't grow forever.
		const known = new Set(this.activeService.agents.map(agent => agent.id));
		for (const id of Object.keys(this.layoutState.custom)) {
			if (!known.has(id)) {
				delete this.layoutState.custom[id];
			}
		}
		this.storageService.store(LAYOUT_KEY, JSON.stringify(this.layoutState), StorageScope.WORKSPACE, StorageTarget.MACHINE);
	}

	// ----------------------------------------------------------------- showing

	show(): void {
		this.visible = true;
		this.element.classList.add('visible');
		this.gesture.block(Date.now());
		this.renderBriefing();
		this.renderAll = true;
		// No entrance or layout animations here: the zoom animates the boxes in.
		this.renderNow(false);
	}

	hide(): void {
		this.visible = false;
		this.element.classList.remove('visible');
		this.setPull(0);
	}

	focus(): void {
		this.viewport.focus({ preventScroll: true });
	}

	/** The all-agents Catch Me Up above the grid, while it shows. */
	get briefingElement(): HTMLElement | undefined {
		return this.briefing.classList.contains('hidden') ? undefined : this.briefing;
	}

	/** The highlighted agent's box (or nested box) on screen, for the zoom animation. */
	focusElement(): HTMLElement | undefined {
		const id = this.activeService.highlightedAgentId;
		const box = this.slots.get(this.boxIdOf(id) ?? '');
		return box?.nested.get(id) ?? box?.node;
	}

	/** Every box but the one zooming, for fading in and out around it. */
	otherElements(): HTMLElement[] {
		const focusBox = this.slots.get(this.boxIdOf(this.activeService.highlightedAgentId) ?? '')?.node;
		return [...this.slots.values()].map(slot => slot.node).filter(node => node !== focusBox);
	}

	/** Brings the highlighted box into view (overflow on) before zooming to it. */
	revealFocus(): void {
		const box = this.current?.rects.get(this.boxIdOf(this.activeService.highlightedAgentId) ?? '');
		if (!box) {
			return;
		}
		const left = box.x + PAD;
		if (left < this.viewport.scrollLeft || left + box.width > this.viewport.scrollLeft + this.viewport.clientWidth) {
			this.viewport.scrollLeft = Math.max(0, left - (this.viewport.clientWidth - box.width) / 2);
		}
		const top = box.y + PAD;
		if (top < this.viewport.scrollTop || top + box.height > this.viewport.scrollTop + this.viewport.clientHeight) {
			this.viewport.scrollTop = Math.max(0, top - PAD);
		}
	}

	layout(): void {
		if (this.visible) {
			this.relayout(false);
		}
	}

	/** The top-level box an agent shows in. */
	private boxIdOf(agentId: string): string | undefined {
		const agent = this.activeService.agentInfo(agentId);
		return agent ? topLevelOf(agent, this.activeService.agents).id : undefined;
	}

	private helperTimer: ReturnType<typeof setTimeout> | undefined;
	private leaving = new Set<string>();

	private topLevel(): AgentInfo[] {
		const { shown, leaving, next } = shownAgents(this.activeService.agents, this.activeService.highlightedAgentId, this.activeService.showFinishedHelpers);
		this.leaving = leaving;
		// Re-render when the next finished helper starts or finishes fading out.
		clearTimeout(this.helperTimer);
		if (next !== undefined) {
			this.helperTimer = setTimeout(() => this.schedule(), Math.max(0, next - Date.now()) + 16);
		}
		return shown.filter(agent => !nestedUnder(agent) || !this.activeService.agentInfo(nestedUnder(agent)!));
	}

	private schedule(boxId?: string): void {
		if (boxId) {
			this.dirty.add(boxId);
		} else {
			this.renderAll = true;
		}
		if (!this.visible || this.frame) {
			return;
		}
		// Streaming text changes chat many times a second: render each box at most once a frame.
		this.frame = dom.scheduleAtNextAnimationFrame(dom.getWindow(this.element), () => {
			this.frame = undefined;
			this.renderNow();
		});
	}

	private renderNow(animate = true): void {
		const all = this.renderAll;
		this.renderAll = false;
		const dirty = [...this.dirty];
		this.dirty.clear();
		const agents = this.topLevel();
		const ids = new Set(agents.map(agent => agent.id));
		let structural = false;
		for (const [id, slot] of this.slots) {
			if (!ids.has(id)) {
				slot.store.dispose();
				slot.node.remove();
				this.slots.delete(id);
				structural = true;
			}
		}
		for (const agent of agents) {
			let slot = this.slots.get(agent.id);
			if (!slot) {
				slot = { node: dom.append(this.canvas, $('.agent-box')), store: new DisposableStore(), nested: new Map() };
				const node = slot.node;
				if (animate) {
					// A new agent scales in where it lands.
					node.classList.add('entering');
					node.addEventListener('animationend', () => node.classList.remove('entering'), { once: true });
				}
				this.slots.set(agent.id, slot);
				this.wireBox(agent.id, slot);
				structural = true;
			}
			if (all || structural || dirty.includes(agent.id)) {
				this.renderBox(agent, slot);
			}
		}
		this.empty.classList.toggle('hidden', agents.length > 0);
		this.empty.textContent = localize('gridEmpty', "Agents appear once connected.");
		if (all || structural) {
			this.relayout(animate);
		}
	}

	private relayout(animate: boolean): void {
		if (!this.visible) {
			return;
		}
		const ids = this.topLevel().map(agent => agent.id);
		const width = this.viewport.clientWidth - PAD * 2;
		const height = this.viewport.clientHeight - PAD * 2;
		if (width <= 0 || height <= 0) {
			return;
		}
		const layout = this.current = computeGridLayout({
			ids,
			preset: this.layoutState.preset,
			width,
			height,
			overflow: this.layoutState.overflow,
			focusId: this.boxIdOf(this.activeService.highlightedAgentId),
			custom: this.layoutState.custom,
		});
		this.canvas.style.width = `${layout.width + PAD * 2}px`;
		this.canvas.style.height = `${layout.height + PAD * 2}px`;
		this.canvas.classList.toggle('animate', animate);
		for (const [id, box] of layout.rects) {
			const node = this.slots.get(id)?.node;
			if (node && this.drag?.id !== id) {
				applyRect(node, box);
			}
		}
		this.element.classList.toggle('overflow', this.layoutState.overflow);
		this.updateEdges();
	}

	private updateEdges(): void {
		const layout = this.current;
		if (!layout || !this.layoutState.overflow) {
			this.edgeLeft.classList.add('hidden');
			this.edgeRight.classList.add('hidden');
			return;
		}
		const left = this.viewport.scrollLeft;
		const right = left + this.viewport.clientWidth;
		let before = 0;
		let after = 0;
		for (const box of layout.rects.values()) {
			if (box.x + PAD + box.width / 2 < left) {
				before++;
			} else if (box.x + PAD + box.width / 2 > right) {
				after++;
			}
		}
		const edge = (node: HTMLElement, count: number, label: string) => {
			node.classList.toggle('hidden', count === 0);
			node.textContent = '';
			if (count) {
				dom.append(node, $('span')).classList.add(...ThemeIcon.asClassNameArray(node === this.edgeLeft ? Codicon.chevronLeft : Codicon.chevronRight));
				dom.append(node, $('span.count')).textContent = String(count);
				node.title = label;
			}
		};
		edge(this.edgeLeft, before, localize('edgeLeft', "{0} more to the left (Shift + scroll)", before));
		edge(this.edgeRight, after, localize('edgeRight', "{0} more to the right (Shift + scroll)", after));
	}

	// ----------------------------------------------------------------- briefing

	/** The all-agents Catch Me Up, above the grid, grouped by agent. */
	private renderBriefing(): void {
		this.briefingStore.clear();
		dom.clearNode(this.briefing);
		const state = this.activeService.allBriefing;
		this.briefing.classList.toggle('hidden', !state);
		if (!state) {
			this.layout();
			return;
		}
		const head = dom.append(this.briefing, $('.briefing-head'));
		dom.append(head, $('.eyebrow')).textContent = localize('allBriefingEyebrow', "Catch me up · all agents");
		const title = dom.append(head, $('.briefing-title'));
		if (state.status === 'loading' || !state.briefing) {
			const spinner = dom.append(title, $('span'));
			spinner.classList.add(...ThemeIcon.asClassNameArray(Codicon.loading), 'codicon-modifier-spin');
			dom.append(title, $('span')).textContent = localize('allBriefingLoading', "Catching you up on every agent…");
		} else {
			title.textContent = state.briefing.headline;
		}
		const dismiss = dom.append(head, $('button.briefing-dismiss')) as HTMLButtonElement;
		dismiss.textContent = localize('allBriefingDismiss', "Got It");
		this.briefingStore.add(dom.addDisposableListener(dismiss, dom.EventType.CLICK, () => this.activeService.dismissAllBriefing()));
		const body = dom.append(this.briefing, $('.briefing-body'));
		const briefing = state.briefing;
		if (briefing) {
			const section = (label: string, items: readonly string[], kind: string) => {
				if (!items.length) {
					return;
				}
				const block = dom.append(body, $(`.briefing-section.${kind}`));
				dom.append(block, $('.briefing-label')).textContent = label;
				const list = dom.append(block, $('ul'));
				for (const item of items) {
					dom.append(list, $('li')).textContent = item;
				}
			};
			section(localize('allNeedsYou', "Needs you"), briefing.attention, 'attention');
			section(localize('allDone', "Done"), briefing.done, 'done');
			section(localize('allProblems', "Unresolved"), briefing.problems, 'problems');
			if (briefing.next) {
				section(localize('allNext', "Next"), [briefing.next], 'next');
			}
		}
		// The walkthroughs, grouped under the agent whose work they explain.
		const groups = new Map<string, typeof state.items[number][]>();
		for (const item of state.items) {
			const key = item.agentId ?? '';
			groups.set(key, [...(groups.get(key) ?? []), item]);
		}
		if (groups.size) {
			const walkthroughs = dom.append(body, $('.briefing-agents'));
			for (const [agentId, items] of groups) {
				const agent = this.activeService.agentInfo(agentId);
				const group = dom.append(walkthroughs, $('.briefing-agent'));
				group.style.setProperty('--agent-color', agentColor(agent));
				dom.append(group, $('.briefing-agent-name')).textContent = agent?.name ?? localize('earlierAgent', "Earlier work");
				for (const item of items) {
					const row = dom.append(group, $('button.briefing-walkthrough')) as HTMLButtonElement;
					dom.append(row, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.playCircle));
					dom.append(row, $('span')).textContent = item.chapter ? localize('allChapter', "Chapter {0}: {1}", item.chapter, item.title) : item.title;
					row.title = item.task;
					this.briefingStore.add(dom.addDisposableListener(row, dom.EventType.CLICK, () => this.activeService.playBriefing(item.recordId)));
				}
			}
		}
		this.layout();
	}

	// ----------------------------------------------------------------- boxes

	/** Listeners that live as long as the box (the contents re-render; the box itself stays for its position). */
	private wireBox(id: string, slot: BoxSlot): void {
		const node = slot.node;
		node.setAttribute('role', 'option');
		this._register(dom.addDisposableListener(node, dom.EventType.POINTER_DOWN, (event: PointerEvent) => this.onPointerDown(event, id)));
		this._register(dom.addDisposableListener(node, dom.EventType.DBLCLICK, (event: MouseEvent) => {
			if (!isInteractive(event.target)) {
				this.host.open(this.nestedIdAt(event.target, slot) ?? id);
			}
		}));
		this._register(dom.addDisposableListener(node, dom.EventType.CLICK, (event: MouseEvent) => {
			if (!isInteractive(event.target)) {
				this.activeService.highlightAgent(this.nestedIdAt(event.target, slot) ?? id);
			}
		}));
	}

	private nestedIdAt(target: EventTarget | null, slot: BoxSlot): string | undefined {
		for (const [nestedId, element] of slot.nested) {
			if (target instanceof Node && element.contains(target)) {
				return nestedId;
			}
		}
		return undefined;
	}

	private renderBox(agent: AgentInfo, slot: BoxSlot): void {
		const node = slot.node;
		const store = slot.store;
		store.clear();
		slot.nested.clear();
		dom.clearNode(node);
		const agents = this.activeService.agents;
		const highlighted = this.activeService.highlightedAgentId;
		const status = agentStatus(agent);
		node.style.setProperty('--agent-color', agentColor(agent));
		node.classList.toggle('highlighted', highlighted === agent.id);
		node.classList.toggle('contains-highlight', highlighted !== agent.id && this.boxIdOf(highlighted) === agent.id);
		node.dataset.status = status;
		node.classList.toggle('leaving', this.leaving.has(agent.id));
		node.setAttribute('aria-selected', String(highlighted === agent.id));
		node.setAttribute('aria-label', localize('boxAria', "{0}: {1}", agent.name, agentStatusLabel(agent, agents, this.activeService.canApprove)));

		// Header: the handle for moving the box, with name, status and the box's menu.
		const header = dom.append(node, $('.agent-box-header'));
		dom.append(header, $('span.agent-dot'));
		dom.append(header, $('span.agent-name')).textContent = agent.name;
		const chip = dom.append(header, $(`span.agent-status-chip.${status}`));
		if (status === 'running' || status === 'starting') {
			chip.classList.add('live');
		}
		chip.textContent = agentStatusLabel(agent, agents, this.activeService.canApprove);
		const helper = helperOf(agent, agents);
		if (helper) {
			dom.append(header, $('span.agent-helper-tag')).textContent = helper;
		}
		renderPresenceBadges(header, this.activeService, agent.id);
		const actions = dom.append(header, $('.agent-box-actions'));
		// Subagents' work is explained as part of their parent's: no explanation mode of their own. Guests get no explanations.
		if (agent.kind === 'agent' && !this.activeService.remote) {
			const mode = this.activeService.modeOf(agent.id);
			const modeButton = this.iconButton(actions, explainModeIcon(mode), localize('boxModeTitle', "Explanations for {0}: {1}. Click to change.", agent.name, mode === 'auto' ? localize('modeAutoShort', "Auto") : mode === 'away' ? localize('modeAwayShort', "Away") : localize('modeOffShort', "Off")), store, () => {
				this.contextMenuService.showContextMenu({ getAnchor: () => modeButton, getActions: () => explainModeActions(this.activeService, agent.id).actions });
			});
			modeButton.classList.add('mode', mode);
		}
		const more = this.iconButton(actions, Codicon.ellipsis, localize('boxMore', "More actions for {0}", agent.name), store, () => this.showBoxMenu(agent, more));

		// Meta: branch, spend, badges.
		const meta = dom.append(node, $('.agent-box-meta'));
		// Anything but the default approval mode is worth seeing at a glance.
		if (agent.kind === 'agent' && agent.approvalMode !== 'auto') {
			const approvals = dom.append(meta, $(`span.agent-approval-mode.${agent.approvalMode}`));
			approvals.textContent = agent.approvalMode === 'allowAll' ? localize('approvalChipAll', "Allows everything") : localize('approvalChipAsk', "Asks more");
		}
		if (agent.branch) {
			const branch = dom.append(meta, $('span.agent-branch'));
			dom.append(branch, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.gitBranch));
			dom.append(branch, $('span')).textContent = agent.branch;
			branch.title = agent.branch;
		}
		const cost = formatCost(agent.cost);
		if (cost) {
			const spend = dom.append(meta, $('span.agent-cost'));
			spend.textContent = cost;
			spend.title = agent.costBreakdown
				? localize('costBreakdownTitle', "Estimated spend so far: {0} coding, {1} explanations", formatCost(agent.costBreakdown.coding) ?? '$0', formatCost(agent.costBreakdown.explanations) ?? '$0')
				: localize('costTitle', "Estimated spend so far");
		}
		this.renderBadges(meta, agent, store);

		// Body: the reasoning summary, then the latest of the conversation, newest at the bottom.
		const body = dom.append(node, $('.agent-box-body'));
		if (agent.reasoning && status === 'running') {
			const reasoning = dom.append(body, $('.agent-box-reasoning'));
			dom.append(reasoning, $('span.icon')).classList.add(...ThemeIcon.asClassNameArray(Codicon.lightbulb));
			dom.append(reasoning, $('span.text')).textContent = agent.reasoning;
		}
		const tail = dom.append(body, $('.agent-box-tail'));
		const chat = this.activeService.chatOf(agent.id);
		this.renderTail(tail, chat, agent);

		if (agent.todo?.length) {
			const done = agent.todo.filter(item => item.status === 'done').length;
			const doing = agent.todo.find(item => item.status === 'inProgress');
			const todo = dom.append(node, $('.agent-box-todo'));
			const bar = dom.append(todo, $('.todo-track'));
			dom.append(bar, $('.todo-bar')).style.width = `${(done / agent.todo.length) * 100}%`;
			const label = dom.append(todo, $('.todo-label'));
			dom.append(label, $('span.count')).textContent = `${done}/${agent.todo.length}`;
			dom.append(label, $('span.item')).textContent = doing?.text ?? (done === agent.todo.length ? localize('todoAllDone', "Plan complete") : agent.todo.find(item => item.status === 'pending')?.text ?? '');
			todo.title = agent.todo.map(item => `${item.status === 'done' ? '✓' : item.status === 'inProgress' ? '▸' : '·'} ${item.text}`).join('\n');
		}

		// An approval is answerable right here.
		const approval = agent.waitingForApproval ? [...chat].reverse().find(entry => entry.role === 'approval' && entry.approval && !entry.approval.resolved) : undefined;
		if (approval?.approval) {
			const card = dom.append(node, $('.agent-box-approval'));
			dom.append(card, $('.approval-title')).textContent = approval.approval.title;
			if (approval.approval.detail) {
				const detail = dom.append(card, $('.approval-detail'));
				detail.textContent = approval.approval.detail;
				detail.title = approval.approval.detail;
			}
			const buttons = dom.append(card, $('.approval-actions'));
			if (!this.activeService.canApprove) {
				dom.append(buttons, $('span.approval-waiting')).textContent = localize('approvalWaitingHost', "Waiting for the host or a collaborator");
			}
			for (const choice of this.activeService.canApprove ? approval.approval.choices : []) {
				const button = dom.append(buttons, $(`button.${choice.approves ? 'primary' : 'secondary'}`)) as HTMLButtonElement;
				button.textContent = choice.label;
				const approvalId = approval.approval.approvalId;
				store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.activeService.decideApprovalFor(agent.id, approvalId, choice.choiceId)));
			}
		}

		// Its subagents, and agents merged into it, as small boxes underneath.
		const nested = agents.filter(other => other.id !== agent.id && topLevelOf(other, agents).id === agent.id);
		if (nested.length) {
			const strip = dom.append(node, $('.agent-box-nested'));
			for (const child of nested) {
				const mini = dom.append(strip, $('.agent-mini'));
				const childStatus = agentStatus(child);
				mini.dataset.status = childStatus;
				mini.style.setProperty('--agent-color', agentColor(child.mergedInto ? child : agent));
				mini.classList.toggle('highlighted', highlighted === child.id);
				mini.classList.toggle('merged', !!child.mergedInto);
				const top = dom.append(mini, $('.mini-head'));
				dom.append(top, $('span.agent-dot'));
				dom.append(top, $('span.mini-name')).textContent = child.name;
				if (child.readOnly || child.kind === 'subagent') {
					dom.append(top, $('span.mini-tag')).textContent = child.mergedInto ? localize('miniMerged', "merged") : localize('miniSubagent', "subagent · read-only");
				} else if (child.mergedInto) {
					dom.append(top, $('span.mini-tag')).textContent = localize('miniMerged', "merged");
				}
				dom.append(mini, $('.mini-line')).textContent = child.mergedInto ? localize('miniMergedLine', "Its work was merged in here") : agentOneLiner(child) || agentStatusLabel(child, agents);
				mini.title = localize('miniTitle', "{0} · {1}\nClick to view, double-click to open.", child.name, agentStatusLabel(child, agents));
				slot.nested.set(child.id, mini);
			}
		}

		dom.append(node, $('.agent-box-resize')).title = localize('resizeBox', "Drag to resize");
	}

	private renderBadges(parent: HTMLElement, agent: AgentInfo, store: DisposableStore): void {
		const ready = this.activeService.readyWalkthroughs(agent.id);
		if (ready.length) {
			const badge = dom.append(parent, $('button.agent-ready-badge')) as HTMLButtonElement;
			dom.append(badge, $('span')).classList.add(...ThemeIcon.asClassNameArray(Codicon.playCircle));
			dom.append(badge, $('span')).textContent = ready.length === 1 ? localize('readyOne', "Walkthrough ready") : localize('readyMany', "{0} walkthroughs ready", ready.length);
			badge.title = ready.map(walkthrough => walkthrough.title).join('\n');
			badge.classList.toggle('pulse', this.pulsing.has(agent.id));
			store.add(dom.addDisposableListener(badge, dom.EventType.CLICK, () => this.activeService.playReady(agent.id)));
		}
		for (const marker of overlapMarkers(agent.id, this.activeService.overlaps)) {
			const other = this.activeService.agentInfo(marker.otherId);
			const button = dom.append(parent, $(`button.agent-overlap${marker.conflict ? '.conflict' : ''}`)) as HTMLButtonElement;
			button.style.setProperty('--other-color', agentColor(other));
			dom.append(button, $('span')).classList.add(...ThemeIcon.asClassNameArray(marker.conflict ? Codicon.warning : Codicon.gitCompare));
			dom.append(button, $('span')).textContent = marker.conflict
				? localize('overlapConflict', "Likely conflict with {0}", other?.name ?? marker.otherId)
				: localize('overlapMild', "Also changed by {0}", other?.name ?? marker.otherId);
			button.title = `${marker.conflict ? localize('overlapConflictTitle', "Both changed the same lines in:") : localize('overlapMildTitle', "Both changed:")}\n${marker.files.join('\n')}`;
			store.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => this.openOverlap(agent.id, marker.files, button)));
		}
	}

	/** Opens a shared file from this agent's worktree (one file directly, several from a menu). */
	private openOverlap(agentId: string, files: readonly string[], anchor: HTMLElement): void {
		const open = (path: string) => {
			this.activeService.highlightAgent(agentId);
			const resource = this.activeService.resolveAgentPath(path, agentId);
			if (resource) {
				void this.editorService.openEditor({ resource, options: { pinned: false } });
			}
		};
		if (files.length === 1) {
			open(files[0]);
			return;
		}
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => files.map(path => toAction({ id: `active.overlap.${path}`, label: path, run: () => open(path) })),
		});
	}

	private renderTail(tail: HTMLElement, chat: readonly ChatEntry[], agent: AgentInfo): void {
		// As much of its own chat as fits: the box shows the newest at the bottom and clips (fading) at the top.
		const shown: ChatEntry[] = [];
		for (let index = chat.length - 1; index >= 0 && shown.length < 60; index--) {
			const entry = chat[index];
			if (entry.role !== 'tool' && entry.role !== 'agent' && entry.role !== 'user' && entry.role !== 'system' && entry.role !== 'explainer') {
				continue;
			}
			shown.unshift(entry);
		}
		if (!shown.length) {
			dom.append(tail, $('.tail-empty')).textContent = agent.task ? agent.task : localize('tailEmpty', "Nothing yet.");
			return;
		}
		for (const entry of shown) {
			switch (entry.role) {
				case 'user': {
					const row = dom.append(tail, $('.tail-user'));
					row.textContent = entry.text;
					break;
				}
				case 'explainer':
				case 'agent': {
					const row = dom.append(tail, $(entry.role === 'explainer' ? '.tail-agent.tail-explainer' : '.tail-agent'));
					const text = plainText(entry.text);
					if (text) {
						row.textContent = text;
					} else if (entry.status === 'streaming') {
						const dots = dom.append(row, $('span.active-typing-dots'));
						for (let index = 0; index < 3; index++) {
							dom.append(dots, $('span'));
						}
					}
					break;
				}
				case 'tool': {
					const row = dom.append(tail, $('.tail-tool'));
					const settled = entry.status === 'completed' || entry.status === 'background' || TAIL_TOOL_FAILED.includes(entry.status ?? '');
					const icon = dom.append(row, $('span.icon'));
					icon.classList.add(...ThemeIcon.asClassNameArray(entry.status === 'completed' ? Codicon.check : TAIL_TOOL_FAILED.includes(entry.status ?? '') ? Codicon.error : entry.status === 'background' ? Codicon.clock : Codicon.loading));
					if (!settled) {
						icon.classList.add('codicon-modifier-spin');
					}
					dom.append(row, $('span.text')).textContent = entry.text;
					break;
				}
				default:
					dom.append(tail, $('.tail-system')).textContent = entry.text;
			}
		}
	}

	private iconButton(parent: HTMLElement, icon: ThemeIcon, title: string, store: DisposableStore, run: () => void): HTMLButtonElement {
		const button = dom.append(parent, $('button.agent-box-icon')) as HTMLButtonElement;
		button.classList.add(...ThemeIcon.asClassNameArray(icon));
		button.title = title;
		button.setAttribute('aria-label', title);
		store.add(dom.addDisposableListener(button, dom.EventType.CLICK, event => {
			event.stopPropagation();
			run();
		}));
		return button;
	}

	private showBoxMenu(agent: AgentInfo, anchor: HTMLElement): void {
		const running = agent.status === 'running';
		// A guest can only look: stopping, renaming, modes, merging and closing are the host's.
		if (this.activeService.remote) {
			this.contextMenuService.showContextMenu({
				getAnchor: () => anchor,
				getActions: () => [toAction({ id: 'active.agentBox.open', label: localize('boxOpen', "Open Full Screen"), run: () => this.host.open(agent.id) })],
			});
			return;
		}
		if (agent.kind === 'subagent') {
			this.contextMenuService.showContextMenu({
				getAnchor: () => anchor,
				getActions: () => [
					toAction({ id: 'active.agentBox.open', label: localize('boxOpen', "Open Full Screen"), run: () => this.host.open(agent.id) }),
					toAction({ id: 'active.agentBox.stop', label: localize('boxStop', "Stop"), enabled: running, run: () => this.activeService.interruptAgent(agent.id) }),
				],
			});
			return;
		}
		this.contextMenuService.showContextMenu({
			getAnchor: () => anchor,
			getActions: () => [
				toAction({ id: 'active.agentBox.open', label: localize('boxOpen', "Open Full Screen"), run: () => this.host.open(agent.id) }),
				toAction({ id: 'active.agentBox.rename', label: localize('boxRename', "Rename…"), run: () => this.rename(agent) }),
				explainModeActions(this.activeService, agent.id),
				approvalModeActions(this.activeService, agent),
				new Separator(),
				toAction({ id: 'active.agentBox.stop', label: localize('boxStop', "Stop"), enabled: running, run: () => this.activeService.interruptAgent(agent.id) }),
				// The agent in the developer's own folder can't be closed (there'd be no worktree to remove).
				...(agent.inMainFolder ? [] : [toAction({ id: 'active.agentBox.close', label: localize('boxClose', "Close Agent…"), run: () => this.close(agent) })]),
			],
		});
	}

	private async rename(agent: AgentInfo): Promise<void> {
		const name = await this.quickInputService.input({ value: agent.name, prompt: localize('renamePrompt', "A name for this agent") });
		if (name?.trim() && name.trim() !== agent.name) {
			await this.activeService.renameAgent(agent.id, name.trim());
		}
	}

	private async close(agent: AgentInfo): Promise<void> {
		const { result: choice } = await this.dialogService.prompt<'keep' | 'close' | undefined>({
			message: localize('closeConfirm', "Close {0}?", agent.name),
			detail: [
				localize('closeKeepDetail', "Commit and close: commits {0}'s work on its branch (kept).", agent.name),
				localize('closeJustDetail', "Just close: deletes its worktree and branch; unmerged work is lost."),
			].join('\n'),
			buttons: [
				{ label: localize('closeKeepButton', "&&Commit and Close"), run: () => 'keep' },
				{ label: localize('closeJustButton', "&&Just Close"), run: () => 'close' },
			],
			cancelButton: { label: localize('closeCancel', "Cancel"), run: () => undefined },
		});
		if (choice) {
			await this.activeService.closeAgent(agent.id, { keep: choice === 'keep' });
		}
	}

	// ----------------------------------------------------------------- moving, resizing, merging

	private onPointerDown(event: PointerEvent, id: string): void {
		if (event.button !== 0 || !this.current) {
			return;
		}
		const target = event.target as HTMLElement;
		const resize = target.classList.contains('agent-box-resize');
		// Only the header moves a box, so text in it can still be selected; buttons stay buttons.
		if (!resize && (isInteractive(target) || !dom.findParentWithClass(target, 'agent-box-header'))) {
			return;
		}
		const shown = this.current.rects.get(id);
		if (!shown) {
			return;
		}
		const scale = this.layoutState.preset === 'custom' ? this.current.scale : 1;
		this.drag = {
			id,
			mode: resize ? 'resize' : 'move',
			pointerId: event.pointerId,
			startX: event.clientX,
			startY: event.clientY,
			origin: { x: shown.x / scale, y: shown.y / scale, width: shown.width / scale, height: shown.height / scale },
			started: false,
			current: shown,
		};
		// Pointer capture waits until it's really a drag: capturing now would retarget a plain click to the canvas.
		event.preventDefault();
	}

	private onPointerMove(event: PointerEvent): void {
		const drag = this.drag;
		if (!drag || event.pointerId !== drag.pointerId || !this.current) {
			return;
		}
		drag.last = event;
		drag.startScroll ??= this.viewport.scrollLeft;
		// The canvas moves under the pointer when the grid scrolls: count that as movement too.
		const dx = event.clientX - drag.startX + (this.viewport.scrollLeft - drag.startScroll);
		const dy = event.clientY - drag.startY;
		if (!drag.started) {
			if (Math.hypot(dx, dy) < 4) {
				return;
			}
			drag.started = true;
			this.startAutoScroll();
			this.canvas.setPointerCapture(drag.pointerId);
			drag.before = this.layoutState;
			this.toCustom();
			this.slots.get(drag.id)?.node.classList.add(drag.mode === 'move' ? 'dragging' : 'resizing');
			this.canvas.classList.remove('animate');
			this.element.classList.add('arranging');
		}
		const scale = this.current.scale;
		const node = this.slots.get(drag.id)?.node;
		if (drag.mode === 'resize') {
			drag.current = { ...drag.origin, width: Math.max(MIN_BOX.width, snap(drag.origin.width + dx / scale)), height: Math.max(MIN_BOX.height, snap(drag.origin.height + dy / scale)) };
		} else {
			drag.current = { ...drag.origin, x: Math.max(0, drag.origin.x + dx / scale), y: Math.max(0, drag.origin.y + dy / scale) };
			const canvasRect = this.canvas.getBoundingClientRect();
			const point = { x: event.clientX - canvasRect.left - PAD, y: event.clientY - canvasRect.top - PAD };
			const target = dropTargetAt(point, this.current.rects, drag.id);
			drag.target = target?.kind === 'merge' && !this.canMerge(drag.id, target.id) ? { kind: 'swap', id: target.id } : target;
			for (const [id, slot] of this.slots) {
				slot.node.classList.toggle('merge-target', drag.target?.kind === 'merge' && drag.target.id === id);
				slot.node.classList.toggle('swap-target', drag.target?.kind === 'swap' && drag.target.id === id);
			}
			this.renderMergeHint(drag);
		}
		if (node) {
			applyRect(node, { x: drag.current.x * scale, y: drag.current.y * scale, width: drag.current.width * scale, height: drag.current.height * scale });
		}
	}

	private renderMergeHint(drag: DragState): void {
		for (const slot of this.slots.values()) {
			for (const hint of [...slot.node.children].filter(child => child.classList.contains('agent-box-drop-hint'))) {
				hint.remove();
			}
		}
		if (!drag.target) {
			return;
		}
		const node = this.slots.get(drag.target.id)?.node;
		const source = this.activeService.agentInfo(drag.id);
		const target = this.activeService.agentInfo(drag.target.id);
		if (!node || !source || !target) {
			return;
		}
		const hint = dom.append(node, $('.agent-box-drop-hint'));
		dom.append(hint, $('span')).classList.add(...ThemeIcon.asClassNameArray(drag.target.kind === 'merge' ? Codicon.gitMerge : Codicon.arrowSwap));
		dom.append(hint, $('span')).textContent = drag.target.kind === 'merge'
			? localize('dropMerge', "Merge {0}'s work into {1}", source.name, target.name)
			: localize('dropSwap', "Swap places");
	}

	private onPointerUp(event: PointerEvent): void {
		const drag = this.drag;
		if (!drag || event.pointerId !== drag.pointerId) {
			return;
		}
		this.endDrag();
		if (!drag.started) {
			return;
		}
		// The click that follows a drag isn't a click.
		const swallow = (click: MouseEvent) => { click.stopPropagation(); click.preventDefault(); };
		this.canvas.addEventListener('click', swallow, { capture: true, once: true });
		setTimeout(() => this.canvas.removeEventListener('click', swallow, { capture: true }), 0);
		const custom = this.snapshotCustom();
		if (drag.mode === 'move' && drag.target?.kind === 'merge') {
			// Merging isn't rearranging: keep the layout the grid had.
			if (drag.before) {
				this.layoutState = drag.before;
				this.saveLayout();
				this.host.layoutChanged();
			}
			this.relayout(true);
			void this.confirmMerge(drag.id, drag.target.id);
			return;
		}
		if (drag.mode === 'move' && drag.target?.kind === 'swap') {
			const other = custom[drag.target.id];
			if (other) {
				// Each takes the other's place; sizes go with the places, so the arrangement stays tidy.
				custom[drag.target.id] = { ...drag.origin };
				custom[drag.id] = { ...other };
			}
		} else {
			custom[drag.id] = { x: snap(drag.current.x), y: snap(drag.current.y), width: snap(drag.current.width), height: snap(drag.current.height) };
			// Boxes never sit on top of each other: whatever the moved or resized box now covers moves out of its way.
			resolveOverlaps(custom, drag.id);
		}
		this.saveLayout();
		this.relayout(true);
	}

	private cancelDrag(event: PointerEvent): void {
		if (this.drag?.pointerId === event.pointerId) {
			this.endDrag();
			this.relayout(true);
		}
	}

	private autoScrollTimer: ReturnType<typeof setInterval> | undefined;

	/**
	 * While a box is dragged near the left or right edge of a grid that extends off screen, the grid scrolls that way
	 * (faster the closer to the edge), and the box keeps following the pointer.
	 */
	private startAutoScroll(): void {
		clearInterval(this.autoScrollTimer);
		this.autoScrollTimer = setInterval(() => {
			const drag = this.drag;
			const last = drag?.last;
			if (!drag || !last) {
				return;
			}
			const rect = this.viewport.getBoundingClientRect();
			const fromLeft = last.clientX - rect.left;
			const fromRight = rect.right - last.clientX;
			const max = this.viewport.scrollWidth - this.viewport.clientWidth;
			let step = 0;
			if (fromLeft < AUTO_SCROLL_EDGE && this.viewport.scrollLeft > 0) {
				step = -AUTO_SCROLL_SPEED * (1 - Math.max(0, fromLeft) / AUTO_SCROLL_EDGE);
			} else if (fromRight < AUTO_SCROLL_EDGE && this.viewport.scrollLeft < max) {
				step = AUTO_SCROLL_SPEED * (1 - Math.max(0, fromRight) / AUTO_SCROLL_EDGE);
			}
			if (step) {
				this.viewport.scrollLeft = Math.max(0, Math.min(max, this.viewport.scrollLeft + step));
				this.onPointerMove(last);
			}
		}, 16);
	}

	private endDrag(): void {
		clearInterval(this.autoScrollTimer);
		this.autoScrollTimer = undefined;
		const drag = this.drag;
		this.drag = undefined;
		this.element.classList.remove('arranging');
		if (drag && this.canvas.hasPointerCapture(drag.pointerId)) {
			this.canvas.releasePointerCapture(drag.pointerId);
		}
		for (const slot of this.slots.values()) {
			slot.node.classList.remove('dragging', 'resizing', 'merge-target', 'swap-target');
		}
		if (drag) {
			this.renderMergeHint({ ...drag, target: undefined });
		}
	}

	/** Every box's place, unscaled, in the custom layout (boxes placed automatically get their place pinned). */
	private snapshotCustom(): Record<string, GridRect> {
		const custom = this.layoutState.custom;
		const scale = this.current?.scale ?? 1;
		for (const [id, box] of this.current?.rects ?? []) {
			custom[id] ??= { x: box.x / scale, y: box.y / scale, width: box.width / scale, height: box.height / scale };
		}
		return custom;
	}

	/** Moving or resizing makes the layout Custom, starting from exactly what's on screen. */
	private toCustom(): void {
		if (this.layoutState.preset === 'custom' || !this.current) {
			return;
		}
		const custom: Record<string, GridRect> = {};
		for (const [id, box] of this.current.rects) {
			custom[id] = { ...box };
		}
		this.layoutState = { ...this.layoutState, preset: 'custom', custom };
		this.current = { ...this.current, scale: 1 };
		this.saveLayout();
		this.host.layoutChanged();
	}

	/** Only top-level agents still working on their own can be merged, and not into themselves. */
	private canMerge(sourceId: string, targetId: string): boolean {
		// Merging is the host's.
		if (this.activeService.remote) {
			return false;
		}
		const source = this.activeService.agentInfo(sourceId);
		const target = this.activeService.agentInfo(targetId);
		const open = (agent: AgentInfo | undefined) => !!agent && agent.kind === 'agent' && !agent.mergedInto && !agent.finished;
		return sourceId !== targetId && open(source) && open(target);
	}

	private async confirmMerge(sourceId: string, targetId: string): Promise<void> {
		const source = this.activeService.agentInfo(sourceId);
		const target = this.activeService.agentInfo(targetId);
		if (!source || !target) {
			return;
		}
		const { result: choice } = await this.dialogService.prompt<'commit' | 'merge' | undefined>({
			message: localize('mergeConfirm', "Merge {0}'s work into {1}?", source.name, target.name),
			detail: [
				localize('mergeCommitDetail', "Commit before merging: commits each agent's work on its own branch ({0}'s is kept), then merges.", source.name),
				localize('mergeJustDetail', "Just merge: merges without committing; {0}'s branch is deleted.", source.name),
			].join('\n'),
			buttons: [
				{ label: localize('mergeCommitButton', "&&Commit Before Merging"), run: () => 'commit' },
				{ label: localize('mergeJustButton', "&&Just Merge"), run: () => 'merge' },
			],
			cancelButton: { label: localize('mergeCancel', "Cancel"), run: () => undefined },
		});
		if (!choice) {
			return;
		}
		const slot = this.slots.get(targetId);
		slot?.node.classList.add('merging');
		const result = await this.activeService.mergeAgents(sourceId, targetId, { commit: choice === 'commit' });
		slot?.node.classList.remove('merging');
		if (result.ok) {
			this.activeService.highlightAgent(targetId);
		}
	}

	// ----------------------------------------------------------------- wheel and keys

	private onWheel(event: WheelEvent): void {
		if (event.shiftKey) {
			// Shift + scroll pans sideways (when the grid extends past the screen).
			const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? wheelPixels(event, 'x') : wheelPixels(event, 'y');
			this.viewport.scrollLeft += delta;
			event.preventDefault();
			return;
		}
		if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) {
			return;
		}
		// Pulling up at the top opens the highlighted agent.
		const step = this.gesture.wheel(-wheelPixels(event, 'y'), this.viewport.scrollTop <= 0, Date.now());
		this.setPull(step.progress);
		if (step.committed) {
			this.gesture.block(Date.now());
			this.host.open(this.activeService.highlightedAgentId);
		}
	}

	private setPull(progress: number): void {
		const name = this.activeService.highlightedAgent?.name;
		this.pullLabel.textContent = name ? localize('pullOpen', "Keep scrolling up to open {0}", name) : localize('pullOpenChat', "Keep scrolling up for chat");
		setPullProgress(this.pull, progress);
		if (this.pullTimer !== undefined) {
			clearTimeout(this.pullTimer);
			this.pullTimer = undefined;
		}
		if (progress > 0) {
			this.pullTimer = setTimeout(() => this.setPull(this.gesture.idle(Date.now())), DEFAULT_OVERSCROLL.releaseMs + 20);
		}
	}

	private onKey(event: KeyboardEvent): void {
		const ids = this.topLevel().map(agent => agent.id);
		const index = ids.indexOf(this.boxIdOf(this.activeService.highlightedAgentId) ?? '');
		if (event.target !== this.viewport) {
			return;
		}
		if (event.key === 'Enter' || event.key === 'Escape') {
			this.host.open(this.activeService.highlightedAgentId);
		} else if ((event.key === 'ArrowRight' || event.key === 'ArrowDown') && ids.length) {
			this.activeService.highlightAgent(ids[(index + 1) % ids.length]);
			this.revealFocus();
		} else if ((event.key === 'ArrowLeft' || event.key === 'ArrowUp') && ids.length) {
			this.activeService.highlightAgent(ids[(index - 1 + ids.length) % ids.length]);
			this.revealFocus();
		} else {
			return;
		}
		event.preventDefault();
	}
}

const TAIL_TOOL_FAILED = ['failed', 'rejected', 'timedOut', 'cancelled'];

function applyRect(node: HTMLElement, box: GridRect): void {
	node.style.left = `${box.x + PAD}px`;
	node.style.top = `${box.y + PAD}px`;
	node.style.width = `${box.width}px`;
	node.style.height = `${box.height}px`;
	// Compact contents in small boxes (container queries can't see the box's own size reliably mid-transition).
	node.classList.toggle('small', box.height < 230 || box.width < 280);
	node.classList.toggle('tiny', box.height < 170);
}

function snap(value: number): number {
	return Math.round(value / 8) * 8;
}

function isInteractive(target: EventTarget | null): boolean {
	return target instanceof HTMLElement && !!(target.closest('button, a, input, textarea, select'));
}

/** Drives a pull indicator (`.active-agent-pull`): position, opacity and its bar. */
export function setPullProgress(indicator: HTMLElement, progress: number): void {
	indicator.style.setProperty('--pull', String(Math.max(0, Math.min(1, progress))));
	indicator.classList.toggle('pulling', progress > 0);
	indicator.classList.toggle('ready', progress >= 1);
}
