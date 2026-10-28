/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { FileChangeStat } from '../shared/activeProtocol';
import { diffStats } from './lineDiff';
import { WorkspaceFiles } from './workspaceFiles';

export type EditSource = 'agent' | 'user';

export interface RecordedEdit {
	readonly seq: number;
	readonly path: string;
	readonly at: number;
	readonly source: EditSource;
	readonly before: string | null;
	readonly after: string | null;
	readonly added: number;
	readonly removed: number;
	/** The coding agent tool call most recently active when the edit was observed. */
	readonly toolItemId?: string;
}

export interface NetFileChange {
	readonly path: string;
	readonly baseline: string | null;
	readonly final: string | null;
	readonly added: number;
	readonly removed: number;
	/** Every recorded edit to this path came from the user. */
	readonly userOnly: boolean;
	/** The user also edited this path during the turn. */
	readonly userTouched: boolean;
	/** The path already had uncommitted changes before the turn began. */
	readonly preexistingUserChanges: boolean;
}

interface MirrorEntry {
	mtime: number;
	content: string | null;
}

const USER_TYPING_WINDOW_MS = 4000;

/**
 * Keeps an in-memory mirror of trackable workspace files so a turn's baseline
 * can be taken instantly, and records the ordered edits observed during each
 * turn. Edits are detected from file watcher events and from mtime rescans
 * after tool calls, so changes made by shell commands are captured as well as
 * those made by file-editing tools.
 */
export class ChangeTracker {
	private readonly mirror = new Map<string, MirrorEntry>();
	private turn: TurnLog | undefined;
	private readonly userTyping = new Map<string, number>();
	private lastScan = 0;
	private activeToolItemId: string | undefined;

	constructor(private readonly files: WorkspaceFiles, private readonly now: () => number = Date.now) { }

	get currentTurnId(): string | undefined {
		return this.turn?.turnId;
	}

	/** Brings the mirror up to date (rereads files whose mtime changed). */
	async refresh(): Promise<void> {
		const listed = await this.files.list();
		const seen = new Set<string>();
		for (const path of listed) {
			seen.add(path);
			const mtime = await this.files.mtime(path);
			if (mtime === undefined) {
				continue;
			}
			const known = this.mirror.get(path);
			if (known && known.mtime === mtime) {
				continue;
			}
			const content = await this.files.read(path);
			if (content === undefined) {
				this.mirror.delete(path);
				continue;
			}
			this.mirror.set(path, { mtime, content });
		}
		for (const path of [...this.mirror.keys()]) {
			if (!seen.has(path) && this.mirror.get(path)?.content !== null) {
				const content = await this.files.read(path);
				if (content === null) {
					this.mirror.set(path, { mtime: 0, content: null });
				} else if (content === undefined) {
					this.mirror.delete(path);
				}
			}
		}
		this.lastScan = this.now();
	}

	async beginTurn(turnId: string): Promise<void> {
		await this.refresh();
		const preexisting = await this.files.uncommittedFiles();
		const baseline = new Map<string, string | null>();
		for (const [path, entry] of this.mirror) {
			baseline.set(path, entry.content);
		}
		this.turn = new TurnLog(turnId, baseline, preexisting);
		this.activeToolItemId = undefined;
	}

	/** Ends recording and returns the final net changes. Later edits are no longer attributed to this turn. */
	async endTurn(): Promise<{ edits: readonly RecordedEdit[]; changes: readonly NetFileChange[] } | undefined> {
		const turn = this.turn;
		if (!turn) {
			return undefined;
		}
		await this.rescan();
		this.turn = undefined;
		return { edits: turn.edits, changes: turn.netChanges() };
	}

	setActiveTool(itemId: string | undefined): void {
		this.activeToolItemId = itemId;
	}

	/** Called when the user types in an editor so the resulting save is attributed to them. */
	noteUserTyping(path: string): void {
		this.userTyping.set(path, this.now());
	}

	/** Observes one path (from a watcher event). Returns the recorded edit, if the content changed. */
	async observe(path: string): Promise<RecordedEdit | undefined> {
		const content = await this.files.read(path);
		if (content === undefined) {
			return undefined;
		}
		const mtime = (await this.files.mtime(path)) ?? 0;
		const previous = this.mirror.get(path);
		this.mirror.set(path, { mtime, content });
		const before = previous ? previous.content : null;
		if (before === content) {
			return undefined;
		}
		if (!this.turn) {
			return undefined;
		}
		const typedAt = this.userTyping.get(path);
		const source: EditSource = typedAt !== undefined && this.now() - typedAt < USER_TYPING_WINDOW_MS ? 'user' : 'agent';
		return this.turn.record(path, before, content, source, this.now(), this.activeToolItemId);
	}

	/** Rescans for files changed since the last scan; catches edits watchers missed (e.g. shell commands). */
	async rescan(): Promise<RecordedEdit[]> {
		const since = this.lastScan;
		const listed = await this.files.list();
		const candidates = new Set<string>();
		for (const path of listed) {
			const mtime = await this.files.mtime(path);
			const known = this.mirror.get(path);
			if (!known || (mtime !== undefined && mtime !== known.mtime && mtime >= since - 2000)) {
				candidates.add(path);
			}
		}
		const listedSet = new Set(listed);
		for (const [path, entry] of this.mirror) {
			if (entry.content !== null && !listedSet.has(path)) {
				candidates.add(path);
			}
		}
		this.lastScan = this.now();
		const edits: RecordedEdit[] = [];
		for (const path of candidates) {
			const edit = await this.observe(path);
			if (edit) {
				edits.push(edit);
			}
		}
		return edits;
	}

	currentStats(): FileChangeStat[] {
		return this.turn ? this.turn.netChanges().filter(change => !change.userOnly).map(change => ({ path: change.path, added: change.added, removed: change.removed })) : [];
	}

	currentNetChanges(): readonly NetFileChange[] {
		return this.turn ? this.turn.netChanges() : [];
	}

	currentEdits(): readonly RecordedEdit[] {
		return this.turn ? this.turn.edits : [];
	}

	/** The current content of every mirrored file, for building the explanation workspace. */
	snapshotAll(): Map<string, string> {
		const result = new Map<string, string>();
		for (const [path, entry] of this.mirror) {
			if (entry.content !== null) {
				result.set(path, entry.content);
			}
		}
		return result;
	}
}

class TurnLog {
	readonly edits: RecordedEdit[] = [];
	private readonly touched = new Map<string, { latest: string | null; sources: Set<EditSource> }>();

	constructor(readonly turnId: string, private readonly baseline: Map<string, string | null>, private readonly preexisting: Set<string>) { }

	record(path: string, before: string | null, after: string | null, source: EditSource, at: number, toolItemId: string | undefined): RecordedEdit {
		const stats = diffStats(before, after);
		const edit: RecordedEdit = { seq: this.edits.length + 1, path, at, source, before, after, added: stats.added, removed: stats.removed, toolItemId };
		this.edits.push(edit);
		if (!this.baseline.has(path)) {
			this.baseline.set(path, before);
		}
		const entry = this.touched.get(path) ?? { latest: after, sources: new Set<EditSource>() };
		entry.latest = after;
		entry.sources.add(source);
		this.touched.set(path, entry);
		return edit;
	}

	netChanges(): NetFileChange[] {
		const result: NetFileChange[] = [];
		for (const [path, entry] of this.touched) {
			const baseline = this.baseline.get(path) ?? null;
			const stats = diffStats(baseline, entry.latest);
			if (stats.added === 0 && stats.removed === 0 && baseline === entry.latest) {
				continue;
			}
			result.push({
				path,
				baseline,
				final: entry.latest,
				added: stats.added,
				removed: stats.removed,
				userOnly: !entry.sources.has('agent'),
				userTouched: entry.sources.has('user'),
				preexistingUserChanges: this.preexisting.has(path),
			});
		}
		return result.sort((a, b) => a.path.localeCompare(b.path));
	}
}
