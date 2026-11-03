/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IClipboardService } from '../../../../../platform/clipboard/common/clipboardService.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../../platform/configuration/common/configurationRegistry.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { ServicesAccessor } from '../../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../../platform/quickinput/common/quickInput.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../../services/statusbar/browser/statusbar.js';
import { IActiveService } from '../activeService.js';
import { DEFAULT_MULTIPLAYER_SERVER, IMultiplayerService, MULTIPLAYER_RELAY_SETTING, MULTIPLAYER_SERVER_SETTING, MultiplayerService } from './multiplayerService.js';

registerSingleton(IMultiplayerService, MultiplayerService, InstantiationType.Eager);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'activeMultiplayer',
	title: localize('multiplayerTitle', "Active Multiplayer"),
	type: 'object',
	properties: {
		[MULTIPLAYER_RELAY_SETTING]: {
			type: 'boolean',
			default: false,
			description: localize('multiplayerRelay', "Connect only through the session server's relay (TURN), never directly. For testing how people on strict networks connect; slower otherwise."),
			scope: ConfigurationScope.APPLICATION,
		},
		[MULTIPLAYER_SERVER_SETTING]: {
			type: 'string',
			default: DEFAULT_MULTIPLAYER_SERVER,
			description: localize('multiplayerServer', "The session server that introduces people to each other (it never sees your code). Everyone in a session must use the same one. For development, run `npm run dev:local` in `active/multiplayer-server` and use `http://127.0.0.1:8787`."),
			scope: ConfigurationScope.APPLICATION,
		},
	},
});

const category = localize2('activeCategory', "Active");
const NAME_KEY = 'active.multiplayer.name';

const CommandIds = {
	Host: 'active.multiplayer.host',
	Join: 'active.multiplayer.join',
	Leave: 'active.multiplayer.leave',
	People: 'active.multiplayer.people',
	CopyInvite: 'active.multiplayer.copyInvite',
} as const;

/** Takes the services, not the accessor: the accessor can't be used after an await. */
async function askName(quickInput: IQuickInputService, storage: IStorageService): Promise<string | undefined> {
	const name = (await quickInput.input({
		title: localize('yourName', "Your name"),
		prompt: localize('yourNamePrompt', "What others in the session see"),
		value: storage.get(NAME_KEY, StorageScope.APPLICATION, ''),
		validateInput: async value => value.trim() ? undefined : localize('nameNeeded', "Type a name"),
	}))?.trim();
	if (name) {
		storage.store(NAME_KEY, name, StorageScope.APPLICATION, StorageTarget.USER);
	}
	return name;
}

registerAction2(class extends Action2 {
	constructor() {
		super({ id: CommandIds.Host, title: localize2('hostSession', "Host a Session"), category, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const multiplayer = accessor.get(IMultiplayerService);
		const clipboard = accessor.get(IClipboardService);
		const notifications = accessor.get(INotificationService);
		const name = multiplayer.state === 'idle' ? await askName(accessor.get(IQuickInputService), accessor.get(IStorageService)) : 'host';
		if (!name) {
			return;
		}
		try {
			const code = await multiplayer.host(name);
			if (code) {
				await clipboard.writeText(code);
				notifications.info(localize('hosting', "You're hosting. Invite code copied: send it to people you want to join (you'll let each one in)."));
			}
		} catch (error) {
			notifications.error(error instanceof Error ? error.message : String(error));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: CommandIds.Join, title: localize2('joinSession', "Join a Session"), category, f1: true });
	}
	async run(accessor: ServicesAccessor, code?: string, presetName?: string): Promise<void> {
		const multiplayer = accessor.get(IMultiplayerService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const storage = accessor.get(IStorageService);
		const invite = code ?? (await quickInput.input({ title: localize('joinTitle', "Join a session"), prompt: localize('joinPrompt', "Paste the invite code the host sent you") }))?.trim();
		if (!invite) {
			return;
		}
		const name = presetName ?? await askName(quickInput, storage);
		if (!name) {
			return;
		}
		try {
			await multiplayer.join(invite, name);
		} catch (error) {
			notifications.error(error instanceof Error ? error.message : String(error));
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: CommandIds.Leave, title: localize2('leaveSession', "Leave or End the Session"), category, f1: true });
	}
	run(accessor: ServicesAccessor): Promise<void> {
		return accessor.get(IMultiplayerService).leave();
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({ id: CommandIds.CopyInvite, title: localize2('copyInvite', "Copy Session Invite Code"), category, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const code = accessor.get(IMultiplayerService).inviteCode;
		const notifications = accessor.get(INotificationService);
		if (code) {
			await accessor.get(IClipboardService).writeText(code);
			notifications.info(localize('inviteCopied', "Invite code copied."));
		}
	}
});

interface PersonItem extends IQuickPickItem { readonly run?: () => void | Promise<void> }

/** Who's in the session; the host changes roles, removes people, copies the invite or ends it from here. */
registerAction2(class extends Action2 {
	constructor() {
		super({ id: CommandIds.People, title: localize2('sessionPeople', "Session People"), category, f1: true });
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const multiplayer = accessor.get(IMultiplayerService);
		const quickInput = accessor.get(IQuickInputService);
		const activeService = accessor.get(IActiveService);
		const clipboard = accessor.get(IClipboardService);
		const notifications = accessor.get(INotificationService);
		const commands = accessor.get(ICommandService);
		if (multiplayer.state === 'idle') {
			const picked = await quickInput.pick([
				{ label: localize('hostItem', "Host a Session"), id: CommandIds.Host },
				{ label: localize('joinItem', "Join a Session"), id: CommandIds.Join },
			], { title: localize('multiplayer', "Multiplayer") });
			if (picked?.id) {
				await commands.executeCommand(picked.id);
			}
			return;
		}
		const hosting = multiplayer.state === 'hosting';
		const agentName = (agentId?: string) => agentId ? activeService.agents.find(agent => agent.id === agentId)?.name : undefined;
		const items: PersonItem[] = multiplayer.participants.map(person => ({
			label: person.name + (person.id === activeService.presenceSelfId ? localize('you', " (you)") : ''),
			description: [person.role, agentName(person.agentId) && localize('watching', "on {0}", agentName(person.agentId))].filter(Boolean).join(' · '),
			id: person.id,
		}));
		if (hosting) {
			items.push({ label: localize('copyInviteItem', "$(copy) Copy Invite Code"), id: 'copy', run: async () => { await clipboard.writeText(multiplayer.inviteCode ?? ''); notifications.info(localize('inviteCopied', "Invite code copied.")); } });
		}
		items.push({ label: hosting ? localize('endItem', "$(close) End Session") : localize('leaveItem', "$(sign-out) Leave Session"), id: 'leave', run: () => multiplayer.leave() });
		const routes = await multiplayer.routes();
		const route = routes.length ? routes.every(type => type === 'relay') ? localize('routeRelay', "relayed") : routes.some(type => type === 'relay') ? localize('routeMixed', "some relayed") : localize('routeDirect', "direct") : '';
		const title = hosting ? localize('peopleTitleHost', "Your session") : localize('peopleTitleGuest', "Session");
		const picked = await quickInput.pick(items, { title: route ? localize('peopleTitleRoute', "{0} · connection {1}", title, route) : title });
		if (!picked) {
			return;
		}
		if (picked.run) {
			await picked.run();
			return;
		}
		const person = multiplayer.participants.find(participant => participant.id === picked.id);
		if (!hosting || !person || person.role === 'host') {
			return;
		}
		const action = await quickInput.pick([
			person.role === 'viewer'
				? { label: localize('makeCollaborator', "Make Collaborator"), description: localize('collaboratorHint', "can message agents and answer approvals"), id: 'collaborator' }
				: { label: localize('makeViewer', "Make Viewer"), description: localize('viewerHint', "can only watch"), id: 'viewer' },
			{ label: localize('remove', "Remove from Session"), id: 'kick' },
		], { title: person.name });
		if (action?.id === 'kick') {
			multiplayer.kick(person.id);
		} else if (action?.id === 'collaborator' || action?.id === 'viewer') {
			multiplayer.setRole(person.id, action.id);
		}
	}
});

/** A status bar entry while in a session: who's here, and the way to everything else. */
class MultiplayerStatus extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'active.multiplayerStatus';
	private readonly entry: IStatusbarEntryAccessor;

	constructor(
		@IStatusbarService statusbarService: IStatusbarService,
		@IMultiplayerService private readonly multiplayer: IMultiplayerService,
	) {
		super();
		this.entry = this._register(statusbarService.addEntry(this.render(), 'active.multiplayer', StatusbarAlignment.LEFT, 8));
		this._register(multiplayer.onDidChange(() => this.entry.update(this.render())));
	}

	private render(): IStatusbarEntry {
		const people = this.multiplayer.participants.length;
		const text = (() => {
			switch (this.multiplayer.state) {
				case 'idle': return '$(live-share)';
				case 'starting': return localize('statusStarting', "$(loading~spin) Starting session…");
				case 'joining': return localize('statusJoining', "$(loading~spin) Joining…");
				case 'waiting': return localize('statusWaiting', "$(loading~spin) Waiting for the host…");
				case 'hosting': return localize('statusHosting', "$(live-share) Hosting · {0}", people);
				case 'guest': return localize('statusGuest', "$(live-share) In session · {0}", people);
			}
		})();
		const tooltip = this.multiplayer.state === 'idle' ? localize('statusIdleTip', "Host or join a session") : localize('statusTip', "Who's in the session");
		return { name: localize('multiplayerStatus', "Multiplayer"), text, ariaLabel: tooltip, tooltip, command: CommandIds.People };
	}
}

registerWorkbenchContribution2(MultiplayerStatus.ID, MultiplayerStatus, WorkbenchPhase.AfterRestored);
