/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

export const enum WalkthroughCommandIds {
	TogglePlayback = 'active.walkthrough.togglePlayback',
	Rewind = 'active.walkthrough.rewind',
	Advance = 'active.walkthrough.advance',
	OpenChat = 'active.walkthrough.openChat',
	OpenFile = 'active.walkthrough.openFile',
	Resume = 'active.walkthrough.resume',
}

export const enum ActiveCommandIds {
	OpenChat = 'active.openChat',
	OpenProfile = 'active.openKnowledgeProfile',
	DeleteAllHistory = 'active.history.deleteAll',
	SignIn = 'active.signInToAgent',
	PickVoice = 'active.pickNarrationVoice',
	OpenSettings = 'active.openSettings',
	NewChat = 'active.newChat',
	CatchUp = 'active.catchUp',
	PickExplainMode = 'active.pickExplainMode',
	ResumeChat = 'active.resumeChat',
	PickCodingEffort = 'active.pickCodingEffort',
	OpenRecentWalkthrough = 'active.openRecentWalkthrough',
	WalkthroughHistory = 'active.walkthroughHistory',
	OpenSystemMap = 'active.openSystemMap',
}
