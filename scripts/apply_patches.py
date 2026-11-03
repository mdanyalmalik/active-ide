#!/usr/bin/env python3
"""Idempotent edits to the Code OSS checkout. Everything else Active needs lives in
src/vs/workbench/contrib/active and extensions/active-agent."""
import json
import pathlib
import sys

root = pathlib.Path(sys.argv[1])


def patch(path, old, new, marker):
    file = root / path
    text = file.read_text()
    if marker in text:
        return
    if old not in text:
        sys.exit(f"patch anchor not found in {path}: {old!r}")
    file.write_text(text.replace(old, new, 1))
    print(f"patched {path}")


# 1. Load the Active workbench contribution.
patch(
    "src/vs/workbench/workbench.common.main.ts",
    "import './contrib/files/browser/files.contribution.js';",
    "import './contrib/files/browser/files.contribution.js';\n\n// Active\nimport './contrib/active/browser/active.contribution.js';",
    "contrib/active/browser/active.contribution.js",
)

# 2. Let narration audio (generated in memory, never saved) play from blob: URLs.
for html in ("src/vs/code/electron-browser/workbench/workbench.html", "src/vs/code/electron-browser/workbench/workbench-dev.html"):
    patch(html, "media-src\n\t\t\t\t\t'self'\n", "media-src\n\t\t\t\t\t'self'\n\t\t\t\t\tblob:\n", "'self'\n\t\t\t\t\tblob:\n\t\t\t\t;\n\t\t\t\tframe-src")
    # Code traces colour their snippets with the editor's tokenizer, which produces HTML (through this policy only).
    patch(html, "\t\t\t\t\tchatDebugTokenizer\n", "\t\t\t\t\tchatDebugTokenizer\n\t\t\t\t\tactiveCodeTokenizer\n", "activeCodeTokenizer")

# 3. Walkthrough narration starts automatically when chat hands off to it.
patch(
    "src/vs/platform/windows/electron-main/windows.ts",
    "autoplayPolicy: 'user-gesture-required',",
    "autoplayPolicy: 'no-user-gesture-required', // Active: narrated walkthroughs start on handoff",
    "Active: narrated walkthroughs start on handoff",
)

# 5. Active's settings come first in the Settings editor, and its model choices are commonly used.
patch(
    "src/vs/workbench/contrib/preferences/browser/settingsLayout.ts",
    "\tchildren: [\n\t\t{\n\t\t\tid: 'editor',\n",
    "\tchildren: [\n\t\t{\n\t\t\tid: 'active',\n\t\t\tlabel: localize('activeSettings', \"Active\"),\n\t\t\tsettings: ['active.*'],\n\t\t\tchildren: [\n\t\t\t\t{ id: 'active/coding', label: localize('activeCoding', \"Coding Agent\"), settings: ['active.coding.*', 'active.agent.*', 'active.muse.*'] },\n\t\t\t\t{ id: 'active/explanation', label: localize('activeExplanation', \"Explanations\"), settings: ['active.explanation.*', 'active.explain.*', 'active.walkthrough.*'] },\n\t\t\t\t{ id: 'active/narration', label: localize('activeNarration', \"Voice\"), settings: ['active.narration.*'] },\n\t\t\t]\n\t\t},\n\t\t{\n\t\t\tid: 'editor',\n",
    "id: 'active/coding'",
)
patch(
    "src/vs/workbench/contrib/preferences/browser/settingsLayout.ts",
    "const COMMONLY_USED_SETTINGS: readonly string[] = [\n",
    "const COMMONLY_USED_SETTINGS: readonly string[] = [\n\t'active.coding.model',\n\t'active.coding.reasoningEffort',\n\t'active.explanation.model',\n\t'active.explanation.reasoningEffort',\n\t'active.narration.voice',\n",
    "'active.coding.reasoningEffort',",
)

# 6. A filter on file decorations, so Active can show the agent's changes instead of git's in the
#    Explorer, editor tabs and breadcrumbs (Active's "Agent" / "Git" switch).
patch(
    "src/vs/workbench/services/decorations/common/decorations.ts",
    "export interface IResourceDecorationChangeEvent {",
    "/**\n * Hides decorations it rejects, wherever decorations are shown. `providerLabel` is the provider's label\n * (an extension's identifier for decorations contributed by extensions).\n */\nexport interface IDecorationsFilter {\n\treadonly onDidChange: Event<void>;\n\taccepts(providerLabel: string, data: IDecorationData): boolean;\n}\n\nexport interface IResourceDecorationChangeEvent {",
    "export interface IDecorationsFilter",
)
patch(
    "src/vs/workbench/services/decorations/common/decorations.ts",
    "\tregisterDecorationsProvider(provider: IDecorationsProvider): IDisposable;\n",
    "\tregisterDecorationsProvider(provider: IDecorationsProvider): IDisposable;\n\n\tregisterDecorationsFilter(filter: IDecorationsFilter): IDisposable;\n",
    "registerDecorationsFilter(filter: IDecorationsFilter): IDisposable;",
)
patch(
    "src/vs/workbench/services/decorations/browser/decorationsService.ts",
    "import { IDecorationsService, IDecoration, IResourceDecorationChangeEvent, IDecorationsProvider, IDecorationData } from '../common/decorations.js';",
    "import { IDecorationsService, IDecoration, IResourceDecorationChangeEvent, IDecorationsProvider, IDecorationData, IDecorationsFilter } from '../common/decorations.js';",
    "IDecorationData, IDecorationsFilter } from '../common/decorations.js';",
)
patch(
    "src/vs/workbench/services/decorations/browser/decorationsService.ts",
    "\tprivate readonly _provider = new LinkedList<IDecorationsProvider>();\n",
    "\tprivate readonly _provider = new LinkedList<IDecorationsProvider>();\n\tprivate readonly _filters = new Set<IDecorationsFilter>();\n",
    "private readonly _filters = new Set<IDecorationsFilter>();",
)
patch(
    "src/vs/workbench/services/decorations/browser/decorationsService.ts",
    "\tprivate _ensureEntry(uri: URI): DecorationEntry {",
    "\tregisterDecorationsFilter(filter: IDecorationsFilter): IDisposable {\n\t\tconst everything = () => this._onDidChangeDecorations.fire({ affectsResource() { return true; } });\n\t\tthis._filters.add(filter);\n\t\tconst listener = filter.onDidChange(everything);\n\t\teverything();\n\t\treturn toDisposable(() => {\n\t\t\tthis._filters.delete(filter);\n\t\t\tlistener.dispose();\n\t\t\teverything();\n\t\t});\n\t}\n\n\tprivate _accepts(provider: IDecorationsProvider, data: IDecorationData): boolean {\n\t\tfor (const filter of this._filters) {\n\t\t\tif (!filter.accepts(provider.label, data)) {\n\t\t\t\treturn false;\n\t\t\t}\n\t\t}\n\t\treturn true;\n\t}\n\n\tprivate _ensureEntry(uri: URI): DecorationEntry {",
    "registerDecorationsFilter(filter: IDecorationsFilter): IDisposable {",
)
patch(
    "src/vs/workbench/services/decorations/browser/decorationsService.ts",
    "\t\t\tif (data && !(data instanceof DecorationDataRequest)) {\n\t\t\t\t// having data\n\t\t\t\tall.push(data);",
    "\t\t\tif (data && !(data instanceof DecorationDataRequest) && this._accepts(provider, data)) {\n\t\t\t\t// having data\n\t\t\t\tall.push(data);",
    "!(data instanceof DecorationDataRequest) && this._accepts(provider, data)) {\n\t\t\t\t// having data",
)
patch(
    "src/vs/workbench/services/decorations/browser/decorationsService.ts",
    "\t\t\t\t\tfor (const data of tuple[1].values()) {\n\t\t\t\t\t\tif (data && !(data instanceof DecorationDataRequest)) {",
    "\t\t\t\t\tfor (const [provider, data] of tuple[1]) {\n\t\t\t\t\t\tif (data && !(data instanceof DecorationDataRequest) && this._accepts(provider, data)) {",
    "for (const [provider, data] of tuple[1]) {",
)
patch(
    "src/vs/workbench/test/browser/workbenchTestServices.ts",
    "\tregisterDecorationsProvider(_provider: IDecorationsProvider): IDisposable { return Disposable.None; }\n",
    "\tregisterDecorationsProvider(_provider: IDecorationsProvider): IDisposable { return Disposable.None; }\n\tregisterDecorationsFilter(): IDisposable { return Disposable.None; }\n",
    "registerDecorationsFilter(): IDisposable { return Disposable.None; }",
)

# 7. Active's walkthrough guides the Explorer: it outlines the file being explained and opens the folders
#    on the way to it (closing them again afterwards). It needs the Explorer's tree and where a row sits.
patch(
    "src/vs/base/browser/ui/tree/asyncDataTree.ts",
    "\tgetRelativeTop(element: T): number | null {\n\t\treturn this.tree.getRelativeTop(this.getDataNode(element));\n\t}\n",
    "\tgetRelativeTop(element: T): number | null {\n\t\treturn this.tree.getRelativeTop(this.getDataNode(element));\n\t}\n\n\t/** The element's top in the tree's content, or `undefined` when it isn't shown (Active). */\n\tgetElementTop(element: T): number | undefined {\n\t\treturn this.nodes.has(element) ? this.tree.getElementTop(this.getDataNode(element)) : undefined;\n\t}\n",
    "getElementTop(element: T): number | undefined {",
)
patch(
    "src/vs/workbench/contrib/files/browser/views/explorerView.ts",
    "\thasFocus(): boolean {\n",
    "\t/** The files tree, for Active's walkthrough guide (an outline on the file being explained). */\n\tget activeTree(): WorkbenchCompressibleAsyncDataTree<ExplorerItem | ExplorerItem[], ExplorerItem, FuzzyScore> {\n\t\treturn this.tree;\n\t}\n\n\thasFocus(): boolean {\n",
    "get activeTree(): WorkbenchCompressibleAsyncDataTree",
)

# Hidden debug sessions (the coding agent's debugging, started with suppressDebugView/Toolbar/Statusbar) stay hidden:
# js-debug starts a child session per process without those options, so children inherit them from their parent,
# and a hidden session never opens the Debug Console, an editor at the paused line, or the Run and Debug view.
for name in ("Statusbar", "Toolbar", "View"):
    patch(
        "src/vs/workbench/contrib/debug/browser/debugSession.ts",
        f"\t\treturn this._options.suppressDebug{name} ?? false;\n",
        f"\t\treturn this._options.suppressDebug{name} ?? this._options.parentSession?.suppressDebug{name} ?? false; // Active: children of hidden sessions stay hidden\n",
        f"this._options.parentSession?.suppressDebug{name}",
    )
patch(
    "src/vs/workbench/contrib/debug/browser/debugService.ts",
    "\t\t\tif (internalConsoleOptions === 'openOnSessionStart' || (this.viewModel.firstSessionStart && internalConsoleOptions === 'openOnFirstSessionStart')) {\n",
    "\t\t\tif (!session.suppressDebugView && (internalConsoleOptions === 'openOnSessionStart' || (this.viewModel.firstSessionStart && internalConsoleOptions === 'openOnFirstSessionStart'))) { // Active: hidden sessions\n",
    "if (!session.suppressDebugView && (internalConsoleOptions",
)
patch(
    "src/vs/workbench/contrib/debug/browser/debugSession.ts",
    "\t\t\t\t\t\tif (focusedThreadDoesNotExist || (!event.preserveFocusHint && thread.getCallStack().length)) {\n",
    "\t\t\t\t\t\tif (!this.suppressDebugView && (focusedThreadDoesNotExist || (!event.preserveFocusHint && thread.getCallStack().length))) { // Active: a hidden session's pauses don't take focus\n",
    "if (!this.suppressDebugView && (focusedThreadDoesNotExist",
)

# 8. The workbench follows the highlighted agent's worktree (Active's worktreeFollow.ts) without changing the workspace
#    folders, which would restart the extension host and the agents with it. A small override in platform/workspace
#    re-roots the Explorer, Search, Quick Open and new terminals, labels worktree paths like workspace paths, and makes
#    subagents' worktrees read-only. With no override set (the agent in the developer's folder), all of it is stock.
def write(path, content):
    file = root / path
    if not file.exists() or file.read_text() != content:
        file.write_text(content)
        print(f"wrote {path}")


write("src/vs/platform/workspace/common/workspaceRootOverride.ts", '''/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Active: written by scripts/apply_patches.py (edit it there).

import { Emitter, Event } from '../../../base/common/event.js';
import { IMarkdownString } from '../../../base/common/htmlContent.js';
import { basename, extUriBiasedIgnorePathCase } from '../../../base/common/resources.js';
import { URI } from '../../../base/common/uri.js';
import { IWorkspaceFolder, WorkspaceFolder } from './workspace.js';

/**
 * Shows another folder (an agent's git worktree) in place of a workspace folder in the Explorer, Search, Quick Open
 * and new terminals. The workspace's real folders don't change: changing them restarts the extension host, and with it
 * the agents. Extensions, settings and storage keep seeing the real folders.
 */
export interface IWorkspaceRootOverride {
	/** The workspace folder that is shown as `root`. */
	readonly folder: URI;
	readonly root: URI;
	/** The Explorer's title instead of the workspace name. */
	readonly label: string;
}

/** A folder outside the workspace whose files are labelled like a workspace folder's (paths relative to it). */
export interface IOverrideRoot {
	readonly root: URI;
	readonly name: string;
	/** Set when its files can't be changed here: why. */
	readonly readonly?: IMarkdownString;
}

export class WorkspaceRootOverrides {
	private _current: IWorkspaceRootOverride | undefined;
	/** The last switch, so tree view state (expanded folders) carries over to the new root. */
	private _moved: { readonly from: string; readonly to: string } | undefined;
	private _roots: readonly IOverrideRoot[] = [];

	private readonly _onDidChange = new Emitter<void>();
	/** The override changed (the Explorer, Search and the rest re-root). */
	readonly onDidChange: Event<void> = this._onDidChange.event;
	private readonly _onDidChangeRoots = new Emitter<void>();
	/** The extra roots (or which are read-only) changed. */
	readonly onDidChangeRoots: Event<void> = this._onDidChangeRoots.event;

	get current(): IWorkspaceRootOverride | undefined {
		return this._current;
	}

	get roots(): readonly IOverrideRoot[] {
		return this._roots;
	}

	set(override: IWorkspaceRootOverride | undefined): void {
		const before = this._current;
		if (before === override || (before && override && before.label === override.label && extUriBiasedIgnorePathCase.isEqual(before.folder, override.folder) && extUriBiasedIgnorePathCase.isEqual(before.root, override.root))) {
			return;
		}
		const from = before?.root ?? override?.folder;
		const to = override?.root ?? before?.folder;
		if (from && to && !extUriBiasedIgnorePathCase.isEqual(from, to)) {
			this._moved = { from: from.toString(), to: to.toString() };
		}
		this._current = override;
		this._onDidChange.fire();
	}

	setRoots(roots: readonly IOverrideRoot[]): void {
		const same = roots.length === this._roots.length && roots.every((root, index) => {
			const other = this._roots[index];
			return root.name === other.name && root.readonly?.value === other.readonly?.value && extUriBiasedIgnorePathCase.isEqual(root.root, other.root);
		});
		if (!same) {
			this._roots = roots;
			this._onDidChangeRoots.fire();
		}
	}

	/** The folder to show for workspace folder `uri`. */
	map<T extends URI | undefined>(uri: T): T {
		const current = this._current;
		return (uri && current && extUriBiasedIgnorePathCase.isEqual(uri, current.folder) ? current.root : uri) as T;
	}

	mapWorkspaceFolders(folders: readonly IWorkspaceFolder[]): IWorkspaceFolder[] {
		const current = this._current;
		return folders.map(folder => current && extUriBiasedIgnorePathCase.isEqual(folder.uri, current.folder)
			? new WorkspaceFolder({ uri: current.root, name: basename(current.root) || folder.name, index: folder.index })
			: folder);
	}

	/** Whether the shown folders contain `uri` (undefined: there's no override, ask the workspace). */
	contains(uri: URI): boolean | undefined {
		const current = this._current;
		if (!current) {
			return undefined;
		}
		if (extUriBiasedIgnorePathCase.isEqualOrParent(uri, current.root)) {
			return true;
		}
		return extUriBiasedIgnorePathCase.isEqualOrParent(uri, current.folder) ? false : undefined;
	}

	/** True for the folder shown in place of a workspace folder. */
	isOverrideRoot(uri: URI): boolean {
		return !!this._current && extUriBiasedIgnorePathCase.isEqual(uri, this._current.root);
	}

	/** The extra root containing `resource` as a workspace folder, so labels show paths relative to it. */
	folderOf(resource: URI): IWorkspaceFolder | null {
		const root = this.rootOf(resource);
		return root ? new WorkspaceFolder({ uri: root.root, name: root.name, index: 0 }) : null;
	}

	readonlyMessage(resource: URI): IMarkdownString | undefined {
		return this.rootOf(resource)?.readonly;
	}

	/** Moves ids of tree items (which contain resource strings) from the previous root to the current one. */
	remapId(id: string): string {
		return this._moved ? remapResourceString(id, this._moved.from, this._moved.to) : id;
	}

	remapViewState<T extends { readonly focus?: string[]; readonly selection?: string[]; readonly expanded?: string[] }>(state: T): T {
		if (!this._moved) {
			return state;
		}
		const remap = (ids: string[] | undefined) => ids?.map(id => this.remapId(id));
		return { ...state, focus: remap(state.focus), selection: remap(state.selection), expanded: remap(state.expanded) };
	}

	private rootOf(resource: URI): IOverrideRoot | undefined {
		let best: IOverrideRoot | undefined;
		for (const root of this._roots) {
			if (extUriBiasedIgnorePathCase.isEqualOrParent(resource, root.root) && (!best || root.root.path.length > best.root.path.length)) {
				best = root;
			}
		}
		return best;
	}

	dispose(): void {
		this._onDidChange.dispose();
		this._onDidChangeRoots.dispose();
	}
}

/** Replaces `from` with `to` wherever it appears as a whole resource or a parent of one (not a mere prefix of a name). */
export function remapResourceString(value: string, from: string, to: string): string {
	if (!from || from === to) {
		return value;
	}
	let result = '';
	let index = 0;
	for (; ;) {
		const found = value.indexOf(from, index);
		if (found < 0) {
			return result + value.slice(index);
		}
		const next = value.charAt(found + from.length);
		const whole = next === '' || next === '/' || next === ':';
		result += value.slice(index, found) + (whole ? to : from);
		index = found + from.length;
	}
}

/** The one override for this window (the workbench has a single set of workspace folders). */
export const workspaceRootOverride = new WorkspaceRootOverrides();
''')


def import_override(path, anchor, depth):
    up = "../" * depth
    patch(path, anchor, f"{anchor}\nimport {{ workspaceRootOverride }} from '{up}platform/workspace/common/workspaceRootOverride.js';", "platform/workspace/common/workspaceRootOverride.js';")


# Explorer: its roots, finding items under the worktree, its title, its filter (files.exclude, .gitignore), and
# keeping the same folders open when it switches between trees.
explorer_model = "src/vs/workbench/contrib/files/common/explorerModel.ts"
import_override(explorer_model, "import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';", 4)
patch(
    explorer_model,
    "\t\tconst setRoots = () => this._roots = this.contextService.getWorkspace().folders\n",
    "\t\tconst setRoots = () => this._roots = workspaceRootOverride.mapWorkspaceFolders(this.contextService.getWorkspace().folders) // Active: an agent's worktree\n",
    "workspaceRootOverride.mapWorkspaceFolders(this.contextService.getWorkspace().folders) // Active: an agent's worktree",
)
patch(
    explorer_model,
    "\t\tthis._listener = this.contextService.onDidChangeWorkspaceFolders(() => {\n",
    "\t\tthis._listener = Event.any<unknown>(this.contextService.onDidChangeWorkspaceFolders, workspaceRootOverride.onDidChange)(() => {\n",
    "Event.any<unknown>(this.contextService.onDidChangeWorkspaceFolders, workspaceRootOverride.onDidChange)",
)
patch(
    explorer_model,
    "\tfindClosest(resource: URI): ExplorerItem | null {\n\t\tconst folder = this.contextService.getWorkspaceFolder(resource);\n",
    "\tfindClosest(resource: URI): ExplorerItem | null {\n\t\t// Active: the worktree shown in place of a workspace folder isn't one itself.\n\t\tconst overrideRoot = this.roots.find(r => workspaceRootOverride.isOverrideRoot(r.resource) && this.uriIdentityService.extUri.isEqualOrParent(resource, r.resource));\n\t\tif (overrideRoot) {\n\t\t\treturn overrideRoot.find(resource);\n\t\t}\n\t\tconst folder = this.contextService.getWorkspaceFolder(resource);\n",
    "const overrideRoot = this.roots.find(r => workspaceRootOverride.isOverrideRoot(r.resource)",
)
explorer_view = "src/vs/workbench/contrib/files/browser/views/explorerView.ts"
import_override(explorer_view, "import { isUntitledWorkspace, IWorkspace, IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';", 5)
patch(
    explorer_view,
    "\tget name(): string {\n\t\treturn this.labelService.getWorkspaceLabel(this.contextService.getWorkspace());\n",
    "\tget name(): string {\n\t\treturn workspaceRootOverride.current?.label ?? this.labelService.getWorkspaceLabel(this.contextService.getWorkspace()); // Active: whose tree it is\n",
    "workspaceRootOverride.current?.label ?? this.labelService.getWorkspaceLabel",
)
patch(
    explorer_view,
    "\t\tthis._register(this.labelService.onDidChangeFormatters(setHeader));\n",
    "\t\tthis._register(this.labelService.onDidChangeFormatters(setHeader));\n\t\tthis._register(workspaceRootOverride.onDidChange(setHeader)); // Active\n",
    "this._register(workspaceRootOverride.onDidChange(setHeader));",
)
patch(
    explorer_view,
    "\t\t\tviewState = this.tree.getViewState();\n",
    "\t\t\tviewState = workspaceRootOverride.remapViewState(this.tree.getViewState()); // Active: the same folders stay open in the other tree\n",
    "workspaceRootOverride.remapViewState(this.tree.getViewState())",
)
explorer_viewer = "src/vs/workbench/contrib/files/browser/views/explorerViewer.ts"
import_override(explorer_viewer, "import { isTemporaryWorkspace, IWorkspaceContextService, WorkbenchState } from '../../../../../platform/workspace/common/workspace.js';", 5)
patch(
    explorer_viewer,
    "\t\tthis.toDispose.push(this.contextService.onDidChangeWorkspaceFolders(() => this.updateConfiguration()));\n",
    "\t\tthis.toDispose.push(this.contextService.onDidChangeWorkspaceFolders(() => this.updateConfiguration()));\n\t\tthis.toDispose.push(workspaceRootOverride.onDidChange(() => this.updateConfiguration())); // Active\n",
    "this.toDispose.push(workspaceRootOverride.onDidChange(() => this.updateConfiguration()));",
)
patch(
    explorer_viewer,
    "\t\tthis.contextService.getWorkspace().folders.forEach(folder => {\n",
    "\t\tworkspaceRootOverride.mapWorkspaceFolders(this.contextService.getWorkspace().folders).forEach(folder => { // Active\n",
    "workspaceRootOverride.mapWorkspaceFolders(this.contextService.getWorkspace().folders).forEach(folder => { // Active",
)
file_commands = "src/vs/workbench/contrib/files/browser/fileCommands.ts"
import_override(file_commands, "import { IWorkspaceContextService, UNTITLED_WORKSPACE_NAME } from '../../../../platform/workspace/common/workspace.js';", 4)
patch(
    file_commands,
    "\t\tif (uri && contextService.isInsideWorkspace(uri)) {\n\t\t\tconst explorerView",
    "\t\tif (uri && (workspaceRootOverride.contains(uri) ?? contextService.isInsideWorkspace(uri))) { // Active: Reveal in Explorer in a worktree\n\t\t\tconst explorerView",
    "(workspaceRootOverride.contains(uri) ?? contextService.isInsideWorkspace(uri))",
)

# Search and Quick Open search the worktree. (Only these views: extensions' findFiles still search the real folders.)
anything = "src/vs/workbench/contrib/search/browser/anythingQuickAccess.ts"
import_override(anything, "import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';", 4)
patch(
    anything,
    "cacheKey => this.fileQueryBuilder.file(this.contextService.getWorkspace().folders, this.getFileQueryOptions({ cacheKey })),",
    "cacheKey => this.fileQueryBuilder.file(workspaceRootOverride.mapWorkspaceFolders(this.contextService.getWorkspace().folders), this.getFileQueryOptions({ cacheKey })), // Active",
    "this.fileQueryBuilder.file(workspaceRootOverride.mapWorkspaceFolders(this.contextService.getWorkspace().folders), this.getFileQueryOptions({ cacheKey }))",
)
patch(
    anything,
    "\t\t\tthis.fileQueryBuilder.file(\n\t\t\t\tthis.contextService.getWorkspace().folders,\n",
    "\t\t\tthis.fileQueryBuilder.file(\n\t\t\t\tworkspaceRootOverride.mapWorkspaceFolders(this.contextService.getWorkspace().folders), // Active\n",
    "\t\t\t\tworkspaceRootOverride.mapWorkspaceFolders(this.contextService.getWorkspace().folders), // Active\n",
)
patch(
    anything,
    "\t\t\tfor (const folder of this.contextService.getWorkspace().folders) {\n",
    "\t\t\tfor (const folder of workspaceRootOverride.mapWorkspaceFolders(this.contextService.getWorkspace().folders)) { // Active\n",
    "for (const folder of workspaceRootOverride.mapWorkspaceFolders(this.contextService.getWorkspace().folders)) { // Active",
)
search_view = "src/vs/workbench/contrib/search/browser/searchView.ts"
import_override(search_view, "import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';", 4)
patch(
    search_view,
    "\t\t\tquery = this.queryBuilder.text(content, folderResources.map(folder => folder.uri), options);\n",
    "\t\t\tquery = this.queryBuilder.text(content, folderResources.map(folder => workspaceRootOverride.map(folder.uri)), options); // Active\n",
    "folderResources.map(folder => workspaceRootOverride.map(folder.uri)), options); // Active",
)
text_quick = "src/vs/workbench/contrib/search/browser/quickTextSearch/textSearchQuickAccess.ts"
import_override(text_quick, "import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../../platform/workspace/common/workspace.js';", 5)
patch(
    text_quick,
    "this.queryBuilder.text(content, folderResources.map(folder => folder.uri), this._getTextQueryBuilderOptions(charsPerLine));",
    "this.queryBuilder.text(content, folderResources.map(folder => workspaceRootOverride.map(folder.uri)), this._getTextQueryBuilderOptions(charsPerLine)); // Active",
    "folderResources.map(folder => workspaceRootOverride.map(folder.uri)), this._getTextQueryBuilderOptions(charsPerLine)); // Active",
)

# New terminals start in the worktree.
terminal_pm = "src/vs/workbench/contrib/terminal/browser/terminalProcessManager.ts"
import_override(terminal_pm, "import { IWorkspaceContextService, IWorkspaceFolder } from '../../../../platform/workspace/common/workspace.js';", 4)
patch(
    terminal_pm,
    "\t\tconst activeWorkspaceRootUri = this._historyService.getLastActiveWorkspaceRoot(Schemas.file);\n\n\t\tconst initialCwd",
    "\t\tconst activeWorkspaceRootUri = workspaceRootOverride.map(this._historyService.getLastActiveWorkspaceRoot(Schemas.file)); // Active: the agent's worktree\n\n\t\tconst initialCwd",
    "workspaceRootOverride.map(this._historyService.getLastActiveWorkspaceRoot(Schemas.file)); // Active",
)

# Worktree files are labelled relative to their worktree (tabs, Quick Open, Search), like workspace files.
label_service = "src/vs/workbench/services/label/common/labelService.ts"
import_override(label_service, "import { IWorkspaceContextService, IWorkspace, isWorkspace, ISingleFolderWorkspaceIdentifier, isSingleFolderWorkspaceIdentifier, isWorkspaceIdentifier, IWorkspaceIdentifier, toWorkspaceIdentifier, WORKSPACE_EXTENSION, isUntitledWorkspace, isTemporaryWorkspace } from '../../../../platform/workspace/common/workspace.js';", 4)
patch(
    label_service,
    "getWorkspaceFolder: resource => this.contextService.getWorkspaceFolder(resource)\n",
    "getWorkspaceFolder: resource => this.contextService.getWorkspaceFolder(resource) ?? workspaceRootOverride.folderOf(resource) // Active\n",
    "this.contextService.getWorkspaceFolder(resource) ?? workspaceRootOverride.folderOf(resource) // Active\n",
)
patch(
    label_service,
    "\t\t\tlet folder = this.contextService.getWorkspaceFolder(resource);\n",
    "\t\t\tlet folder = this.contextService.getWorkspaceFolder(resource) ?? workspaceRootOverride.folderOf(resource); // Active: agent worktrees\n",
    "workspaceRootOverride.folderOf(resource); // Active: agent worktrees",
)

# Breadcrumbs start at the worktree (like a workspace folder), not at the top of the disk.
breadcrumbs_model = "src/vs/workbench/browser/parts/editor/breadcrumbsModel.ts"
import_override(breadcrumbs_model, "import { IWorkspaceContextService, IWorkspaceFolder, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';", 4)
patch(
    breadcrumbs_model,
    "\t\t\tfolder: this._workspaceService.getWorkspaceFolder(uri) ?? undefined,\n",
    "\t\t\tfolder: this._workspaceService.getWorkspaceFolder(uri) ?? workspaceRootOverride.folderOf(uri) ?? undefined, // Active: agent worktrees\n",
    "getWorkspaceFolder(uri) ?? workspaceRootOverride.folderOf(uri) ?? undefined, // Active",
)

# Search includes like `./src` resolve against workspace folders: point those at the worktree too.
patch(
    search_view,
    "\t\t\tquery = this.queryBuilder.text(content, folderResources.map(folder => workspaceRootOverride.map(folder.uri)), options); // Active\n",
    "\t\t\tquery = this.queryBuilder.text(content, folderResources.map(folder => workspaceRootOverride.map(folder.uri)), options); // Active\n\t\t\tquery = { ...query, folderQueries: query.folderQueries.map(folderQuery => ({ ...folderQuery, folder: workspaceRootOverride.map(folderQuery.folder) })) }; // Active: relative includes too\n",
    "// Active: relative includes too",
)
patch(
    text_quick,
    "\t\tconst query: ITextQuery = this.queryBuilder.text(content, folderResources.map(folder => workspaceRootOverride.map(folder.uri)), this._getTextQueryBuilderOptions(charsPerLine)); // Active\n",
    "\t\tconst built: ITextQuery = this.queryBuilder.text(content, folderResources.map(folder => workspaceRootOverride.map(folder.uri)), this._getTextQueryBuilderOptions(charsPerLine)); // Active\n\t\tconst query: ITextQuery = { ...built, folderQueries: built.folderQueries.map(folderQuery => ({ ...folderQuery, folder: workspaceRootOverride.map(folderQuery.folder) })) }; // Active: relative includes too\n",
    "// Active: relative includes too",
)

# Subagents' worktrees (the coding agent's own) are read-only, in editors and the Explorer.
files_config = "src/vs/workbench/services/filesConfiguration/common/filesConfigurationService.ts"
import_override(files_config, "import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';", 4)
patch(
    files_config,
    "\t\tif (sessionReadonlyOverride !== undefined) {\n\t\t\treturn sessionReadonlyOverride;\n\t\t}\n",
    "\t\tif (sessionReadonlyOverride !== undefined) {\n\t\t\treturn sessionReadonlyOverride;\n\t\t}\n\n\t\t// Active: a subagent's worktree belongs to the coding agent, shown read-only\n\t\tconst agentReadonly = workspaceRootOverride.readonlyMessage(resource);\n\t\tif (agentReadonly) {\n\t\t\treturn agentReadonly;\n\t\t}\n",
    "const agentReadonly = workspaceRootOverride.readonlyMessage(resource);",
)
patch(
    files_config,
    "\t\tthis.registerListeners();\n\t}\n",
    "\t\tthis.registerListeners();\n\t\tthis._register(workspaceRootOverride.onDidChangeRoots(() => this._onDidChangeReadonly.fire())); // Active\n\t}\n",
    "this._register(workspaceRootOverride.onDidChangeRoots(() => this._onDidChangeReadonly.fire()));",
)

# 4. Branding.
product_path = root / "product.json"
product = json.loads(product_path.read_text())
branding = {
    "nameShort": "Active",
    "nameLong": "Active",
    "applicationName": "active",
    "dataFolderName": ".active-ide",
    "darwinBundleIdentifier": "dev.active.ide",
    "urlProtocol": "active",
}
if any(product.get(key) != value for key, value in branding.items()):
    product.update(branding)
    product_path.write_text(json.dumps(product, indent="\t") + "\n")
    print("patched product.json")

# 4b. CodeLLDB (C, C++, Rust debugging for code traces) ships as a built-in extension. setup-debuggers.sh unpacks
# this platform's build into .build/builtInExtensions (where dev builds load built-ins listed here) and keeps the
# VSIX it checked, which a packaged build uses.
import platform as _platform

debuggers = json.loads((pathlib.Path(__file__).resolve().parent / "debuggers.json").read_text())
lldb = debuggers["codelldb"]
machine = {"x86_64": "x64", "amd64": "x64", "aarch64": "arm64", "arm64": "arm64", "armv7l": "armhf"}.get(_platform.machine().lower(), _platform.machine().lower())
target = f"{ {'darwin': 'darwin', 'linux': 'linux', 'win32': 'win32'}.get(sys.platform, sys.platform)}-{machine}"
if target in lldb["sha256"]:
    entry = {
        "name": lldb["name"],
        "version": lldb["version"],
        "sha256": lldb["sha256"][target],
        "repo": lldb["repo"],
        "vsix": ".build/active-debuggers/codelldb.vsix",
        "metadata": {"publisherDisplayName": "Vadim Chugunov"},
    }
    listed = product.setdefault("builtInExtensions", [])
    current = next((item for item in listed if item.get("name") == lldb["name"]), None)
    if current != entry:
        if current:
            listed.remove(current)
        listed.append(entry)
        product_path.write_text(json.dumps(product, indent="\t") + "\n")
        print("patched product.json (CodeLLDB)")

# 5. App icon (active/branding/icon.svg, built into Active.icns and icon-512.png on Apple's 824-on-1024 grid).
import shutil

branding_dir = pathlib.Path(__file__).resolve().parent.parent / "active" / "branding"
icons = [
    (branding_dir / "Active.icns", root / "resources" / "darwin" / "code.icns"),
    (branding_dir / "icon-512.png", root / "resources" / "linux" / "code.png"),
]
# The dev Electron bundle is built once by setup; give it the icon too so it shows without a rebuild.
for bundle in (root / ".build" / "electron").glob("*.app"):
    icons.append((branding_dir / "Active.icns", bundle / "Contents" / "Resources" / f"{bundle.stem}.icns"))
for source, target in icons:
    if target.parent.exists() and (not target.exists() or target.read_bytes() != source.read_bytes()):
        shutil.copyfile(source, target)
        if target.suffix == ".icns" and ".app" in str(target):
            # Finder and the Dock cache bundle icons; touching the bundle makes them look again.
            (target.parents[2]).touch()
        print(f"copied icon to {target.relative_to(root)}")

# 9. Active's "Report a Bug or Request a Feature" icon at the top of the bottom-left bar (above Accounts and Manage).
#    It renders like those icons and runs Active's active.reportIssue command (feedback.ts). Accounts moves to index 1,
#    and showing/hiding Accounts checks for its action instead of counting the bar's items.
GLOBAL_BAR = "src/vs/workbench/browser/parts/globalCompositeBar.ts"
patch(
    GLOBAL_BAR,
    "export class GlobalCompositeBar extends Disposable {",
    "const ACTIVE_FEEDBACK_ID = 'active.reportIssue';\n\n"
    "/** Active: report a bug or request a feature (the command lives in Active's feedback.ts). */\n"
    "class ActiveFeedbackAction extends CompositeBarAction {\n"
    "\tconstructor(private readonly commandService: ICommandService) {\n"
    "\t\tsuper({ id: ACTIVE_FEEDBACK_ID, name: localize('activeFeedback', \"Report a Bug or Request a Feature\"), classNames: ThemeIcon.asClassNameArray(Codicon.feedback) });\n"
    "\t}\n\n"
    "\toverride async run(): Promise<void> {\n"
    "\t\tawait this.commandService.executeCommand(ACTIVE_FEEDBACK_ID);\n"
    "\t}\n"
    "}\n\n"
    "export class GlobalCompositeBar extends Disposable {",
    "class ActiveFeedbackAction extends CompositeBarAction",
)
patch(
    GLOBAL_BAR,
    "\tprivate static readonly ACCOUNTS_ACTION_INDEX = 0;",
    "\tprivate static readonly ACCOUNTS_ACTION_INDEX = 1; // Active: its feedback icon is first",
    "ACCOUNTS_ACTION_INDEX = 1; // Active",
)
patch(
    GLOBAL_BAR,
    "\t\t@IExtensionService private readonly extensionService: IExtensionService,\n\t) {\n\t\tsuper();\n\n\t\tthis.element = $('div');",
    "\t\t@IExtensionService private readonly extensionService: IExtensionService,\n\t\t@ICommandService private readonly activeCommandService: ICommandService,\n\t) {\n\t\tsuper();\n\n\t\tthis.element = $('div');",
    "private readonly activeCommandService: ICommandService",
)
patch(
    GLOBAL_BAR,
    "\t\t\t\tif (action.id === ACCOUNTS_ACTIVITY_ID) {\n\t\t\t\t\treturn this.instantiationService.createInstance(AccountsActivityActionViewItem,",
    "\t\t\t\tif (action.id === ACTIVE_FEEDBACK_ID) {\n\t\t\t\t\treturn this.instantiationService.createInstance(CompositeBarActionViewItem, action as CompositeBarAction, { ...options, icon: true, colors: this.colors, hoverOptions: this.activityHoverOptions }, () => false);\n\t\t\t\t}\n\n"
    "\t\t\t\tif (action.id === ACCOUNTS_ACTIVITY_ID) {\n\t\t\t\t\treturn this.instantiationService.createInstance(AccountsActivityActionViewItem,",
    "if (action.id === ACTIVE_FEEDBACK_ID) {",
)
patch(
    GLOBAL_BAR,
    "\t\tif (this.accountsVisibilityPreference) {\n\t\t\tthis.globalActivityActionBar.push(this.accountAction, { index: GlobalCompositeBar.ACCOUNTS_ACTION_INDEX });\n\t\t}\n\n\t\tthis.globalActivityActionBar.push(this.globalActivityAction);",
    "\t\tthis.globalActivityActionBar.push(this._register(new ActiveFeedbackAction(this.activeCommandService)));\n\n"
    "\t\tif (this.accountsVisibilityPreference) {\n\t\t\tthis.globalActivityActionBar.push(this.accountAction, { index: GlobalCompositeBar.ACCOUNTS_ACTION_INDEX });\n\t\t}\n\n\t\tthis.globalActivityActionBar.push(this.globalActivityAction);",
    "new ActiveFeedbackAction(this.activeCommandService)",
)
patch(
    GLOBAL_BAR,
    "\t\tconst accountsVisible = this.globalActivityActionBar.length() === 2;",
    "\t\tconst accountsVisible = this.globalActivityActionBar.hasAction(this.accountAction); // Active: not a count (its feedback icon is there too)",
    "hasAction(this.accountAction); // Active",
)
