/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { buildCodeQuestionPrompt, composeCodeTask } from '../explain/prompts';
import { DEFAULT_PROFILE, describeCodeSelection } from '../shared/activeProtocol';

describe('Asking about code, and asking for changes to it', () => {
	test('chat names code by file and lines', () => {
		assert.equal(describeCodeSelection({ file: 'src/net/client.js', startLine: 3, endLine: 8 }), 'client.js loc 3–8');
		assert.equal(describeCodeSelection({ file: 'src/net/client.js', startLine: 12, endLine: 12 }), 'client.js loc 12');
	});

	test('a question about a selection gives the explainer the file, the lines and the selected code', () => {
		const prompt = buildCodeQuestionPrompt('why does it loop?', { file: 'src/client.js', startLine: 3, endLine: 5, text: 'for (;;) {\n  await take();\n}' }, DEFAULT_PROFILE);
		assert.match(prompt, /You only read; never modify files/);
		assert.match(prompt, /THE SELECTION\nsrc\/client\.js, lines 3-5:\n```\nfor \(;;\) \{\n  await take\(\);\n\}\n```/);
		assert.match(prompt, /QUESTION\nwhy does it loop\?$/);
	});

	test('a change asked for while pointing at code gives the agent that code and the card as context, not as the only place to edit', () => {
		assert.equal(composeCodeTask({ text: 'Retry at most 3 times', code: { file: 'src/client.js', startLine: 3, endLine: 8 }, explanation: { title: 'Retrying on 429', text: 'It loops until the server says yes.' } }), [
			'Retry at most 3 times',
			'',
			'Context: the developer asked for this while looking at src/client.js, lines 3-8 in Active\'s walkthrough (the file may have changed since). The change may be to that code or elsewhere based on it; use your judgment.',
			'',
			'The explanation they were reading ("Retrying on 429"): It loops until the server says yes.',
		].join('\n'));
		assert.equal(composeCodeTask({ text: ' Rename it ', code: { file: 'a.py', startLine: 1, endLine: 1, text: 'x = 1' } }), 'Rename it\n\nContext: the developer asked for this while looking at a.py, lines 1-1. The change may be to that code or elsewhere based on it; use your judgment.\n```\nx = 1\n```');
	});
});
