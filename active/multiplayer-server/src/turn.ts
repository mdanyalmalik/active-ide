/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** Mints short-lived Cloudflare TURN credentials for `GET /turn`. */

export interface IceServer {
	urls: string | string[];
	username?: string;
	credential?: string;
}

export interface TurnSecrets {
	readonly TURN_KEY_ID?: string;
	readonly TURN_KEY_API_TOKEN?: string;
}

/** Just the part of `fetch` used here, so tests can stub it. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export const PUBLIC_STUN: IceServer = { urls: 'stun:stun.cloudflare.com:3478' };
/** Long enough for any session; Active can refresh with RTCPeerConnection.setConfiguration. */
export const TURN_TTL_SECONDS = 86400;

export function turnApiUrl(keyId: string): string {
	return `https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`;
}

/**
 * Public STUN plus, when the TURN secrets are set, Cloudflare TURN. Falls back
 * to STUN only if the API fails: most connections still go direct.
 */
export async function getIceServers(secrets: TurnSecrets, fetchFn: FetchLike): Promise<IceServer[]> {
	if (!secrets.TURN_KEY_ID || !secrets.TURN_KEY_API_TOKEN) {
		return [PUBLIC_STUN];
	}
	let body: unknown;
	try {
		const res = await fetchFn(turnApiUrl(secrets.TURN_KEY_ID), {
			method: 'POST',
			headers: { 'Authorization': `Bearer ${secrets.TURN_KEY_API_TOKEN}`, 'Content-Type': 'application/json' },
			body: JSON.stringify({ ttl: TURN_TTL_SECONDS }),
		});
		if (!res.ok) {
			console.error(`TURN credential API returned ${res.status}`);
			return [PUBLIC_STUN];
		}
		body = await res.json();
	} catch (err) {
		console.error('TURN credential API failed', err);
		return [PUBLIC_STUN];
	}
	return withPublicStun(normaliseIceServers(body));
}

/**
 * Accepts both response shapes: `generate-ice-servers` returns an array, the
 * older `generate` endpoint a single object. Drops port-53 URLs, which browsers
 * block (Cloudflare's docs say they would only stall ICE until a timeout).
 */
export function normaliseIceServers(body: unknown): IceServer[] {
	const raw = (body as { iceServers?: unknown } | null)?.iceServers;
	const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
	const out: IceServer[] = [];
	for (const entry of list as Array<Partial<IceServer>>) {
		const urls = (Array.isArray(entry?.urls) ? entry.urls : [entry?.urls])
			.filter((u): u is string => typeof u === 'string' && !/:53(\?|$)/.test(u));
		if (urls.length === 0) {
			continue;
		}
		const server: IceServer = { urls };
		if (typeof entry.username === 'string') { server.username = entry.username; }
		if (typeof entry.credential === 'string') { server.credential = entry.credential; }
		out.push(server);
	}
	return out;
}

function withPublicStun(servers: IceServer[]): IceServer[] {
	const has = servers.some(s => ([] as string[]).concat(s.urls).includes(PUBLIC_STUN.urls as string));
	return has ? servers : [PUBLIC_STUN, ...servers];
}
