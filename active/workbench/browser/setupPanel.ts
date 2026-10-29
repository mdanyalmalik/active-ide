/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import type { AgentProviderInfo, SetupState, SignInMethod } from '../common/activeProtocol.js';
import { IActiveService } from './activeService.js';

const $ = dom.$;

/** View-only state that survives re-renders (expanded log, typed key). */
export interface SetupPanelViewState {
	showLog: boolean;
	apiKeyDraft: string;
}

function icon(parent: HTMLElement, codicon: ThemeIcon, spin = false): HTMLElement {
	const element = dom.append(parent, $('span.setup-icon'));
	element.classList.add(...ThemeIcon.asClassNameArray(codicon));
	if (spin) {
		element.classList.add('codicon-modifier-spin');
	}
	return element;
}

/**
 * First-run setup of the coding agent, rendered inside chat: install, choose
 * subscription or API key, sign in. Everything here is provider-agnostic; names
 * and options come from the agent services.
 */
export function renderSetupPanel(container: HTMLElement, setup: SetupState, provider: AgentProviderInfo, view: SetupPanelViewState, rerender: () => void, store: DisposableStore, activeService: IActiveService, openerService: IOpenerService): void {
	const panel = dom.append(container, $('.active-setup'));
	const click = (element: HTMLElement, run: () => unknown) => store.add(dom.addDisposableListener(element, dom.EventType.CLICK, () => run()));
	const button = (parent: HTMLElement, label: string, kind: 'primary' | 'secondary' | 'link', run: () => unknown) => {
		const element = dom.append(parent, $(`button.${kind}`)) as HTMLButtonElement;
		element.textContent = label;
		click(element, run);
		return element;
	};
	const link = (parent: HTMLElement, label: string, url: string) => {
		const element = dom.append(parent, $('a.setup-link'));
		element.textContent = label;
		element.tabIndex = 0;
		click(element, () => openerService.open(URI.parse(url), { openExternal: true }));
		return element;
	};

	// Header
	const head = dom.append(panel, $('.setup-head'));
	icon(head, Codicon.sparkle).classList.add('setup-mark');
	const titles = dom.append(head, $('.setup-titles'));
	dom.append(titles, $('h2')).textContent = setup.step === 'install'
		? localize('setupTitleInstall', "Set up {0}", provider.name)
		: localize('setupTitleSignIn', "Sign in to {0}", provider.name);
	dom.append(titles, $('p')).textContent = setup.reason
		? localize('setupReason', "{0} needs you to sign in before it can keep working.", provider.name)
		: localize('setupLead', "Active works alongside {0}: it writes the code, then Active walks you through what changed.", provider.name);

	// Stepper
	const steps: Array<{ id: SetupState['step']; label: string }> = [
		{ id: 'install', label: localize('stepInstall', "Install") },
		{ id: 'chooseMethod', label: localize('stepSignIn', "Sign in") },
		{ id: 'done', label: localize('stepReady', "Ready") },
	];
	const order = (step: SetupState['step']) => step === 'install' ? 0 : step === 'done' ? 2 : 1;
	const current = setup.signIn.status === 'done' ? 2 : order(setup.step);
	const stepper = dom.append(panel, $('ol.setup-steps'));
	steps.forEach((step, index) => {
		const item = dom.append(stepper, $('li'));
		item.classList.toggle('done', index < current);
		item.classList.toggle('current', index === current);
		const bullet = dom.append(item, $('span.bullet'));
		if (index < current) {
			icon(bullet, Codicon.check);
		} else {
			bullet.textContent = String(index + 1);
		}
		dom.append(item, $('span.label')).textContent = step.label;
	});

	const body = dom.append(panel, $('.setup-body'));

	// Step 1: install
	if (setup.step === 'install') {
		const install = setup.install;
		if (install.unavailable) {
			dom.append(body, $('p.setup-text')).textContent = install.unavailable;
			button(dom.append(body, $('.setup-actions')), localize('reconnect', "I've Installed It"), 'primary', () => activeService.reconnect());
			return;
		}
		if (install.status === 'running') {
			const progress = dom.append(body, $('.setup-progress'));
			dom.append(progress, $('.setup-progress-bar.indeterminate'));
			const status = dom.append(body, $('.setup-status'));
			icon(status, Codicon.loading, true);
			dom.append(status, $('span')).textContent = install.line ?? localize('installing', "Installing…");
		} else if (install.status === 'failed') {
			const status = dom.append(body, $('.setup-status.error'));
			icon(status, Codicon.error);
			dom.append(status, $('span')).textContent = install.error ?? localize('installFailed', "The installer stopped before finishing.");
		} else {
			dom.append(body, $('p.setup-text')).textContent = localize('installExplain', "Active will run {0}'s official installer. It adds the command-line app for your user account only.", provider.name);
			const command = dom.append(body, $('.setup-command'));
			icon(command, Codicon.terminal);
			dom.append(command, $('code')).textContent = install.command ?? '';
			if (install.scriptUrl) {
				link(command, localize('readScript', "Read the script"), install.scriptUrl);
			}
		}
		const actions = dom.append(body, $('.setup-actions'));
		if (install.status === 'running') {
			button(actions, localize('cancel', "Cancel"), 'secondary', () => activeService.setupCancel());
		} else {
			button(actions, install.status === 'failed' ? localize('retryInstall', "Try Again") : localize('installButton', "Install {0}", provider.name), 'primary', () => activeService.setupInstall());
		}
		if (install.log.length) {
			button(actions, view.showLog ? localize('hideDetails', "Hide Details") : localize('showDetails', "Show Details"), 'link', () => {
				view.showLog = !view.showLog;
				rerender();
			});
			if (view.showLog) {
				dom.append(body, $('pre.setup-log')).textContent = install.log.join('\n');
			}
		}
		return;
	}

	// Step 2a: choose subscription or API key
	if (setup.step === 'chooseMethod') {
		dom.append(body, $('p.setup-question')).textContent = localize('chooseMethod', "How do you want to sign in?");
		const choices = dom.append(body, $('.setup-choices'));
		for (const method of setup.methods) {
			const card = dom.append(choices, $('button.setup-choice')) as HTMLButtonElement;
			card.disabled = !!method.unavailable;
			icon(card, method.id === 'subscription' ? Codicon.account : Codicon.key);
			const text = dom.append(card, $('.choice-text'));
			dom.append(text, $('.choice-label')).textContent = method.label;
			dom.append(text, $('.choice-description')).textContent = method.unavailable ?? method.description;
			icon(card, Codicon.chevronRight).classList.add('choice-go');
			click(card, () => activeService.setupChooseMethod(method.id as SignInMethod));
		}
		return;
	}

	// Step 2b: sign in
	const back = () => button(dom.append(body, $('.setup-back')), localize('otherMethod', "← Choose a different way to sign in"), 'link', () => activeService.setupRestart());
	const signIn = setup.signIn;
	if (signIn.status === 'done') {
		const status = dom.append(body, $('.setup-status.success'));
		icon(status, Codicon.passFilled);
		dom.append(status, $('span')).textContent = signIn.message ?? localize('signedIn', "Signed in");
		return;
	}

	if (setup.method === 'apiKey') {
		dom.append(body, $('p.setup-text')).textContent = localize('apiKeyExplain', "Paste your key. Active stores it in your system keychain and gives it to {0} only when it starts.", provider.name);
		const row = dom.append(body, $('.setup-key-row'));
		const input = dom.append(row, $('input.setup-key')) as HTMLInputElement;
		input.type = 'password';
		input.placeholder = setup.apiKeyEnvVar ? localize('apiKeyPlaceholderVar', "Paste your key ({0})", setup.apiKeyEnvVar) : localize('apiKeyPlaceholder', "Paste your key");
		input.value = view.apiKeyDraft;
		input.autocomplete = 'off';
		input.spellcheck = false;
		const save = button(row, localize('saveKey', "Save Key"), 'primary', () => activeService.setupSaveApiKey(input.value));
		save.disabled = !input.value.trim();
		store.add(dom.addDisposableListener(input, dom.EventType.INPUT, () => {
			view.apiKeyDraft = input.value;
			save.disabled = !input.value.trim();
		}));
		store.add(dom.addStandardDisposableListener(input, dom.EventType.KEY_DOWN, (event: StandardKeyboardEvent) => {
			if (event.keyCode === KeyCode.Enter && input.value.trim()) {
				void activeService.setupSaveApiKey(input.value);
			}
		}));
		setTimeout(() => input.focus(), 0);
		if (setup.apiKeyHelpUrl) {
			link(dom.append(body, $('.setup-help')), localize('whereKey', "Where do I get a key?"), setup.apiKeyHelpUrl);
		}
		back();
		return;
	}

	// Subscription: browser sign-in driven in the background.
	if (signIn.status === 'idle') {
		dom.append(body, $('p.setup-text')).textContent = localize('browserExplain', "Active will open {0}'s sign-in page in your browser. Approve it there, then come back here. No terminal needed.", provider.name);
		button(dom.append(body, $('.setup-actions')), localize('signInBrowser', "Sign In with Browser"), 'primary', () => activeService.setupSignIn());
	} else if (signIn.status === 'failed') {
		const status = dom.append(body, $('.setup-status.error'));
		icon(status, Codicon.error);
		dom.append(status, $('span')).textContent = signIn.message ?? localize('signInFailed', "Sign-in didn't complete.");
		const actions = dom.append(body, $('.setup-actions'));
		button(actions, localize('tryAgain', "Try Again"), 'primary', () => activeService.setupSignIn());
		button(actions, localize('useKeyInstead', "Use an API Key Instead"), 'secondary', () => activeService.setupChooseMethod('apiKey'));
	} else {
		const waiting = signIn.status === 'waitingForBrowser';
		const progress = dom.append(body, $('.setup-progress'));
		dom.append(progress, $('.setup-progress-bar.indeterminate'));
		const status = dom.append(body, $('.setup-status'));
		icon(status, waiting ? Codicon.globe : Codicon.loading, !waiting);
		dom.append(status, $('span')).textContent = waiting
			? localize('approveInBrowser', "Approve the sign-in in your browser, then come back here.")
			: signIn.message ?? localize('startingSignIn', "Starting sign-in…");
		if (signIn.code) {
			const code = dom.append(body, $('.setup-code'));
			dom.append(code, $('span.setup-code-label')).textContent = localize('confirmCode', "Check that the page shows this code:");
			dom.append(code, $('code')).textContent = signIn.code;
		}
		const actions = dom.append(body, $('.setup-actions'));
		if (signIn.url) {
			button(actions, localize('openSignInPage', "Open Sign-In Page"), 'secondary', () => openerService.open(URI.parse(signIn.url!), { openExternal: true }));
		}
		button(actions, localize('cancel', "Cancel"), 'link', () => activeService.setupCancel());
	}
	back();
}
