/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** Commits Active makes on its own agent branches are signed as Active, whatever the developer's git identity. */
const ACTIVE_IDENTITY = ['-c', 'user.name=Active', '-c', 'user.email=active@localhost', '-c', 'commit.gpgsign=false'];

export interface Worktree {
	readonly root: string;
	readonly branch: string;
	/** The commit holding where the agent started (the developer's folder, uncommitted changes included). */
	readonly base: string;
}

export interface WorktreeChange {
	readonly path: string;
	readonly status: 'added' | 'modified' | 'deleted';
}

export interface MergeOutcome {
	/** Files the merge wrote (or deleted) in the target. */
	readonly files: readonly string[];
	/** Files left with conflict markers (or an add/delete clash) for the target agent to resolve. */
	readonly conflicts: readonly string[];
}

/** Changed line ranges of a file, in its base's line numbers (`[start, end]`, inclusive; an insertion is `[n, n]`). */
export type ChangedRanges = ReadonlyArray<readonly [number, number]>;

export function runGit(cwd: string, args: readonly string[], input?: string, okCodes: readonly number[] = [0]): Promise<{ stdout: string; code: number }> {
	return new Promise((resolve, reject) => {
		const child = execFile('git', [...args], { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout, stderr) => {
			const code = error ? (typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : 1) : 0;
			if (error && !okCodes.includes(code)) {
				reject(new Error(`git ${args.slice(0, 3).join(' ')}: ${(stderr || error.message).trim().split('\n').slice(0, 3).join(' ')}`));
				return;
			}
			resolve({ stdout, code });
		});
		if (input !== undefined) {
			child.stdin?.end(input);
		}
	});
}

/** Branch-safe slug of an agent's name. */
export function branchSlug(name: string): string {
	return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'agent';
}

/** Parses `git diff -U0` output into changed ranges per file (old side, so two agents' diffs from one base compare). */
export function parseChangedRanges(diff: string): Map<string, Array<[number, number]>> {
	const ranges = new Map<string, Array<[number, number]>>();
	let file: string | undefined;
	for (const line of diff.split('\n')) {
		if (line.startsWith('+++ ')) {
			const target = line.slice(4);
			file = target === '/dev/null' ? file : target.replace(/^b\//, '');
			continue;
		}
		if (line.startsWith('--- ')) {
			const source = line.slice(4);
			file = source === '/dev/null' ? undefined : source.replace(/^a\//, '');
			continue;
		}
		const hunk = /^@@ -(\d+)(?:,(\d+))? \+\d+(?:,\d+)? @@/.exec(line);
		if (hunk && file) {
			const start = Number(hunk[1]);
			const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
			// A pure insertion after line `start` touches the boundary at `start`.
			const range: [number, number] = count === 0 ? [start, start] : [start, start + count - 1];
			const list = ranges.get(file) ?? [];
			list.push(range);
			ranges.set(file, list);
		}
	}
	return ranges;
}

export function rangesOverlap(a: ChangedRanges, b: ChangedRanges): boolean {
	return a.some(([aStart, aEnd]) => b.some(([bStart, bEnd]) => aStart <= bEnd + 1 && bStart <= aEnd + 1));
}

/**
 * Git worktrees for agents beyond the first, under Active's storage. Each starts from the developer's folder as it
 * is (uncommitted changes and untracked files included), committed on the agent's own branch as its starting point.
 * Merging one agent's work into another's folder is a three-way merge per file against that starting point, so it
 * never needs commits in the developer's own branch.
 */
export class WorktreeManager {
	constructor(private readonly repoRoot: string, private readonly baseDir: string, private readonly log: (line: string) => void) { }

	/** Why worktrees can't be made here, or undefined when they can. */
	async blocker(): Promise<string | undefined> {
		try {
			const { stdout } = await runGit(this.repoRoot, ['rev-parse', '--show-toplevel']);
			if (path.resolve(stdout.trim()) !== path.resolve(this.repoRoot)) {
				return undefined; // a subfolder of a repository works too: the worktree is of the whole repository
			}
			await runGit(this.repoRoot, ['rev-parse', '--verify', 'HEAD']);
			return undefined;
		} catch {
			return 'More agents need a git repository with at least one commit.';
		}
	}

	/** The repository's top folder, and this folder's path inside it. */
	private async layout(): Promise<{ top: string; prefix: string }> {
		const { stdout } = await runGit(this.repoRoot, ['rev-parse', '--show-toplevel']);
		const top = stdout.trim();
		const prefix = path.relative(top, this.repoRoot);
		return { top, prefix };
	}

	async create(id: string, name: string): Promise<Worktree> {
		const { top, prefix } = await this.layout();
		// Named after the agent: Source Control and the status bar show the folder's name.
		const dir = path.join(this.baseDir, `${branchSlug(name)}-${id.slice(-4)}`);
		const branch = `active/${branchSlug(name)}-${id.slice(-4)}`;
		await fs.mkdir(this.baseDir, { recursive: true });
		await runGit(top, ['worktree', 'add', '--quiet', '-b', branch, dir, 'HEAD']);
		try {
			// Start from what the developer sees, not just the last commit.
			const diff = await runGit(top, ['diff', 'HEAD', '--binary'], undefined);
			if (diff.stdout.trim()) {
				await runGit(dir, ['apply', '--binary', '--whitespace=nowarn', '-'], diff.stdout);
			}
			const untracked = (await runGit(top, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean);
			for (const file of untracked) {
				const target = path.join(dir, file);
				await fs.mkdir(path.dirname(target), { recursive: true });
				await fs.copyFile(path.join(top, file), target).catch(() => undefined);
			}
			await runGit(dir, ['add', '-A']);
			await runGit(dir, [...ACTIVE_IDENTITY, 'commit', '--quiet', '--allow-empty', '--no-verify', '-m', `Active: ${name} starts here`]);
		} catch (error) {
			await this.remove({ root: dir, branch, base: '' }).catch(() => undefined);
			throw error;
		}
		const base = (await runGit(dir, ['rev-parse', 'HEAD'])).stdout.trim();
		this.log(`worktree for ${name}: ${dir} on ${branch} from ${base.slice(0, 8)}`);
		// The agent works in the same subfolder the developer opened.
		return { root: prefix ? path.join(dir, prefix) : dir, branch, base };
	}

	/** Commits everything in `root` (the dragged agent's work, before a merge); the commit, or undefined if nothing changed. */
	async commitAll(root: string, message: string): Promise<string | undefined> {
		await runGit(root, ['add', '-A']);
		const staged = await runGit(root, ['diff', '--cached', '--quiet'], undefined, [0, 1]);
		if (staged.code === 0) {
			return undefined;
		}
		await runGit(root, [...ACTIVE_IDENTITY, 'commit', '--quiet', '--no-verify', '-m', message]);
		return (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
	}

	/** The commit `HEAD` names in `root` right now. */
	async head(root: string): Promise<string> {
		return (await runGit(root, ['rev-parse', 'HEAD'])).stdout.trim();
	}

	/** `keepBranch`: remove the worktree folder only (the branch keeps the agent's committed work). */
	async remove(worktree: Worktree, keepBranch = false): Promise<void> {
		const { top } = await this.layout();
		const dir = await this.topOf(worktree.root).catch(() => worktree.root);
		await runGit(top, ['worktree', 'remove', '--force', dir]).catch(error => this.log(`couldn't remove worktree ${dir}: ${error instanceof Error ? error.message : error}`));
		await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
		await runGit(top, ['worktree', 'prune']).catch(() => undefined);
		if (!keepBranch) {
			await runGit(top, ['branch', '-D', worktree.branch]).catch(() => undefined);
		}
	}

	/**
	 * Removes what crashed or interrupted runs left behind: folders under Active's worktree folder and `active/…`
	 * agent branches that no agent uses. Only Active's own names are touched (`active/<name>-<4 chars>`), never other
	 * branches, and never a branch checked out in some worktree.
	 */
	async cleanup(inUse: { readonly roots: readonly string[]; readonly branches: readonly string[] }): Promise<{ folders: string[]; branches: string[] }> {
		const removed = { folders: [] as string[], branches: [] as string[] };
		let top: string;
		try {
			top = (await this.layout()).top;
		} catch {
			return removed; // not a repository: nothing of Active's to clean
		}
		await runGit(top, ['worktree', 'prune']).catch(() => undefined);
		const keepFolders = new Set(await Promise.all(inUse.roots.map(root => this.topOf(root).catch(() => root))));
		const entries = await fs.readdir(this.baseDir, { withFileTypes: true }).catch(() => []);
		for (const entry of entries) {
			const dir = path.join(this.baseDir, entry.name);
			if (!entry.isDirectory() || keepFolders.has(dir)) {
				continue;
			}
			await runGit(top, ['worktree', 'remove', '--force', dir]).catch(() => undefined);
			await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
			removed.folders.push(dir);
		}
		await runGit(top, ['worktree', 'prune']).catch(() => undefined);
		const checkedOut = new Set((await runGit(top, ['worktree', 'list', '--porcelain'])).stdout.split('\n').filter(line => line.startsWith('branch refs/heads/')).map(line => line.slice('branch refs/heads/'.length)));
		const keepBranches = new Set(inUse.branches);
		const branches = (await runGit(top, ['branch', '--list', 'active/*', '--format=%(refname:short)'])).stdout.split('\n').map(line => line.trim()).filter(Boolean);
		for (const branch of branches) {
			if (!/^active\/[a-z0-9-]+-[a-z0-9]{4}$/.test(branch) || keepBranches.has(branch) || checkedOut.has(branch)) {
				continue;
			}
			await runGit(top, ['branch', '-D', branch]).then(() => removed.branches.push(branch), () => undefined);
		}
		if (removed.folders.length || removed.branches.length) {
			this.log(`cleaned up after earlier runs: ${removed.folders.length} worktree folder(s), ${removed.branches.length} branch(es) (${removed.branches.join(', ')})`);
		}
		return removed;
	}

	private async topOf(root: string): Promise<string> {
		return (await runGit(root, ['rev-parse', '--show-toplevel'])).stdout.trim();
	}

	/**
	 * What changed in `root` since `base` (a commit; `HEAD` for the developer's folder): tracked changes plus
	 * untracked files, as paths relative to `root`.
	 */
	async changes(root: string, base: string): Promise<WorktreeChange[]> {
		const tracked = (await runGit(root, ['diff', '--name-status', '--no-renames', '--relative', '-z', base, '--', '.'])).stdout.split('\0').filter(Boolean);
		const changes: WorktreeChange[] = [];
		for (let index = 0; index + 1 < tracked.length; index += 2) {
			const code = tracked[index];
			changes.push({ path: tracked[index + 1], status: code.startsWith('A') ? 'added' : code.startsWith('D') ? 'deleted' : 'modified' });
		}
		for (const file of (await runGit(root, ['ls-files', '--others', '--exclude-standard', '-z'])).stdout.split('\0').filter(Boolean)) {
			changes.push({ path: file, status: 'added' });
		}
		return changes;
	}

	/** Changed line ranges per file since `base`, in `base`'s line numbers. */
	async changedRanges(root: string, base: string): Promise<Map<string, Array<[number, number]>>> {
		const { stdout } = await runGit(root, ['diff', '-U0', '--no-renames', '--relative', base, '--', '.']);
		return parseChangedRanges(stdout);
	}

	/** A file's content at `base` (`null` when it didn't exist). */
	async fileAt(root: string, base: string, relative: string): Promise<string | null> {
		const prefix = path.relative(await this.topOf(root), root);
		const spec = `${base}:${(prefix ? path.join(prefix, relative) : relative).split(path.sep).join('/')}`;
		return runGit(root, ['show', spec]).then(result => result.stdout, () => null);
	}

	/**
	 * Merges what changed in `source` since `sourceBase` into `targetRoot`'s files (three-way per file, with the
	 * source's starting point as the common base). Clean merges are written; clashes are written with conflict
	 * markers (or, for add/delete clashes, the source's version beside the target's) and listed.
	 */
	async merge(source: { root: string; base: string; name: string }, target: { root: string; name: string }): Promise<MergeOutcome> {
		const files: string[] = [];
		const conflicts: string[] = [];
		const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'active-merge-'));
		try {
			for (const change of await this.changes(source.root, source.base)) {
				const relative = change.path;
				const theirs = await readOrNull(path.join(source.root, relative));
				const base = await this.fileAt(source.root, source.base, relative);
				const targetFile = path.join(target.root, relative);
				const ours = await readOrNull(targetFile);
				if (theirs === base || theirs === ours) {
					continue;
				}
				if (ours === base) {
					await writeOrDelete(targetFile, theirs);
					files.push(relative);
					continue;
				}
				if (theirs === null || ours === null || base === null) {
					// One side deleted (or both added) the file: keep the target's version and put the source's beside it.
					if (theirs !== null) {
						await writeOrDelete(`${targetFile}.from-${branchSlug(source.name)}`, theirs);
					}
					files.push(relative);
					conflicts.push(relative);
					continue;
				}
				const oursFile = path.join(scratch, 'ours');
				const baseFile = path.join(scratch, 'base');
				const theirsFile = path.join(scratch, 'theirs');
				await fs.writeFile(oursFile, ours);
				await fs.writeFile(baseFile, base);
				await fs.writeFile(theirsFile, theirs);
				// Exit code: the number of conflicts (capped at 127); negative on error.
				const merged = await runGit(scratch, ['merge-file', '-p', '-L', target.name, '-L', 'starting point', '-L', source.name, oursFile, baseFile, theirsFile], undefined, Array.from({ length: 128 }, (_, index) => index));
				await fs.writeFile(targetFile, merged.stdout);
				files.push(relative);
				if (merged.code > 0) {
					conflicts.push(relative);
				}
			}
		} finally {
			await fs.rm(scratch, { recursive: true, force: true }).catch(() => undefined);
		}
		return { files, conflicts };
	}
}

async function readOrNull(file: string): Promise<string | null> {
	return fs.readFile(file, 'utf8').catch(() => null);
}

async function writeOrDelete(file: string, content: string | null): Promise<void> {
	if (content === null) {
		await fs.rm(file, { force: true });
		return;
	}
	await fs.mkdir(path.dirname(file), { recursive: true });
	await fs.writeFile(file, content);
}
