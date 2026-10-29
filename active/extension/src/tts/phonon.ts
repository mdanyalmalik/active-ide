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

export type PhononStatus = NarrationStatus;

/** Storytelling character voices (a demon, a wizard…) as opposed to everyday narrators. */
function isCharacterVoice(name: string, description: string | undefined): boolean {
	return / /.test(name) || /\b(demon|wizard|knight|gravedigger|ogre|elf|queen|pirate|godmother|creature|dragon|monster|witch|giant|ghost)\b/i.test(description ?? '');
}

/**
 * Client for the Phonon 31M English sidecar. Audio is synthesized on demand from
 * narration text and returned in memory; it is never written to history.
 */
export class PhononNarrator {
	private child: ChildProcessWithoutNullStreams | undefined;
	private ready: Promise<void> | undefined;
	private readonly pending = new Map<string, Pending>();
	private nextId = 1;
	private status: PhononStatus = { available: false, detail: 'Phonon not started' };
	private voices: VoiceInfo[] = [];

	constructor(private readonly python: string, private readonly script: string, private readonly onStatus: (status: PhononStatus) => void, private readonly log: (line: string) => void) { }

	get currentStatus(): PhononStatus {
		return this.status;
	}

	start(): Promise<void> {
		if (this.ready) {
			return this.ready;
		}
		this.ready = new Promise<void>((resolve, reject) => {
			if (!existsSync(this.python)) {
				this.setStatus({ available: false, detail: `Python for Phonon not found at ${this.python}. Run scripts/setup-tts.sh or set active.narration.pythonPath.` });
				reject(new Error(this.status.detail));
				return;
			}
			this.setStatus({ available: false, detail: 'Loading Phonon 31M…' });
			const child = spawn(this.python, [this.script], { stdio: ['pipe', 'pipe', 'pipe'] });
			this.child = child;
			child.stderr.on('data', chunk => this.log(`[phonon] ${String(chunk).trimEnd()}`));
			const lines = readline.createInterface({ input: child.stdout });
			let started = false;
			lines.on('line', line => {
				let message: { ready?: boolean; error?: string; id?: string; wav?: string; model?: string; voices?: Array<{ name: string; description?: string } | string> };
				try {
					message = JSON.parse(line);
				} catch {
					this.log(`[phonon] ${line}`);
					return;
				}
				if (!started && message.ready !== undefined) {
					started = true;
					if (message.ready) {
						this.voices = (message.voices ?? []).map(voice => typeof voice === 'string' ? { name: voice } : { name: voice.name, description: voice.description || undefined, character: voice.name !== 'default' && isCharacterVoice(voice.name, voice.description) });
						this.setStatus({ available: true, detail: 'Phonon 31M English · on-device' });
						resolve();
					} else {
						this.setStatus({ available: false, detail: `Phonon failed to load: ${message.error}` });
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
				const error = new Error(`Phonon sidecar exited (${code})`);
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
			throw new Error('Phonon is not running');
		}
		const id = String(this.nextId++);
		return new Promise<string>((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			child.stdin.write(`${JSON.stringify({ id, text, voice })}\n`);
		});
	}

	private setStatus(status: PhononStatus): void {
		status = { ...status, voices: this.voices.length ? this.voices : undefined };
		this.status = status;
		this.onStatus(status);
	}

	dispose(): void {
		this.child?.kill();
		this.child = undefined;
	}
}
