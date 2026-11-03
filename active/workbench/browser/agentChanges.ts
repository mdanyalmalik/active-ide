/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { Schemas } from '../../../../base/common/network.js';
import { URI } from '../../../../base/common/uri.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../editor/common/model.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ITextModelContentProvider, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IDecorationData, IDecorationsService } from '../../../services/decorations/common/decorations.js';
import { IQuickDiffService } from '../../scm/common/quickDiff.js';
import { ExtensionCommand } from '../common/activeProtocol.js';
import { ExplorerCountsMode, IActiveService } from './activeService.js';

/** Files as they were before the agent's last prompt that changed them, for the editor gutter. */
const BASELINE_SCHEME = 'active-agent-baseline';
const PROVIDER_ID = 'active.agentChanges';
/** The quick diff providers Active hid for the "Agent" mode, so "Git" shows exactly those again. */
const HIDDEN_BY_ACTIVE_KEY = 'active.quickDiff.hiddenByActive';

/**
 * Makes the editor's change bars follow the Explorer's counts mode. In "Agent" mode they show what the
 * agent's last prompt that changed files changed (against the files as they were before it), and the
 * source control (git) bars are hidden; in "Git" mode it's the other way round.
 */
export class AgentQuickDiff extends Disposable implements IWorkbenchContribution, ITextModelContentProvider {
	static readonly ID = 'workbench.contrib.activeAgentQuickDiff';

	private readonly provider = this._register(new MutableDisposable());
	/** Changes with every new set of agent changes, so baselines from an earlier prompt are never reused. */
	private version = 0;

	constructor(
		@IQuickDiffService private readonly quickDiffService: IQuickDiffService,
		@ITextModelService textModelService: ITextModelService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@ICommandService private readonly commandService: ICommandService,
		@IStorageService private readonly storageService: IStorageService,
		@IActiveService private readonly activeService: IActiveService,
	) {
		super();
		this._register(textModelService.registerTextModelContentProvider(BASELINE_SCHEME, this));
		this.registerProvider();
		// New agent changes: re-register, which makes open editors diff again against the new baselines.
		this._register(this.activeService.onDidChangeTurnChanges(() => this.registerProvider()));
		this._register(this.activeService.onDidChangeExplorerCounts(() => this.syncVisibility()));
		// Source control registers its providers when its extension starts, often after this.
		this._register(this.quickDiffService.onDidChangeQuickDiffProviders(() => this.syncVisibility()));
		this.syncVisibility();
	}

	private registerProvider(): void {
		this.version++;
		// The highlighted agent's folder: its own worktree, or the workspace folder.
		const root = this.activeService.agentRoot();
		this.provider.value = this.quickDiffService.addQuickDiffProvider({
			id: PROVIDER_ID,
			label: localize('agentChanges', "Agent Changes"),
			rootUri: root,
			kind: 'contributed',
			getOriginalResource: async uri => {
				const relative = this.relativePath(uri);
				return relative && this.activeService.turnChanges.has(relative)
					? URI.from({ scheme: BASELINE_SCHEME, path: `/${relative}`, query: String(this.version) })
					: null;
			},
		});
	}

	async provideTextContent(resource: URI): Promise<ITextModel | null> {
		const existing = this.modelService.getModel(resource);
		if (existing) {
			return existing;
		}
		const result = await this.commandService.executeCommand<{ baseline: string | null } | undefined>(ExtensionCommand.AgentBaseline, resource.path.slice(1));
		if (!result) {
			return null;
		}
		// A file the agent created is diffed against nothing, so all of it shows as added.
		return this.modelService.createModel(result.baseline ?? '', this.languageService.createByFilepathOrFirstLine(resource), resource);
	}

	/** Shows the bars that match the mode. Only changes what differs, so its own change events settle at once. */
	private syncVisibility(): void {
		const agentMode = this.activeService.explorerCountsMode === 'agent';
		const hiddenByActive = new Set<string>(JSON.parse(this.storageService.get(HIDDEN_BY_ACTIVE_KEY, StorageScope.PROFILE, '[]')));
		const setVisible = (id: string, visible: boolean) => {
			if (this.quickDiffService.isQuickDiffProviderVisible(id) !== visible) {
				this.quickDiffService.toggleQuickDiffProviderVisibility(id);
			}
		};
		if (agentMode) {
			for (const provider of this.quickDiffService.providers) {
				if (provider.kind !== 'contributed' && this.quickDiffService.isQuickDiffProviderVisible(provider.id)) {
					hiddenByActive.add(provider.id);
					setVisible(provider.id, false);
				}
			}
			setVisible(PROVIDER_ID, true);
		} else {
			setVisible(PROVIDER_ID, false);
			for (const id of hiddenByActive) {
				setVisible(id, true);
			}
			hiddenByActive.clear();
		}
		this.storageService.store(HIDDEN_BY_ACTIVE_KEY, JSON.stringify([...hiddenByActive]), StorageScope.PROFILE, StorageTarget.MACHINE);
	}

	private relativePath(uri: URI): string | undefined {
		if (uri.scheme !== Schemas.file) {
			return undefined;
		}
		return agentRelative(this.activeService, uri);
	}
}

/** `uri` relative to the highlighted agent's folder (the counts and baselines are that agent's). */
function agentRelative(activeService: IActiveService, uri: URI): string | undefined {
	const root = activeService.agentRoot();
	if (!root || uri.scheme !== Schemas.file) {
		return undefined;
	}
	const prefix = root.path.replace(/\/$/, '') + '/';
	return uri.path.startsWith(prefix) ? uri.path.slice(prefix.length) : undefined;
}

/** Git's decorations come from its extension, under its identifier. */
const GIT_DECORATIONS = 'vscode.git';
/** Kept in "Agent" mode too: dimming ignored files isn't a sign of changes. */
const GIT_IGNORED_COLOR = 'gitDecoration.ignoredResourceForeground';

/**
 * Makes the file decorations (the colored names and letters in the Explorer, editor tabs, breadcrumbs and
 * Open Editors) follow the mode. In "Agent" mode the files the agent's last prompt changed are marked
 * (M, or A for files it created) and git's change decorations are hidden; in "Git" mode git's show as usual.
 */
export class AgentDecorations extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.activeAgentDecorations';

	private readonly _onDidChangeDecorations = this._register(new Emitter<readonly URI[]>());
	private readonly _onDidChangeFilter = this._register(new Emitter<void>());
	private mode: ExplorerCountsMode;
	private marked: readonly URI[] = [];

	constructor(
		@IDecorationsService decorationsService: IDecorationsService,
		@IActiveService private readonly activeService: IActiveService,
	) {
		super();
		this.mode = activeService.explorerCountsMode;
		this._register(decorationsService.registerDecorationsProvider({
			label: localize('agentDecorations', "Agent Changes"),
			onDidChange: this._onDidChangeDecorations.event,
			provideDecorations: uri => this.decorationFor(uri),
		}));
		this._register(decorationsService.registerDecorationsFilter({
			onDidChange: this._onDidChangeFilter.event,
			accepts: (providerLabel, data) => this.mode !== 'agent' || providerLabel !== GIT_DECORATIONS || data.color === GIT_IGNORED_COLOR,
		}));
		this._register(activeService.onDidChangeExplorerCounts(() => this.update()));
		this.update();
	}

	private decorationFor(uri: URI): IDecorationData | undefined {
		if (this.mode !== 'agent') {
			return undefined;
		}
		const relative = agentRelative(this.activeService, uri);
		const stats = relative !== undefined ? this.activeService.turnChanges.get(relative) : undefined;
		if (!stats) {
			return undefined;
		}
		return stats.created
			? { letter: 'A', color: 'gitDecoration.addedResourceForeground', tooltip: localize('agentCreated', "Created by the agent's last prompt that changed files"), bubble: true }
			: { letter: 'M', color: 'gitDecoration.modifiedResourceForeground', tooltip: localize('agentModified', "Changed by the agent's last prompt that changed files"), bubble: true };
	}

	/** Refreshes the files that were marked and the ones that are marked now, and re-filters git on a mode switch. */
	private update(): void {
		const root = this.activeService.agentRoot();
		const now = root && this.activeService.explorerCountsMode === 'agent' ? [...this.activeService.turnChanges.keys()].map(path => URI.joinPath(root, path)) : [];
		const modeChanged = this.mode !== this.activeService.explorerCountsMode;
		this.mode = this.activeService.explorerCountsMode;
		const affected = [...this.marked, ...now];
		this.marked = now;
		if (affected.length) {
			this._onDidChangeDecorations.fire(affected);
		}
		if (modeChanged) {
			this._onDidChangeFilter.fire();
		}
	}
}
