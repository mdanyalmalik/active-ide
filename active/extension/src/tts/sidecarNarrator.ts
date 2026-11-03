/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import * as readline from 'node:readline';
import type { NarrationStatus, VoiceInfo } from '../shared/activeProtocol';

interface Pending {
	resolve(wav: string): void;
	reject(error: Error): void;
}

/** A narration model run as a Python sidecar speaking the JSON-lines protocol of resources/*_sidecar.py. */
export interface NarrationEngine {
	/** Shown in the status bar and messages, e.g. "MMS English". */
	readonly name: string;
	readonly script: string;
	readonly args?: readonly string[];
	/** What the Python environment needs, for the "not found" message. */
	readonly needs: string;
}

/** Storytelling character voices (a demon, a wizard…) as opposed to everyday narrators. */
function isCharacterVoice(name: string, description: string | undefined): boolean {
	return / /.test(name) || /\b(demon|wizard|knight|gravedigger|ogre|elf|queen|pirate|godmother|creature|dragon|monster|witch|giant|ghost)\b/i.test(description ?? '');
}

/**
 * Client for a narration sidecar (MMS or Phonon). Audio is synthesized on demand from
 * narration text and returned in memory; it is never written to history.
 */
export class SidecarNarrator {
	private child: ChildProcessWithoutNullStreams | undefined;
	private ready: Promise<void> | undefined;
	private readonly pending = new Map<string, Pending>();
	private nextId = 1;
	private status: NarrationStatus;
	private voices: VoiceInfo[] = [];
	private model: string;

	constructor(private readonly engine: NarrationEngine, private readonly python: string, private readonly onStatus: (status: NarrationStatus) => void, private readonly log: (line: string) => void) {
		this.model = engine.name;
		this.status = { available: false, detail: `${engine.name} not started`, model: engine.name };
	}

	get currentStatus(): NarrationStatus {
		return this.status;
	}

	start(): Promise<void> {
		if (this.ready) {
			return this.ready;
		}
		this.ready = new Promise<void>((resolve, reject) => {
			if (!existsSync(this.python)) {
				this.setStatus({ available: false, detail: `Python for ${this.engine.name} (${this.engine.needs}) not found at ${this.python}. Run scripts/setup-tts.sh or set active.narration.pythonPath.` });
				reject(new Error(this.status.detail));
				return;
			}
			this.setStatus({ available: false, detail: `Loading ${this.engine.name}…` });
			const child = spawn(this.python, [this.engine.script, ...(this.engine.args ?? [])], { stdio: ['pipe', 'pipe', 'pipe'] });
			this.child = child;
			child.stderr.on('data', chunk => this.log(`[narration] ${String(chunk).trimEnd()}`));
			const lines = readline.createInterface({ input: child.stdout });
			let started = false;
			lines.on('line', line => {
				let message: { ready?: boolean; error?: string; id?: string; wav?: string; model?: string; voices?: Array<{ name: string; description?: string } | string>; label?: string };
				try {
					message = JSON.parse(line);
				} catch {
					this.log(`[narration] ${line}`);
					return;
				}
				if (!started && message.ready !== undefined) {
					started = true;
					if (message.ready) {
						this.voices = (message.voices ?? []).map(voice => typeof voice === 'string' ? { name: voice } : { name: voice.name, description: voice.description || undefined, character: voice.name !== 'default' && isCharacterVoice(voice.name, voice.description) });
						// `label` is a display name (a fine-tune's folder, say); `model` is only an id, so the engine's name is shown instead.
						this.model = message.label || this.engine.name;
						this.setStatus({ available: true, detail: `${this.model} · on-device` });
						resolve();
					} else {
						this.setStatus({ available: false, detail: `${this.engine.name} failed to load: ${message.error}` });
						reject(new Error(this.status.detail));
					}
					return;
				}
				const pending = message.id ? this.pending.get(message.id) : undefined;
				if (!pending) {
					return;
				}
				this.pending.delete(message.id!);
				if (message.wav) {
					pending.resolve(message.wav);
				} else {
					pending.reject(new Error(message.error ?? 'synthesis failed'));
				}
			});
			child.on('exit', code => {
				const error = new Error(`${this.engine.name} sidecar exited (${code})`);
				for (const pending of this.pending.values()) {
					pending.reject(error);
				}
				this.pending.clear();
				this.child = undefined;
				this.ready = undefined;
				if (!started) {
					this.setStatus({ available: false, detail: error.message });
					reject(error);
				} else {
					this.setStatus({ available: false, detail: `${error.message}; it restarts on the next narration` });
				}
			});
		});
		this.ready.catch(() => { this.ready = undefined; });
		return this.ready;
	}

	async synthesize(text: string, voice: string): Promise<string> {
		await this.start();
		const child = this.child;
		if (!child) {
			throw new Error(`${this.engine.name} is not running`);
		}
		const id = String(this.nextId++);
		return new Promise<string>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			child.stdin.write(`${JSON.stringify({ id, text, voice })}\n`);
		});
	}

	private setStatus(status: NarrationStatus): void {
		status = { ...status, model: this.model, voices: this.voices.length ? this.voices : undefined };
		this.status = status;
		this.onStatus(status);
	}

	dispose(): void {
		this.child?.kill();
		this.child = undefined;
	}
}
