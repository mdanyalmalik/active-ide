/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { Disposable, DisposableStore, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { localize } from '../../../../nls.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IWorkbenchLayoutService } from '../../../services/layout/browser/layoutService.js';
import { IActiveService, VOICE_OFF } from './activeService.js';
import { renderSetupPanel, SetupPanelViewState } from './setupPanel.js';

const $ = dom.$;
const HIDE_KEY = 'active.welcome.hidden';
/** The developer answered "Narrate walkthroughs?" (here or by choosing a voice elsewhere). */
const VOICE_CHOSEN_KEY = 'active.welcome.voiceChosen';
/** How long setup must look incomplete before the dialog opens. */
const OPEN_DELAY_MS = 2500;

/**
 * The startup modal (in the spirit of the workspace trust prompt) shown while
 * Active isn't ready: trust the folder, connect the coding agent, and set up the
 * knowledge profile, and choose whether walkthroughs are narrated (and by which
 * voice). It doesn't come back once everything is done or the user turns it off.
 */
export class ActiveWelcomeDialog extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.activeWelcome';

	private readonly dialog = this._register(new MutableDisposable<DisposableStore>());
	private shown = false;
	private openTimer: ReturnType<typeof setTimeout> | undefined;
	private connecting = false;
	private readonly setupView: SetupPanelViewState = { showLog: false, apiKeyDraft: '' };

	constructor(
		@IWorkbenchLayoutService private readonly layoutService: IWorkbenchLayoutService,
		@IActiveService private readonly activeService: IActiveService,
		@IStorageService private readonly storageService: IStorageService,
		@IOpenerService private readonly openerService: IOpenerService,
		@IWorkspaceTrustManagementService private readonly trustService: IWorkspaceTrustManagementService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super();
		if (this.storageService.getBoolean(HIDE_KEY, StorageScope.PROFILE, false)) {
			return;
		}
		const evaluate = () => this.evaluate();
		this._register(activeService.onDidChangeAgent(evaluate));
		this._register(activeService.onDidChangeProfile(evaluate));
		// The voice list arrives with the narrator's status.
		this._register(activeService.onDidChangeNarration(evaluate));
		this._register(trustService.onDidChangeTrust(evaluate));
		void trustService.workspaceTrustInitialized.then(() => {
			// An untrusted folder never starts the agent, so ask right away.
			if (this.activeService.needsTrust) {
				evaluate();
			}
		});
		this._register(toDisposable(() => clearTimeout(this.openTimer)));
		void activeService.initialize().then(evaluate);
	}

	/** Asked once: an explicit voice (or Off) chosen anywhere counts as an answer. */
	private get voiceChosen(): boolean {
		return this.storageService.getBoolean(VOICE_CHOSEN_KEY, StorageScope.PROFILE, false) || this.activeService.narrationVoice !== 'default';
	}

	private async chooseVoice(voice: string): Promise<void> {
		this.storageService.store(VOICE_CHOSEN_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
		await this.activeService.setVoice(voice);
		this.render();
	}

	private get agentReady(): boolean {
		const agent = this.activeService.agent;
		return !agent.setup && (agent.status === 'idle' || agent.status === 'running');
	}

	private evaluate(): void {
		const agent = this.activeService.agent;
		if (this.dialog.value) {
			this.render();
			return;
		}
		// Wait until the agent's state and the saved profile are known (an untrusted folder never starts it).
		if (this.shown || (!this.activeService.needsTrust && (agent.status === 'starting' || !this.activeService.stateLoaded))) {
			return;
		}
		if (!this.activeService.needsTrust && this.agentReady && this.activeService.profile.configured && this.voiceChosen) {
			clearTimeout(this.openTimer);
			this.openTimer = undefined;
			return;
		}
		// The agent can look unready for a moment while it reconnects after a reload, so only
		// open if setup still looks incomplete a little later.
		this.openTimer ??= setTimeout(() => {
			this.openTimer = undefined;
			if (!this.shown && (this.activeService.needsTrust || !this.agentReady || !this.activeService.profile.configured || !this.voiceChosen)) {
				this.shown = true;
				this.open();
			}
		}, OPEN_DELAY_MS);
	}

	private open(): void {
		const store = new DisposableStore();
		this.dialog.value = store;
		const backdrop = dom.append(this.layoutService.mainContainer, $('.active-welcome-backdrop'));
		store.add({ dispose: () => backdrop.remove() });
		const box = dom.append(backdrop, $('.active-welcome'));
		box.setAttribute('role', 'dialog');
		box.setAttribute('aria-modal', 'true');
		box.tabIndex = -1;
		store.add(dom.addStandardDisposableListener(box, dom.EventType.KEY_DOWN, (event: StandardKeyboardEvent) => {
			if (event.keyCode === KeyCode.Escape) {
				event.preventDefault();
				this.close();
			}
		}));
		this.box = box;
		this.render();
		box.focus();
	}

	private box: HTMLElement | undefined;
	/** Trusted from this dialog: keep showing that step as done. */
	private trustedHere = false;
	private readonly contentStore = this._register(new DisposableStore());

	private render(): void {
		const box = this.box;
		if (!box || !this.dialog.value) {
			return;
		}
		this.contentStore.clear();
		dom.clearNode(box);
		const agent = this.activeService.agent;
		const provider = agent.provider;
		const click = (element: HTMLElement, run: () => unknown) => this.contentStore.add(dom.addDisposableListener(element, dom.EventType.CLICK, () => run()));

		const head = dom.append(box, $('.welcome-head'));
		dom.append(head, $('span.welcome-mark')).classList.add(...ThemeIcon.asClassNameArray(Codicon.sparkle));
		const titles = dom.append(head, $('.welcome-titles'));
		dom.append(titles, $('h2')).textContent = localize('welcomeTitle', "Welcome to Active");
		dom.append(titles, $('p')).textContent = localize('welcomeLead', "{0} writes the code. Active walks you through every change.", provider.name);

		// Trust: the agent edits files and runs commands, so it only runs in trusted folders.
		const needsTrust = this.activeService.needsTrust;
		const folder = this.workspaceService.getWorkspace().folders[0];
		if (needsTrust || this.trustedHere) {
			const trust = dom.append(box, $('.welcome-step'));
			const trustRow = dom.append(trust, $('.welcome-step-row'));
			this.stepIcon(trustRow, !needsTrust, Codicon.shield);
			const trustText = dom.append(trustRow, $('.welcome-step-text'));
			dom.append(trustText, $('.welcome-step-title')).textContent = localize('trustTitle', "Trust this folder");
			dom.append(trustText, $('.welcome-step-detail')).textContent = needsTrust
				? localize('trustDetail', "{0} edits files and runs commands in {1}. Only trust folders you trust.", provider.name, folder?.name ?? localize('thisFolder', "this folder"))
				: localize('trusted', "Trusted");
			if (needsTrust) {
				const button = dom.append(trustRow, $('button.primary')) as HTMLButtonElement;
				button.textContent = localize('trust', "Trust");
				click(button, async () => {
					this.trustedHere = true;
					await this.trustService.setWorkspaceTrust(true);
				});
			}
		}

		// The coding agent
		const connect = dom.append(box, $('.welcome-step'));
		connect.classList.toggle('disabled', needsTrust);
		const connectRow = dom.append(connect, $('.welcome-step-row'));
		this.stepIcon(connectRow, this.agentReady, Codicon.plug);
		const connectText = dom.append(connectRow, $('.welcome-step-text'));
		dom.append(connectText, $('.welcome-step-title')).textContent = localize('connectTitle', "Connect {0}", provider.name);
		dom.append(connectText, $('.welcome-step-detail')).textContent = this.agentReady
			? (agent.account ? localize('connectedAs', "Connected · {0}", agent.account) : localize('connected', "Connected"))
			: needsTrust
				? localize('connectAfterTrust', "After you trust the folder.")
				: agent.status === 'starting'
					? localize('connecting', "Connecting…")
					: agent.setup
						? localize('connectDetail', "Install and sign in. Takes a minute.")
						: agent.blocker ?? localize('connectUnavailable', "Not connected.");
		if (needsTrust) {
			// Nothing to connect until the folder is trusted.
		} else if (!this.agentReady && agent.status !== 'starting') {
			if (agent.setup && this.connecting) {
				renderSetupPanel(dom.append(connect, $('.welcome-setup')), agent.setup, provider, this.setupView, () => this.render(), this.contentStore, this.activeService, this.openerService);
			} else {
				const button = dom.append(connectRow, $('button.primary')) as HTMLButtonElement;
				button.textContent = agent.setup ? localize('connect', "Connect") : localize('retry', "Retry");
				click(button, () => {
					if (agent.setup) {
						this.connecting = true;
						this.render();
					} else {
						void this.activeService.reconnect();
					}
				});
			}
		}

		// Step 2: the knowledge profile
		const profileDone = this.activeService.profile.configured;
		const profile = dom.append(box, $('.welcome-step'));
		const profileRow = dom.append(profile, $('.welcome-step-row'));
		this.stepIcon(profileRow, profileDone, Codicon.account);
		const profileText = dom.append(profileRow, $('.welcome-step-text'));
		dom.append(profileText, $('.welcome-step-title')).textContent = localize('profileStepTitle', "Set up your knowledge profile");
		dom.append(profileText, $('.welcome-step-detail')).textContent = profileDone
			? localize('profileDone', "Done. Change it any time.")
			: localize('profileStepDetail', "So walkthroughs skip what you already know.");
		const profileButton = dom.append(profileRow, $(profileDone ? 'button.secondary' : this.agentReady ? 'button.primary' : 'button.secondary')) as HTMLButtonElement;
		profileButton.textContent = profileDone ? localize('editProfile', "Edit") : localize('setUpProfile', "Set Up");
		click(profileButton, () => {
			this.close();
			void this.activeService.openProfile();
		});

		// Step 3: the voice
		this.renderVoiceStep(box, click);

		// Footer
		const footer = dom.append(box, $('.welcome-footer'));
		const hide = dom.append(footer, $('label.welcome-hide'));
		const checkbox = dom.append(hide, $('input')) as HTMLInputElement;
		checkbox.type = 'checkbox';
		checkbox.checked = this.storageService.getBoolean(HIDE_KEY, StorageScope.PROFILE, false);
		dom.append(hide, $('span')).textContent = localize('dontShow', "Don't show again");
		this.contentStore.add(dom.addDisposableListener(checkbox, dom.EventType.CHANGE, () => this.storageService.store(HIDE_KEY, checkbox.checked, StorageScope.PROFILE, StorageTarget.USER)));
		const allDone = !needsTrust && this.agentReady && profileDone && this.voiceChosen;
		const done = dom.append(footer, $(allDone ? 'button.primary' : 'button.secondary')) as HTMLButtonElement;
		done.textContent = allDone ? localize('getStarted', "Get Started") : localize('later', "Later");
		click(done, () => this.close());
	}

	/** "Narrate walkthroughs?" Yes or No, and with Yes, which voice (each one can be previewed). */
	private renderVoiceStep(box: HTMLElement, click: (element: HTMLElement, run: () => unknown) => void): void {
		const narration = this.activeService.narration;
		const chosen = this.voiceChosen;
		const off = this.activeService.voiceOff;
		const step = dom.append(box, $('.welcome-step'));
		const row = dom.append(step, $('.welcome-step-row'));
		this.stepIcon(row, chosen, off ? Codicon.mute : Codicon.unmute);
		const text = dom.append(row, $('.welcome-step-text'));
		dom.append(text, $('.welcome-step-title')).textContent = localize('voiceStepTitle', "Narrate walkthroughs?");
		const voiceName = (name: string) => name === 'default' ? localize('defaultVoiceName', "Default voice") : name;
		dom.append(text, $('.welcome-step-detail')).textContent = !narration.available && !off
			? localize('voiceUnavailable', "Narration isn't available here yet: {0}", narration.detail)
			: !chosen
				? localize('voiceStepDetail', "Walkthroughs can be read aloud as they play, or read by you with Previous and Next.")
				: off
					? localize('voiceOffDetail', "Off. You read walkthroughs yourself, with Previous and Next.")
					: localize('voiceOnDetail', "On · {0}. Change it any time from the status bar.", voiceName(this.activeService.narrationVoice));
		const choice = dom.append(row, $('.welcome-choice'));
		const option = (label: string, selected: boolean, run: () => unknown, disabled = false) => {
			const button = dom.append(choice, $(selected ? 'button.primary' : 'button.secondary')) as HTMLButtonElement;
			button.textContent = label;
			button.disabled = disabled;
			button.setAttribute('aria-pressed', String(selected));
			click(button, run);
		};
		option(localize('voiceYes', "Yes"), chosen && !off, () => this.chooseVoice(off ? 'default' : this.activeService.narrationVoice), !narration.available);
		option(localize('voiceNo', "No"), chosen && off, () => this.chooseVoice(VOICE_OFF));
		if (!chosen || off || !narration.available) {
			return;
		}
		// Which voice: a list, with a preview of the selected one.
		const picker = dom.append(step, $('.welcome-voice'));
		const select = dom.append(picker, $('select.welcome-voice-select')) as HTMLSelectElement;
		select.setAttribute('aria-label', localize('voiceSelectLabel', "Narration voice"));
		const voices = narration.voices?.length ? narration.voices : [{ name: 'default', description: undefined, character: false }];
		const current = this.activeService.narrationVoice;
		const group = (label: string, list: typeof voices) => {
			if (!list.length) {
				return;
			}
			const element = dom.append(select, $('optgroup')) as HTMLOptGroupElement;
			element.label = label;
			for (const voice of list) {
				const item = dom.append(element, $('option')) as HTMLOptionElement;
				item.value = voice.name;
				item.textContent = voiceName(voice.name);
				item.title = voice.description ?? '';
				item.selected = voice.name === current;
			}
		};
		group(localize('narratorsGroup', "Narrators"), voices.filter(voice => !voice.character));
		group(localize('charactersGroup', "Character voices"), voices.filter(voice => voice.character));
		this.contentStore.add(dom.addDisposableListener(select, dom.EventType.CHANGE, () => void this.chooseVoice(select.value)));
		const preview = dom.append(picker, $('button.secondary')) as HTMLButtonElement;
		const label = () => preview.textContent = this.activeService.speaking ? localize('voiceStopPreview', "Stop") : localize('voicePreview', "▶ Preview");
		label();
		this.contentStore.add(this.activeService.onDidChangeSpeaking(label));
		click(preview, () => {
			if (this.activeService.speaking) {
				this.activeService.stopSpeaking();
				return;
			}
			const name = select.value;
			void this.activeService.speak(localize('voiceSampleWelcome', "Hi, I'm {0}. This is how your walkthroughs will sound.", name === 'default' ? localize('phononName', "Phonon") : name), name);
		});
	}

	private stepIcon(parent: HTMLElement, done: boolean, icon: ThemeIcon): void {
		const element = dom.append(parent, $('span.welcome-step-icon'));
		element.classList.toggle('done', done);
		element.classList.add(...ThemeIcon.asClassNameArray(done ? Codicon.check : icon));
	}

	private close(): void {
		this.contentStore.clear();
		this.box = undefined;
		this.dialog.clear();
	}
}
