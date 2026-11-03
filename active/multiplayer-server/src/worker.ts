/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cloudflare Worker entry plus the `Room` Durable Object (one per room id).
 * The Worker routes HTTP; each room's sockets live in its Durable Object, which
 * uses the WebSocket Hibernation API so an idle room (peers connected, nothing
 * to relay) isn't billed as running. Room behaviour is all in room.ts.
 */

import { DurableObject } from 'cloudflare:workers';
import { hashToken, newHostToken, newRoomId, verifyToken } from './ids.ts';
import { CloseCode, parseConnectParams, SignallingRoom, type ConnectionInfo } from './room.ts';
import { CORS_HEADERS, matchRoute } from './routes.ts';
import { getIceServers } from './turn.ts';

export interface Env {
	readonly ROOMS: DurableObjectNamespace<Room>;
	readonly TURN_KEY_ID?: string;
	readonly TURN_KEY_API_TOKEN?: string;
}

/** A room nobody ever hosts is deleted after this long. */
const UNUSED_ROOM_TTL_MS = 10 * 60 * 1000;

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		const url = new URL(request.url);
		const route = matchRoute(request.method, url.pathname);
		switch (route.kind) {
			case 'preflight':
				return new Response(null, { status: 204, headers: CORS_HEADERS });
			case 'create-room': {
				// A 50-bit id basically never collides, but init() refuses a taken id, so retry.
				for (let attempt = 0; attempt < 5; attempt++) {
					const roomId = newRoomId();
					const hostToken = newHostToken();
					if (await roomStub(env, roomId).init(await hashToken(hostToken))) {
						return json({ roomId, hostToken }, 201);
					}
				}
				return json({ error: 'could not allocate a room' }, 503);
			}
			case 'room-socket':
				if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
					return json({ error: 'expected a WebSocket upgrade' }, 426);
				}
				return roomStub(env, route.roomId).fetch(request);
			case 'turn':
				return json({ iceServers: await getIceServers(env, fetch) });
			case 'method-not-allowed':
				return json({ error: 'method not allowed' }, 405);
			case 'not-found':
				return json({ error: 'not found' }, 404);
		}
	},
} satisfies ExportedHandler<Env>;

function roomStub(env: Env, roomId: string): DurableObjectStub<Room> {
	return env.ROOMS.get(env.ROOMS.idFromName(roomId));
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } });
}

export class Room extends DurableObject<Env> {
	private tokenHash: string | undefined;
	private room: SignallingRoom<WebSocket>;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.room = this.newRoom();
		// Runs on first use and again after every hibernation wake-up: reload the
		// token hash and re-attach the sockets that stayed open while we slept.
		void ctx.blockConcurrencyWhile(async () => {
			this.tokenHash = await ctx.storage.get<string>('tokenHash');
			for (const ws of ctx.getWebSockets()) {
				const info = ws.deserializeAttachment() as ConnectionInfo | null;
				if (info) {
					this.room.restore(ws, info);
				}
			}
		});
	}

	/** Called by the Worker for `POST /rooms`. False if the id is already taken. */
	async init(tokenHash: string): Promise<boolean> {
		if (this.tokenHash !== undefined) {
			return false;
		}
		if (this.room.ended) {
			this.room = this.newRoom();
		}
		this.tokenHash = tokenHash;
		await this.ctx.storage.put('tokenHash', tokenHash);
		await this.ctx.storage.setAlarm(Date.now() + UNUSED_ROOM_TTL_MS);
		return true;
	}

	async alarm(): Promise<void> {
		if (!this.room.hasHost) {
			await this.forget();
		}
	}

	async fetch(request: Request): Promise<Response> {
		const params = parseConnectParams(new URL(request.url).searchParams);
		const [client, server] = Object.values(new WebSocketPair());

		// Refusals still complete the upgrade so the client can read the error
		// message; a browser WebSocket can't see an HTTP status.
		const refuse = (code: number, message: string) => {
			server.accept();
			this.room.reject(server, code, message);
			return new Response(null, { status: 101, webSocket: client });
		};

		if ('error' in params) {
			return refuse(CloseCode.badRequest, params.error);
		}
		if (this.tokenHash === undefined) {
			return refuse(CloseCode.notFound, 'room not found');
		}
		if (params.role === 'host') {
			if (!await verifyToken(params.token, this.tokenHash)) {
				return refuse(CloseCode.unauthorised, 'invalid host token');
			}
			this.ctx.acceptWebSocket(server);
			this.room.connectHost(server);
		} else {
			this.ctx.acceptWebSocket(server);
			this.room.connectGuest(server, params.name);
		}
		return new Response(null, { status: 101, webSocket: client });
	}

	async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
		this.room.message(ws, message);
	}

	async webSocketClose(ws: WebSocket): Promise<void> {
		this.room.disconnect(ws);
		try {
			ws.close(CloseCode.normal, 'closed'); // Complete the close handshake.
		} catch {
			// Already closed.
		}
	}

	async webSocketError(ws: WebSocket): Promise<void> {
		this.room.disconnect(ws);
	}

	private newRoom(): SignallingRoom<WebSocket> {
		return new SignallingRoom<WebSocket>({
			send: (ws, message) => {
				try {
					ws.send(JSON.stringify(message));
				} catch {
					// The socket is closing; its close event will clean up.
				}
			},
			close: (ws, code, reason) => {
				try {
					ws.close(code, reason);
				} catch {
					// Already closed.
				}
			},
			save: (ws, info) => ws.serializeAttachment(info),
			// The host left: the room is gone for good (see README, "Room lifetime").
			ended: () => void this.forget(),
		});
	}

	private async forget(): Promise<void> {
		this.tokenHash = undefined;
		await this.ctx.storage.deleteAlarm();
		await this.ctx.storage.deleteAll();
	}
}
