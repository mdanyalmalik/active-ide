/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildCleanupPrompt, nameParts, pickVocabulary, sanitizeCleanup, transcribeErrorKind } from '../dictation/cleanup';

describe('dictation cleanup', () => {
	test('names split into the words a person would say', () => {
		assert.deepEqual(nameParts('loadConfig'), ['load', 'config']);
		assert.deepEqual(nameParts('src/configLoader.ts'), ['config', 'loader']);
		assert.deepEqual(nameParts('MAX_RETRY_COUNT'), ['max', 'retry', 'count']);
		assert.deepEqual(nameParts('HTTPServer'), ['http', 'server']);
		assert.deepEqual(nameParts('fetch_user_v2'), ['fetch', 'user', 'v2']);
	});

	test('only names the transcript seems to mention are sent', () => {
		const raw = 'rename load config to load settings and retry the fetch users call';
		const picked = pickVocabulary(raw, ['loadConfig', 'loadSettings', 'src/fetchUser.ts', 'renderGrid', 'config', 'agentGrid.ts', 'loadConfig']);
		assert.deepEqual(picked.slice().sort(), ['fetchUser.ts', 'loadConfig', 'loadSettings']);
		// Plain lower-case words carry nothing to spell.
		assert.ok(!picked.includes('config'));
		assert.deepEqual(pickVocabulary(raw, Array.from({ length: 50 }, (_, i) => `loadConfig${i}`), 5).length, 5);
	});

	test('the prompt is small, fences the transcript and says not to answer', () => {
		const prompt = buildCleanupPrompt('um so uh fix the bug', ['fetchUser'], ['Muse', ' '], 'Earlier I said');
		assert.match(prompt, /<dictation>um so uh fix the bug<\/dictation>$/);
		assert.match(prompt, /never answer/);
		assert.match(prompt, /Muse, fetchUser/);
		assert.match(prompt, /It continues: "Earlier I said"/);
		assert.ok(prompt.length < 700, `prompt is ${prompt.length} characters`);
		assert.ok(!/Spell these/.test(buildCleanupPrompt('hello', [], [])));
	});

	test('replies are trimmed of wrappers; answers and empty replies fall back', () => {
		const raw = 'um can you rename load config';
		assert.equal(sanitizeCleanup('Can you rename loadConfig?', raw), 'Can you rename loadConfig?');
		assert.equal(sanitizeCleanup('```\nCan you rename loadConfig?\n```', raw), 'Can you rename loadConfig?');
		assert.equal(sanitizeCleanup('<dictation>Can you rename loadConfig?</dictation>', raw), 'Can you rename loadConfig?');
		assert.equal(sanitizeCleanup('Here is the cleaned text: Can you rename loadConfig?', raw), 'Can you rename loadConfig?');
		assert.equal(sanitizeCleanup('"Can you rename loadConfig?"', raw), 'Can you rename loadConfig?');
		assert.equal(sanitizeCleanup('   ', raw), undefined);
		assert.equal(sanitizeCleanup('Sure! To rename loadConfig, open the file, find every reference to it, and then use your editor\'s rename symbol command so all imports update too.', raw), undefined);
	});

	test('transcription errors are told apart', () => {
		assert.equal(transcribeErrorKind(4, 'no speech credential: voice authentication unavailable'), 'signedOut');
		assert.equal(transcribeErrorKind(7, 'no words heard: voice session closed before final transcript'), 'empty');
		assert.equal(transcribeErrorKind('ENOENT', 'spawn muse ENOENT'), 'unavailable');
		assert.equal(transcribeErrorKind(1, 'something else'), 'failed');
	});
});
