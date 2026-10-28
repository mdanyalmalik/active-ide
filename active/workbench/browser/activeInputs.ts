/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Emitter } from '../../../../base/common/event.js';
import { basename } from '../../../../base/common/path.js';
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

	/** The tab shows the captured file currently on screen. */
	setCurrentFile(file: string): void {
		if (file !== this.currentFile) {
			this.currentFile = file;
			this._onDidChangeLabel.fire();
			this._onDidChangeFile.fire();
		}
	}

	override getName(): string {
		return this.currentFile ? basename(this.currentFile) : localize('walkthrough', "Walkthrough");
	}

	override getDescription(): string {
		return localize('activeWalkthrough', "Active walkthrough");
	}

	override getTitle(): string {
		return localize('walkthroughTitle', "{0} — Active walkthrough", this.getName());
	}

	override getIcon(): ThemeIcon {
		return Codicon.playCircle;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof WalkthroughInput && other.walkthrough.id === this.walkthrough.id;
	}
}

export class LearningProfileInput extends EditorInput {
	static readonly ID = 'workbench.input.activeLearningProfile';
	static readonly RESOURCE = URI.from({ scheme: 'active', path: '/profile' });

	override get typeId(): string {
		return LearningProfileInput.ID;
	}

	override get resource(): URI {
		return LearningProfileInput.RESOURCE;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.Readonly | EditorInputCapabilities.Singleton;
	}

	override getName(): string {
		return localize('learningProfile', "Learning Profile");
	}

	override getIcon(): ThemeIcon {
		return Codicon.mortarBoard;
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		return other instanceof LearningProfileInput;
	}
}
