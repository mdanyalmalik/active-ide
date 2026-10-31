/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { existsSync, promises as fs, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentProvider, BridgeProvider, InstallerSpec, MuseProvider } from './agents/providers';
import { ActiveController } from './controller';
import { NATIVE_DEBUGGER_EXTENSION, registerDebugAdapters } from './debug/adapters';
import { DebugRunner } from './debug/debugRunner';
import { LocalToolchain } from './debug/toolchain';
import { callDebugTool, DEBUG_TOOLS, MCP_SERVER_NAME } from './debug/debugTools';
import { RunningMcpServer, startMcpServer } from './debug/mcpServer';
import { VscodeDebugBackend } from './debug/vscodeDebugBackend';
import { DiagramAgent } from './diagram/diagramAgent';
import { TraceBuilder } from './trace/traceBuilder';
import { ExplainerMemory } from './explain/memory';
import { HistoryStore, ProfileStore } from './history/historyStore';
import { ActiveEvent, ActiveSetting, AgentRunSettings, DiagramFolderMode, AskRequest, BriefingRequest, DEFAULT_PROFILE, ElaborateRequest, ExtensionCommand, KnowledgeProfile, REASONING_EFFORTS, ReasoningEffort, SignInMethod, SynthesizeResult, SystemMapTextEdit, TraceRequest, WORKBENCH_EVENT_COMMAND } from './shared/activeProtocol';
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

	// The coding agent's debugger: an MCP server only the coding host is given (so the explainer and the diagram
	// agent never get it). Commands run under VS Code's debugger, hidden from the developer's debug UI.
	// Each language has its own debugger: js-debug (built in), debugpy (vendored here), Delve (installed on first use
	// with the developer's Go) and CodeLLDB (a built-in extension).
	context.subscriptions.push(registerDebugAdapters(path.join(context.extensionPath, 'vendor'), log));
	const debugBackend = new VscodeDebugBackend(folder);
	context.subscriptions.push(debugBackend);
	const debugRunner = new DebugRunner({
		backend: debugBackend,
		toolchain: new LocalToolchain({ workspaceRoot: root, toolsDir: path.join(storage, 'tools'), nativeDebugger: () => !!vscode.extensions.getExtension(NATIVE_DEBUGGER_EXTENSION), log }),
		workspaceRoot: root,
		fileExists: async file => (await fs.stat(file).then(stat => stat.isFile(), () => false)),
		directoryExists: async dir => (await fs.stat(dir).then(stat => stat.isDirectory(), () => false)),
		log: line => log(line),
	});
	context.subscriptions.push({ dispose: () => void debugRunner.stopAll() });
	const debugToolsOn = () => config<boolean>('debug.agentTools', true);
	let debugServer: Promise<RunningMcpServer | undefined> | undefined;
	const debugMcpServer = () => debugServer ??= startMcpServer({
		name: MCP_SERVER_NAME,
		version: String(context.extension.packageJSON.version ?? '0'),
		tools: DEBUG_TOOLS,
		call: async (name, args) => debugToolsOn() ? callDebugTool(debugRunner, name, args) : { text: 'The developer has turned the debugger off in Active\'s settings. Continue without it.', isError: true },
		log,
	}).then(server => {
		context.subscriptions.push({ dispose: () => void server.close() });
		return server;
	}, error => {
		log(`debug tools unavailable: couldn't start the MCP server: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	});
	/** Whether the running coding host was given the debug tools. */
	let codingHostHasDebugTools = false;

	// Both sessions run in the project; the explanation one under a read-only permission profile.
	const startHost = async (role: 'coding' | 'explanation') => {
		const bin = setup.locate();
		if (!bin) {
			throw new Error(`${provider.displayName} is not installed.`);
		}
		try {
			const env = await setup.agentEnv();
			const server = role === 'coding' && debugToolsOn() ? await debugMcpServer() : undefined;
			if (role === 'coding') {
				codingHostHasDebugTools = !!server;
			}
			// Muse takes secrets in `-c` settings only from the environment, so the token travels there.
			const codingArgs = server ? ['-c', `mcpServers.${MCP_SERVER_NAME}=${JSON.stringify({ transport: 'streamable_http', url: server.url, headers: { Authorization: '${ACTIVE_MCP_AUTH}' }, mode: 'optional' })}`] : [];
			return await provider.startHost(bin, { role, cwd: root, env: server ? { ...env, ACTIVE_MCP_AUTH: `Bearer ${server.token}` } : env, log: line => log(`[${provider.id}] ${line}`), codingArgs });
		} catch (error) {
			throw new Error(`Could not start ${provider.displayName} (${bin}): ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	// The diagram agent hears about checkpoints from the controller, which is created first.
	let diagram: DiagramAgent | undefined;
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
		// The explainer's own memory: personal notes follow the developer across folders, project notes stay with this one.
		memory: new ExplainerMemory({ personal: path.join(storage, 'explainer-memory.json'), project: path.join(storage, 'explainer-memory', `${workspaceKey}.json`) }),
		explanationsEnabled: () => config<string>('explain.mode', 'auto') !== 'off' && config<string>('features', 'both') !== 'diagrams',
		debugTools: {
			available: () => debugToolsOn() && codingHostHasDebugTools,
			suggestWhenStuck: () => config<boolean>('debug.suggestWhenStuck', true),
			stopAll: () => debugRunner.stopAll(),
		},
		onDiagramCheckpoint: snapshot => void diagram?.checkpoint(snapshot).catch(error => log(`diagram checkpoint failed: ${error}`)),
		profile: () => profile,
		systemMap: async version => version === undefined ? (await diagram?.state())?.current?.map : (await diagram?.revision(version))?.map,
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

	// The diagram agent: its own read-only session, keeping this folder's system map.
	const diagramSession = active.createSideAgent();
	const diagramAgent = diagram = new DiagramAgent({
		session: { ask: prompt => diagramSession.ask(prompt) },
		storePath: path.join(storage, 'system-map', `${workspaceKey}.json`),
		fileExists: async relative => !relative.includes('..') && existsSync(path.join(root, relative)),
		listFiles: async () => {
			const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.venv/**,**/__pycache__/**}', 600);
			const relative = found.map(uri => files.relative(uri.fsPath)).filter((file): file is string => !!file && !isIgnoredPath(file)).sort();
			return { files: relative.slice(0, 400), truncated: relative.length > 400 };
		},
		emit: state => emit({ type: 'diagram', state }),
		announce: (text, version, turnId) => active.diagramNote(text, version, turnId),
		log: line => log(line),
		enabled: () => config<string>('features', 'both') !== 'explanations',
		checkMs: () => Math.max(0, config<number>('diagram.checkMinutes', 2)) * 60_000,
	});
	context.subscriptions.push({ dispose: () => diagramAgent.dispose() });
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

	register(ExtensionCommand.Init, async () => ({ ...(await active.initialState()), narration: narrator.currentStatus, profile, diagram: await diagramAgent.state() }));
	register(ExtensionCommand.DiagramBuild, () => diagramAgent.build());
	register(ExtensionCommand.DiagramUpdate, () => diagramAgent.updateNow());
	// Code traces: their own read-only session on the explanation host (so they don't wait behind walkthroughs),
	// observed with the same debug runner as the coding agent's tools.
	let traceSession: ReturnType<typeof active.createSideAgent> | undefined;
	const traces = new TraceBuilder({
		ask: prompt => (traceSession ??= active.createSideAgent()).ask(prompt),
		root,
		listFiles: async () => {
			const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.venv/**,**/__pycache__/**}', 600);
			return found.map(uri => files.relative(uri.fsPath)).filter((file): file is string => !!file && !isIgnoredPath(file)).sort().slice(0, 400);
		},
		readFile: async relative => {
			const absolute = path.resolve(root, relative);
			return absolute.startsWith(root + path.sep) ? fs.readFile(absolute, 'utf8').catch(() => undefined) : undefined;
		},
		runner: debugRunner,
		storeDir: path.join(storage, 'traces', workspaceKey),
		emit: trace => emit({ type: 'trace', trace }),
		profile: () => profile,
		log,
	});
	register(ExtensionCommand.TraceBuild, (request: TraceRequest) => traces.build(request));
	register(ExtensionCommand.TraceGet, (id: string) => traces.get(id));
	register(ExtensionCommand.TraceList, () => traces.list());
	register(ExtensionCommand.TraceDelete, (id: string) => traces.delete(id));
	register(ExtensionCommand.DiagramReviseText, (edit: SystemMapTextEdit) => diagramAgent.reviseText(edit));
	register(ExtensionCommand.DiagramEdit, (request: string) => active.editDiagram(request, text => diagramAgent.edit(text)));
	register(ExtensionCommand.DiagramRevision, (version: number) => diagramAgent.revision(version));
	register(ExtensionCommand.DiagramSetFolderMode, (mode: DiagramFolderMode) => diagramAgent.setFolderMode(mode));
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
	register(ExtensionCommand.Brief, (request: BriefingRequest) => active.brief(request));
	register(ExtensionCommand.ResumeSession, (sessionId: string) => active.resumeSession(sessionId));
	register(ExtensionCommand.Elaborate, (request: ElaborateRequest) => active.elaborate(request));
	register(ExtensionCommand.GitChanges, () => active.gitChanges());
	register(ExtensionCommand.AgentBaseline, (path: string) => active.agentBaseline(path));
	register(ExtensionCommand.MemoryGet, () => active.memoryNotes());
	register(ExtensionCommand.MemoryDelete, (id?: string) => active.forget(id));
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
