/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// The agent setup flow, against stand-ins: a fake installer and a fake
// interactive agent app (test-fixtures/fake-agent-tui.mjs) driven through a
// real pseudo-terminal by resources/agent_signin.py.

import assert from 'node:assert/strict';
import { chmodSync, existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { MuseProvider } from '../agents/providers';
import { AgentSetup, SecretStore } from '../setup/agentSetup';
import type { SetupState } from '../shared/activeProtocol';

const extensionRoot = path.resolve(__dirname, '..', '..');
const fakeTui = path.join(extensionRoot, 'test-fixtures', 'fake-agent-tui.mjs');
const python = ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3'].find(candidate => existsSync(candidate));

class MemorySecrets implements SecretStore {
	readonly values = new Map<string, string>();
	async get(key: string) { return this.values.get(key); }
	async store(key: string, value: string) { this.values.set(key, value); }
	async delete(key: string) { this.values.delete(key); }
}

class MenuMuseProvider extends MuseProvider {
	override readonly browserSignIn = { mode: 'menu' as const, args: [] };
}

async function harness(binDir: string, installCommand?: string, provider: MuseProvider = new MuseProvider()) {
	chmodSync(fakeTui, 0o755);
	const states: Array<SetupState | undefined> = [];
	let ready = 0;
	const secrets = new MemorySecrets();
	const setup = new AgentSetup(provider, {
		platform: process.platform,
		configuredPath: () => path.join(binDir, 'muse'),
		secrets,
		signInScript: path.join(extensionRoot, 'resources', 'agent_signin.py'),
		python: () => python,
		scratchDir: await fs.mkdtemp(path.join(os.tmpdir(), 'active-signin-')),
		installerOverride: installCommand ? () => ({ display: installCommand, command: '/bin/sh', args: ['-c', installCommand] }) : undefined,
		emit: state => states.push(state),
		onReady: async () => { ready++; },
		log: () => undefined,
	});
	const until = async (predicate: () => boolean, ms = 15000) => {
		const deadline = Date.now() + ms;
		while (!predicate()) {
			if (Date.now() > deadline) {
				throw new Error(`timed out; last state: ${JSON.stringify(setup.current)}`);
			}
			await new Promise(resolve => setTimeout(resolve, 50));
		}
	};
	return { setup, states, secrets, ready: () => ready, until };
}

describe('agent setup', () => {
	test('installs, then asks how to sign in', async () => {
		const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-bin-'));
		const h = await harness(binDir, `echo "Downloading muse"; sleep 0.2; cp "${fakeTui}" "${binDir}/muse"; chmod +x "${binDir}/muse"; echo "Installed muse to ${binDir}"`);
		assert.equal(h.setup.evaluate(), true);
		assert.equal(h.setup.current?.step, 'install');
		await h.setup.install();
		assert.deepStrictEqual(
			[h.setup.current?.step, h.setup.current?.install.status, h.setup.current?.methods.map(method => method.id)],
			['chooseMethod', 'done', ['subscription', 'apiKey']],
		);
		assert.ok(h.states.some(state => state?.install.line === 'Downloading muse'));
	});

	test('reports a failed install with its last output', async () => {
		const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-bin-'));
		const h = await harness(binDir, 'echo "curl: (6) Could not resolve host"; exit 6');
		h.setup.evaluate();
		await h.setup.install();
		assert.equal(h.setup.current?.install.status, 'failed');
		assert.match(h.setup.current?.install.error ?? '', /Could not resolve host/);
	});

	test('signs in with the browser through the hidden terminal', { skip: !python }, async () => {
		const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-bin-'));
		await fs.copyFile(fakeTui, path.join(binDir, 'muse'));
		chmodSync(path.join(binDir, 'muse'), 0o755);
		const h = await harness(binDir);
		h.setup.requireSignIn('authRequired');
		h.setup.chooseMethod('subscription');
		await h.setup.signInWithBrowser();
		await h.until(() => h.ready() === 1);
		assert.equal(h.setup.current, undefined);
		assert.ok(h.states.some(state => state?.signIn.status === 'waitingForBrowser'));
		assert.ok(h.states.some(state => state?.signIn.url === 'https://auth.meta.com/oauth/device/?code=TEST-1234'));
		assert.ok(h.states.some(state => state?.signIn.code === 'TEST-1234'));
	});

	test('can also drive sign-in through the interactive app menu', { skip: !python }, async () => {
		const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-bin-'));
		await fs.copyFile(fakeTui, path.join(binDir, 'muse'));
		chmodSync(path.join(binDir, 'muse'), 0o755);
		const h = await harness(binDir, undefined, new MenuMuseProvider());
		h.setup.requireSignIn();
		h.setup.chooseMethod('subscription');
		await h.setup.signInWithBrowser();
		await h.until(() => h.ready() === 1);
		assert.ok(h.states.some(state => state?.signIn.code === 'TEST-1234'));
	});

	test('reports a sign-in the user did not approve', { skip: !python }, async () => {
		const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-bin-'));
		await fs.writeFile(path.join(binDir, 'muse'), `#!/bin/sh\nFAKE_TUI_OUTCOME=deny exec node "${fakeTui}" "$@"\n`);
		chmodSync(path.join(binDir, 'muse'), 0o755);
		const h = await harness(binDir);
		h.setup.requireSignIn();
		h.setup.chooseMethod('subscription');
		await h.setup.signInWithBrowser();
		await h.until(() => h.setup.current?.signIn.status === 'failed');
		assert.equal(h.ready(), 0);
	});

	test('stores an API key in the keychain and hands it to the agent', async () => {
		const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-bin-'));
		await fs.copyFile(fakeTui, path.join(binDir, 'muse'));
		const h = await harness(binDir);
		h.setup.requireSignIn();
		h.setup.chooseMethod('apiKey');
		await h.setup.saveApiKey('  mk-test-123  ');
		await h.until(() => h.ready() === 1);
		assert.deepStrictEqual(await h.setup.agentEnv(), { META_API_KEY: 'mk-test-123' });
		// Choosing the subscription later drops the key so it can't override the browser session.
		h.setup.requireSignIn();
		h.setup.chooseMethod('subscription');
		await h.until(() => h.secrets.values.size === 0);
	});

	test('shows sign-in before the first task when the agent has no credentials', async () => {
		const binDir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-bin-'));
		await fs.writeFile(path.join(binDir, 'muse'), '#!/bin/sh\necho "muse usage: not logged in: run \\`muse login\\` first"\n');
		chmodSync(path.join(binDir, 'muse'), 0o755);
		const saved = process.env.META_API_KEY;
		delete process.env.META_API_KEY;
		try {
			const h = await harness(binDir);
			await h.setup.checkSignedIn();
			assert.equal(h.setup.current?.step, 'chooseMethod');
		} finally {
			if (saved !== undefined) {
				process.env.META_API_KEY = saved;
			}
		}
	});

	test('recognizes authentication failures', () => {
		const provider = new MuseProvider();
		assert.deepStrictEqual([provider.isAuthFailure('authRequired', undefined), provider.isAuthFailure('modelError', 'rate limited')], [true, false]);
	});
});
