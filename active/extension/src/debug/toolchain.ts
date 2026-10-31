/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Toolchain } from './languages';

/** Delve's version Active installs (pinned in scripts/debuggers.json too). */
export const DELVE_MODULE = 'github.com/go-delve/delve/cmd/dlv';
export const DELVE_VERSION = 'v1.27.2';
const INSTALL_TIMEOUT_MS = 4 * 60_000;
const windows = process.platform === 'win32';
const exe = (name: string) => windows ? `${name}.exe` : name;

export interface ToolchainOptions {
	readonly workspaceRoot: string;
	/** Where Active keeps tools it installs (Delve), e.g. the extension's global storage. */
	readonly toolsDir: string;
	readonly nativeDebugger: () => boolean;
	readonly log: (line: string) => void;
}

/** Finds the tools each debugger needs on this machine, installing Delve with the developer's Go when it's missing. */
export class LocalToolchain implements Toolchain {
	private installing: Promise<{ path: string } | string> | undefined;

	constructor(private readonly options: ToolchainOptions) { }

	async python(cwd: string): Promise<string | undefined> {
		const bin = windows ? path.join('Scripts', 'python.exe') : path.join('bin', 'python');
		const environments = [process.env.VIRTUAL_ENV, path.join(cwd, '.venv'), path.join(cwd, 'venv'), path.join(this.options.workspaceRoot, '.venv'), path.join(this.options.workspaceRoot, 'venv')];
		for (const environment of environments) {
			if (environment && await isFile(path.join(environment, bin))) {
				return path.join(environment, bin);
			}
		}
		return await onPath(exe('python3')) ?? await onPath(exe('python'));
	}

	nativeDebugger(): boolean {
		return this.options.nativeDebugger();
	}

	async tempDir(): Promise<string> {
		return fs.mkdtemp(path.join(os.tmpdir(), 'active-debug-'));
	}

	async dlv(): Promise<{ path: string } | string> {
		const installed = path.join(this.options.toolsDir, 'bin', exe('dlv'));
		const goPath = process.env.GOPATH?.split(path.delimiter)[0] ?? path.join(os.homedir(), 'go');
		for (const candidate of [installed, process.env.GOBIN && path.join(process.env.GOBIN, exe('dlv')), path.join(goPath, 'bin', exe('dlv'))]) {
			if (candidate && await isFile(candidate)) {
				return { path: candidate };
			}
		}
		const found = await onPath(exe('dlv'));
		if (found) {
			return { path: found };
		}
		return this.installing ??= this.install(installed).finally(() => this.installing = undefined);
	}

	/** `go install`s Delve into Active's tools folder (once; about half a minute). */
	private async install(target: string): Promise<{ path: string } | string> {
		const go = await onPath(exe('go')) ?? (await firstFile(['/usr/local/go/bin/go', '/opt/homebrew/bin/go', path.join(os.homedir(), 'go', 'bin', 'go')]));
		if (!go) {
			return 'Go debugging needs Go installed (go isn\'t on PATH), to install the Delve debugger.';
		}
		this.options.log(`debug: installing Delve ${DELVE_VERSION} with ${go}`);
		try {
			await run(go, ['install', `${DELVE_MODULE}@${DELVE_VERSION}`], { ...process.env, GOBIN: path.dirname(target) }, INSTALL_TIMEOUT_MS);
		} catch (failure) {
			return `Installing the Delve debugger failed: ${failure instanceof Error ? failure.message.split('\n').slice(0, 4).join(' ') : String(failure)}`;
		}
		return (await isFile(target)) ? { path: target } : 'Installing the Delve debugger didn\'t produce dlv.';
	}
}

async function isFile(file: string): Promise<boolean> {
	return fs.stat(file).then(stat => stat.isFile(), () => false);
}

async function firstFile(files: readonly string[]): Promise<string | undefined> {
	for (const file of files) {
		if (await isFile(file)) {
			return file;
		}
	}
	return undefined;
}

async function onPath(name: string): Promise<string | undefined> {
	return firstFile((process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(dir => path.join(dir, name)));
}

function run(file: string, args: readonly string[], env: NodeJS.ProcessEnv, timeout: number): Promise<void> {
	return new Promise((resolve, reject) => execFile(file, args, { env, timeout }, (failure, _stdout, stderr) => failure ? reject(new Error(stderr || failure.message)) : resolve()));
}
