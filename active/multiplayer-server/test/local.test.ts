/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startLocalServer, type LocalServer } from '../src/local.ts';
import { CloseCode } from '../src/room.ts';

/** A client on Node's built-in WebSocket that queues incoming messages for `next()`. */
class Client {
	readonly ws: WebSocket;
	readonly closed: Promise<{ code: number }>;
	private readonly inbox: unknown[] = [];
	private waiter: ((msg: unknown) => void) | undefined;

	constructor(url: string) {
		this.ws = new WebSocket(url);
		this.ws.addEventListener('message', e => {
			const msg = JSON.parse(String(e.data));
			if (this.waiter) {
				const w = this.waiter;
				this.waiter = undefined;
				w(msg);
			} else {
				this.inbox.push(msg);
			}
		});
		this.closed = new Promise(resolve => this.ws.addEventListener('close', e => resolve({ code: e.code })));
	}

	next(): Promise<any> {
		if (this.inbox.length) {
			return Promise.resolve(this.inbox.shift());
		}
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => reject(new Error('timed out waiting for a message')), 2000);
			this.waiter = msg => { clearTimeout(timer); resolve(msg); };
		});
	}

	async send(msg: unknown): Promise<void> {
		if (this.ws.readyState === WebSocket.CONNECTING) {
			await new Promise(resolve => this.ws.addEventListener('open', resolve, { once: true }));
		}
		this.ws.send(JSON.stringify(msg));
	}
}

describe('local server', () => {
	let local: LocalServer;
	let wsBase: string;
	before(async () => {
		local = await startLocalServer(0);
		wsBase = local.url.replace(/^http/, 'ws');
	});
	after(() => local.close());

	const createRoom = async () => {
		const res = await fetch(`${local.url}/rooms`, { method: 'POST' });
		assert.equal(res.status, 201);
		assert.equal(res.headers.get('access-control-allow-origin'), '*');
		return await res.json() as { roomId: string; hostToken: string };
	};

	it('serves /turn with no ICE servers and answers CORS preflight', async () => {
		assert.deepEqual(await (await fetch(`${local.url}/turn`)).json(), { iceServers: [] });
		const pre = await fetch(`${local.url}/rooms`, { method: 'OPTIONS' });
		assert.equal(pre.status, 204);
		assert.match(pre.headers.get('access-control-allow-methods') ?? '', /POST/);
		assert.equal((await fetch(`${local.url}/nope`)).status, 404);
	});

	it('drives a host and a guest through join, admit, signal and host-left', async () => {
		const { roomId, hostToken } = await createRoom();
		assert.match(roomId, /^[a-z2-7]{10}$/);
		assert.ok(hostToken.length >= 43);

		const bad = new Client(`${wsBase}/rooms/${roomId}/ws?role=host&token=wrong`);
		assert.deepEqual(await bad.next(), { type: 'error', message: 'invalid host token' });
		assert.equal((await bad.closed).code, CloseCode.unauthorised);

		const host = new Client(`${wsBase}/rooms/${roomId}/ws?role=host&token=${encodeURIComponent(hostToken)}`);
		await new Promise(resolve => host.ws.addEventListener('open', resolve, { once: true }));

		const guest = new Client(`${wsBase}/rooms/${roomId}/ws?role=guest&name=${encodeURIComponent('Ada Lovelace')}`);
		assert.deepEqual(await guest.next(), { type: 'pending' });
		const request = await host.next();
		assert.equal(request.type, 'join-request');
		assert.equal(request.name, 'Ada Lovelace');

		await host.send({ type: 'admit', peerId: request.peerId });
		assert.deepEqual(await guest.next(), { type: 'admitted', peerId: request.peerId });

		await host.send({ type: 'signal', to: request.peerId, data: { sealed: 'offer' } });
		assert.deepEqual(await guest.next(), { type: 'signal', from: 'host', data: { sealed: 'offer' } });
		await guest.send({ type: 'signal', data: { sealed: 'answer' } });
		assert.deepEqual(await host.next(), { type: 'signal', from: request.peerId, data: { sealed: 'answer' } });

		await guest.send({ type: 'signal', data: 'x'.repeat(70 * 1024) });
		assert.equal((await guest.next()).type, 'error');

		host.ws.close();
		assert.deepEqual(await guest.next(), { type: 'host-left' });
		assert.equal((await guest.closed).code, CloseCode.hostLeft);

		// The room is gone: the token no longer works.
		const again = new Client(`${wsBase}/rooms/${roomId}/ws?role=host&token=${encodeURIComponent(hostToken)}`);
		assert.deepEqual(await again.next(), { type: 'error', message: 'room not found' });
		assert.equal((await again.closed).code, CloseCode.notFound);
	});
});
