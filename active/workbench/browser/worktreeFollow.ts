/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/worktreeFollow.css';
import * as dom from '../../../../base/browser/dom.js';
import { renderIcon } from '../../../../base/browser/ui/iconLabel/iconLabels.js';
import { raceTimeout, Sequencer } from '../../../../base/common/async.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { MarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { ResourceSet } from '../../../../base/common/map.js';
import { Schemas } from '../../../../base/common/network.js';
import { basename, extUriBiasedIgnorePathCase, IExtUri } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import { ICodeEditorViewState } from '../../../../editor/common/editorCommon.js';
import { localize } from '../../../../nls.js';
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationHandle, INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { registerColor } from '../../../../platform/theme/common/colorUtils.js';
import { IOverrideRoot, workspaceRootOverride } from '../../../../platform/workspace/common/workspaceRootOverride.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorResourceAccessor } from '../../../common/editor.js';
import { IDecorationData, IDecorationsService } from '../../../services/decorations/common/decorations.js';
import { IEditorGroupsService } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService, IUntypedEditorReplacement } from '../../../services/editor/common/editorService.js';
import { VIEW_ID as SEARCH_VIEW_ID } from '../../../services/search/common/search.js';
import { IStatusbarEntry, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { ExplorerView } from '../../files/browser/views/explorerView.js';
import { VIEW_ID as EXPLORER_VIEW_ID } from '../../files/common/files.js';
import { ISCMRepository, ISCMService, ISCMViewService } from '../../scm/common/scm.js';
import { SearchView } from '../../search/browser/searchView.js';
import { AGENT_COLORS, AgentInfo, MAIN_AGENT_ID } from '../common/activeProtocol.js';
import { IActiveService, REMOTE_FILE_SCHEME } from './activeService.js';

// The workbench follows the highlighted agent's worktree: the Explorer, Search, Quick Open, Source Control, new
// terminals and open editors switch to its folder, without changing the workspace folders (that would restart the
// extension host and the agents in it). The core side is `workspaceRootOverride` (patched in by apply_patches.py);
// this sets it and does what needs no patch: swapping open editors, Source Control, watching the worktree, tab
// badges, the Explorer's header and the notice when a walkthrough switches trees.

// ---------------------------------------------------------------- pure helpers (tested)

/** The same file under another root, or undefined when `resource` isn't under `from`. */
export function remapResource(resource: URI, from: URI, to: URI, extUri: IExtUri = extUriBiasedIgnorePathCase): URI | undefined {
	if (!extUri.isEqualOrParent(resource, from)) {
		return undefined;
	}
	const relative = extUri.relativePath(from, resource);
	if (relative === undefined) {
		return undefined;
	}
	return relative ? extUri.joinPath(to, relative) : to;
}

/** A tab badge for an agent: its number when its name ends in one ("Agent 2" → "2"), else its initial. */
export function agentBadge(name: string): string {
	const number = /(\d+)\s*$/.exec(name);
	if (number) {
		return number[1].slice(-2);
	}
	const initial = name.trim().charAt(0).toUpperCase();
	return initial || '•';
}

/** The agent whose folder `resource` is in: the deepest worktree, else the agent in the developer's folder. */
export function agentForResource(resource: URI, agents: readonly AgentInfo[], mainFolder: URI | undefined, extUri: IExtUri = extUriBiasedIgnorePathCase): AgentInfo | undefined {
	let best: AgentInfo | undefined;
	let bestLength = -1;
	for (const agent of agents) {
		if (agent.inMainFolder) {
			continue;
		}
		const root = resource.scheme === REMOTE_FILE_SCHEME ? URI.from({ scheme: REMOTE_FILE_SCHEME, path: agent.root }) : URI.file(agent.root);
		// Top-level agents come before their nested ones, so on equal roots the top-level one wins.
		if (root.path.length > bestLength && extUri.isEqualOrParent(resource, root)) {
			best = agent;
			bestLength = root.path.length;
		}
	}
	if (best) {
		return best;
	}
	return mainFolder && extUri.isEqualOrParent(resource, mainFolder) ? agents.find(agent => agent.inMainFolder && agent.kind === 'agent') : undefined;
}

// ---------------------------------------------------------------- colours

/** Agent colours as theme colours (decorations need colour ids). CSS prefers `--active-agent-N` when it's defined. */
const AGENT_THEME_COLORS: readonly string[] = (() => {
	// The same order as the grid's `--active-agent-N` colours (agentGrid.css), so a tab matches its agent's box and card.
	const defaults = ['charts.blue', 'charts.purple', 'charts.green', 'charts.orange', '#4FC1C9', '#E07AB8', 'charts.yellow', '#EF8F6F'];
	const colors: string[] = [];
	for (let index = 0; index < AGENT_COLORS; index++) {
		const value = defaults[index % defaults.length];
		colors.push(registerColor(`activeWorktree.agent${index}`, { dark: value, light: value, hcDark: value, hcLight: value }, localize('activeWorktreeAgentColor', "Agent {0}'s colour in tabs and the Explorer.", index + 1)));
	}
	return colors;
})();

function colorClass(agent: AgentInfo): string {
	return `agent-color-${((agent.colorIndex % AGENT_COLORS) + AGENT_COLORS) % AGENT_COLORS}`;
}

// ---------------------------------------------------------------- explanation

const EXPLAIN_COMMAND = 'active.worktree.explain';

CommandsRegistry.registerCommand(EXPLAIN_COMMAND, (accessor: ServicesAccessor) => {
	const agent = accessor.get(IActiveService).highlightedAgent;
	return accessor.get(IDialogService).info(
		localize('worktreeExplainTitle', "What's a worktree?"),
		[
			localize('worktreeExplain1', "Each agent works in its own copy of the project (a git worktree, on its own branch), so agents don't overwrite each other's changes."),
			localize('worktreeExplain2', "Viewing an agent, or playing its walkthrough, switches the Explorer, Search, Source Control, terminals and open files to its copy."),
			agent?.readOnly
				? localize('worktreeExplainReadOnly', "{0} is a subagent. Its copy is read-only and removed when it finishes.", agent.name)
				: localize('worktreeExplain3', "Other agents' work stays in their copies until you merge it."),
		].join('\n\n'),
	);
});

// ---------------------------------------------------------------- the contribution

class WorktreeFollow extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.activeWorktreeFollow';

	/** The folder everything shows now (the workspace folder when there's no override). */
	private shownRoot: URI | undefined;
	private readonly transitions = new Sequencer();
	private readonly watcher = this._register(new MutableDisposable());
	private readonly status = this._register(new MutableDisposable<{ update(entry: IStatusbarEntry): void; dispose(): void }>());
	private notice: INotificationHandle | undefined;
	/** Source Control's visible repositories from before the first switch, restored on returning to the developer's folder. */
	private savedRepositories: readonly ISCMRepository[] | undefined;
	private pinnedRepository: ISCMRepository | undefined;
	private readonly openResources = new ResourceSet(uri => extUriBiasedIgnorePathCase.getComparisonKey(uri));
	private readonly _onDidChangeDecorations = this._register(new Emitter<URI[]>());
	private readonly header = this._register(new DisposableStore());

	constructor(
		@IActiveService private readonly activeService: IActiveService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IFileService private readonly fileService: IFileService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IEditorService private readonly editorService: IEditorService,
		@IEditorGroupsService private readonly editorGroupsService: IEditorGroupsService,
		@ISCMService private readonly scmService: ISCMService,
		@ISCMViewService private readonly scmViewService: ISCMViewService,
		@ICommandService private readonly commandService: ICommandService,
		@INotificationService private readonly notificationService: INotificationService,
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IViewsService private readonly viewsService: IViewsService,
		@IDecorationsService decorationsService: IDecorationsService,
		@ILogService private readonly logService: ILogService,
	) {
		super();
		this.shownRoot = this.mainFolder();
		this._register(decorationsService.registerDecorationsProvider({
			label: localize('worktreeDecorations', "Agent worktrees"),
			onDidChange: this._onDidChangeDecorations.event,
			provideDecorations: uri => this.decorationFor(uri),
		}));
		this._register(this.activeService.onDidChangeHighlight(change => {
			// The service announces the agent list before the highlight, so the switch itself may be done already:
			// whether the files changed is a question about the two agents' folders.
			const before = this.activeService.agentRoot(change.previousId);
			const after = this.activeService.agentRoot(change.agentId);
			this.update();
			if (change.reason === 'explanation' && before && after && !extUriBiasedIgnorePathCase.isEqual(before, after)) {
				this.showNotice();
			}
		}));
		// Agents' activity changes this often; only what's shown here matters (see `shownKey`).
		this._register(this.activeService.onDidChangeAgents(() => this.update()));
		this._register(this.activeService.onDidChangeRemote(() => this.update()));
		this._register(this.workspaceService.onDidChangeWorkspaceFolders(() => this.update()));
		this._register(this.editorService.onDidEditorsChange(() => this.updateOpenResources()));
		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('files.watcherExclude')) {
				this.watch();
			}
		}));
		this._register(this.viewsService.onDidChangeViewVisibility(event => event.id === EXPLORER_VIEW_ID && this.renderHeader()));
		this._register({ dispose: () => { workspaceRootOverride.set(undefined); workspaceRootOverride.setRoots([]); this.notice?.close(); } });
		this.updateOpenResources();
		this.update();
	}

	private mainFolder(): URI | undefined {
		return this.workspaceService.getWorkspace().folders[0]?.uri;
	}

	/** An agent's folder: on this machine, or the host's (read-only, through the session) while a guest. */
	private rootOf(agent: AgentInfo): URI {
		return this.activeService.remote ? URI.from({ scheme: REMOTE_FILE_SCHEME, path: agent.root }) : URI.file(agent.root);
	}

	/** The highlighted agent when it works outside the developer's folder (the only case anything is overridden). */
	private worktreeAgent(): AgentInfo | undefined {
		const agent = this.activeService.highlightedAgent;
		return agent && !agent.inMainFolder && agent.root ? agent : undefined;
	}

	/** What this shows of the agents (folders, names, colours, branches, the highlight), to skip activity-only changes. */
	private shownKey(): string {
		const highlighted = this.activeService.highlightedAgentId;
		return JSON.stringify([highlighted, this.mainFolder()?.toString(), !!this.activeService.remote, this.activeService.agents.map(agent => [agent.id, agent.name, agent.root, agent.inMainFolder, agent.branch, agent.readOnly, agent.colorIndex, agent.kind, agent.finished])]);
	}

	private lastKey: string | undefined;

	private update(): void {
		const key = this.shownKey();
		if (key === this.lastKey) {
			return;
		}
		this.lastKey = key;
		const folder = this.mainFolder();
		const agents = this.activeService.agents;

		// Every worktree's files are labelled relative to it, and subagents' worktrees are read-only, highlighted or not.
		const roots: IOverrideRoot[] = [];
		for (const agent of agents) {
			if (!agent.inMainFolder && agent.root && !roots.some(root => extUriBiasedIgnorePathCase.isEqual(root.root, this.rootOf(agent)))) {
				roots.push({
					root: this.rootOf(agent),
					name: agent.name,
					readonly: this.activeService.remote ? new MarkdownString(localize('sessionReadOnly', "Files in a shared session are read-only.")) : agent.readOnly ? new MarkdownString(localize('worktreeReadOnly', "{0}'s worktree is read-only.", agent.name)) : undefined,
				});
			}
		}
		workspaceRootOverride.setRoots(roots);

		const agent = this.worktreeAgent();
		const target = agent && folder ? this.rootOf(agent) : folder;
		workspaceRootOverride.set(agent && folder ? { folder, root: this.rootOf(agent), label: agent.name } : undefined);
		this.updateStatus();
		this.renderHeader();
		this._onDidChangeDecorations.fire([...this.openResources]);

		const previous = this.shownRoot;
		if (!target || !previous || extUriBiasedIgnorePathCase.isEqual(previous, target)) {
			this.shownRoot = target;
			return;
		}
		this.shownRoot = target;
		this.watch();
		void this.transitions.queue(async () => {
			try {
				await this.swapEditors(previous, target);
			} catch (error) {
				this.logService.error('[Active] swapping editors to the worktree failed', error);
			}
			this.refreshSearch();
			await this.followRepository(agent ? target : undefined);
		});
	}

	// ------------------------------------------------------------- open editors

	/**
	 * Swaps each open file under `from` for the same path under `to`, in place, keeping pinned/sticky and the visible
	 * editors' scroll and selection. A file with unsaved changes, or one the other tree doesn't have, stays open as it
	 * is (its tab badge says whose it is).
	 */
	private async swapEditors(from: URI, to: URI): Promise<void> {
		const keptDirty: string[] = [];
		for (const group of this.editorGroupsService.groups) {
			const replacements: IUntypedEditorReplacement[] = [];
			for (const editor of group.editors) {
				const resource = EditorResourceAccessor.getOriginalUri(editor);
				// A guest's tabs are the host's files through the session (`active-remote:`); they follow too.
				if (!resource || (resource.scheme !== Schemas.file && resource.scheme !== REMOTE_FILE_SCHEME)) {
					continue;
				}
				if (editor.isDirty()) {
					if (remapResource(resource, from, to)) {
						keptDirty.push(basename(resource));
					}
					continue;
				}
				const replacement = remapResource(resource, from, to);
				if (!replacement || group.editors.some(other => other !== editor && other.resource && extUriBiasedIgnorePathCase.isEqual(other.resource, replacement))) {
					continue;
				}
				if (!await this.fileService.exists(replacement)) {
					continue;
				}
				let viewState: ICodeEditorViewState | undefined;
				if (group.activeEditor === editor) {
					const control = group.activeEditorPane?.getControl();
					viewState = isCodeEditor(control) ? control.saveViewState() ?? undefined : undefined;
				}
				replacements.push({
					editor,
					replacement: {
						resource: replacement,
						options: {
							pinned: group.isPinned(editor),
							sticky: group.isSticky(editor),
							preserveFocus: true,
							viewState,
							override: editor.editorId,
						},
					},
				});
			}
			if (replacements.length && this.editorGroupsService.getGroup(group.id)) {
				await this.editorService.replaceEditors(replacements, group);
			}
		}
		// Unsaved edits stay on the copy they were made in: say so, or the tab silently shows the other agent's file.
		if (keptDirty.length) {
			const owner = agentForResource(from, this.activeService.agents, this.mainFolder());
			this.notificationService.info(keptDirty.length === 1
				? localize('keptDirtyOne', "{0} has unsaved changes, so it's still {1}'s copy. Save or revert it to switch.", keptDirty[0], owner?.name ?? localize('previousAgent', "the previous agent"))
				: localize('keptDirtyMany', "{0} files have unsaved changes, so they're still {1}'s copies: {2}. Save or revert them to switch.", keptDirty.length, owner?.name ?? localize('previousAgent', "the previous agent"), keptDirty.join(', ')));
		}
	}

	// ------------------------------------------------------------- Source Control

	/** Shows (and opens, when git hasn't yet) the worktree's repository; back to what was shown before for the developer's folder. */
	private async followRepository(root: URI | undefined): Promise<void> {
		if (!root) {
			const saved = this.savedRepositories;
			this.savedRepositories = undefined;
			if (saved) {
				const still = saved.filter(repository => this.scmViewService.repositories.includes(repository));
				if (still.length) {
					this.scmViewService.visibleRepositories = still;
				}
			}
			if (this.pinnedRepository) {
				this.pinnedRepository = undefined;
				this.scmViewService.pinActiveRepository(undefined);
			}
			// Unpinning leaves the worktree's repository active (the status bar's branch): back to the developer's.
			const home = this.activeService.agentRoot(MAIN_AGENT_ID);
			const mine = home && this.repositoryAt(home);
			if (mine) {
				this.scmViewService.focus(mine);
			}
			return;
		}
		let repository = this.repositoryAt(root);
		if (!repository) {
			const store = new DisposableStore();
			const added = Event.toPromise(Event.filter(this.scmService.onDidAddRepository, candidate => this.isRepositoryAt(candidate, root)), store);
			try {
				await this.commandService.executeCommand('git.openRepository', root.fsPath);
				repository = this.repositoryAt(root) ?? await raceTimeout(added, 10_000);
			} catch (error) {
				this.logService.warn('[Active] could not open the worktree in Source Control', error);
			} finally {
				added.cancel();
				store.dispose();
			}
		}
		// Another switch may have happened meanwhile.
		if (!repository || !this.shownRoot || !extUriBiasedIgnorePathCase.isEqual(this.shownRoot, root)) {
			return;
		}
		this.savedRepositories ??= [...this.scmViewService.visibleRepositories];
		this.scmViewService.visibleRepositories = [repository];
		this.scmViewService.focus(repository);
		this.scmViewService.pinActiveRepository(repository);
		this.pinnedRepository = repository;
	}

	private isRepositoryAt(repository: ISCMRepository, root: URI): boolean {
		return !!repository.provider.rootUri && extUriBiasedIgnorePathCase.isEqual(repository.provider.rootUri, root);
	}

	private repositoryAt(root: URI): ISCMRepository | undefined {
		for (const repository of this.scmService.repositories) {
			if (this.isRepositoryAt(repository, root)) {
				return repository;
			}
		}
		return undefined;
	}

	// ------------------------------------------------------------- Search, file watching

	/** Search results from the other tree are stale: search again (only when there are results, and without taking focus). */
	private refreshSearch(): void {
		const view = this.viewsService.getViewWithId(SEARCH_VIEW_ID);
		if (view instanceof SearchView && view.hasSearchResults()) {
			view.triggerQueryChange({ preserveFocus: true });
		}
	}

	/**
	 * The worktree is outside the workspace, so nothing watches it recursively (open editors outside the workspace are
	 * watched one by one). The Explorer needs the whole tree: watch it while it's shown.
	 */
	private watch(): void {
		const agent = this.worktreeAgent();
		// A guest's host pushes changes itself.
		if (!agent || !this.mainFolder() || this.activeService.remote) {
			this.watcher.clear();
			return;
		}
		const excludes: string[] = [];
		const configured = this.configurationService.getValue<Record<string, boolean>>('files.watcherExclude') ?? {};
		for (const pattern in configured) {
			if (pattern && configured[pattern] === true) {
				excludes.push(pattern);
			}
		}
		this.watcher.value = this.fileService.watch(this.rootOf(agent), { recursive: true, excludes });
	}

	// ------------------------------------------------------------- tab badges

	private updateOpenResources(): void {
		const before = [...this.openResources];
		this.openResources.clear();
		for (const editor of this.editorService.editors) {
			const resource = EditorResourceAccessor.getOriginalUri(editor);
			if (resource?.scheme === Schemas.file) {
				this.openResources.add(resource);
			}
		}
		this._onDidChangeDecorations.fire([...before, ...this.openResources]);
	}

	/**
	 * Open files from a worktree carry their agent's badge and colour (and so do files from the developer's folder while
	 * another agent's tree is shown). Only open files: badging every row of the Explorer would just be noise.
	 */
	private decorationFor(uri: URI): IDecorationData | undefined {
		if (uri.scheme !== Schemas.file || !this.openResources.has(uri)) {
			return undefined;
		}
		const agent = agentForResource(uri, this.activeService.agents, this.mainFolder());
		if (!agent || (agent.inMainFolder && !this.worktreeAgent())) {
			return undefined;
		}
		const where = agent.inMainFolder
			? localize('worktreeTabMain', "{0}'s files (your folder)", agent.name)
			: agent.branch
				? localize('worktreeTabBranch', "{0}'s worktree ({1})", agent.name, agent.branch)
				: localize('worktreeTab', "{0}'s worktree", agent.name);
		return {
			letter: agentBadge(agent.name),
			color: AGENT_THEME_COLORS[((agent.colorIndex % AGENT_COLORS) + AGENT_COLORS) % AGENT_COLORS],
			tooltip: agent.readOnly ? localize('worktreeTabReadOnly', "{0}, read-only", where) : where,
			bubble: false,
			// Whose copy a tab is matters more than its change colour: the agent's colour wins.
			weight: 100,
		};
	}

	// ------------------------------------------------------------- Explorer header

	/** A chip in the Explorer's header: whose tree it is (colour, branch, read-only). Shown when there's more than one agent. */
	private renderHeader(): void {
		this.header.clear();
		const view = this.viewsService.getViewWithId<ExplorerView>(EXPLORER_VIEW_ID);
		// The Explorer's header isn't ours to build; its title is the anchor.
		// eslint-disable-next-line no-restricted-syntax
		const title = view instanceof ExplorerView ? view.element.querySelector<HTMLElement>('.pane-header .title') : null;
		const highlighted = this.activeService.highlightedAgent;
		const topLevel = this.activeService.agents.filter(agent => agent.kind === 'agent' && !agent.finished).length;
		if (!title || !highlighted || (!this.worktreeAgent() && topLevel < 2)) {
			return;
		}
		const chip = dom.$(`span.active-worktree-chip.${colorClass(highlighted)}`);
		chip.classList.toggle('read-only', !!highlighted.readOnly);
		dom.append(chip, dom.$('span.dot'));
		if (highlighted.inMainFolder) {
			// The Explorer's title is the folder's name already; say whose it is.
			dom.append(chip, dom.$('span.name')).textContent = localize('worktreeChipMain', "{0} · your folder", highlighted.name);
		}
		if (highlighted.branch) {
			const branch = dom.append(chip, dom.$('span.branch'));
			branch.append(renderIcon(Codicon.gitBranch), highlighted.branch);
		}
		if (highlighted.readOnly) {
			const lock = dom.append(chip, dom.$('span.lock'));
			lock.append(renderIcon(Codicon.lock), localize('worktreeChipReadOnly', "read-only"));
		}
		chip.title = highlighted.inMainFolder
			? localize('worktreeChipMainTitle', "{0} works in your own folder.", highlighted.name)
			: highlighted.readOnly
				? localize('worktreeChipReadOnlyTitle', "{0}'s worktree (read-only)", highlighted.name)
				: localize('worktreeChipTitle', "{0}'s worktree", highlighted.name);
		// The header toggles the section when clicked: keep clicks on the chip to itself.
		this.header.add(dom.addDisposableListener(chip, dom.EventType.MOUSE_DOWN, event => event.stopPropagation()));
		this.header.add(dom.addDisposableListener(chip, dom.EventType.CLICK, event => {
			event.stopPropagation();
			void this.commandService.executeCommand(EXPLAIN_COMMAND);
		}));
		title.after(chip);
		this.header.add({ dispose: () => chip.remove() });
	}

	// ------------------------------------------------------------- status bar, notice

	private updateStatus(): void {
		const agent = this.worktreeAgent();
		if (!agent) {
			this.status.clear();
			return;
		}
		const entry: IStatusbarEntry = {
			name: localize('worktreeStatusName', "Agent Worktree"),
			text: `$(${agent.readOnly ? Codicon.lock.id : Codicon.repoForked.id}) ${agent.name}`,
			ariaLabel: localize('worktreeStatusAria', "Showing {0}'s worktree", agent.name),
			tooltip: agent.branch
				? localize('worktreeStatusTooltipBranch', "Showing {0}'s worktree ({1})", agent.name, agent.branch)
				: localize('worktreeStatusTooltip', "Showing {0}'s worktree", agent.name),
			command: EXPLAIN_COMMAND,
		};
		if (this.status.value) {
			this.status.value.update(entry);
		} else {
			this.status.value = this.statusbarService.addEntry(entry, 'active.worktree', StatusbarAlignment.LEFT, 8);
		}
	}

	/** A walkthrough switched trees under the developer: say so, once, with a way to find out why. */
	private showNotice(): void {
		const agent = this.activeService.highlightedAgent;
		if (!agent) {
			return;
		}
		this.notice?.close();
		const message = agent.inMainFolder
			? localize('worktreeNoticeMain', "Showing {0}'s files for this walkthrough.", agent.name)
			: localize('worktreeNotice', "Showing {0}'s worktree for this walkthrough.", agent.name);
		const notice = this.notice = this.notificationService.prompt(Severity.Info, message, [{
			label: localize('worktreeNoticeWhat', "What's this?"),
			run: () => void this.commandService.executeCommand(EXPLAIN_COMMAND),
		}]);
		Event.once(notice.onDidClose)(() => {
			if (this.notice === notice) {
				this.notice = undefined;
			}
		});
	}
}

registerWorkbenchContribution2(WorktreeFollow.ID, WorktreeFollow, WorkbenchPhase.AfterRestored);
