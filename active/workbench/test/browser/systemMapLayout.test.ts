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

	test('the bounds cover every box', () => {
		assert.deepStrictEqual(mapBounds([{ x: 0, y: 0 }, { x: 300, y: 200 }]), { x: 0, y: 0, width: 300 + NODE_WIDTH, height: 200 + NODE_HEIGHT });
	});
});
