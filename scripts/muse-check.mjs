#!/usr/bin/env node
// Checks real Muse Code outside Active, through Active's own MuseHost:
//   1. sign-in state and plan usage (offers to sign in when signed out),
//   2. one tiny coding turn in a throwaway project (should create a file),
//   3. one read-only turn there (should NOT be able to create a file),
//   4. plan usage afterwards, so you can see what the turns drew from.
//
// Usage: node scripts/muse-check.mjs [--only-auth] [--skip-coding] [--skip-read-only] [--dry-run]
//   --dry-run uses Muse's offline echo provider to check the plumbing without signing in.
//   MUSE_CHECK_VERBOSE=1 prints muse serve's own log.
// Needs the extension compiled once: (cd active/extension && npm run compile)

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOST_JS = path.join(ROOT, 'active/extension/out/agents/museHost.js');
const TURN_TIMEOUT_MS = 4 * 60 * 1000;
const args = new Set(process.argv.slice(2));

const bold = text => `\x1b[1m${text}\x1b[0m`;
const dim = text => `\x1b[2m${text}\x1b[0m`;
const pass = text => console.log(`\x1b[32m✔\x1b[0m ${text}`);
const fail = text => console.log(`\x1b[31m✘\x1b[0m ${text}`);
const note = text => console.log(`  ${dim(text)}`);

function findMuse() {
	for (const candidate of [process.env.ACTIVE_MUSE_BIN, path.join(os.homedir(), '.local/bin/muse')]) {
		if (candidate && existsSync(candidate)) {
			return candidate;
		}
	}
	const found = spawnSync('which', ['muse'], { encoding: 'utf8' }).stdout.trim();
	return found || undefined;
}

/** --dry-run: a wrapper whose `serve` uses Muse's offline echo provider (no sign-in, no credits). */
function echoWrapper(muse) {
	const wrapper = path.join(mkdtempSync(path.join(os.tmpdir(), 'active-muse-echo-')), 'muse');
	writeFileSync(wrapper, `#!/bin/bash\ncase "$1" in\n  usage) echo '{"dryRun":true}';;\n  serve) shift; exec "${muse}" serve --provider echo "$@";;\n  *) exec "${muse}" "$@";;\nesac\n`, { mode: 0o755 });
	return wrapper;
}

/** `muse usage --json`: the plan allowance, or why it isn't available. */
function readUsage(muse) {
	const run = spawnSync(muse, ['usage', '--json'], { encoding: 'utf8', timeout: 30000 });
	const raw = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim() || String(run.error?.message ?? '');
	if (/not logged in/i.test(raw)) {
		return { signedIn: false, raw };
	}
	try {
		return { signedIn: true, raw, json: JSON.parse(run.stdout) };
	} catch {
		return { signedIn: run.status === 0, raw };
	}
}

function printUsage(usage) {
	if (usage.json) {
		console.log(dim(JSON.stringify(usage.json, null, 2).split('\n').map(line => `  ${line}`).join('\n')));
	} else {
		note(usage.raw);
	}
}

function credentialSource() {
	if (process.env.META_API_KEY) {
		return 'META_API_KEY from the environment (pay as you go; this beats any browser sign-in)';
	}
	return 'stored credentials (browser sign-in or a stored API key)';
}

async function ensureSignedIn(muse) {
	let usage = readUsage(muse);
	if (usage.signedIn) {
		return usage;
	}
	fail('Muse Code is not signed in.');
	const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
	const answer = (await rl.question('Sign in now? [b] browser (muse login)  [k] paste an API key  [q] quit: ')).trim().toLowerCase();
	rl.close();
	if (answer === 'b') {
		spawnSync(muse, ['login'], { stdio: 'inherit' });
	} else if (answer === 'k') {
		console.log('Paste the key, then press Enter and Ctrl-D:');
		spawnSync(muse, ['auth', 'set', '--api-key-stdin'], { stdio: 'inherit' });
	} else {
		process.exit(1);
	}
	usage = readUsage(muse);
	if (!usage.signedIn) {
		fail('Still not signed in.');
		note(usage.raw);
		process.exit(1);
	}
	return usage;
}

/** Runs one turn and resolves with what happened. */
function runTurn(session, listener, prompt) {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no turn/completed within ${TURN_TIMEOUT_MS / 1000}s`)), TURN_TIMEOUT_MS);
		listener.done = result => {
			clearTimeout(timer);
			resolve(result);
		};
		session.startTurn(prompt).catch(error => {
			clearTimeout(timer);
			reject(error);
		});
	});
}

function makeListener(label, getSession) {
	const listener = {
		messages: [],
		tools: [],
		approvals: [],
		onItem(item, completed) {
			if (!completed) {
				return;
			}
			if (item.kind === 'agentMessage' && item.text) {
				listener.messages.push(item.text);
			} else if (item.kind === 'toolCall') {
				listener.tools.push(`${item.tool ?? 'tool'} → ${item.status}${item.failureReason ? ` (${item.failureReason})` : ''}`);
			}
		},
		onApproval(approval) {
			// Only the coding session reaches here; the read-only session denies on its own.
			const allow = approval.choices.find(choice => choice.approves);
			listener.approvals.push(`${approval.title}: ${approval.detail} → ${allow ? `approved (${allow.label})` : 'no approving choice'}`);
			if (allow) {
				void getSession().decideApproval(approval.approvalId, allow.choiceId);
			}
		},
		onApprovalResolved(approvalId, decision) {
			listener.approvals.push(`${approvalId} resolved: ${decision}`);
		},
		onTurnCompleted(_turnId, terminal, error, errorKind) {
			listener.done?.({ terminal, error, errorKind });
		},
	};
	listener.label = label;
	return listener;
}

function report(listener, result) {
	note(`turn ${result.terminal}${result.errorKind ? ` [${result.errorKind}]` : ''}${result.error ? `: ${result.error}` : ''}`);
	for (const tool of listener.tools) {
		note(`tool: ${tool}`);
	}
	for (const approval of listener.approvals) {
		note(`approval: ${approval}`);
	}
	const reply = listener.messages.at(-1);
	if (reply) {
		note(`reply: ${reply.replace(/\s+/g, ' ').slice(0, 300)}`);
	}
}

async function main() {
	const installed = findMuse();
	if (!installed) {
		fail('Muse Code is not installed (looked for ~/.local/bin/muse and PATH).');
		process.exit(1);
	}
	const dryRun = args.has('--dry-run');
	const muse = dryRun ? echoWrapper(installed) : installed;
	console.log(bold(`Muse: ${execFileSync(installed, ['--version'], { encoding: 'utf8' }).trim()}`));
	note(dryRun ? 'dry run: offline echo provider, so the model only repeats prompts and never writes' : `credentials: ${credentialSource()}`);

	console.log(bold('\n1. Sign-in and plan usage (before)'));
	const before = await ensureSignedIn(muse);
	pass('Signed in.');
	printUsage(before);
	if (args.has('--only-auth')) {
		return;
	}

	if (!existsSync(HOST_JS)) {
		fail(`Active's extension isn't compiled (${path.relative(ROOT, HOST_JS)} missing). Run: (cd active/extension && npm run compile)`);
		process.exit(1);
	}
	const { MuseHost } = createRequire(import.meta.url)(HOST_JS);
	const project = mkdtempSync(path.join(os.tmpdir(), 'active-muse-check-'));
	writeFileSync(path.join(project, 'README.md'), '# Muse check\n\nA throwaway project for scripts/muse-check.mjs.\n');
	spawnSync('git', ['init', '-q'], { cwd: project });
	note(`throwaway project: ${project}`);
	const log = line => process.env.MUSE_CHECK_VERBOSE && console.log(dim(`  [muse] ${line}`));
	let failures = 0;

	if (!args.has('--skip-coding')) {
		console.log(bold('\n2. Coding turn (normal session, should write a file)'));
		const host = await MuseHost.spawn(muse, project, log);
		try {
			let session;
			const listener = makeListener('coding', () => session);
			session = await host.startSession({ workspaceRoot: project, listener });
			const started = Date.now();
			const result = await runTurn(session, listener, 'Create a file named hello.txt containing exactly the text "hi from Active" and nothing else. Do not do anything else.');
			report(listener, result);
			note(`took ${((Date.now() - started) / 1000).toFixed(1)}s`);
			if (existsSync(path.join(project, 'hello.txt'))) {
				pass('The coding session created hello.txt.');
			} else {
				failures++;
				fail('The coding session did not create hello.txt.');
			}
			const tier = await session.accountSummary().catch(() => undefined);
			note(`usage/read tier: ${tier ?? 'not reported'}`);
		} finally {
			await host.dispose();
		}
	}

	if (!args.has('--skip-read-only')) {
		console.log(bold('\n3. Read-only turn (explanation session, should NOT write)'));
		const host = await MuseHost.spawn(muse, project, log);
		try {
			let session;
			const listener = makeListener('read-only', () => session);
			session = await host.startSession({ workspaceRoot: project, listener, readOnly: true });
			pass('Muse accepted the :read-only permission profile.');
			const result = await runTurn(session, listener, 'Create a file named blocked.txt containing the text "x". If you cannot, say exactly why in one sentence.');
			report(listener, result);
			if (existsSync(path.join(project, 'blocked.txt'))) {
				failures++;
				fail('blocked.txt EXISTS: the read-only session was able to write.');
			} else if (listener.tools.length === 0) {
				note('Inconclusive: blocked.txt was not created, but the model never tried a tool.');
			} else {
				pass('blocked.txt was not created even though the model tried: read-only held.');
			}
		} finally {
			await host.dispose();
		}
	}

	console.log(bold('\n4. Plan usage (after)'));
	printUsage(readUsage(muse));
	note('If a plan percentage went up, the turns used your subscription. If it didn\'t (or no plan is shown),');
	note('check the billing page on dev.meta.ai: pay-as-you-go spend or "free credits in use" should have moved.');
	process.exitCode = failures ? 1 : 0;
}

main().catch(error => {
	fail(error instanceof Error ? error.message : String(error));
	process.exit(1);
});
