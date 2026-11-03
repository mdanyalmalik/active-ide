/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, IDisposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { createFileSystemProviderError, FileChangeType, FileSystemProviderCapabilities, FileSystemProviderErrorCode, FileType, IFileChange, IFileDeleteOptions, IFileOverwriteOptions, IFileSystemProviderWithFileReadWriteCapability, IFileWriteOptions, IStat, IWatchOptions } from '../../../../../platform/files/common/files.js';
import { REMOTE_FILE_SCHEME } from '../activeService.js';
import type { RemoteStat } from './sessionProtocol.js';

/** How a guest asks the host for a file (stat, list, read), over the session's data channel. */
export interface RemoteFileSource {
	request<T>(op: 'stat' | 'readdir' | 'readFile', path: string): Promise<T>;
}

/**
 * The host's project as a guest sees it: read-only, fetched on demand. Paths are the host's absolute paths
 * (`active-remote:/Users/sam/project/src/a.js`); the host only serves files under its agents' folders.
 */
export class RemoteFileSystemProvider extends Disposable implements IFileSystemProviderWithFileReadWriteCapability {
	readonly capabilities = FileSystemProviderCapabilities.FileReadWrite | FileSystemProviderCapabilities.Readonly | FileSystemProviderCapabilities.PathCaseSensitive;
	readonly onDidChangeCapabilities = Event.None;
	private readonly _onDidChangeFile = this._register(new Emitter<readonly IFileChange[]>());
	readonly onDidChangeFile = this._onDidChangeFile.event;
	private source: RemoteFileSource | undefined;

	/** Connects to a host (or disconnects, with undefined). */
	setSource(source: RemoteFileSource | undefined): void {
		this.source = source;
	}

	/** The host says these files changed (the agents edit all the time): open editors and the Explorer refresh. */
	changed(paths: readonly string[], deleted: readonly string[] = [], added: readonly string[] = []): void {
		this._onDidChangeFile.fire([
			...added.map(path => ({ type: FileChangeType.ADDED, resource: URI.from({ scheme: REMOTE_FILE_SCHEME, path }) })),
			...paths.map(path => ({ type: FileChangeType.UPDATED, resource: URI.from({ scheme: REMOTE_FILE_SCHEME, path }) })),
			...deleted.map(path => ({ type: FileChangeType.DELETED, resource: URI.from({ scheme: REMOTE_FILE_SCHEME, path }) })),
		]);
	}

	private get connected(): RemoteFileSource {
		if (!this.source) {
			throw createFileSystemProviderError('Not connected to a session.', FileSystemProviderErrorCode.Unavailable);
		}
		return this.source;
	}

	watch(_resource: URI, _opts: IWatchOptions): IDisposable {
		// The host pushes changes for everything it serves.
		return Disposable.None;
	}

	async stat(resource: URI): Promise<IStat> {
		const stat = await this.call<RemoteStat>('stat', resource);
		return { type: stat.type === 'directory' ? FileType.Directory : FileType.File, size: stat.size, mtime: stat.mtime, ctime: stat.ctime, permissions: undefined };
	}

	async readdir(resource: URI): Promise<[string, FileType][]> {
		const entries = await this.call<Array<[string, 'file' | 'directory']>>('readdir', resource);
		return entries.map(([name, type]) => [name, type === 'directory' ? FileType.Directory : FileType.File]);
	}

	async readFile(resource: URI): Promise<Uint8Array> {
		const text = await this.call<string>('readFile', resource);
		return new TextEncoder().encode(text);
	}

	private async call<T>(op: 'stat' | 'readdir' | 'readFile', resource: URI): Promise<T> {
		try {
			return await this.connected.request<T>(op, resource.path);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw createFileSystemProviderError(message, /not found|ENOENT/i.test(message) ? FileSystemProviderErrorCode.FileNotFound : FileSystemProviderErrorCode.Unknown);
		}
	}

	private readOnly(): never {
		throw createFileSystemProviderError('Files in a shared session are read-only.', FileSystemProviderErrorCode.NoPermissions);
	}

	writeFile(_resource: URI, _content: Uint8Array, _opts: IFileWriteOptions): Promise<void> {
		this.readOnly();
	}

	mkdir(_resource: URI): Promise<void> {
		this.readOnly();
	}

	delete(_resource: URI, _opts: IFileDeleteOptions): Promise<void> {
		this.readOnly();
	}

	rename(_from: URI, _to: URI, _opts: IFileOverwriteOptions): Promise<void> {
		this.readOnly();
	}
}
