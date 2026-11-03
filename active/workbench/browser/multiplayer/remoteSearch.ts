/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../../base/common/cancellation.js';
import { extUriBiasedIgnorePathCase } from '../../../../../base/common/resources.js';
import { URI, UriComponents } from '../../../../../base/common/uri.js';
import { IFileMatch, IFileQuery, IFolderQuery, IRawFileQuery, IRawTextQuery, ISearchComplete, ISearchProgressItem, ISearchResultProvider, ISearchService, ITextQuery } from '../../../../services/search/common/search.js';
import { REMOTE_FILE_SCHEME } from '../activeService.js';

/** A search as it travels between guest and host: folders as the host's paths, results as paths. */
export interface RemoteSearchRequest {
	readonly kind: 'file' | 'text';
	readonly query: IRawFileQuery | IRawTextQuery;
}

export interface RemoteSearchReply {
	readonly results: Array<{ readonly path: string; readonly results?: unknown[] }>;
	readonly limitHit?: boolean;
}

/** How a guest sends a search to the host. */
export interface RemoteSearchSource {
	search(request: RemoteSearchRequest): Promise<RemoteSearchReply>;
}

/**
 * Quick open and Find in Files for a guest: the queries (whose folders are the host's, as `active-remote:` URIs) run on
 * the host, which searches its own files and sends back what matched.
 */
export class RemoteSearchProvider implements ISearchResultProvider {
	source: RemoteSearchSource | undefined;

	async getAIName(): Promise<string | undefined> {
		return undefined;
	}

	fileSearch(query: IFileQuery, token?: CancellationToken): Promise<ISearchComplete> {
		return this.run({ kind: 'file', query }, token);
	}

	async textSearch(query: ITextQuery, onProgress?: (p: ISearchProgressItem) => void, token?: CancellationToken): Promise<ISearchComplete> {
		const complete = await this.run({ kind: 'text', query }, token);
		for (const match of complete.results) {
			onProgress?.(match);
		}
		return complete;
	}

	async clearCache(): Promise<void> { }

	private async run(request: RemoteSearchRequest, token?: CancellationToken): Promise<ISearchComplete> {
		if (!this.source || token?.isCancellationRequested) {
			return { results: [], messages: [] };
		}
		const reply = await this.source.search(request);
		const results: IFileMatch[] = reply.results.map(match => ({ resource: URI.from({ scheme: REMOTE_FILE_SCHEME, path: match.path }), results: match.results as IFileMatch['results'] }));
		return { results, limitHit: reply.limitHit, messages: [] };
	}
}

/** The host side: runs a guest's search on its own files, only inside `roots` (its agents' folders). */
export async function runRemoteSearch(searchService: ISearchService, request: RemoteSearchRequest, roots: readonly URI[]): Promise<RemoteSearchReply> {
	const local = (folder: UriComponents) => URI.file(URI.revive(folder).path);
	const allowed = (folder: URI) => roots.some(root => extUriBiasedIgnorePathCase.isEqualOrParent(folder, root));
	const folderQueries = request.query.folderQueries
		.map((folderQuery: IFolderQuery<UriComponents>): IFolderQuery => ({
			...folderQuery,
			folder: local(folderQuery.folder),
			excludePattern: folderQuery.excludePattern?.map(pattern => ({ ...pattern, folder: pattern.folder ? local(pattern.folder) : undefined })),
		}))
		.filter(folderQuery => allowed(folderQuery.folder));
	if (!folderQueries.length) {
		return { results: [] };
	}
	// Files the guest has open locally mean nothing here.
	const query = { ...request.query, folderQueries, extraFileResources: undefined };
	const complete = request.kind === 'file'
		? await searchService.fileSearch(query as IFileQuery)
		: await searchService.textSearch(query as ITextQuery);
	return {
		results: complete.results.map(match => ({
			path: match.resource.path,
			// Plain data only (the URI inside each match is the host's; the guest's provider supplies the file).
			results: match.results?.map(result => JSON.parse(JSON.stringify({ ...result, uri: undefined }))),
		})),
		limitHit: complete.limitHit,
	};
}
