import assert from 'node:assert/strict';
import test from 'node:test';
import { parseDuration } from '../src/duration.js';

test('parses seconds', () => {
	assert.equal(parseDuration('30s'), 30000);
});
