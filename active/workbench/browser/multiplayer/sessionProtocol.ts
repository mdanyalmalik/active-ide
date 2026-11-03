/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { ActiveEvent, InitialState } from '../../common/activeProtocol.js';
import type { SessionParticipant, SessionRole } from '../activeService.js';
import type { RemoteSearchRequest } from './remoteSearch.js';

/**
 * What a host and its guests say to each other over their data channel. The host runs everything; a guest's window
 * shows the host's agents and sends requests (checked against its role) back.
 */
export type SessionMessage =
	// guest → host
	| { readonly t: 'hello'; readonly name: string }
	| { readonly t: 'call'; readonly id: number; readonly command: string; readonly args: unknown[] }
	| { readonly t: 'presence'; readonly agentId?: string }
	| { readonly t: 'fs'; readonly id: number; readonly op: 'stat' | 'readdir' | 'readFile'; readonly path: string }
	| { readonly t: 'search'; readonly id: number; readonly request: RemoteSearchRequest }
	// host → guest
	| { readonly t: 'welcome'; readonly you: SessionParticipant; readonly hostName: string; readonly snapshot: InitialState }
	| { readonly t: 'event'; readonly event: ActiveEvent }
	| { readonly t: 'result'; readonly id: number; readonly ok: boolean; readonly value?: unknown; readonly error?: string }
	| { readonly t: 'participants'; readonly list: readonly SessionParticipant[] }
	| { readonly t: 'role'; readonly role: SessionRole }
	| { readonly t: 'fsResult'; readonly id: number; readonly ok: boolean; readonly value?: unknown; readonly error?: string }
	| { readonly t: 'fsChanged'; readonly paths: readonly string[]; readonly deleted?: readonly string[]; readonly added?: readonly string[] }
	| { readonly t: 'bye'; readonly reason: string };

/** A file's metadata, as a host sends it for a guest's read-only view. */
export interface RemoteStat {
	readonly type: 'file' | 'directory';
	readonly size: number;
	readonly mtime: number;
	readonly ctime: number;
}

// ------------------------------------------------------------------ chunking

/** Data channels cap message size (~256 KB in Chromium): longer messages travel in pieces. */
export const CHUNK_SIZE = 48 * 1024;

type Wire = { readonly c: number; readonly i: number; readonly n: number; readonly s: string };

let chunkSeq = 0;

/** Splits a message into wire frames (one frame when it's small). */
export function encodeFrames(message: SessionMessage): string[] {
	const text = JSON.stringify(message);
	if (text.length <= CHUNK_SIZE) {
		return [text];
	}
	const id = ++chunkSeq;
	const count = Math.ceil(text.length / CHUNK_SIZE);
	const frames: string[] = [];
	for (let index = 0; index < count; index++) {
		frames.push(JSON.stringify({ c: id, i: index, n: count, s: text.slice(index * CHUNK_SIZE, (index + 1) * CHUNK_SIZE) } satisfies Wire));
	}
	return frames;
}

/** Puts frames back together; returns a message once it's complete. */
export class FrameDecoder {
	private readonly partial = new Map<number, string[]>();

	push(frame: string): SessionMessage | undefined {
		const parsed = JSON.parse(frame) as SessionMessage | Wire;
		if (!('c' in parsed)) {
			return parsed;
		}
		const parts = this.partial.get(parsed.c) ?? new Array<string>(parsed.n);
		parts[parsed.i] = parsed.s;
		this.partial.set(parsed.c, parts);
		if (parts.filter(part => part !== undefined).length < parsed.n) {
			return undefined;
		}
		this.partial.delete(parsed.c);
		return JSON.parse(parts.join('')) as SessionMessage;
	}
}

// ------------------------------------------------------------------ invites and encryption

/**
 * An invite code: the room on the signalling server, plus a key that never leaves the invite. Signalling messages
 * (which carry the WebRTC fingerprints) are encrypted with it, so the server can't read or swap them.
 */
export interface Invite {
	readonly roomId: string;
	readonly key: string;
}

export function formatInvite(invite: Invite): string {
	return `${invite.roomId}.${invite.key}`;
}

export function parseInvite(code: string): Invite | undefined {
	const match = /^\s*([a-z2-7]{6,32})\.([A-Za-z0-9_-]{30,})\s*$/.exec(code);
	return match ? { roomId: match[1], key: match[2] } : undefined;
}

function toBase64Url(bytes: Uint8Array): string {
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
	const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
	const bytes = new Uint8Array(binary.length);
	for (let index = 0; index < binary.length; index++) {
		bytes[index] = binary.charCodeAt(index);
	}
	return bytes;
}

export function newInviteKey(): string {
	return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}

export class SignalCipher {
	private constructor(private readonly key: CryptoKey) { }

	static async create(inviteKey: string): Promise<SignalCipher> {
		const key = await crypto.subtle.importKey('raw', fromBase64Url(inviteKey) as BufferSource, 'AES-GCM', false, ['encrypt', 'decrypt']);
		return new SignalCipher(key);
	}

	async seal(value: unknown): Promise<string> {
		const iv = crypto.getRandomValues(new Uint8Array(12));
		const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, this.key, new TextEncoder().encode(JSON.stringify(value))));
		return `${toBase64Url(iv)}.${toBase64Url(sealed)}`;
	}

	/** Throws when the data wasn't sealed with this invite's key. */
	async open<T>(data: string): Promise<T> {
		const [iv, sealed] = data.split('.');
		const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64Url(iv) as BufferSource }, this.key, fromBase64Url(sealed) as BufferSource);
		return JSON.parse(new TextDecoder().decode(plain)) as T;
	}
}
