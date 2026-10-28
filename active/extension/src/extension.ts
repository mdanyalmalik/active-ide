/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { locateMuse, MuseHost } from './agents/museHost';
import { ActiveController } from './controller';
import { HistoryStore, ProfileStore } from './history/historyStore';
import { ActiveEvent, AskRequest, DEFAULT_PROFILE, ExtensionCommand, LearningProfile, SynthesizeResult, WORKBENCH_EVENT_COMMAND } from './shared/activeProtocol';
import { ChangeTracker } from './tracking/changeTracker';
import { isIgnoredPath, WorkspaceFiles } from './tracking/workspaceFiles';
import { PhononNarrator } from './tts/phonon';

const INSTALL_HINT = 'Install Muse Code with `curl -fsSL https://dev.meta.ai/install.sh | sh`, run `muse` once in a terminal to sign in with your subscription, then reload Active. You can also set `active.muse.binaryPath`.';

function config<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration('active').get<T>(key, fallback);
}

function resolvePython(extensionPath: string): string {
	const configured = config<string>('narration.pythonPath', '');
	if (configured) {
		return configured;
	}
	const candidates = [
		path.resolve(extensionPath, '..', '..', '..', '.tools', 'tts-venv', 'bin', 'python'),
		path.join(os.homedir(), '.active', 'tts-venv', 'bin', 'python'),
	];
	return candidates.find(candidate => existsSync(candidate)) ?? candidates[0];
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	const output = vscode.window.createOutputChannel('Active', { log: true });
	context.subscriptions.push(output);
	const log = (line: string) => output.info(line);

	let profile: LearningProfile = DEFAULT_PROFILE;
	const profileStore = new ProfileStore(path.join(context.globalStorageUri.fsPath, 'profile.json'));
	profile = await profileStore.read(DEFAULT_PROFILE);

	const emit = (event: ActiveEvent) => {
		void vscode.commands.executeCommand(WORKBENCH_EVENT_COMMAND, event).then(undefined, () => undefined);
	};

	const narrator = new PhononNarrator(resolvePython(context.extensionPath), context.asAbsolutePath(path.join('resources', 'phonon_sidecar.py')), status => emit({ type: 'narration', ...status }), log);
	context.subscriptions.push({ dispose: () => narrator.dispose() });

	const folder = vscode.workspace.workspaceFolders?.[0];
	const register = (id: string, handler: (...args: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, handler));

	register(ExtensionCommand.Synthesize, async (request: { text: string; voice?: string }): Promise<SynthesizeResult> => {
		try {
			return { wav: await narrator.synthesize(request.text, request.voice ?? profile.voice) };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	});
	register(ExtensionCommand.ProfileSet, async (next: LearningProfile) => {
		profile = { ...DEFAULT_PROFILE, ...next, version: 1 };
		await profileStore.write(profile);
		emit({ type: 'profile', profile });
	});

	if (!folder || folder.uri.scheme !== 'file') {
		register(ExtensionCommand.Init, async () => ({
			agent: { status: 'unavailable', blocker: 'Open a folder to work with Muse Code in Active.', workspaceName: 'No folder', backgroundTasks: 0 },
			chat: [], profile, history: [], turnChanges: [], narration: narrator.currentStatus,
		}));
		return;
	}

	const root = folder.uri.fsPath;
	const workspaceKey = createHash('sha1').update(root).digest('hex').slice(0, 16);
	const storage = context.globalStorageUri.fsPath;
	const explanationWorkspace = path.join(storage, 'explain-workspaces', workspaceKey);
	mkdirSync(explanationWorkspace, { recursive: true });

	const files = new WorkspaceFiles(root);
	const tracker = new ChangeTracker(files);
	const history = new HistoryStore(path.join(storage, 'history', workspaceKey));

	const startHost = async (cwd: string) => {
		const muse = locateMuse(config<string>('muse.binaryPath', '') || undefined);
		if (!muse) {
			throw new Error(`Muse Code CLI not found. ${INSTALL_HINT}`);
		}
		try {
			return await MuseHost.spawn(muse, cwd, line => log(`[muse] ${line}`));
		} catch (error) {
			throw new Error(`Could not start \`muse serve\` (${muse}): ${error instanceof Error ? error.message : String(error)}\n${INSTALL_HINT}`);
		}
	};

	const controller = new ActiveController({
		workspaceName: folder.name,
		workspaceRoot: root,
		explanationWorkspace,
		backgroundTimeoutMs: () => Math.max(0, config<number>('walkthrough.backgroundTimeoutSeconds', 20)) * 1000,
		minMeaningfulLines: () => config<number>('explain.minMeaningfulLines', 8),
		draftQuietMs: () => Math.max(1, config<number>('explain.draftQuietSeconds', 6)) * 1000,
		profile: () => profile,
		emit,
		log,
		startCodingHost: () => startHost(root),
		startExplanationHost: () => startHost(explanationWorkspace),
	}, tracker, history);
	context.subscriptions.push({ dispose: () => void controller.dispose() });

	// Capture every change on disk (file tools and shell commands alike).
	const timers = new Map<string, NodeJS.Timeout>();
	const onDisk = (uri: vscode.Uri) => {
		const relative = files.relative(uri.fsPath);
		if (!relative || isIgnoredPath(relative)) {
			return;
		}
		clearTimeout(timers.get(relative));
		timers.set(relative, setTimeout(() => {
			timers.delete(relative);
			void controller.onFileChanged(relative).catch(error => log(`tracking ${relative} failed: ${error}`));
		}, 120));
	};
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
	context.subscriptions.push(watcher, watcher.onDidChange(onDisk), watcher.onDidCreate(onDisk), watcher.onDidDelete(onDisk));

	// Attribute saves to the user when they were typing in that document.
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
		if (event.contentChanges.length && event.document.isDirty && event.document.uri.scheme === 'file') {
			const relative = files.relative(event.document.uri.fsPath);
			if (relative) {
				controller.noteUserTyping(relative);
			}
		}
	}));

	register(ExtensionCommand.Init, async () => ({ ...(await controller.initialState()), narration: narrator.currentStatus, profile }));
	register(ExtensionCommand.SubmitTask, (text: string) => controller.submitTask(text));
	register(ExtensionCommand.Ask, (request: AskRequest) => controller.ask(request));
	register(ExtensionCommand.DecideApproval, (request: { approvalId: string; choiceId: string }) => controller.decideApproval(request.approvalId, request.choiceId));
	register(ExtensionCommand.HistoryGet, (turnId: string) => controller.historyGet(turnId));
	register(ExtensionCommand.HistoryDelete, (turnId?: string) => controller.historyDelete(turnId));

	void controller.connect();
	// Warm the narrator so the first walkthrough starts speaking promptly.
	void narrator.start().catch(error => log(`narration unavailable: ${error instanceof Error ? error.message : error}`));
}

export function deactivate(): void { }
