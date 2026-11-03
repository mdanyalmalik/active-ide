/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { cheapestModel, encodeWav, identifiersIn, insertAtCursor, joinPcm } from '../../browser/dictation.js';

suite('Active dictation', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('PCM16 is wrapped in a 16 kHz mono WAV header', () => {
		const pcm = new Uint8Array([1, 0, 2, 0, 0xff, 0x7f]);
		const wav = encodeWav(pcm);
		const view = new DataView(wav.buffer);
		const text = (offset: number, length: number) => String.fromCharCode(...wav.subarray(offset, offset + length));
		assert.strictEqual(wav.byteLength, 44 + 6);
		assert.strictEqual(text(0, 4), 'RIFF');
		assert.strictEqual(view.getUint32(4, true), 36 + 6);
		assert.strictEqual(text(8, 8), 'WAVEfmt ');
		assert.strictEqual(view.getUint32(16, true), 16);
		assert.strictEqual(view.getUint16(20, true), 1);
		assert.strictEqual(view.getUint16(22, true), 1);
		assert.strictEqual(view.getUint32(24, true), 16000);
		assert.strictEqual(view.getUint32(28, true), 32000);
		assert.strictEqual(view.getUint16(32, true), 2);
		assert.strictEqual(view.getUint16(34, true), 16);
		assert.strictEqual(text(36, 4), 'data');
		assert.strictEqual(view.getUint32(40, true), 6);
		assert.deepStrictEqual([...wav.subarray(44)], [...pcm]);
		assert.strictEqual(new DataView(encodeWav(pcm, 24000).buffer).getUint32(24, true), 24000);
	});

	test('chunks are joined in order, dropping a stray odd byte', () => {
		assert.deepStrictEqual([...joinPcm([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])])], [1, 2, 3, 4]);
		assert.strictEqual(joinPcm([]).byteLength, 0);
	});

	test('dictated text goes in at the cursor without running words together', () => {
		assert.deepStrictEqual(insertAtCursor('', 0, 0, 'Fix it.'), { value: 'Fix it.', cursor: 7 });
		assert.deepStrictEqual(insertAtCursor('Please', 6, 6, 'fix it'), { value: 'Please fix it', cursor: 13 });
		assert.deepStrictEqual(insertAtCursor('Please now', 7, 7, 'fix it'), { value: 'Please fix it now', cursor: 13 });
		assert.deepStrictEqual(insertAtCursor('Please.', 6, 6, 'go'), { value: 'Please go.', cursor: 9 });
		// A selection is replaced.
		assert.deepStrictEqual(insertAtCursor('a XX b', 2, 4, 'yy'), { value: 'a yy b', cursor: 4 });
	});

	test('code names on screen are offered; plain words are not', () => {
		const names = identifiersIn('const loadConfig = readSettings(MAX_RETRY); loadConfig(); return value; class AgentGrid {} the word');
		assert.deepStrictEqual(names[0], 'loadConfig');
		assert.ok(names.includes('readSettings') && names.includes('MAX_RETRY') && names.includes('AgentGrid'));
		assert.ok(!names.includes('const') && !names.includes('value') && !names.includes('return'));
	});

	test('the cheapest listed model is picked for cleanup', () => {
		assert.strictEqual(cheapestModel([
			{ id: 'big', label: 'big', inputCost: '4', outputCost: '20', efforts: [] },
			{ id: 'cheap', label: 'cheap', inputCost: '0.10', outputCost: '0.20', efforts: [] },
			{ id: 'unpriced', label: 'unpriced', efforts: [] },
		]), 'cheap');
		assert.strictEqual(cheapestModel([{ id: 'unpriced', label: 'unpriced', efforts: [] }]), undefined);
	});
});
