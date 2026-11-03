/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { getIceServers, PUBLIC_STUN, type FetchLike } from '../src/turn.ts';

const secrets = { TURN_KEY_ID: 'key-id', TURN_KEY_API_TOKEN: 'secret' };

function stub(status: number, body: unknown, calls: unknown[] = []): FetchLike {
	return async (url, init) => {
		calls.push({ url, init });
		return { ok: status >= 200 && status < 300, status, json: async () => body };
	};
}

describe('getIceServers', () => {
	it('is STUN only without secrets', async () => {
		assert.deepEqual(await getIceServers({}, stub(500, null)), [PUBLIC_STUN]);
	});

	it('calls the Cloudflare API and drops port 53 URLs', async () => {
		const calls: Array<{ url: string; init: { headers: Record<string, string>; body: string } }> = [];
		const servers = await getIceServers(secrets, stub(201, {
			iceServers: [
				{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.cloudflare.com:53'] },
				{ urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp'], username: 'u', credential: 'c' },
			],
		}, calls));
		assert.equal(calls[0].url, 'https://rtc.live.cloudflare.com/v1/turn/keys/key-id/credentials/generate-ice-servers');
		assert.equal(calls[0].init.headers.Authorization, 'Bearer secret');
		assert.deepEqual(JSON.parse(calls[0].init.body), { ttl: 86400 });
		assert.deepEqual(servers, [
			{ urls: ['stun:stun.cloudflare.com:3478'] },
			{ urls: ['turn:turn.cloudflare.com:3478?transport=udp'], username: 'u', credential: 'c' },
		]);
	});

	it('accepts the older single-object shape and adds STUN', async () => {
		const servers = await getIceServers(secrets, stub(201, { iceServers: { urls: 'turn:t:3478', username: 'u', credential: 'c' } }));
		assert.deepEqual(servers, [PUBLIC_STUN, { urls: ['turn:t:3478'], username: 'u', credential: 'c' }]);
	});

	it('falls back to STUN when the API fails', async () => {
		const quiet = console.error;
		console.error = () => { };
		try {
			assert.deepEqual(await getIceServers(secrets, stub(401, {})), [PUBLIC_STUN]);
			assert.deepEqual(await getIceServers(secrets, async () => { throw new Error('offline'); }), [PUBLIC_STUN]);
		} finally {
			console.error = quiet;
		}
	});
});
