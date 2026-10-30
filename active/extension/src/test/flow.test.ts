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
import { ExplainerMemory } from '../explain/memory';
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
	memory: ExplainerMemory;
	waitFor<T extends ActiveEvent>(predicate: (event: ActiveEvent) => event is T, timeoutMs?: number): Promise<T>;
}

async function harness(backgroundTimeoutMs: number, timing: { checkpointMs: number; chapterMs: number; explanations?: boolean } = { checkpointMs: 5 * 60_000, chapterMs: 10 * 60_000 }, hostEnv: Record<string, string> = {}): Promise<Harness> {
	const root = await fs.mkdtemp(path.join(os.tmpdir(), 'active-flow-'));
	await fs.cp(path.join(repo, 'demo', 'ledger-api'), root, { recursive: true });
	execSync('git init -q && git add -A && git -c user.email=t@t -c user.name=t commit -qm init', { cwd: root });
	const storage = await fs.mkdtemp(path.join(os.tmpdir(), 'active-storage-'));
	const events: ActiveEvent[] = [];
	const waiters: Array<{ predicate: (event: ActiveEvent) => boolean; resolve: (event: ActiveEvent) => void }> = [];
	const files = new WorkspaceFiles(root);
	const tracker = new ChangeTracker(files);
	const history = new HistoryStore(path.join(storage, 'history'));
	const memory = new ExplainerMemory({ personal: path.join(storage, 'memory-personal.json'), project: path.join(storage, 'memory-project.json') });
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
		checkpointMs: () => timing.checkpointMs,
		chapterMs: () => timing.chapterMs,
		preferNotes: () => true,
		memory,
		explanationsEnabled: () => timing.explanations !== false,
		profile: () => ({ ...DEFAULT_PROFILE, configured: true }),
		emit,
		log: line => process.env.FLOW_DEBUG && console.error(`[flow] ${line}`),
		startCodingHost: () => MuseHost.spawn(host, root, () => undefined, hostEnv),
		runSettings: () => ({}),
		lastSessionId: () => remembered,
		rememberSession: sessionId => { remembered = sessionId; },
		startExplanationHost: () => MuseHost.spawn(host, root, () => undefined, hostEnv),
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
		controller, events, root, history, memory,
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

describe('explanations off (scripted MSP host)', () => {
	let h: Harness;

	before(async () => {
		process.env.ACTIVE_SCRIPTED_SCENARIO = path.join(repo, 'demo', 'scenarios', 'ledger.json');
		process.env.ACTIVE_SCRIPTED_SPEED = '4';
		h = await harness(1500, { checkpointMs: 0, chapterMs: 0, explanations: false }, { ACTIVE_SCRIPTED_CHAPTERS: '1' });
	});

	after(async () => {
		await h.controller.dispose();
	});

	test('the "off" mode saves the turn to history without asking the explanation model', async () => {
		const done = h.waitFor(isStage('notExplained'));
		await h.controller.submitTask('Support minutes and hours in parseDuration');
		const { status } = await done;
		assert.equal(status.detail, 'Explanations are off. Saved to history.');
		assert.equal(h.events.some(event => event.type === 'walkthroughReady' || (event.type === 'walkthroughStatus' && event.status.stage === 'drafting')), false);
		await new Promise(resolve => setTimeout(resolve, 200));
		assert.equal((await h.history.list())[0].task, 'Support minutes and hours in parseDuration');
	});

	test('with explanations off, memory is never condensed (the explanation model isn\'t used)', async () => {
		await h.memory.add(Array.from({ length: 30 }, (_, index) => ({ scope: 'project' as const, note: `fact ${index} ${'x'.repeat(260)}` })));
		await h.controller.condenseMemory();
		assert.equal((await h.memory.list()).length, 30);
	});
});

describe('chapters (scripted MSP host)', () => {
	let h: Harness;

	before(async () => {
		process.env.ACTIVE_SCRIPTED_SCENARIO = path.join(repo, 'demo', 'scenarios', 'ledger.json');
		process.env.ACTIVE_SCRIPTED_SPEED = '4';
		// No minimum spacing, and an explainer that says "chapter" at the first checkpoint.
		h = await harness(1500, { checkpointMs: 0, chapterMs: 0 }, { ACTIVE_SCRIPTED_CHAPTERS: '1', ACTIVE_SCRIPTED_PAUSE_BEFORE_FINAL_MS: '1500' });
	});

	after(async () => {
		await h.controller.dispose();
	});

	test('finished work is explained as a chapter while the agent is still working', async () => {
		const chapter = h.waitFor(isReady);
		const ended = h.waitFor((event): event is Extract<ActiveEvent, { type: 'walkthroughStatus' }> => event.type === 'walkthroughStatus' && /Explained in 1 chapter/.test(event.status.detail));
		await h.controller.submitTask('Support minutes and hours in parseDuration');
		const { walkthrough } = await chapter;
		assert.equal(walkthrough.chapter, 1);
		// Nothing changed after the chapter, so the end of the turn adds no second explanation.
		await ended;
		// The chapter was started at a checkpoint (the test run), while the agent was still working.
		const chapterStarted = h.events.findIndex(event => event.type === 'walkthroughStatus' && /Writing chapter 1 while/.test(event.status.detail));
		const finalMessage = h.events.findIndex(event => event.type === 'chat' && event.entry.role === 'agent' && /now accepts/.test(event.entry.text) && event.entry.status === 'done');
		assert.ok(chapterStarted >= 0 && chapterStarted < finalMessage, `chapter started at event ${chapterStarted}, final message at ${finalMessage}`);
		assert.equal(h.events.filter(event => event.type === 'walkthroughReady').length, 1);
		const turns = await h.history.list();
		assert.ok(turns.some(turn => turn.walkthroughId === walkthrough.id && turn.explanationNote.startsWith('Chapter 1')));
	});
});

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
		// What the explainer asked to remember is saved once, with where it came from.
		const notes = await h.memory.list();
		assert.deepStrictEqual(notes.map(note => [note.scope, note.source, note.context]).sort(), [['personal', 'explainer', walkthrough.title], ['project', 'explainer', walkthrough.title]]);
		assert.ok(h.events.some(event => event.type === 'memory'));
	});

	test('the Explorer\'s "last prompt" counts stay until a prompt changes something', async () => {
		const counts = (await h.controller.initialState()).turnChanges;
		assert.deepStrictEqual(counts.map(file => file.path).sort(), ['src/duration.js', 'test/duration.test.js']);
		const from = h.events.length;
		const done = h.waitFor(isStage('notExplained'));
		await h.controller.submitTask('Just answer: what does this project do?');
		await done;
		// No empty update at the start or end of a prompt that changed nothing...
		assert.equal(h.events.slice(from).some(event => event.type === 'turnChanges'), false);
		// ...and a reload still shows the last prompt that did change files.
		assert.deepStrictEqual((await h.controller.initialState()).turnChanges, counts);
		// The editor's "Agent" change bars diff against the files as they were before that prompt.
		const original = await fs.readFile(path.join(repo, 'demo', 'ledger-api', 'src', 'duration.js'), 'utf8');
		assert.deepStrictEqual(
			[await h.controller.agentBaseline('src/duration.js'), await h.controller.agentBaseline('README.md')],
			[{ baseline: original }, undefined],
		);
	});

	test('reconnecting resumes the folder\'s last session and puts its chat back', async () => {
		const sessionId = h.controller.sessionIdForTest;
		const reset = h.waitFor((event): event is Extract<ActiveEvent, { type: 'chatReset' }> => event.type === 'chatReset');
		await h.controller.reconnect();
		const { chat } = await reset;
		assert.equal(h.controller.sessionIdForTest, sessionId);
		assert.ok(chat.some(entry => entry.role === 'user' && /parseDuration/.test(entry.text)), 'the earlier task is back in chat');
	});

	test('a tiny change gets a short note in chat instead of a walkthrough', async () => {
		const done = h.waitFor(isStage('notExplained'));
		await h.controller.submitTask('Fix the typo in the README');
		const { status } = await done;
		assert.equal(status.detail, 'Explained in a short note.');
		const note = h.events.find(event => event.type === 'chat' && event.entry.role === 'explainer' && /README wording/.test(event.entry.text));
		assert.ok(note && note.type === 'chat');
		// The note never pops up as a walkthrough...
		assert.ok(!h.events.some(event => event.type === 'walkthroughReady' && event.walkthrough.task === 'Fix the typo in the README'));
		await new Promise(resolve => setTimeout(resolve, 200));
		const turns = await h.history.list();
		assert.equal(turns[0].task, 'Fix the typo in the README');
		assert.deepStrictEqual(turns[0].files, [{ path: 'README.md', added: 1, removed: 1 }]);
		// ...but its inline version (one scene at the change) is saved with the turn and linked from chat.
		assert.equal(note.entry.recordId, turns[0].turnId);
		const inline = (await h.history.get(turns[0].turnId))?.walkthrough;
		assert.equal(inline?.note, true);
		assert.equal(turns[0].walkthroughId, inline?.id);
		assert.equal(turns[0].walkthroughIsNote, true);
		assert.equal(inline?.scenes.length, 1);
		assert.equal(inline?.scenes[0].file, 'README.md');
		assert.match(inline!.scenes[0].narration.map(segment => segment.text).join(' '), /README wording/);
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

	test('the return briefing condenses what happened since a time', async () => {
		const briefing = await h.controller.brief({ since: 0 });
		assert.equal(briefing.fallback, undefined);
		assert.match(briefing.headline, /tasks finished while you were away/);
		assert.ok(briefing.done.some(line => /parseDuration/.test(line)), briefing.done.join(' | '));
		// Nothing since now: a plain briefing, without asking the model.
		assert.deepStrictEqual((await h.controller.brief({ since: Date.now() + 1000 })).headline, 'Nothing new while you were away');
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

	test('a question asked from a walkthrough card is answered beside the scene, not in chat', async () => {
		const turns = await h.history.list();
		const walkthroughId = turns.find(turn => turn.walkthroughId && !turn.walkthroughId.includes('-c'))!.walkthroughId!;
		const chatBefore = h.events.filter(event => event.type === 'chat').length;
		const done = h.waitFor((event): event is Extract<ActiveEvent, { type: 'elaboration' }> => event.type === 'elaboration' && event.requestId === 'q1' && event.status === 'done');
		await h.controller.elaborate({ requestId: 'q1', walkthroughId, sceneId: 'model', question: 'Why does refill not need a timer?' });
		const { text } = await done as Extract<ActiveEvent, { type: 'elaboration' }>;
		assert.match(text, /never needs a timer/);
		// The question is remembered (by Active, not the model) so later explanations know they asked.
		assert.ok((await h.memory.list()).some(note => note.source === 'question' && /Why does refill not need a timer\?/.test(note.text)));
		assert.equal(h.events.filter(event => event.type === 'chat').length, chatBefore);
	});

	test('when memory grows too long, the explainer condenses it and the condensed notes replace the old ones', async () => {
		await h.memory.add(Array.from({ length: 25 }, (_, index) => ({ scope: 'project' as const, note: `project fact ${index} ${'x'.repeat(260)}` })));
		const before = (await h.memory.list()).length;
		assert.equal(await h.memory.needsCondensing(), true);
		await h.controller.condenseMemory();
		const notes = await h.memory.list();
		assert.deepStrictEqual(notes.map(note => note.text).sort(), ['Condensed 1 personal notes.', `Condensed ${before - 1} project notes.`]);
		assert.equal(await h.memory.needsCondensing(), false);
		assert.ok(h.events.some(event => event.type === 'memory' && event.notes.length === 2));
	});

	test('"more detail" on a walkthrough that is gone reports an error instead of hanging', async () => {
		const failed = h.waitFor((event): event is Extract<ActiveEvent, { type: 'elaboration' }> => event.type === 'elaboration' && event.requestId === 'gone' && event.status === 'error');
		await h.controller.elaborate({ requestId: 'gone', walkthroughId: 'wt-missing', sceneId: 'model' });
		const { text } = await failed as Extract<ActiveEvent, { type: 'elaboration' }>;
		assert.match(text, /no longer in history/);
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
