/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { decodeBase64 } from '../../../../base/common/buffer.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import type { Cue, NarrationSegment, Scene, SynthesizeResult, Walkthrough } from '../common/activeProtocol.js';
import type { NarrationSource, PlaybackPosition } from './narrationCache.js';

export type { PlaybackPosition } from './narrationCache.js';

export type PlaybackState = 'paused' | 'loading' | 'speaking' | 'ended';

/** The visual state for a position: everything a scene shows once its cues up to `segment` have fired. */
export interface VisualState {
	readonly scene: Scene;
	readonly segment: NarrationSegment;
	readonly focus: number | undefined;
	readonly nodes: readonly string[];
	readonly reveal: number | undefined;
}

export function visualStateAt(walkthrough: Walkthrough, position: PlaybackPosition): VisualState {
	const scene = walkthrough.scenes[position.scene];
	let focus: number | undefined;
	let nodes: readonly string[] = [];
	let reveal: number | undefined;
	for (let index = 0; index <= position.segment && index < scene.narration.length; index++) {
		const cue: Cue | undefined = scene.narration[index].cue;
		if (cue?.focus !== undefined) {
			focus = cue.focus;
		}
		if (cue?.nodes) {
			nodes = cue.nodes;
		}
		if (cue?.reveal !== undefined) {
			reveal = Math.max(reveal ?? 0, cue.reveal);
		}
	}
	return { scene, segment: scene.narration[Math.min(position.segment, scene.narration.length - 1)], focus, nodes, reveal };
}

const SCENE_GAP_MS = 650;

/** Seams for tests: how narration audio is played and how long the pause between scenes lasts. */
export interface PlayerOptions {
	readonly createAudio?: (src: string) => HTMLAudioElement;
	readonly sceneGapMs?: number;
}
/** Pressing Next this soon after a scene appears (and before half of it is narrated) counts as an early skip. */
const QUICK_SKIP_MS = 6000;

/**
 * Plays a walkthrough: narration is synthesized (never persisted) from the
 * saved script segment by segment, and the position drives the visuals so
 * presentation and speech stay in step. Rewinding re-derives the visual state
 * for the earlier position, so it is restored exactly.
 */
export class WalkthroughPlayer extends Disposable {
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	/** The user skipped ahead before much of a scene was narrated (fires once per scene). */
	private readonly _onDidSkipEarly = this._register(new Emitter<number>());
	readonly onDidSkipEarly = this._onDidSkipEarly.event;
	private sceneShownAt = Date.now();
	private readonly skippedScenes = new Set<number>();

	private _position: PlaybackPosition;
	private _state: PlaybackState = 'paused';
	private _narrationIssue: string | undefined;
	private run = 0;
	private audio: HTMLAudioElement | undefined;
	private audioUrl: string | undefined;
	private audioPosition: PlaybackPosition | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** Set by `pauseAfterSegment`: stop when the sentence being read ends instead of cutting it off. */
	private stopAtSegmentEnd = false;
	/** Where `play` resumes after stopping at the end of a scene's last sentence (the scene stays on screen). */
	private continueAt: PlaybackPosition | undefined;
	/** The next scene while the short pause between scenes runs. */
	private gapNext: PlaybackPosition | undefined;

	constructor(
		readonly walkthrough: Walkthrough,
		start: PlaybackPosition,
		private readonly narration: NarrationSource,
		private readonly rate: () => number,
		private readonly options: PlayerOptions = {},
	) {
		super();
		this._position = start;
	}

	get position(): PlaybackPosition {
		return this._position;
	}

	get state(): PlaybackState {
		return this._state;
	}

	get playing(): boolean {
		return this._state === 'loading' || this._state === 'speaking';
	}

	/** Set when narration audio could not be produced; captions continue on a reading-speed timer. */
	get narrationIssue(): string | undefined {
		return this._narrationIssue;
	}

	get visual(): VisualState {
		return visualStateAt(this.walkthrough, this._position);
	}

	play(): void {
		if (this.playing) {
			return;
		}
		if (this._state === 'ended') {
			this._position = { scene: 0, segment: 0 };
		}
		this.stopAtSegmentEnd = false;
		if (this.continueAt) {
			this._position = this.continueAt;
			this.continueAt = undefined;
			this.sceneShownAt = Date.now();
			this.dropAudio();
		}
		const run = ++this.run;
		if (this.audio && this.audioPosition && this.samePosition(this.audioPosition, this._position) && !this.audio.ended) {
			// Resume the paused sentence, and hand its end to this run (the old run's handlers are ignored).
			const audio = this.audio;
			const segment = this.segmentAt(this._position)!;
			audio.onended = () => this.onSegmentDone(run);
			audio.onerror = () => this.fallbackTimer(run, segment, 'audio playback failed');
			this.setState('speaking');
			void audio.play().catch(() => this.speak(run));
			return;
		}
		void this.speak(run);
	}

	pause(): void {
		this.run++;
		this.stopAtSegmentEnd = false;
		this.clearTimer();
		this.audio?.pause();
		if (this._state !== 'ended') {
			this.setState('paused');
		}
	}

	/**
	 * Pauses once the sentence being read finishes (right away if nothing is being read), staying on this
	 * scene. `play` then carries on from the next sentence.
	 */
	pauseAfterSegment(): void {
		if (this.gapNext) {
			// The scene's last sentence has just ended.
			const next = this.gapNext;
			this.pause();
			this.continueAt = next;
		} else if (this._state === 'speaking') {
			this.stopAtSegmentEnd = true;
		} else if (this.playing) {
			this.pause();
		}
	}

	toggle(): void {
		if (this.playing) {
			this.pause();
		} else {
			this.play();
		}
	}

	/** Back one narration segment, or to the start of the previous scene from a scene's first segment. */
	rewind(): void {
		const { scene, segment } = this._position;
		if (segment > 0) {
			this.seek({ scene, segment: segment - 1 });
		} else if (scene > 0) {
			this.seek({ scene: scene - 1, segment: 0 });
		} else {
			this.seek({ scene: 0, segment: 0 });
		}
	}

	/** Forward to the next scene (the next coherent idea). */
	advance(): void {
		const { scene, segment } = this._position;
		const segments = this.walkthrough.scenes[scene].narration.length;
		if (this.playing && segment < Math.ceil(segments / 2) && Date.now() - this.sceneShownAt < QUICK_SKIP_MS && !this.skippedScenes.has(scene)) {
			this.skippedScenes.add(scene);
			this._onDidSkipEarly.fire(scene);
		}
		if (scene + 1 < this.walkthrough.scenes.length) {
			this.seek({ scene: scene + 1, segment: 0 });
		} else {
			this.pause();
			this.setState('ended');
		}
	}

	seek(position: PlaybackPosition): void {
		const wasPlaying = this.playing;
		this.run++;
		this.stopAtSegmentEnd = false;
		this.continueAt = undefined;
		this.clearTimer();
		this.dropAudio();
		const scene = Math.max(0, Math.min(position.scene, this.walkthrough.scenes.length - 1));
		const segment = Math.max(0, Math.min(position.segment, this.walkthrough.scenes[scene].narration.length - 1));
		if (scene !== this._position.scene) {
			this.sceneShownAt = Date.now();
		}
		this._position = { scene, segment };
		// Re-prioritize background synthesis around where the viewer jumped.
		this.narration.prefetchFrom(this.walkthrough, this._position);
		if (wasPlaying) {
			void this.speak(this.run);
		} else {
			this.setState('paused');
		}
	}

	private samePosition(a: PlaybackPosition, b: PlaybackPosition): boolean {
		return a.scene === b.scene && a.segment === b.segment;
	}

	private segmentAt(position: PlaybackPosition): NarrationSegment | undefined {
		return this.walkthrough.scenes[position.scene]?.narration[position.segment];
	}

	private next(position: PlaybackPosition): PlaybackPosition | undefined {
		const scene = this.walkthrough.scenes[position.scene];
		if (position.segment + 1 < scene.narration.length) {
			return { scene: position.scene, segment: position.segment + 1 };
		}
		if (position.scene + 1 < this.walkthrough.scenes.length) {
			return { scene: position.scene + 1, segment: 0 };
		}
		return undefined;
	}

	private audioFor(text: string): Promise<SynthesizeResult> {
		return this.narration.audio(text);
	}

	private async speak(run: number): Promise<void> {
		const position = this._position;
		const segment = this.segmentAt(position);
		if (!segment) {
			this.setState('ended');
			return;
		}
		this.setState('loading');
		const result = await this.audioFor(segment.text);
		if (run !== this.run) {
			return;
		}
		this.dropAudio();
		if (result.wav) {
			this._narrationIssue = undefined;
			const blob = new Blob([new Uint8Array(decodeBase64(result.wav).buffer)], { type: 'audio/wav' });
			this.audioUrl = URL.createObjectURL(blob);
			const audio = this.options.createAudio?.(this.audioUrl) ?? mainWindow.document.createElement('audio');
			audio.src = this.audioUrl;
			audio.preservesPitch = true;
			audio.playbackRate = this.rate();
			audio.onended = () => this.onSegmentDone(run);
			audio.onerror = () => this.fallbackTimer(run, segment, 'audio playback failed');
			this.audio = audio;
			this.audioPosition = position;
			this.setState('speaking');
			try {
				await audio.play();
			} catch (error) {
				this.fallbackTimer(run, segment, `audio playback failed: ${error}`);
			}
		} else {
			this.fallbackTimer(run, segment, result.error ?? 'narration unavailable');
		}
	}

	private fallbackTimer(run: number, segment: NarrationSegment, issue: string): void {
		if (run !== this.run) {
			return;
		}
		this._narrationIssue = issue;
		this.setState('speaking');
		const words = segment.text.split(/\s+/).length;
		const ms = Math.max(1800, (words / 2.6) * 1000) / this.rate();
		this.clearTimer();
		this.timer = setTimeout(() => this.onSegmentDone(run), ms);
	}

	private onSegmentDone(run: number): void {
		if (run !== this.run) {
			return;
		}
		const next = this.next(this._position);
		if (!next) {
			this.dropAudio();
			this.stopAtSegmentEnd = false;
			this.setState('ended');
			return;
		}
		const sceneChange = next.scene !== this._position.scene;
		if (this.stopAtSegmentEnd) {
			this.stopAtSegmentEnd = false;
			this.run++;
			this.dropAudio();
			if (sceneChange) {
				this.continueAt = next;
			} else {
				this._position = next;
			}
			this.setState('paused');
			return;
		}
		const advance = () => {
			if (run !== this.run) {
				return;
			}
			this.gapNext = undefined;
			this.dropAudio();
			if (next.scene !== this._position.scene) {
				this.sceneShownAt = Date.now();
			}
			this._position = next;
			this._onDidChange.fire();
			void this.speak(run);
		};
		if (sceneChange) {
			this.clearTimer();
			this.gapNext = next;
			this.timer = setTimeout(advance, this.options.sceneGapMs ?? SCENE_GAP_MS);
		} else {
			advance();
		}
	}

	/** Applies a changed narration speed to the segment currently playing. */
	updateRate(): void {
		if (this.audio) {
			this.audio.playbackRate = this.rate();
		}
	}

	private setState(state: PlaybackState): void {
		this._state = state;
		this._onDidChange.fire();
	}

	private clearTimer(): void {
		this.gapNext = undefined;
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
	}

	private dropAudio(): void {
		if (this.audio) {
			this.audio.onended = null;
			this.audio.onerror = null;
			this.audio.pause();
			this.audio = undefined;
			this.audioPosition = undefined;
		}
		if (this.audioUrl) {
			URL.revokeObjectURL(this.audioUrl);
			this.audioUrl = undefined;
		}
	}

	override dispose(): void {
		this.run++;
		this.clearTimer();
		this.dropAudio();
		super.dispose();
	}
}
