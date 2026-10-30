/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.muse', '.agents', 'dist', 'out', 'build', '.next', 'coverage', '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.tox', '.venv', 'venv', 'target', '.tools', '.active', '.gradle', '.parcel-cache', '.turbo', '.cache']);
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_FILES = 8000;

export function isIgnoredPath(relativePath: string): boolean {
	return relativePath.split('/').some(segment => IGNORED_DIRECTORIES.has(segment));
}

export function looksBinary(buffer: Buffer): boolean {
	const sample = buffer.subarray(0, Math.min(buffer.length, 8000));
	return sample.includes(0);
}

/**
 * Reads workspace text files relative to a root. Binary, oversized and
 * ignored files are reported as `undefined` (not tracked).
 */
export class WorkspaceFiles {
	constructor(readonly root: string) { }

	absolute(relativePath: string): string {
		return path.join(this.root, ...relativePath.split('/'));
	}

	relative(absolutePath: string): string | undefined {
		const relative = path.relative(this.root, absolutePath);
		if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
			return undefined;
		}
		return relative.split(path.sep).join('/');
	}

	/** Returns the text, `null` if the file does not exist, `undefined` if it is not trackable. */
	async read(relativePath: string): Promise<string | null | undefined> {
		if (isIgnoredPath(relativePath)) {
			return undefined;
		}
		try {
			const stat = await fs.stat(this.absolute(relativePath));
			if (!stat.isFile()) {
				return stat.isDirectory() ? undefined : null;
			}
			if (stat.size > MAX_FILE_BYTES) {
				return undefined;
			}
			const buffer = await fs.readFile(this.absolute(relativePath));
			return looksBinary(buffer) ? undefined : buffer.toString('utf8');
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') {
				return null;
			}
			throw error;
		}
	}

	async mtime(relativePath: string): Promise<number | undefined> {
		try {
			return (await fs.stat(this.absolute(relativePath))).mtimeMs;
		} catch {
			return undefined;
		}
	}

	/** Lists trackable files, using git's view of the tree when available. */
	async list(): Promise<string[]> {
		const fromGit = await this.listFromGit();
		if (fromGit) {
			return fromGit.filter(file => !isIgnoredPath(file)).slice(0, MAX_FILES);
		}
		const files: string[] = [];
		const walk = async (directory: string): Promise<void> => {
			if (files.length >= MAX_FILES) {
				return;
			}
			let entries;
			try {
				entries = await fs.readdir(directory, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (IGNORED_DIRECTORIES.has(entry.name)) {
					continue;
				}
				const absolute = path.join(directory, entry.name);
				if (entry.isDirectory()) {
					await walk(absolute);
				} else if (entry.isFile()) {
					const relative = this.relative(absolute);
					if (relative) {
						files.push(relative);
					}
				}
			}
		};
		await walk(this.root);
		return files;
	}

	private async listFromGit(): Promise<string[] | undefined> {
		try {
			const { stdout } = await execFileAsync('git', ['ls-files', '-co', '--exclude-standard', '-z'], { cwd: this.root, maxBuffer: 64 * 1024 * 1024 });
			return stdout.split('\0').filter(Boolean);
		} catch {
			return undefined;
		}
	}

	/** Files with uncommitted changes relative to HEAD (the user's pre-existing work). */
	async uncommittedFiles(): Promise<Set<string>> {
		try {
			const { stdout } = await execFileAsync('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { cwd: this.root, maxBuffer: 16 * 1024 * 1024 });
			const result = new Set<string>();
			for (const entry of stdout.split('\0')) {
				if (entry.length > 3) {
					result.add(entry.slice(3));
				}
			}
			return result;
		} catch {
			return new Set();
		}
	}

	async branch(): Promise<string | undefined> {
		try {
			const { stdout } = await execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: this.root });
			return stdout.trim() || undefined;
		} catch {
			return undefined;
		}
	}
}
