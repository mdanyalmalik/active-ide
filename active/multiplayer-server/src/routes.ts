/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/** HTTP routes shared by the Worker and the local server, so both expose the same API. */

import { isRoomId } from './ids.ts';

/** Permissive: Active calls from a desktop renderer whose origin isn't a stable web origin. */
export const CORS_HEADERS: Readonly<Record<string, string>> = {
	'Access-Control-Allow-Origin': '*',
	'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
	'Access-Control-Allow-Headers': 'Content-Type',
	'Access-Control-Max-Age': '86400',
};

export type Route =
	| { kind: 'preflight' }
	| { kind: 'create-room' }
	| { kind: 'room-socket'; roomId: string }
	| { kind: 'turn' }
	| { kind: 'not-found' }
	| { kind: 'method-not-allowed' };

const ROOM_SOCKET = /^\/rooms\/([^/]+)\/ws$/;

export function matchRoute(method: string, pathname: string): Route {
	if (method === 'OPTIONS') {
		return { kind: 'preflight' };
	}
	if (pathname === '/rooms') {
		return method === 'POST' ? { kind: 'create-room' } : { kind: 'method-not-allowed' };
	}
	if (pathname === '/turn') {
		return method === 'GET' ? { kind: 'turn' } : { kind: 'method-not-allowed' };
	}
	const socket = ROOM_SOCKET.exec(pathname);
	if (socket && isRoomId(socket[1])) {
		return method === 'GET' ? { kind: 'room-socket', roomId: socket[1] } : { kind: 'method-not-allowed' };
	}
	return { kind: 'not-found' };
}
