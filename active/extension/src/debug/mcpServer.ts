/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { randomBytes } from 'node:crypto';
import * as http from 'node:http';
import type { McpTool } from './debugTools';

export interface McpServerOptions {
	readonly name: string;
	readonly version: string;
	readonly tools: readonly McpTool[];
	readonly call: (name: string, args: Record<string, unknown>) => Promise<{ text: string; isError?: boolean }>;
	readonly log: (line: string) => void;
}

/** A running server: where it listens and the bearer token every request must carry. */
export interface RunningMcpServer {
	readonly url: string;
	readonly token: string;
	close(): Promise<void>;
}

type JsonRpcRequest = { jsonrpc?: string; id?: string | number | null; method?: string; params?: Record<string, unknown> };

/**
 * A minimal MCP server over streamable HTTP (plain JSON responses, no streaming), listening on localhost only.
 * Active gives it to the coding agent's `muse serve` process, so only the coding agent gets these tools. Every
 * request must carry the random bearer token, so other local programs can't call it.
 */
export function startMcpServer(options: McpServerOptions): Promise<RunningMcpServer> {
	const token = randomBytes(24).toString('hex');
	const server = http.createServer((request, response) => {
		if (request.headers.authorization !== `Bearer ${token}`) {
			response.writeHead(401).end();
			return;
		}
		if (request.method === 'DELETE') {
			response.writeHead(200).end();
			return;
		}
		if (request.method !== 'POST') {
			// No server-to-client stream: everything is a reply to a POST.
			response.writeHead(405, { allow: 'POST, DELETE' }).end();
			return;
		}
		let body = '';
		request.setEncoding('utf8');
		request.on('data', chunk => {
			body += chunk;
			if (body.length > 1_000_000) {
				request.destroy();
			}
		});
		request.on('end', () => {
			void respond(body).then(reply => {
				if (reply === undefined) {
					response.writeHead(202).end();
				} else {
					response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(reply));
				}
			}, failure => {
				options.log(`mcp: request failed: ${failure instanceof Error ? failure.message : String(failure)}`);
				response.writeHead(500).end();
			});
		});
	});

	const handle = async (message: JsonRpcRequest): Promise<unknown> => {
		const reply = (result: unknown) => ({ jsonrpc: '2.0', id: message.id, result });
		const fail = (code: number, text: string) => ({ jsonrpc: '2.0', id: message.id ?? null, error: { code, message: text } });
		if (message.id === undefined || message.id === null) {
			return undefined; // a notification (e.g. notifications/initialized): nothing to say back
		}
		switch (message.method) {
			case 'initialize':
				return reply({
					protocolVersion: typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '2025-06-18',
					capabilities: { tools: { listChanged: false } },
					serverInfo: { name: options.name, version: options.version },
				});
			case 'ping':
				return reply({});
			case 'tools/list':
				return reply({ tools: options.tools });
			case 'tools/call': {
				const name = typeof message.params?.name === 'string' ? message.params.name : '';
				if (!options.tools.some(tool => tool.name === name)) {
					return fail(-32602, `Unknown tool: ${name}`);
				}
				const args = (message.params?.arguments ?? {}) as Record<string, unknown>;
				options.log(`mcp: ${name} ${JSON.stringify(args).slice(0, 300)}`);
				const result = await options.call(name, args);
				return reply({ content: [{ type: 'text', text: result.text }], isError: result.isError === true });
			}
			default:
				return fail(-32601, `Method not found: ${message.method}`);
		}
	};

	const respond = async (body: string): Promise<unknown> => {
		let parsed: JsonRpcRequest | JsonRpcRequest[];
		try {
			parsed = JSON.parse(body) as JsonRpcRequest | JsonRpcRequest[];
		} catch {
			return { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
		}
		if (Array.isArray(parsed)) {
			const replies = (await Promise.all(parsed.map(handle))).filter(reply => reply !== undefined);
			return replies.length ? replies : undefined;
		}
		return handle(parsed);
	};

	return new Promise((resolve, reject) => {
		server.once('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const address = server.address();
			const port = typeof address === 'object' && address ? address.port : 0;
			options.log(`mcp: listening on 127.0.0.1:${port}`);
			resolve({
				url: `http://127.0.0.1:${port}/mcp`,
				token,
				close: () => new Promise(done => server.close(() => done())),
			});
		});
	});
}
