/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// End-to-end orchestration through the official @muse-code/sdk, against the
// scripted MSP test host (test-fixtures/scripted-muse-host.mjs). The host is a
// test double; this verifies Active's flow, not Muse Code's model behavior.

import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { chmodSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { MuseHost } from '../agents/museHost';
import { MuseProvider } from '../agents/providers';
import { ActiveController } from '../controller';
import { HistoryStore } from '../history/historyStore';
import { ActiveEvent, ChatEntry, DEFAULT_PROFILE, Walkthrough, WalkthroughStage } from '../shared/activeProtocol';
import { ChangeTracker } from '../tracking/changeTracker';
import { WorkspaceFiles } from '../tracking/workspaceFiles';

const repo = path.resolve(__dirname, '..', '..', '..', '..');
const host = path.join(repo, 'active', 'extension', 'test-fixtures', 'scripted-muse-host.mjs');

interface Harness {
	controller: ActiveController;
	events: ActiveEvent[];
	root: string;
	history: HistoryStore;
	waitFor<T extends ActiveEvent>(predicate: (event: ActiveEvent) => event is T, timeoutMs?: number): Promise<T>;
}

async function harness(backgroundTimeoutMs: number): Promise<Harness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'active-flow-'));
	await fs.cp(path.join(repo, 'demo', 'ledger-api'), root, { recursive: true });
	execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: root });
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'active-storage-'));
	const events: ActiveEvent[] = [];
	const waiters: Array<{ predicate: (event: ActiveEvent) => boolean; resolve: (event: ActiveEvent) => void }> = [];
	const files = new WorkspaceFiles(root);
	const tracker = new ChangeTracker(files);
	const history = new HistoryStore(path.join(storage, 'history'));
	let controller: ActiveController;
	let remembered: string | undefined;
	const emit = (event: ActiveEvent) => {
		events.push(event);
		for (const waiter of [...waiters]) {
			if (waiter.predicate(event)) {
				waiters.splice(waiters.indexOf(waiter), 1);
				waiter.resolve(event);
			}
		}
	};
	controller = new ActiveController({
		provider: { id: 'muse', name: 'Muse Code', shortName: 'Muse', devOnly: false },
		needsSetup: () => false,
		setupState: () => undefined,
		isAuthFailure: (kind, message) => new MuseProvider().isAuthFailure(kind, message),
		onAuthRequired: () => undefined,
		accountHint: async () => undefined,
		workspaceName: 'ledger-api',
		workspaceRoot: root,
		backgroundTimeoutMs: () => backgroundTimeoutMs,
		minMeaningfulLines: () => 8,
		draftQuietMs: () => 300,
		profile: () => ({ ...DEFAULT_PROFILE, configured: true }),
		emit,
		log: () => undefined,
		startCodingHost: () => MuseHost.spawn(host, root, () => undefined),
		runSettings: () => ({}),
		lastSessionId: () => remembered,
		rememberSession: sessionId => { remembered = sessionId; },
		startExplanationHost: () => MuseHost.spawn(host, root, () => undefined),
	}, tracker, history);
	// Stand in for the extension's file watcher: poll the workspace.
	const poll = setInterval(() => {
		void tracker.rescan().then(edits => {
			if (edits.length) {
				(controller as unknown as { afterEdits(edits: unknown[]): void }).afterEdits(edits);
			}
		});
	}, 100);
	after(() => clearInterval(poll));
	await controller.connect();
	return {
		controller, events, root, history,
		waitFor<T extends ActiveEvent>(predicate: (event: ActiveEvent) => event is T, timeoutMs = 20000): Promise<T> {
			return new Promise<T>((resolve, reject) => {
				const timer = setTimeout(() => reject(new Error('timed out waiting for event')), timeoutMs);
				waiters.push({ predicate, resolve: event => { clearTimeout(timer); resolve(event as T); } });
			});
		},
	};
}

const isStage = (stage: WalkthroughStage) => (event: ActiveEvent): event is Extract<ActiveEvent, { type: 'walkthroughStatus' }> => event.type === 'walkthroughStatus' && event.status.stage === stage;
const isReady = (event: ActiveEvent): event is Extract<ActiveEvent, { type: 'walkthroughReady' }> => event.type === 'walkthroughReady';

describe('Active flow (scripted MSP host via @muse-code/sdk)', () => {
	let h: Harness;

	before(async () => {
		chmodSync(host, 0o755);
		process.env.ACTIVE_SCRIPTED_SCENARIO = path.join(repo, 'demo', 'scenarios', 'ledger.json');
		process.env.ACTIVE_SCRIPTED_SPEED = '4';
		h = await harness(1500);
	});

	after(async () => {
		await h.controller.dispose();
	});

	test('a simple change produces a grounded walkthrough after the turn', async () => {
		const ready = h.waitFor(isReady);
		await h.controller.submitTask('Support minutes and hours in parseDuration');
		const { walkthrough } = await ready;
		assert.deepStrictEqual(walkthrough.scenes.map(scene => scene.id), ['problem', 'model', 'implementation', 'evidence']);
		assert.deepStrictEqual(Object.keys(walkthrough.files).sort(), ['src/duration.js', 'test/duration.test.js']);
		const implementation = walkthrough.scenes[2];
		const finalLines = walkthrough.files['src/duration.js'].final!.split('\n');
		assert.match(finalLines[implementation.focus[0].startLine - 1], /const match/);
		// The coding turn finished before the walkthrough was presented.
		const readyIndex = h.events.findIndex(event => event.type === 'walkthroughReady');
		const idleIndex = h.events.findIndex(event => event.type === 'agent' && event.agent.status === 'idle' && h.events.indexOf(event) > 2);
		assert.ok(idleIndex >= 0 && idleIndex < readyIndex);
		// It was planned from the agent's final answer, and the end of the turn reused that plan.
		const details = h.events.flatMap(event => event.type === 'walkthroughStatus' ? [event.status.detail] : []);
		assert.ok(details.some(detail => /while .* wraps up/.test(detail)), details.join(' | '));
	});

	test('reconnecting resumes the folder\'s last session and puts its chat back', async () => {
		const sessionId = h.controller.sessionIdForTest;
		const reset = h.waitFor((event): event is Extract<ActiveEvent, { type: 'chatReset' }> => event.type === 'chatReset');
		await h.controller.reconnect();
		const { chat } = await reset;
		assert.equal(h.controller.sessionIdForTest, sessionId);
		assert.ok(chat.some(entry => entry.role === 'user' && /parseDuration/.test(entry.text)), 'the earlier task is back in chat');
	});

	test('a tiny change is kept in history but not explained', async () => {
		const done = h.waitFor(isStage('notExplained'));
		await h.controller.submitTask('Fix the typo in the README');
		await done;
		await new Promise(resolve => setTimeout(resolve, 200));
		const turns = await h.history.list();
		assert.equal(turns[0].task, 'Fix the typo in the README');
		assert.equal(turns[0].walkthroughId, undefined);
		assert.deepStrictEqual(turns[0].files, [{ path: 'README.md', added: 1, removed: 1 }]);
	});

	test('a multi-file change waits for background checks up to the timeout and marks them pending', async () => {
		const waiting = h.waitFor(isStage('waitingForBackground'));
		const ready = h.waitFor(isReady, 30000);
		await h.controller.submitTask('Add client-side rate limiting to ApiClient');
		await waiting;
		const { walkthrough } = await ready;
		assert.deepStrictEqual(Object.keys(walkthrough.files).sort(), ['src/apiClient.js', 'src/rateLimiter.js', 'test/rateLimiter.test.js']);
		assert.deepStrictEqual(walkthrough.pending.map(check => check.label), ['npm test']);
		assert.deepStrictEqual(walkthrough.scenes.map(scene => scene.visual?.type ?? 'none'), ['diagram', 'equation', 'none', 'chart', 'diff', 'none']);
		const chart = walkthrough.scenes[3].visual;
		assert.equal(chart?.type === 'chart' && chart.source, 'illustrative');
		// Captured versions are immutable: editing the project afterwards does not change them.
		await fs.writeFile(path.join(h.root, 'src', 'rateLimiter.js'), '// rewritten later\n');
		const detail = await h.history.get(walkthrough.turnId);
		assert.match(detail!.walkthrough!.files['src/rateLimiter.js'].final!, /class RateLimiter/);
		assert.equal(detail!.walkthrough!.scenes.length, 6);
	});

	test('a pending check updates when its background task finishes, and history records it', async () => {
		const turns = await h.history.list();
		const walkthroughId = turns[0].walkthroughId!;
		const update = h.events.find(event => event.type === 'checkUpdate') as Extract<ActiveEvent, { type: 'checkUpdate' }> | undefined
			?? await h.waitFor((event): event is Extract<ActiveEvent, { type: 'checkUpdate' }> => event.type === 'checkUpdate', 30000);
		assert.deepStrictEqual([update.walkthroughId, update.check.label, update.check.state], [walkthroughId, 'npm test', 'finished']);
		await new Promise(resolve => setTimeout(resolve, 100));
		const detail = await h.history.get(turns[0].turnId);
		assert.deepStrictEqual(detail!.walkthrough!.pending.map(check => check.state), ['finished']);
	});

	test('the explanation session refuses to start without the read-only profile', async () => {
		const strict = await MuseHost.spawn(host, h.root, () => undefined, { ACTIVE_SCRIPTED_NO_READ_ONLY: '1' });
		try {
			await assert.rejects(strict.startSession({ workspaceRoot: h.root, readOnly: true, listener: {} }), /read-only permission profile/);
		} finally {
			await strict.dispose();
		}
	});

	test('"more detail" streams a deeper explanation of one scene', async () => {
		const turns = await h.history.list();
		const done = h.waitFor((event): event is Extract<ActiveEvent, { type: 'elaboration' }> => event.type === 'elaboration' && event.status === 'done');
		await h.controller.elaborate({ requestId: 'r1', walkthroughId: turns[0].walkthroughId!, sceneId: 'model' });
		const { text, requestId } = await done as Extract<ActiveEvent, { type: 'elaboration' }>;
		assert.equal(requestId, 'r1');
		assert.match(text, /slow down on/);
	});

	test('questions about a walkthrough go to the read-only explanation session', async () => {
		const turns = await h.history.list();
		const walkthrough = (await h.history.get(turns[0].turnId))!.walkthrough as Walkthrough;
		const answered = h.waitFor((event): event is Extract<ActiveEvent, { type: 'chat' }> => event.type === 'chat' && event.entry.role === 'explainer' && event.entry.status === 'done');
		await h.controller.ask({ question: 'Why does refill not need a timer?', walkthroughId: walkthrough.id, sceneId: 'model' });
		const { entry } = await answered as { entry: ChatEntry };
		assert.match(entry.text, /never needs a timer/);
		// The explanation session is read-only, so the project is untouched by it.
		assert.equal(await fs.readFile(path.join(h.root, 'src', 'rateLimiter.js'), 'utf8'), '// rewritten later\n');
	});
});
