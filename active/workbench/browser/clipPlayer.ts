/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { SynthesizeResult } from '../common/activeProtocol.js';

/** How a clip ended: played to the end, stopped (or replaced) before that, or couldn't be played. */
export type ClipOutcome = { readonly kind: 'ended' } | { readonly kind: 'stopped' } | { readonly kind: 'failed'; readonly error: string };

/**
 * Plays one stand-alone narration clip at a time (a deeper explanation, a voice
 * preview), outside the walkthrough's own segment-by-segment narration. Audio
 * stays in memory and is released when the clip ends or is stopped.
 */
export class ClipPlayer extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private audio: HTMLAudioElement | undefined;
	private url: string | undefined;
	private generation = 0;
	private loading = false;
	private settle: ((outcome: ClipOutcome) => void) | undefined;

	constructor(private readonly rate: () => number, private readonly createAudio: (src: string) => HTMLAudioElement = () => mainWindow.document.createElement('audio')) {
		super();
	}

	/** True while a clip is being synthesized or played. */
	get speaking(): boolean {
		return this.loading || !!this.audio;
	}

	/** Synthesizes and plays a clip, replacing any clip in progress. Resolves when it has finished playing. */
	async play(synthesize: () => Promise<SynthesizeResult>): Promise<ClipOutcome> {
		this.stop();
		const generation = ++this.generation;
		const outcome = new Promise<ClipOutcome>(resolve => this.settle = resolve);
		this.loading = true;
		this._onDidChange.fire();
		const result = await synthesize().catch(error => ({ error: String(error) }) as SynthesizeResult);
		if (generation !== this.generation) {
			return outcome;
		}
		this.loading = false;
		if (!result.wav) {
			this.finish({ kind: 'failed', error: result.error ?? 'no audio was produced' });
			this._onDidChange.fire();
			return outcome;
		}
		this.url = URL.createObjectURL(new Blob([new Uint8Array(decodeBase64(result.wav).buffer)], { type: 'audio/wav' }));
		const audio = this.createAudio(this.url);
		audio.src = this.url;
		audio.preservesPitch = true;
		audio.playbackRate = this.rate();
		audio.onended = () => this.stop({ kind: 'ended' });
		audio.onerror = () => this.stop({ kind: 'failed', error: 'audio playback failed' });
		this.audio = audio;
		this._onDidChange.fire();
		await audio.play().catch(error => this.stop({ kind: 'failed', error: `audio playback failed: ${error}` }));
		return outcome;
	}

	private finish(outcome: ClipOutcome): void {
		const settle = this.settle;
		this.settle = undefined;
		settle?.(outcome);
	}

	stop(outcome: ClipOutcome = { kind: 'stopped' }): void {
		this.finish(outcome);
		const wasSpeaking = this.speaking;
		this.generation++;
		this.loading = false;
		if (this.audio) {
			this.audio.onended = null;
			this.audio.onerror = null;
			this.audio.pause();
			this.audio = undefined;
		}
		if (this.url) {
			URL.revokeObjectURL(this.url);
			this.url = undefined;
		}
		if (wasSpeaking) {
			this._onDidChange.fire();
		}
	}

	override dispose(): void {
		this.stop();
		super.dispose();
	}
}
