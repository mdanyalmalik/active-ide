/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ActiveEvent, ChatEntry } from '../../common/activeProtocol.js';
import { serverUrls } from '../../browser/multiplayer/peerLink.js';
import { guestEvent } from '../../browser/multiplayer/multiplayerService.js';
import { runRemoteSearch } from '../../browser/multiplayer/remoteSearch.js';
import { URI } from '../../../../../base/common/uri.js';
import { IFileQuery, ISearchService, QueryType } from '../../../../services/search/common/search.js';
import { CHUNK_SIZE, encodeFrames, formatInvite, FrameDecoder, newInviteKey, parseInvite, SessionMessage, SignalCipher } from '../../browser/multiplayer/sessionProtocol.js';

suite('Active multiplayer', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('small messages are one frame; large ones are split and put back together', () => {
		const small: SessionMessage = { t: 'presence', agentId: 'a1' };
		assert.deepStrictEqual(encodeFrames(small).length, 1);
		assert.deepStrictEqual(new FrameDecoder().push(encodeFrames(small)[0]), small);

		const big: SessionMessage = { t: 'fsResult', id: 7, ok: true, value: 'x'.repeat(CHUNK_SIZE * 3 + 5) };
		const frames = encodeFrames(big);
		assert.ok(frames.length >= 4);
		const decoder = new FrameDecoder();
		// Out of order still works.
		const results = [...frames].reverse().map(frame => decoder.push(frame));
		assert.deepStrictEqual(results.filter(Boolean), [big]);
	});

	test('invite codes round-trip and reject junk', () => {
		const invite = { roomId: 'abcdefghij', key: newInviteKey() };
		assert.deepStrictEqual(parseInvite(` ${formatInvite(invite)} `), invite);
		assert.strictEqual(parseInvite('hello'), undefined);
		assert.strictEqual(parseInvite('abcdefghij.short'), undefined);
	});

	test('signals sealed with the invite key open only with that key', async () => {
		const key = newInviteKey();
		const cipher = await SignalCipher.create(key);
		const sealed = await cipher.seal({ sdp: { type: 'offer', sdp: 'v=0' } });
		assert.ok(!sealed.includes('v=0'));
		assert.deepStrictEqual(await (await SignalCipher.create(key)).open(sealed), { sdp: { type: 'offer', sdp: 'v=0' } });
		await assert.rejects((await SignalCipher.create(newInviteKey())).open(sealed));
	});

	test('guests get the agents but not explanations', () => {
		const entry = (role: ChatEntry['role']): ChatEntry => ({ id: role, role, text: role } as ChatEntry);
		assert.strictEqual(guestEvent({ type: 'walkthroughReady' } as unknown as ActiveEvent), undefined);
		assert.strictEqual(guestEvent({ type: 'chat', entry: entry('explainer') } as ActiveEvent), undefined);
		const agentChat = { type: 'chat', entry: entry('agent') } as ActiveEvent;
		assert.strictEqual(guestEvent(agentChat), agentChat);
		const reset = guestEvent({ type: 'chatReset', chat: [entry('user'), entry('explainer'), entry('agent')] } as unknown as ActiveEvent) as unknown as { chat: ChatEntry[] };
		assert.deepStrictEqual(reset.chat.map(item => item.role), ['user', 'agent']);
	});

	test('the server URL works as http or ws', () => {
		assert.deepStrictEqual(serverUrls('http://127.0.0.1:8787/'), { http: 'http://127.0.0.1:8787', ws: 'ws://127.0.0.1:8787' });
		assert.deepStrictEqual(serverUrls('wss://active.example.workers.dev'), { http: 'https://active.example.workers.dev', ws: 'wss://active.example.workers.dev' });
	});

	test('a guest\'s search runs on the host only inside its agents\' folders', async () => {
		let ran: IFileQuery | undefined;
		const searchService = {
			fileSearch: async (query: IFileQuery) => {
				ran = query;
				return { results: [{ resource: URI.file('/work/project/src/a.js') }], messages: [] };
			},
		} as unknown as ISearchService;
		const remote = (path: string) => URI.from({ scheme: 'active-remote', path }).toJSON();
		const reply = await runRemoteSearch(searchService, {
			kind: 'file',
			query: { type: QueryType.File, filePattern: 'a', folderQueries: [{ folder: remote('/work/project') }, { folder: remote('/etc') }] },
		}, [URI.file('/work/project')]);
		assert.deepStrictEqual(ran?.folderQueries.map(folder => folder.folder.toString()), ['file:///work/project']);
		assert.deepStrictEqual(reply.results.map(result => result.path), ['/work/project/src/a.js']);

		ran = undefined;
		const outside = await runRemoteSearch(searchService, { kind: 'file', query: { type: QueryType.File, folderQueries: [{ folder: remote('/etc') }] } }, [URI.file('/work/project')]);
		assert.strictEqual(ran, undefined);
		assert.deepStrictEqual(outside.results, []);
	});
});
