/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';

/** Debug types Active registers itself (contributed, hidden from the debugger list, in package.json). */
export const PYTHON_DEBUG_TYPE = 'active-python';
export const GO_DEBUG_TYPE = 'active-go';
/** CodeLLDB's type (it ships with Active as a built-in extension). */
export const NATIVE_DEBUG_TYPE = 'lldb';
export const NATIVE_DEBUGGER_EXTENSION = 'vadimcn.vscode-lldb';

const DELVE_READY = /DAP server listening at:\s*([\d.]+):(\d+)/;
const DELVE_START_TIMEOUT_MS = 20_000;

/**
 * Python runs debugpy's adapter (shipped in the extension's vendor folder) with the project's Python. Go starts
 * `dlv dap` in the run's folder (Delve builds from there) on a free port and connects to it; the Delve process, and
 * the temporary folder its debug build went into, go away with the session.
 */
export function registerDebugAdapters(vendorDir: string, log: (line: string) => void): vscode.Disposable {
	const delves = new Map<string, { process: ChildProcess; output?: string }>();
	return vscode.Disposable.from(
		vscode.debug.registerDebugAdapterDescriptorFactory(PYTHON_DEBUG_TYPE, {
			createDebugAdapterDescriptor: session => {
				const python = (session.configuration.python as string[] | undefined)?.[0];
				if (!python) {
					throw new Error('no Python interpreter was given');
				}
				return new vscode.DebugAdapterExecutable(python, [path.join(vendorDir, 'debugpy', 'adapter')]);
			},
		}),
		vscode.debug.registerDebugAdapterDescriptorFactory(GO_DEBUG_TYPE, {
			createDebugAdapterDescriptor: async session => {
				const dlv = session.configuration.dlvPath as string | undefined;
				if (!dlv) {
					throw new Error('Delve wasn\'t found');
				}
				const cwd = String(session.configuration.cwd ?? '');
				const child = spawn(dlv, ['dap', '--listen=127.0.0.1:0'], { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
				const output = typeof session.configuration.output === 'string' ? path.dirname(session.configuration.output) : undefined;
				delves.set(session.id, { process: child, output });
				const port = await new Promise<number>((resolve, reject) => {
					let seen = '';
					const timer = setTimeout(() => reject(new Error(`Delve didn't start: ${seen.trim().slice(0, 300)}`)), DELVE_START_TIMEOUT_MS);
					const read = (chunk: Buffer) => {
						seen += chunk.toString();
						const ready = DELVE_READY.exec(seen);
						if (ready) {
							clearTimeout(timer);
							resolve(Number(ready[2]));
						}
					};
					child.stdout?.on('data', read);
					child.stderr?.on('data', read);
					child.on('exit', code => {
						clearTimeout(timer);
						reject(new Error(`Delve exited (${code}): ${seen.trim().slice(0, 300)}`));
					});
				});
				log(`debug: Delve listening on ${port} for ${session.name}`);
				return new vscode.DebugAdapterServer(port, '127.0.0.1');
			},
		}),
		vscode.debug.onDidTerminateDebugSession(session => {
			const delve = delves.get(session.id);
			if (delve) {
				delves.delete(session.id);
				if (delve.process.exitCode === null) {
					delve.process.kill();
				}
				if (delve.output) {
					void fs.rm(delve.output, { recursive: true, force: true });
				}
			}
		}),
		{ dispose: () => delves.forEach(delve => delve.process.kill()) },
	);
}
