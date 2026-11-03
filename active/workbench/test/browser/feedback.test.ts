/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { feedbackEmail } from '../../browser/feedback.js';

suite('Active feedback', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('a bug report has a template to fill in, then the facts', () => {
		const { subject, body } = feedbackEmail('bug', 'Map never loads', [['Active', 'Active 1.0'], ['OS', 'macOS']]);
		assert.deepStrictEqual({ subject, lines: body.split('\n') }, {
			subject: '[Active bug] Map never loads',
			lines: ['What happened:', '', '', 'What you expected:', '', '', 'Steps to reproduce:', '1. ', '', '--', 'Active: Active 1.0', 'OS: macOS'],
		});
	});

	test('a feature request asks what and why', () => {
		const { subject, body } = feedbackEmail('feature', 'Dark map', []);
		assert.deepStrictEqual({ subject, lines: body.split('\n') }, { subject: '[Active idea] Dark map', lines: ['What you would like:', '', '', 'Why it would help:', '', '', '--'] });
	});
});
