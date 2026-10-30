/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { importAMDNodeModule } from '../../../../amdX.js';
import * as dom from '../../../../base/browser/dom.js';
import { basicMarkupHtmlTags, defaultAllowedAttrs, safeSetInnerHtml } from '../../../../base/browser/domSanitize.js';
import { getWindow } from '../../../../base/browser/dom.js';
import { tokenizeToString } from '../../../../editor/common/languages/textToHtmlTokenizer.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { MarkedKatexSupport } from '../../markdown/browser/markedKatexSupport.js';
import type { CapturedFile, ChartVisual, CodeVisual, DiagramVisual, DiffVisual, EquationVisual, LineRange, Scene, SceneVisual } from '../common/activeProtocol.js';

const $ = dom.$;
const SVG_NS = 'http://www.w3.org/2000/svg';

export interface VisualCue {
	readonly nodes: readonly string[];
	readonly reveal: number | undefined;
}

export interface DiffLine {
	readonly kind: 'add' | 'remove' | 'context' | 'gap';
	readonly text: string;
}

function splitLines(text: string | null): string[] {
	if (!text) {
		return [];
	}
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/** LCS-based line diff (files shown in a walkthrough are already bounded). */
function diffOps(a: readonly string[], b: readonly string[]): Array<{ kind: 'add' | 'remove' | 'context'; text: string; newLine: number }> {
	const n = a.length;
	const m = b.length;
	if (n * m > 4_000_000) {
		return [...a.map(text => ({ kind: 'remove' as const, text, newLine: 0 })), ...b.map((text, index) => ({ kind: 'add' as const, text, newLine: index + 1 }))];
	}
	const table: Uint32Array[] = [];
	for (let i = 0; i <= n; i++) {
		table.push(new Uint32Array(m + 1));
	}
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
		}
	}
	const ops: Array<{ kind: 'add' | 'remove' | 'context'; text: string; newLine: number }> = [];
	let i = 0;
	let j = 0;
	while (i < n || j < m) {
		if (i < n && j < m && a[i] === b[j]) {
			ops.push({ kind: 'context', text: b[j], newLine: j + 1 });
			i++;
			j++;
		} else if (i < n && (j >= m || table[i + 1][j] >= table[i][j + 1])) {
			ops.push({ kind: 'remove', text: a[i], newLine: j + 1 });
			i++;
		} else {
			ops.push({ kind: 'add', text: b[j], newLine: j + 1 });
			j++;
		}
	}
	return ops;
}

/** How each line of the final version came about: new, changed (replacing removed lines), or with lines removed just after it. */
export interface LineChanges {
	readonly added: ReadonlySet<number>;
	readonly modified: ReadonlySet<number>;
	/** Lines followed by a removal (0: removed at the top of the file). */
	readonly removedAfter: ReadonlySet<number>;
}

export function lineChanges(file: CapturedFile): LineChanges {
	const added = new Set<number>();
	const modified = new Set<number>();
	const removedAfter = new Set<number>();
	if (file.final === null) {
		return { added, modified, removedAfter };
	}
	const ops = diffOps(splitLines(file.baseline), splitLines(file.final));
	for (let index = 0; index < ops.length;) {
		if (ops[index].kind === 'context') {
			index++;
			continue;
		}
		// A run of removals and additions between unchanged lines: additions that replace removals are changes.
		const run: typeof ops = [];
		while (index < ops.length && ops[index].kind !== 'context') {
			run.push(ops[index++]);
		}
		const additions = run.filter(op => op.kind === 'add');
		const removals = run.length - additions.length;
		additions.forEach((op, position) => (position < removals ? modified : added).add(op.newLine));
		if (removals > additions.length) {
			removedAfter.add(additions.length ? additions[additions.length - 1].newLine : run[0].newLine - 1);
		}
	}
	return { added, modified, removedAfter };
}

/**
 * A diff that only adds lines repeats what the editor already shows with its change marks; it's worth
 * a visual only when something was removed or replaced.
 */
export function isRedundantDiff(visual: SceneVisual | undefined, files: Readonly<Record<string, CapturedFile>>): boolean {
	if (visual?.type !== 'diff') {
		return false;
	}
	const file = files[visual.file];
	return !!file && !diffExcerpt(file, visual.range).some(line => line.kind === 'remove');
}

/**
 * Whether a scene's visual only repeats what the editor already shows: a diff that only adds lines,
 * or a code excerpt that's mostly the highlighted lines themselves. Such visuals are left out.
 */
export function isRedundantVisual(scene: Scene, files: Readonly<Record<string, CapturedFile>>): boolean {
	const visual = scene.visual;
	if (visual?.type === 'code' && visual.file === scene.file && visual.version === scene.version) {
		const length = visual.range.endLine - visual.range.startLine + 1;
		let shown = 0;
		for (let line = visual.range.startLine; line <= visual.range.endLine; line++) {
			shown += scene.focus.some(range => line >= range.startLine - 3 && line <= range.endLine + 3) ? 1 : 0;
		}
		return length > 0 && shown / length >= 0.6;
	}
	if (visual?.type === 'diff' && visual.file === scene.file && scene.version === 'final') {
		// A diff at the highlighted lines that's mostly additions shows what the editor and its change
		// marks already show; it earns its space only when removed code is a real part of it.
		const file = files[visual.file];
		const lines = file ? diffExcerpt(file, visual.range).filter(line => line.kind !== 'gap') : [];
		const removed = lines.filter(line => line.kind === 'remove').length;
		const atFocus = scene.focus.some(range => visual.range.startLine <= range.endLine + 3 && visual.range.endLine >= range.startLine - 3);
		if (atFocus && lines.length && removed / lines.length < 0.25) {
			return true;
		}
	}
	return isRedundantDiff(visual, files);
}

/** The changed lines around `range` (final-version coordinates), with one line of context. */
export function diffExcerpt(file: CapturedFile, range: LineRange, maxLines = 28): DiffLine[] {
	const ops = diffOps(splitLines(file.baseline), splitLines(file.final));
	const near = (line: number) => line >= range.startLine - 2 && line <= range.endLine + 2;
	const changed = ops.map((op, index) => ({ op, index })).filter(({ op }) => op.kind !== 'context' && op.text.trim().length > 0);
	let selected = changed.filter(({ op }) => near(op.newLine));
	if (selected.length === 0) {
		selected = changed;
	}
	const keep = new Set<number>();
	for (const { index } of selected) {
		keep.add(index);
	}
	const lines: DiffLine[] = [];
	let last = -1;
	for (let index = 0; index < ops.length && lines.length < maxLines; index++) {
		if (!keep.has(index)) {
			continue;
		}
		if (last >= 0 && index - last > 1) {
			lines.push({ kind: 'gap', text: '⋯' });
		}
		lines.push({ kind: ops[index].kind, text: ops[index].text });
		last = index;
	}
	return lines;
}

function renderDiff(container: HTMLElement, visual: DiffVisual, files: Readonly<Record<string, CapturedFile>>, cue: VisualCue): (cue: VisualCue) => void {
	const file = files[visual.file];
	const block = dom.append(container, $('.active-visual-diff'));
	const rows: Array<{ row: HTMLElement; hunk: number }> = [];
	const update = (next: VisualCue) => {
		for (const { row, hunk } of rows) {
			row.classList.toggle('dim', next.reveal !== undefined && hunk > next.reveal);
		}
	};
	if (!file) {
		return update;
	}
	const lines = diffExcerpt(file, visual.range);
	let hunk = 0;
	lines.forEach((line, index) => {
		if (line.kind === 'gap') {
			hunk++;
		}
		const row = dom.append(block, $(`.diff-line.${line.kind}`));
		row.textContent = line.kind === 'add' ? `+ ${line.text}` : line.kind === 'remove' ? `− ${line.text}` : line.kind === 'gap' ? '  ⋯' : `  ${line.text}`;
		row.style.setProperty('--active-index', String(Math.min(index, 24)));
		rows.push({ row, hunk });
		if (cue.reveal !== undefined && hunk > cue.reveal) {
			row.classList.add('dim');
		}
	});
	const caption = dom.append(container, $('.active-visual-source'));
	caption.textContent = localize('diffSource', "{0} · captured diff", visual.file);
	return update;
}

async function renderCode(container: HTMLElement, visual: CodeVisual, files: Readonly<Record<string, CapturedFile>>, languageService: ILanguageService): Promise<void> {
	const file = files[visual.file];
	const text = file ? (visual.version === 'baseline' ? file.baseline : file.final) : null;
	const block = dom.append(container, $('.active-visual-code'));
	if (text === null) {
		return;
	}
	const lines = splitLines(text).slice(visual.range.startLine - 1, visual.range.endLine);
	const languageId = languageService.guessLanguageIdByFilepathOrFirstLine(URI.file(visual.file)) ?? null;
	const html = await tokenizeToString(languageService, lines.join('\n'), languageId);
	safeSetInnerHtml(block, html, { allowedAttributes: { augment: ['class', 'style'] } });
	block.classList.add('ready');
	const caption = dom.append(container, $('.active-visual-source'));
	caption.textContent = localize('codeSource', "{0} · lines {1}–{2} · {3} version", visual.file, visual.range.startLine, visual.range.endLine, visual.version);
}

let katexPromise: Promise<typeof import('katex').default> | undefined;

async function renderEquation(container: HTMLElement, visual: EquationVisual): Promise<void> {
	const block = dom.append(container, $('.active-visual-equation'));
	try {
		katexPromise ??= importAMDNodeModule<typeof import('katex').default>('katex', 'dist/katex.min.js');
		const katex = await katexPromise;
		MarkedKatexSupport.ensureKatexStyles(getWindow(container));
		const html = katex.renderToString(visual.latex, { displayMode: true, throwOnError: false, output: 'html' });
		safeSetInnerHtml(block, html, MarkedKatexSupport.getSanitizerOptions({ allowedTags: basicMarkupHtmlTags, allowedAttributes: defaultAllowedAttrs }));
	} catch {
		block.textContent = visual.latex;
	}
	block.classList.add('ready');
	if (visual.legend?.length) {
		const legend = dom.append(container, $('.active-visual-legend'));
		for (const item of visual.legend) {
			const row = dom.append(legend, $('.legend-row'));
			dom.append(row, $('span.symbol')).textContent = item.symbol;
			dom.append(row, $('span.term')).textContent = item.term;
		}
	}
}

/** Assigns columns: explicit `column`, otherwise the longest path from a source node. */
export function layoutColumns(visual: DiagramVisual): Map<string, number> {
	const columns = new Map<string, number>();
	for (const node of visual.nodes) {
		if (node.column !== undefined) {
			columns.set(node.id, node.column);
		}
	}
	const incoming = new Map<string, string[]>();
	for (const edge of visual.edges) {
		if (edge.from !== edge.to) {
			incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
		}
	}
	const visiting = new Set<string>();
	const rank = (id: string): number => {
		const known = columns.get(id);
		if (known !== undefined) {
			return known;
		}
		if (visiting.has(id)) {
			return 0;
		}
		visiting.add(id);
		const parents = incoming.get(id) ?? [];
		const value = parents.length ? Math.max(...parents.map(parent => rank(parent) + 1)) : 0;
		visiting.delete(id);
		columns.set(id, value);
		return value;
	};
	for (const node of visual.nodes) {
		rank(node.id);
	}
	return columns;
}

/** Vertical padding of a diagram (matches the CSS), and how far below the boxes a detouring edge runs. */
const DIAGRAM_PADDING = 6;
const DETOUR_GAP = 14;
const DETOUR_LABEL_ROOM = 34;
const MIN_COLUMN_GAP = 48;
/** Width a box needs for a typical label to wrap only between words. */
const READABLE_COLUMN_WIDTH = 160;

function renderDiagram(container: HTMLElement, visual: DiagramVisual, cue: VisualCue): { layout: () => void; update: (cue: VisualCue) => void } {
	const diagram = dom.append(container, $('.active-visual-diagram'));
	const columns = layoutColumns(visual);
	const order = [...new Set([...columns.values()])].sort((a, b) => a - b);
	const row = dom.append(diagram, $('.diagram-columns'));
	// A single row of boxes reads as a pipeline, so its boxes share one height.
	row.classList.toggle('single-row', order.every(column => visual.nodes.filter(node => columns.get(node.id) === column).length === 1));
	const boxes = new Map<string, HTMLElement>();
	const columnElements: HTMLElement[] = [];
	let highlighted = new Set(cue.nodes);
	order.forEach((column, columnIndex) => {
		const columnElement = dom.append(row, $('.diagram-column'));
		columnElement.style.setProperty('--active-index', String(columnIndex));
		columnElements.push(columnElement);
		// A labelled edge between two boxes of this column needs room for its label between them.
		if (visual.edges.some(edge => edge.label && columns.get(edge.from) === column && columns.get(edge.to) === column)) {
			columnElement.classList.add('roomy');
		}
		for (const node of visual.nodes.filter(candidate => columns.get(candidate.id) === column)) {
			const box = dom.append(columnElement, $('.diagram-node'));
			dom.append(box, $('.label')).textContent = node.label;
			if (node.detail) {
				dom.append(box, $('.detail')).textContent = node.detail;
			}
			boxes.set(node.id, box);
		}
	});
	const svg = document.createElementNS(SVG_NS, 'svg');
	svg.classList.add('diagram-edges');
	diagram.appendChild(svg);
	const labels = dom.append(diagram, $('.diagram-edge-labels'));
	if (visual.illustrative) {
		dom.append(container, $('.active-visual-badge')).textContent = localize('illustrative', "Illustrative model");
	}
	const markerId = `active-arrow-${Math.random().toString(36).slice(2)}`;
	const edgeElements: Array<{ from: string; to: string; path: SVGPathElement; label?: HTMLElement }> = [];
	const update = (next: VisualCue) => {
		highlighted = new Set(next.nodes);
		columnElements.forEach((element, index) => element.classList.toggle('dim', next.reveal !== undefined && index > next.reveal));
		for (const [id, box] of boxes) {
			box.classList.toggle('highlight', highlighted.has(id));
			box.classList.toggle('muted', highlighted.size > 0 && !highlighted.has(id));
		}
		for (const edge of edgeElements) {
			const active = highlighted.has(edge.from) && highlighted.has(edge.to);
			edge.path.classList.toggle('highlight', active);
			edge.label?.classList.toggle('highlight', active);
		}
	};
	update(cue);
	// Edges draw themselves in once, the first time the diagram has a size.
	let drawn = false;
	const draw = () => {
		const origin = diagram.getBoundingClientRect();
		if (origin.width === 0) {
			return;
		}
		// Many columns can't keep the full gap: give the boxes a readable width first, and the gaps what's left.
		if (columnElements.length > 1) {
			const count = columnElements.length;
			const fullGap = 120;
			const gap = Math.max(MIN_COLUMN_GAP, Math.min(fullGap, Math.floor((row.clientWidth - count * READABLE_COLUMN_WIDTH) / (count - 1))));
			const value = gap < fullGap ? `${gap}px` : '';
			if (row.style.columnGap !== value) {
				row.style.columnGap = value;
			}
			labels.style.setProperty('--active-gap', `${gap}px`);
		}
		svg.setAttribute('width', String(origin.width));
		svg.setAttribute('height', String(origin.height));
		if (!drawn) {
			drawn = true;
			diagram.classList.add('draw-in');
			// Boxes are still sliding in; follow them once they've settled.
			setTimeout(draw, 1300);
			setTimeout(() => diagram.classList.remove('draw-in'), 2000);
		}
		// Built once and only moved afterwards: recreating the paths would restart their draw-in animation.
		if (!svg.firstChild) {
			const defs = document.createElementNS(SVG_NS, 'defs');
			const marker = document.createElementNS(SVG_NS, 'marker');
			marker.setAttribute('id', markerId);
			marker.setAttribute('viewBox', '0 0 10 10');
			marker.setAttribute('refX', '9');
			marker.setAttribute('refY', '5');
			marker.setAttribute('markerWidth', '7');
			marker.setAttribute('markerHeight', '7');
			marker.setAttribute('orient', 'auto-start-reverse');
			const tip = document.createElementNS(SVG_NS, 'path');
			tip.setAttribute('d', 'M 0 0 L 10 5 L 0 10 z');
			tip.setAttribute('class', 'arrow-tip');
			marker.appendChild(tip);
			defs.appendChild(marker);
			svg.appendChild(defs);
			visual.edges.forEach((edge, edgeIndex) => {
				if (!boxes.has(edge.from) || !boxes.has(edge.to)) {
					return;
				}
				const path = document.createElementNS(SVG_NS, 'path');
				path.setAttribute('marker-end', `url(#${markerId})`);
				path.setAttribute('pathLength', '1');
				path.style.setProperty('--active-index', String(edgeIndex));
				const active = highlighted.has(edge.from) && highlighted.has(edge.to);
				path.setAttribute('class', active ? 'edge highlight' : 'edge');
				svg.appendChild(path);
				let label: HTMLElement | undefined;
				if (edge.label) {
					label = dom.append(labels, $('.edge-label'));
					label.textContent = edge.label;
					label.classList.toggle('highlight', active);
					label.style.setProperty('--active-index', String(edgeIndex));
				}
				edgeElements.push({ from: edge.from, to: edge.to, path, label });
			});
		}
		let detourDepth = 0;
		const labelledEdges = visual.edges.filter(edge => edge.label);
		for (const element of edgeElements) {
			const from = boxes.get(element.from)!.getBoundingClientRect();
			const to = boxes.get(element.to)!.getBoundingClientRect();
			let x1: number;
			let y1: number;
			let x2: number;
			let y2: number;
			if (Math.abs(from.left - to.left) < 4) {
				const down = to.top > from.top;
				x1 = from.left + from.width / 2 - origin.left;
				y1 = (down ? from.bottom : from.top) - origin.top;
				x2 = to.left + to.width / 2 - origin.left;
				y2 = (down ? to.top : to.bottom) - origin.top;
			} else {
				const right = to.left > from.left;
				x1 = (right ? from.right : from.left) - origin.left;
				y1 = from.top + from.height / 2 - origin.top;
				x2 = (right ? to.left : to.right) - origin.left;
				y2 = to.top + to.height / 2 - origin.top;
			}
			// Two edges between the same pair run on parallel tracks: forward above, return below.
			const opposed = visual.edges.some(other => other.from === element.to && other.to === element.from);
			const returning = opposed && x2 < x1;
			if (opposed) {
				const offset = returning ? 9 : -9;
				y1 += offset;
				y2 += offset;
			}
			const mid = (x1 + x2) / 2;
			// An edge that skips a column would run behind the boxes in between: route it underneath them.
			const [left, right] = x1 < x2 ? [x1, x2] : [x2, x1];
			const blockers = [...boxes].filter(([id]) => id !== element.from && id !== element.to).map(([, box]) => box.getBoundingClientRect())
				.filter(rect => rect.right - origin.left > left + 4 && rect.left - origin.left < right - 4 && rect.bottom - origin.top > Math.min(y1, y2) - 6 && rect.top - origin.top < Math.max(y1, y2) + 6);
			if (blockers.length) {
				const under = Math.max(...blockers.map(rect => rect.bottom - origin.top)) + DETOUR_GAP;
				const direction = x2 > x1 ? 1 : -1;
				const bend = Math.min(40, Math.abs(x2 - x1) / 4);
				element.path.setAttribute('d', `M ${x1} ${y1} C ${x1 + direction * bend} ${y1}, ${x1 + direction * bend} ${under}, ${x1 + direction * bend * 2} ${under} L ${x2 - direction * bend * 2} ${under} C ${x2 - direction * bend} ${under}, ${x2 - direction * bend} ${y2}, ${x2} ${y2}`);
				// Room for the detour and its label below the row of boxes.
				detourDepth = Math.max(detourDepth, under + DETOUR_LABEL_ROOM - (row.getBoundingClientRect().bottom - origin.top));
			} else {
				element.path.setAttribute('d', Math.abs(x1 - x2) > 4 ? `M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}` : `M ${x1} ${y1} L ${x2} ${y2}`);
			}
			if (element.label) {
				const vertical = Math.abs(x1 - x2) <= 4;
				element.label.classList.toggle('below', !vertical && (returning || blockers.length > 0));
				// Between stacked boxes there's no room on the line, so the label sits beside it.
				element.label.classList.toggle('beside', vertical);
				if (vertical) {
					element.label.style.left = `${x1 + 8}px`;
					element.label.style.top = `${(y1 + y2) / 2}px`;
				} else if (blockers.length) {
					element.label.style.left = `${mid}px`;
					element.label.style.top = `${Math.max(...blockers.map(rect => rect.bottom - origin.top)) + DETOUR_GAP}px`;
				} else {
					// Labels of edges fanning out of (or into) one box would pile up mid-way; move them toward the far end, where the edges have spread apart.
					const fansOut = labelledEdges.filter(other => other.from === element.from).length > 1;
					const fansIn = labelledEdges.filter(other => other.to === element.to).length > 1;
					const t = fansOut && !fansIn ? 0.72 : fansIn && !fansOut ? 0.28 : 0.5;
					const u = 1 - t;
					element.label.style.left = `${u * u * u * x1 + 3 * u * t * mid + t * t * t * x2}px`;
					element.label.style.top = `${y1 + (y2 - y1) * (3 * t * t - 2 * t * t * t)}px`;
				}
			}
		}
		// Make room below the boxes for detours so they don't run into the caption.
		const padding = `${DIAGRAM_PADDING + Math.max(0, Math.ceil(detourDepth))}px`;
		if (diagram.style.paddingBottom !== padding) {
			diagram.style.paddingBottom = padding;
		}
	};
	return { layout: draw, update };
}

function niceMax(value: number): number {
	if (value <= 0) {
		return 1;
	}
	const magnitude = Math.pow(10, Math.floor(Math.log10(value)));
	for (const step of [1, 2, 2.5, 5, 10]) {
		if (step * magnitude >= value) {
			return step * magnitude;
		}
	}
	return 10 * magnitude;
}

function renderChart(container: HTMLElement, visual: ChartVisual, cue: VisualCue): () => void {
	const chart = dom.append(container, $('.active-visual-chart'));
	if (visual.title) {
		dom.append(chart, $('.chart-title')).textContent = visual.title;
	}
	const svg = document.createElementNS(SVG_NS, 'svg');
	chart.appendChild(svg);
	const legend = dom.append(chart, $('.chart-legend'));
	visual.series.forEach((series, index) => {
		const item = dom.append(legend, $(`span.series-${index % 4}`));
		item.textContent = series.name;
	});
	dom.append(container, $('.active-visual-badge')).textContent = visual.source === 'observed'
		? localize('observed', "Observed · from captured tool output")
		: localize('illustrativeChart', "Illustrative example — not measured");
	const draw = () => {
		const width = Math.max(320, Math.min(chart.clientWidth || 560, 760));
		const height = 200;
		const pad = { left: 52, right: 16, top: 12, bottom: 40 };
		svg.setAttribute('width', String(width));
		svg.setAttribute('height', String(height));
		while (svg.firstChild) {
			svg.removeChild(svg.firstChild);
		}
		const xs = [...new Set(visual.series.flatMap(series => series.points.map(point => String(point.x))))];
		const max = niceMax(Math.max(...visual.series.flatMap(series => series.points.map(point => point.y))));
		const plotWidth = width - pad.left - pad.right;
		const plotHeight = height - pad.top - pad.bottom;
		const y = (value: number) => pad.top + plotHeight - (value / max) * plotHeight;
		const add = (name: string, attributes: Record<string, string | number>, text?: string) => {
			const element = document.createElementNS(SVG_NS, name);
			for (const [key, value] of Object.entries(attributes)) {
				element.setAttribute(key, String(value));
			}
			if (text !== undefined) {
				element.textContent = text;
			}
			svg.appendChild(element);
			return element;
		};
		for (let tick = 0; tick <= 4; tick++) {
			const value = (max / 4) * tick;
			add('line', { x1: pad.left, x2: width - pad.right, y1: y(value), y2: y(value), class: 'grid' });
			add('text', { x: pad.left - 6, y: y(value) + 4, 'text-anchor': 'end', class: 'tick' }, Number.isInteger(value) ? String(value) : value.toFixed(1));
		}
		const band = plotWidth / Math.max(xs.length, 1);
		xs.forEach((x, index) => add('text', { x: pad.left + band * index + band / 2, y: height - pad.bottom + 16, 'text-anchor': 'middle', class: 'tick' }, x));
		add('text', { x: pad.left + plotWidth / 2, y: height - 4, 'text-anchor': 'middle', class: 'axis-label' }, visual.xLabel);
		add('text', { x: 12, y: pad.top + plotHeight / 2, 'text-anchor': 'middle', class: 'axis-label', transform: `rotate(-90 12 ${pad.top + plotHeight / 2})` }, visual.yLabel);
		const revealCount = cue.reveal === undefined ? xs.length : cue.reveal + 1;
		visual.series.forEach((series, seriesIndex) => {
			const points = series.points.filter(point => xs.indexOf(String(point.x)) < revealCount);
			if (visual.chart === 'bar') {
				const barWidth = Math.max(4, (band * 0.7) / visual.series.length);
				for (const point of points) {
					const index = xs.indexOf(String(point.x));
					const x = pad.left + band * index + band * 0.15 + barWidth * seriesIndex;
					add('rect', { x, y: y(point.y), width: barWidth, height: Math.max(0, pad.top + plotHeight - y(point.y)), class: `bar series-${seriesIndex % 4}` });
					add('text', { x: x + barWidth / 2, y: y(point.y) - 4, 'text-anchor': 'middle', class: 'value' }, String(point.y));
				}
			} else {
				const coords = points.map(point => `${pad.left + band * xs.indexOf(String(point.x)) + band / 2},${y(point.y)}`);
				add('polyline', { points: coords.join(' '), class: `line series-${seriesIndex % 4}` });
				for (const coord of coords) {
					const [cx, cy] = coord.split(',');
					add('circle', { cx, cy, r: 3.5, class: `dot series-${seriesIndex % 4}` });
				}
			}
		});
	};
	return draw;
}

/**
 * Renders a scene visual into `container`. Returns a function that re-lays out
 * geometry-dependent parts (diagram edges, chart width) after the container is
 * attached or resized, and a promise for asynchronous rendering (syntax
 * highlighting, KaTeX).
 */
export interface RenderedVisual {
	/** Re-lays out geometry-dependent parts (diagram edges, chart width) after the container is attached or resized. */
	readonly layout: () => void;
	/** Settles when asynchronous rendering (syntax highlighting, KaTeX) is done. */
	readonly ready: Promise<void>;
	/** Applies a new narration cue in place, so highlights animate instead of the visual being rebuilt. Absent when the visual must be re-rendered. */
	readonly update?: (cue: VisualCue) => void;
}

/** Renders a scene visual into `container`. */
export function renderVisual(container: HTMLElement, visual: SceneVisual, files: Readonly<Record<string, CapturedFile>>, cue: VisualCue, languageService: ILanguageService): RenderedVisual {
	const still = () => { };
	switch (visual.type) {
		case 'diff':
			return { layout: still, ready: Promise.resolve(), update: renderDiff(container, visual, files, cue) };
		case 'code':
			return { layout: still, ready: renderCode(container, visual, files, languageService), update: still };
		case 'equation':
			return { layout: still, ready: renderEquation(container, visual), update: still };
		case 'diagram':
			return { ...renderDiagram(container, visual, cue), ready: Promise.resolve() };
		case 'chart':
			return { layout: renderChart(container, visual, cue), ready: Promise.resolve() };
	}
}

export function visualKindLabel(visual: SceneVisual | undefined): string {
	switch (visual?.type) {
		case 'diff': return localize('kindDiff', "Code diff");
		case 'code': return localize('kindCode', "Code");
		case 'equation': return localize('kindEquation', "Equation");
		case 'diagram': return localize('kindDiagram', "Diagram");
		case 'chart': return localize('kindChart', "Chart");
		default: return '';
	}
}
