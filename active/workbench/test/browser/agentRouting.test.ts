/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { AgentInfo } from '../../common/activeProtocol.js';
import { agentForResource, liveAgent } from '../../browser/activeService.js';

suite('Active agent routing', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const agent = (id: string, root: string, extra: Partial<AgentInfo> = {}): AgentInfo => ({
		id, name: id, colorIndex: 0, kind: 'agent', root, inMainFolder: id === 'main', status: 'idle', waitingForApproval: false, ...extra,
	} as AgentInfo);
	const agents = [
		agent('main', '/work/app'),
		// A worktree inside the main folder: the innermost root wins.
		agent('a2', '/work/app/.active/worktrees/a2'),
		agent('a3', '/work/app-a3'),
		agent('sub', '/work/app-a3/.muse/sub', { kind: 'subagent', parentId: 'a3' }),
		agent('old', '/work/app-old', { mergedInto: 'a2' }),
	];
	const rootOf = (id: string) => {
		const info = agents.find(a => a.id === id);
		return info && URI.file(info.root);
	};
	const owner = (path: string) => agentForResource(agents, rootOf, URI.file(path));

	test('a file goes to the agent whose worktree it is in; files elsewhere to nobody', () => {
		assert.deepStrictEqual(
			['/work/app/src/a.js', '/work/app/.active/worktrees/a2/src/a.js', '/work/app-a3/src/a.js', '/work/app-a3/.muse/sub/x.js', '/work/app-old/y.js', '/tmp/z.js'].map(owner),
			['main', 'a2', 'a3', 'a3', 'a2', undefined],
		);
	});

	test('subagents and merged agents hand messages on; unknown agents fall back to the main one', () => {
		assert.deepStrictEqual(['a3', 'sub', 'old', 'gone', undefined].map(id => liveAgent(agents, id)), ['a3', 'a3', 'a2', 'main', 'main']);
	});
});
