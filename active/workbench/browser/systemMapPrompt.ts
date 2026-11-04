/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { SystemMapInput } from './activeInputs.js';
import { IActiveService } from './activeService.js';

/**
 * Opening a folder that has no system map asks, once, what to do: build it and keep it updated, build it once
 * (updating only on request), or keep it off. It waits for the welcome dialog, which may still be asking what
 * Active should do at all. When the first map it asked for is ready, it says so (with a way to open it) unless the
 * map is already showing: the build takes a minute and otherwise finishes silently.
 */
export class SystemMapFolderPrompt extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.activeSystemMapPrompt';

	private asked = false;
	/** Set when the developer asked for a map here; cleared once the first one is ready. */
	private awaitingFirstMap = false;
	private retry: ReturnType<typeof setTimeout> | undefined;

	constructor(
		@IActiveService private readonly activeService: IActiveService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspaceContextService private readonly workspaceService: IWorkspaceContextService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super();
		this._register(this.activeService.onDidChangeDiagram(() => this.evaluate()));
		this._register(toDisposable(() => clearTimeout(this.retry)));
		void this.activeService.initialize().then(() => this.evaluate());
	}

	private evaluate(): void {
		const folder = this.workspaceService.getWorkspace().folders[0];
		const diagram = this.activeService.diagram;
		if (this.awaitingFirstMap && diagram.current) {
			this.awaitingFirstMap = false;
			if (!(this.editorService.activeEditor instanceof SystemMapInput)) {
				this.notificationService.prompt(Severity.Info, localize('mapReady', "The system map of {0} is ready.", folder?.name ?? ''), [
					{ label: localize('openSystemMapAction', "Open System Map"), run: () => void this.activeService.openSystemMap() },
				]);
			}
		}
		// A guest in someone's session sees the host's map; this window's own folder isn't on screen.
		if (this.activeService.remote) {
			return;
		}
		if (this.asked || !folder || !this.activeService.stateLoaded || !this.activeService.diagramsEnabled || diagram.current || diagram.folderMode !== undefined || diagram.status === 'building') {
			return;
		}
		// eslint-disable-next-line no-restricted-syntax
		if (mainWindow.document.querySelector('.active-welcome-backdrop')) {
			clearTimeout(this.retry);
			this.retry = setTimeout(() => this.evaluate(), 1500);
			return;
		}
		this.asked = true;
		this.notificationService.prompt(Severity.Info, localize('mapFolderPrompt', "Active can draw a system map of {0}: its parts and how they connect. A diagram agent reads the project to build it.", folder.name), [
			{ label: localize('mapFolderAuto', "Generate and Keep Updated"), run: () => { this.awaitingFirstMap = true; void this.activeService.setDiagramFolderMode('auto'); } },
			{ label: localize('mapFolderOnce', "Just Generate"), run: () => { this.awaitingFirstMap = true; void this.activeService.setDiagramFolderMode('manual'); } },
			{ label: localize('mapFolderOff', "Keep Off"), run: () => void this.activeService.setDiagramFolderMode('off') },
		], { sticky: true });
	}
}
