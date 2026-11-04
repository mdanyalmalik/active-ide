/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { ActiveController, AgentActivity, SubagentEvent } from '../controller';
import { AGENT_COLORS, MAIN_AGENT_ID } from '../shared/activeProtocol';
import type { AgentApprovalMode } from '../shared/activeProtocol';
import type { ActiveEvent, AgentInfo, AgentInitialState, AgentOverlap, AgentState, ChatEntry, ExplainMode, MergeAgentsResult, NewAgentRequest, TaskRequest } from '../shared/activeProtocol';
import type { AgentItem, AgentSessionListener } from './agentTypes';
import { rangesOverlap, WorktreeManager } from './worktrees';

/** What's saved about each agent, so they come back after a reload. */
export interface AgentSpec {
	readonly id: string;
	name: string;
	readonly colorIndex: number;
	readonly root: string;
	readonly inMainFolder: boolean;
	readonly branch?: string;
	/** Its starting-point commit (worktree agents), what its changes are measured against. */
	readonly base?: string;
	readonly createdAt: number;
	mergedInto?: string;
	finished?: boolean;
	mode?: ExplainMode;
	approvalMode?: AgentApprovalMode;
	/** Its work was committed on its branch before merging, so the branch is kept (and never cleaned up). */
	keptBranch?: boolean;
}

/** One top-level agent's running parts (its controller, and whatever else the extension gives it). */
export interface AgentRuntime {
	readonly controller: ActiveController;
	dispose(): void;
}

/** What a runtime needs from the manager. */
export interface RuntimeHooks {
	/** Emits an event for this agent (tagged with its id). */
	readonly emit: (event: ActiveEvent) => void;
	readonly name: () => string;
	readonly multiAgent: () => boolean;
	readonly mode: () => ExplainMode | undefined;
	readonly approvalMode: () => AgentApprovalMode;
	readonly overlaps: () => ReadonlyArray<{ readonly agent: string; readonly path: string; readonly sameLines: boolean }>;
	readonly onActivity: (activity: AgentActivity) => void;
	readonly onSubagent: (event: SubagentEvent) => void;
}

export interface AgentManagerOptions {
	readonly mainRoot: string;
	readonly worktrees: WorktreeManager;
	readonly createRuntime: (spec: AgentSpec, hooks: RuntimeHooks, seedFrom?: AgentSpec) => AgentRuntime;
	readonly load: () => AgentSpec[];
	readonly save: (specs: readonly AgentSpec[]) => void;
	readonly emit: (event: ActiveEvent) => void;
	readonly log: (line: string) => void;
	/** The approval mode for agents that haven't chosen their own (the `active.agents.approvalMode` setting). */
	readonly defaultApprovalMode?: () => AgentApprovalMode;
	/** The most top-level agents that may exist at once (0: no limit). */
	readonly maxAgents: () => number;
	/** Subagents and their chats, kept across reloads (they're agents the developer can open and message). */
	readonly loadSubagents?: () => SavedSubagent[];
	readonly saveSubagents?: (subagents: SavedSubagent[]) => void;
}

export interface SavedSubagent {
	readonly id: string;
	readonly parentId: string;
	readonly subagentId: string;
	readonly childSessionId?: string;
	readonly name: string;
	readonly objective: string;
	readonly status: string;
	readonly root: string;
	readonly readOnly: boolean;
	readonly createdAt: number;
	readonly viaWorkflow?: boolean;
	readonly chat: readonly ChatEntry[];
}

interface SubagentState {
	readonly id: string;
	readonly parentId: string;
	readonly subagentId: string;
	name: string;
	objective: string;
	status: string;
	finished: boolean;
	root: string;
	readOnly: boolean;
	readonly createdAt: number;
	childSessionId?: string;
	lastResult?: string;
	finishedAt?: number;
	viaWorkflow?: boolean;
	activity?: string;
	reasoning?: string;
	readonly chat: ChatEntry[];
	readonly files: Set<string>;
	/** Files as they were when one of its edit tools started (by tool item and path). */
	readonly before: Map<string, Promise<string | null>>;
	watch?: { dispose(): void };
}

const OVERLAP_DEBOUNCE_MS = 4000;

/**
 * Runs every agent: the one in the developer's folder (`main`) and the ones started beside it, each in its own git
 * worktree with its own controller (turns, change tracking, explainer rooted in its folder). Requests without an agent
 * go to the focused one (the agent the developer highlighted). Merging drops one agent's work into another's folder
 * as if it had been that agent's subagent. Muse's own subagents are followed read-only and listed under their parent.
 */
export class AgentManager {
	private readonly specs: AgentSpec[];
	private readonly runtimes = new Map<string, AgentRuntime>();
	private readonly activities = new Map<string, AgentActivity>();
	private readonly subagents = new Map<string, SubagentState>();
	private overlaps: AgentOverlap[] = [];
	private focusedId = MAIN_AGENT_ID;
	private overlapTimer: NodeJS.Timeout | undefined;
	private blocker: string | undefined;

	constructor(private readonly options: AgentManagerOptions) {
		const saved = options.load().filter(spec => spec.id !== MAIN_AGENT_ID);
		const main: AgentSpec = options.load().find(spec => spec.id === MAIN_AGENT_ID) ?? { id: MAIN_AGENT_ID, name: 'Agent 1', colorIndex: 0, root: options.mainRoot, inMainFolder: true, createdAt: 0 };
		this.specs = [{ ...main, root: options.mainRoot, inMainFolder: true }, ...saved];
	}

	/** Starts every saved agent that isn't finished. */
	async start(): Promise<void> {
		this.blocker = await this.options.worktrees.blocker();
		// A worktree deleted outside Active (or by `git worktree prune`) takes its agent with it.
		for (const spec of [...this.specs]) {
			// (A merged agent's worktree is gone on purpose; its record stays, nested under the agent it went into.)
			if (!spec.inMainFolder && !spec.finished && !existsSync(spec.root)) {
				this.options.log(`${spec.name}'s worktree is gone (${spec.root}); dropping it`);
				this.specs.splice(this.specs.indexOf(spec), 1);
			}
		}
		this.save();
		// Worktree folders and agent branches no agent uses (left by a crash, or deleted agents) go too.
		const live = this.specs.filter(spec => !spec.inMainFolder && !spec.finished);
		const kept = this.specs.filter(spec => spec.keptBranch && spec.branch);
		await this.options.worktrees.cleanup({ roots: live.map(spec => spec.root), branches: [...live, ...kept].flatMap(spec => spec.branch ? [spec.branch] : []) }).catch(error => this.options.log(`worktree cleanup failed: ${error}`));
		for (const spec of this.specs) {
			if (!spec.finished || spec.id === MAIN_AGENT_ID) {
				this.ensureRuntime(spec);
			}
		}
		// Subagents from before the reload come back as finished (they can still be given follow-up tasks).
		for (const saved of this.options.loadSubagents?.() ?? []) {
			if (this.runtimes.has(saved.parentId) && !this.subagents.has(saved.id)) {
				this.subagents.set(saved.id, { ...saved, readOnly: saved.readOnly && saved.root !== this.spec(saved.parentId)?.root, finished: true, chat: [...saved.chat], files: new Set(), before: new Map() });
			}
		}
		this.publish();
		// Overlaps left from before a reload show straight away, not after the next change.
		this.scheduleOverlaps();
	}

	get focused(): string {
		return this.focusedId;
	}

	get multiAgentBlocker(): string | undefined {
		return this.blocker;
	}

	focus(agentId: string): void {
		if (this.runtimes.has(agentId) || this.subagents.has(agentId)) {
			this.focusedId = agentId;
		}
	}

	get main(): ActiveController {
		return this.ensureRuntime(this.spec(MAIN_AGENT_ID)!).controller;
	}

	/** The controller requests for `agentId` (default: the focused agent) go to; a subagent's go to its parent. */
	controllerFor(agentId?: string): ActiveController {
		const id = agentId ?? this.focusedId;
		const target = this.subagents.get(id)?.parentId ?? id;
		return this.runtimes.get(target)?.controller ?? this.main;
	}

	runtimeFor(agentId?: string): AgentRuntime | undefined {
		const id = agentId ?? this.focusedId;
		return this.runtimes.get(this.subagents.get(id)?.parentId ?? id);
	}

	get controllers(): ActiveController[] {
		return [...this.runtimes.values()].map(runtime => runtime.controller);
	}

	/** The top-level agent whose folder holds `absolutePath`, if any (longest root wins: worktrees are outside the main folder). */
	agentForPath(absolutePath: string): string | undefined {
		let best: AgentSpec | undefined;
		for (const spec of this.specs) {
			if (this.runtimes.has(spec.id) && (absolutePath === spec.root || absolutePath.startsWith(spec.root + path.sep)) && (!best || spec.root.length > best.root.length)) {
				best = spec;
			}
		}
		return best?.id;
	}

	spec(agentId: string): AgentSpec | undefined {
		return this.specs.find(spec => spec.id === agentId);
	}

	private topLevelLive(): AgentSpec[] {
		return this.specs.filter(spec => !spec.finished);
	}

	private ensureRuntime(spec: AgentSpec, seedFrom?: AgentSpec): AgentRuntime {
		let runtime = this.runtimes.get(spec.id);
		if (!runtime) {
			runtime = this.options.createRuntime(spec, {
				emit: event => this.onAgentEvent(spec.id, event),
				name: () => spec.name,
				multiAgent: () => this.topLevelLive().length > 1,
				mode: () => spec.mode,
				approvalMode: () => this.approvalModeOf(spec),
				overlaps: () => this.overlapsFor(spec.id),
				onActivity: activity => {
					this.activities.set(spec.id, { ...this.activities.get(spec.id), ...activity });
					this.publishSoon();
				},
				onSubagent: event => this.onSubagent(spec.id, event),
			}, seedFrom);
			this.runtimes.set(spec.id, runtime);
		}
		return runtime;
	}

	private onAgentEvent(agentId: string, event: ActiveEvent): void {
		this.options.emit({ ...event, agentId });
		if (event.type === 'agent') {
			this.publishSoon();
		}
		if (event.type === 'turnChanges' || event.type === 'history') {
			this.scheduleOverlaps();
		}
	}

	// ---------------------------------------------------------------- the list

	infos(): AgentInfo[] {
		const infos: AgentInfo[] = [];
		// One top-level agent: it and its subagents each get their own colour (they read as separate agents). Two or
		// more: subagents take their parent's colour, so the colours say which agent they belong to.
		const single = this.topLevelLive().length <= 1;
		const subColor = (sub: SubagentState, parentColor: number) => {
			if (!single) {
				return parentColor;
			}
			const order = [...this.subagents.values()].filter(other => other.parentId === sub.parentId).indexOf(sub);
			return (parentColor + 1 + order) % AGENT_COLORS;
		};
		for (const spec of this.specs) {
			const runtime = this.runtimes.get(spec.id);
			if (!runtime && spec.finished && !spec.mergedInto) {
				continue;
			}
			const state = runtime?.controller.currentState();
			const activity = this.activities.get(spec.id) ?? {};
			infos.push({
				id: spec.id,
				name: spec.name,
				colorIndex: spec.colorIndex,
				kind: 'agent',
				parentId: spec.mergedInto,
				root: spec.root,
				inMainFolder: spec.inMainFolder,
				branch: spec.branch,
				sessionId: state?.sessionId,
				status: spec.finished ? 'idle' : state?.status ?? 'starting',
				waitingForApproval: activity.waitingForApproval ?? false,
				activity: spec.mergedInto ? `Merged into ${this.spec(spec.mergedInto)?.name ?? 'another agent'}` : activity.activity,
				reasoning: activity.reasoning,
				todo: activity.todo,
				cost: activity.cost,
				costBreakdown: activity.costBreakdown,
				task: activity.task ?? runtime?.controller.lastTask,
				explainMode: spec.mode ?? 'auto',
				approvalMode: this.approvalModeOf(spec),
				createdAt: spec.createdAt,
				mergedInto: spec.mergedInto,
				finished: spec.finished,
			});
			for (const sub of this.subagents.values()) {
				if (sub.parentId === spec.id) {
					infos.push({
						id: sub.id,
						name: sub.name,
						colorIndex: subColor(sub, spec.colorIndex),
						kind: 'subagent',
						parentId: spec.id,
						root: sub.root,
						inMainFolder: false,
						readOnly: sub.readOnly,
						status: sub.finished ? 'idle' : 'running',
						waitingForApproval: false,
						activity: sub.finished ? (/fail/i.test(sub.status) ? `Failed: ${sub.status.replace(/^failed:\s*/i, '')}` : sub.lastResult ? `Finished: ${sub.lastResult.split('\n')[0].slice(0, 100)}` : 'Finished') : sub.activity,
						reasoning: sub.reasoning,
						task: sub.objective,
						explainMode: 'off',
						approvalMode: this.approvalModeOf(spec),
						createdAt: sub.createdAt,
						finished: sub.finished,
						finishedAt: sub.finished ? sub.finishedAt ?? 0 : undefined,
					});
				}
			}
		}
		return infos;
	}

	private publishTimer: NodeJS.Timeout | undefined;

	/** Activity changes come in bursts (streaming tools, reasoning): publish at most a few times a second. */
	private publishSoon(): void {
		this.publishTimer ??= setTimeout(() => {
			this.publishTimer = undefined;
			this.publish();
		}, 250);
	}

	publish(): void {
		this.options.emit({ type: 'agents', agents: this.infos(), overlaps: this.overlaps });
		this.options.saveSubagents?.([...this.subagents.values()].map(sub => ({
			id: sub.id, parentId: sub.parentId, subagentId: sub.subagentId, childSessionId: sub.childSessionId, name: sub.name, objective: sub.objective,
			status: sub.status, root: sub.root, readOnly: sub.readOnly, createdAt: sub.createdAt, viaWorkflow: sub.viaWorkflow, chat: sub.chat.slice(-60),
		})));
	}

	async agentStates(): Promise<AgentInitialState[]> {
		const states: AgentInitialState[] = [];
		for (const [id, runtime] of this.runtimes) {
			if (id === MAIN_AGENT_ID) {
				continue;
			}
			const initial = await runtime.controller.initialState();
			states.push({ agentId: id, agent: initial.agent, chat: initial.chat, turnChanges: initial.turnChanges, pendingWalkthrough: initial.pendingWalkthrough, diagram: await (runtime as AgentRuntime & { diagramState?: () => Promise<AgentInitialState['diagram']> }).diagramState?.() });
		}
		for (const sub of this.subagents.values()) {
			states.push({ agentId: sub.id, agent: this.subagentState(sub), chat: sub.chat, turnChanges: [] });
		}
		return states;
	}

	// ---------------------------------------------------------------- new, close, rename, modes

	async create(request: NewAgentRequest): Promise<{ id?: string; error?: string }> {
		if (this.blocker) {
			return { error: this.blocker };
		}
		const live = this.topLevelLive();
		const max = this.options.maxAgents();
		if (max > 0 && live.length >= max) {
			return { error: `At most ${max} agents (active.agents.max). Merge or close one first.` };
		}
		const numbers = this.specs.map(spec => /^Agent (\d+)$/.exec(spec.name)?.[1]).filter(Boolean).map(Number);
		const name = request.name?.trim() || `Agent ${Math.max(1, ...numbers) + 1}`;
		const id = `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
		const used = new Set(live.map(spec => spec.colorIndex));
		const colorIndex = Array.from({ length: AGENT_COLORS }, (_, index) => index).find(index => !used.has(index)) ?? this.specs.length % AGENT_COLORS;
		let worktree;
		try {
			worktree = await this.options.worktrees.create(id, name);
		} catch (error) {
			return { error: `Couldn't make a worktree for ${name}: ${error instanceof Error ? error.message : String(error)}` };
		}
		const spec: AgentSpec = { id, name, colorIndex, root: worktree.root, inMainFolder: false, branch: worktree.branch, base: worktree.base, createdAt: Date.now() };
		this.specs.push(spec);
		this.save();
		const runtime = this.ensureRuntime(spec, this.spec(this.focusedId) ?? this.spec(MAIN_AGENT_ID));
		this.publish();
		void runtime.controller.connect().then(() => {
			this.publish();
			if (request.task) {
				return runtime.controller.submitTask(request.task);
			}
			return undefined;
		}).catch(error => this.options.log(`${name} didn't start: ${error}`));
		return { id };
	}

	/** `keep`: commit its work on its branch and keep the branch (the worktree folder goes either way). */
	async close(agentId: string, options: { keep?: boolean } = {}): Promise<{ ok: boolean; message: string }> {
		const spec = this.spec(agentId);
		if (!spec || spec.id === MAIN_AGENT_ID) {
			return { ok: false, message: 'The agent in your folder can\'t be closed.' };
		}
		const task = this.runtimes.get(spec.id)?.controller.lastTask;
		await this.stopRuntime(spec);
		let committed: string | undefined;
		if (spec.branch && !spec.inMainFolder) {
			if (options.keep) {
				committed = await this.options.worktrees.commitAll(spec.root, `${task ? `${spec.name}: ${task.split('\n')[0].slice(0, 72)}` : `${spec.name}'s work`} (on close)`).catch(error => {
					this.options.log(`couldn't commit ${spec.name}'s work: ${error}`);
					return undefined;
				});
			}
			await this.options.worktrees.remove({ root: spec.root, branch: spec.branch, base: spec.base ?? '' }, !!options.keep);
		}
		// A kept branch stays recorded (hidden from the list) so startup cleanup never deletes it.
		const retire = (candidate: AgentSpec) => {
			if (candidate.keptBranch || (candidate === spec && options.keep)) {
				candidate.keptBranch = true;
				candidate.finished = true;
				candidate.mergedInto = undefined;
			} else {
				this.specs.splice(this.specs.indexOf(candidate), 1);
			}
		};
		retire(spec);
		// Agents merged into it go too (their work is in its worktree, now gone), unless their branch was kept.
		for (const merged of this.specs.filter(candidate => candidate.mergedInto === agentId)) {
			retire(merged);
		}
		if (this.focusedId === agentId) {
			this.focusedId = MAIN_AGENT_ID;
		}
		this.save();
		this.publish();
		return { ok: true, message: options.keep ? `Closed ${spec.name}; ${committed ? 'its work is committed on' : 'nothing to commit, kept'} ${spec.branch}.` : `Closed ${spec.name}.` };
	}

	private async stopRuntime(spec: AgentSpec): Promise<void> {
		const runtime = this.runtimes.get(spec.id);
		if (!runtime) {
			return;
		}
		await runtime.controller.interrupt().catch(() => undefined);
		for (const sub of [...this.subagents.values()].filter(candidate => candidate.parentId === spec.id)) {
			sub.watch?.dispose();
			this.subagents.delete(sub.id);
		}
		runtime.dispose();
		this.runtimes.delete(spec.id);
	}

	rename(agentId: string, name: string): void {
		const spec = this.spec(agentId);
		if (spec && name.trim()) {
			spec.name = name.trim().slice(0, 40);
			this.save();
			this.publish();
		}
	}

	setMode(agentId: string, mode: ExplainMode): void {
		const spec = this.spec(agentId);
		if (spec && spec.id !== MAIN_AGENT_ID) {
			spec.mode = mode;
			this.save();
			this.publish();
		}
	}

	private approvalModeOf(spec: AgentSpec): AgentApprovalMode {
		return spec.approvalMode ?? this.options.defaultApprovalMode?.() ?? 'auto';
	}

	/** The default changed: agents that haven't chosen their own mode follow it (from their next action). */
	async defaultApprovalModeChanged(): Promise<void> {
		this.publish();
		await Promise.all(this.specs.filter(spec => !spec.approvalMode).map(spec => this.runtimes.get(spec.id)?.controller.applyApprovalMode()));
	}

	/** How this agent's actions get approved; applied to its live session straight away (from its next action). */
	async setApprovalMode(agentId: string, mode: AgentApprovalMode): Promise<void> {
		const spec = this.spec(this.subagents.get(agentId)?.parentId ?? agentId);
		if (!spec) {
			return;
		}
		spec.approvalMode = mode;
		this.save();
		this.publish();
		await this.runtimes.get(spec.id)?.controller.applyApprovalMode();
	}

	/** A task for an agent that was merged away revives it (only the main agent keeps its folder after merging). */
	async submitTask(agentId: string | undefined, request: string | TaskRequest): Promise<void> {
		const id = agentId ?? this.focusedId;
		const sub = this.subagents.get(id);
		if (sub) {
			await this.messageSubagent(sub, typeof request === 'string' ? request : request.text);
			return;
		}
		const spec = this.spec(this.subagents.get(id)?.parentId ?? id);
		if (spec?.finished && spec.id === MAIN_AGENT_ID) {
			spec.finished = undefined;
			spec.mergedInto = undefined;
			this.save();
			this.publish();
		}
		await this.controllerFor(id).submitTask(request);
	}

	/**
	 * The developer writes to a subagent from its own chat: a message while it works, or a follow-up task once it's
	 * finished (which wakes it up again).
	 */
	private async messageSubagent(sub: SubagentState, text: string): Promise<void> {
		const body = text.trim();
		const controller = this.runtimes.get(sub.parentId)?.controller;
		if (!body || !controller) {
			return;
		}
		const followUp = sub.finished;
		this.subChat(sub, { id: `${sub.id}-you-${Date.now().toString(36)}`, role: 'user', text: body, at: Date.now() });
		// Muse's workflow helpers break on direct messages (seen live): their parent passes the message on.
		if (sub.viaWorkflow) {
			const parent = this.spec(sub.parentId);
			this.subChat(sub, { id: `${sub.id}-relay-${Date.now().toString(36)}`, role: 'system', text: `Passed to ${parent?.name ?? 'its agent'}, which runs ${sub.name} (Muse's workflow helpers don't take direct messages).`, at: Date.now() });
			await controller.relayToAgent(`About ${sub.name}'s task${sub.objective ? ` ("${sub.objective.split('\n')[0].slice(0, 200)}")` : ''}, the developer says: ${body}${followUp ? '' : '\n(If that helper is still working, pass this on to it or account for it when its result comes back.)'}`).catch(error => this.options.log(`couldn't relay to ${parent?.name}: ${error}`));
			return;
		}
		try {
			await controller.messageSubagent(sub.subagentId, body, followUp);
			if (followUp) {
				sub.finished = false;
				sub.status = 'running';
				sub.activity = 'Thinking…';
				if (sub.childSessionId && !sub.watch) {
					void this.watchSubagent(sub, sub.childSessionId);
				}
				this.options.emit({ type: 'agent', agent: this.subagentState(sub), agentId: sub.id });
				this.publishSoon();
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			// Muse doesn't let some finished helpers (those its workflows start) take new work: their parent takes it.
			if (followUp && /ineligible|closed|not.*(running|open)/i.test(message)) {
				const parent = this.spec(sub.parentId);
				this.subChat(sub, { id: `${sub.id}-handoff-${Date.now().toString(36)}`, role: 'system', text: `${sub.name} has finished and can't take new work, so this went to ${parent?.name ?? 'its agent'}.`, at: Date.now() });
				await controller.submitTask(`Follow-up to ${sub.name}'s task${sub.objective ? ` ("${sub.objective.split('\n')[0].slice(0, 200)}")` : ''}: ${body}`).catch(() => undefined);
				return;
			}
			this.subChat(sub, { id: `${sub.id}-error-${Date.now().toString(36)}`, role: 'system', text: `Couldn't reach ${sub.name}: ${message}`, at: Date.now() });
		}
	}

	/** Stops an agent's running turn, or a subagent. */
	async interrupt(agentId: string): Promise<void> {
		const sub = this.subagents.get(agentId);
		if (sub) {
			await this.runtimes.get(sub.parentId)?.controller.stopSubagent(sub.subagentId).catch(error => this.options.log(`couldn't stop ${sub.name}: ${error}`));
			return;
		}
		await this.controllerFor(agentId).interrupt();
	}

	// ---------------------------------------------------------------- merging

	async merge(sourceId: string, targetId: string, options: { commit?: boolean } = {}): Promise<MergeAgentsResult> {
		const source = this.spec(sourceId);
		const target = this.spec(targetId);
		if (!source || !target || source === target) {
			return { ok: false, message: 'Drag one agent onto a different agent to merge them.' };
		}
		if (source.finished || target.finished) {
			return { ok: false, message: `${source.finished ? source.name : target.name} has already been merged into another agent.` };
		}
		const sourceRuntime = this.runtimes.get(source.id);
		const targetRuntime = this.runtimes.get(target.id);
		if (!sourceRuntime || !targetRuntime) {
			return { ok: false, message: 'That agent isn\'t running.' };
		}
		if (sourceRuntime.controller.busy) {
			return { ok: false, message: `${source.name} is still working. Merge it once it's finished.` };
		}
		if (targetRuntime.controller.busy) {
			return { ok: false, message: `${target.name} is still working. Merge once it's finished.` };
		}
		let outcome;
		let committed: string | undefined;
		let targetCommitted: string | undefined;
		try {
			// The changes to merge are measured from where the source started (resolved now: committing moves HEAD).
			const base = source.base ?? await this.options.worktrees.head(source.root);
			if (options.commit) {
				// Each agent's work is committed on its own branch first, so both are in history before they're combined.
				const message = (spec: AgentSpec, task: string | undefined) => task ? `${spec.name}: ${task.split('\n')[0].slice(0, 72)}` : `${spec.name}'s work`;
				committed = await this.options.worktrees.commitAll(source.root, message(source, sourceRuntime.controller.lastTask));
				targetCommitted = await this.options.worktrees.commitAll(target.root, message(target, targetRuntime.controller.lastTask));
			}
			outcome = await targetRuntime.controller.receiveMerge({ name: source.name, task: sourceRuntime.controller.lastTask }, () => this.options.worktrees.merge(
				{ root: source.root, base, name: source.name },
				{ root: target.root, name: target.name },
			));
		} catch (error) {
			return { ok: false, message: error instanceof Error ? error.message : String(error) };
		}
		source.mergedInto = target.id;
		source.finished = true;
		if (!source.inMainFolder) {
			await this.stopRuntime(source);
			if (source.branch) {
				// Committed work stays on its branch; otherwise the branch goes with the worktree.
				await this.options.worktrees.remove({ root: source.root, branch: source.branch, base: source.base ?? '' }, !!committed);
				if (committed) {
					source.keptBranch = true;
				}
			}
		}
		if (this.focusedId === source.id) {
			this.focusedId = target.id;
		}
		this.save();
		this.publish();
		this.scheduleOverlaps();
		const conflicts = outcome.conflicts.length ? ` ${target.name} is resolving conflicts in ${outcome.conflicts.join(', ')}.` : '';
		const where = (spec: AgentSpec) => spec.inMainFolder ? 'your branch' : spec.branch ?? 'its branch';
		const kept = [committed && `${source.name}'s work committed on ${where(source)}`, targetCommitted && `${target.name}'s on ${where(target)}`].filter(Boolean).join(', ');
		const commits = kept ? ` ${kept}.` : '';
		return { ok: true, message: `Merged ${source.name} into ${target.name}: ${outcome.files.length} file${outcome.files.length === 1 ? '' : 's'}.${conflicts}${commits}`, files: outcome.files.length, conflicts: outcome.conflicts };
	}

	// ---------------------------------------------------------------- overlaps

	private scheduleOverlaps(): void {
		clearTimeout(this.overlapTimer);
		this.overlapTimer = setTimeout(() => void this.computeOverlaps().catch(error => this.options.log(`overlap check failed: ${error}`)), OVERLAP_DEBOUNCE_MS);
	}

	/** Which top-level agents are changing the same files (and lines), from each one's changes since its starting point. */
	async computeOverlaps(): Promise<void> {
		const live = this.topLevelLive().filter(spec => this.runtimes.has(spec.id));
		if (live.length < 2) {
			if (this.overlaps.length) {
				this.overlaps = [];
				this.publish();
			}
			return;
		}
		// Each agent's own changes: a worktree agent's since its starting point. The agent in the developer's folder has
		// no starting point of its own, so it's measured from the other agent's (a snapshot of that folder when it began):
		// work that was already there then isn't counted as either agent's change.
		const cache = new Map<string, Map<string, Array<[number, number]>>>();
		const rangesOf = async (spec: AgentSpec, base: string) => {
			const key = `${spec.id}@${base}`;
			if (!cache.has(key)) {
				cache.set(key, await this.options.worktrees.changedRanges(spec.root, base).catch(() => new Map()));
			}
			return cache.get(key)!;
		};
		const overlaps: AgentOverlap[] = [];
		for (let a = 0; a < live.length; a++) {
			for (let b = a + 1; b < live.length; b++) {
				const baseOf = (spec: AgentSpec, other: AgentSpec) => spec.base ?? other.base ?? 'HEAD';
				const left = await rangesOf(live[a], baseOf(live[a], live[b]));
				const right = await rangesOf(live[b], baseOf(live[b], live[a]));
				const files = [...left.keys()].filter(file => right.has(file)).map(file => ({ path: file, sameLines: rangesOverlap(left.get(file)!, right.get(file)!) }));
				if (files.length) {
					overlaps.push({ agents: [live[a].id, live[b].id], files });
				}
			}
		}
		if (JSON.stringify(overlaps) !== JSON.stringify(this.overlaps)) {
			this.overlaps = overlaps;
			this.publish();
		}
	}

	/** Overlaps in words, for briefings. */
	overlapLines(): string[] {
		return this.overlaps.flatMap(overlap => {
			const [a, b] = overlap.agents.map(id => this.spec(id)?.name ?? id);
			return overlap.files.map(file => `${a} and ${b} both changed ${file.path}${file.sameLines ? ' (the same lines: likely to conflict when merged)' : ''}`);
		});
	}

	private overlapsFor(agentId: string): Array<{ agent: string; path: string; sameLines: boolean }> {
		return this.overlaps.filter(overlap => overlap.agents.includes(agentId)).flatMap(overlap => {
			const other = this.spec(overlap.agents[0] === agentId ? overlap.agents[1] : overlap.agents[0]);
			return overlap.files.map(file => ({ agent: other?.name ?? 'another agent', path: file.path, sameLines: file.sameLines }));
		});
	}

	// ---------------------------------------------------------------- Muse's subagents

	private onSubagent(parentId: string, event: SubagentEvent): void {
		const id = `sub-${event.subagentId}`;
		let sub = this.subagents.get(id);
		const parent = this.spec(parentId);
		if (!sub) {
			// Muse's generic helpers are numbered per agent, so they can be told apart.
			const name = event.name === 'Helper' ? `Helper ${[...this.subagents.values()].filter(other => other.parentId === parentId).length + 1}` : event.name;
			event = { ...event, name };
			sub = { id, parentId, subagentId: event.subagentId, childSessionId: event.childSessionId, name: event.name, objective: event.objective, status: event.status, finished: event.finished, root: parent?.root ?? this.options.mainRoot, readOnly: false, createdAt: Date.now(), chat: [], files: new Set(), before: new Map() };
			this.subagents.set(id, sub);
			this.options.emit({ type: 'agent', agent: this.subagentState(sub), agentId: id });
			if (event.objective) {
				this.subChat(sub, { id: `${id}-objective`, role: 'user', text: event.objective, at: Date.now() });
			}
			if (event.childSessionId) {
				void this.watchSubagent(sub, event.childSessionId);
			}
		}
		sub.name = event.name === 'Helper' ? sub.name : event.name || sub.name;
		sub.viaWorkflow = sub.viaWorkflow || event.viaWorkflow;
		if (event.objective && event.objective !== sub.objective && !sub.chat.some(entry => entry.id === `${id}-objective`)) {
			this.subChat(sub, { id: `${id}-objective`, role: 'user', text: event.objective, at: sub.createdAt });
		}
		if (event.childSessionId && !sub.childSessionId) {
			sub.childSessionId = event.childSessionId;
			void this.watchSubagent(sub, event.childSessionId);
		}
		sub.objective = event.objective || sub.objective;
		sub.status = event.status;
		if (event.finished && !sub.finished) {
			sub.finished = true;
			sub.finishedAt = Date.now();
			// Each result is its own entry (a follow-up task reports again), in order after whatever led to it.
			if (event.result && event.result !== sub.lastResult) {
				sub.lastResult = event.result;
				this.subChat(sub, { id: `${id}-result-${Date.now().toString(36)}`, role: 'agent', text: event.result, at: Date.now(), status: 'done' });
			}
			this.options.emit({ type: 'agent', agent: this.subagentState(sub), agentId: id });
			// Its session is done; keep the box (and transcript) but stop following it.
			setTimeout(() => {
				sub?.watch?.dispose();
				if (sub) {
					sub.watch = undefined;
				}
			}, 5000);
		}
		this.publishSoon();
	}

	private subagentState(sub: SubagentState): AgentState {
		const parent = this.runtimes.get(sub.parentId)?.controller.currentState();
		return {
			status: sub.finished ? 'idle' : 'running',
			provider: parent?.provider ?? { id: 'muse', name: 'Muse Code', shortName: 'Muse', devOnly: false },
			workspaceName: path.basename(sub.root),
			backgroundTasks: 0,
		};
	}

	private subChat(sub: SubagentState, entry: ChatEntry): void {
		const index = sub.chat.findIndex(candidate => candidate.id === entry.id);
		if (index >= 0) {
			sub.chat[index] = entry;
		} else {
			sub.chat.push(entry);
			if (sub.chat.length > 200) {
				sub.chat.splice(0, sub.chat.length - 200);
			}
		}
		this.options.emit({ type: 'chat', entry, agentId: sub.id });
	}

	private async watchSubagent(sub: SubagentState, childSessionId: string): Promise<void> {
		const host = this.runtimes.get(sub.parentId)?.controller.codingHostForWatching;
		if (!host?.watchSession) {
			return;
		}
		const listener: AgentSessionListener = {
			onItem: (item: AgentItem, completed: boolean) => this.onSubagentItem(sub, item, completed),
			onDelta: (itemId, field, text) => {
				if (field === 'text') {
					this.subChat(sub, { id: `${sub.id}-${itemId}`, role: 'agent', text, status: 'streaming', at: Date.now() });
				}
			},
		};
		try {
			const watch = await host.watchSession(childSessionId, listener);
			sub.watch = watch;
			// Only a worktree of its own (Muse's) is read-only; otherwise it works in its parent's folder.
			if (watch.worktreeRoot) {
				sub.root = watch.worktreeRoot;
				sub.readOnly = true;
				this.publishSoon();
			}
		} catch (error) {
			this.options.log(`couldn't follow subagent ${sub.name}: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	private onSubagentItem(sub: SubagentState, item: AgentItem, completed: boolean): void {
		const entryId = `${sub.id}-${item.id}`;
		if (item.kind === 'agentMessage') {
			this.subChat(sub, { id: entryId, role: 'agent', text: item.text ?? '', phase: item.phase, status: completed ? 'done' : 'streaming', at: Date.now() });
			if (completed && item.text) {
				sub.activity = item.text.trim().split('\n')[0].slice(0, 140);
				this.publishSoon();
			}
		} else if (item.kind === 'reasoning' && item.reasoningSummary?.length) {
			sub.reasoning = item.reasoningSummary[item.reasoningSummary.length - 1];
			this.publishSoon();
		} else if (item.kind === 'toolCall') {
			const label = item.label ?? item.tool ?? 'Tool';
			this.subChat(sub, { id: entryId, role: 'tool', text: label, status: item.status, at: Date.now() });
			if (item.status === 'inProgress') {
				sub.activity = label.slice(0, 140);
				this.publishSoon();
			}
			// What it touched, so its parent's explanation can say which parts it did: each file just before and just after
			// its edit (the lines it wrote are found in the final version later, even if the parent changed some since).
			const touched = toolFiles(item.args).map(file => path.isAbsolute(file) ? path.relative(sub.root, file) : file).filter(file => file && !file.startsWith('..'));
			if (touched.length && !completed) {
				for (const file of touched) {
					if (!sub.before.has(`${item.id}:${file}`)) {
						sub.before.set(`${item.id}:${file}`, readText(path.join(sub.root, file)));
					}
				}
			}
			if (touched.length && completed && item.patch) {
				const controller = this.runtimes.get(sub.parentId)?.controller;
				for (const file of touched) {
					sub.files.add(file);
					const before = sub.before.get(`${item.id}:${file}`);
					sub.before.delete(`${item.id}:${file}`);
					void Promise.all([before ?? Promise.resolve(undefined), readText(path.join(sub.root, file))]).then(([was, now]) => {
						controller?.noteSubagentEdit(sub.subagentId, file, was === undefined ? undefined : was, now);
					});
				}
				controller?.noteSubagentFiles(sub.subagentId, touched);
			}
		}
	}

	// ---------------------------------------------------------------- persistence

	private save(): void {
		this.options.save(this.specs.map(spec => ({ ...spec })));
	}

	dispose(): void {
		clearTimeout(this.overlapTimer);
		clearTimeout(this.publishTimer);
		for (const sub of this.subagents.values()) {
			sub.watch?.dispose();
		}
		for (const runtime of this.runtimes.values()) {
			runtime.dispose();
		}
		this.runtimes.clear();
	}
}

function readText(file: string): Promise<string | null> {
	return fs.readFile(file, 'utf8').catch(() => null);
}

/** File paths a tool call's arguments name (edit tools: `path`, `file_path`, `files`…). */
export function toolFiles(args: string | undefined): string[] {
	if (!args) {
		return [];
	}
	try {
		const parsed = JSON.parse(args) as Record<string, unknown>;
		const found: string[] = [];
		for (const key of ['path', 'file_path', 'filePath', 'file', 'target_file']) {
			if (typeof parsed[key] === 'string') {
				found.push(parsed[key] as string);
			}
		}
		for (const key of ['files', 'paths']) {
			const value = parsed[key];
			if (Array.isArray(value)) {
				found.push(...value.filter((item): item is string => typeof item === 'string'));
			}
		}
		return found;
	} catch {
		return [];
	}
}
