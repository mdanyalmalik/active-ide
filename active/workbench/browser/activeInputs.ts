/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { EditorInputCapabilities, IUntypedEditorInput } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import type { Walkthrough } from '../common/activeProtocol.js';

export class ActiveChatInput extends EditorInput {
	static readonly ID = 'workbench.input.activeChat';
	static readonly RESOURCE = URI.from({ scheme: 'active', path: '/chat' });

	override get typeId(): string {
		return ActiveChatInput.ID;
	}

	override get resource(): URI {
		return ActiveChatInput.RESOURCE;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('activeChat', "Active Chat");
	}

	override getIcon(): ThemeIcon {
		return Codicon.commentDiscussion;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof ActiveChatInput;
	}
}

export class WalkthroughInput extends EditorInput {
	static readonly ID = 'workbench.input.activeWalkthrough';

	private readonly _onDidChangeFile = this._register(new Emitter<void>());
	/** The captured file on screen changed (Explorer outlines it). */
	readonly onDidChangeFile = this._onDidChangeFile.event;
	private currentFile: string;

	constructor(readonly walkthrough: Walkthrough, startScene = 0) {
		super();
		this.currentFile = walkthrough.scenes[startScene]?.file ?? walkthrough.scenes[0]?.file ?? '';
	}

	override get typeId(): string {
		return WalkthroughInput.ID;
	}

	override get resource(): URI {
		return URI.from({ scheme: 'active', path: `/walkthrough/${this.walkthrough.id}` });
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	/** The workspace-relative path of the captured file currently on screen. */
	get file(): string {
		return this.currentFile;
	}

	/** The tab's tooltip names the captured file currently on screen. */
	setCurrentFile(file: string): void {
		if (file !== this.currentFile) {
			this.currentFile = file;
			this._onDidChangeLabel.fire();
			this._onDidChangeFile.fire();
		}
	}

	// The file is already in the walkthrough's own file strip, so the tab just says what it is.
	override getName(): string {
		return localize('walkthrough', "Walkthrough");
	}

	/** Told apart by the task when two walkthroughs are open. */
	override getDescription(): string {
		return this.walkthrough.title;
	}

	override getTitle(): string {
		return this.currentFile ? localize('walkthroughTitle', "Walkthrough — {0}", this.currentFile) : this.getName();
	}

	override getIcon(): ThemeIcon {
		return Codicon.playCircle;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof WalkthroughInput && other.walkthrough.id === this.walkthrough.id;
	}
}

export class KnowledgeProfileInput extends EditorInput {
	static readonly ID = 'workbench.input.activeKnowledgeProfile';
	static readonly RESOURCE = URI.from({ scheme: 'active', path: '/profile' });

	override get typeId(): string {
		return KnowledgeProfileInput.ID;
	}

	override get resource(): URI {
		return KnowledgeProfileInput.RESOURCE;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('knowledgeProfile', "Knowledge Profile");
	}

	override getIcon(): ThemeIcon {
		return Codicon.mortarBoard;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof KnowledgeProfileInput;
	}
}

/** The system map: the diagram agent's view of the project's components and how they connect. */
export class SystemMapInput extends EditorInput {
	static readonly ID = 'workbench.input.activeSystemMap';
	static readonly RESOURCE = URI.from({ scheme: 'active', path: '/system-map' });

	private readonly _onDidChangeSelection = this._register(new Emitter<void>());
	/** The files of the component clicked on the map changed (Explorer outlines them). */
	readonly onDidChangeSelection = this._onDidChangeSelection.event;
	private _selectedFiles: readonly string[] = [];

	override get typeId(): string {
		return SystemMapInput.ID;
	}

	override get resource(): URI {
		return SystemMapInput.RESOURCE;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	/** Workspace-relative paths of the files the selected component or connection cites. */
	get selectedFiles(): readonly string[] {
		return this._selectedFiles;
	}

	select(files: readonly string[]): void {
		if (files.length !== this._selectedFiles.length || files.some((file, index) => file !== this._selectedFiles[index])) {
			this._selectedFiles = files;
			this._onDidChangeSelection.fire();
		}
	}

	override getName(): string {
		return localize('systemMap', "System Map");
	}

	override getIcon(): ThemeIcon {
		return Codicon.typeHierarchy;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof SystemMapInput;
	}
}

/**
 * The Code Trace tab: one tab with its own question box and history, showing one trace at a time (how a behavior
 * flows through the code, step by step, and what running it showed), or the history when none is picked.
 */
export class TraceInput extends EditorInput {
	static readonly ID = 'workbench.input.activeTrace';

	private readonly _onDidChangeSelection = this._register(new Emitter<void>());
	readonly onDidChangeSelection = this._onDidChangeSelection.event;
	private title = '';

	constructor(private selected?: string) {
		super();
	}

	override get typeId(): string {
		return TraceInput.ID;
	}

	override get resource(): URI {
		return URI.from({ scheme: 'active', path: '/trace' });
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	/** The trace on show, or none for the history. */
	get traceId(): string | undefined {
		return this.selected;
	}

	select(traceId: string | undefined): void {
		if (traceId !== this.selected) {
			this.selected = traceId;
			this.setTitle('');
			this._onDidChangeSelection.fire();
		}
	}

	setTitle(title: string): void {
		if (title !== this.title) {
			this.title = title;
			this._onDidChangeLabel.fire();
		}
	}

	override getName(): string {
		return localize('codeTrace', "Code Trace");
	}

	override getDescription(): string {
		return this.title;
	}

	override getTitle(): string {
		return this.title ? localize('codeTraceTitle', "Code Trace — {0}", this.title) : this.getName();
	}

	override getIcon(): ThemeIcon {
		return Codicon.debugAlt;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof TraceInput;
	}
}
