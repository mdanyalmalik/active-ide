/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { mainWindow } from '../../../../../base/browser/window.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { TreeMotion } from '../../browser/explorerGuide.js';

const HEIGHT = 22;

/** A stand-in for a list's rows container: rows placed like Code OSS's list places them. */
class FakeRows {
	readonly element = mainWindow.document.createElement('div');

	constructor(items: readonly string[]) {
		this.element.className = 'monaco-list-rows';
		items.forEach((item, index) => this.element.appendChild(this.row(item, index)));
		mainWindow.document.body.appendChild(this.element);
	}

	/** `name` is "indent + label"; a trailing "/" makes it a folder, "+" an open one. */
	row(name: string, index: number): HTMLElement {
		const row = mainWindow.document.createElement('div');
		row.className = 'monaco-list-row';
		const label = name.trim().replace(/[/+]$/, '');
		row.dataset.label = label;
		row.setAttribute('aria-level', String((name.length - name.trimStart().length) / 2 + 1));
		const content = mainWindow.document.createElement('div');
		content.className = 'monaco-tl-row';
		if (/[/+]$/.test(name)) {
			content.setAttribute('aria-expanded', String(name.endsWith('+')));
		}
		row.appendChild(content);
		this.place(row, index);
		return row;
	}

	place(row: HTMLElement, index: number): void {
		row.style.top = `${index * HEIGHT}px`;
		row.setAttribute('data-index', String(index));
	}

	get(label: string): HTMLElement {
		return [...this.element.children].find(row => (row as HTMLElement).dataset.label === label) as HTMLElement;
	}

	setExpanded(label: string, expanded: boolean): void {
		this.get(label).querySelector('.monaco-tl-row')!.setAttribute('aria-expanded', String(expanded));
	}

	/** Moves the rows from `from` on by `shift` places. */
	shift(from: number, shift: number): void {
		for (const row of [...this.element.children] as HTMLElement[]) {
			const index = Number(row.getAttribute('data-index'));
			if (index >= from) {
				this.place(row, index + shift);
			}
		}
	}

	dispose(): void {
		this.element.remove();
	}
}

const mutationsDelivered = () => new Promise(resolve => setTimeout(resolve, 0));

suite('Active TreeMotion: folders open and close smoothly, whoever toggles them', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let rows: FakeRows;
	let played: string[];
	let reduced: boolean;
	let now: number;

	setup(() => {
		played = [];
		reduced = false;
		now = 0;
	});

	teardown(() => rows?.dispose());

	function motion(items: readonly string[]): TreeMotion {
		rows = new FakeRows(items);
		return store.add(new TreeMotion(rows.element, () => reduced, (element, keyframes) => {
			const first = keyframes[0];
			const label = element.dataset.label ?? '?';
			const kind = element.classList.contains('active-tree-ghost') ? 'fold away' : first.clipPath ? 'unfold' : first.opacity === 0 ? 'fade in' : `slide ${first.transform}`;
			played.push(`${label}: ${kind}`);
		}, () => now));
	}

	test('opening a folder: its children unfold from under it, the rows below slide down', async () => {
		motion(['src/', 'test/', 'README.md']);
		rows.setExpanded('src', true);
		rows.shift(1, 2);
		rows.element.appendChild(rows.row('  a.js', 1));
		rows.element.appendChild(rows.row('  b.js', 2));
		await mutationsDelivered();
		assert.deepStrictEqual(played.sort(), ['README.md: slide translateY(-44px)', 'a.js: unfold', 'b.js: unfold', 'test: slide translateY(-44px)']);
	});

	test('closing a folder: copies of its children fold away under it, the rows below slide up', async () => {
		const tree = motion(['src+', '  a.js', '  b.js', 'test/', 'README.md']);
		tree.capture();
		rows.setExpanded('src', false);
		rows.get('a.js').remove();
		rows.get('b.js').remove();
		rows.shift(3, -2);
		await mutationsDelivered();
		assert.deepStrictEqual(played.sort(), ['README.md: slide translateY(44px)', 'a.js: fold away', 'b.js: fold away', 'test: slide translateY(44px)']);
	});

	test('closing a folder whose rows the list reuses for rows coming into view below: still animated', async () => {
		const tree = motion(['src+', '  lib+', 'test/']);
		tree.capture();
		rows.setExpanded('src', false);
		// The list hands the "lib" row element to an item scrolling into view further down, a closed folder.
		const reused = rows.get('lib');
		reused.dataset.label = 'docs';
		rows.place(reused, 5);
		reused.querySelector('.monaco-tl-row')!.setAttribute('aria-expanded', 'false');
		rows.shift(2, -1);
		rows.place(reused, 5);
		await mutationsDelivered();
		assert.deepStrictEqual(played.sort(), ['docs: fade in', 'lib: fold away', 'test: slide translateY(22px)']);
	});

	test('closing without a recent copy of the rows: the rows below still slide up', async () => {
		const tree = motion(['src+', '  a.js', 'test/']);
		tree.capture();
		now += 5000;
		rows.setExpanded('src', false);
		rows.get('a.js').remove();
		rows.shift(2, -1);
		await mutationsDelivered();
		assert.deepStrictEqual(played, ['test: slide translateY(22px)']);
	});

	test('a folder whose children load later: they unfold when they arrive', async () => {
		motion(['src/', 'test/']);
		rows.setExpanded('src', true);
		await mutationsDelivered();
		assert.deepStrictEqual(played, []);
		now += 400;
		rows.shift(1, 1);
		rows.element.appendChild(rows.row('  a.js', 1));
		await mutationsDelivered();
		assert.deepStrictEqual(played.sort(), ['a.js: unfold', 'test: slide translateY(-22px)']);
	});

	test('scrolling: rows reused for other items (even folders) are not animated', async () => {
		motion(['src+', '  a.js', 'test/']);
		// The list reuses the folder's row element for another folder further down, collapsed.
		const reused = rows.get('src');
		rows.place(reused, 7);
		reused.querySelector('.monaco-tl-row')!.setAttribute('aria-expanded', 'false');
		await mutationsDelivered();
		assert.deepStrictEqual(played, []);
	});

	test('many folders at once (a refresh, Collapse All): no animation', async () => {
		motion(['src+', '  a.js', 'test+', '  t.js']);
		rows.setExpanded('src', false);
		rows.setExpanded('test', false);
		rows.get('a.js').remove();
		rows.get('t.js').remove();
		rows.place(rows.get('test'), 1);
		await mutationsDelivered();
		assert.deepStrictEqual(played, []);
	});

	test('with reduced motion: nothing moves', async () => {
		motion(['src/', 'test/']);
		reduced = true;
		rows.setExpanded('src', true);
		rows.shift(1, 1);
		rows.element.appendChild(rows.row('  a.js', 1));
		await mutationsDelivered();
		assert.deepStrictEqual(played, []);
	});

	test('a folder at the bottom (nothing below it on screen): its children still unfold', async () => {
		motion(['README.md', 'src/']);
		rows.setExpanded('src', true);
		rows.element.appendChild(rows.row('  a.js', 2));
		rows.element.appendChild(rows.row('  b.js', 3));
		await mutationsDelivered();
		assert.deepStrictEqual(played.sort(), ['a.js: unfold', 'b.js: unfold']);
	});
});
