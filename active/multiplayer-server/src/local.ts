/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * A local stand-in for the Worker: the same routes and WebSocket protocol on
 * 127.0.0.1:8787 (or $PORT), sharing room.ts, so Active can be tested without
 * Cloudflare. Rooms live in memory. `GET /turn` has no TURN: same-machine
 * WebRTC needs no ICE servers at all.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, type WebSocket } from 'ws';
import { hashToken, newHostToken, newRoomId, verifyToken } from './ids.ts';
import { CloseCode, MAX_MESSAGE_BYTES, parseConnectParams, SignallingRoom } from './room.ts';
import { CORS_HEADERS, matchRoute } from './routes.ts';

const UNUSED_ROOM_TTL_MS = 10 * 60 * 1000;

interface LocalRoom {
	readonly tokenHash: string;
	readonly room: SignallingRoom<WebSocket>;
	readonly unusedTimer: NodeJS.Timeout;
}

export interface LocalServer {
	readonly server: Server;
	readonly port: number;
	readonly url: string;
	close(): Promise<void>;
}

export async function startLocalServer(port = 8787, host = '127.0.0.1'): Promise<LocalServer> {
	const rooms = new Map<string, LocalRoom>();
	// Frames between 64 KB and 1 MB get the room's error reply (as on Cloudflare,
	// whose own frame limit is 1 MiB); bigger ones make `ws` drop the socket.
	const wss = new WebSocketServer({ noServer: true, maxPayload: Math.max(1024 * 1024, MAX_MESSAGE_BYTES) });

	const forget = (roomId: string) => {
		const entry = rooms.get(roomId);
		if (entry) {
			clearTimeout(entry.unusedTimer);
			rooms.delete(roomId);
		}
	};

	const createRoom = async (): Promise<{ roomId: string; hostToken: string }> => {
		let roomId = newRoomId();
		while (rooms.has(roomId)) {
			roomId = newRoomId();
		}
		const hostToken = newHostToken();
		const room = new SignallingRoom<WebSocket>({
			send: (ws, message) => {
				if (ws.readyState === ws.OPEN) {
					ws.send(JSON.stringify(message));
				}
			},
			close: (ws, code, reason) => ws.close(code, reason),
			ended: () => forget(roomId),
		});
		const unusedTimer = setTimeout(() => {
			if (!rooms.get(roomId)?.room.hasHost) {
				forget(roomId);
			}
		}, UNUSED_ROOM_TTL_MS);
		unusedTimer.unref();
		rooms.set(roomId, { tokenHash: await hashToken(hostToken), room, unusedTimer });
		return { roomId, hostToken };
	};

	const server = createServer((req, res) => {
		void handleHttp(req, res).catch(err => {
			console.error(err);
			if (!res.headersSent) {
				sendJson(res, 500, { error: 'internal error' });
			}
		});
	});

	const handleHttp = async (req: IncomingMessage, res: ServerResponse) => {
		const route = matchRoute(req.method ?? 'GET', new URL(req.url ?? '/', 'http://localhost').pathname);
		switch (route.kind) {
			case 'preflight':
				res.writeHead(204, CORS_HEADERS).end();
				return;
			case 'create-room':
				sendJson(res, 201, await createRoom());
				return;
			case 'turn':
				sendJson(res, 200, { iceServers: [] });
				return;
			case 'room-socket':
				sendJson(res, 426, { error: 'expected a WebSocket upgrade' });
				return;
			case 'method-not-allowed':
				sendJson(res, 405, { error: 'method not allowed' });
				return;
			case 'not-found':
				sendJson(res, 404, { error: 'not found' });
				return;
		}
	};

	server.on('upgrade', (req, socket, head) => {
		const url = new URL(req.url ?? '/', 'http://localhost');
		const route = matchRoute(req.method ?? 'GET', url.pathname);
		if (route.kind !== 'room-socket') {
			socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
			return;
		}
		void admission(route.roomId, url.searchParams).then(verdict => {
			wss.handleUpgrade(req, socket, head, ws => attach(ws, verdict));
		});
	});

	type Verdict =
		| { ok: true; room: SignallingRoom<WebSocket>; role: 'host' | 'guest'; name: string }
		| { ok: false; code: number; message: string };

	// Checked before the upgrade completes (as on the Worker), so once a host's
	// socket opens it is already the room's host.
	const admission = async (roomId: string, query: URLSearchParams): Promise<Verdict> => {
		const params = parseConnectParams(query);
		if ('error' in params) {
			return { ok: false, code: CloseCode.badRequest, message: params.error };
		}
		const entry = rooms.get(roomId);
		if (!entry) {
			return { ok: false, code: CloseCode.notFound, message: 'room not found' };
		}
		if (params.role === 'host') {
			return await verifyToken(params.token, entry.tokenHash)
				? { ok: true, room: entry.room, role: 'host', name: '' }
				: { ok: false, code: CloseCode.unauthorised, message: 'invalid host token' };
		}
		return { ok: true, room: entry.room, role: 'guest', name: params.name };
	};

	const attach = (ws: WebSocket, verdict: Verdict) => {
		if (!verdict.ok) {
			// Refusals complete the upgrade so the client can read why.
			ws.send(JSON.stringify({ type: 'error', message: verdict.message }));
			ws.close(verdict.code, verdict.message);
			return;
		}
		const { room } = verdict;
		ws.on('message', (data, isBinary) => room.message(ws, isBinary ? toBuffer(data) : toBuffer(data).toString('utf8')));
		ws.on('close', () => room.disconnect(ws));
		ws.on('error', () => room.disconnect(ws));
		if (verdict.role === 'host') {
			room.connectHost(ws);
		} else {
			room.connectGuest(ws, verdict.name);
		}
	};

	await new Promise<void>((resolve, reject) => {
		server.once('error', reject);
		server.listen(port, host, () => resolve());
	});
	const actualPort = (server.address() as AddressInfo).port;
	return {
		server,
		port: actualPort,
		url: `http://${host}:${actualPort}`,
		close: () => new Promise<void>(resolve => {
			for (const ws of wss.clients) {
				ws.terminate();
			}
			wss.close();
			for (const roomId of [...rooms.keys()]) {
				forget(roomId);
			}
			server.close(() => resolve());
		}),
	};
}

function toBuffer(data: Buffer | ArrayBuffer | Buffer[]): Buffer {
	if (Array.isArray(data)) {
		return Buffer.concat(data);
	}
	return Buffer.isBuffer(data) ? data : Buffer.from(data);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { ...CORS_HEADERS, 'Content-Type': 'application/json' }).end(JSON.stringify(body));
}

// Run directly (`npm run dev:local`), not when imported by the tests.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const port = process.env.PORT ? Number(process.env.PORT) : 8787;
	const local = await startLocalServer(port);
	console.log(`Active multiplayer signalling (local) on ${local.url}`);
	const stop = () => void local.close().then(() => process.exit(0));
	process.on('SIGINT', stop);
	process.on('SIGTERM', stop);
}
