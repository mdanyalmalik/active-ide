/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export interface DiffHunk {
	/** 1-based start in the old text (the line before which lines were removed when `oldLines` is 0). */
	readonly oldStart: number;
	readonly oldLines: number;
	/** 1-based start in the new text. */
	readonly newStart: number;
	readonly newLines: number;
	readonly removed: readonly string[];
	readonly added: readonly string[];
}

export function splitLines(text: string | null): string[] {
	if (text === null || text.length === 0) {
		return [];
	}
	const lines = text.split('\n');
	if (lines[lines.length - 1] === '') {
		lines.pop();
	}
	return lines;
}

/**
 * Myers O(ND) line diff. Returns the edit hunks turning `before` into `after`.
 */
export function diffLines(before: string | null, after: string | null): DiffHunk[] {
	const a = splitLines(before);
	const b = splitLines(after);
	let prefix = 0;
	while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) {
		prefix++;
	}
	let suffix = 0;
	while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
		suffix++;
	}
	const aMid = a.slice(prefix, a.length - suffix);
	const bMid = b.slice(prefix, b.length - suffix);
	const ops = myers(aMid, bMid);

	const hunks: DiffHunk[] = [];
	let i = 0;
	let j = 0;
	let k = 0;
	while (k < ops.length) {
		if (ops[k] === 0) {
			i++;
			j++;
			k++;
			continue;
		}
		const oldStart = i;
		const newStart = j;
		const removed: string[] = [];
		const added: string[] = [];
		while (k < ops.length && ops[k] !== 0) {
			if (ops[k] === -1) {
				removed.push(aMid[i++]);
			} else {
				added.push(bMid[j++]);
			}
			k++;
		}
		hunks.push({
			oldStart: prefix + oldStart + 1,
			oldLines: removed.length,
			newStart: prefix + newStart + 1,
			newLines: added.length,
			removed,
			added,
		});
	}
	return hunks;
}

/** Returns a sequence of 0 (keep), -1 (delete from a), 1 (insert from b). */
function myers(a: readonly string[], b: readonly string[]): number[] {
	const n = a.length;
	const m = b.length;
	if (n === 0) {
		return new Array<number>(m).fill(1);
	}
	if (m === 0) {
		return new Array<number>(n).fill(-1);
	}
	const max = n + m;
	const offset = max;
	const v = new Int32Array(2 * max + 2);
	const trace: Int32Array[] = [];
	let found = false;
	for (let d = 0; d <= max && !found; d++) {
		trace.push(v.slice());
		for (let k = -d; k <= d; k += 2) {
			let x: number;
			if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
				x = v[offset + k + 1];
			} else {
				x = v[offset + k - 1] + 1;
			}
			let y = x - k;
			while (x < n && y < m && a[x] === b[y]) {
				x++;
				y++;
			}
			v[offset + k] = x;
			if (x >= n && y >= m) {
				found = true;
				break;
			}
		}
	}
	trace.push(v.slice());
	// Backtrack.
	const ops: number[] = [];
	let x = n;
	let y = m;
	for (let d = trace.length - 2; d >= 0 && (x > 0 || y > 0); d--) {
		const vd = trace[d];
		const k = x - y;
		let prevK: number;
		if (k === -d || (k !== d && vd[offset + k - 1] < vd[offset + k + 1])) {
			prevK = k + 1;
		} else {
			prevK = k - 1;
		}
		const prevX = vd[offset + prevK];
		const prevY = prevX - prevK;
		while (x > prevX && y > prevY) {
			ops.push(0);
			x--;
			y--;
		}
		if (d > 0) {
			if (x === prevX) {
				ops.push(1);
				y--;
			} else {
				ops.push(-1);
				x--;
			}
		}
	}
	while (x > 0 && y > 0) {
		ops.push(0);
		x--;
		y--;
	}
	while (x > 0) {
		ops.push(-1);
		x--;
	}
	while (y > 0) {
		ops.push(1);
		y--;
	}
	return ops.reverse();
}

export function diffStats(before: string | null, after: string | null): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const hunk of diffLines(before, after)) {
		added += hunk.newLines;
		removed += hunk.oldLines;
	}
	return { added, removed };
}

/** A unified diff for prompts and history. */
export function unifiedDiff(path: string, before: string | null, after: string | null, context = 3): string {
	const a = splitLines(before);
	const b = splitLines(after);
	const hunks = diffLines(before, after);
	if (hunks.length === 0) {
		return '';
	}
	const out: string[] = [`--- ${before === null ? '/dev/null' : `a/${path}`}`, `+++ ${after === null ? '/dev/null' : `b/${path}`}`];
	let index = 0;
	while (index < hunks.length) {
		// Merge hunks whose context overlaps.
		let last = index;
		while (last + 1 < hunks.length && hunks[last + 1].oldStart - (hunks[last].oldStart + hunks[last].oldLines) <= context * 2) {
			last++;
		}
		const first = hunks[index];
		const end = hunks[last];
		const oldFrom = Math.max(1, first.oldStart - context);
		const oldTo = Math.min(a.length, end.oldStart + end.oldLines - 1 + context);
		const newFrom = Math.max(1, first.newStart - context);
		const body: string[] = [];
		let oldLine = oldFrom;
		for (let h = index; h <= last; h++) {
			const hunk = hunks[h];
			while (oldLine < hunk.oldStart) {
				body.push(` ${a[oldLine - 1]}`);
				oldLine++;
			}
			for (const line of hunk.removed) {
				body.push(`-${line}`);
			}
			for (const line of hunk.added) {
				body.push(`+${line}`);
			}
			oldLine = hunk.oldStart + hunk.oldLines;
		}
		while (oldLine <= oldTo) {
			body.push(` ${a[oldLine - 1]}`);
			oldLine++;
		}
		const oldCount = body.filter(line => !line.startsWith('+')).length;
		const newCount = body.filter(line => !line.startsWith('-')).length;
		out.push(`@@ -${oldCount === 0 ? oldFrom - 1 : oldFrom},${oldCount} +${newCount === 0 ? newFrom - 1 : newFrom},${newCount} @@`);
		out.push(...body);
		index = last + 1;
	}
	void b;
	return out.join('\n');
}
