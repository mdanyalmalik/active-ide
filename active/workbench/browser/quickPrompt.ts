/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore, IDisposable, MutableDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import type { AgentInfo } from '../common/activeProtocol.js';
import { agentColor } from './agentGrid.js';

const $ = dom.$;

/** What a right-click on an ask or change button offers: a small box that sends straight to the agent. */
export interface QuickPromptOptions {
	/** What the message is about, e.g. "Request a change · client.js 3–8". */
	readonly title: string;
	readonly placeholder: string;
	/** Who it goes to (shown as "To: <agent>" when there's more than one agent). */
	readonly agent?: AgentInfo;
	readonly showAgent?: boolean;
	readonly send: (text: string) => Promise<void>;
}

/** Whether to name the receiving agent: only when there's a choice (merged agents and helpers don't count). */
export function showsReceiver(agents: readonly AgentInfo[]): boolean {
	return agents.filter(agent => agent.kind === 'agent' && !agent.mergedInto).length > 1;
}

/** Only one quick prompt at a time: opening another closes the first. */
const current = new MutableDisposable<IDisposable>();

const GAP_PX = 6;
const EXIT_MS = 220;

/**
 * Opens the quick prompt by `anchor` (the button that was right-clicked). Enter sends and the box leaves with a short
 * lift-and-fade; Shift+Enter adds a line; Escape, clicking elsewhere or switching away closes it without sending.
 */
export function showQuickPrompt(anchor: HTMLElement, options: QuickPromptOptions): void {
	const store = new DisposableStore();
	current.value = store;
	const targetWindow = dom.getWindow(anchor);
	// Inside the workbench element, so theme colours apply; fixed, so no scrolling container clips it.
	const host = anchor.closest<HTMLElement>('.monaco-workbench') ?? targetWindow.document.body;
	const box = dom.append(host, $('.active-quick-prompt'));
	box.setAttribute('role', 'dialog');
	box.setAttribute('aria-label', options.title);
	let closing = false;
	store.add(toDisposable(() => {
		if (!closing) {
			box.remove();
		}
	}));

	const head = dom.append(box, $('.quick-prompt-head'));
	dom.append(head, $('span.quick-prompt-title')).textContent = options.title;
	if (options.agent && options.showAgent) {
		const to = dom.append(head, $('span.quick-prompt-to'));
		to.style.setProperty('--agent-color', agentColor(options.agent));
		dom.append(to, $('span.agent-dot'));
		dom.append(to, $('span')).textContent = localize('quickPromptTo', "To {0}", options.agent.name);
	}
	const input = dom.append(box, $('textarea.quick-prompt-input')) as HTMLTextAreaElement;
	input.rows = 1;
	input.placeholder = options.placeholder;
	input.setAttribute('aria-label', options.placeholder);
	dom.append(box, $('.quick-prompt-hint')).textContent = localize('quickPromptHint', "Enter to send · Esc to cancel");

	// Where the button was: some buttons (the editor's selection buttons) disappear once focus moves into the box.
	let anchorRect = anchor.getBoundingClientRect();
	const place = () => {
		if (anchor.isConnected && anchor.offsetParent) {
			anchorRect = anchor.getBoundingClientRect();
		}
		const rect = anchorRect;
		const width = box.offsetWidth;
		const height = box.offsetHeight;
		const viewport = { width: targetWindow.innerWidth, height: targetWindow.innerHeight };
		const left = Math.max(8, Math.min(rect.left, viewport.width - width - 8));
		const below = rect.bottom + GAP_PX;
		const top = below + height <= viewport.height - 8 ? below : Math.max(8, rect.top - GAP_PX - height);
		box.style.left = `${left}px`;
		box.style.top = `${top}px`;
		box.classList.toggle('above', top < rect.top);
	};
	const grow = () => {
		input.style.height = 'auto';
		input.style.height = `${Math.min(input.scrollHeight, 160)}px`;
	};
	place();
	// Next frame, so the entering transition runs from the starting style.
	targetWindow.requestAnimationFrame(() => box.classList.add('open'));
	// Focus goes back where it was (the editor, say) when the box closes, sent or not.
	const previousFocus = targetWindow.document.activeElement as HTMLElement | null;
	input.focus();

	const close = (sent: boolean) => {
		if (closing) {
			return;
		}
		closing = true;
		if (box.contains(targetWindow.document.activeElement) && previousFocus?.isConnected) {
			previousFocus.focus();
		}
		box.classList.remove('open');
		box.classList.add(sent ? 'sent' : 'closing');
		targetWindow.setTimeout(() => box.remove(), EXIT_MS);
		if (current.value === store) {
			current.clear();
		} else {
			store.dispose();
		}
	};
	const send = () => {
		const text = input.value.trim();
		if (!text) {
			close(false);
			return;
		}
		close(true);
		void options.send(text);
	};

	store.add(dom.addDisposableListener(input, dom.EventType.INPUT, () => {
		grow();
		place();
	}));
	store.add(dom.addStandardDisposableListener(input, dom.EventType.KEY_DOWN, (event: StandardKeyboardEvent) => {
		if (event.keyCode === KeyCode.Enter && !event.shiftKey && !event.browserEvent.isComposing) {
			event.preventDefault();
			send();
		} else if (event.keyCode === KeyCode.Escape) {
			event.preventDefault();
			event.stopPropagation();
			close(false);
		}
	}));
	// A click anywhere else (not a right-click on another button, which opens its own) closes it.
	store.add(dom.addDisposableListener(targetWindow.document, dom.EventType.MOUSE_DOWN, event => {
		if (!box.contains(event.target as Node) && event.button === 0) {
			close(false);
		}
	}, true));
	store.add(dom.addDisposableListener(targetWindow, dom.EventType.BLUR, () => close(false)));
	store.add(dom.addDisposableListener(targetWindow, dom.EventType.RESIZE, () => place()));
}

/**
 * Right-click on `button` opens the quick prompt instead of the browser or editor menu. `options` is read at click
 * time, so it can describe what's selected then. Returns undefined (no prompt) when quick sending isn't allowed.
 */
export function onRightClickQuickPrompt(button: HTMLElement, options: () => QuickPromptOptions | undefined): IDisposable {
	return dom.addDisposableListener(button, dom.EventType.CONTEXT_MENU, event => {
		const resolved = options();
		if (!resolved) {
			return;
		}
		event.preventDefault();
		event.stopPropagation();
		showQuickPrompt(button, resolved);
	});
}
