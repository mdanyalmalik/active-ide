/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface MapPoint {
	readonly x: number;
	readonly y: number;
}

export interface MapSize {
	readonly width: number;
	readonly height: number;
}

export const NODE_WIDTH = 240;
export const NODE_HEIGHT = 96;
const COLUMN_GAP = 150;
const ROW_GAP = 56;

/**
 * Places a map's components left to right in columns, following its connections (a layered layout: cycles are
 * broken, each component goes one column after the furthest component pointing at it, and the order within a
 * column is settled by the average position of neighbours). Components that already have a place keep it, so
 * the map doesn't rearrange itself when it updates; new ones are placed where the layout puts them, moved down
 * until they overlap nothing.
 */
export function layoutMap(ids: readonly string[], edges: ReadonlyArray<{ readonly from: string; readonly to: string }>, kept: ReadonlyMap<string, MapPoint> = new Map()): Map<string, MapPoint> {
	const known = new Set(ids);
	const links = edges.filter(edge => known.has(edge.from) && known.has(edge.to) && edge.from !== edge.to);
	const layers = assignLayers(ids, links);
	const columns = orderColumns(ids, links, layers);
	const placed = new Map<string, MapPoint>();
	const tallest = Math.max(...columns.map(column => column.length), 1);
	columns.forEach((column, columnIndex) => {
		// Columns are centred against the tallest one.
		const offset = (tallest - column.length) * (NODE_HEIGHT + ROW_GAP) / 2;
		column.forEach((id, row) => placed.set(id, { x: columnIndex * (NODE_WIDTH + COLUMN_GAP), y: offset + row * (NODE_HEIGHT + ROW_GAP) }));
	});
	const keptHere = ids.filter(id => kept.has(id));
	if (!keptHere.length) {
		return placed;
	}
	const result = new Map<string, MapPoint>();
	for (const id of keptHere) {
		result.set(id, kept.get(id)!);
	}
	for (const id of ids) {
		if (result.has(id)) {
			continue;
		}
		let point = placed.get(id)!;
		for (let tries = 0; tries < 200 && [...result.values()].some(other => overlaps(point, other)); tries++) {
			point = { x: point.x, y: point.y + NODE_HEIGHT / 2 };
		}
		result.set(id, point);
	}
	return result;
}

function overlaps(a: MapPoint, b: MapPoint): boolean {
	return Math.abs(a.x - b.x) < NODE_WIDTH + 24 && Math.abs(a.y - b.y) < NODE_HEIGHT + 20;
}

/** Each component's column: one past the furthest component that points at it (after breaking cycles). */
function assignLayers(ids: readonly string[], edges: ReadonlyArray<{ from: string; to: string }>): Map<string, number> {
	const outgoing = new Map<string, string[]>(ids.map(id => [id, []]));
	for (const edge of edges) {
		outgoing.get(edge.from)!.push(edge.to);
	}
	// Depth-first: an edge back to a component still on the path closes a cycle, and is left out.
	const state = new Map<string, 'visiting' | 'done'>();
	const acyclic: Array<{ from: string; to: string }> = [];
	const visit = (id: string) => {
		state.set(id, 'visiting');
		for (const next of outgoing.get(id)!) {
			if (state.get(next) === 'visiting') {
				continue;
			}
			acyclic.push({ from: id, to: next });
			if (!state.has(next)) {
				visit(next);
			}
		}
		state.set(id, 'done');
	};
	// Start from components nothing points at, so the flow reads from the left.
	const pointedAt = new Set(edges.map(edge => edge.to));
	for (const id of [...ids.filter(id => !pointedAt.has(id)), ...ids]) {
		if (!state.has(id)) {
			visit(id);
		}
	}
	const layer = new Map<string, number>(ids.map(id => [id, 0]));
	// Longest path: relax until nothing moves (at most one pass per component).
	for (let pass = 0; pass < ids.length; pass++) {
		let moved = false;
		for (const edge of acyclic) {
			const next = layer.get(edge.from)! + 1;
			if (next > layer.get(edge.to)!) {
				layer.set(edge.to, next);
				moved = true;
			}
		}
		if (!moved) {
			break;
		}
	}
	return layer;
}

/** The components of each column, ordered to cross as few connections as a few barycenter sweeps manage. */
function orderColumns(ids: readonly string[], edges: ReadonlyArray<{ from: string; to: string }>, layers: Map<string, number>): string[][] {
	const count = Math.max(0, ...layers.values()) + 1;
	const columns: string[][] = Array.from({ length: count }, () => []);
	for (const id of ids) {
		columns[layers.get(id)!].push(id);
	}
	const neighbours = new Map<string, string[]>(ids.map(id => [id, []]));
	for (const edge of edges) {
		neighbours.get(edge.from)!.push(edge.to);
		neighbours.get(edge.to)!.push(edge.from);
	}
	const position = () => {
		const at = new Map<string, number>();
		columns.forEach(column => column.forEach((id, index) => at.set(id, index)));
		return at;
	};
	for (let sweep = 0; sweep < 6; sweep++) {
		const at = position();
		const order = sweep % 2 === 0 ? columns.slice(1) : columns.slice(0, -1).reverse();
		for (const column of order) {
			const weight = new Map(column.map((id, index) => {
				const near = neighbours.get(id)!.filter(other => layers.get(other) !== layers.get(id));
				return [id, near.length ? near.reduce((sum, other) => sum + at.get(other)!, 0) / near.length : index];
			}));
			column.sort((a, b) => weight.get(a)! - weight.get(b)!);
		}
	}
	return columns;
}

/** The bounds of everything placed, for fitting the map to the view. */
export function mapBounds(points: Iterable<MapPoint>): { x: number; y: number; width: number; height: number } {
	let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
	for (const point of points) {
		minX = Math.min(minX, point.x);
		minY = Math.min(minY, point.y);
		maxX = Math.max(maxX, point.x + NODE_WIDTH);
		maxY = Math.max(maxY, point.y + NODE_HEIGHT);
	}
	return minX === Infinity ? { x: 0, y: 0, width: 0, height: 0 } : { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

/**
 * The curve for a connection between two boxes: out of the source's right side into the target's left side,
 * or around when the target sits to the left. Returns the SVG path and the point halfway along (for the label).
 */
export function connectionPath(from: MapPoint, to: MapPoint): { path: string; middle: MapPoint } {
	const forward = to.x >= from.x + NODE_WIDTH / 2;
	if (forward) {
		const start = { x: from.x + NODE_WIDTH, y: from.y + NODE_HEIGHT / 2 };
		const end = { x: to.x, y: to.y + NODE_HEIGHT / 2 };
		const bend = Math.max(40, (end.x - start.x) / 2);
		const c1 = { x: start.x + bend, y: start.y };
		const c2 = { x: end.x - bend, y: end.y };
		return { path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`, middle: cubicAt(start, c1, c2, end, 0.5) };
	}
	// Same column or backwards: leave from the bottom and arrive at the bottom, looping below.
	const start = { x: from.x + NODE_WIDTH / 2, y: from.y + NODE_HEIGHT };
	const end = { x: to.x + NODE_WIDTH / 2, y: to.y + NODE_HEIGHT };
	const drop = 70 + Math.abs(start.x - end.x) * 0.15;
	const low = Math.max(start.y, end.y) + drop;
	const c1 = { x: start.x, y: low };
	const c2 = { x: end.x, y: low };
	return { path: `M ${start.x} ${start.y} C ${c1.x} ${c1.y}, ${c2.x} ${c2.y}, ${end.x} ${end.y}`, middle: cubicAt(start, c1, c2, end, 0.5) };
}

function cubicAt(p0: MapPoint, p1: MapPoint, p2: MapPoint, p3: MapPoint, t: number): MapPoint {
	const u = 1 - t;
	return {
		x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
		y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
	};
}
