#!/usr/bin/env node
// Copyright (c) Active contributors. Licensed under the MIT License.
//
// DEV ONLY. Lets an automated "user" operate a running Active window (started
// with --remote-debugging-port, default 9333) the way a person would: read
// what is on screen, type in chat, and use the walkthrough controls.
//
//   ui-driver.mjs observe                 what is on screen right now (text)
//   ui-driver.mjs shot <name>             save a screenshot, prints its path
//   ui-driver.mjs chat <text>             send a coding task from chat (opens chat if needed)
//   ui-driver.mjs ask <question>          from a walkthrough: open chat and ask about the current scene
//   ui-driver.mjs wt <play|pause|next|rewind|open-file|open-chat|return>
//   ui-driver.mjs wait <seconds> [walkthrough|idle]   wait, optionally until a walkthrough is showing / the agent is idle
//   ui-driver.mjs history                 list saved turns
//   ui-driver.mjs replay <turnNumber>     replay a saved walkthrough
//   ui-driver.mjs click <text>            click the visible button, link, tab, menu or list item with that text (or tooltip)
//   ui-driver.mjs type <text>             type into whatever has focus (add --enter to press Enter after)
//   ui-driver.mjs key <combo>             press a key or chord, e.g. Escape, Enter, Meta+Comma
//   ui-driver.mjs command <title>         run a command from the Command Palette, e.g. "Active: Catch Me Up"
//   ui-driver.mjs setting <title> <value> in an open Settings editor, change the setting with that title (dropdown, number, text or checkbox)

import { createRequire } from 'node:module';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(path.resolve(here, '../../../vscode/node_modules/playwright-core'));
const port = process.env.ACTIVE_CDP_PORT ?? '9333';
const shotsDir = process.env.ACTIVE_SHOTS_DIR ?? path.resolve(here, '../../../.active-dev/shots');

const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts().flatMap(context => context.pages()).find(candidate => candidate.url().includes('workbench'));
if (!page) {
	console.error('No Active window found.');
	process.exit(1);
}
const [command, ...args] = process.argv.slice(2);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Everything a person could read on screen, as text. */
function snapshot() {
	const text = el => el?.innerText?.trim() ?? '';
	const q = (selector, root = document) => root.querySelector(selector);
	const qa = (selector, root = document) => [...root.querySelectorAll(selector)];
	const activeTab = q('.tabs-container .tab.active')?.getAttribute('aria-label') ?? '';
	const out = [];
	out.push(`ACTIVE TAB: ${activeTab}`);
	out.push(`OPEN TABS: ${qa('.tabs-container .tab').map(tab => tab.getAttribute('aria-label')).join(' | ')}`);
	out.push(`STATUS BAR: ${text(q('.statusbar')).replace(/\n/g, ' | ')}`);
	const chat = q('.active-chat');
	if (chat && chat.offsetParent) {
		out.push('', '== CHAT ==');
		out.push(`HEADER: ${text(q('.active-chat-header')).replace(/\n/g, ' | ')}`);
		const notices = text(q('.active-chat-notices'));
		if (notices) {
			out.push(`NOTICES: ${notices.replace(/\n/g, ' / ')}`);
		}
		// Keep line breaks so commands and lists in answers read as they appear on screen.
		const entries = qa('.active-chat-transcript .entry').slice(-14).map(entry => `- ${text(entry).replace(/\n+/g, '\n    ')}`);
		out.push('TRANSCRIPT (latest):', ...entries);
		const stage = text(q('.active-chat-stage'));
		if (stage) {
			out.push(`ACTIVITY: ${stage}`);
		}
		const headerButtons = qa('.active-chat-header button').map(button => `[${text(button) || button.title || button.getAttribute('aria-label')}]`);
		if (headerButtons.length) {
			out.push(`HEADER BUTTONS: ${headerButtons.join(' ')}`);
		}
		const handoff = q('.active-chat-handoff');
		if (handoff && !handoff.classList.contains('hidden') && text(handoff)) {
			out.push(`HANDOFF: ${text(handoff).replace(/\n/g, ' / ')}`);
		}
		const tools = qa('.active-chat-composer .composer-bar button, .active-chat-composer .composer-tools button').map(button => `[${text(button) || button.title || button.getAttribute('aria-label')}${button.disabled ? ' (disabled)' : ''}]`);
		if (tools.length) {
			out.push(`COMPOSER BUTTONS: ${[...new Set(tools)].join(' ')}`);
		}
		const modes = qa('.composer-context button.mode').map(button => `${button.classList.contains('selected') ? '[x]' : '[ ]'} ${text(button)}`);
		if (modes.length) {
			out.push(`COMPOSER MODE: ${modes.join('  ')}`);
		}
	}
	const walkthrough = q('.active-walkthrough');
	if (walkthrough && walkthrough.offsetParent) {
		out.push('', '== WALKTHROUGH ==');
		out.push(`FILES: ${text(q('.walkthrough-files')).replace(/\n/g, ' ')}`);
		out.push(`BREADCRUMBS: ${text(q('.walkthrough-crumbs .breadcrumbs')).replace(/\n/g, '')}   (${text(q('.walkthrough-crumbs .captured-version'))})`);
		out.push(`CONTROLS: ${text(q('.walkthrough-controls')).replace(/\n/g, ' | ')}`);
		// Code on screen, with highlighted lines marked ">>".
		const editor = q('.walkthrough-code .monaco-editor');
		if (editor) {
			const numbers = qa('.margin-view-overlays .line-numbers', editor).map(el => ({ top: el.parentElement.getBoundingClientRect().top, n: text(el) }));
			const focusTops = qa('.view-overlays .active-focus-line, .view-overlays .active-focus-line-secondary', editor).map(el => el.getBoundingClientRect().top);
			const lines = qa('.view-lines .view-line', editor).map(el => ({ top: el.getBoundingClientRect().top, code: el.innerText.replace(/ /g, ' ') })).sort((a, b) => a.top - b.top);
			out.push('CODE ON SCREEN:');
			for (const line of lines) {
				const number = numbers.find(entry => Math.abs(entry.top - line.top) < 3)?.n ?? '';
				const focused = focusTops.some(top => Math.abs(top - line.top) < 3);
				out.push(`${focused ? '>>' : '  '} ${number.padStart(4)}  ${line.code}`);
			}
			const folded = qa('.active-folded-region', editor).map(text);
			if (folded.length) {
				out.push(`FOLDED: ${folded.join(' ; ')}`);
			}
		}
		const card = q('.active-explain-card');
		if (card) {
			out.push('EXPLANATION ZONE:');
			out.push(`  label: ${text(q('.eyebrow', card))}`);
			out.push(`  title: ${text(q('h2.title', card))}`);
			const subtitle = text(q('.subtitle', card));
			if (subtitle) {
				out.push(`  visual kind: ${subtitle}`);
			}
			const nodes = qa('.diagram-node', card).map(node => `${node.classList.contains('highlight') ? '*' : ''}[${text(node).replace(/\n/g, ' — ')}]`);
			if (nodes.length) {
				out.push(`  diagram boxes: ${nodes.join('  ')}`);
				out.push(`  diagram arrows: ${qa('.edge-label', card).map(text).join(' ; ')}`);
			}
			const latex = qa('annotation[encoding="application/x-tex"]', card).map(el => el.textContent);
			if (latex.length) {
				out.push(`  equation: ${latex.join(' ; ')}`);
				out.push(`  legend: ${text(q('.active-visual-legend', card)).replace(/\n/g, ' ')}`);
			}
			const chart = q('.active-visual-chart', card);
			if (chart) {
				const bars = qa('rect.bar', chart).length;
				out.push(`  chart: ${text(q('.chart-title', chart))} (${bars} bars visible; values: ${qa('text.value', chart).map(el => el.textContent).join(', ')})`);
			}
			const diff = q('.active-visual-diff', card);
			if (diff) {
				out.push(`  diff:\n${qa('.diff-line', diff).map(line => `    ${line.textContent}`).join('\n')}`);
			}
			const code = q('.active-visual-code', card);
			if (code) {
				out.push(`  code excerpt:\n${code.innerText.split('\n').map(line => `    ${line}`).join('\n')}`);
			}
			qa('.active-visual-badge, .active-visual-source, .caption', card).forEach(el => out.push(`  note: ${text(el)}`));
			const segments = qa('p.narration .segment', card).map(segment => `${segment.classList.contains('current') ? '▶ ' : '  '}${text(segment)}`);
			out.push('  narration (▶ = being spoken):', ...segments.map(segment => `    ${segment}`));
			const pending = text(q('.pending', card));
			if (pending) {
				out.push(`  pending: ${pending.replace(/\n/g, ' ')}`);
			}
		}
	}
	const feedback = qa('.detail-feedback').find(el => el.offsetParent);
	if (feedback) {
		out.push('', `DETAIL QUESTION: ${text(feedback).replace(/\n/g, ' | ')}`);
	}
	const history = q('.active-history');
	if (history && history.offsetParent) {
		out.push('', '== HISTORY ==', ...qa('.active-history .turn').map(turn => `- ${text(turn).replace(/\n/g, ' | ')}`));
	}
	// Settings may open as a tab or as a floating panel over the editor.
	const settings = qa('.settings-editor').find(el => el.offsetParent);
	if (settings) {
		out.push('', '== SETTINGS ==');
		out.push(`SEARCH: ${text(q('.settings-header .suggest-input-container', settings)).replace(/\n/g, ' ')}`);
		out.push(`TOC: ${qa('.settings-toc-container .monaco-list-row', settings).map(row => text(row)).join(' | ')}`);
		for (const row of qa('.settings-tree-container .monaco-list-row', settings).slice(0, 14)) {
			const title = text(q('.setting-item-label', row)) || text(q('.settings-group-title-label', row));
			const category = text(q('.setting-item-category', row));
			const value = q('select', row)?.selectedOptions?.[0]?.textContent ?? q('input[type=number], input[type=text], textarea', row)?.value ?? (q('.setting-value-checkbox', row) ? (q('.setting-value-checkbox', row).classList.contains('checked') ? 'on' : 'off') : '');
			const description = text(q('.setting-item-description', row)).slice(0, 140);
			out.push(`- ${category}${title}${value !== '' ? ` = ${value}` : ''}${description ? `  — ${description}` : ''}`);
		}
	}
	const editorPane = activeTab && !/Active Chat|Walkthrough|Settings/.test(activeTab) ? q('.editor-group-container.active .editor-container') : null;
	if (!settings && editorPane && !q('.active-chat', editorPane)?.offsetParent && !q('.active-walkthrough', editorPane)?.offsetParent) {
		out.push('', '== EDITOR ==', text(editorPane).slice(0, 3000));
	}
	const menu = qa('.monaco-menu .action-item:not(.disabled) .action-label, .context-view .monaco-menu .action-label').map(el => `${el.closest('.action-item')?.querySelector('[aria-checked=true]') ? '✓ ' : ''}${text(el)}`).filter(Boolean);
	if (menu.length) {
		out.push('', `OPEN MENU: ${[...new Set(menu)].join(' | ')}`);
	}
	const quickInput = q('.quick-input-widget');
	if (quickInput && quickInput.style.display !== 'none' && quickInput.offsetParent) {
		out.push('', `QUICK PICK: ${q('.quick-input-box input', quickInput)?.placeholder ?? ''}`);
		out.push(...qa('.quick-input-list .monaco-list-row', quickInput).slice(0, 12).map(row => `- ${text(row).replace(/\n/g, ' — ')}`));
	}
	const dialog = q('.monaco-dialog-box');
	if (dialog) {
		out.push('', `DIALOG: ${text(dialog).replace(/\n/g, ' / ')}`);
	}
	// The round button at the bottom right; hovering it opens these choices upwards.
	const fab = q('.active-fab-stack');
	if (fab && !fab.classList.contains('hidden')) {
		const choices = qa('.active-fab-item', fab).filter(item => !item.classList.contains('hidden')).map(text);
		out.push('', `FLOATING BUTTON (bottom right, hover for a menu): ${choices.join(' | ')}`);
	}
	// Active's welcome dialog covers the window until "Later" or "Get Started".
	const welcome = q('.active-welcome');
	if (welcome) {
		out.push('', `WELCOME DIALOG (blocks clicks): ${text(welcome).replace(/\n+/g, ' / ')}`);
	}
	const notifications = qa('.notifications-toasts .notification-list-item-message').map(text);
	if (notifications.length) {
		out.push('', `NOTIFICATIONS: ${notifications.join(' / ')}`);
	}
	return out.join('\n');
}

async function focusWalkthrough() {
	await page.click('.active-walkthrough .walkthrough-crumbs');
}

/** Opens the History view; its activity bar icon toggles, so only click when it's hidden. */
async function showHistory() {
	if (!await page.locator('.active-history').isVisible().catch(() => false)) {
		await page.click(".activitybar [aria-label^='History']");
		await sleep(800);
	}
}

/** The round button at the bottom right: hover it, then pick from the menu that opens upwards. */
async function openFromFloatingMenu(label) {
	// A real pointer move: the menu opens on :hover.
	const box = await page.locator('.active-fab-stack .active-fab-main').boundingBox();
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
	await sleep(350);
	await page.locator('.active-fab-stack .active-fab-item', { hasText: label }).first().click();
}

async function openChat() {
	const chatTab = page.locator(".tabs-container .tab[aria-label='Active Chat']");
	if (await chatTab.count()) {
		await chatTab.first().click();
	} else {
		await page.keyboard.press('Meta+Alt+KeyI');
	}
	await page.waitForSelector('.active-chat-composer textarea', { state: 'visible', timeout: 10000 });
}

async function typeInComposer(text) {
	await page.click('.active-chat-composer textarea');
	await page.keyboard.type(text, { delay: 2 });
	await page.keyboard.press('Enter');
}

const states = {
	walkthrough: () => !!document.querySelector('.active-walkthrough')?.offsetParent,
	idle: () => /Ready/.test(document.querySelector('.active-chat-header .agent-status')?.textContent ?? '') || !!document.querySelector('.active-walkthrough')?.offsetParent,
};

switch (command) {
	case 'observe':
		console.log(await page.evaluate(snapshot));
		break;
	case 'shot': {
		const file = path.join(shotsDir, `${(args[0] ?? 'screen').replace(/[^\w-]/g, '_')}.png`);
		await page.screenshot({ path: file });
		console.log(file);
		break;
	}
	case 'chat': {
		await openChat();
		const task = page.locator('.composer-context button.mode', { hasText: 'New Coding Task' });
		if (await task.count()) {
			await task.click();
		}
		await typeInComposer(args.join(' '));
		await sleep(1500);
		console.log(await page.evaluate(snapshot));
		break;
	}
	case 'ask': {
		if (await page.locator('.active-walkthrough').isVisible().catch(() => false)) {
			await openFromFloatingMenu('Chat');
			await sleep(800);
		} else {
			await openChat();
		}
		const ask = page.locator('.composer-context button.mode', { hasText: 'Ask About' });
		if (await ask.count()) {
			await ask.click();
		}
		await typeInComposer(args.join(' '));
		for (let i = 0; i < 120; i++) {
			await sleep(1000);
			const done = await page.evaluate(() => {
				const last = [...document.querySelectorAll('.active-chat-transcript .entry.explainer')].pop();
				return last && !last.classList.contains('status-streaming');
			});
			if (done) {
				break;
			}
		}
		console.log(await page.evaluate(snapshot));
		break;
	}
	case 'wt': {
		const action = args[0];
		if (action === 'return') {
			await openChat();
			await page.click('text=Return to Walkthrough').catch(() => page.click('text=Play Walkthrough'));
		} else if (action === 'open-chat') {
			await openFromFloatingMenu('Chat');
		} else if (action === 'open-file') {
			await page.click('.active-explain-card .open-file');
		} else {
			await focusWalkthrough();
			const key = { play: 'k', pause: 'k', next: 'l', rewind: 'j' }[action];
			if (!key) {
				console.error(`unknown walkthrough action ${action}`);
				process.exit(2);
			}
			const playing = await page.evaluate(() => /Pause/.test(document.querySelector('.walkthrough-controls .primary')?.textContent ?? ''));
			if ((action === 'play' && playing) || (action === 'pause' && !playing)) {
				// already in the requested state
			} else {
				await page.keyboard.press(key);
			}
		}
		await sleep(1200);
		console.log(await page.evaluate(snapshot));
		break;
	}
	case 'wait': {
		const seconds = Math.min(Number(args[0] ?? 10), 540);
		const until = args[1];
		const deadline = Date.now() + seconds * 1000;
		while (Date.now() < deadline) {
			if (until && await page.evaluate(`(${states[until]})()`)) {
				break;
			}
			await sleep(1000);
		}
		console.log(await page.evaluate(snapshot));
		break;
	}
	case 'history':
		await showHistory();
		console.log(await page.evaluate(snapshot));
		break;
	case 'replay': {
		await showHistory();
		await page.locator('.active-history .turn', { hasText: `Turn ${args[0]} ` }).first().locator('button', { hasText: 'Replay' }).click();
		await sleep(2000);
		console.log(await page.evaluate(snapshot));
		break;
	}
	case 'click': {
		const label = args.join(' ');
		const candidates = [
			page.getByRole('menuitem', { name: label, exact: false }),
			page.getByRole('menuitemcheckbox', { name: label, exact: false }),
			page.getByRole('button', { name: label, exact: true }),
			page.locator('button, a, [role=button]').filter({ hasText: new RegExp(`^\\W*${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\W*$`) }),
			page.getByRole('option', { name: label, exact: false }),
			page.getByRole('tab', { name: label, exact: false }),
			page.getByRole('button', { name: label, exact: false }),
			page.getByTitle(label, { exact: false }),
			page.getByText(label, { exact: true }),
			page.getByText(label, { exact: false }),
		];
		let clicked = false;
		for (const locator of candidates) {
			const visible = locator.filter({ visible: true });
			if (await visible.count().catch(() => 0)) {
				await visible.first().click({ timeout: 5000 }).then(() => clicked = true).catch(() => undefined);
				if (clicked) {
					break;
				}
			}
		}
		if (!clicked) {
			console.error(`Nothing visible to click matching "${label}".`);
		}
		await sleep(1200);
		console.log(await page.evaluate(snapshot));
		break;
	}
	case 'type': {
		const enter = args.includes('--enter');
		await page.keyboard.type(args.filter(arg => arg !== '--enter').join(' '), { delay: 5 });
		if (enter) {
			await page.keyboard.press('Enter');
		}
		await sleep(1000);
		console.log(await page.evaluate(snapshot));
		break;
	}
	case 'key':
		await page.keyboard.press(args[0]);
		await sleep(1000);
		console.log(await page.evaluate(snapshot));
		break;
	case 'command': {
		await page.keyboard.press('Meta+Shift+KeyP');
		await page.waitForSelector('.quick-input-widget .quick-input-box input', { state: 'visible', timeout: 5000 });
		await page.keyboard.type(args.join(' '), { delay: 5 });
		await sleep(600);
		await page.keyboard.press('Enter');
		await sleep(1500);
		console.log(await page.evaluate(snapshot));
		break;
	}
	case 'setting': {
		const value = args.at(-1);
		const title = args.slice(0, -1).join(' ');
		const row = page.locator('.settings-editor .settings-tree-container .monaco-list-row').filter({ has: page.locator('.setting-item-label', { hasText: title }) }).first();
		if (!await row.count() && await page.locator('.settings-editor .settings-header .suggest-input-container').count()) {
			// Off-screen rows aren't rendered: search for the setting like a person would.
			await page.locator('.settings-editor .settings-header .suggest-input-container').first().click();
			await page.keyboard.press('Meta+KeyA');
			await page.keyboard.type(`@tag:active ${title}`, { delay: 5 });
			await sleep(1200);
		}
		if (!await row.count()) {
			console.error(`No visible setting titled "${title}". Search for it first (click the settings search box and type).`);
		} else {
			await row.scrollIntoViewIfNeeded();
			const select = row.locator('select');
			const input = row.locator('input[type=number], input[type=text], textarea');
			const checkbox = row.locator('.setting-value-checkbox');
			if (await select.count()) {
				await select.first().selectOption({ label: value }).catch(() => select.first().selectOption(value));
			} else if (await input.count()) {
				await input.first().click();
				await input.first().fill(value);
				await page.keyboard.press('Tab');
			} else if (await checkbox.count()) {
				const checked = await checkbox.first().evaluate(el => el.classList.contains('checked'));
				if (checked !== /^(on|true|yes)$/i.test(value)) {
					await checkbox.first().click();
				}
			} else {
				console.error('That setting has no editable control here.');
			}
		}
		await sleep(1200);
		console.log(await page.evaluate(snapshot));
		break;
	}
	default:
		console.error('usage: ui-driver.mjs <observe|shot|chat|ask|wt|wait|history|replay|click|type|key|command|setting> ...');
		process.exit(2);
}
await browser.close().catch(() => undefined);
process.exit(0);
