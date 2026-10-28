/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IExplorerFileContribution, IExplorerFileContributionDescriptor } from '../../files/browser/explorerFileContrib.js';
import { IActiveService } from './activeService.js';

const $ = dom.$;

/** Adds the latest turn's per-file addition/deletion counts to Explorer rows. Nothing else. */
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
		this._register(this.activeService.onDidChangeTurnChanges(() => this.render()));
	}

	setResource(resource: URI | undefined): void {
		this.resource = resource;
		this.render();
	}

	private render(): void {
		const folder = this.resource ? this.workspaceService.getWorkspaceFolder(this.resource) : undefined;
		const relative = folder && this.resource ? this.resource.path.slice(folder.uri.path.length + 1) : undefined;
		const stats = relative ? this.activeService.turnChanges.get(relative) : undefined;
		if (!stats) {
			this.element.remove();
			return;
		}
		dom.clearNode(this.element);
		dom.append(this.element, $('span.added')).textContent = `+${stats.added}`;
		dom.append(this.element, $('span.removed')).textContent = `−${stats.removed}`;
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
