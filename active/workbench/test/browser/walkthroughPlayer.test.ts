/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import type { Scene, SynthesizeResult, Walkthrough } from '../../common/activeProtocol.js';
import { ClipPlayer } from '../../browser/clipPlayer.js';
import type { NarrationSource } from '../../browser/narrationCache.js';
import { PlaybackPosition, WalkthroughPlayer } from '../../browser/walkthroughPlayer.js';

/** Audio that plays only when told to: `finish()` ends it, as if the sentence had been read. */
class FakeAudio {
	src = '';
	playbackRate = 1;
	preservesPitch = true;
	ended = false;
	paused = true;
	onended: (() => void) | null = null;
	onerror: (() => void) | null = null;
	play(): Promise<void> {
		this.paused = false;
		return Promise.resolve();
	}
	pause(): void {
		this.paused = true;
	}
	finish(): void {
		this.ended = true;
		this.paused = true;
		this.onended?.();
	}
}

/** A tiny valid base64 payload: the fake audio never decodes it. */
const WAV = 'UklGRgAAAAA=';

function scene(id: string, segments: number): Scene {
	return {
		id, role: 'implementation', label: id, title: id, file: 'a.ts', version: 'final', focus: [{ startLine: 1, endLine: 1 }], anchorLine: 1,
		narration: Array.from({ length: segments }, (_, index) => ({ text: `${id} sentence ${index + 1}.` })),
	};
}

/** Two scenes of two sentences each: A1 A2 | B1 B2. */
const walkthrough: Walkthrough = {
	id: 'wt-test', sessionId: 's', turnId: 't', turnIndex: 1, task: 'task', title: 'title', summary: 'summary', createdAt: 0,
	terms: [], scenes: [scene('A', 2), scene('B', 2)], pending: [], files: {},
};

/** Narration that answers at once, or holds a sentence until released, or fails. */
class FakeNarration implements NarrationSource {
	held = new Map<string, (result: SynthesizeResult) => void>();
	hold = new Set<string>();
	fail = false;
	audio(text: string): Promise<SynthesizeResult> {
		if (this.fail) {
			return Promise.resolve({ error: 'no narrator' });
		}
		if (this.hold.has(text)) {
			return new Promise(resolve => this.held.set(text, resolve));
		}
		return Promise.resolve({ wav: WAV });
	}
	prefetchFrom(): void { }
}

const settle = async () => {
	for (let index = 0; index < 5; index++) {
		await new Promise(resolve => setTimeout(resolve, 0));
	}
};

suite('Active WalkthroughPlayer: "More detail" and questions stop after the sentence being read', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let audios: FakeAudio[];
	let narration: FakeNarration;

	setup(() => {
		audios = [];
		narration = new FakeNarration();
	});

	function player(start: PlaybackPosition = { scene: 0, segment: 0 }, sceneGapMs = 0, rate = 1): WalkthroughPlayer {
		return store.add(new WalkthroughPlayer(walkthrough, start, narration, () => rate, {
			sceneGapMs,
			createAudio: () => {
				const audio = new FakeAudio();
				audios.push(audio);
				return audio as unknown as HTMLAudioElement;
			},
		}));
	}

	const current = () => audios[audios.length - 1];
	const at = (p: WalkthroughPlayer) => `${p.walkthrough.scenes[p.position.scene].id}${p.position.segment + 1}`;

	test('mid-scene: the sentence finishes, then it pauses on the next sentence of the same scene', async () => {
		const p = player();
		p.play();
		await settle();
		assert.strictEqual(p.state, 'speaking');
		p.pauseAfterSegment();
		assert.strictEqual(p.state, 'speaking', 'the sentence is not cut off');
		assert.strictEqual(current().paused, false);
		current().finish();
		await settle();
		assert.strictEqual(p.state, 'paused');
		assert.strictEqual(at(p), 'A2');
		assert.strictEqual(audios.length, 1, 'the next sentence is not started');
		p.play();
		await settle();
		assert.strictEqual(p.state, 'speaking');
		assert.strictEqual(at(p), 'A2');
		assert.strictEqual(audios.length, 2);
	});

	test('on a scene\'s last sentence: the scene stays on screen, and play carries on with the next scene', async () => {
		const p = player({ scene: 0, segment: 1 });
		p.play();
		await settle();
		p.pauseAfterSegment();
		current().finish();
		await settle();
		assert.strictEqual(p.state, 'paused');
		assert.strictEqual(at(p), 'A2', 'still on scene A, so its deeper explanation stays visible');
		p.play();
		await settle();
		assert.strictEqual(at(p), 'B1');
		assert.strictEqual(p.state, 'speaking');
	});

	test('in the pause between scenes: stops at once on the finished scene, then play goes to the next scene', async () => {
		const p = player({ scene: 0, segment: 1 }, 60_000);
		p.play();
		await settle();
		current().finish();
		await settle();
		assert.strictEqual(at(p), 'A2', 'waiting between scenes');
		assert.strictEqual(p.state, 'speaking');
		p.pauseAfterSegment();
		assert.strictEqual(p.state, 'paused');
		assert.strictEqual(at(p), 'A2');
		p.play();
		await settle();
		assert.strictEqual(at(p), 'B1');
	});

	test('while the next sentence is still being synthesized: pauses at once and the late audio never plays', async () => {
		narration.hold.add('A sentence 1.');
		const p = player();
		p.play();
		await settle();
		assert.strictEqual(p.state, 'loading');
		p.pauseAfterSegment();
		assert.strictEqual(p.state, 'paused');
		narration.held.get('A sentence 1.')!({ wav: WAV });
		await settle();
		assert.strictEqual(audios.length, 0);
		assert.strictEqual(p.state, 'paused');
	});

	test('while already paused: nothing changes, and play resumes the same sentence', async () => {
		const p = player();
		p.play();
		await settle();
		p.pause();
		p.pauseAfterSegment();
		assert.strictEqual(p.state, 'paused');
		assert.strictEqual(at(p), 'A1');
		p.play();
		await settle();
		assert.strictEqual(p.state, 'speaking');
		assert.strictEqual(at(p), 'A1');
		assert.strictEqual(audios.length, 1, 'the paused sentence resumes rather than restarting');
	});

	test('on the walkthrough\'s last sentence: it ends normally', async () => {
		const p = player({ scene: 1, segment: 1 });
		p.play();
		await settle();
		p.pauseAfterSegment();
		current().finish();
		await settle();
		assert.strictEqual(p.state, 'ended');
	});

	test('after it has ended: nothing changes', async () => {
		const p = player({ scene: 1, segment: 1 });
		p.play();
		await settle();
		current().finish();
		await settle();
		p.pauseAfterSegment();
		assert.strictEqual(p.state, 'ended');
	});

	test('pausing by hand, then playing again, forgets the request: narration runs on normally', async () => {
		const p = player();
		p.play();
		await settle();
		p.pauseAfterSegment();
		p.pause();
		p.play();
		await settle();
		current().finish();
		await settle();
		assert.strictEqual(p.state, 'speaking');
		assert.strictEqual(at(p), 'A2');
	});

	test('jumping elsewhere forgets the request', async () => {
		const p = player();
		p.play();
		await settle();
		p.pauseAfterSegment();
		p.seek({ scene: 1, segment: 0 });
		await settle();
		current().finish();
		await settle();
		assert.strictEqual(p.state, 'speaking');
		assert.strictEqual(at(p), 'B2');
	});

	test('without a narrator (captions on a timer): the caption finishes, then it pauses', async () => {
		narration.fail = true;
		// Normal speed: a short caption stays up for 1.8 s, long enough to ask before it ends.
		const p = player();
		p.play();
		await settle();
		assert.strictEqual(p.state, 'speaking');
		assert.ok(p.narrationIssue);
		p.pauseAfterSegment();
		assert.strictEqual(p.state, 'speaking');
		await new Promise(resolve => setTimeout(resolve, 2000));
		await settle();
		assert.strictEqual(p.state, 'paused');
		assert.strictEqual(at(p), 'A2');
	});
});

suite('Active WalkthroughPlayer with audio off: read a whole scene at a time', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let audios: number;
	let silent: boolean;

	setup(() => {
		audios = 0;
		silent = true;
	});

	/** Scene A focuses two ranges in turn (the voice would move between them), with a diagram cue. */
	const cued: Walkthrough = {
		...walkthrough,
		scenes: [
			{ ...scene('A', 2), focus: [{ startLine: 1, endLine: 2 }, { startLine: 4, endLine: 5 }], narration: [{ text: 'first', cue: { focus: 0, nodes: ['x'] } }, { text: 'second', cue: { focus: 1, nodes: ['y'], reveal: 2 } }] },
			scene('B', 2),
		],
	};

	function player(): WalkthroughPlayer {
		return store.add(new WalkthroughPlayer(cued, { scene: 0, segment: 0 }, new FakeNarration(), () => 1, {
			sceneGapMs: 0,
			silent: () => silent,
			createAudio: () => {
				audios++;
				return new FakeAudio() as unknown as HTMLAudioElement;
			},
		}));
	}

	test('nothing plays, and the whole scene shows at once: every focus range evenly, every cue applied', async () => {
		const p = player();
		p.play();
		await settle();
		const visual = p.visual;
		assert.deepStrictEqual({ state: p.state, audios, focus: visual.focus, nodes: visual.nodes, reveal: visual.reveal }, { state: 'paused', audios: 0, focus: undefined, nodes: ['y'], reveal: 2 });
	});

	test('Next and Previous move a whole scene; Next on the last scene (Done) finishes it', () => {
		const p = player();
		const at = () => `${p.position.scene}/${p.position.segment} ${p.state}`;
		const steps = [at()];
		p.advance();
		steps.push(at());
		p.advance();
		steps.push(at());
		p.rewind();
		steps.push(at());
		p.rewind();
		steps.push(at());
		assert.deepStrictEqual(steps, ['0/0 paused', '1/0 paused', '1/0 ended', '0/0 paused', '0/0 paused']);
	});

	test('turning audio back on: narration plays and the voice leads the highlighting again', async () => {
		const p = player();
		silent = false;
		assert.strictEqual(p.visual.focus, 0);
		p.play();
		await settle();
		assert.deepStrictEqual({ state: p.state, audios }, { state: 'speaking', audios: 1 });
	});
});

suite('Active ClipPlayer: how a read-aloud clip ends', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	let audios: FakeAudio[];

	setup(() => audios = []);

	function clips(): ClipPlayer {
		return store.add(new ClipPlayer(() => 1, () => {
			const audio = new FakeAudio();
			audios.push(audio);
			return audio as unknown as HTMLAudioElement;
		}));
	}

	test('played to the end', async () => {
		const player = clips();
		const outcome = player.play(async () => ({ wav: WAV }));
		await settle();
		assert.strictEqual(player.speaking, true);
		audios[0].finish();
		assert.deepStrictEqual(await outcome, { kind: 'ended' });
		assert.strictEqual(player.speaking, false);
	});

	test('stopped while playing', async () => {
		const player = clips();
		const outcome = player.play(async () => ({ wav: WAV }));
		await settle();
		player.stop();
		assert.deepStrictEqual(await outcome, { kind: 'stopped' });
	});

	test('stopped while still being synthesized', async () => {
		const player = clips();
		let release!: (result: SynthesizeResult) => void;
		const outcome = player.play(() => new Promise(resolve => release = resolve));
		player.stop();
		release({ wav: WAV });
		assert.deepStrictEqual(await outcome, { kind: 'stopped' });
		assert.strictEqual(audios.length, 0);
	});

	test('replaced by another clip', async () => {
		const player = clips();
		const first = player.play(async () => ({ wav: WAV }));
		await settle();
		const second = player.play(async () => ({ wav: WAV }));
		assert.deepStrictEqual(await first, { kind: 'stopped' });
		await settle();
		audios[1].finish();
		assert.deepStrictEqual(await second, { kind: 'ended' });
	});

	test('the narrator failed: the error is reported, not swallowed', async () => {
		const player = clips();
		assert.deepStrictEqual(await player.play(async () => ({ error: 'Phonon is not running' })), { kind: 'failed', error: 'Phonon is not running' });
		assert.strictEqual(player.speaking, false);
	});
});
