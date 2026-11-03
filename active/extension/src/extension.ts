/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, promises as fs, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { AgentProvider, BridgeProvider, InstallerSpec, MuseProvider } from './agents/providers';
import { ActiveController } from './controller';
import type { AgentHost } from './agents/agentTypes';
import { AgentManager, AgentRuntime, AgentSpec, RuntimeHooks, SavedSubagent } from './agents/agentManager';
import { WorktreeManager } from './agents/worktrees';
import { buildBriefingPrompt, BriefingContext, BriefingTurn } from './explain/prompts';
import { ExplainerGate } from './explain/planner';
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
import { AgentApprovalMode, Briefing, DiagramState, ExplainMode, extractJsonObject, MAIN_AGENT_ID, MergeAgentsRequest, NewAgentRequest } from './shared/activeProtocol';
import { ActiveEvent, ActiveSetting, AgentRunSettings, DiagramFolderMode, AskRequest, BriefingRequest, DEFAULT_PROFILE, ElaborateRequest, ExtensionCommand, KnowledgeProfile, REASONING_EFFORTS, ReasoningEffort, SignInMethod, SynthesizeResult, SystemMapTextEdit, TaskRequest, TraceRequest, WORKBENCH_EVENT_COMMAND } from './shared/activeProtocol';
import { ChangeTracker } from './tracking/changeTracker';
import { isIgnoredPath, WorkspaceFiles } from './tracking/workspaceFiles';
import { AgentSetup } from './setup/agentSetup';
import { PhononNarrator } from './tts/phonon';

/** The coding session last open in this folder (resumed on the next start). */
const LAST_SESSION_KEY = 'active.codingSessionId';

/** Disposes everything added to it, newest first. */
class DisposableStore {
	private readonly items: Array<{ dispose(): unknown }> = [];
	add<T extends { dispose(): unknown }>(item: T): T {
		this.items.push(item);
		return item;
	}
	dispose(): void {
		for (const item of this.items.splice(0).reverse()) {
			try {
				item.dispose();
			} catch {
				// keep disposing the rest
			}
		}
	}
}

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

	const history = new HistoryStore(path.join(storage, 'history', workspaceKey));
	const memory = new ExplainerMemory({ personal: path.join(storage, 'explainer-memory.json'), project: path.join(storage, 'explainer-memory', `${workspaceKey}.json`) });

	let manager: AgentManager | undefined;
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
		emit: () => manager?.controllers.forEach(controller => controller.refreshAgentState()),
		onReady: async () => { await reconnectAll(); },
		log,
	});

	// The coding agent's debugger: an MCP server only the coding host is given (so the explainer and the diagram
	// agent never get it). Commands run under VS Code's debugger, hidden from the developer's debug UI.
	// Each language has its own debugger: js-debug (built in), debugpy (vendored here), Delve (installed on first use
	// with the developer's Go) and CodeLLDB (a built-in extension).
	context.subscriptions.push(registerDebugAdapters(path.join(context.extensionPath, 'vendor'), log));
	const toolchainFor = (agentRoot: string) => new LocalToolchain({ workspaceRoot: agentRoot, toolsDir: path.join(storage, 'tools'), nativeDebugger: () => !!vscode.extensions.getExtension(NATIVE_DEBUGGER_EXTENSION), log });
	const runnerFor = (agentRoot: string, agentFolder: vscode.WorkspaceFolder) => {
		const backend = new VscodeDebugBackend(agentFolder);
		const runner = new DebugRunner({
			backend,
			toolchain: toolchainFor(agentRoot),
			workspaceRoot: agentRoot,
			fileExists: async file => (await fs.stat(file).then(stat => stat.isFile(), () => false)),
			directoryExists: async dir => (await fs.stat(dir).then(stat => stat.isDirectory(), () => false)),
			log: line => log(line),
		});
		return { backend, runner };
	};
	const { backend: debugBackend, runner: debugRunner } = runnerFor(root, folder);
	context.subscriptions.push(debugBackend);
	context.subscriptions.push({ dispose: () => void debugRunner.stopAll() });
	const debugToolsOn = () => config<boolean>('debug.agentTools', true);
	/**
	 * Each agent's debugger tools: a small MCP server backed by a debug runner in that agent's folder, given to that
	 * agent's coding session only (so Agent 2's logpoints land in Agent 2's worktree; the explainer never gets them).
	 */
	const debugToolServer = (runner: DebugRunner, label: string) => {
		let started: Promise<RunningMcpServer | undefined> | undefined;
		return {
			get: () => started ??= startMcpServer({
				name: MCP_SERVER_NAME,
				version: String(context.extension.packageJSON.version ?? '0'),
				tools: DEBUG_TOOLS,
				call: async (name, args) => debugToolsOn() ? callDebugTool(runner, name, args) : { text: 'The developer has turned the debugger off in Active\'s settings. Continue without it.', isError: true },
				log,
			}).catch(error => {
				log(`debug tools unavailable for ${label}: couldn't start the MCP server: ${error instanceof Error ? error.message : String(error)}`);
				return undefined;
			}),
			close: () => void started?.then(server => server?.close()),
		};
	};

	// Both sessions run in the project; the explanation one under a read-only permission profile.
	const startHost = async (role: 'coding' | 'explanation') => {
		const bin = setup.locate();
		if (!bin) {
			throw new Error(`${provider.displayName} is not installed.`);
		}
		try {
			const env = await setup.agentEnv();
			// The debugger tools are given per session (each agent's in its own folder), not to the whole host.
			return await provider.startHost(bin, { role, cwd: root, env, log: line => log(`[${provider.id}] ${line}`) });
		} catch (error) {
			throw new Error(`Could not start ${provider.displayName} (${bin}): ${error instanceof Error ? error.message : String(error)}`);
		}
	};

	// One coding host and one explanation host serve every agent (one session each); restarting them restarts all.
	const hosts = new Map<'coding' | 'explanation', Promise<AgentHost>>();
	const sharedHost = (role: 'coding' | 'explanation'): Promise<AgentHost> => {
		let pending = hosts.get(role);
		if (!pending) {
			pending = startHost(role);
			hosts.set(role, pending);
			const current = pending;
			current.then(host => host.exited.then(() => {
				if (hosts.get(role) === current) {
					hosts.delete(role);
				}
			}), () => {
				if (hosts.get(role) === current) {
					hosts.delete(role);
				}
			});
		}
		return pending;
	};
	const reconnectAll = async () => {
		const running = [...hosts.values()];
		hosts.clear();
		for (const pending of running) {
			await pending.then(host => host.dispose(), () => undefined).catch(() => undefined);
		}
		for (const controller of manager?.controllers ?? []) {
			await controller.reconnect();
		}
	};
	context.subscriptions.push({
		dispose: () => {
			for (const pending of hosts.values()) {
				void pending.then(host => host.dispose(), () => undefined);
			}
		},
	});

	// Every agent's explainer (and diagram/trace sessions) takes turns on the explanation host: the highlighted agent first.
	const gate = new ExplainerGate(() => Math.max(1, config<number>('agents.parallelExplanations', 1)), () => manager?.focused);
	const ignoreGlob = '{**/node_modules/**,**/.git/**,**/dist/**,**/out/**,**/build/**,**/.venv/**,**/__pycache__/**}';

	const createRuntime = (spec: AgentSpec, hooks: RuntimeHooks, seedFrom?: AgentSpec): AgentRuntime & { diagram: DiagramAgent; traces: TraceBuilder; files: WorkspaceFiles; tracker: ChangeTracker; diagramState: () => Promise<DiagramState> } => {
		const agentRoot = spec.root;
		const isMain = spec.id === MAIN_AGENT_ID;
		const store = new DisposableStore();
		const files = new WorkspaceFiles(agentRoot);
		const tracker = new ChangeTracker(files);
		const agentFolder: vscode.WorkspaceFolder = isMain ? folder : { uri: vscode.Uri.file(agentRoot), name: spec.name, index: -1 };
		const sessionKey = isMain ? LAST_SESSION_KEY : `${LAST_SESSION_KEY}.${spec.id}`;
		// This agent's debug runner (in its folder), for its debugger tools and its code traces.
		const own = isMain ? undefined : runnerFor(agentRoot, agentFolder);
		const runner = own?.runner ?? debugRunner;
		if (own) {
			store.add(own.backend);
			store.add({ dispose: () => void own.runner.stopAll() });
		}
		const tools = debugToolServer(runner, spec.name);
		store.add({ dispose: () => tools.close() });
		let toolsGiven = false;
		// The diagram agent hears about checkpoints from the controller, which is created first.
		let diagram: DiagramAgent | undefined;
		const controller = new ActiveController({
			agentId: spec.id,
			agentName: hooks.name,
			multiAgent: hooks.multiAgent,
			sharedHosts: true,
			gate,
			overlaps: hooks.overlaps,
			onActivity: hooks.onActivity,
			onSubagent: hooks.onSubagent,
			provider: providerInfo,
			needsSetup: () => setup.evaluate(),
			setupState: () => setup.current,
			isAuthFailure: (kind, message) => provider.isAuthFailure(kind, message),
			onAuthRequired: reason => setup.requireSignIn(reason),
			accountHint: async () => (await setup.usesApiKey()) ? 'API key' : undefined,
			workspaceName: isMain ? folder.name : `${folder.name} · ${spec.name}`,
			workspaceRoot: agentRoot,
			backgroundTimeoutMs: () => Math.max(0, config<number>('walkthrough.backgroundTimeoutSeconds', 20)) * 1000,
			checkpointMs: () => Math.max(1, config<number>('explain.checkpointMinutes', 5)) * 60_000,
			chapterMs: () => Math.max(1, config<number>('explain.chapterMinutes', 10)) * 60_000,
			preferNotes: () => config<boolean>('explain.preferNotesForSmallChanges', true),
			// The explainer's own memory: personal notes follow the developer across folders, project notes stay with this one.
			memory,
			// Each agent has its own explanation mode; the setting is the main agent's (and the default).
			explanationsEnabled: () => (hooks.mode() ?? config<string>('explain.mode', 'auto')) !== 'off' && config<string>('features', 'both') !== 'diagrams',
			debugTools: {
				available: () => debugToolsOn() && toolsGiven,
				suggestWhenStuck: () => config<boolean>('debug.suggestWhenStuck', true),
				stopAll: () => runner.stopAll(),
			},
			approvalMode: hooks.approvalMode,
			sessionTools: async () => {
				const server = debugToolsOn() ? await tools.get() : undefined;
				toolsGiven = !!server;
				return server ? { [MCP_SERVER_NAME]: { url: server.url, headers: { Authorization: `Bearer ${server.token}` } } } : undefined;
			},
			onDiagramCheckpoint: snapshot => void diagram?.checkpoint(snapshot).catch(error => log(`diagram checkpoint failed: ${error}`)),
			profile: () => profile,
			systemMap: async version => version === undefined ? (await diagram?.state())?.current?.map : (await diagram?.revision(version))?.map,
			emit: hooks.emit,
			log: line => log(isMain ? line : `[${spec.name}] ${line}`),
			startCodingHost: () => sharedHost('coding'),
			startExplanationHost: () => sharedHost('explanation'),
			runSettings,
			lastSessionId: () => context.workspaceState.get<string>(sessionKey),
			rememberSession: sessionId => void context.workspaceState.update(sessionKey, sessionId),
		}, tracker, history);

		// The diagram agent: its own read-only session, keeping this agent's system map. A new agent starts from the map
		// of the agent it was started from (same code), so nothing has to be rebuilt.
		const storePath = path.join(storage, 'system-map', isMain ? `${workspaceKey}.json` : `${workspaceKey}-${spec.id}.json`);
		if (!isMain && seedFrom && !existsSync(storePath)) {
			const seed = path.join(storage, 'system-map', seedFrom.id === MAIN_AGENT_ID ? `${workspaceKey}.json` : `${workspaceKey}-${seedFrom.id}.json`);
			if (existsSync(seed)) {
				mkdirSync(path.dirname(storePath), { recursive: true });
				copyFileSync(seed, storePath);
			}
		}
		const listFiles = async () => {
			if (isMain) {
				const found = await vscode.workspace.findFiles(new vscode.RelativePattern(folder, '**/*'), ignoreGlob, 600);
				return found.map(uri => files.relative(uri.fsPath)).filter((file): file is string => !!file && !isIgnoredPath(file)).sort();
			}
			return (await files.list()).filter(file => !isIgnoredPath(file)).sort();
		};
		const diagramSession = controller.createSideAgent();
		diagram = new DiagramAgent({
			session: { ask: prompt => diagramSession.ask(prompt) },
			storePath,
			fileExists: async relative => !relative.includes('..') && existsSync(path.join(agentRoot, relative)),
			listFiles: async () => {
				const relative = await listFiles();
				return { files: relative.slice(0, 400), truncated: relative.length > 400 };
			},
			emit: state => hooks.emit({ type: 'diagram', state }),
			announce: (text, version, turnId) => controller.diagramNote(text, version, turnId),
			log: line => log(line),
			enabled: () => config<string>('features', 'both') !== 'explanations',
			checkMs: () => Math.max(0, config<number>('diagram.checkMinutes', 2)) * 60_000,
		});
		const diagramAgent = diagram;
		if (!isMain) {
			// Started before the first map was ready (nothing to copy): build its own once, if maps are kept updated.
			void diagramAgent.state().then(state => {
				if (!state.current && state.folderMode === 'auto' && state.status !== 'building') {
					return diagramAgent.build();
				}
				return undefined;
			}).catch(error => log(`[${spec.name}] map build failed: ${error}`));
		}

		// Code traces: their own read-only session on the explanation host (so they don't wait behind walkthroughs),
		// observed with this agent's debug runner.
		let traceSession: ReturnType<typeof controller.createSideAgent> | undefined;
		const traces = new TraceBuilder({
			ask: prompt => (traceSession ??= controller.createSideAgent()).ask(prompt),
			root: agentRoot,
			listFiles: async () => (await listFiles()).slice(0, 400),
			readFile: async relative => {
				const absolute = path.resolve(agentRoot, relative);
				return absolute.startsWith(agentRoot + path.sep) ? fs.readFile(absolute, 'utf8').catch(() => undefined) : undefined;
			},
			runner,
			storeDir: path.join(storage, 'traces', workspaceKey),
			emit: trace => emit({ type: 'trace', trace }),
			profile: () => profile,
			log,
		});

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
		const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(isMain ? folder : vscode.Uri.file(agentRoot), '**/*'));
		store.add(watcher);
		store.add(watcher.onDidChange(onDisk));
		store.add(watcher.onDidCreate(onDisk));
		store.add(watcher.onDidDelete(onDisk));
		store.add({ dispose: () => timers.forEach(timer => clearTimeout(timer)) });
		store.add({ dispose: () => diagramAgent.dispose() });
		store.add({ dispose: () => void controller.dispose() });

		return {
			controller,
			diagram: diagramAgent,
			traces,
			files,
			tracker,
			diagramState: () => diagramAgent.state(),
			dispose: () => store.dispose(),
		};
	};
	type Runtime = ReturnType<typeof createRuntime>;

	const AGENTS_KEY = 'active.agents';
	const agents = manager = new AgentManager({
		mainRoot: root,
		worktrees: new WorktreeManager(root, path.join(storage, 'worktrees', workspaceKey), log),
		createRuntime,
		load: () => context.workspaceState.get<AgentSpec[]>(AGENTS_KEY, []),
		save: specs => void context.workspaceState.update(AGENTS_KEY, specs),
		emit,
		log,
		// No limit unless the developer sets one.
		maxAgents: () => Math.max(0, config<number>('agents.max', 0)),
		loadSubagents: () => context.workspaceState.get<SavedSubagent[]>('active.subagents', []),
		saveSubagents: subagents => void context.workspaceState.update('active.subagents', subagents),
	});
	context.subscriptions.push({ dispose: () => agents.dispose() });
	await agents.start();
	const runtime = (agentId?: string) => (agents.runtimeFor(agentId) ?? agents.runtimeFor(MAIN_AGENT_ID)) as Runtime;
	const main = () => agents.main;
	/** The controller that made a walkthrough (from its id), for questions about it. */
	const controllerForWalkthrough = async (walkthroughId: string) => {
		const turnId = walkthroughId.replace(/^wt-/, '').replace(/-c\d+$/, '');
		const owner = (await history.list()).find(turn => turn.turnId === turnId || turn.turnId.startsWith(turnId))?.agentId;
		return agents.controllerFor(owner && agents.runtimeFor(owner) ? owner : undefined);
	};

	context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
		if ([ActiveSetting.CodingModel, ActiveSetting.ExplanationModel].some(key => event.affectsConfiguration(key))) {
			agents.controllers.forEach(controller => void controller.applyRunSettings());
		}
	}));

	// Attribute saves to the user when they were typing in that document (in whichever agent's folder it is).
	context.subscriptions.push(vscode.workspace.onDidChangeTextDocument(event => {
		if (event.contentChanges.length && event.document.isDirty && event.document.uri.scheme === 'file') {
			const owner = agents.agentForPath(event.document.uri.fsPath);
			const target = owner ? agents.runtimeFor(owner) as Runtime | undefined : undefined;
			const relative = target?.files.relative(event.document.uri.fsPath);
			if (target && relative) {
				target.controller.noteUserTyping(relative);
			}
		}
	}));

	register(ExtensionCommand.Init, async () => ({
		...(await main().initialState()),
		narration: narrator.currentStatus,
		profile,
		diagram: await runtime(MAIN_AGENT_ID).diagram.state(),
		agents: agents.infos(),
		agentStates: await agents.agentStates(),
		multiAgentBlocker: agents.multiAgentBlocker,
	}));
	register(ExtensionCommand.DiagramBuild, () => runtime().diagram.build());
	register(ExtensionCommand.DiagramUpdate, () => runtime().diagram.updateNow());
	register(ExtensionCommand.TraceBuild, (request: TraceRequest) => runtime().traces.build(request));
	register(ExtensionCommand.TraceGet, (id: string) => runtime().traces.get(id));
	register(ExtensionCommand.TraceList, () => runtime().traces.list());
	register(ExtensionCommand.TraceDelete, (id: string) => runtime().traces.delete(id));
	register(ExtensionCommand.DiagramReviseText, (edit: SystemMapTextEdit) => runtime().diagram.reviseText(edit));
	register(ExtensionCommand.DiagramEdit, (request: string) => {
		const target = runtime();
		return target.controller.editDiagram(request, text => target.diagram.edit(text));
	});
	register(ExtensionCommand.DiagramRevision, (version: number) => runtime().diagram.revision(version));
	register(ExtensionCommand.DiagramSetFolderMode, (mode: DiagramFolderMode) => runtime().diagram.setFolderMode(mode));
	register(ExtensionCommand.SubmitTask, (request: string | TaskRequest, agentId?: string) => agents.submitTask(agentId, request));
	register(ExtensionCommand.Ask, (request: AskRequest, agentId?: string) => agents.controllerFor(agentId).ask(request));
	register(ExtensionCommand.DecideApproval, (request: { approvalId: string; choiceId: string; agentId?: string }) => agents.controllerFor(request.agentId).decideApproval(request.approvalId, request.choiceId));
	register(ExtensionCommand.HistoryGet, (turnId: string) => main().historyGet(turnId));
	register(ExtensionCommand.HistoryDelete, async (turnId?: string) => {
		for (const controller of agents.controllers) {
			await controller.historyDelete(turnId);
		}
	});
	register(ExtensionCommand.SetupInstall, () => setup.install());
	register(ExtensionCommand.SetupChooseMethod, (method: SignInMethod) => setup.chooseMethod(method));
	register(ExtensionCommand.SetupSignIn, () => setup.signInWithBrowser());
	register(ExtensionCommand.SetupSaveApiKey, (key: string) => setup.saveApiKey(key));
	register(ExtensionCommand.SetupCancel, () => setup.cancel());
	register(ExtensionCommand.Reconnect, () => reconnectAll());
	register(ExtensionCommand.NewSession, () => agents.controllerFor().newSession());
	register(ExtensionCommand.Brief, (request: BriefingRequest) => request.allAgents ? briefAll(request) : agents.controllerFor(request.agentId).brief(request));
	register(ExtensionCommand.ResumeSession, (sessionId: string) => agents.controllerFor().resumeSession(sessionId));
	register(ExtensionCommand.Elaborate, async (request: ElaborateRequest) => (await controllerForWalkthrough(request.walkthroughId)).elaborate(request));
	register(ExtensionCommand.GitChanges, () => agents.controllerFor().gitChanges());
	register(ExtensionCommand.AgentBaseline, (file: string) => agents.controllerFor().agentBaseline(file));
	register(ExtensionCommand.MemoryGet, () => main().memoryNotes());
	register(ExtensionCommand.MemoryDelete, (id?: string) => main().forget(id));
	register(ExtensionCommand.SetupRestart, () => {
		setup.restart();
		agents.controllers.forEach(controller => controller.refreshAgentState());
	});
	register(ExtensionCommand.AgentFocus, (agentId: string) => agents.focus(agentId));
	register(ExtensionCommand.AgentNew, (request: NewAgentRequest) => agents.create(request ?? {}));
	register(ExtensionCommand.AgentMerge, (request: MergeAgentsRequest) => agents.merge(request.sourceId, request.targetId, { commit: request.commit }));
	register(ExtensionCommand.AgentClose, (agentId: string, options?: { keep?: boolean }) => agents.close(agentId, options));
	register(ExtensionCommand.AgentRename, (request: { agentId: string; name: string }) => agents.rename(request.agentId, request.name));
	register(ExtensionCommand.AgentSetMode, (request: { agentId: string; mode: ExplainMode }) => agents.setMode(request.agentId, request.mode));
	register(ExtensionCommand.AgentSetApprovalMode, (request: { agentId: string; mode: AgentApprovalMode }) => agents.setApprovalMode(request.agentId, request.mode));
	register(ExtensionCommand.AgentInterrupt, (agentId: string) => agents.interrupt(agentId));
	register(ExtensionCommand.AgentStates, () => agents.agentStates());

	/** One Catch Me Up across every agent, grouped by agent, written by the main agent's explainer. */
	const briefAll = async (request: BriefingRequest): Promise<Briefing> => {
		const infos = agents.infos().filter(info => info.kind === 'agent');
		const perAgent: NonNullable<Briefing['agents']>[number][] = [];
		const turns: BriefingTurn[] = [];
		const allAgents: NonNullable<BriefingContext['allAgents']>[number][] = [];
		for (const info of infos) {
			const controller = agents.runtimeFor(info.id)?.controller;
			const briefing = controller ? await controller.briefingMaterial(request.since) : undefined;
			if (!briefing) {
				continue;
			}
			turns.push(...briefing.turns.map(turn => ({ ...turn, agent: info.name })));
			allAgents.push({ agentId: info.id, name: info.name, running: briefing.running, waiting: briefing.waiting });
			perAgent.push({ agentId: info.id, name: info.name, headline: briefing.turns.length ? `${briefing.turns.length} task${briefing.turns.length === 1 ? '' : 's'} finished` : briefing.running ? `Working on: ${briefing.running.task.split('\n')[0].slice(0, 80)}` : 'Nothing new', done: briefing.turns.map(turn => `${turn.task.split('\n')[0].slice(0, 80)} — ${turn.explanation}`), attention: briefing.waiting, problems: briefing.turns.flatMap(turn => turn.failedCommands.map(command => `Failed: ${command}`)) });
		}
		const overlaps = agents.overlapLines();
		const fallback: Briefing = { headline: turns.length ? `${turns.length} task${turns.length === 1 ? '' : 's'} finished across ${infos.length} agents` : 'Nothing new across your agents', done: [], attention: [], problems: overlaps, next: '', fallback: true, agents: perAgent };
		if (!turns.length && !allAgents.some(agent => agent.running || agent.waiting.length)) {
			return fallback;
		}
		try {
			const reply = await main().askExplainer(buildBriefingPrompt({ profile, minutesAway: Math.max(1, Math.round((Date.now() - request.since) / 60000)), turns, waiting: [], allAgents, overlaps }));
			const parsed = extractJsonObject(reply) as Partial<Record<keyof Briefing, unknown>> | undefined;
			const list = (value: unknown) => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item.trim()) : [];
			if (!parsed || typeof parsed.headline !== 'string') {
				throw new Error('no headline in the reply');
			}
			const groups = Array.isArray(parsed.agents) ? (parsed.agents as Array<Record<string, unknown>>).map(group => ({
				agentId: String(group.agentId ?? ''),
				name: String(group.name ?? infos.find(info => info.id === group.agentId)?.name ?? ''),
				headline: String(group.headline ?? ''),
				done: list(group.done),
				attention: list(group.attention),
				problems: list(group.problems),
			})).filter(group => group.name) : perAgent;
			return { headline: parsed.headline, done: list(parsed.done), attention: list(parsed.attention), problems: list(parsed.problems), next: typeof parsed.next === 'string' ? parsed.next : '', agents: groups };
		} catch (error) {
			log(`all-agents briefing failed: ${error instanceof Error ? error.message : String(error)}`);
			return fallback;
		}
	};

	// Show sign-in before the first task rather than after it fails.
	void main().connect().then(() => setup.checkSignedIn());
	for (const controller of agents.controllers) {
		if (controller !== main()) {
			void controller.connect();
		}
	}
	// Warm the narrator so the first walkthrough starts speaking promptly.
	void narrator.start().catch(error => log(`narration unavailable: ${error instanceof Error ? error.message : error}`));
}

export function deactivate(): void { }
