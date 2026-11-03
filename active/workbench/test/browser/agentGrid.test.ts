/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentInfo } from '../../common/activeProtocol.js';
import { bestColumns, COMFORT_BOX, computeGridLayout, dropTargetAt, GRID_GAP, GridRect, OverscrollGesture, overlapMarkers, placeNewRect, plainText, topLevelOf, shownAgents, HELPER_LINGER_MS, HELPER_LEAVE_MS } from '../../browser/agentGrid.js';

const ids = (count: number) => Array.from({ length: count }, (_, index) => `a${index}`);

function overlapping(rects: Iterable<GridRect>): boolean {
	const boxes = [...rects];
	return boxes.some((a, i) => boxes.some((b, j) => i < j && a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height));
}

function within(rects: Iterable<GridRect>, width: number, height: number): boolean {
	return [...rects].every(box => box.x >= 0 && box.y >= 0 && box.x + box.width <= width + 1 && box.y + box.height <= height + 1);
}

suite('Active agent grid layout', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('auto picks a shape that keeps boxes readable', () => {
		assert.strictEqual(bestColumns(1, 1200, 800), 1);
		assert.strictEqual(bestColumns(2, 1200, 800), 2);
		assert.strictEqual(bestColumns(4, 1200, 800), 2);
		assert.strictEqual(bestColumns(6, 1500, 800), 3);
		// A tall, narrow space stacks them.
		assert.strictEqual(bestColumns(3, 500, 1200), 1);
	});

	test('without overflow every preset fits all agents on screen, without overlapping', () => {
		for (const preset of ['auto', 'columns', 'rows', 'focus'] as const) {
			for (const count of [1, 2, 3, 5, 9]) {
				const layout = computeGridLayout({ ids: ids(count), preset, width: 1200, height: 700, overflow: false, focusId: 'a1' });
				assert.strictEqual(layout.rects.size, count, `${preset} ${count}`);
				assert.ok(within(layout.rects.values(), 1200, 700), `${preset} ${count} fits`);
				assert.ok(!overlapping(layout.rects.values()), `${preset} ${count} doesn't overlap`);
			}
		}
	});

	test('more agents shrink the boxes when overflow is off', () => {
		const few = computeGridLayout({ ids: ids(2), preset: 'auto', width: 1200, height: 700, overflow: false });
		const many = computeGridLayout({ ids: ids(12), preset: 'auto', width: 1200, height: 700, overflow: false });
		assert.ok(many.rects.get('a0')!.width < few.rects.get('a0')!.width);
		assert.deepStrictEqual([many.width, many.height], [1200, 700]);
	});

	test('with overflow on, boxes keep a comfortable size and the grid extends sideways', () => {
		const layout = computeGridLayout({ ids: ids(12), preset: 'auto', width: 1200, height: 700, overflow: true });
		for (const box of layout.rects.values()) {
			assert.ok(box.width >= COMFORT_BOX.width && box.height >= COMFORT_BOX.height);
		}
		assert.ok(layout.width > 1200);
		assert.strictEqual(layout.height, 700);
		assert.ok(!overlapping(layout.rects.values()));
		// Column by column: a new agent goes at the end without moving the others.
		const more = computeGridLayout({ ids: ids(13), preset: 'auto', width: 1200, height: 700, overflow: true });
		assert.deepStrictEqual(more.rects.get('a5'), layout.rects.get('a5'));
	});

	test('with overflow on, a few agents still fill the screen', () => {
		const layout = computeGridLayout({ ids: ids(2), preset: 'auto', width: 1200, height: 700, overflow: true });
		assert.deepStrictEqual([layout.width, layout.height], [1200, 700]);
		assert.strictEqual(layout.rects.get('a0')!.width, (1200 - GRID_GAP) / 2);
	});

	test('focus makes the highlighted agent large and stacks the rest beside it', () => {
		const layout = computeGridLayout({ ids: ids(4), preset: 'focus', width: 1200, height: 700, overflow: false, focusId: 'a2' });
		const main = layout.rects.get('a2')!;
		assert.deepStrictEqual([main.x, main.y, main.height], [0, 0, 700]);
		for (const id of ['a0', 'a1', 'a3']) {
			const box = layout.rects.get(id)!;
			assert.ok(box.x > main.x + main.width && box.width < main.width, id);
		}
	});

	test('custom keeps saved places, places new agents in free space, and shrinks to fit without overflow', () => {
		const custom = { a0: { x: 0, y: 0, width: 400, height: 300 }, a1: { x: 1600, y: 0, width: 400, height: 300 } };
		const shrunk = computeGridLayout({ ids: ['a0', 'a1', 'a2'], preset: 'custom', width: 1000, height: 700, overflow: false, custom });
		assert.ok(shrunk.scale < 1);
		assert.ok(within(shrunk.rects.values(), 1000, 700));
		assert.ok(!overlapping(shrunk.rects.values()));
		const kept = computeGridLayout({ ids: ['a0', 'a1'], preset: 'custom', width: 1000, height: 700, overflow: true, custom });
		assert.strictEqual(kept.scale, 1);
		assert.deepStrictEqual(kept.rects.get('a1'), custom.a1);
		assert.strictEqual(kept.width, 2000);
	});

	test('a new box goes in the first free cell, else after everything', () => {
		assert.deepStrictEqual(placeNewRect([], 1000, 700), { x: 0, y: 0, width: COMFORT_BOX.width, height: COMFORT_BOX.height });
		const second = placeNewRect([{ x: 0, y: 0, width: COMFORT_BOX.width, height: COMFORT_BOX.height }], 1000, 700);
		assert.strictEqual(second.x, COMFORT_BOX.width + GRID_GAP);
		const full = placeNewRect([{ x: 0, y: 0, width: 1000, height: 700 }], 1000, 700);
		assert.strictEqual(full.x, 1000 + GRID_GAP);
	});

	test('dropping on the middle of a box merges, on its rim swaps, elsewhere moves', () => {
		const rects = new Map<string, GridRect>([['a', { x: 0, y: 0, width: 100, height: 100 }], ['b', { x: 200, y: 0, width: 100, height: 100 }]]);
		assert.deepStrictEqual(dropTargetAt({ x: 250, y: 50 }, rects, 'a'), { kind: 'merge', id: 'b' });
		assert.deepStrictEqual(dropTargetAt({ x: 205, y: 50 }, rects, 'a'), { kind: 'swap', id: 'b' });
		assert.strictEqual(dropTargetAt({ x: 150, y: 50 }, rects, 'a'), undefined);
		// Never onto itself.
		assert.strictEqual(dropTargetAt({ x: 50, y: 50 }, rects, 'a'), undefined);
	});
});

suite('Active agent grid overscroll', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const options = { threshold: 300, pauseMs: 250, releaseMs: 450, maxStep: 100 };

	test('the momentum that reached the edge does not count', () => {
		const gesture = new OverscrollGesture(options);
		let now = 1000;
		// Scrolling down the chat, then hitting the bottom with events still coming every 16 ms.
		for (let i = 0; i < 10; i++) {
			gesture.wheel(80, false, now += 16);
		}
		for (let i = 0; i < 40; i++) {
			const step = gesture.wheel(80, true, now += 16);
			assert.strictEqual(step.progress, 0);
			assert.strictEqual(step.committed, false);
		}
	});

	test('a fresh gesture at the edge builds up and commits past the threshold', () => {
		const gesture = new OverscrollGesture(options);
		let now = 1000;
		gesture.wheel(80, false, now += 16);
		now += 300; // a pause: the next wheel is a new gesture
		const first = gesture.wheel(60, true, now);
		assert.strictEqual(first.progress, 0.2);
		const second = gesture.wheel(60, true, now += 16);
		assert.strictEqual(second.progress, 0.4);
		gesture.wheel(100, true, now += 16);
		const last = gesture.wheel(100, true, now += 16);
		assert.strictEqual(last.committed, true);
		// Momentum after the commit doesn't start another one.
		assert.strictEqual(gesture.wheel(100, true, now += 16).progress, 0);
	});

	test('one big flick cannot commit in a single event', () => {
		const gesture = new OverscrollGesture(options);
		const step = gesture.wheel(5000, true, 10_000);
		assert.strictEqual(step.committed, false);
		assert.ok(step.progress <= 100 / 300 + 1e-9);
	});

	test('scrolling back, or leaving the edge, resets the pull', () => {
		const gesture = new OverscrollGesture(options);
		let now = 10_000;
		gesture.wheel(100, true, now);
		assert.ok(gesture.progress > 0);
		gesture.wheel(-20, true, now += 16);
		assert.strictEqual(gesture.progress, 0);
		// And it needs a pause again before counting.
		assert.strictEqual(gesture.wheel(100, true, now += 16).progress, 0);
	});

	test('stopping short lets go after a pause', () => {
		const gesture = new OverscrollGesture(options);
		gesture.wheel(100, true, 10_000);
		assert.ok(gesture.idle(10_100) > 0);
		assert.strictEqual(gesture.idle(10_500), 0);
		// A later gesture starts again from nothing.
		assert.strictEqual(gesture.wheel(60, true, 11_000).progress, 0.2);
	});

	test('after a view switch the momentum that follows is ignored', () => {
		const gesture = new OverscrollGesture(options);
		gesture.block(10_000);
		assert.strictEqual(gesture.wheel(100, true, 10_016).progress, 0);
		assert.ok(gesture.wheel(100, true, 10_400).progress > 0);
	});
});

suite('Active agent grid helpers', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const agent = (id: string, extra: Partial<AgentInfo> = {}): AgentInfo => ({ id, name: id, colorIndex: 0, kind: 'agent', root: `/${id}`, inMainFolder: false, status: 'idle', waitingForApproval: false, explainMode: 'auto', approvalMode: 'auto', createdAt: 0, ...extra });

	test('merged agents show inside the agent they went into; subagents get boxes of their own', () => {
		const agents = [agent('a'), agent('b', { mergedInto: 'a' }), agent('s', { kind: 'subagent', parentId: 'b' }), agent('c')];
		assert.deepStrictEqual(agents.map(item => topLevelOf(item, agents).id), ['a', 'a', 's', 'c']);
	});

	test('finished helpers linger, fade out, then leave (unless highlighted or kept)', () => {
		const done = agent('h', { kind: 'subagent', parentId: 'a', finished: true, finishedAt: 1000 });
		const agents = [agent('a'), done];
		const at = (now: number, highlighted = 'a', keep = false) => shownAgents(agents, highlighted, keep, now);
		assert.deepStrictEqual(at(1000 + HELPER_LINGER_MS - 1).shown.map(item => item.id), ['a', 'h']);
		assert.strictEqual(at(1000 + HELPER_LINGER_MS - 1).next, 1000 + HELPER_LINGER_MS);
		assert.ok(at(1000 + HELPER_LINGER_MS + 10).leaving.has('h'));
		assert.deepStrictEqual(at(1000 + HELPER_LINGER_MS + HELPER_LEAVE_MS).shown.map(item => item.id), ['a']);
		assert.deepStrictEqual(at(99_999, 'h').shown.map(item => item.id), ['a', 'h'], 'a highlighted helper stays');
		assert.deepStrictEqual(at(99_999, 'a', true).shown.map(item => item.id), ['a', 'h'], 'kept when the developer chose to');
	});

	test('overlap markers name the other agent, likely conflicts first', () => {
		const markers = overlapMarkers('a', [
			{ agents: ['a', 'b'], files: [{ path: 'x.ts', sameLines: false }] },
			{ agents: ['c', 'a'], files: [{ path: 'y.ts', sameLines: true }, { path: 'z.ts', sameLines: false }] },
			{ agents: ['b', 'c'], files: [{ path: 'w.ts', sameLines: true }] },
		]);
		assert.deepStrictEqual(markers, [{ otherId: 'c', conflict: true, files: ['y.ts', 'z.ts'] }, { otherId: 'b', conflict: false, files: ['x.ts'] }]);
	});

	test('markdown becomes a plain line for a box', () => {
		assert.strictEqual(plainText('## Done\n- Fixed **the** `parser` in [cli](cli.ts)\n```ts\nx\n```'), 'Done Fixed the parser in cli [code]');
	});
});
