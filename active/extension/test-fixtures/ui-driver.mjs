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
	const history = q('.active-history');
	if (history && history.offsetParent) {
		out.push('', '== HISTORY ==', ...qa('.active-history .turn').map(turn => `- ${text(turn).replace(/\n/g, ' | ')}`));
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
			await page.click('.walkthrough-controls .open-chat');
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
			await page.click('.walkthrough-controls .open-chat');
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
		await page.click(".activitybar [aria-label^='History']");
		await sleep(800);
		console.log(await page.evaluate(snapshot));
		break;
	case 'replay': {
		await page.click(".activitybar [aria-label^='History']");
		await sleep(800);
		await page.locator('.active-history .turn', { hasText: `Turn ${args[0]} ` }).first().locator('button', { hasText: 'Replay' }).click();
		await sleep(2000);
		console.log(await page.evaluate(snapshot));
		break;
	}
	default:
		console.error('usage: ui-driver.mjs <observe|shot|chat|ask|wt|wait|history|replay> ...');
		process.exit(2);
}
await browser.close().catch(() => undefined);
process.exit(0);
