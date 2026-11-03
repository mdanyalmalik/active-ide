/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { MarkdownString } from '../../../../../base/common/htmlContent.js';
import { extUri } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { remapResourceString, WorkspaceRootOverrides } from '../../../../../platform/workspace/common/workspaceRootOverride.js';
import { WorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';
import { AgentInfo } from '../../common/activeProtocol.js';
import { agentBadge, agentForResource, remapResource } from '../../browser/worktreeFollow.js';

const main = URI.file('/work/project');
const tree2 = URI.file('/storage/worktrees/agent-2');
const tree3 = URI.file('/storage/worktrees/agent-3');

function agent(id: string, root: URI, extra: Partial<AgentInfo> = {}): AgentInfo {
	return { id, name: `Agent ${id}`, colorIndex: 0, kind: 'agent', root: root.fsPath, inMainFolder: false, status: 'idle', waitingForApproval: false, explainMode: 'auto', createdAt: 0, ...extra } as AgentInfo;
}

suite('Active worktree follow', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('remaps a file to the same path in the other tree', () => {
		assert.strictEqual(remapResource(URI.file('/work/project/src/a.ts'), main, tree2, extUri)?.fsPath, URI.file('/storage/worktrees/agent-2/src/a.ts').fsPath);
		assert.strictEqual(remapResource(main, main, tree2, extUri)?.fsPath, tree2.fsPath);
		assert.strictEqual(remapResource(URI.file('/storage/worktrees/agent-2/x/y.md'), tree2, tree3, extUri)?.fsPath, URI.file('/storage/worktrees/agent-3/x/y.md').fsPath);
	});

	test('leaves files outside the old tree alone, including siblings sharing a name prefix', () => {
		assert.strictEqual(remapResource(URI.file('/work/other/a.ts'), main, tree2, extUri), undefined);
		assert.strictEqual(remapResource(URI.file('/work/project-old/a.ts'), main, tree2, extUri), undefined);
		assert.strictEqual(remapResource(URI.parse('untitled:Untitled-1'), main, tree2, extUri), undefined);
	});

	test('badges', () => {
		assert.strictEqual(agentBadge('Agent 2'), '2');
		assert.strictEqual(agentBadge('Agent 12'), '12');
		assert.strictEqual(agentBadge('refactor auth'), 'R');
		assert.strictEqual(agentBadge('  '), '•');
	});

	test('finds whose folder a file is in', () => {
		const agents = [
			agent('1', main, { inMainFolder: true }),
			agent('2', tree2),
			agent('2a', tree2, { kind: 'subagent', parentId: '2' }),
			agent('2b', URI.joinPath(tree2, '.sub/b'), { kind: 'subagent', parentId: '2', readOnly: true }),
		];
		assert.strictEqual(agentForResource(URI.joinPath(tree2, 'src/a.ts'), agents, main, extUri)?.id, '2');
		assert.strictEqual(agentForResource(URI.joinPath(tree2, '.sub/b/c.ts'), agents, main, extUri)?.id, '2b');
		assert.strictEqual(agentForResource(URI.joinPath(main, 'a.ts'), agents, main, extUri)?.id, '1');
		assert.strictEqual(agentForResource(URI.file('/elsewhere/a.ts'), agents, main, extUri), undefined);
	});

	test('the override maps the workspace folder, and only it', () => {
		const overrides = new WorkspaceRootOverrides();
		try {
			const folders = [new WorkspaceFolder({ uri: main, name: 'project', index: 0 }), new WorkspaceFolder({ uri: URI.file('/work/docs'), name: 'docs', index: 1 })];
			assert.strictEqual(overrides.map(main), main);
			assert.strictEqual(overrides.contains(URI.joinPath(main, 'a.ts')), undefined);

			let changes = 0;
			const listener = overrides.onDidChange(() => changes++);
			overrides.set({ folder: main, root: tree2, label: 'Agent 2' });
			overrides.set({ folder: main, root: tree2, label: 'Agent 2' });
			assert.strictEqual(changes, 1);
			listener.dispose();

			assert.strictEqual(overrides.map(main).fsPath, tree2.fsPath);
			assert.strictEqual(overrides.map(undefined), undefined);
			const mapped = overrides.mapWorkspaceFolders(folders);
			assert.strictEqual(mapped[0].uri.fsPath, tree2.fsPath);
			assert.strictEqual(mapped[0].toResource('src/a.ts').fsPath, URI.joinPath(tree2, 'src/a.ts').fsPath);
			assert.strictEqual(mapped[1], folders[1]);
			assert.strictEqual(overrides.contains(URI.joinPath(tree2, 'a.ts')), true);
			assert.strictEqual(overrides.contains(URI.joinPath(main, 'a.ts')), false);
			assert.strictEqual(overrides.contains(URI.file('/work/docs/a.md')), undefined);
			assert.ok(overrides.isOverrideRoot(tree2));

			overrides.set(undefined);
			assert.strictEqual(overrides.map(main), main);
		} finally {
			overrides.dispose();
		}
	});

	test('tree view state follows to the new root', () => {
		const overrides = new WorkspaceRootOverrides();
		try {
			overrides.set({ folder: main, root: tree2, label: 'Agent 2' });
			const id = (uri: URI) => `${main.toString()}::${uri.toString()}`;
			const state = overrides.remapViewState({ expanded: [id(URI.joinPath(main, 'src'))], focus: [], scrollTop: 10 });
			assert.deepStrictEqual(state.expanded, [`${tree2.toString()}::${URI.joinPath(tree2, 'src').toString()}`]);
			assert.strictEqual((state as { scrollTop?: number }).scrollTop, 10);

			// From one worktree to another, then back to the developer's folder.
			overrides.set({ folder: main, root: tree3, label: 'Agent 3' });
			assert.strictEqual(overrides.remapId(URI.joinPath(tree2, 'a').toString()), URI.joinPath(tree3, 'a').toString());
			overrides.set(undefined);
			assert.strictEqual(overrides.remapId(URI.joinPath(tree3, 'a').toString()), URI.joinPath(main, 'a').toString());
		} finally {
			overrides.dispose();
		}
	});

	test('remapping resource strings only replaces whole path segments', () => {
		assert.strictEqual(remapResourceString('file:///a/wt::file:///a/wt/x', 'file:///a/wt', 'file:///b'), 'file:///b::file:///b/x');
		assert.strictEqual(remapResourceString('file:///a/wt2/x', 'file:///a/wt', 'file:///b'), 'file:///a/wt2/x');
		assert.strictEqual(remapResourceString('file:///a/wt', 'file:///a/wt', 'file:///b'), 'file:///b');
	});

	test('extra roots label and protect worktree files', () => {
		const overrides = new WorkspaceRootOverrides();
		try {
			let changes = 0;
			const listener = overrides.onDidChangeRoots(() => changes++);
			const nested = URI.joinPath(tree2, 'sub');
			overrides.setRoots([{ root: tree2, name: 'Agent 2' }, { root: nested, name: 'Helper', readonly: new MarkdownString('read-only') }]);
			overrides.setRoots([{ root: tree2, name: 'Agent 2' }, { root: nested, name: 'Helper', readonly: new MarkdownString('read-only') }]);
			assert.strictEqual(changes, 1);
			listener.dispose();

			assert.strictEqual(overrides.folderOf(URI.joinPath(tree2, 'a.ts'))?.name, 'Agent 2');
			assert.strictEqual(overrides.folderOf(URI.joinPath(nested, 'a.ts'))?.name, 'Helper');
			assert.strictEqual(overrides.folderOf(URI.joinPath(main, 'a.ts')), null);
			assert.strictEqual(overrides.readonlyMessage(URI.joinPath(tree2, 'a.ts')), undefined);
			assert.strictEqual(overrides.readonlyMessage(URI.joinPath(nested, 'a.ts'))?.value, 'read-only');
		} finally {
			overrides.dispose();
		}
	});
});
