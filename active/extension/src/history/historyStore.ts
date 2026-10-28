/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { CapturedFile, ChatEntry, HistoryDetail, ToolOutcome, TurnSummary, Walkthrough } from '../shared/activeProtocol';

interface StoredEdit {
	readonly seq: number;
	readonly path: string;
	readonly source: 'agent' | 'user';
	readonly added: number;
	readonly removed: number;
	readonly at: number;
	readonly toolItemId?: string;
	readonly before: string | null;
	readonly after: string | null;
}

interface StoredFile {
	readonly path: string;
	readonly languageHint?: string;
	readonly baseline: string | null;
	readonly final: string | null;
	readonly added: number;
	readonly removed: number;
}

/** What a turn record holds; file contents are stored as content-addressed blobs. */
export interface TurnRecord {
	readonly summary: TurnSummary;
	readonly chat: readonly ChatEntry[];
	readonly reasoningSummaries: readonly string[];
	readonly tools: readonly ToolOutcome[];
	readonly edits: readonly StoredEdit[];
	readonly files: readonly StoredFile[];
	/** The walkthrough script and scene/visual specification, without file contents. */
	readonly walkthrough?: Omit<Walkthrough, 'files'>;
	readonly worthiness?: readonly string[];
}

export interface TurnRecordInput {
	readonly summary: TurnSummary;
	readonly chat: readonly ChatEntry[];
	readonly reasoningSummaries: readonly string[];
	readonly tools: readonly ToolOutcome[];
	readonly edits: ReadonlyArray<{ seq: number; path: string; source: 'agent' | 'user'; added: number; removed: number; at: number; toolItemId?: string; before: string | null; after: string | null }>;
	readonly files: readonly CapturedFile[];
	readonly walkthrough?: Walkthrough;
	readonly worthiness?: readonly string[];
}

/**
 * Local, per-workspace session history: chat, exposed reasoning summaries, tool
 * outcomes, captured code versions and diffs, narration scripts and scene
 * specifications. Narration audio is never stored; it is regenerated on replay.
 */
export class HistoryStore {
	private readonly turnsDir: string;
	private readonly blobsDir: string;

	constructor(readonly root: string) {
		this.turnsDir = path.join(root, 'turns');
		this.blobsDir = path.join(root, 'blobs');
	}

	private async putBlob(content: string | null): Promise<string | null> {
		if (content === null) {
			return null;
		}
		const hash = createHash('sha256').update(content).digest('hex');
		const file = path.join(this.blobsDir, `${hash}.txt`);
		try {
			await fs.access(file);
		} catch {
			await fs.mkdir(this.blobsDir, { recursive: true });
			await fs.writeFile(file, content, 'utf8');
		}
		return hash;
	}

	private async getBlob(hash: string | null): Promise<string | null> {
		if (hash === null) {
			return null;
		}
		try {
			return await fs.readFile(path.join(this.blobsDir, `${hash}.txt`), 'utf8');
		} catch {
			return null;
		}
	}

	async save(input: TurnRecordInput): Promise<void> {
		await fs.mkdir(this.turnsDir, { recursive: true });
		const edits: StoredEdit[] = [];
		for (const edit of input.edits) {
			edits.push({ seq: edit.seq, path: edit.path, source: edit.source, added: edit.added, removed: edit.removed, at: edit.at, toolItemId: edit.toolItemId, before: await this.putBlob(edit.before), after: await this.putBlob(edit.after) });
		}
		const files: StoredFile[] = [];
		for (const file of input.files) {
			files.push({ path: file.path, languageHint: file.languageHint, baseline: await this.putBlob(file.baseline), final: await this.putBlob(file.final), added: file.added, removed: file.removed });
		}
		let walkthrough: Omit<Walkthrough, 'files'> | undefined;
		if (input.walkthrough) {
			const { files: _files, ...rest } = input.walkthrough;
			walkthrough = rest;
		}
		const record: TurnRecord = { summary: input.summary, chat: input.chat, reasoningSummaries: input.reasoningSummaries, tools: input.tools, edits, files, walkthrough, worthiness: input.worthiness };
		const target = path.join(this.turnsDir, `${input.summary.turnId}.json`);
		await fs.writeFile(`${target}.tmp`, JSON.stringify(record), 'utf8');
		await fs.rename(`${target}.tmp`, target);
	}

	private async readRecord(turnId: string): Promise<TurnRecord | undefined> {
		try {
			return JSON.parse(await fs.readFile(path.join(this.turnsDir, `${path.basename(turnId)}.json`), 'utf8')) as TurnRecord;
		} catch {
			return undefined;
		}
	}

	async list(): Promise<TurnSummary[]> {
		let names: string[];
		try {
			names = (await fs.readdir(this.turnsDir)).filter(name => name.endsWith('.json'));
		} catch {
			return [];
		}
		const summaries: TurnSummary[] = [];
		for (const name of names) {
			const record = await this.readRecord(name.slice(0, -5));
			if (record) {
				summaries.push(record.summary);
			}
		}
		return summaries.sort((a, b) => b.startedAt - a.startedAt);
	}

	/** Rehydrates captured files for a walkthrough so it can be replayed exactly as captured. */
	async get(turnId: string): Promise<HistoryDetail | undefined> {
		const record = await this.readRecord(turnId);
		if (!record) {
			return undefined;
		}
		const files: Record<string, CapturedFile> = {};
		for (const file of record.files) {
			files[file.path] = { path: file.path, languageHint: file.languageHint, baseline: await this.getBlob(file.baseline), final: await this.getBlob(file.final), added: file.added, removed: file.removed };
		}
		return {
			turn: record.summary,
			chat: record.chat,
			reasoningSummaries: record.reasoningSummaries,
			tools: record.tools,
			edits: record.edits.map(edit => ({ seq: edit.seq, path: edit.path, source: edit.source, added: edit.added, removed: edit.removed, at: edit.at })),
			walkthrough: record.walkthrough ? { ...record.walkthrough, files } : undefined,
			files: Object.values(files),
		};
	}

	/** Recent turn summaries (task + files) that give the explainer historical context. */
	async recentContext(limit: number): Promise<string[]> {
		const summaries = (await this.list()).slice(0, limit);
		return summaries.map(summary => `Turn ${summary.index}: "${summary.task}" → ${summary.outcome}; files: ${summary.files.map(file => `${file.path} (+${file.added} -${file.removed})`).join(', ') || 'none'}`);
	}

	/** Deletes saved history (one turn, or everything). Project files are never touched. */
	async delete(turnId?: string): Promise<void> {
		if (!turnId) {
			await fs.rm(this.root, { recursive: true, force: true });
			return;
		}
		await fs.rm(path.join(this.turnsDir, `${path.basename(turnId)}.json`), { force: true });
		await this.collectGarbage();
	}

	private async collectGarbage(): Promise<void> {
		const referenced = new Set<string>();
		let names: string[] = [];
		try {
			names = (await fs.readdir(this.turnsDir)).filter(name => name.endsWith('.json'));
		} catch {
			// no turns left
		}
		for (const name of names) {
			const record = await this.readRecord(name.slice(0, -5));
			for (const file of record?.files ?? []) {
				for (const hash of [file.baseline, file.final]) {
					if (hash) {
						referenced.add(hash);
					}
				}
			}
			for (const edit of record?.edits ?? []) {
				for (const hash of [edit.before, edit.after]) {
					if (hash) {
						referenced.add(hash);
					}
				}
			}
		}
		let blobs: string[] = [];
		try {
			blobs = await fs.readdir(this.blobsDir);
		} catch {
			return;
		}
		for (const blob of blobs) {
			if (!referenced.has(blob.replace(/\.txt$/, ''))) {
				await fs.rm(path.join(this.blobsDir, blob), { force: true });
			}
		}
	}
}

export class ProfileStore {
	constructor(private readonly file: string) { }

	async read<T>(fallback: T): Promise<T> {
		try {
			return { ...fallback, ...JSON.parse(await fs.readFile(this.file, 'utf8')) } as T;
		} catch {
			return fallback;
		}
	}

	async write<T>(value: T): Promise<void> {
		await fs.mkdir(path.dirname(this.file), { recursive: true });
		await fs.writeFile(this.file, JSON.stringify(value, null, '\t'), 'utf8');
	}
}
