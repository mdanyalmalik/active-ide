/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IExplorerFileContribution, IExplorerFileContributionDescriptor } from '../../files/browser/explorerFileContrib.js';
import { ExplorerCountsMode, IActiveService } from './activeService.js';

const $ = dom.$;

/** Adds per-file addition/deletion counts to Explorer rows: the last prompt's, or uncommitted git changes. */
class ExplorerChangeCounts extends Disposable implements IExplorerFileContribution {
	private resource: URI | undefined;
	private readonly element: HTMLElement;

	constructor(
		private readonly container: HTMLElement,
		@IActiveService private readonly activeService: IActiveService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
	) {
		super();
		this.element = $('span.active-explorer-counts');
		this._register(this.activeService.onDidChangeExplorerCounts(() => this.render()));
	}

	setResource(resource: URI | undefined): void {
		this.resource = resource;
		this.render();
	}

	private render(): void {
		const folder = this.resource ? this.workspaceService.getWorkspaceFolder(this.resource) : undefined;
		const relative = folder && this.resource ? this.resource.path.slice(folder.uri.path.length + 1) : undefined;
		const stats = relative ? this.activeService.explorerCounts.get(relative) : undefined;
		if (!stats || (!stats.added && !stats.removed)) {
			this.element.remove();
			return;
		}
		dom.clearNode(this.element);
		// A zero is implied: "+12" alone means nothing was removed.
		if (stats.added) {
			dom.append(this.element, $('span.added')).textContent = `+${stats.added}`;
		}
		if (stats.removed) {
			dom.append(this.element, $('span.removed')).textContent = `−${stats.removed}`;
		}
		if (!this.element.parentElement) {
			this.container.appendChild(this.element);
		}
	}

	override dispose(): void {
		this.element.remove();
		super.dispose();
	}
}

export const explorerChangeCountsDescriptor: IExplorerFileContributionDescriptor = {
	create(instantiationService: IInstantiationService, container: HTMLElement): IExplorerFileContribution {
		return instantiationService.createInstance(ExplorerChangeCounts, container);
	},
};

export const ACTIVE_CHANGE_COUNTS_VIEW_ID = 'workbench.view.active.changeCounts';

/**
 * A one-line bar at the top of the Explorer: which counts the rows show. It's a header-only view (its body
 * is zero high), so it lays out with the Explorer's other sections.
 */
export class ChangeCountsBar extends ViewPane {
	private readonly barStore = this._register(new DisposableStore());
	private bar: HTMLElement | undefined;

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IActiveService private readonly activeService: IActiveService,
	) {
		super({ ...options, minimumBodySize: 0, maximumBodySize: 0 }, keybindingService, contextMenuService, configurationService, contextKeyService, viewDescriptorService, instantiationService, openerService, themeService, hoverService);
		this._register(this.activeService.onDidChangeExplorerCounts(() => this.renderBar()));
	}

	override render(): void {
		super.render();
		this.element.classList.add('active-change-counts-pane');
	}

	protected override renderHeaderTitle(container: HTMLElement, title: string): void {
		super.renderHeaderTitle(container, title);
		this.bar = dom.append(container, $('.active-change-counts-bar'));
		// The header toggles the (empty) body when clicked: keep clicks on the switch to itself.
		this._register(dom.addDisposableListener(this.bar, dom.EventType.MOUSE_DOWN, event => event.stopPropagation()));
		this._register(dom.addDisposableListener(this.bar, dom.EventType.CLICK, event => event.stopPropagation()));
		this.renderBar();
	}

	private renderBar(): void {
		const bar = this.bar;
		if (!bar) {
			return;
		}
		this.barStore.clear();
		dom.clearNode(bar);
		const mode = this.activeService.explorerCountsMode;
		const option = (value: ExplorerCountsMode, label: string, title: string, disabled = false) => {
			const button = dom.append(bar, $('button.counts-option')) as HTMLButtonElement;
			button.textContent = label;
			button.title = title;
			button.disabled = disabled;
			button.setAttribute('aria-pressed', String(mode === value));
			button.classList.toggle('selected', mode === value);
			this.barStore.add(dom.addDisposableListener(button, dom.EventType.CLICK, () => void this.activeService.setExplorerCountsMode(value)));
		};
		option('agent', localize('countsAgent', "Agent"), localize('countsAgentTitle', "Show what the agent changed in the last prompt that changed files (Explorer counts and editor change bars)"));
		const git = this.activeService.gitAvailable;
		option('git', localize('countsGit', "Git"), git ? localize('countsGitTitle', "Show everything not yet committed, including new files (Explorer counts and editor change bars)") : localize('countsNoGit', "This folder isn't a git repository"), !git && mode !== 'git');
	}
}
