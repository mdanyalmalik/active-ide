/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CloseCode, MAX_GUESTS, MAX_MESSAGE_BYTES, parseConnectParams, SignallingRoom, type ConnectionInfo, type ServerMessage } from '../src/room.ts';

/** A fake socket that records what the room sent it and how it was closed. */
class Conn {
	readonly name: string;
	readonly sent: ServerMessage[] = [];
	closed: { code: number; reason: string } | undefined;
	info: ConnectionInfo | undefined;
	constructor(name: string) { this.name = name; }
	last(): ServerMessage | undefined { return this.sent[this.sent.length - 1]; }
	take(): ServerMessage[] { return this.sent.splice(0); }
}

function setup(options: { maxGuests?: number } = {}) {
	let ended = 0;
	let nextId = 0;
	const room = new SignallingRoom<Conn>({
		send: (c, m) => c.sent.push(m),
		close: (c, code, reason) => { c.closed = { code, reason }; },
		save: (c, info) => { c.info = info; },
		ended: () => { ended++; },
	}, { ...options, newPeerId: () => `p${++nextId}` });
	const host = new Conn('host');
	assert.equal(room.connectHost(host), true);
	return { room, host, endedCount: () => ended };
}

const send = (room: SignallingRoom<Conn>, conn: Conn, msg: unknown) => room.message(conn, JSON.stringify(msg));

/** Joins a guest and returns it with its peer id; optionally admits it. */
function join(room: SignallingRoom<Conn>, host: Conn, name: string, admit = false) {
	const guest = new Conn(name);
	assert.equal(room.connectGuest(guest, name), true);
	const request = host.take().find(m => m.type === 'join-request');
	assert.ok(request && request.type === 'join-request');
	if (admit) {
		send(room, host, { type: 'admit', peerId: request.peerId });
	}
	return { guest, peerId: request.peerId };
}

describe('SignallingRoom', () => {
	it('tells a new guest it is pending and asks the host', () => {
		const { room, host } = setup();
		const guest = new Conn('ada');
		room.connectGuest(guest, 'Ada');
		assert.deepEqual(guest.sent, [{ type: 'pending' }]);
		assert.deepEqual(host.sent, [{ type: 'join-request', peerId: 'p1', name: 'Ada' }]);
		assert.deepEqual(guest.info, { role: 'guest', peerId: 'p1', name: 'Ada', admitted: false });
	});

	it('admits a guest', () => {
		const { room, host } = setup();
		const { guest, peerId } = join(room, host, 'Ada');
		send(room, host, { type: 'admit', peerId });
		assert.deepEqual(guest.last(), { type: 'admitted', peerId });
		assert.equal(guest.info?.role === 'guest' && guest.info.admitted, true);
		send(room, host, { type: 'admit', peerId });
		assert.equal(host.last()?.type, 'error');
	});

	it('denies a pending guest and closes it, with an optional reason', () => {
		const { room, host } = setup();
		const a = join(room, host, 'Ada');
		send(room, host, { type: 'deny', peerId: a.peerId, reason: 'not today' });
		assert.deepEqual(a.guest.last(), { type: 'denied', reason: 'not today' });
		assert.equal(a.guest.closed?.code, CloseCode.denied);
		assert.equal(room.guestCount, 0);

		const b = join(room, host, 'Bob');
		send(room, host, { type: 'deny', peerId: b.peerId });
		assert.deepEqual(b.guest.last(), { type: 'denied' });
		// The close event that follows is harmless and doesn't report peer-left.
		room.disconnect(b.guest);
		assert.deepEqual(host.sent, []);
	});

	it('kicks an admitted guest', () => {
		const { room, host } = setup();
		const { guest, peerId } = join(room, host, 'Ada', true);
		send(room, host, { type: 'deny', peerId });
		assert.equal(host.last()?.type, 'error', 'deny is only for pending guests');
		send(room, host, { type: 'kick', peerId });
		assert.deepEqual(guest.last(), { type: 'kicked' });
		assert.equal(guest.closed?.code, CloseCode.kicked);
		send(room, guest, { type: 'signal', data: 'x' });
		assert.deepEqual(guest.last(), { type: 'kicked' }, 'a removed guest is ignored');
	});

	it('relays opaque signals both ways, only for admitted guests', () => {
		const { room, host } = setup();
		const { guest, peerId } = join(room, host, 'Ada');
		send(room, guest, { type: 'signal', data: 'early' });
		assert.deepEqual(guest.last(), { type: 'error', message: 'not admitted yet' });
		send(room, host, { type: 'signal', to: peerId, data: 'early' });
		assert.equal(host.last()?.type, 'error');

		send(room, host, { type: 'admit', peerId });
		const blob = { iv: 'abc', ct: 'ZGF0YQ', nested: [1, null, true] };
		send(room, host, { type: 'signal', to: peerId, data: blob });
		assert.deepEqual(guest.last(), { type: 'signal', from: 'host', data: blob });
		send(room, guest, { type: 'signal', data: 'reply', to: 'someone-else' });
		assert.deepEqual(host.last(), { type: 'signal', from: peerId, data: 'reply' });
		send(room, guest, { type: 'signal' });
		assert.deepEqual(guest.last(), { type: 'error', message: 'missing data' });
	});

	it('only lets the host admit, deny, kick and address peers', () => {
		const { room, host } = setup();
		const a = join(room, host, 'Ada', true);
		const b = join(room, host, 'Bob');
		send(room, a.guest, { type: 'admit', peerId: b.peerId });
		assert.equal(a.guest.last()?.type, 'error');
		send(room, a.guest, { type: 'kick', peerId: b.peerId });
		assert.equal(b.guest.closed, undefined);
		send(room, host, { type: 'kick', peerId: 'nobody' });
		assert.deepEqual(host.last(), { type: 'error', message: 'unknown peer' });
	});

	it('rejects malformed, binary and oversized frames without closing', () => {
		const { room, host } = setup();
		for (const frame of ['not json', '[1,2]', 'null', '"str"', '{}']) {
			room.message(host, frame);
			assert.equal(host.last()?.type, 'error', frame);
		}
		room.message(host, new Uint8Array([1, 2, 3]));
		assert.equal(host.last()?.type, 'error');
		const { peerId } = join(room, host, 'Ada', true);
		room.message(host, JSON.stringify({ type: 'signal', to: peerId, data: 'x'.repeat(MAX_MESSAGE_BYTES) }));
		assert.deepEqual(host.last(), { type: 'error', message: `message exceeds ${MAX_MESSAGE_BYTES} bytes` });
		// Multi-byte characters are counted as UTF-8 bytes, not string length.
		room.message(host, JSON.stringify({ type: 'signal', to: peerId, data: 'é'.repeat(MAX_MESSAGE_BYTES / 2) }));
		assert.equal(host.last()?.type, 'error');
		assert.equal(host.closed, undefined);
	});

	it('caps pending plus admitted guests', () => {
		const { room, host } = setup();
		const guests = Array.from({ length: MAX_GUESTS }, (_, i) => join(room, host, `g${i}`, i % 2 === 0));
		const extra = new Conn('extra');
		assert.equal(room.connectGuest(extra, 'Extra'), false);
		assert.deepEqual(extra.sent, [{ type: 'error', message: 'room is full' }]);
		assert.equal(extra.closed?.code, CloseCode.full);
		// Leaving frees a slot.
		room.disconnect(guests[0].guest);
		assert.deepEqual(host.last(), { type: 'peer-left', peerId: guests[0].peerId });
		assert.equal(room.connectGuest(new Conn('later'), 'Later'), true);
	});

	it('tells the host when a pending or admitted guest leaves', () => {
		const { room, host } = setup();
		const a = join(room, host, 'Ada');
		room.disconnect(a.guest);
		room.disconnect(a.guest);
		assert.deepEqual(host.sent, [{ type: 'peer-left', peerId: a.peerId }]);
	});

	it('rejects a second host and guests before the host arrives', () => {
		const { room } = setup();
		const second = new Conn('host2');
		assert.equal(room.connectHost(second), false);
		assert.equal(second.closed?.code, CloseCode.hostTaken);
		room.disconnect(second); // Its close event must not end the room.
		assert.equal(room.ended, false);

		const empty = new SignallingRoom<Conn>({ send: (c, m) => c.sent.push(m), close: (c, code, reason) => { c.closed = { code, reason }; } });
		const early = new Conn('early');
		assert.equal(empty.connectGuest(early, 'Early'), false);
		assert.equal(early.closed?.code, CloseCode.notFound);
	});

	it('ends the room when the host leaves', () => {
		const { room, host, endedCount } = setup();
		const a = join(room, host, 'Ada', true);
		const b = join(room, host, 'Bob');
		room.disconnect(host);
		for (const { guest } of [a, b]) {
			assert.deepEqual(guest.last(), { type: 'host-left' });
			assert.equal(guest.closed?.code, CloseCode.hostLeft);
		}
		assert.equal(room.ended, true);
		assert.equal(endedCount(), 1);
		// The guests' close events after that are no-ops.
		room.disconnect(a.guest);
		assert.equal(endedCount(), 1);
		const host2 = new Conn('host2');
		assert.equal(room.connectHost(host2), false);
		assert.equal(host2.closed?.code, CloseCode.notFound);
	});

	it('restores sockets after hibernation from their saved info', () => {
		const { room, host } = setup();
		const a = join(room, host, 'Ada', true);
		const revived = new SignallingRoom<Conn>({ send: (c, m) => c.sent.push(m), close: () => { } });
		revived.restore(host, host.info!);
		revived.restore(a.guest, a.guest.info!);
		revived.message(a.guest, JSON.stringify({ type: 'signal', data: 42 }));
		assert.deepEqual(host.last(), { type: 'signal', from: a.peerId, data: 42 });
	});
});

describe('parseConnectParams', () => {
	const parse = (q: string) => parseConnectParams(new URLSearchParams(q));
	it('reads host and guest params', () => {
		assert.deepEqual(parse('role=host&token=abc'), { role: 'host', token: 'abc' });
		assert.deepEqual(parse('role=guest&name=%20Ada%0A%20'), { role: 'guest', name: 'Ada' });
		assert.equal((parse('role=guest&name=' + 'x'.repeat(200)) as { name: string }).name.length, 64);
	});
	it('rejects missing or unknown values', () => {
		for (const q of ['', 'role=admin', 'role=host', 'role=guest', 'role=guest&name=%20']) {
			assert.ok('error' in parse(q), q);
		}
	});
});
