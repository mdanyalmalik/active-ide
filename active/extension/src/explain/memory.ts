/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { MemoryNote, MemoryScope } from '../shared/activeProtocol';

/** A note the explainer asked to keep (from the `remember` field of its reply). */
export interface MemoryInput {
	readonly scope: MemoryScope;
	readonly note: string;
	/** The id of an existing note this one updates. */
	readonly replaces?: string;
}

const MAX_NOTE_CHARS = 300;
/** Past this size the explainer is asked to condense its memory into fewer, shorter notes. */
export const CONDENSE_AT_CHARS = 6000;
/** What condensing aims for, leaving room to grow before the next time. */
export const CONDENSE_TARGET_CHARS = 3000;
/** A safety net if condensing keeps failing: prompts never carry more than this (the newest notes win). */
const HARD_LIMIT_CHARS = 12000;

/**
 * The explainer's own memory, kept by Active and independent of the coding agent's: `personal` notes
 * (about the developer, shared across projects) and `project` notes (about this folder). The explainer
 * adds notes through its replies; Active records the developer's questions itself. All of it goes into
 * the explainer's prompts; when it grows past `CONDENSE_AT_CHARS`, the explainer condenses it.
 */
export class ExplainerMemory {
	private notes: MemoryNote[] | undefined;
	private writing = Promise.resolve();

	constructor(private readonly files: Record<MemoryScope, string>, private readonly now: () => number = Date.now) { }

	async list(): Promise<readonly MemoryNote[]> {
		if (!this.notes) {
			const read = async (scope: MemoryScope): Promise<MemoryNote[]> => {
				try {
					const parsed = JSON.parse(await fs.readFile(this.files[scope], 'utf8')) as MemoryNote[];
					return Array.isArray(parsed) ? parsed.filter(note => typeof note?.id === 'string' && typeof note.text === 'string').map(note => ({ ...note, scope })) : [];
				} catch {
					return [];
				}
			};
			this.notes = [...await read('personal'), ...await read('project')].sort((a, b) => a.at - b.at);
		}
		return this.notes;
	}

	/** Adds the explainer's notes. Exact repeats are dropped; `replaces` updates a note in place. Returns whether anything changed. */
	async add(inputs: readonly MemoryInput[], context?: string): Promise<boolean> {
		const notes = [...await this.list()];
		let changed = false;
		for (const input of inputs) {
			const text = input.note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
			if (!text || notes.some(note => normalize(note.text) === normalize(text))) {
				continue;
			}
			const replaced = input.replaces ? notes.findIndex(note => note.id === input.replaces) : -1;
			const note: MemoryNote = { id: replaced >= 0 ? notes[replaced].id : this.newId(notes), scope: input.scope, text, at: this.now(), source: 'explainer', context };
			if (replaced >= 0) {
				notes[replaced] = note;
			} else {
				notes.push(note);
			}
			changed = true;
		}
		if (changed) {
			await this.save(notes);
		}
		return changed;
	}

	/** Records a question the developer asked (what they wanted to know is worth remembering). */
	async recordQuestion(question: string, about?: string): Promise<void> {
		const text = `${about ? `Asked about "${about}": ` : 'Asked: '}${question.replace(/\s+/g, ' ').trim()}`.slice(0, MAX_NOTE_CHARS);
		const notes = [...await this.list()];
		if (notes.some(note => note.text === text)) {
			return;
		}
		notes.push({ id: this.newId(notes), scope: 'project', text, at: this.now(), source: 'question' });
		await this.save(notes);
	}

	/** Forgets one note, or every note when `id` is absent. */
	async delete(id?: string): Promise<void> {
		await this.save(id ? (await this.list()).filter(note => note.id !== id) : []);
	}

	/** The memory section of a prompt: every note, oldest first, with ids for `replaces` (newest kept if over the hard limit). */
	async describe(): Promise<string> {
		const lines: string[] = [];
		let size = 0;
		for (const note of [...await this.list()].reverse()) {
			const line = describeNote(note);
			if (size + line.length > HARD_LIMIT_CHARS) {
				break;
			}
			lines.unshift(line);
			size += line.length + 1;
		}
		return lines.join('\n');
	}

	/** How much memory there is, as it appears in a prompt. */
	async size(): Promise<number> {
		return (await this.list()).reduce((total, note) => total + describeNote(note).length + 1, 0);
	}

	async needsCondensing(): Promise<boolean> {
		return (await this.size()) > CONDENSE_AT_CHARS;
	}

	/**
	 * Replaces the notes the explainer condensed (`replacedIds`) with its shorter version. Notes added while it
	 * was condensing aren't among them, so they're kept.
	 */
	async condense(replacedIds: ReadonlySet<string>, condensed: readonly MemoryInput[], context: string): Promise<void> {
		const kept = (await this.list()).filter(note => !replacedIds.has(note.id));
		const at = this.now();
		const notes = [...kept];
		for (const input of condensed) {
			const text = input.note.replace(/\s+/g, ' ').trim().slice(0, MAX_NOTE_CHARS);
			if (text && !notes.some(note => normalize(note.text) === normalize(text))) {
				notes.push({ id: this.newId(notes), scope: input.scope, text, at, source: 'explainer', context });
			}
		}
		await this.save(notes);
	}

	private newId(notes: readonly MemoryNote[]): string {
		const used = new Set(notes.map(note => note.id));
		let index = notes.length + 1;
		while (used.has(`m${index}`)) {
			index++;
		}
		return `m${index}`;
	}

	private async save(all: MemoryNote[]): Promise<void> {
		this.notes = [...all].sort((a, b) => a.at - b.at);
		const snapshot = this.notes;
		this.writing = this.writing.then(async () => {
			for (const scope of ['personal', 'project'] as const) {
				await fs.mkdir(path.dirname(this.files[scope]), { recursive: true });
				await fs.writeFile(this.files[scope], JSON.stringify(snapshot.filter(note => note.scope === scope), null, '\t'), 'utf8');
			}
		});
		await this.writing;
	}
}

function describeNote(note: MemoryNote): string {
	return `- [${note.id}] (${note.scope}${note.source === 'question' ? ', their question' : ''}) ${note.text}`;
}

function normalize(text: string): string {
	return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Reads the explainer's condensed memory (`{"notes": [{scope, note}]}`); `undefined` if it isn't usable. */
export function condensedOf(parsed: unknown): MemoryInput[] | undefined {
	const value = (parsed as { notes?: unknown } | undefined)?.notes;
	if (!Array.isArray(value)) {
		return undefined;
	}
	const notes = value.flatMap(entry => {
		const item = entry as { scope?: unknown; note?: unknown };
		return typeof item?.note === 'string' && item.note.trim() ? [{ scope: item.scope === 'personal' ? 'personal' as const : 'project' as const, note: item.note }] : [];
	});
	return notes.length ? notes : undefined;
}

/** Reads the `remember` field of an explainer reply; anything malformed is ignored. */
export function rememberOf(parsed: unknown): MemoryInput[] {
	const value = (parsed as { remember?: unknown } | undefined)?.remember;
	if (!Array.isArray(value)) {
		return [];
	}
	return value.slice(0, 5).flatMap(entry => {
		const item = entry as { scope?: unknown; note?: unknown; replaces?: unknown };
		if (typeof item?.note !== 'string' || !item.note.trim()) {
			return [];
		}
		const scope: MemoryScope = item.scope === 'personal' ? 'personal' : 'project';
		return [{ scope, note: item.note, ...(typeof item.replaces === 'string' ? { replaces: item.replaces } : {}) }];
	});
}
