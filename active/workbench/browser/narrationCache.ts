/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import type { SynthesizeResult, Walkthrough } from '../common/activeProtocol.js';

export interface PlaybackPosition {
	readonly scene: number;
	readonly segment: number;
}

/** Where a player gets narration audio from. */
export interface NarrationSource {
	audio(text: string): Promise<SynthesizeResult>;
	/** Synthesizes the rest of the walkthrough in the background, starting at `from`. */
	prefetchFrom(walkthrough: Walkthrough, from: PlaybackPosition): void;
}

const MAX_ENTRIES = 400;

/**
 * Pre-generates narration for whole walkthroughs in the background, one segment
 * at a time so a request for the segment about to play never waits behind a
 * long queue. Audio lives in memory only; it is never written to history.
 */
export class NarrationCache extends Disposable implements NarrationSource {
	private readonly entries = new Map<string, Promise<SynthesizeResult>>();
	private generation = 0;

	constructor(private readonly synthesize: (text: string) => Promise<SynthesizeResult>) {
		super();
	}

	audio(text: string): Promise<SynthesizeResult> {
		let entry = this.entries.get(text);
		if (entry) {
			// Keep recently used entries at the end for eviction order.
			this.entries.delete(text);
		} else {
			entry = this.synthesize(text).catch(error => ({ error: String(error) }));
			void entry.then(result => {
				if (result.error) {
					this.entries.delete(text);
				}
			});
		}
		this.entries.set(text, entry);
		while (this.entries.size > MAX_ENTRIES) {
			this.entries.delete(this.entries.keys().next().value!);
		}
		return entry;
	}

	prefetchFrom(walkthrough: Walkthrough, from: PlaybackPosition): void {
		const generation = ++this.generation;
		const order: string[] = [];
		walkthrough.scenes.forEach((scene, sceneIndex) => scene.narration.forEach((segment, segmentIndex) => {
			const ahead = sceneIndex > from.scene || (sceneIndex === from.scene && segmentIndex >= from.segment);
			if (ahead) {
				order.push(segment.text);
			}
		}));
		// Then whatever lies behind, so rewinding is instant too.
		walkthrough.scenes.forEach((scene, sceneIndex) => scene.narration.forEach((segment, segmentIndex) => {
			const behind = sceneIndex < from.scene || (sceneIndex === from.scene && segmentIndex < from.segment);
			if (behind) {
				order.push(segment.text);
			}
		}));
		void (async () => {
			for (const text of order) {
				if (generation !== this.generation || this._store.isDisposed) {
					return;
				}
				const result = await this.audio(text);
				if (result.error) {
					return; // Narration unavailable; playback falls back to captions and retries on demand.
				}
			}
		})();
	}

	clear(): void {
		this.generation++;
		this.entries.clear();
	}
}
