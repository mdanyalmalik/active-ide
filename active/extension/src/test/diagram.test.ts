/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import { DiagramAgent, DiagramSnapshot, describeChanges, structuralSignals } from '../diagram/diagramAgent';
import { buildMapQuestionPrompt } from '../explain/prompts';
import { DEFAULT_PROFILE, DiagramState, parseSystemMap, SystemMap } from '../shared/activeProtocol';

const FILES = new Set(['src/api.ts', 'src/store.ts', 'src/cli.ts', 'test/api.test.ts']);

const MAP: SystemMap = {
	overview: 'A CLI over an API client and a store.',
	components: [
		{ id: 'cli', name: 'CLI', summary: 'Entry point', description: 'Parses arguments.', files: [{ path: 'src/cli.ts' }] },
		{ id: 'api', name: 'API client', summary: 'Talks HTTP', description: 'Calls the service.', files: [{ path: 'src/api.ts', startLine: 1, endLine: 30 }] },
		{ id: 'store', name: 'Store', summary: 'Keeps state', description: 'Saves results.', files: [{ path: 'src/store.ts' }] },
	],
	connections: [
		{ from: 'cli', to: 'api', label: 'requests', evidence: [{ path: 'src/cli.ts', startLine: 3, endLine: 3 }] },
		{ from: 'api', to: 'store', label: 'saves', evidence: [] },
	],
};

describe('System map validation', () => {
	test('a good map passes untouched', () => {
		const errors: string[] = [];
		assert.deepStrictEqual(parseSystemMap(MAP, file => FILES.has(file), errors), MAP);
		assert.deepStrictEqual(errors, []);
	});

	test('missing files, unknown endpoints, duplicates and self-links are reported; the rest is kept', () => {
		const errors: string[] = [];
		const map = parseSystemMap({
			overview: 'x',
			components: [
				{ id: 'cli', name: 'CLI', files: ['./src/cli.ts'] },
				{ id: 'cli', name: 'Again', files: ['src/api.ts'] },
				{ id: 'ghost', name: 'Ghost', files: ['src/nowhere.ts'] },
				{ id: 'bad id!', name: 'Bad', files: ['src/api.ts'] },
				{ id: 'api', name: 'API', files: [{ path: 'src/api.ts', startLine: 5, endLine: 2 }] },
			],
			connections: [
				{ from: 'cli', to: 'api', label: 'calls' },
				{ from: 'cli', to: 'api', label: 'again' },
				{ from: 'cli', to: 'ghost', label: 'nope' },
				{ from: 'api', to: 'api', label: 'self' },
			],
		}, file => FILES.has(file), errors);
		assert.deepStrictEqual({ components: map?.components.map(component => [component.id, component.files]), connections: map?.connections.map(connection => `${connection.from}>${connection.to}`), errors: errors.length }, {
			components: [['cli', [{ path: 'src/cli.ts' }]], ['api', [{ path: 'src/api.ts', startLine: 5, endLine: 5 }]]],
			connections: ['cli>api'],
			errors: 7,
		});
	});
});

describe('Diagram agent: when a change could alter the map', () => {
	const snapshot = (changes: DiagramSnapshot['changes']): DiagramSnapshot => ({ turnId: 't', turnIndex: 1, task: 'x', changes, progress: [], final: true });

	test('an edit inside a component, with no new dependencies, does not', () => {
		const changes = describeChanges(snapshot([{ path: 'src/api.ts', added: 3, removed: 1, baseline: 'import a from "./a";\nconst x = 1;', final: 'import a from "./a";\nconst x = 2;\nconst y = 3;' }]));
		assert.strictEqual(structuralSignals(MAP, changes), false);
	});

	test('a new import, a new file, a deleted file, or a file no component covers does', () => {
		const cases = [
			{ path: 'src/api.ts', added: 1, removed: 0, baseline: 'const x = 1;', final: 'import { save } from "./store";\nconst x = 1;' },
			{ path: 'src/cache.ts', added: 10, removed: 0, baseline: null, final: 'export const cache = 1;' },
			{ path: 'src/store.ts', added: 0, removed: 10, baseline: 'export const s = 1;', final: null },
			{ path: 'docs/notes.md', added: 1, removed: 0, baseline: 'a', final: 'b' },
		];
		assert.deepStrictEqual(cases.map(change => structuralSignals(MAP, describeChanges(snapshot([change])))), [true, true, true, true]);
	});
});

describe('Diagram agent: building and keeping the map', () => {
	async function harness(replies: string[], folderMode?: 'auto' | 'manual' | 'off') {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-diagram-'));
		const storePath = path.join(dir, 'map.json');
		if (folderMode) {
			await fs.writeFile(storePath, JSON.stringify({ folderMode, revisions: [] }));
		}
		const asked: string[] = [];
		const prompts: string[] = [];
		const states: DiagramState[] = [];
		const announced: string[] = [];
		let now = 1000;
		const agent = new DiagramAgent({
			session: { ask: async prompt => { prompts.push(prompt); asked.push(prompt.split('\n').find(line => line.startsWith('SYSTEM MAP')) ?? '?'); return replies.shift() ?? '{"update": false, "reason": "none"}'; } },
			storePath,
			fileExists: async file => FILES.has(file),
			listFiles: async () => ({ files: [...FILES], truncated: false }),
			emit: state => states.push(state),
			announce: (text, version) => announced.push(`v${version}: ${text}`),
			log: () => undefined,
			enabled: () => true,
			checkMs: () => 60_000,
			now: () => now,
		});
		return { agent, asked, prompts, states, announced, storePath, tick: (ms: number) => { now += ms; } };
	}
	const settle = () => new Promise(resolve => setTimeout(resolve, 20));
	const turn = (index: number, final: boolean): DiagramSnapshot => ({ turnId: `t${index}`, turnIndex: index, task: 'add a cache', progress: [], final, changes: [{ path: 'src/cache.ts', added: 5, removed: 0, baseline: null, final: 'export const cache = new Map();' }] });

	test('choosing to keep the map builds it, and a structural change in a turn produces a new version announced in chat', async () => {
		const updated = { ...MAP, components: [...MAP.components, { id: 'cache', name: 'Cache', summary: 'Remembers', description: 'Caches.', files: [{ path: 'src/api.ts' }] }] };
		const h = await harness([JSON.stringify(MAP), JSON.stringify({ update: true, reason: 'Added a cache.', changed: ['cache'], map: updated })]);
		await h.agent.setFolderMode('auto');
		await h.agent.checkpoint(turn(1, true));
		await settle();
		const state = await h.agent.state();
		assert.deepStrictEqual({ asked: h.asked, announced: h.announced, version: state.current?.version, changed: state.current?.changed, folderMode: state.folderMode, history: state.history.map(entry => entry.reason) }, {
			asked: ['SYSTEM MAP SURVEY', 'SYSTEM MAP UPDATE'],
			announced: ['v2: Added a cache.'],
			version: 2,
			changed: ['cache'],
			folderMode: 'auto',
			history: ['Added a cache.', 'Built the first map of the project.'],
		});
		// The choice and the versions are kept together, for the next time the folder opens.
		const stored = JSON.parse(await fs.readFile(h.storePath, 'utf8'));
		assert.deepStrictEqual({ folderMode: stored.folderMode, versions: stored.revisions.map((revision: { version: number }) => revision.version) }, { folderMode: 'auto', versions: [1, 2] });
	});

	test('"Just Generate" builds once and never updates by itself; Check Now still does', async () => {
		const h = await harness([JSON.stringify(MAP)]);
		await h.agent.setFolderMode('manual');
		await h.agent.checkpoint(turn(1, true));
		await settle();
		assert.deepStrictEqual(h.asked, ['SYSTEM MAP SURVEY']);
		await h.agent.updateNow();
		assert.deepStrictEqual(h.asked, ['SYSTEM MAP SURVEY', 'SYSTEM MAP UPDATE']);
	});

	test('"Keep Off" builds nothing', async () => {
		const h = await harness([]);
		await h.agent.setFolderMode('off');
		await h.agent.checkpoint(turn(1, true));
		await settle();
		assert.deepStrictEqual({ asked: h.asked, current: (await h.agent.state()).current }, { asked: [], current: undefined });
	});

	test('during a turn it checks at most once per interval; the end of the turn is always checked', async () => {
		const h = await harness([JSON.stringify(MAP)], 'auto');
		await h.agent.build();
		await h.agent.checkpoint(turn(1, false));
		await settle();
		await h.agent.checkpoint(turn(1, false));
		await settle();
		assert.strictEqual(h.asked.filter(prompt => prompt === 'SYSTEM MAP UPDATE').length, 1, 'the second checkpoint waits for the interval');
		await h.agent.checkpoint(turn(1, true));
		await settle();
		assert.strictEqual(h.asked.filter(prompt => prompt === 'SYSTEM MAP UPDATE').length, 2, 'the end of the turn is checked at once');
		h.agent.dispose();
	});

	test('a map with problems goes back once with the problems listed', async () => {
		const broken = { ...MAP, components: [...MAP.components, { id: 'ghost', name: 'Ghost', files: ['src/nowhere.ts'] }] };
		const h = await harness([JSON.stringify(broken), JSON.stringify(MAP)], 'auto');
		await h.agent.build();
		const state = await h.agent.state();
		assert.deepStrictEqual({ asked: h.asked, components: state.current?.map.components.map(component => component.id) }, { asked: ['SYSTEM MAP SURVEY', 'SYSTEM MAP REPAIR'], components: ['cli', 'api', 'store'] });
	});

	test('a change the developer describes becomes a new version, and later updates are told to keep it', async () => {
		const renamed = { ...MAP, components: MAP.components.map(component => component.id === 'store' ? { ...component, name: 'Results store' } : component) };
		const h = await harness([JSON.stringify(MAP), JSON.stringify({ update: true, reason: 'Renamed Store to Results store.', changed: ['store'], map: renamed })], 'manual');
		await h.agent.build();
		const result = await h.agent.edit('call the store "Results store"');
		const state = await h.agent.state();
		assert.deepStrictEqual({ result, request: state.current?.request, name: state.current?.map.components.find(component => component.id === 'store')?.name, announced: h.announced }, {
			result: { version: 2, reason: 'Renamed Store to Results store.' },
			request: 'call the store "Results store"',
			name: 'Results store',
			announced: [], // the reply goes to chat as the answer to the developer, not as an announcement
		});
		assert.deepStrictEqual(JSON.parse(await fs.readFile(h.storePath, 'utf8')).requests, ['call the store "Results store"']);
		await h.agent.updateNow();
		assert.match(h.prompts.at(-1)!, /asked for these changes to the map earlier[\s\S]*- call the store "Results store"/);
	});

	test('a change the agent declines leaves the map alone and says why', async () => {
		const h = await harness([JSON.stringify(MAP), JSON.stringify({ update: false, reason: 'The map already shows the CLI calling the API.' })], 'manual');
		await h.agent.build();
		const result = await h.agent.edit('show that the CLI calls the API');
		const state = await h.agent.state();
		assert.deepStrictEqual({ result, version: state.current?.version, asked: h.asked }, {
			result: { reason: 'The map already shows the CLI calling the API.' },
			version: 1,
			asked: ['SYSTEM MAP SURVEY', 'SYSTEM MAP EDIT'],
		});
		assert.deepStrictEqual(JSON.parse(await fs.readFile(h.storePath, 'utf8')).requests, []);
	});

	test('a repaired change that comes back without its wrapper is still the change, with its first reason', async () => {
		const broken = { ...MAP, components: [...MAP.components, { id: 'ghost', name: 'Ghost', files: ['src/nowhere.ts'] }] };
		const renamed = { ...MAP, components: MAP.components.map(component => component.id === 'cli' ? { ...component, name: 'Command line' } : component) };
		const h = await harness([JSON.stringify(MAP), JSON.stringify({ update: true, reason: 'Renamed CLI to Command line.', changed: ['cli'], map: broken }), JSON.stringify(renamed)], 'manual');
		await h.agent.build();
		const result = await h.agent.edit('rename CLI to Command line');
		const state = await h.agent.state();
		assert.deepStrictEqual({ result, asked: h.asked, name: state.current?.map.components.find(component => component.id === 'cli')?.name }, {
			result: { version: 2, reason: 'Renamed CLI to Command line.' },
			asked: ['SYSTEM MAP SURVEY', 'SYSTEM MAP EDIT', 'SYSTEM MAP REPAIR'],
			name: 'Command line',
		});
	});

	test('text the developer edits on the map is saved at once, without the model, and later updates keep it', async () => {
		const h = await harness([JSON.stringify(MAP)], 'manual');
		await h.agent.build();
		const version = await h.agent.reviseText({
			components: [{ id: 'store', name: 'Results store', description: 'Keeps finished results on disk.' }, { id: 'cli', name: 'CLI' }],
			connections: [{ from: 'api', to: 'store', label: 'writes results' }],
		});
		const state = await h.agent.state();
		const map = state.current!.map;
		assert.deepStrictEqual({
			version, manual: state.current?.manual, reason: state.current?.reason, changed: state.current?.changed,
			store: map.components.find(component => component.id === 'store'), label: map.connections[1].label, asked: h.asked,
		}, {
			version: 2, manual: true,
			reason: "You renamed Store to Results store, edited Results store's description, edited the API client → Results store connection.",
			changed: ['store'],
			store: { id: 'store', name: 'Results store', summary: 'Keeps state', description: 'Keeps finished results on disk.', files: [{ path: 'src/store.ts' }] },
			label: 'writes results',
			asked: ['SYSTEM MAP SURVEY'],
		});
		// Nothing changed: no new version.
		assert.strictEqual(await h.agent.reviseText({ components: [{ id: 'cli', name: 'CLI' }] }), undefined);
		await h.agent.updateNow();
		assert.match(h.prompts.at(-1)!, /- Call the component "store" "Results store"\./);
		assert.match(h.prompts.at(-1)!, /"description":"Keeps finished results on disk\."/);
	});

	test('the components a turn touched are marked from the files alone, without asking the model', async () => {
		const h = await harness([JSON.stringify(MAP)], 'manual');
		await h.agent.build();
		await h.agent.checkpoint({ ...turn(4, true), changes: [{ path: 'src/store.ts', added: 1, removed: 1, baseline: 'a', final: 'b' }] });
		const state = await h.agent.state();
		assert.deepStrictEqual({ touched: state.touched, turn: state.touchedTurnIndex, asked: h.asked }, { touched: ['store'], turn: 4, asked: ['SYSTEM MAP SURVEY'] });
	});
});

describe('Questions from the system map', () => {
	test('the prompt carries what was picked, with its code, and the whole map for context', () => {
		const prompt = buildMapQuestionPrompt('how do these fit together?', MAP, { components: ['api', 'gone'], connections: [{ from: 'cli', to: 'api' }] }, DEFAULT_PROFILE);
		const picked = prompt.split('WHAT THE DEVELOPER PICKED ON THE MAP\n')[1].split('\n\n')[0];
		assert.deepStrictEqual(picked.split('\n').filter(line => !line.startsWith('  ')), ['Component "API client" (api): Talks HTTP', 'Connection CLI → API client: requests']);
		assert.match(picked, /Code: src\/api\.ts:1-30/);
		assert.match(picked, /Where: src\/cli\.ts:3/);
		assert.match(prompt, /THE WHOLE MAP \(for context\)\nA CLI over an API client and a store\./);
		assert.match(prompt, /QUESTION\nhow do these fit together\?$/);
	});
});
