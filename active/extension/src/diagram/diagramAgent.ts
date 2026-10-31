/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { DiagramFolderMode, DiagramState, DiagramStatus, extractJsonObject, parseSystemMap, SystemMap, SystemMapRevision, SystemMapTextEdit } from '../shared/activeProtocol';
import { buildDiagramEditPrompt, buildDiagramRecheckPrompt, buildDiagramRepairPrompt, buildDiagramSurveyPrompt, buildDiagramUpdatePrompt, DiagramFileChange } from './prompts';

/** What the diagram agent hears about a turn: at its checkpoints, and when it ends. */
export interface DiagramSnapshot {
	readonly turnId: string;
	readonly turnIndex: number;
	readonly task: string;
	readonly changes: ReadonlyArray<{ readonly path: string; readonly added: number; readonly removed: number; readonly baseline: string | null; readonly final: string | null }>;
	readonly progress: readonly string[];
	/** The turn is over (always checked, whatever the interval). */
	readonly final: boolean;
}

/** The part of the explanation agent the diagram agent needs: one question at a time, answered in text. */
export interface DiagramSession {
	ask(prompt: string): Promise<string>;
}

export interface DiagramAgentOptions {
	readonly session: DiagramSession;
	/** Where the map's versions are kept. */
	readonly storePath: string;
	readonly fileExists: (relative: string) => Promise<boolean>;
	/** The project's files (for the first survey); `truncated` when there were more. */
	readonly listFiles: () => Promise<{ files: string[]; truncated: boolean }>;
	readonly emit: (state: DiagramState) => void;
	/** Tells the developer in chat that the map changed (without leaving what they're doing). */
	readonly announce: (text: string, version: number, turnId?: string) => void;
	readonly log: (line: string) => void;
	/** System diagrams are turned on (globally). */
	readonly enabled: () => boolean;
	/** Least time between checks during a turn. */
	readonly checkMs: () => number;
	readonly now?: () => number;
}

/** What came of a change the developer asked for: a new version, or the agent's reason for leaving the map alone. */
export interface DiagramEditResult {
	readonly version?: number;
	readonly reason: string;
}

const MAX_REVISIONS = 40;
/** The developer's requests kept for later maps to honour. */
const MAX_REQUESTS = 20;
/** Lines that make or change a dependency between files, in the languages a project is likely to use. */
const DEPENDENCY_LINE = /^\s*(?:import\b|export\s+(?:\*|\{[^}]*\})\s+from\b|from\s+\S+\s+import\b|const\s+\S+\s*=\s*require\(|#include\b|use\s+[\w:]+|using\s+[\w.]+;|require\s*\(|require_relative\b|@import\b)/;

/**
 * The diagram agent: its own read-only session, separate from the explainer, keeping the system map. It builds
 * the first map when asked, and on its own timeline (at most every `checkMs` during a turn, and at the end of
 * every turn that changed files) decides whether the map needs to change. Which components a turn touched is
 * worked out from the files alone, without asking the model; the model is only asked when the change could
 * alter the structure (files added or removed, dependencies changed, files no component covers).
 */
export class DiagramAgent {
	private revisions: SystemMapRevision[] | undefined;
	/** This folder's choice, kept with its map; only `auto` updates the map by itself. */
	private folderMode: DiagramFolderMode | undefined;
	/** Changes the developer asked for, oldest first; every later build and update is told to keep them. */
	private requests: string[] = [];
	private status: DiagramStatus = 'empty';
	private detail: string | undefined;
	private touched: string[] = [];
	private touchedTurnIndex: number | undefined;
	private running: Promise<void> | undefined;
	private lastCheckAt = -Infinity;
	private pending: DiagramSnapshot | undefined;
	private timer: ReturnType<typeof setTimeout> | undefined;
	/** The latest snapshot of each turn, for "Check Now" and for files the map hasn't seen yet. */
	private latest: DiagramSnapshot | undefined;

	constructor(private readonly options: DiagramAgentOptions) { }

	private get now(): number {
		return (this.options.now ?? Date.now)();
	}

	async state(): Promise<DiagramState> {
		const revisions = await this.load();
		const current = revisions[revisions.length - 1];
		const status: DiagramStatus = !this.options.enabled() && !current ? 'off' : this.status === 'empty' && current ? 'ready' : this.status;
		return {
			status,
			detail: this.detail,
			current,
			history: [...revisions].reverse().map(({ map: _map, ...summary }) => summary),
			touched: this.touched,
			touchedTurnIndex: this.touchedTurnIndex,
			folderMode: this.folderMode,
		};
	}

	/** The developer's choice for this folder; building the map if they want one and there's none yet. */
	async setFolderMode(mode: DiagramFolderMode): Promise<void> {
		const current = (await this.load()).at(-1);
		this.folderMode = mode;
		await this.persist();
		await this.emit();
		if (mode !== 'off' && !current) {
			await this.build();
		}
	}

	async revision(version: number): Promise<SystemMapRevision | undefined> {
		return (await this.load()).find(revision => revision.version === version);
	}

	dispose(): void {
		clearTimeout(this.timer);
	}

	// ------------------------------------------------------------------ building

	/** Builds the map (the first time, or again from scratch). One build or check runs at a time. */
	build(): Promise<void> {
		return this.exclusive(() => this.doBuild());
	}

	private async doBuild(): Promise<void> {
		const revisions = await this.load();
		await this.setStatus('building');
		try {
			const { files, truncated } = await this.options.listFiles();
			const map = await this.askForMap(buildDiagramSurveyPrompt(files, truncated, this.requests), value => value);
			if (!map) {
				await this.setStatus('failed', 'The diagram agent did not return a usable map.');
				return;
			}
			const first = !revisions.length;
			await this.save({ version: this.nextVersion(), at: this.now, reason: first ? 'Built the first map of the project.' : 'Rebuilt the map from scratch.', changed: map.components.map(component => component.id), map });
			await this.setStatus('ready');
		} catch (error) {
			await this.setStatus('failed', `Couldn't build the map: ${message(error)}`);
		}
	}

	/**
	 * The developer edited names, summaries, descriptions or labels on the map. Saved as a new version straight
	 * away (no model), and remembered so later updates keep the developer's wording.
	 */
	reviseText(edit: SystemMapTextEdit): Promise<number | undefined> {
		let version: number | undefined;
		return this.exclusive(async () => {
			const current = (await this.load()).at(-1);
			if (!current) {
				return;
			}
			const clean = (text: string | undefined, max: number) => text === undefined ? undefined : text.replace(/\s+$/g, '').trim().slice(0, max);
			const notes: string[] = [];
			const keep: string[] = [];
			const changed = new Set<string>();
			const components = current.map.components.map(component => {
				const change = edit.components?.find(candidate => candidate.id === component.id);
				if (!change) {
					return component;
				}
				const name = clean(change.name, 80) || component.name;
				const summary = clean(change.summary, 160) ?? component.summary;
				const description = clean(change.description, 2000) ?? component.description;
				if (name !== component.name) {
					notes.push(`renamed ${component.name} to ${name}`);
					keep.push(`Call the component "${component.id}" "${name}".`);
				}
				if (summary !== component.summary || description !== component.description) {
					notes.push(`edited ${name}'s ${summary !== component.summary && description !== component.description ? 'summary and description' : summary !== component.summary ? 'summary' : 'description'}`);
					keep.push(`For "${component.id}", keep the developer's wording: ${JSON.stringify({ summary, description })}.`);
				}
				if (name === component.name && summary === component.summary && description === component.description) {
					return component;
				}
				changed.add(component.id);
				return { ...component, name, summary, description };
			});
			const nameOf = (id: string) => components.find(component => component.id === id)?.name ?? id;
			const connections = current.map.connections.map(connection => {
				const change = edit.connections?.find(candidate => candidate.from === connection.from && candidate.to === connection.to);
				if (!change) {
					return connection;
				}
				const label = clean(change.label, 80) ?? connection.label;
				const detail = clean(change.detail, 1000) ?? connection.detail;
				if (label === connection.label && detail === (connection.detail ?? '')) {
					return connection;
				}
				notes.push(`edited the ${nameOf(connection.from)} → ${nameOf(connection.to)} connection`);
				keep.push(`For the connection "${connection.from}" → "${connection.to}", keep the developer's wording: ${JSON.stringify({ label, detail })}.`);
				return { ...connection, label, ...(detail ? { detail } : {}) };
			});
			if (!notes.length) {
				return;
			}
			const revision: SystemMapRevision = { version: this.nextVersion(), at: this.now, reason: `You ${notes.join(', ')}.`, changed: [...changed], map: { ...current.map, components, connections }, manual: true };
			// Newer wording for the same thing replaces the older note.
			const subject = (note: string) => /^(?:Call the component|For) ("[^"]+"(?: → "[^"]+")?)/.exec(note)?.[1] + (note.startsWith('Call') ? ':name' : ':text');
			this.requests = [...this.requests.filter(earlier => !keep.some(note => subject(note) === subject(earlier))), ...keep].slice(-MAX_REQUESTS);
			await this.save(revision);
			await this.setStatus('ready');
			version = revision.version;
		}).then(() => version);
	}

	// ------------------------------------------------------------------ keeping it current

	/**
	 * The coding agent reached a checkpoint, or finished a turn. Marks the components the change touched at once,
	 * then checks the map at most every `checkMs` (the end of a turn always gets a check).
	 */
	async checkpoint(snapshot: DiagramSnapshot): Promise<void> {
		this.latest = snapshot;
		const current = (await this.load()).at(-1);
		if (current) {
			this.markTouched(current.map, snapshot);
		}
		if (!this.options.enabled() || this.folderMode !== 'auto' || !current || !snapshot.changes.length) {
			return;
		}
		// Coalesce: the newest snapshot of a turn covers the earlier ones.
		this.pending = snapshot.final || !this.pending?.final ? snapshot : this.pending;
		this.schedule();
	}

	private schedule(): void {
		if (this.running || !this.pending) {
			return;
		}
		const wait = this.pending.final ? 0 : this.lastCheckAt + this.options.checkMs() - this.now;
		clearTimeout(this.timer);
		if (wait > 0) {
			this.timer = setTimeout(() => this.schedule(), wait);
			return;
		}
		const snapshot = this.pending;
		this.pending = undefined;
		void this.exclusive(() => this.check(snapshot)).then(() => this.schedule());
	}

	/** The developer asked to check now: against the latest turn's changes, or the code as it is. */
	updateNow(): Promise<void> {
		return this.exclusive(async () => {
			const current = (await this.load()).at(-1);
			if (!current) {
				return this.doBuild();
			}
			if (this.latest?.changes.length) {
				return this.check({ ...this.latest, final: true }, true);
			}
			await this.runUpdate(current, buildDiagramRecheckPrompt(current.map, this.requests));
		});
	}

	/**
	 * The developer described a change to the map. The agent makes it (still true to the code) or says why not;
	 * either way the reply is for the developer. Requests that changed the map are kept for later versions.
	 */
	edit(request: string): Promise<DiagramEditResult> {
		let result: DiagramEditResult = { reason: '' };
		return this.exclusive(async () => {
			const current = (await this.load()).at(-1);
			if (!current) {
				result = { reason: "There's no map to change yet. Build it first." };
				return;
			}
			const outcome = await this.runUpdate(current, buildDiagramEditPrompt(current.map, request, this.requests), undefined, request);
			if (outcome.version !== undefined) {
				this.requests = [...this.requests.filter(earlier => earlier !== request), request].slice(-MAX_REQUESTS);
				await this.persist();
			}
			result = outcome;
		}).then(() => result);
	}

	private async check(snapshot: DiagramSnapshot, force = false): Promise<void> {
		const current = (await this.load()).at(-1);
		if (!current || !this.options.enabled() || (!force && this.folderMode !== 'auto')) {
			return;
		}
		this.lastCheckAt = this.now;
		const changes = describeChanges(snapshot);
		const structural = force || structuralSignals(current.map, changes);
		if (!structural) {
			this.options.log(`diagram: turn ${snapshot.turnIndex} changed no structure, map unchanged`);
			return;
		}
		await this.runUpdate(current, buildDiagramUpdatePrompt(current.map, snapshot.task, changes, snapshot.progress, snapshot.final, this.requests), snapshot);
	}

	/**
	 * Asks for an updated map and saves it as a new version. A change the developer asked for (`request`) is
	 * answered in chat by the caller; other new versions are announced here.
	 */
	private async runUpdate(current: SystemMapRevision, prompt: string, snapshot?: DiagramSnapshot, request?: string): Promise<DiagramEditResult> {
		await this.setStatus('updating', request ? 'Making your change…' : undefined);
		try {
			let reason = '';
			let changed: string[] = [];
			let wantsUpdate = false;
			const map = await this.askForMap(prompt, value => {
				const reply = value as { update?: unknown; reason?: unknown; changed?: unknown; map?: unknown; components?: unknown } | undefined;
				// A repaired map can come back bare (without the update wrapper): it is still the change, and the
				// first reply's reason and ids still describe it.
				if (wantsUpdate && reply?.update === undefined && Array.isArray(reply?.components)) {
					return reply;
				}
				reason = typeof reply?.reason === 'string' ? reply.reason.trim().slice(0, 300) : reason;
				changed = Array.isArray(reply?.changed) ? reply.changed.filter((id): id is string => typeof id === 'string') : changed;
				wantsUpdate = reply?.update === true;
				return wantsUpdate ? reply?.map : null;
			});
			if (!wantsUpdate) {
				this.options.log(`diagram: no update${reason ? ` (${reason})` : ''}`);
				await this.setStatus('ready');
				return { reason: reason || 'The map already shows this, so I left it as it is.' };
			}
			if (!map) {
				await this.setStatus('failed', 'The diagram agent proposed a change that did not check out; the map is unchanged.');
				return { reason: "The change I came up with didn't check out against the code, so the map is unchanged." };
			}
			// What changed, worked out from the maps themselves when the agent didn't say. Line numbers shifting
			// as code is edited don't count: a component changed if what it is, or which files it is, changed.
			const identity = (component: SystemMap['components'][number]) => JSON.stringify([component.name, component.summary, component.description, component.files.map(file => file.path).sort()]);
			const before = new Map(current.map.components.map(component => [component.id, identity(component)]));
			const differs = map.components.filter(component => before.get(component.id) !== identity(component)).map(component => component.id);
			const known = new Set(map.components.map(component => component.id));
			const revision: SystemMapRevision = {
				version: this.nextVersion(),
				at: this.now,
				turnId: snapshot?.turnId,
				turnIndex: snapshot?.turnIndex,
				reason: reason || 'Updated the map.',
				changed: [...new Set([...changed.filter(id => known.has(id)), ...differs])],
				map,
				...(request ? { request } : {}),
			};
			await this.save(revision);
			if (!request) {
				this.options.announce(revision.reason, revision.version, snapshot?.turnId);
			}
			if (snapshot) {
				this.markTouched(map, snapshot);
			}
			await this.setStatus('ready');
			return { version: revision.version, reason: revision.reason };
		} catch (error) {
			await this.setStatus('failed', `The last map check failed: ${message(error)}`);
			return { reason: `I couldn't change the map: ${message(error)}` };
		}
	}

	/**
	 * Asks for a map and checks it, sending it back once with the problems found. `pick` takes the map out of
	 * the reply (`null`: the reply deliberately has none, e.g. "no update").
	 */
	private async askForMap(prompt: string, pick: (reply: unknown) => unknown): Promise<SystemMap | undefined> {
		let reply = await this.options.session.ask(prompt);
		for (let attempt = 0; attempt < 2; attempt++) {
			const value = pick(extractJsonObject(reply));
			if (value === null) {
				return undefined;
			}
			const errors: string[] = [];
			const paths = collectPaths(value);
			const existing = new Set<string>();
			for (const file of paths) {
				if (await this.options.fileExists(file)) {
					existing.add(file);
				}
			}
			const map = parseSystemMap(value, file => existing.has(file), errors);
			if (map && !errors.length) {
				return map;
			}
			if (attempt === 1) {
				// Keep what checked out rather than nothing.
				return map;
			}
			this.options.log(`diagram: map had ${errors.length} problem(s), asking for a repair: ${errors.slice(0, 5).join('; ')}`);
			reply = await this.options.session.ask(buildDiagramRepairPrompt(errors));
		}
		return undefined;
	}

	private markTouched(map: SystemMap, snapshot: DiagramSnapshot): void {
		const changed = new Set(snapshot.changes.map(change => change.path));
		const touched = map.components.filter(component => component.files.some(file => changed.has(file.path))).map(component => component.id);
		if (touched.join() !== this.touched.join() || this.touchedTurnIndex !== snapshot.turnIndex) {
			this.touched = touched;
			this.touchedTurnIndex = snapshot.turnIndex;
			void this.emit();
		}
	}

	// ------------------------------------------------------------------ state and storage

	private async exclusive(run: () => Promise<void>): Promise<void> {
		while (this.running) {
			await this.running.catch(() => undefined);
		}
		const running = this.running = run().finally(() => {
			if (this.running === running) {
				this.running = undefined;
			}
		});
		return running;
	}

	private async setStatus(status: DiagramStatus, detail?: string): Promise<void> {
		this.status = status;
		this.detail = detail;
		await this.emit();
	}

	private async emit(): Promise<void> {
		this.options.emit(await this.state());
	}

	private nextVersion(): number {
		return (this.revisions?.at(-1)?.version ?? 0) + 1;
	}

	private async load(): Promise<SystemMapRevision[]> {
		if (!this.revisions) {
			try {
				const parsed = JSON.parse(await fs.readFile(this.options.storePath, 'utf8')) as { revisions?: SystemMapRevision[]; folderMode?: DiagramFolderMode; requests?: unknown };
				this.revisions = Array.isArray(parsed.revisions) ? parsed.revisions : [];
				this.requests = Array.isArray(parsed.requests) ? parsed.requests.filter((request): request is string => typeof request === 'string') : [];
				this.folderMode = parsed.folderMode === 'auto' || parsed.folderMode === 'manual' || parsed.folderMode === 'off' ? parsed.folderMode : undefined;
			} catch {
				this.revisions = [];
			}
		}
		return this.revisions;
	}

	private async save(revision: SystemMapRevision): Promise<void> {
		const revisions = await this.load();
		revisions.push(revision);
		revisions.splice(0, Math.max(0, revisions.length - MAX_REVISIONS));
		await this.persist();
	}

	private async persist(): Promise<void> {
		await fs.mkdir(path.dirname(this.options.storePath), { recursive: true });
		await fs.writeFile(this.options.storePath, JSON.stringify({ folderMode: this.folderMode, requests: this.requests, revisions: this.revisions ?? [] }), 'utf8');
	}
}

/** The changes as the agent is told about them, with the dependency lines that came and went. */
export function describeChanges(snapshot: DiagramSnapshot): DiagramFileChange[] {
	return snapshot.changes.map(change => {
		const before = dependencyLines(change.baseline);
		const after = dependencyLines(change.final);
		return {
			path: change.path,
			added: change.added,
			removed: change.removed,
			...(change.baseline === null ? { created: true } : {}),
			...(change.final === null ? { deleted: true } : {}),
			dependencyLines: { added: [...after].filter(line => !before.has(line)).slice(0, 12), removed: [...before].filter(line => !after.has(line)).slice(0, 12) },
		};
	});
}

/** Whether a change could alter the map: a file added or removed, a dependency changed, or a file no component covers. */
export function structuralSignals(map: SystemMap, changes: readonly DiagramFileChange[]): boolean {
	const covered = new Set(map.components.flatMap(component => component.files.map(file => file.path)));
	return changes.some(change => change.created || change.deleted || !covered.has(change.path) || !!change.dependencyLines?.added.length || !!change.dependencyLines?.removed.length);
}

function dependencyLines(text: string | null): Set<string> {
	if (!text) {
		return new Set();
	}
	return new Set(text.split('\n').filter(line => DEPENDENCY_LINE.test(line)).map(line => line.trim().slice(0, 200)));
}

/** Every file path a proposed map cites, so their existence can be checked before parsing. */
function collectPaths(value: unknown): string[] {
	const found = new Set<string>();
	const visit = (node: unknown) => {
		if (Array.isArray(node)) {
			node.forEach(visit);
		} else if (node && typeof node === 'object') {
			const record = node as Record<string, unknown>;
			if (typeof record.path === 'string') {
				found.add(record.path.replace(/^\.\//, '').trim());
			}
			Object.values(record).forEach(visit);
		} else if (typeof node === 'string' && /\.[a-z0-9]+$/i.test(node) && node.includes('/')) {
			found.add(node.replace(/^\.\//, '').trim());
		}
	};
	visit(value);
	return [...found];
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
