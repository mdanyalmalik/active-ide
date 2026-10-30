/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Coding-agent providers. Everything Active needs to know about a particular
 * agent platform (finding and installing it, how users sign in, how to start
 * its sessions) lives behind `AgentProvider`, so another agent can be added by
 * writing one adapter. Muse Code is the default provider.
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { SignInMethod } from '../shared/activeProtocol';
import type { AgentHost } from './agentTypes';
import { BridgeHost } from './bridgeHost';
import { MuseHost } from './museHost';

export interface InstallerSpec {
	/** What runs, shown to the user before they agree. */
	readonly display: string;
	/** Where the user can read the script first. */
	readonly scriptUrl?: string;
	readonly command: string;
	readonly args: readonly string[];
	readonly env?: Readonly<Record<string, string>>;
}

export interface SignInMethodSpec {
	readonly id: SignInMethod;
	readonly label: string;
	readonly description: string;
}

/**
 * How a provider's browser sign-in is driven in the background:
 * `menu` answers an interactive app's prompts (pick "sign in with browser");
 * `command` runs a dedicated login command and waits for it to exit.
 */
export interface BrowserSignInSpec {
	readonly mode: 'menu' | 'command';
	readonly args: readonly string[];
}

export interface HostOptions {
	readonly role: 'coding' | 'explanation';
	readonly cwd: string;
	/** Extra environment for the agent process (for example an API key). */
	readonly env: Readonly<Record<string, string>>;
	readonly log: (line: string) => void;
}

export interface AgentProvider {
	readonly id: string;
	/** Shown throughout the UI, e.g. "Muse Code". */
	readonly displayName: string;
	/** Short name for transcript labels, e.g. "Muse". */
	readonly shortName: string;
	/** Dev-only providers are never offered to end users. */
	readonly devOnly: boolean;
	/** Returns the agent's CLI if it is installed. */
	locate(configuredPath: string | undefined): string | undefined;
	/** How to install the agent on this platform, if Active can do it. */
	installer(platform: NodeJS.Platform): InstallerSpec | undefined;
	readonly signInMethods: readonly SignInMethodSpec[];
	/** Environment variable that carries an API key. */
	readonly apiKeyEnvVar?: string;
	readonly apiKeyHelpUrl?: string;
	/** How to run the provider's browser sign-in without showing a terminal. */
	readonly browserSignIn?: BrowserSignInSpec;
	startHost(bin: string, options: HostOptions): Promise<AgentHost>;
	/** Whether a turn failure means the user has to sign in again. */
	isAuthFailure(errorKind: string | undefined, message: string | undefined): boolean;
	/** Whether the agent has credentials, checked before the first task. `undefined` when it can't tell. */
	isSignedIn?(bin: string, env: Record<string, string>): Promise<boolean | undefined>;
}

// Muse's built-in reminder observers (goal, verify, todo, skill) read each prompt and can push the
// session to carry out the work it describes. The explanation prompt quotes the user's coding task, so
// with them on, the explainer tries to do that task (its writes are refused) and its turn never ends.
// They also add roughly a third to each turn's tokens.
const REMINDERS = ['goal-reminder', 'verify-reminder', 'todo-reminder', 'skill-reminder'];
// The explainer only reads: it gets Muse's file reading and search tools and nothing else (no shell,
// writes, web, memory, goals, schedules or todos), so agent features can't pull it into doing work.
const EXPLANATION_TOOLS = ['read_file', 'search'];
const EXPLANATION_SERVE_ARGS = [
	'-c', `runtime_capabilities=${JSON.stringify(Object.fromEntries(REMINDERS.map(id => [`plugin:tbh-reminders:reminder:${id}`, { enabled: false }])))}`,
	'-c', `run.toolset=${JSON.stringify(EXPLANATION_TOOLS)}`,
];

const MUSE_INSTALLER_SH = 'https://dev.meta.ai/install.sh';
const MUSE_INSTALLER_PS1 = 'https://dev.meta.ai/install.ps1';

export class MuseProvider implements AgentProvider {
	readonly id = 'muse';
	readonly displayName = 'Muse Code';
	readonly shortName = 'Muse';
	readonly devOnly = false;
	readonly apiKeyEnvVar = 'META_API_KEY';
	readonly apiKeyHelpUrl = 'https://dev.meta.ai/docs/muse-code/auth';
	readonly signInMethods: readonly SignInMethodSpec[] = [
		{ id: 'subscription', label: 'Muse subscription', description: 'Sign in with your browser.' },
		{ id: 'apiKey', label: 'Meta API key', description: 'Pay as you go. Stored in your keychain.' },
	];

	locate(configuredPath: string | undefined): string | undefined {
		if (configuredPath) {
			return existsSync(configuredPath) ? configuredPath : undefined;
		}
		const names = process.platform === 'win32' ? ['muse.exe', 'muse.cmd'] : ['muse'];
		const dirs = [...(process.env.PATH ?? '').split(path.delimiter), path.join(os.homedir(), '.local', 'bin')];
		for (const dir of dirs) {
			for (const name of names) {
				const candidate = path.join(dir, name);
				if (dir && existsSync(candidate)) {
					return candidate;
				}
			}
		}
		return undefined;
	}

	installer(platform: NodeJS.Platform): InstallerSpec | undefined {
		if (platform === 'win32') {
			return { display: `irm ${MUSE_INSTALLER_PS1} | iex`, scriptUrl: MUSE_INSTALLER_PS1, command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `irm ${MUSE_INSTALLER_PS1} | iex`] };
		}
		return { display: `curl -fsSL ${MUSE_INSTALLER_SH} | sh`, scriptUrl: MUSE_INSTALLER_SH, command: '/bin/sh', args: ['-c', `curl -fsSL ${MUSE_INSTALLER_SH} | sh`] };
	}

	// `muse login` runs a device-code browser sign-in and exits when it's approved.
	readonly browserSignIn: BrowserSignInSpec = { mode: 'command', args: ['login'] };

	startHost(bin: string, options: HostOptions): Promise<AgentHost> {
		return MuseHost.spawn(bin, options.cwd, options.log, options.env, options.role === 'explanation' ? EXPLANATION_SERVE_ARGS : []);
	}

	isAuthFailure(errorKind: string | undefined, message: string | undefined): boolean {
		return errorKind === 'authRequired' || /\b(not signed in|sign in|authenticat|unauthori[sz]ed|credential)/i.test(message ?? '');
	}

	isSignedIn(bin: string, env: Record<string, string>): Promise<boolean | undefined> {
		if (env[this.apiKeyEnvVar] || process.env[this.apiKeyEnvVar]) {
			return Promise.resolve(true);
		}
		// `muse usage` answers "not logged in: run `muse login` first" when there are no credentials.
		return new Promise(resolve => execFile(bin, ['usage'], { env: { ...process.env, ...env }, timeout: 15000 }, (error, stdout, stderr) => {
			const output = `${stdout}${stderr}`;
			resolve(/not logged in/i.test(output) ? false : error ? undefined : true);
		}));
	}
}

/** DEV ONLY: sessions served by external agents through a mailbox directory. */
export class BridgeProvider implements AgentProvider {
	readonly id = 'bridge';
	readonly displayName = 'Claude Code subagent bridge';
	readonly shortName = 'Agent';
	readonly devOnly = true;
	readonly signInMethods: readonly SignInMethodSpec[] = [];

	constructor(private readonly bridgeDir: string) { }

	locate(): string | undefined {
		return this.bridgeDir;
	}

	installer(): undefined {
		return undefined;
	}

	async startHost(_bin: string, options: HostOptions): Promise<AgentHost> {
		options.log(`dev bridge backend at ${this.bridgeDir}`);
		return new BridgeHost(this.bridgeDir, options.role);
	}

	isAuthFailure(): boolean {
		return false;
	}
}
