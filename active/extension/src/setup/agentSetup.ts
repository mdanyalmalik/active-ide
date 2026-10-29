/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcess, spawn } from 'node:child_process';
import * as readline from 'node:readline';
import type { AgentProvider, InstallerSpec } from '../agents/providers';
import type { SetupState, SignInMethod } from '../shared/activeProtocol';

export interface SecretStore {
	get(key: string): Thenable<string | undefined>;
	store(key: string, value: string): Thenable<void>;
	delete(key: string): Thenable<void>;
}

export interface AgentSetupOptions {
	readonly platform: NodeJS.Platform;
	readonly configuredPath: () => string | undefined;
	readonly secrets: SecretStore;
	/** Script that drives browser sign-in in a hidden pseudo-terminal. */
	readonly signInScript: string;
	readonly python: () => string | undefined;
	/** Throwaway directory for sign-in, so no real project is ever trusted on the user's behalf. */
	readonly scratchDir: string;
	/** DEV ONLY: replaces the provider's installer (for testing the flow without installing). */
	readonly installerOverride?: () => InstallerSpec | undefined;
	readonly emit: (state: SetupState | undefined) => void;
	/** Called when setup finishes; reconnects the agent. */
	readonly onReady: () => Promise<void>;
	readonly log: (line: string) => void;
}

const LOG_LINES = 200;

/**
 * Provider-agnostic first-run setup: install the agent's CLI, ask whether the
 * user signs in with a subscription or an API key, then sign in without ever
 * showing a terminal. API keys are kept in the system keychain (VS Code secret
 * storage) and handed to the agent through its documented environment variable.
 */
export class AgentSetup {
	private state: SetupState | undefined;
	private running: ChildProcess | undefined;

	constructor(private readonly provider: AgentProvider, private readonly options: AgentSetupOptions) { }

	get current(): SetupState | undefined {
		return this.state;
	}

	private get secretKey(): string {
		return `active.agent.${this.provider.id}.apiKey`;
	}

	private installer(): InstallerSpec | undefined {
		return this.options.installerOverride?.() ?? this.provider.installer(this.options.platform);
	}

	/** The agent's CLI, if installed. */
	locate(): string | undefined {
		return this.provider.locate(this.options.configuredPath());
	}

	/** Extra environment for the agent process: the stored API key, if the user chose one. */
	async agentEnv(): Promise<Record<string, string>> {
		const key = this.provider.apiKeyEnvVar ? await this.options.secrets.get(this.secretKey) : undefined;
		return key && this.provider.apiKeyEnvVar ? { [this.provider.apiKeyEnvVar]: key } : {};
	}

	async usesApiKey(): Promise<boolean> {
		return Object.keys(await this.agentEnv()).length > 0;
	}

	private base(step: SetupState['step'], reason?: string): SetupState {
		const installer = this.installer();
		return {
			step,
			reason,
			install: {
				status: step === 'install' ? 'idle' : 'done',
				command: installer?.display,
				scriptUrl: installer?.scriptUrl,
				log: [],
				unavailable: installer ? undefined : `Active can't install ${this.provider.displayName} on this platform. Install it yourself, then reload.`,
			},
			methods: this.provider.signInMethods.map(method => ({
				...method,
				unavailable: method.id === 'subscription' && (!this.provider.browserSignIn || this.options.platform === 'win32')
					? `Browser sign-in from Active isn't available here yet. Use an API key, or sign in with ${this.provider.displayName} in a terminal.`
					: undefined,
			})),
			signIn: { status: 'idle' },
			apiKeyEnvVar: this.provider.apiKeyEnvVar,
			apiKeyHelpUrl: this.provider.apiKeyHelpUrl,
		};
	}

	private update(patch: Partial<SetupState> | ((state: SetupState) => Partial<SetupState>)): void {
		if (!this.state) {
			return;
		}
		this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
		this.options.emit(this.state);
	}

	private finish(): void {
		this.state = undefined;
		this.options.emit(undefined);
		void this.options.onReady();
	}

	/** Decides whether setup is needed before connecting. Returns true when it is. */
	evaluate(): boolean {
		if (this.locate()) {
			return this.state !== undefined;
		}
		this.state = this.base('install');
		this.options.emit(this.state);
		return true;
	}

	/** Asks the agent whether it has credentials, and shows sign-in up front when it doesn't. */
	async checkSignedIn(): Promise<void> {
		const bin = this.locate();
		if (!bin || this.state || !this.provider.isSignedIn) {
			return;
		}
		if (await this.provider.isSignedIn(bin, await this.agentEnv()) === false && !this.state) {
			this.requireSignIn();
		}
	}

	/** The agent reported that it needs sign-in (or the user asked to switch accounts). */
	requireSignIn(reason?: string): void {
		if (this.state?.step === 'signIn' && this.state.signIn.status !== 'failed') {
			return;
		}
		this.state = this.base('chooseMethod', reason);
		this.options.emit(this.state);
	}

	async install(): Promise<void> {
		const installer = this.installer();
		if (!installer || !this.state || this.running) {
			return;
		}
		this.update({ install: { ...this.state.install, status: 'running', line: 'Starting the installer…', log: [], error: undefined } });
		const log: string[] = [];
		const ok = await new Promise<boolean>(resolve => {
			const child = spawn(installer.command, [...installer.args], { env: { ...process.env, ...installer.env }, stdio: ['ignore', 'pipe', 'pipe'] });
			this.running = child;
			const onLine = (line: string) => {
				const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').trim();
				if (!clean) {
					return;
				}
				log.push(clean);
				if (log.length > LOG_LINES) {
					log.shift();
				}
				this.update(state => ({ install: { ...state.install, line: clean, log: [...log] } }));
			};
			readline.createInterface({ input: child.stdout! }).on('line', onLine);
			readline.createInterface({ input: child.stderr! }).on('line', onLine);
			child.on('error', error => {
				onLine(String(error));
				resolve(false);
			});
			child.on('exit', code => resolve(code === 0));
		});
		this.running = undefined;
		if (!this.state) {
			return;
		}
		if (!ok) {
			this.update(state => ({ install: { ...state.install, status: 'failed', error: `The installer stopped before finishing. ${log[log.length - 1] ?? ''}`.trim() } }));
			return;
		}
		if (!this.locate()) {
			this.update(state => ({ install: { ...state.install, status: 'failed', error: `The installer finished, but Active can't find the ${this.provider.displayName} command. Set its path in Settings (active.muse.binaryPath) or reload.` } }));
			return;
		}
		this.options.log(`${this.provider.displayName} installed`);
		// A fresh install has no credentials yet: go straight to choosing how to sign in.
		this.update(state => ({ step: 'chooseMethod', install: { ...state.install, status: 'done', line: 'Installed' } }));
	}

	chooseMethod(method: SignInMethod): void {
		if (!this.state) {
			return;
		}
		if (method === 'subscription') {
			// A stored key would take precedence over the subscription session.
			void this.clearApiKey();
		}
		this.update({ step: 'signIn', method, signIn: { status: 'idle' } });
	}

	/** Runs the provider's browser sign-in in a hidden pseudo-terminal and reports progress. */
	async signInWithBrowser(): Promise<void> {
		const bin = this.locate();
		const spec = this.provider.browserSignIn;
		const python = this.options.python();
		if (!this.state || this.running) {
			return;
		}
		if (!bin || !spec || !python || this.options.platform === 'win32') {
			this.update({ signIn: { status: 'failed', message: `Browser sign-in from Active isn't available on this system. Use an API key, or sign in with ${this.provider.displayName} in a terminal.` } });
			return;
		}
		this.update({ signIn: { status: 'running', message: 'Starting sign-in…' } });
		const child = spawn(python, [this.options.signInScript, spec.mode, this.options.scratchDir, '300', bin, ...spec.args], { stdio: ['pipe', 'pipe', 'pipe'] });
		this.running = child;
		child.stderr.on('data', chunk => this.options.log(`[sign-in] ${String(chunk).trimEnd()}`));
		let finished = false;
		readline.createInterface({ input: child.stdout }).on('line', line => {
			let event: { event?: string; stage?: string; text?: string; url?: string; code?: string; ok?: boolean; reason?: string; transcript?: string };
			try {
				event = JSON.parse(line);
			} catch {
				return;
			}
			if (event.event === 'status') {
				this.update(state => ({ signIn: { ...state.signIn, status: event.stage === 'waitingForBrowser' || event.stage === 'finishing' ? 'waitingForBrowser' : 'running', message: event.text } }));
			} else if (event.event === 'url' && event.url) {
				this.update(state => ({ signIn: { ...state.signIn, url: event.url } }));
			} else if (event.event === 'code' && event.code) {
				this.update(state => ({ signIn: { ...state.signIn, code: event.code } }));
			} else if (event.event === 'done') {
				finished = true;
				if (event.ok) {
					this.update({ signIn: { status: 'done', message: 'Signed in' } });
					setTimeout(() => this.finish(), 900);
				} else {
					this.options.log(`sign-in did not complete (${event.reason}):\n${event.transcript ?? ''}`);
					const message = event.reason === 'cancelled'
						? 'Sign-in cancelled.'
						: event.reason === 'timeout'
							? 'Sign-in timed out. Try again when you are ready to approve it in your browser.'
							: `Sign-in didn't complete (${event.reason}). Try again, or use an API key instead.`;
					this.update({ signIn: { status: 'failed', message } });
				}
			}
		});
		child.on('exit', () => {
			this.running = undefined;
			if (!finished && this.state?.signIn.status !== 'done') {
				this.update({ signIn: { status: 'failed', message: 'Sign-in stopped unexpectedly. Try again, or use an API key instead.' } });
			}
		});
	}

	async saveApiKey(key: string): Promise<void> {
		const trimmed = key.trim();
		if (!this.state || !trimmed) {
			return;
		}
		await this.options.secrets.store(this.secretKey, trimmed);
		this.update({ signIn: { status: 'done', message: 'API key saved to your keychain' } });
		setTimeout(() => this.finish(), 600);
	}

	/** Forgets the stored API key (e.g. when switching to the subscription). */
	async clearApiKey(): Promise<void> {
		await this.options.secrets.delete(this.secretKey);
	}

	cancel(): void {
		if (this.running) {
			this.running.stdin?.write('cancel\n');
			const child = this.running;
			setTimeout(() => child.kill(), 1500);
		}
	}

	/** Back to choosing how to sign in. */
	restart(): void {
		this.cancel();
		this.state = this.base('chooseMethod', this.state?.reason);
		this.options.emit(this.state);
	}
}
