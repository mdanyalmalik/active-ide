/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { RunOnceScheduler } from '../../../../../base/common/async.js';
import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../../base/common/lifecycle.js';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { localize } from '../../../../../nls.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { ActiveEvent, ExtensionCommand, InitialState, SessionAuthor, TaskRequest } from '../../common/activeProtocol.js';
import { IActiveService, REMOTE_FILE_SCHEME, SessionParticipant, SessionRole } from '../activeService.js';
import { PeerLink, serverUrls, SignalingClient, SignalPayload, SignalServerMessage } from './peerLink.js';
import { RemoteFileSystemProvider } from './remoteFileSystem.js';
import { RemoteSearchProvider, RemoteSearchReply, RemoteSearchRequest, runRemoteSearch } from './remoteSearch.js';
import { ISearchService, SearchProviderType } from '../../../../services/search/common/search.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ILifecycleService, LifecyclePhase } from '../../../../services/lifecycle/common/lifecycle.js';
import { EditorsOrder } from '../../../../common/editor.js';
import { formatInvite, Invite, newInviteKey, parseInvite, RemoteStat, SessionMessage, SignalCipher } from './sessionProtocol.js';

export const MULTIPLAYER_SERVER_SETTING = 'active.multiplayer.serverUrl';
export const MULTIPLAYER_RELAY_SETTING = 'active.multiplayer.relayOnly';
/** Active's session server on Cloudflare (`active/multiplayer-server`); `http://127.0.0.1:8787` is the local one for development. */
export const DEFAULT_MULTIPLAYER_SERVER = 'https://active-multiplayer.danyalmalik.workers.dev';
/** How many people can join one session (besides the host). */
export const MAX_GUESTS = 5;
/** How many person colours there are (`--active-person-N` in CSS). */
export const PERSON_COLORS = 6;

export type SessionState = 'idle' | 'starting' | 'hosting' | 'joining' | 'waiting' | 'guest';

export const IMultiplayerService = createDecorator<IMultiplayerService>('activeMultiplayerService');

export interface IMultiplayerService {
	readonly _serviceBrand: undefined;
	readonly state: SessionState;
	readonly onDidChange: Event<void>;
	/** While hosting: the code guests join with. */
	readonly inviteCode: string | undefined;
	/** Everyone in the session (the host first). */
	readonly participants: readonly SessionParticipant[];
	/** How each live connection goes (ICE candidate type: 'relay' = through TURN). */
	routes(): Promise<string[]>;
	host(name: string): Promise<string | undefined>;
	join(code: string, name: string): Promise<void>;
	leave(): Promise<void>;
	/** Host only: what a guest may do. */
	setRole(participantId: string, role: Exclude<SessionRole, 'host'>): void;
	/** Host only: removes a guest. */
	kick(participantId: string): void;
}

/** Requests a viewer may make of the host's agent services (the rest are refused). */
const VIEWER_COMMANDS = new Set<string>([ExtensionCommand.Init, ExtensionCommand.AgentStates, ExtensionCommand.GitChanges, ExtensionCommand.DiagramRevision, ExtensionCommand.AgentFocus]);
/** A collaborator may also give agents tasks and answer their approvals. */
const COLLABORATOR_COMMANDS = new Set<string>([...VIEWER_COMMANDS, ExtensionCommand.SubmitTask, ExtensionCommand.DecideApproval]);
/** Explanations aren't shared with guests (for now): these events stay with the host. */
const HOST_ONLY_EVENTS = new Set<ActiveEvent['type']>(['walkthroughReady', 'walkthroughStatus', 'elaboration', 'narration', 'checkUpdate', 'memory', 'profile', 'history', 'trace']);
const CALL_TIMEOUT_MS = 30_000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

interface Guest {
	readonly peerId: string;
	name: string;
	colorIndex: number;
	role: Exclude<SessionRole, 'host'>;
	agentId?: string;
	link?: PeerLink;
	readonly store: DisposableStore;
	welcomed?: boolean;
	removed?: boolean;
}

/**
 * Multiplayer: one person hosts, up to five join. The host's window runs everything (agents, Muse, credit); a guest's
 * window becomes a live, read-only-files view of the host's session and sends requests back, which the host checks
 * against the guest's role. Connections are direct (WebRTC); the signalling server (Cloudflare, or a local one in dev)
 * only introduces peers, and its messages are encrypted with a key that lives only in the invite code.
 */
export class MultiplayerService extends Disposable implements IMultiplayerService {
	declare readonly _serviceBrand: undefined;

	private _state: SessionState = 'idle';
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly session = this._register(new MutableDisposable<DisposableStore>());
	private signaling: SignalingClient | undefined;
	private cipher: SignalCipher | undefined;
	private invite: Invite | undefined;
	private selfName = '';
	private selfId = 'host';
	// host side
	private readonly guests = new Map<string, Guest>();
	private readonly joinPrompts = new Map<string, INotificationHandle>();
	/** Names of people waiting to be let in (already made unique). */
	private readonly pendingNames = new Map<string, string>();
	private readonly changedPaths = new Set<string>();
	private readonly deletedPaths = new Set<string>();
	private readonly addedPaths = new Set<string>();
	private readonly fsFlush = this._register(new RunOnceScheduler(() => this.flushChanges(), 300));
	// guest side
	private hostLink: PeerLink | undefined;
	private hostName = '';
	private role: SessionRole = 'viewer';
	private remoteParticipants: readonly SessionParticipant[] = [];
	private nextId = 0;
	private ending = false;
	private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
	private readonly files = this._register(new RemoteFileSystemProvider());
	private readonly search = new RemoteSearchProvider();

	constructor(
		@IActiveService private readonly activeService: IActiveService,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IFileService private readonly fileService: IFileService,
		@INotificationService private readonly notificationService: INotificationService,
		@ISearchService private readonly searchService: ISearchService,
		@IEditorService private readonly editorService: IEditorService,
		@ILifecycleService lifecycleService: ILifecycleService,
	) {
		super();
		// Tabs on a host's files come back after a restart, but there's no session to read them from.
		void lifecycleService.when(LifecyclePhase.Restored).then(() => {
			if (this._state === 'idle') {
				void this.closeRemoteEditors();
			}
		});
		this._register(fileService.registerProvider(REMOTE_FILE_SCHEME, this.files));
		// Quick open and Find in Files over the host's files, for a guest.
		this._register(searchService.registerSearchResultProvider(REMOTE_FILE_SCHEME, SearchProviderType.file, this.search));
		this._register(searchService.registerSearchResultProvider(REMOTE_FILE_SCHEME, SearchProviderType.text, this.search));
	}

	get state(): SessionState { return this._state; }
	get inviteCode(): string | undefined { return this._state === 'hosting' && this.invite ? formatInvite(this.invite) : undefined; }

	get participants(): readonly SessionParticipant[] {
		if (this._state === 'guest') {
			return this.remoteParticipants;
		}
		if (this._state !== 'hosting') {
			return [];
		}
		return [
			{ id: 'host', name: this.selfName, colorIndex: 0, role: 'host', agentId: this.activeService.highlightedAgentId },
			...[...this.guests.values()].filter(guest => guest.welcomed).map(guest => ({ id: guest.peerId, name: guest.name, colorIndex: guest.colorIndex, role: guest.role, agentId: guest.agentId })),
		];
	}

	private setState(state: SessionState): void {
		this._state = state;
		this._onDidChange.fire();
	}

	private urls(): { http: string; ws: string } {
		return serverUrls(this.configurationService.getValue<string>(MULTIPLAYER_SERVER_SETTING) || DEFAULT_MULTIPLAYER_SERVER);
	}

	private get relayOnly(): boolean {
		return this.configurationService.getValue<boolean>(MULTIPLAYER_RELAY_SETTING) === true;
	}

	/** How this window's connection(s) go, for testing: the candidate type of each live link. */
	async routes(): Promise<string[]> {
		const links = this._state === 'guest' ? [this.hostLink] : [...this.guests.values()].map(guest => guest.link);
		return Promise.all(links.filter((link): link is PeerLink => !!link).map(async link => (await link.route()) ?? 'unknown'));
	}

	private async iceServers(): Promise<RTCIceServer[]> {
		try {
			const response = await fetch(`${this.urls().http}/turn`);
			const body = await response.json() as { iceServers?: RTCIceServer[] };
			return body.iceServers ?? [];
		} catch {
			return [];
		}
	}

	// ------------------------------------------------------------------ hosting

	async host(name: string): Promise<string | undefined> {
		if (this._state !== 'idle') {
			return this.inviteCode;
		}
		if (this.activeService.remote) {
			throw new Error(localize('hostWhileGuest', "Leave the session you're in before hosting one."));
		}
		this.setState('starting');
		const store = new DisposableStore();
		this.session.value = store;
		try {
			this.selfName = name;
			this.selfId = 'host';
			const response = await fetch(`${this.urls().http}/rooms`, { method: 'POST' });
			if (!response.ok) {
				throw new Error(`the session server answered ${response.status}`);
			}
			const room = await response.json() as { roomId: string; hostToken: string };
			this.invite = { roomId: room.roomId, key: newInviteKey() };
			this.cipher = await SignalCipher.create(this.invite.key);
			const signaling = store.add(new SignalingClient(`${this.urls().ws}/rooms/${room.roomId}/ws?role=host&token=${encodeURIComponent(room.hostToken)}`));
			this.signaling = signaling;
			store.add(signaling.onMessage(message => void this.onHostSignal(message)));
			store.add(signaling.onClose(() => {
				if (this._state === 'hosting') {
					this.notificationService.warn(localize('serverLost', "Lost the connection to the session server: new people can't join until you host again. People already in stay connected."));
				}
			}));
			await signaling.open();
			// Forward the host's own agents to everyone in the session.
			store.add(this.activeService.onDidReceiveLocalEvent(event => this.forward(event)));
			store.add(this.activeService.onDidChangeHighlight(() => this.broadcastParticipants()));
			store.add(this.fileService.onDidFilesChange(event => this.collectChanges(event.rawUpdated, event.rawDeleted, event.rawAdded)));
			this.setState('hosting');
			this.broadcastParticipants();
			return this.inviteCode;
		} catch (error) {
			this.session.clear();
			this.setState('idle');
			throw new Error(localize('hostFailed', "Couldn't start the session: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	private async onHostSignal(message: SignalServerMessage): Promise<void> {
		switch (message.type) {
			case 'join-request': {
				if ([...this.guests.values()].length + this.pendingNames.size >= MAX_GUESTS) {
					this.signaling?.send({ type: 'deny', peerId: message.peerId, reason: 'The session is full.' });
					return;
				}
				// Two people with the same name get told apart (identical notices would also merge into one).
				const requested = message.name.slice(0, 40) || localize('someone', "Someone");
				const taken = new Set([this.selfName, ...[...this.guests.values()].map(other => other.name), ...this.pendingNames.values()]);
				let name = requested;
				for (let index = 2; taken.has(name); index++) {
					name = `${requested} ${index}`;
				}
				this.pendingNames.set(message.peerId, name);
				// The host lets each person in, and decides what they can do.
				const handle = this.notificationService.prompt(Severity.Info, localize('joinRequest', "{0} wants to join your session.", name), [
					{ label: localize('admitCollaborator', "Let In as Collaborator"), run: () => this.admit(message.peerId, name, 'collaborator') },
					{ label: localize('admitViewer', "Let In as Viewer"), run: () => this.admit(message.peerId, name, 'viewer') },
					{ label: localize('deny', "Deny"), run: () => { this.pendingNames.delete(message.peerId); this.signaling?.send({ type: 'deny', peerId: message.peerId }); } },
				], { sticky: true });
				this.joinPrompts.set(message.peerId, handle);
				break;
			}
			case 'signal': {
				const guest = this.guests.get(message.from);
				if (guest?.link && this.cipher) {
					try {
						await guest.link.handleSignal(await this.cipher.open<SignalPayload>(message.data));
					} catch {
						// not sealed with this session's key: ignore it
					}
				}
				break;
			}
			case 'peer-left':
				this.pendingNames.delete(message.peerId);
				this.joinPrompts.get(message.peerId)?.close();
				this.joinPrompts.delete(message.peerId);
				this.removeGuest(message.peerId);
				break;
		}
	}

	private async admit(peerId: string, name: string, role: Exclude<SessionRole, 'host'>): Promise<void> {
		this.joinPrompts.delete(peerId);
		if (this._state !== 'hosting' || !this.cipher) {
			return;
		}
		const used = new Set([0, ...[...this.guests.values()].map(guest => guest.colorIndex)]);
		const colorIndex = Array.from({ length: PERSON_COLORS }, (_, index) => index).find(index => !used.has(index)) ?? this.guests.size % PERSON_COLORS;
		this.pendingNames.delete(peerId);
		const guest: Guest = { peerId, name, colorIndex, role, store: new DisposableStore() };
		this.guests.set(peerId, guest);
		this.signaling?.send({ type: 'admit', peerId });
		const cipher = this.cipher;
		const link = await PeerLink.asHost(await this.iceServers(), payload => void cipher.seal(payload).then(data => this.signaling?.send({ type: 'signal', to: peerId, data })), this.relayOnly);
		guest.link = guest.store.add(link);
		guest.store.add(link.onOpen(() => void this.welcome(guest)));
		guest.store.add(link.onMessage(message => void this.onGuestMessage(guest, message)));
		guest.store.add(link.onClose(() => this.removeGuest(peerId)));
	}

	private async welcome(guest: Guest): Promise<void> {
		const snapshot = await this.commandService.executeCommand<InitialState>(ExtensionCommand.Init);
		if (!snapshot || !guest.link) {
			return;
		}
		guest.welcomed = true;
		const you: SessionParticipant = { id: guest.peerId, name: guest.name, colorIndex: guest.colorIndex, role: guest.role };
		guest.link.send({ t: 'welcome', you, hostName: this.selfName, snapshot: guestSnapshot(snapshot) });
		this.notificationService.info(localize('joined', "{0} joined your session as a {1}.", guest.name, guest.role));
		this.broadcastParticipants();
	}

	private removeGuest(peerId: string): void {
		const guest = this.guests.get(peerId);
		if (!guest) {
			return;
		}
		this.guests.delete(peerId);
		guest.store.dispose();
		if (guest.welcomed && this._state === 'hosting' && !this.ending) {
			this.notificationService.info(guest.removed ? localize('removedNotice', "{0} was removed from your session.", guest.name) : localize('left', "{0} left your session.", guest.name));
		}
		this.broadcastParticipants();
	}

	private broadcastParticipants(): void {
		const list = this.participants;
		this.activeService.setPresence(this._state === 'hosting' ? list : [], this._state === 'hosting' ? 'host' : undefined);
		for (const guest of this.guests.values()) {
			if (guest.welcomed) {
				guest.link?.send({ t: 'participants', list });
			}
		}
		this._onDidChange.fire();
	}

	/** The host's own events go to every guest, minus explanations (not shared for now). */
	private forward(event: ActiveEvent): void {
		const shared = guestEvent(event);
		if (!shared) {
			return;
		}
		for (const guest of this.guests.values()) {
			if (guest.welcomed) {
				guest.link?.send({ t: 'event', event: shared });
			}
		}
	}

	private async onGuestMessage(guest: Guest, message: SessionMessage): Promise<void> {
		switch (message.t) {
			case 'presence':
				guest.agentId = message.agentId;
				this.broadcastParticipants();
				break;
			case 'call': {
				const reply = (ok: boolean, value?: unknown, error?: string) => guest.link?.send({ t: 'result', id: message.id, ok, value, error });
				const allowed = guest.role === 'collaborator' ? COLLABORATOR_COMMANDS : VIEWER_COMMANDS;
				if (!allowed.has(message.command)) {
					reply(false, undefined, guest.role === 'viewer' && COLLABORATOR_COMMANDS.has(message.command)
						? localize('viewerOnly', "You're a viewer in this session. Ask the host to make you a collaborator.")
						: localize('hostOnly', "Only the host can do that."));
					return;
				}
				// A guest's highlight is theirs: it never moves the host's.
				if (message.command === ExtensionCommand.AgentFocus) {
					reply(true);
					return;
				}
				let args = message.args;
				if (message.command === ExtensionCommand.SubmitTask) {
					// Their message shows with their name, in their colour.
					const author: SessionAuthor = { id: guest.peerId, name: guest.name, colorIndex: guest.colorIndex };
					const request = args[0];
					const task: TaskRequest = typeof request === 'string' ? { text: request, author } : { ...(request as TaskRequest), author };
					args = [task, ...args.slice(1)];
				}
				try {
					reply(true, await this.commandService.executeCommand(message.command, ...args));
				} catch (error) {
					reply(false, undefined, error instanceof Error ? error.message : String(error));
				}
				break;
			}
			case 'search': {
				const reply = (ok: boolean, value?: unknown, error?: string) => guest.link?.send({ t: 'fsResult', id: message.id, ok, value, error });
				try {
					reply(true, await runRemoteSearch(this.searchService, message.request, this.activeService.agents.map(agent => URI.file(agent.root))));
				} catch (error) {
					reply(false, undefined, error instanceof Error ? error.message : String(error));
				}
				break;
			}
			case 'fs': {
				const reply = (ok: boolean, value?: unknown, error?: string) => guest.link?.send({ t: 'fsResult', id: message.id, ok, value, error });
				try {
					reply(true, await this.serveFile(message.op, message.path));
				} catch (error) {
					reply(false, undefined, error instanceof Error ? error.message : String(error));
				}
				break;
			}
		}
	}

	/** Only files under the host's agents' folders are served, read-only. */
	private async serveFile(op: 'stat' | 'readdir' | 'readFile', path: string): Promise<unknown> {
		const resource = URI.file(path);
		const roots = this.activeService.agents.map(agent => URI.file(agent.root));
		if (!roots.some(root => extUriBiasedIgnorePathCase.isEqualOrParent(resource, root))) {
			throw new Error('not found');
		}
		if (op === 'readFile') {
			const content = await this.fileService.readFile(resource, { limits: { size: MAX_FILE_BYTES } });
			return content.value.toString();
		}
		const stat = await this.fileService.resolve(resource, { resolveMetadata: true });
		if (op === 'stat') {
			return { type: stat.isDirectory ? 'directory' : 'file', size: stat.size ?? 0, mtime: stat.mtime ?? 0, ctime: stat.ctime ?? 0 } satisfies RemoteStat;
		}
		return (stat.children ?? []).filter(child => child.name !== '.git').map(child => [child.name, child.isDirectory ? 'directory' : 'file']);
	}

	private collectChanges(changed: readonly URI[], deleted: readonly URI[], added: readonly URI[] = []): void {
		if (!this.guests.size) {
			return;
		}
		for (const resource of changed) {
			if (resource.scheme === 'file') {
				this.changedPaths.add(resource.path);
				this.deletedPaths.delete(resource.path);
			}
		}
		for (const resource of added) {
			if (resource.scheme === 'file') {
				this.addedPaths.add(resource.path);
				this.deletedPaths.delete(resource.path);
			}
		}
		for (const resource of deleted) {
			if (resource.scheme === 'file') {
				this.deletedPaths.add(resource.path);
				this.changedPaths.delete(resource.path);
				this.addedPaths.delete(resource.path);
			}
		}
		if (this.changedPaths.size || this.deletedPaths.size || this.addedPaths.size) {
			this.fsFlush.schedule();
		}
	}

	private flushChanges(): void {
		const roots = this.activeService.agents.map(agent => URI.file(agent.root));
		const served = (path: string) => roots.some(root => extUriBiasedIgnorePathCase.isEqualOrParent(URI.file(path), root));
		const paths = [...this.changedPaths].filter(served);
		const deleted = [...this.deletedPaths].filter(served);
		const added = [...this.addedPaths].filter(served);
		this.changedPaths.clear();
		this.deletedPaths.clear();
		this.addedPaths.clear();
		if (!paths.length && !deleted.length && !added.length) {
			return;
		}
		for (const guest of this.guests.values()) {
			if (guest.welcomed) {
				guest.link?.send({ t: 'fsChanged', paths, deleted, added });
			}
		}
	}

	setRole(participantId: string, role: Exclude<SessionRole, 'host'>): void {
		const guest = this.guests.get(participantId);
		if (!guest || this._state !== 'hosting') {
			return;
		}
		guest.role = role;
		guest.link?.send({ t: 'role', role });
		this.broadcastParticipants();
	}

	kick(participantId: string): void {
		const guest = this.guests.get(participantId);
		if (!guest) {
			return;
		}
		guest.removed = true;
		guest.link?.send({ t: 'bye', reason: localize('removed', "The host removed you from the session.") });
		this.signaling?.send({ type: 'kick', peerId: participantId });
		setTimeout(() => this.removeGuest(participantId), 300);
	}

	// ------------------------------------------------------------------ joining

	async join(code: string, name: string): Promise<void> {
		if (this._state !== 'idle') {
			throw new Error(localize('alreadyInSession', "You're already in a session."));
		}
		const invite = parseInvite(code);
		if (!invite) {
			throw new Error(localize('badInvite', "That isn't a session invite code."));
		}
		this.setState('joining');
		const store = new DisposableStore();
		this.session.value = store;
		this.selfName = name;
		try {
			this.invite = invite;
			this.cipher = await SignalCipher.create(invite.key);
			const cipher = this.cipher;
			const signaling = store.add(new SignalingClient(`${this.urls().ws}/rooms/${invite.roomId}/ws?role=guest&name=${encodeURIComponent(name)}`));
			this.signaling = signaling;
			const ice = await this.iceServers();
			let waiting: INotificationHandle | undefined;
			store.add({ dispose: () => waiting?.close() });
			store.add(signaling.onMessage(message => void (async () => {
				switch (message.type) {
					case 'pending':
						this.setState('waiting');
						waiting = this.notificationService.notify({ severity: Severity.Info, message: localize('waitingForHost', "Waiting for the host to let you in…"), sticky: true });
						break;
					case 'admitted': {
						waiting?.close();
						this.selfId = message.peerId;
						const link = store.add(PeerLink.asGuest(ice, payload => void cipher.seal(payload).then(data => signaling.send({ type: 'signal', data })), this.relayOnly));
						this.hostLink = link;
						store.add(link.onOpen(() => link.send({ t: 'hello', name })));
						store.add(link.onMessage(sessionMessage => this.onHostMessage(sessionMessage)));
						store.add(link.onClose(() => this.endAsGuest(localize('hostGone', "The session ended."))));
						break;
					}
					case 'signal':
						try {
							await this.hostLink?.handleSignal(await cipher.open<SignalPayload>(message.data));
						} catch {
							// not sealed with this invite's key
						}
						break;
					case 'denied':
						this.endAsGuest(message.reason || localize('denied', "The host didn't let you in."));
						break;
					case 'kicked':
						this.endAsGuest(localize('kicked', "The host removed you from the session."));
						break;
					case 'host-left':
						this.endAsGuest(localize('hostLeft', "The host ended the session."));
						break;
					case 'error':
						if (this._state !== 'guest') {
							this.endAsGuest(message.message);
						}
						break;
				}
			})()));
			await signaling.open();
		} catch (error) {
			this.session.clear();
			this.setState('idle');
			throw new Error(localize('joinFailed', "Couldn't join: {0}", error instanceof Error ? error.message : String(error)));
		}
	}

	private onHostMessage(message: SessionMessage): void {
		switch (message.t) {
			case 'welcome': {
				this.hostName = message.hostName;
				this.role = message.you.role;
				this.selfId = message.you.id;
				const link = this.hostLink!;
				this.files.setSource({ request: <T>(op: 'stat' | 'readdir' | 'readFile', path: string) => this.request<T>(link, { t: 'fs', op, path }) });
				this.search.source = { search: (request: RemoteSearchRequest) => this.request<RemoteSearchReply>(link, { t: 'search', request }) };
				this.activeService.enterRemote({ call: <T>(command: string, args: unknown[]) => this.request<T>(link, { t: 'call', command, args }) }, message.snapshot, { hostName: message.hostName, role: message.you.role, selfId: message.you.id });
				// Where this person is looking, for everyone's presence.
				const store = this.session.value;
				store?.add(this.activeService.onDidChangeHighlight(change => link.send({ t: 'presence', agentId: change.agentId })));
				link.send({ t: 'presence', agentId: this.activeService.highlightedAgentId });
				this.setState('guest');
				this.notificationService.info(localize('welcome', "You joined {0}'s session as a {1}.", message.hostName, message.you.role));
				break;
			}
			case 'event':
				this.activeService.handleEvent(message.event, true);
				break;
			case 'result':
			case 'fsResult': {
				const waiting = this.pending.get(message.id);
				if (waiting) {
					this.pending.delete(message.id);
					clearTimeout(waiting.timer);
					if (message.ok) {
						waiting.resolve(message.value);
					} else {
						waiting.reject(new Error(message.error ?? 'failed'));
					}
				}
				break;
			}
			case 'participants':
				this.remoteParticipants = message.list;
				this.activeService.setPresence(message.list, this.selfId);
				this._onDidChange.fire();
				break;
			case 'role':
				this.role = message.role;
				this.activeService.setRemoteRole(message.role);
				this.notificationService.info(localize('roleChanged', "The host made you a {0}.", message.role));
				this._onDidChange.fire();
				break;
			case 'fsChanged':
				this.files.changed(message.paths, message.deleted, message.added);
				break;
			case 'bye':
				this.endAsGuest(message.reason);
				break;
		}
	}

	private request<T>(link: PeerLink, message: { t: 'call'; command: string; args: unknown[] } | { t: 'fs'; op: 'stat' | 'readdir' | 'readFile'; path: string } | { t: 'search'; request: RemoteSearchRequest }): Promise<T> {
		return new Promise<T>((resolve, reject) => {
			const id = ++this.nextId;
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(localize('hostTimeout', "The host didn't answer.")));
			}, CALL_TIMEOUT_MS);
			this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject, timer });
			link.send({ ...message, id } as SessionMessage);
		});
	}

	private endAsGuest(reason: string): void {
		// Closing the connection below reports itself too: only the first reason counts.
		if (this._state === 'idle' || this.ending) {
			return;
		}
		this.ending = true;
		const wasGuest = this._state === 'guest';
		for (const waiting of this.pending.values()) {
			clearTimeout(waiting.timer);
			waiting.reject(new Error(reason));
		}
		this.pending.clear();
		this.files.setSource(undefined);
		this.search.source = undefined;
		this.hostLink = undefined;
		this.remoteParticipants = [];
		this.session.clear();
		this.activeService.exitRemote();
		void this.closeRemoteEditors();
		this.ending = false;
		this.setState('idle');
		this.notificationService.info(wasGuest ? reason : localize('couldNotJoin', "Couldn't join: {0}", reason));
	}

	/** The host's files can't be read once the session is over: close their tabs. */
	private async closeRemoteEditors(): Promise<void> {
		const remote = this.editorService.getEditors(EditorsOrder.SEQUENTIAL).filter(({ editor }) => editor.resource?.scheme === REMOTE_FILE_SCHEME);
		if (remote.length) {
			await this.editorService.closeEditors(remote, { preserveFocus: true });
		}
	}

	// ------------------------------------------------------------------ leaving

	async leave(): Promise<void> {
		if (this._state === 'hosting' || this._state === 'starting') {
			for (const guest of this.guests.values()) {
				guest.link?.send({ t: 'bye', reason: localize('hostEnded', "The host ended the session.") });
			}
			// Let the goodbyes go out before the connections close.
			this.ending = true;
			await new Promise(resolve => setTimeout(resolve, 200));
			for (const peerId of [...this.guests.keys()]) {
				this.removeGuest(peerId);
			}
			for (const handle of this.joinPrompts.values()) {
				handle.close();
			}
			this.joinPrompts.clear();
			this.pendingNames.clear();
			this.session.clear();
			this.invite = undefined;
			this.activeService.setPresence([], undefined);
			this.ending = false;
			this.setState('idle');
			return;
		}
		if (this._state !== 'idle') {
			this.endAsGuest(localize('youLeft', "You left the session."));
		}
	}

	get guestRole(): SessionRole {
		return this.role;
	}

	get sessionHostName(): string {
		return this.hostName;
	}
}

/** What a guest is sent of the host's state: everything but explanations. */
export function guestSnapshot(state: InitialState): InitialState {
	return {
		...state,
		history: [],
		pendingWalkthrough: undefined,
		narration: { available: false, detail: '' },
		chat: state.chat.filter(entry => entry.role !== 'explainer'),
		agentStates: state.agentStates?.map(agent => ({ ...agent, chat: agent.chat.filter(entry => entry.role !== 'explainer'), pendingWalkthrough: undefined })),
	};
}

/** An event as guests get it, or undefined when it's about explanations (not shared for now). */
export function guestEvent(event: ActiveEvent): ActiveEvent | undefined {
	if (HOST_ONLY_EVENTS.has(event.type)) {
		return undefined;
	}
	if (event.type === 'chat' && event.entry.role === 'explainer') {
		return undefined;
	}
	if (event.type === 'chatReset') {
		return { ...event, chat: event.chat.filter(entry => entry.role !== 'explainer') };
	}
	return event;
}
