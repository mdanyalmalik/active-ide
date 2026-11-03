/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The signalling room: who is connected, who the host has admitted, and which
 * messages may go where. Pure logic with no Cloudflare or Node APIs; the
 * Durable Object (worker.ts) and the local server (local.ts) hand it frames and
 * give it callbacks to send and close, so both runtimes behave identically.
 *
 * `data` in signal messages is opaque (the clients encrypt it) and is relayed
 * as-is, never inspected.
 */

import { randomBase32 } from './ids.ts';

export const MAX_MESSAGE_BYTES = 64 * 1024;
/** Pending and admitted guests together, so a flood of join requests can't crowd the host. */
export const MAX_GUESTS = 5;
export const MAX_NAME_LENGTH = 64;
const MAX_REASON_LENGTH = 200;

/** WebSocket close codes (4000-4999 is the application range). */
export const CloseCode = {
	normal: 1000,
	badRequest: 4000,
	unauthorised: 4001,
	denied: 4003,
	notFound: 4004,
	kicked: 4005,
	hostTaken: 4009,
	hostLeft: 4010,
	full: 4029,
} as const;

// --- Messages -------------------------------------------------------------

export type ServerMessage =
	| { type: 'join-request'; peerId: string; name: string }
	| { type: 'peer-left'; peerId: string }
	| { type: 'signal'; from: string; data: unknown }
	| { type: 'pending' }
	| { type: 'admitted'; peerId: string }
	| { type: 'denied'; reason?: string }
	| { type: 'kicked' }
	| { type: 'host-left' }
	| { type: 'error'; message: string };

/** What a runtime must remember about each socket (persisted across Durable Object hibernation). */
export type ConnectionInfo =
	| { role: 'host' }
	| { role: 'guest'; peerId: string; name: string; admitted: boolean };

export type ConnectParams =
	| { role: 'host'; token: string }
	| { role: 'guest'; name: string };

/** Parses the `?role=…` query of a connection URL. */
export function parseConnectParams(query: URLSearchParams): ConnectParams | { error: string } {
	const role = query.get('role');
	if (role === 'host') {
		const token = query.get('token');
		return token ? { role: 'host', token } : { error: 'missing token' };
	}
	if (role === 'guest') {
		// Strip control characters so a name can't break the host's UI or logs.
		const name = (query.get('name') ?? '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_LENGTH);
		return name ? { role: 'guest', name } : { error: 'missing name' };
	}
	return { error: 'role must be host or guest' };
}

// --- Room -----------------------------------------------------------------

export interface RoomTransport<C> {
	send(conn: C, message: ServerMessage): void;
	close(conn: C, code: number, reason: string): void;
	/** A connection's info changed; hibernating runtimes persist it and hand it back to `restore`. */
	save?(conn: C, info: ConnectionInfo): void;
	/** The host left, so the room is over; the runtime should forget it. */
	ended?(): void;
}

export interface RoomOptions {
	readonly maxGuests?: number;
	readonly maxMessageBytes?: number;
	readonly newPeerId?: () => string;
}

interface Guest<C> {
	readonly conn: C;
	readonly peerId: string;
	readonly name: string;
	admitted: boolean;
}

export class SignallingRoom<C> {
	private readonly transport: RoomTransport<C>;
	private readonly maxGuests: number;
	private readonly maxMessageBytes: number;
	private readonly newPeerId: () => string;

	private host: C | undefined;
	private readonly guests = new Map<string, Guest<C>>();
	private readonly peerIdByConn = new Map<C, string>();
	private isEnded = false;

	constructor(transport: RoomTransport<C>, options: RoomOptions = {}) {
		this.transport = transport;
		this.maxGuests = options.maxGuests ?? MAX_GUESTS;
		this.maxMessageBytes = options.maxMessageBytes ?? MAX_MESSAGE_BYTES;
		this.newPeerId = options.newPeerId ?? (() => randomBase32(8));
	}

	get ended(): boolean { return this.isEnded; }
	get hasHost(): boolean { return this.host !== undefined; }
	get guestCount(): number { return this.guests.size; }

	/** Re-registers a socket that survived while the runtime was asleep, without sending anything. */
	restore(conn: C, info: ConnectionInfo): void {
		if (info.role === 'host') {
			this.host = conn;
		} else {
			this.guests.set(info.peerId, { conn, peerId: info.peerId, name: info.name, admitted: info.admitted });
			this.peerIdByConn.set(conn, info.peerId);
		}
	}

	/** Sends an error and closes; for connections refused before (or instead of) joining. */
	reject(conn: C, code: number, message: string): void {
		this.transport.send(conn, { type: 'error', message });
		this.transport.close(conn, code, message);
	}

	/** The caller has already checked the host token. */
	connectHost(conn: C): boolean {
		if (this.isEnded) {
			this.reject(conn, CloseCode.notFound, 'room has ended');
			return false;
		}
		if (this.host !== undefined) {
			this.reject(conn, CloseCode.hostTaken, 'room already has a host');
			return false;
		}
		this.host = conn;
		this.transport.save?.(conn, { role: 'host' });
		return true;
	}

	connectGuest(conn: C, name: string): boolean {
		if (this.isEnded) {
			this.reject(conn, CloseCode.notFound, 'room has ended');
			return false;
		}
		if (this.host === undefined) {
			this.reject(conn, CloseCode.notFound, 'host is not connected');
			return false;
		}
		if (this.guests.size >= this.maxGuests) {
			this.reject(conn, CloseCode.full, 'room is full');
			return false;
		}
		let peerId = this.newPeerId();
		while (this.guests.has(peerId) || peerId === 'host') {
			peerId = this.newPeerId();
		}
		this.guests.set(peerId, { conn, peerId, name, admitted: false });
		this.peerIdByConn.set(conn, peerId);
		this.transport.save?.(conn, { role: 'guest', peerId, name, admitted: false });
		this.transport.send(conn, { type: 'pending' });
		this.transport.send(this.host, { type: 'join-request', peerId, name });
		return true;
	}

	message(conn: C, frame: string | ArrayBuffer | ArrayBufferView): void {
		const isHost = conn === this.host;
		const peerId = this.peerIdByConn.get(conn);
		if (!isHost && peerId === undefined) {
			return; // Not (or no longer) in the room.
		}
		if (typeof frame !== 'string') {
			this.error(conn, 'only JSON text frames are accepted');
			return;
		}
		// UTF-8 is at most 3 bytes per UTF-16 unit, so most frames skip the encode.
		if (frame.length * 3 > this.maxMessageBytes && new TextEncoder().encode(frame).byteLength > this.maxMessageBytes) {
			this.error(conn, `message exceeds ${this.maxMessageBytes} bytes`);
			return;
		}
		let msg: Record<string, unknown>;
		try {
			const parsed: unknown = JSON.parse(frame);
			if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
				throw new Error();
			}
			msg = parsed as Record<string, unknown>;
		} catch {
			this.error(conn, 'malformed message');
			return;
		}
		if (isHost) {
			this.hostMessage(conn, msg);
		} else {
			this.guestMessage(conn, this.guests.get(peerId!)!, msg);
		}
	}

	/** The socket closed (for any reason). Safe to call more than once. */
	disconnect(conn: C): void {
		if (conn === this.host) {
			this.host = undefined;
			this.end();
			return;
		}
		const peerId = this.peerIdByConn.get(conn);
		if (peerId === undefined) {
			return;
		}
		this.removeGuest(peerId);
		if (this.host !== undefined) {
			this.transport.send(this.host, { type: 'peer-left', peerId });
		}
	}

	private hostMessage(host: C, msg: Record<string, unknown>): void {
		const type = msg.type;
		if (type !== 'admit' && type !== 'deny' && type !== 'kick' && type !== 'signal') {
			this.error(host, typeof type === 'string' ? `unknown message type: ${type.slice(0, 32)}` : 'missing message type');
			return;
		}
		const target = type === 'signal' ? msg.to : msg.peerId;
		const guest = typeof target === 'string' ? this.guests.get(target) : undefined;
		if (!guest) {
			this.error(host, 'unknown peer');
			return;
		}
		switch (type) {
			case 'admit':
				if (guest.admitted) {
					this.error(host, 'peer is already admitted');
					return;
				}
				guest.admitted = true;
				this.transport.save?.(guest.conn, { role: 'guest', peerId: guest.peerId, name: guest.name, admitted: true });
				this.transport.send(guest.conn, { type: 'admitted', peerId: guest.peerId });
				return;
			case 'deny': {
				if (guest.admitted) {
					this.error(host, 'peer is already admitted; use kick');
					return;
				}
				const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, MAX_REASON_LENGTH) : undefined;
				this.transport.send(guest.conn, reason === undefined ? { type: 'denied' } : { type: 'denied', reason });
				this.removeGuest(guest.peerId);
				this.transport.close(guest.conn, CloseCode.denied, 'denied');
				return;
			}
			case 'kick':
				this.transport.send(guest.conn, { type: 'kicked' });
				this.removeGuest(guest.peerId);
				this.transport.close(guest.conn, CloseCode.kicked, 'kicked');
				return;
			case 'signal':
				if (!guest.admitted) {
					this.error(host, 'peer is not admitted');
					return;
				}
				if (msg.data === undefined) {
					this.error(host, 'missing data');
					return;
				}
				this.transport.send(guest.conn, { type: 'signal', from: 'host', data: msg.data });
				return;
		}
	}

	private guestMessage(conn: C, guest: Guest<C>, msg: Record<string, unknown>): void {
		if (msg.type !== 'signal') {
			this.error(conn, typeof msg.type === 'string' ? `unknown message type: ${msg.type.slice(0, 32)}` : 'missing message type');
			return;
		}
		if (!guest.admitted) {
			this.error(conn, 'not admitted yet');
			return;
		}
		if (msg.data === undefined) {
			this.error(conn, 'missing data');
			return;
		}
		if (this.host !== undefined) {
			this.transport.send(this.host, { type: 'signal', from: guest.peerId, data: msg.data });
		}
	}

	private end(): void {
		if (this.isEnded) {
			return;
		}
		this.isEnded = true;
		const guests = [...this.guests.values()];
		this.guests.clear();
		this.peerIdByConn.clear();
		for (const guest of guests) {
			this.transport.send(guest.conn, { type: 'host-left' });
			this.transport.close(guest.conn, CloseCode.hostLeft, 'host left');
		}
		this.transport.ended?.();
	}

	private removeGuest(peerId: string): void {
		const guest = this.guests.get(peerId);
		if (guest) {
			this.guests.delete(peerId);
			this.peerIdByConn.delete(guest.conn);
		}
	}

	private error(conn: C, message: string): void {
		this.transport.send(conn, { type: 'error', message });
	}
}
