/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Random ids and host-token hashing. Only Web Crypto (a global in both Workers
 * and Node), so the Worker and the local server mint ids the same way.
 */

// Lowercase RFC 4648 base32: 32 symbols divides 256, so `byte & 31` is unbiased.
const BASE32 = 'abcdefghijklmnopqrstuvwxyz234567';

export const ROOM_ID_LENGTH = 10;
const ROOM_ID_PATTERN = /^[a-z2-7]{10}$/;

export function randomBase32(length: number): string {
	const bytes = crypto.getRandomValues(new Uint8Array(length));
	let out = '';
	for (const byte of bytes) {
		out += BASE32[byte & 31];
	}
	return out;
}

/** 10 base32 chars = 50 bits: unguessable enough given the host token and host approval. */
export function newRoomId(): string {
	return randomBase32(ROOM_ID_LENGTH);
}

export function isRoomId(value: string): boolean {
	return ROOM_ID_PATTERN.test(value);
}

/** 32 random bytes, base64url without padding (43 chars). */
export function newHostToken(): string {
	const bytes = crypto.getRandomValues(new Uint8Array(32));
	let binary = '';
	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}
	return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** SHA-256 hex. Only the hash is stored, so leaked room storage can't be used to host. */
export async function hashToken(token: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
	return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('');
}

/** Hashes `token` and compares in constant time against the stored hash. */
export async function verifyToken(token: string, storedHash: string): Promise<boolean> {
	const hash = await hashToken(token);
	if (hash.length !== storedHash.length) {
		return false;
	}
	let diff = 0;
	for (let i = 0; i < hash.length; i++) {
		diff |= hash.charCodeAt(i) ^ storedHash.charCodeAt(i);
	}
	return diff === 0;
}
