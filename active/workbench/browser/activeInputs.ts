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

	constructor(readonly walkthrough: Walkthrough) {
		super();
		this.currentFile = walkthrough.scenes[0]?.file ?? '';
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
