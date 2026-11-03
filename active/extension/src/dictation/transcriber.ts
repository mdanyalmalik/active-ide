/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { TranscribeRequest, TranscribeResult } from '../shared/activeProtocol';
import { buildCleanupPrompt, pickVocabulary, sanitizeCleanup, transcribeErrorKind } from './cleanup';

/** `muse voice transcribe` is batch only; two minutes of speech comes back well inside this. */
const TRANSCRIBE_TIMEOUT_MS = 60_000;
/** Cleanup measured 3 to 6.5 s (Muse's ~15k-token system prompt dominates); past this the raw transcript is used. */
export const CLEANUP_TIMEOUT_MS = 8_000;
/** The cheapest model Muse Code 1.4 offers, when the workbench doesn't name one. */
const FALLBACK_CLEANUP_MODEL = 'muse-spark-1.3-contributor';

export interface DictationOptions {
	/** The Muse CLI, if installed. */
	readonly locate: () => string | undefined;
	/** Extra environment (a stored API key). */
	readonly env: () => Promise<Record<string, string>>;
	readonly log: (line: string) => void;
}

interface RunResult {
	readonly code: number | string | null;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
}

function run(bin: string, args: string[], env: Record<string, string>, cwd: string, timeout: number): Promise<RunResult> {
	return new Promise(resolve => {
		execFile(bin, args, { env: { ...process.env, ...env }, cwd, timeout, killSignal: 'SIGKILL', maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
			const failure = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
			resolve({
				code: failure ? failure.code ?? null : 0,
				stdout: String(stdout),
				stderr: String(stderr),
				timedOut: !!failure?.killed,
			});
		});
	});
}

/**
 * Push-to-talk dictation: `muse voice transcribe` on a temporary WAV, then (optionally) a one-shot `muse exec`
 * with a cheap model at minimal effort, under Muse's read-only permission profile and with no tools, in an empty
 * folder, so the cleanup can only ever reply with text.
 */
export class Dictation {
	constructor(private readonly options: DictationOptions) { }

	async transcribe(request: TranscribeRequest): Promise<TranscribeResult> {
		const bin = this.options.locate();
		if (!bin) {
			return { error: 'Muse Code is not installed.', errorKind: 'unavailable' };
		}
		const env = await this.options.env();
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-dictation-'));
		try {
			const clip = path.join(dir, 'clip.wav');
			await fs.writeFile(clip, Buffer.from(request.wav, 'base64'));
			const started = Date.now();
			const heard = await run(bin, ['voice', 'transcribe', clip], env, dir, TRANSCRIBE_TIMEOUT_MS);
			const raw = heard.stdout.trim();
			this.options.log(`dictation: transcribed in ${Date.now() - started} ms (exit ${heard.code})`);
			if (heard.code !== 0 || !raw) {
				const message = heard.timedOut ? 'Transcription timed out.' : (heard.stderr.replace(/^error:\s*/im, '').trim() || 'No words heard.');
				const errorKind = heard.timedOut ? 'failed' : heard.code === 0 ? 'empty' : transcribeErrorKind(heard.code, message);
				return { error: message, errorKind };
			}
			if (!request.cleanup) {
				return { text: raw, raw, cleaned: false };
			}
			const cleaned = await this.cleanUp(bin, env, dir, raw, request.cleanup);
			return cleaned ? { text: cleaned, raw, cleaned: true } : { text: raw, raw, cleaned: false };
		} finally {
			await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
		}
	}

	private async cleanUp(bin: string, env: Record<string, string>, dir: string, raw: string, cleanup: NonNullable<TranscribeRequest['cleanup']>): Promise<string | undefined> {
		const prompt = buildCleanupPrompt(raw, pickVocabulary(raw, cleanup.vocabulary), cleanup.dictionary, cleanup.before);
		const promptFile = path.join(dir, `prompt-${randomUUID()}.txt`);
		await fs.writeFile(promptFile, prompt);
		const started = Date.now();
		const result = await run(bin, [
			'exec',
			'--model', cleanup.model || FALLBACK_CLEANUP_MODEL,
			'--reasoning-effort', 'minimal',
			'--preset', 'empty',
			'--permission-profile', ':read-only',
			'--max-model-steps', '1',
			'--disable-shell', '--disable-write', '--disable-web-tools', '--disable-reminders', '--disable-request-user-input',
			'--no-foreign-personal-context', '--no-session-log',
			'--prompt-file', promptFile,
		], env, dir, CLEANUP_TIMEOUT_MS);
		const elapsed = Date.now() - started;
		if (result.timedOut || result.code !== 0) {
			this.options.log(`dictation: cleanup ${result.timedOut ? 'timed out' : `failed (exit ${result.code}): ${result.stderr.split('\n').find(line => !line.startsWith('muse:')) ?? ''}`} after ${elapsed} ms; using the raw transcript`);
			return undefined;
		}
		const text = sanitizeCleanup(result.stdout, raw);
		this.options.log(`dictation: cleaned up in ${elapsed} ms${text ? '' : ' (reply rejected; using the raw transcript)'}`);
		return text;
	}
}
