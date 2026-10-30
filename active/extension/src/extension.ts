/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentProvider, BridgeProvider, InstallerSpec, MuseProvider } from './agents/providers';
import { ActiveController } from './controller';
import { HistoryStore, ProfileStore } from './history/historyStore';
import { ActiveEvent, ActiveSetting, AgentRunSettings, AskRequest, DEFAULT_PROFILE, ElaborateRequest, ExtensionCommand, KnowledgeProfile, REASONING_EFFORTS, ReasoningEffort, SignInMethod, SynthesizeResult, WORKBENCH_EVENT_COMMAND } from './shared/activeProtocol';
import { ChangeTracker } from './tracking/changeTracker';
import { isIgnoredPath, WorkspaceFiles } from './tracking/workspaceFiles';
import { AgentSetup } from './setup/agentSetup';
import { PhononNarrator } from './tts/phonon';

/** The coding session last open in this folder (resumed on the next start). */
const LAST_SESSION_KEY = 'active.codingSessionId';

function config<T>(key: string, fallback: T): T {
	return vscode.workspace.getConfiguration('active').get<T>(key, fallback);
}

/** The model and effort a role should use. `default` effort and an empty model leave Muse's own defaults. */
function runSettings(role: 'coding' | 'explanation'): AgentRunSettings {
	const settings = vscode.workspace.getConfiguration();
	const model = settings.get<string>(role === 'coding' ? ActiveSetting.CodingModel : ActiveSetting.ExplanationModel, '').trim();
	const effort = settings.get<string>(role === 'coding' ? ActiveSetting.CodingEffort : ActiveSetting.ExplanationEffort, 'default');
	return {
		model: model || undefined,
		reasoningEffort: (REASONING_EFFORTS as readonly string[]).includes(effort) ? effort as ReasoningEffort : undefined,
	};
}

/** Voice and speed used to live in the knowledge profile; carry them over to settings once. */
async function migrateNarrationSettings(stored: Partial<KnowledgeProfile>): Promise<void> {
	const settings = vscode.workspace.getConfiguration();
	const voice = settings.inspect<string>(ActiveSetting.NarrationVoice);
	if (stored.voice && stored.voice !== 'default' && voice?.globalValue === undefined) {
		await settings.update(ActiveSetting.NarrationVoice, stored.voice, vscode.ConfigurationTarget.Global);
	}
	const speed = settings.inspect<number>(ActiveSetting.NarrationSpeed);
	if (stored.narrationRate !== undefined && stored.narrationRate !== 1 && speed?.globalValue === undefined) {
		await settings.update(ActiveSetting.NarrationSpeed, stored.narrationRate, vscode.ConfigurationTarget.Global);
	}
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

	let profile: KnowledgeProfile = DEFAULT_PROFILE;
	const profileStore = new ProfileStore(path.join(context.globalStorageUri.fsPath, 'profile.json'));
	// Older saved profiles may lack newer fields (`followClosely` was `wantToLearn`).
	const stored = await profileStore.read<Partial<KnowledgeProfile> & { wantToLearn?: string }>(DEFAULT_PROFILE);
	const { wantToLearn, voice: _voice, narrationRate: _rate, ...rest } = stored;
	profile = { ...DEFAULT_PROFILE, ...rest, followClosely: rest.followClosely ?? wantToLearn ?? '' };
	await migrateNarrationSettings(stored).catch(error => log(`couldn't move narration settings: ${error}`));

	const emit = (event: ActiveEvent) => {
		void vscode.commands.executeCommand(WORKBENCH_EVENT_COMMAND, event).then(undefined, () => undefined);
	};

	const narrator = new PhononNarrator(resolvePython(context.extensionPath), context.asAbsolutePath(path.join('resources', 'phonon_sidecar.py')), status => emit({ type: 'narration', ...status }), log);
	context.subscriptions.push({ dispose: () => narrator.dispose() });

	const folder = vscode.workspace.workspaceFolders?.[0];
	const register = (id: string, handler: (...args: never[]) => unknown) => context.subscriptions.push(vscode.commands.registerCommand(id, handler));

	register(ExtensionCommand.Synthesize, async (request: { text: string; voice?: string }): Promise<SynthesizeResult> => {
		try {
			const voice = request.voice || vscode.workspace.getConfiguration().get<string>(ActiveSetting.NarrationVoice, '') || 'default';
			return { wav: await narrator.synthesize(request.text, voice) };
		} catch (error) {
			return { error: error instanceof Error ? error.message : String(error) };
		}
	});
	register(ExtensionCommand.ProfileSet, async (next: KnowledgeProfile) => {
		profile = { ...DEFAULT_PROFILE, ...next, version: 1 };
		await profileStore.write(profile);
		emit({ type: 'profile', profile });
	});

	const storage = context.globalStorageUri.fsPath;
	const workspaceKey = folder ? createHash('sha1').update(folder.uri.fsPath).digest('hex').slice(0, 16) : 'none';
	// The coding agent platform. Muse Code is the default; the bridge is a dev-only provider.
	const providerId = config<string>('agent.provider', '') || (config<string>('dev.agentBackend', 'muse') === 'bridge' ? 'bridge' : 'muse');
	const provider: AgentProvider = providerId === 'bridge'
		? new BridgeProvider(config<string>('dev.bridgeDir', '') || path.join(storage, 'bridge', workspaceKey))
		: new MuseProvider();
	const providerInfo = { id: provider.id, name: provider.displayName, shortName: provider.shortName, devOnly: provider.devOnly };

	if (!folder || folder.uri.scheme !== 'file') {
		register(ExtensionCommand.Init, async () => ({
			agent: { status: 'unavailable', provider: providerInfo, blocker: `Open a folder to work with ${provider.displayName} in Active.`, workspaceName: 'No folder', backgroundTasks: 0 },
			chat: [], profile, history: [], turnChanges: [], narration: narrator.currentStatus,
		}));
		return;
	}

	const root = folder.uri.fsPath;
	// Earlier versions explained from snapshot copies of the project; the copies are no longer used.
	rmSync(path.join(storage, 'explain-workspaces'), { recursive: true, force: true });

	const files = new WorkspaceFiles(root);
	const tracker = new ChangeTracker(files);
	const history = new HistoryStore(path.join(storage, 'history', workspaceKey));

	let controller: ActiveController | undefined;
	const setup = new AgentSetup(provider, {
		platform: process.platform,
		configuredPath: () => config<string>('muse.binaryPath', '') || undefined,
		secrets: context.secrets,
		signInScript: context.asAbsolutePath(path.join('resources', 'agent_signin.py')),
		python: () => ['/usr/bin/python3', '/opt/homebrew/bin/python3', '/usr/local/bin/python3', resolvePython(context.extensionPath)].find(candidate => existsSync(candidate)),
		scratchDir: path.join(storage, 'sign-in'),
		installerOverride: () => {
			// DEV ONLY: lets the setup flow be exercised with a stand-in installer.
			const command = config<string>('dev.installCommand', '');
			return command ? { display: command, command: '/bin/sh', args: ['-c', command] } as InstallerSpec : undefined;
		},
		emit: () => controller?.refreshAgentState(),
		onReady: async () => { await controller?.reconnect(); },
		log,
	});

	// Both sessions run in the project; the explanation one under a read-only permission profile.
	const startHost = async (role: 'coding' | 'explanation') => {
		const bin = setup.locate();
		if (!bin) {
			throw new Error(`${provider.displayName} is not installed.`);
		}
		try {
			return await provider.startHost(bin, { role, cwd: root, env: await setup.agentEnv(), log: line => log(`[${provider.id}] ${line}`) });
		} catch (error) {
			throw new Error(`Could not start ${provider.displayName} (${bin}): ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const active = new ActiveController({
		provider: providerInfo,
		needsSetup: () => setup.evaluate(),
		setupState: () => setup.current,
		isAuthFailure: (kind, message) => provider.isAuthFailure(kind, message),
		onAuthRequired: reason => setup.requireSignIn(reason),
		accountHint: async () => (await setup.usesApiKey()) ? 'API key' : undefined,
		workspaceName: folder.name,
		workspaceRoot: root,
		backgroundTimeoutMs: () => Math.max(0, config<number>('walkthrough.backgroundTimeoutSeconds', 20)) * 1000,
		checkpointMs: () => Math.max(1, config<number>('explain.checkpointMinutes', 5)) * 60_000,
		chapterMs: () => Math.max(1, config<number>('explain.chapterMinutes', 10)) * 60_000,
		preferNotes: () => config<boolean>('explain.preferNotesForSmallChanges', true),
		profile: () => profile,
		emit,
		log,
		startCodingHost: () => startHost('coding'),
		startExplanationHost: () => startHost('explanation'),
		runSettings,
		lastSessionId: () => context.workspaceState.get<string>(LAST_SESSION_KEY),
		rememberSession: sessionId => void context.workspaceState.update(LAST_SESSION_KEY, sessionId),
	}, tracker, history);
	controller = active;
	context.subscriptions.push({ dispose: () => void active.dispose() });
	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if ([ActiveSetting.CodingModel, ActiveSetting.ExplanationModel].some(key => event.affectsConfiguration(key))) {
			void active.applyRunSettings();
		}
	}));

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
			void active.onFileChanged(relative).catch(error => log(`tracking ${relative} failed: ${error}`));
		}, 120));
	};
	const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*'));
	context.subscriptions.push(watcher, watcher.onDidChange(onDisk), watcher.onDidCreate(onDisk), watcher.onDidDelete(onDisk));

	// Attribute saves to the user when they were typing in that document.
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
		if (event.contentChanges.length && event.document.isDirty && event.document.uri.scheme === 'file') {
			const relative = files.relative(event.document.uri.fsPath);
			if (relative) {
				active.noteUserTyping(relative);
			}
		}
	}));

	register(ExtensionCommand.Init, async () => ({ ...(await active.initialState()), narration: narrator.currentStatus, profile }));
	register(ExtensionCommand.SubmitTask, (text: string) => active.submitTask(text));
	register(ExtensionCommand.Ask, (request: AskRequest) => active.ask(request));
	register(ExtensionCommand.DecideApproval, (request: { approvalId: string; choiceId: string }) => active.decideApproval(request.approvalId, request.choiceId));
	register(ExtensionCommand.HistoryGet, (turnId: string) => active.historyGet(turnId));
	register(ExtensionCommand.HistoryDelete, (turnId?: string) => active.historyDelete(turnId));
	register(ExtensionCommand.SetupInstall, () => setup.install());
	register(ExtensionCommand.SetupChooseMethod, (method: SignInMethod) => setup.chooseMethod(method));
	register(ExtensionCommand.SetupSignIn, () => setup.signInWithBrowser());
	register(ExtensionCommand.SetupSaveApiKey, (key: string) => setup.saveApiKey(key));
	register(ExtensionCommand.SetupCancel, () => setup.cancel());
	register(ExtensionCommand.Reconnect, () => active.reconnect());
	register(ExtensionCommand.NewSession, () => active.newSession());
	register(ExtensionCommand.ResumeSession, (sessionId: string) => active.resumeSession(sessionId));
	register(ExtensionCommand.Elaborate, (request: ElaborateRequest) => active.elaborate(request));
	register(ExtensionCommand.SetupRestart, () => {
		setup.restart();
		active.refreshAgentState();
	});

	// Show sign-in before the first task rather than after it fails.
	void active.connect().then(() => setup.checkSignedIn());
	// Warm the narrator so the first walkthrough starts speaking promptly.
	void narrator.start().catch(error => log(`narration unavailable: ${error instanceof Error ? error.message : error}`));
}

export function deactivate(): void { }
