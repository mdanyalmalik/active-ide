/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../../base/common/event.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { encodeFrames, FrameDecoder, SessionMessage } from './sessionProtocol.js';

/** What WebRTC needs from the other side, carried (encrypted) through the signalling server. */
export type SignalPayload = { readonly sdp: RTCSessionDescriptionInit } | { readonly candidate: RTCIceCandidateInit };

/**
 * One direct connection between a host and a guest: a WebRTC peer connection with one ordered, reliable data
 * channel. The workbench (Chromium) has WebRTC built in, so the connection lives here, not in the extension.
 */
export class PeerLink extends Disposable {
	private readonly connection: RTCPeerConnection;
	private channel: RTCDataChannel | undefined;
	private readonly decoder = new FrameDecoder();
	private readonly pendingCandidates: RTCIceCandidateInit[] = [];
	private closed = false;

	private readonly _onMessage = this._register(new Emitter<SessionMessage>());
	readonly onMessage = this._onMessage.event;
	private readonly _onOpen = this._register(new Emitter<void>());
	readonly onOpen = this._onOpen.event;
	private readonly _onClose = this._register(new Emitter<void>());
	readonly onClose = this._onClose.event;

	private constructor(iceServers: RTCIceServer[], private readonly sendSignal: (payload: SignalPayload) => void, relayOnly = false) {
		super();
		// Relay-only sends everything through TURN: how people on two strict networks connect (and a way to test that on one machine).
		this.connection = new RTCPeerConnection({ iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
		this.connection.onicecandidate = event => {
			if (event.candidate) {
				this.sendSignal({ candidate: event.candidate.toJSON() });
			}
		};
		this.connection.onconnectionstatechange = () => {
			if (['failed', 'closed', 'disconnected'].includes(this.connection.connectionState)) {
				// "disconnected" can recover; give it a moment before giving up.
				if (this.connection.connectionState === 'disconnected') {
					setTimeout(() => {
						if (this.connection.connectionState === 'disconnected') {
							this.close();
						}
					}, 8000);
					return;
				}
				this.close();
			}
		};
		this.connection.ondatachannel = event => this.adopt(event.channel);
	}

	/** The host opens the channel and makes the offer. */
	static async asHost(iceServers: RTCIceServer[], sendSignal: (payload: SignalPayload) => void, relayOnly = false): Promise<PeerLink> {
		const link = new PeerLink(iceServers, sendSignal, relayOnly);
		link.adopt(link.connection.createDataChannel('active', { ordered: true }));
		const offer = await link.connection.createOffer();
		await link.connection.setLocalDescription(offer);
		sendSignal({ sdp: link.connection.localDescription!.toJSON() });
		return link;
	}

	/** A guest waits for the host's offer. */
	static asGuest(iceServers: RTCIceServer[], sendSignal: (payload: SignalPayload) => void, relayOnly = false): PeerLink {
		return new PeerLink(iceServers, sendSignal, relayOnly);
	}

	/** How the connection actually goes: 'relay' (through TURN), 'srflx'/'prflx' (direct, through NAT) or 'host' (same network). */
	async route(): Promise<string | undefined> {
		const stats = await this.connection.getStats();
		let pairId: string | undefined;
		stats.forEach(report => {
			if (report.type === 'transport' && report.selectedCandidatePairId) {
				pairId = report.selectedCandidatePairId;
			}
		});
		const pair = pairId ? stats.get(pairId) : undefined;
		return pair ? stats.get(pair.localCandidateId)?.candidateType : undefined;
	}

	async handleSignal(payload: SignalPayload): Promise<void> {
		if ('sdp' in payload) {
			await this.connection.setRemoteDescription(payload.sdp);
			for (const candidate of this.pendingCandidates.splice(0)) {
				await this.connection.addIceCandidate(candidate).catch(() => undefined);
			}
			if (payload.sdp.type === 'offer') {
				const answer = await this.connection.createAnswer();
				await this.connection.setLocalDescription(answer);
				this.sendSignal({ sdp: this.connection.localDescription!.toJSON() });
			}
		} else if (this.connection.remoteDescription) {
			await this.connection.addIceCandidate(payload.candidate).catch(() => undefined);
		} else {
			this.pendingCandidates.push(payload.candidate);
		}
	}

	get isOpen(): boolean {
		return this.channel?.readyState === 'open';
	}

	send(message: SessionMessage): void {
		if (!this.isOpen) {
			return;
		}
		for (const frame of encodeFrames(message)) {
			this.channel!.send(frame);
		}
	}

	private adopt(channel: RTCDataChannel): void {
		this.channel = channel;
		channel.onopen = () => this._onOpen.fire();
		channel.onclose = () => this.close();
		channel.onmessage = event => {
			try {
				const message = this.decoder.push(String(event.data));
				if (message) {
					this._onMessage.fire(message);
				}
			} catch {
				// a malformed frame: ignore it
			}
		};
	}

	close(): void {
		if (this.closed) {
			return;
		}
		this.closed = true;
		this.channel?.close();
		this.connection.close();
		this._onClose.fire();
	}

	override dispose(): void {
		this.close();
		super.dispose();
	}
}

// ------------------------------------------------------------------ signalling

export type SignalServerMessage =
	| { readonly type: 'join-request'; readonly peerId: string; readonly name: string }
	| { readonly type: 'peer-left'; readonly peerId: string }
	| { readonly type: 'signal'; readonly from: string; readonly data: string }
	| { readonly type: 'pending' }
	| { readonly type: 'admitted'; readonly peerId: string }
	| { readonly type: 'denied'; readonly reason?: string }
	| { readonly type: 'kicked' }
	| { readonly type: 'host-left' }
	| { readonly type: 'error'; readonly message: string };

/** The WebSocket to the signalling server: it only introduces peers (Cloudflare in production, a local server in dev). */
export class SignalingClient extends Disposable {
	private socket: WebSocket | undefined;
	private readonly _onMessage = this._register(new Emitter<SignalServerMessage>());
	readonly onMessage = this._onMessage.event;
	private readonly _onClose = this._register(new Emitter<void>());
	readonly onClose = this._onClose.event;

	constructor(private readonly url: string) {
		super();
	}

	open(): Promise<void> {
		return new Promise((resolve, reject) => {
			const socket = new WebSocket(this.url);
			this.socket = socket;
			socket.onopen = () => resolve();
			socket.onerror = () => reject(new Error(`Couldn't reach the session server (${new URL(this.url).host}).`));
			socket.onclose = () => this._onClose.fire();
			socket.onmessage = event => {
				try {
					this._onMessage.fire(JSON.parse(String(event.data)) as SignalServerMessage);
				} catch {
					// not ours
				}
			};
		});
	}

	send(message: Record<string, unknown>): void {
		if (this.socket?.readyState === WebSocket.OPEN) {
			this.socket.send(JSON.stringify(message));
		}
	}

	override dispose(): void {
		this.socket?.close();
		super.dispose();
	}
}

/** The signalling server's HTTP base and WebSocket base for a configured URL (http(s) or ws(s)). */
export function serverUrls(configured: string): { http: string; ws: string } {
	const trimmed = configured.trim().replace(/\/+$/, '');
	const http = trimmed.replace(/^ws(s?):/, 'http$1:');
	return { http, ws: http.replace(/^http(s?):/, 'ws$1:') };
}
