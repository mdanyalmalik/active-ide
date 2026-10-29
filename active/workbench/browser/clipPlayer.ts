/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { SynthesizeResult } from '../common/activeProtocol.js';

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

	constructor(private readonly rate: () => number) {
		super();
	}

	/** True while a clip is being synthesized or played. */
	get speaking(): boolean {
		return this.loading || !!this.audio;
	}

	async play(synthesize: () => Promise<SynthesizeResult>): Promise<void> {
		this.stop();
		const generation = ++this.generation;
		this.loading = true;
		this._onDidChange.fire();
		const result = await synthesize().catch(error => ({ error: String(error) }) as SynthesizeResult);
		if (generation !== this.generation) {
			return;
		}
		this.loading = false;
		if (!result.wav) {
			this._onDidChange.fire();
			return;
		}
		this.url = URL.createObjectURL(new Blob([new Uint8Array(decodeBase64(result.wav).buffer)], { type: 'audio/wav' }));
		const audio = mainWindow.document.createElement('audio');
		audio.src = this.url;
		audio.preservesPitch = true;
		audio.playbackRate = this.rate();
		audio.onended = () => this.stop();
		audio.onerror = () => this.stop();
		this.audio = audio;
		this._onDidChange.fire();
		await audio.play().catch(() => this.stop());
	}

	stop(): void {
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
