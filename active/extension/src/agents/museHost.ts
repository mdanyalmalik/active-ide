/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SpawnedMspConnection } from '@muse-code/sdk' with { 'resolution-mode': 'import' };
import type { AgentModelInfo } from '../shared/activeProtocol';
import type { AgentApproval, AgentHost, AgentItem, AgentSession, AgentSessionListener, AgentSessionOptions, AgentTask } from './agentTypes';

type Params = Record<string, unknown>;

const CLIENT_INFO = { name: 'active_ide', title: 'Active', version: '0.1.0' };
/** Muse Code's built-in read-only permission profile ("Reads files only"), as listed by `permissionProfile/list`. */
const READ_ONLY_PROFILE = ':read-only';

export class MuseUnavailableError extends Error { }

function asString(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}

function toItem(raw: Params): AgentItem {
	const patch = raw.patchSummary as Params | undefined;
	const completion = raw.backgroundTerminalCompletion as Params | undefined;
	const label = raw.displayLabel as Params | undefined;
	const status = asString(raw.status) ?? 'inProgress';
	return {
		id: String(raw.itemId),
		turnId: (raw.turnId as string | null | undefined) ?? null,
		kind: asString(raw.kind) ?? 'unknown',
		status,
		text: asString(raw.text),
		phase: asString(raw.messagePhase),
		tool: asString(raw.tool),
		args: asString(raw.args),
		label: label ? asString(status === 'inProgress' ? label.active : status === 'completed' ? label.done : label.neutral) : undefined,
		output: asString(raw.visibleOutput),
		outputRef: asString((raw.outputRef as Params | undefined)?.id),
		reasoningSummary: Array.isArray(raw.summary) ? raw.summary.filter((part): part is string => typeof part === 'string') : undefined,
		background: raw.background === true,
		failureReason: asString(raw.failureReason),
		patch: patch ? { added: Number(patch.added) || 0, removed: Number(patch.removed) || 0, files: Number(patch.files) || 0 } : undefined,
		backgroundCompletion: completion ? {
			command: String(completion.command ?? ''),
			output: String(completion.output ?? ''),
			terminalStatus: String(completion.terminalStatus ?? ''),
			toolCallId: String(completion.toolCallId ?? ''),
		} : undefined,
		callId: asString(raw.callId),
		fallbackText: asString(raw.fallbackText),
		subagent: raw.kind === 'subagent' ? {
			subagentId: String(raw.subagentId ?? raw.itemId),
			childSessionId: asString(raw.childSessionId),
			objective: asString(raw.objective),
			role: asString(raw.role),
			agentPath: asString(raw.agentPath),
			controlStatus: asString(raw.controlStatus),
			resultSummary: asString((raw.result as Params | undefined)?.summary),
			failureReason: asString(raw.failureReason),
			depth: typeof raw.depth === 'number' ? raw.depth : undefined,
		} : undefined,
	};
}

/** Per-session tool servers, in `session/start` / `session/resume` form (only for sessions that may act). */
function sessionConfig(options: AgentSessionOptions): Params {
	if (options.readOnly || !options.mcpServers || !Object.keys(options.mcpServers).length) {
		return {};
	}
	const mcpServers: Params = {};
	for (const [name, server] of Object.entries(options.mcpServers)) {
		mcpServers[name] = { transport: 'streamableHttp', url: server.url, ...(server.headers ? { headers: { ...server.headers } } : {}), mode: 'optional' };
	}
	return { config: { mcpServers } };
}

function describeApproval(params: Params): { title: string; detail: string } {
	const subject = (params.subject ?? {}) as Params;
	const kind = asString(subject.kind) ?? 'tool';
	const toolName = asString(params.toolName) ?? 'tool';
	switch (kind) {
		case 'shell':
			return { title: 'Run a shell command', detail: asString(subject.command) ?? asString(params.rawArgs) ?? '' };
		case 'fileAccess':
			return { title: `${subject.access === 'write' ? 'Write' : 'Read'} a file`, detail: asString(subject.path) ?? '' };
		case 'network':
			return { title: 'Connect to the network', detail: [asString(subject.protocol), asString(subject.host), subject.port].filter(Boolean).join(' ') };
		default:
			return { title: `Use ${toolName}`, detail: asString(params.rawArgs)?.slice(0, 600) ?? '' };
	}
}

/**
 * One `muse serve` child speaking the Muse Session Protocol via the official
 * `@muse-code/sdk`. Each Active role (coding, explanation) owns its own host so
 * their workspaces and permissions stay isolated.
 */
export class MuseHost implements AgentHost {
	private readonly sessions = new Map<string, MuseSession>();
	private readonly seenApprovals = new Set<string>();
	readonly exited: Promise<string>;

	private constructor(private readonly msp: SpawnedMspConnection, readonly description: string, private readonly stderr: string[]) {
		this.exited = msp.exited.then(exit => {
			const tail = this.stderr.join('').split('\n').filter(Boolean).slice(-6).join('\n');
			return `muse serve exited (code ${exit.code ?? 'none'}${exit.signal ? `, signal ${exit.signal}` : ''})${tail ? `:\n${tail}` : ''}`;
		});
	}

	static async spawn(museBin: string, cwd: string, log: (line: string) => void, extraEnv: Readonly<Record<string, string>> = {}, extraArgs: readonly string[] = []): Promise<MuseHost> {
		const sdk = await import('@muse-code/sdk');
		const stderr: string[] = [];
		const handshake = sdk.spawnMspConnection({
			command: museBin,
			args: ['serve', ...extraArgs],
			cwd,
			env: { ...process.env, ...extraEnv },
			onStderr: chunk => {
				stderr.push(chunk);
				if (stderr.length > 200) {
					stderr.shift();
				}
				log(chunk.trimEnd());
			},
		});
		let host: MuseHost | undefined;
		const early: Array<{ method: string; params: Params }> = [];
		// Subscribe before the handshake completes: early pushes are otherwise dropped.
		handshake.onNotification(notification => {
			const frame = { method: notification.method, params: (notification.params ?? {}) as Params };
			if (host) {
				host.route(frame.method, frame.params);
			} else {
				early.push(frame);
			}
		});
		handshake.onServerRequest(async request => {
			if (request.method === 'approval/request') {
				host?.route('approval/requested', (request.params ?? {}) as Params);
				return {};
			}
			if (request.method === 'userInput/request') {
				// Active's auto mode never blocks on questions; cancel them so the turn continues.
				const params = (request.params ?? {}) as Params;
				host?.cancelUserInput(params);
				return {};
			}
			throw new sdk.MspError({ code: -32601, message: `method not found: ${request.method}`, data: { kind: 'methodNotFound', retryable: false } });
		});
		let msp: SpawnedMspConnection;
		try {
			// sessionMcp: each coding agent gets its own tools (its debugger, in its own folder) at session start.
			msp = await handshake.initialize({ clientInfo: CLIENT_INFO, capabilities: { requestedCapabilities: ['sessionMcp'] } });
		} catch (error) {
			const tail = stderr.join('').split('\n').filter(Boolean).slice(-6).join('\n');
			throw new MuseUnavailableError(`${error instanceof Error ? error.message : String(error)}${tail ? `\n${tail}` : ''}`);
		}
		if (msp.fingerprintWarning) {
			log(`Muse schema fingerprint warning: ${JSON.stringify(msp.fingerprintWarning)}`);
		}
		const info = msp.initializeResult;
		host = new MuseHost(msp, `${info.serverInfo.name} ${info.serverInfo.version}`, stderr);
		host.sessionTools = (info.grantedCapabilities ?? []).includes('sessionMcp');
		if (!host.sessionTools) {
			log('Muse didn\'t grant per-session tools (sessionMcp): agents won\'t get their debugger');
		}
		for (const frame of early) {
			host.route(frame.method, frame.params);
		}
		return host;
	}

	private route(method: string, params: Params): void {
		const sessionId = asString(params.sessionId);
		const session = sessionId ? this.sessions.get(sessionId) ?? this.watched.get(sessionId) : undefined;
		if (!session) {
			return;
		}
		if (method === 'approval/requested') {
			const approvalId = asString(params.approvalId);
			if (!approvalId || this.seenApprovals.has(approvalId)) {
				return;
			}
			this.seenApprovals.add(approvalId);
		}
		session.handle(method, params);
	}

	private cancelUserInput(params: Params): void {
		const sessionId = asString(params.sessionId);
		const userInputId = asString(params.userInputId);
		if (sessionId && userInputId) {
			void this.msp.connection.command('userInput/cancel', { sessionId, userInputId }).catch(() => undefined);
		}
	}

	async startSession(options: AgentSessionOptions): Promise<AgentSession> {
		const connection = this.msp.connection;
		let result: Params;
		if (options.readOnly) {
			// Muse enforces read-only in its sandbox, so the session can run in the real project.
			// Without the profile the session would be able to write, so refuse rather than fall back.
			try {
				result = await connection.command('session/start', { workspaceRoot: options.workspaceRoot, permissionProfile: READ_ONLY_PROFILE, approvalMode: 'denyUnmatched' });
			} catch (error) {
				throw new MuseUnavailableError(`Muse Code didn't accept its read-only permission profile (${READ_ONLY_PROFILE}), so Active won't start the explanation session: ${error instanceof Error ? error.message : String(error)}`);
			}
		} else {
			result = await connection.command('session/start', { workspaceRoot: options.workspaceRoot, ...(this.sessionTools ? sessionConfig(options) : {}) });
		}
		const sessionInfo = (result.session ?? {}) as Params;
		const sessionId = String(sessionInfo.sessionId);
		const session = new MuseSession(sessionId, this.msp, options.listener, options.readOnly);
		this.sessions.set(sessionId, session);
		return session;
	}

	async listModels(): Promise<AgentModelInfo[]> {
		const result = await this.msp.connection.request('model/list', {});
		const models = Array.isArray(result.models) ? result.models as Params[] : [];
		return models.map(model => {
			const cost = (model.cost ?? {}) as Params;
			return {
				id: String(model.modelId),
				label: asString(model.displayLabel) ?? String(model.modelId),
				description: asString(model.description),
				inputCost: asString(cost.input),
				outputCost: asString(cost.output),
				isDefault: model.isDefault === true,
				efforts: Array.isArray(model.variants) ? model.variants.filter((tier): tier is string => typeof tier === 'string') : [],
				defaultEffort: asString(model.defaultReasoningEffort),
			};
		});
	}

	async resumeSession(sessionId: string, options: AgentSessionOptions): Promise<AgentSession> {
		// Active keeps its own transcript, so only the live session is needed, not Muse's history.
		const result = await this.msp.connection.command('session/resume', { sessionId, excludeItems: true, ...(this.sessionTools ? sessionConfig(options) : {}) });
		const resumed = String(((result.session ?? {}) as Params).sessionId ?? sessionId);
		const session = new MuseSession(resumed, this.msp, options.listener, options.readOnly);
		this.sessions.set(resumed, session);
		return session;
	}

	/** Muse accepts tool servers per session (each agent's own debugger). */
	sessionTools = false;

	/** Sessions followed read-only (subagents'), by id. */
	private readonly watched = new Map<string, MuseSession>();

	async watchSession(sessionId: string, listener: AgentSessionListener): Promise<{ readonly worktreeRoot?: string; dispose(): void }> {
		const session = new MuseSession(sessionId, this.msp, listener, true, true);
		this.watched.set(sessionId, session);
		// Only new events: the parent's item already carries what the child set out to do.
		await this.msp.connection.request('view/subscribe', { sessionId }).catch(error => {
			this.watched.delete(sessionId);
			throw error;
		});
		const read = await this.msp.connection.request('session/read', { sessionId, excludeItems: true }).catch(() => undefined) as Params | undefined;
		const worktree = read?.worktree as Params | undefined;
		return {
			worktreeRoot: asString(worktree?.worktreeRoot),
			dispose: () => {
				if (this.watched.get(sessionId) === session) {
					this.watched.delete(sessionId);
					void this.msp.connection.request('view/unsubscribe', { sessionId }).catch(() => undefined);
				}
			},
		};
	}

	async dispose(): Promise<void> {
		await this.msp.close().catch(() => undefined);
	}
}

class MuseSession implements AgentSession {
	private readonly deltas = new Map<string, Map<string, string>>();

	/** `watchOnly`: a session Active follows but doesn't own (a subagent's): its approvals are left to its parent. */
	constructor(readonly sessionId: string, private readonly msp: SpawnedMspConnection, private readonly listener: AgentSessionListener, private readonly readOnly: boolean, private readonly watchOnly = false) { }

	handle(method: string, params: Params): void {
		switch (method) {
			case 'turn/started':
				this.listener.onTurnStarted?.(String(params.turnId));
				break;
			case 'item/started':
			case 'item/updated':
				this.listener.onItem?.(toItem(params.item as Params), false);
				break;
			case 'item/completed': {
				const item = toItem(params.item as Params);
				this.deltas.delete(item.id);
				this.listener.onItem?.(item, true);
				break;
			}
			case 'item/delta': {
				const itemId = String(params.itemId);
				const field = asString(params.field) ?? 'text';
				const delta = String(params.delta ?? '');
				const fields = this.deltas.get(itemId) ?? new Map<string, string>();
				fields.set(field, (fields.get(field) ?? '') + delta);
				this.deltas.set(itemId, fields);
				this.listener.onDelta?.(itemId, field, fields.get(field)!);
				break;
			}
			case 'turn/completed': {
				const error = params.error as Params | undefined;
				this.listener.onTurnCompleted?.(String(params.turnId), String(params.terminal ?? 'completed'), asString(error?.message) ?? asString(params.reason), asString(error?.kind));
				break;
			}
			case 'turn/unqueued':
				this.listener.onTurnCompleted?.(String(params.turnId), 'unqueued');
				break;
			case 'approval/requested':
				if (!this.watchOnly) {
					this.onApproval(params);
				}
				break;
			case 'session/todoListChanged': {
				const items = Array.isArray(params.items) ? params.items as Params[] : [];
				this.listener.onTodo?.(items.map(item => ({ text: String(item.activeForm && item.status === 'inProgress' ? item.activeForm : item.text ?? ''), status: String(item.status ?? 'pending') })));
				break;
			}
			case 'session/tokenUsage': {
				const cumulative = (params.cumulative ?? {}) as Params;
				const cost = cumulative.cost as Params | undefined;
				this.listener.onUsage?.({ totalTokens: Number(cumulative.totalTokens) || 0, costUsd: typeof cost?.usd === 'number' ? cost.usd : undefined });
				break;
			}
			case 'approval/resolved':
				this.listener.onApprovalResolved?.(String(params.approvalId), String(params.decision ?? ''));
				break;
		}
	}

	private onApproval(params: Params): void {
		const choices = (Array.isArray(params.availableChoices) ? params.availableChoices as Params[] : []).map(choice => {
			const decision = String(choice.decision ?? '');
			return { choiceId: String(choice.choiceId), label: String(choice.label ?? choice.choiceId), approves: /^approved|allow/i.test(decision) };
		});
		const approvalId = String(params.approvalId);
		if (this.readOnly) {
			// The explanation session never acts on the project: deny everything it asks for.
			const deny = choices.find(choice => !choice.approves);
			if (deny) {
				void this.decide(approvalId, deny.choiceId, params.currentRequirementId).catch(() => undefined);
			}
			return;
		}
		this.pendingRequirements.set(approvalId, params.currentRequirementId);
		const described = describeApproval(params);
		const approval: AgentApproval = {
			approvalId,
			turnId: String(params.turnId),
			itemId: String(params.itemId),
			toolName: String(params.toolName ?? ''),
			title: described.title,
			detail: described.detail,
			choices,
		};
		this.listener.onApproval?.(approval);
	}

	private readonly pendingRequirements = new Map<string, unknown>();

	private async decide(approvalId: string, choiceId: string, requirementId: unknown): Promise<void> {
		await this.msp.connection.command('approval/decide', { sessionId: this.sessionId, approvalId, choiceId, requirementId: requirementId as Params });
	}

	async decideApproval(approvalId: string, choiceId: string): Promise<void> {
		const requirementId = this.pendingRequirements.get(approvalId) ?? { approvalId, sourceIndex: 0 };
		await this.decide(approvalId, choiceId, requirementId);
	}

	async startTurn(text: string, displayText?: string, reasoningEffort?: string): Promise<string> {
		const ack = await this.msp.connection.command('turn/start', {
			sessionId: this.sessionId,
			input: [{ type: 'text', text }],
			...(displayText ? { displayText } : {}),
			...(reasoningEffort ? { reasoningEffort } : {}),
		});
		return String(ack.turnId);
	}

	async setModel(modelId: string): Promise<void> {
		await this.msp.connection.command('session/setModel', { sessionId: this.sessionId, model: { modelId } });
	}

	async messageSubagent(subagentId: string, body: string, followUp: boolean): Promise<void> {
		const params = { sessionId: this.sessionId, subagentId, body };
		if (!followUp) {
			await this.msp.connection.command('subagent/sendMessage', params);
			return;
		}
		try {
			await this.msp.connection.command('subagent/followupTask', params);
		} catch {
			// A closed child is reopened first, then given the task.
			await this.msp.connection.command('subagent/reopen', { sessionId: this.sessionId, subagentId });
			await this.msp.connection.command('subagent/followupTask', params);
		}
	}

	async stopSubagent(subagentId: string): Promise<void> {
		await this.msp.connection.command('subagent/interrupt', { sessionId: this.sessionId, subagentId, reason: 'Stopped by the developer in Active' });
	}

	async setApprovalMode(mode: string): Promise<void> {
		await this.msp.connection.command('session/setApprovalMode', { sessionId: this.sessionId, mode });
	}

	async steer(turnId: string, text: string): Promise<void> {
		await this.msp.connection.command('turn/steer', { sessionId: this.sessionId, expectedTurnId: turnId, input: [{ type: 'text', text }] });
	}

	async interruptTurn(turnId: string): Promise<void> {
		await this.msp.connection.command('turn/interrupt', { sessionId: this.sessionId, turnId });
	}

	async listTasks(): Promise<AgentTask[]> {
		const result = await this.msp.connection.request('task/list', { sessionId: this.sessionId });
		const tasks = Array.isArray(result.tasks) ? result.tasks as Params[] : [];
		return tasks.map(task => ({
			taskId: String(task.taskId),
			tool: asString(task.tool),
			command: asString(task.command),
			background: task.executionMode === undefined || task.executionMode === 'background',
		}));
	}

	async accountSummary(): Promise<string | undefined> {
		// `usage/read` reports the subscription tier once Muse has observed usage; absence is normal.
		const result = await this.msp.connection.request('usage/read', { sessionId: this.sessionId });
		const tier = asString((result.usage as Params | undefined)?.tier);
		return tier ? `${tier} plan` : undefined;
	}

	async readOutput(itemId: string, outputRef: string, maxBytes = 64 * 1024): Promise<string | undefined> {
		try {
			const result = await this.msp.connection.request('item/readOutput', { sessionId: this.sessionId, itemId, outputRef, lengthBytes: maxBytes });
			if (result.encoding === 'base64') {
				return Buffer.from(String(result.content), 'base64').toString('utf8');
			}
			return String(result.content ?? '');
		} catch {
			return undefined;
		}
	}
}
