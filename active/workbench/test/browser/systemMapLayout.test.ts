/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { layoutMap, mapBounds, NODE_HEIGHT, NODE_WIDTH } from '../../browser/systemMapLayout.js';

suite('Active system map layout', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const columnOf = (positions: Map<string, { x: number }>) => Object.fromEntries([...positions].map(([id, point]) => [id, Math.round(point.x / (NODE_WIDTH + 150))]));

	test('components flow left to right along their connections', () => {
		const positions = layoutMap(['store', 'cli', 'api', 'tests'], [{ from: 'cli', to: 'api' }, { from: 'api', to: 'store' }, { from: 'tests', to: 'api' }]);
		assert.deepStrictEqual(columnOf(positions), { store: 2, cli: 0, api: 1, tests: 0 });
	});

	test('a cycle still lays out, every component in a column', () => {
		const positions = layoutMap(['a', 'b', 'c'], [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }, { from: 'c', to: 'a' }]);
		assert.deepStrictEqual(Object.values(columnOf(positions)).sort(), [0, 1, 2]);
	});

	test('components that already have a place keep it; new ones are placed without overlapping anything', () => {
		const kept = new Map([['cli', { x: 500, y: 40 }], ['api', { x: 900, y: 40 }]]);
		const positions = layoutMap(['cli', 'api', 'cache', 'store'], [{ from: 'cli', to: 'api' }, { from: 'api', to: 'cache' }, { from: 'api', to: 'store' }], kept);
		assert.deepStrictEqual([positions.get('cli'), positions.get('api')], [{ x: 500, y: 40 }, { x: 900, y: 40 }]);
		const boxes = [...positions.values()];
		const overlapping = boxes.some((a, i) => boxes.some((b, j) => i < j && Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) < NODE_HEIGHT));
		assert.strictEqual(overlapping, false);
	});

	test('a component split out of a kept one lands a whole row away, not on top of it', () => {
		// The middleware keeps its place; the limiter split out of it belongs in the same column.
		const kept = new Map([['client', { x: 0, y: 0 }], ['api', { x: 390, y: 0 }], ['middleware', { x: 780, y: 0 }], ['store', { x: 1170, y: 76 }]]);
		const edges = [{ from: 'client', to: 'api' }, { from: 'api', to: 'middleware' }, { from: 'api', to: 'limiter' }, { from: 'middleware', to: 'store' }];
		const positions = layoutMap(['client', 'api', 'middleware', 'limiter', 'store'], edges, kept);
		const limiter = positions.get('limiter')!;
		for (const [id, point] of positions) {
			if (id !== 'limiter' && Math.abs(point.x - limiter.x) < NODE_WIDTH) {
				assert.ok(Math.abs(point.y - limiter.y) >= NODE_HEIGHT + 56, `${id} is too close to the limiter`);
			}
		}
	});

	test('a remembered place that something else now occupies is moved, not reused', () => {
		// The limiter was remembered from an older version at the spot the middleware holds now.
		const kept = new Map([['middleware', { x: 780, y: 0 }], ['limiter', { x: 780, y: 40 }]]);
		const positions = layoutMap(['middleware', 'limiter'], [{ from: 'middleware', to: 'limiter' }], kept);
		assert.deepStrictEqual(positions.get('middleware'), { x: 780, y: 0 });
		assert.ok(Math.abs(positions.get('limiter')!.y - 0) >= NODE_HEIGHT + 56);
	});

	test('remembered places close together but not overlapping are kept as they are', () => {
		const kept = new Map([['store', { x: 1950, y: 76 }], ['file', { x: 1950, y: 76 + NODE_HEIGHT + 10 }]]);
		const positions = layoutMap(['store', 'file'], [{ from: 'store', to: 'file' }], kept);
		assert.deepStrictEqual([positions.get('store'), positions.get('file')], [kept.get('store'), kept.get('file')]);
	});

	test('the bounds cover every box', () => {
		assert.deepStrictEqual(mapBounds([{ x: 0, y: 0 }, { x: 300, y: 200 }]), { x: 0, y: 0, width: 300 + NODE_WIDTH, height: 200 + NODE_HEIGHT });
	});
});
