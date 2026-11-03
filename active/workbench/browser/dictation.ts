/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { decodeBase64, encodeBase64, VSBuffer } from '../../../../base/common/buffer.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKey, IContextKeyService, RawContextKey } from '../../../../platform/contextkey/common/contextkey.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IMicCaptureService, isMicrophonePermissionDeniedError } from '../../chat/browser/voiceClient/micCaptureService.js';
import { ActiveSetting, AgentModelInfo, DictationCleanupRequest, ExtensionCommand, TranscribeRequest, TranscribeResult } from '../common/activeProtocol.js';
import { IActiveService } from './activeService.js';

export const DICTATE_COMMAND_ID = 'active.dictate';
export const STOP_DICTATION_COMMAND_ID = 'active.dictate.stop';

/** The microphone service records 16 kHz mono PCM16. */
export const DICTATION_SAMPLE_RATE = 16000;
/** A recording stops by itself after two minutes. */
export const MAX_DICTATION_SECONDS = 120;
/** A press shorter than this is a tap (toggle); longer is hold-to-talk. */
export const DICTATION_HOLD_MS = 400;
/** Less audio than this is a slip of the finger: nothing is sent. */
const MIN_DICTATION_MS = 300;

export const ActiveDictationRecording = new RawContextKey<boolean>('activeDictationRecording', false, localize('activeDictationRecording', "Whether Active is recording dictation"));

export type DictationState = 'idle' | 'recording' | 'transcribing';

/** Where dictated text goes: the chat composer. */
export interface DictationTarget {
	readonly window: Window & typeof globalThis;
	/** False while the composer can't take text (a viewer in someone else's session). */
	canDictate(): boolean;
	isVisible(): boolean;
	/** The text before the cursor, for cleanup context. */
	textBeforeCursor(): string;
	/** Inserts at the cursor (never sends). */
	insert(text: string): void;
}

export const IActiveDictationService = createDecorator<IActiveDictationService>('activeDictationService');

export interface IActiveDictationService {
	readonly _serviceBrand: undefined;
	readonly state: DictationState;
	readonly onDidChangeState: Event<DictationState>;
	/** The composer dictation goes to, if one is showing. */
	readonly target: DictationTarget | undefined;
	registerTarget(target: DictationTarget): IDisposable;
	/** Marks a composer as the one in use (it was focused). */
	preferTarget(target: DictationTarget): void;
	start(target: DictationTarget): Promise<void>;
	/** Stops recording and transcribes. */
	stop(): void;
	/** Stops recording and throws the audio away. */
	cancel(): void;
	/**
	 * A press on the key or the mic button: starts recording (or stops it, if recording). Call the returned function
	 * on release: after a hold it stops and transcribes; after a quick tap recording carries on until the next tap.
	 */
	press(target: DictationTarget): () => void;
}

// ------------------------------------------------------------------------------------------------ pure helpers

/** Joins raw PCM16 chunks (dropping a trailing odd byte). */
export function joinPcm(chunks: readonly Uint8Array[]): Uint8Array {
	const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0) & ~1;
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		const take = Math.min(chunk.byteLength, total - offset);
		out.set(chunk.subarray(0, take), offset);
		offset += take;
	}
	return out;
}

/** Wraps mono PCM16 (little-endian) in a 44-byte WAV header. */
export function encodeWav(pcm: Uint8Array, sampleRate = DICTATION_SAMPLE_RATE): Uint8Array {
	const length = pcm.byteLength & ~1;
	const wav = new Uint8Array(44 + length);
	const view = new DataView(wav.buffer);
	const ascii = (offset: number, text: string) => { for (let i = 0; i < text.length; i++) { view.setUint8(offset + i, text.charCodeAt(i)); } };
	ascii(0, 'RIFF');
	view.setUint32(4, 36 + length, true);
	ascii(8, 'WAVE');
	ascii(12, 'fmt ');
	view.setUint32(16, 16, true);
	view.setUint16(20, 1, true); // PCM
	view.setUint16(22, 1, true); // mono
	view.setUint32(24, sampleRate, true);
	view.setUint32(28, sampleRate * 2, true);
	view.setUint16(32, 2, true);
	view.setUint16(34, 16, true);
	ascii(36, 'data');
	view.setUint32(40, length, true);
	wav.set(pcm.subarray(0, length), 44);
	return wav;
}

/** The cheapest model by listed price, or `undefined` when none lists one. */
export function cheapestModel(models: readonly AgentModelInfo[]): string | undefined {
	const priced = models
		.map(model => ({ id: model.id, cost: Number(model.inputCost) + Number(model.outputCost) }))
		.filter(model => Number.isFinite(model.cost));
	priced.sort((a, b) => a.cost - b.cost);
	return priced[0]?.id;
}

/** Code names in some text worth offering for spelling: camelCase, PascalCase with two humps, snake_case. */
export function identifiersIn(text: string, max = 150): string[] {
	const counts = new Map<string, number>();
	for (const match of text.matchAll(/\b[A-Za-z_][A-Za-z0-9_]{3,39}\b/g)) {
		const word = match[0];
		if (/[a-z][A-Z]|[A-Z][a-z]+[A-Z]|[A-Za-z0-9]_[A-Za-z0-9]/.test(word)) {
			counts.set(word, (counts.get(word) ?? 0) + 1);
		}
	}
	return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([word]) => word);
}

/** Puts text in at the cursor, with a space either side where words would otherwise run together. */
export function insertAtCursor(value: string, start: number, end: number, text: string): { value: string; cursor: number } {
	const before = value.slice(0, start);
	const after = value.slice(end);
	const lead = before && !/\s$/.test(before) ? ' ' : '';
	const trail = after && !/^[\s.,;:!?)]/.test(after) ? ' ' : '';
	const inserted = `${lead}${text}${trail}`;
	return { value: before + inserted + after, cursor: before.length + lead.length + text.length };
}

// ------------------------------------------------------------------------------------------------ service

export class ActiveDictationService extends Disposable implements IActiveDictationService {
	declare readonly _serviceBrand: undefined;

	private _state: DictationState = 'idle';
	private readonly _onDidChangeState = this._register(new Emitter<DictationState>());
	readonly onDidChangeState = this._onDidChangeState.event;
	private readonly recordingKey: IContextKey<boolean>;
	private readonly targets: DictationTarget[] = [];
	private recordingTarget: DictationTarget | undefined;
	private readonly session = this._register(new DisposableStore());
	private chunks: Uint8Array[] = [];
	private bytes = 0;
	private startedAt = 0;
	/** Whether the microphone was already open (for someone else) when this recording started. */
	private micWasOpen = false;
	private generation = 0;

	constructor(
		@IMicCaptureService private readonly micService: IMicCaptureService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@IActiveService private readonly activeService: IActiveService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.recordingKey = ActiveDictationRecording.bindTo(contextKeyService);
		this._register(toDisposable(() => this.cancel()));
	}

	get state(): DictationState { return this._state; }

	get target(): DictationTarget | undefined {
		return this.targets.find(target => target.isVisible());
	}

	registerTarget(target: DictationTarget): IDisposable {
		this.targets.unshift(target);
		return toDisposable(() => {
			const index = this.targets.indexOf(target);
			if (index >= 0) {
				this.targets.splice(index, 1);
			}
			if (this.recordingTarget === target) {
				this.cancel();
			}
		});
	}

	preferTarget(target: DictationTarget): void {
		const index = this.targets.indexOf(target);
		if (index > 0) {
			this.targets.splice(index, 1);
			this.targets.unshift(target);
		}
	}

	private setState(state: DictationState): void {
		if (this._state !== state) {
			this._state = state;
			this.recordingKey.set(state === 'recording');
			this._onDidChangeState.fire(state);
		}
	}

	press(target: DictationTarget): () => void {
		if (this._state === 'recording') {
			this.stop();
			return () => { };
		}
		if (this._state !== 'idle') {
			return () => { };
		}
		const pressed = Date.now();
		const generation = this.generation + 1;
		void this.start(target);
		return () => {
			if (Date.now() - pressed >= DICTATION_HOLD_MS && this.generation === generation && this._state === 'recording') {
				this.stop();
			}
		};
	}

	async start(target: DictationTarget): Promise<void> {
		if (this._state !== 'idle' || !target.canDictate()) {
			return;
		}
		const generation = ++this.generation;
		this.recordingTarget = target;
		this.chunks = [];
		this.bytes = 0;
		this.startedAt = Date.now();
		this.micWasOpen = this.micService.isCapturing;
		this.setState('recording');
		const maxBytes = MAX_DICTATION_SECONDS * DICTATION_SAMPLE_RATE * 2;
		this.session.add(this.micService.onPttAudioChunk(chunk => {
			if (generation !== this.generation || this.bytes >= maxBytes) {
				return;
			}
			const bytes = decodeBase64(chunk).buffer;
			this.chunks.push(bytes);
			this.bytes += bytes.byteLength;
			if (this.bytes >= maxBytes && this._state === 'recording') {
				this.notificationService.info(localize('dictationCapped', "Dictation stops at 2 minutes."));
				this.stop();
			}
		}));
		this.session.add(this.micService.onPttEnd(() => {
			if (generation === this.generation && this._state === 'transcribing') {
				void this.finish(generation);
			}
		}));
		// In case the microphone stops sending (a stalled device), the cap still holds.
		const cap = setTimeout(() => this._state === 'recording' && generation === this.generation && this.stop(), (MAX_DICTATION_SECONDS + 1) * 1000);
		this.session.add(toDisposable(() => clearTimeout(cap)));
		try {
			this.micService.prepare(target.window);
			await this.micService.pttDown(`active-dictation-${generation}`);
		} catch (error) {
			if (generation !== this.generation) {
				return;
			}
			this.reset();
			// A denied permission is already reported by the microphone service.
			if (!isMicrophonePermissionDeniedError(error)) {
				const name = error instanceof Error ? error.name : '';
				this.notificationService.error(name === 'NotFoundError' || name === 'OverconstrainedError'
					? localize('dictationNoMic', "No microphone found.")
					: localize('dictationMicFailed', "Couldn't open the microphone: {0}", error instanceof Error ? error.message : String(error)));
			}
			this.logService.warn(`[Active] dictation: microphone failed: ${error}`);
		}
	}

	stop(): void {
		if (this._state !== 'recording') {
			return;
		}
		const generation = this.generation;
		this.setState('transcribing');
		this.micService.pttUp();
		// `onPttEnd` follows the release tail; if it never comes (the microphone never opened), go on without it.
		const fallback = setTimeout(() => generation === this.generation && this._state === 'transcribing' && void this.finish(generation), 1500);
		this.session.add(toDisposable(() => clearTimeout(fallback)));
	}

	cancel(): void {
		if (this._state === 'idle') {
			return;
		}
		this.generation++;
		if (this._state === 'recording') {
			this.micService.abortPtt();
		}
		this.reset();
	}

	/** Back to idle, closing the microphone unless something else had it open. */
	private reset(): void {
		this.session.clear();
		if (!this.micWasOpen && this.micService.isCapturing) {
			this.micService.stopCapture();
		}
		this.chunks = [];
		this.bytes = 0;
		this.recordingTarget = undefined;
		this.setState('idle');
	}

	private async finish(generation: number): Promise<void> {
		this.session.clear();
		const target = this.recordingTarget;
		const pcm = joinPcm(this.chunks);
		this.chunks = [];
		if (!this.micWasOpen && this.micService.isCapturing) {
			this.micService.stopCapture();
		}
		const heardMs = pcm.byteLength / 2 / DICTATION_SAMPLE_RATE * 1000;
		if (!target || heardMs < MIN_DICTATION_MS) {
			if (target && Date.now() - this.startedAt >= MIN_DICTATION_MS) {
				this.notificationService.info(localize('dictationNothing', "Didn't hear anything."));
			}
			this.reset();
			return;
		}
		const request: TranscribeRequest = {
			wav: encodeBase64(VSBuffer.wrap(encodeWav(pcm))),
			cleanup: this.cleanupRequest(target),
		};
		let result: TranscribeResult | undefined;
		try {
			// Straight to this window's extension, never routed to a session host: a guest dictates with their own Muse.
			result = await this.commandService.executeCommand<TranscribeResult>(ExtensionCommand.Transcribe, request);
		} catch (error) {
			result = { error: error instanceof Error ? error.message : String(error), errorKind: 'failed' };
		}
		if (generation !== this.generation) {
			return;
		}
		this.reset();
		if (result?.text) {
			target.insert(result.text);
			return;
		}
		switch (result?.errorKind) {
			case 'empty':
				this.notificationService.info(localize('dictationEmpty', "Didn't catch any words."));
				break;
			case 'signedOut':
				this.notificationService.error(localize('dictationSignedOut', "Sign in to Muse to dictate."));
				break;
			case 'unavailable':
				this.notificationService.error(localize('dictationNoMuse', "Dictation needs Muse Code installed."));
				break;
			default:
				this.notificationService.error(localize('dictationFailed', "Dictation failed: {0}", result?.error ?? localize('dictationNoReply', "no reply")));
		}
	}

	private cleanupRequest(target: DictationTarget): DictationCleanupRequest | undefined {
		if (!this.configurationService.getValue<boolean>(ActiveSetting.DictationCleanup)) {
			return undefined;
		}
		const model = this.configurationService.getValue<string>(ActiveSetting.DictationCleanupModel)?.trim() || cheapestModel(this.activeService.models);
		const dictionary = this.configurationService.getValue<unknown>(ActiveSetting.DictationDictionary);
		return {
			...(model ? { model } : {}),
			vocabulary: this.vocabulary(),
			dictionary: Array.isArray(dictionary) ? dictionary.filter((word): word is string => typeof word === 'string') : [],
			before: target.textBeforeCursor().slice(-160),
		};
	}

	/** Names the developer may say: open files, the agent's changed files, code names on screen. */
	private vocabulary(): string[] {
		const names = new Set<string>();
		for (const editor of this.editorService.editors.slice(0, 40)) {
			if (editor.resource) {
				names.add(basename(editor.resource));
			}
		}
		for (const path of [...this.activeService.turnChanges.keys()].slice(0, 40)) {
			names.add(path.split(/[\\/]/).pop() ?? path);
		}
		const visible: string[] = [];
		for (const control of this.editorService.visibleTextEditorControls) {
			const model = isCodeEditor(control) ? control.getModel() : undefined;
			if (model && isCodeEditor(control)) {
				for (const range of control.getVisibleRanges()) {
					visible.push(model.getValueInRange(range));
				}
			}
		}
		for (const word of identifiersIn(visible.join('\n').slice(0, 200_000))) {
			names.add(word);
		}
		return [...names].slice(0, 300);
	}
}
