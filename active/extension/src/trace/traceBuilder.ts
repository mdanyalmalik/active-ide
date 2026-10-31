/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { BreakpointSpec } from '../debug/debugRunner';
import { CodeTrace, extractJsonObject, KnowledgeProfile, parseCodeTrace, summarizeTrace, TraceObservation, TraceRequest, TraceRunPlan, TraceSnippet, TraceStep, TraceStepObservation, TraceSummary } from '../shared/activeProtocol';
import { DEBUG_LANGUAGE_NAMES, DebugLanguage, languageOfCommand, languageOfFile } from '../debug/languages';
import { buildTracePrompt, buildTraceRepairPrompt } from './tracePrompts';

/** What the trace builder needs from the debug runner. */
export interface TraceRunner {
	checkPoint(file: unknown, line: unknown): Promise<{ file: string; line: number } | string>;
	observe(command: string, cwd: unknown, logpoints: readonly BreakpointSpec[], timeoutMs: number): Promise<{ hits: Array<{ index: number; text: string }>; output: string[]; exitCode?: number; timedOut: boolean } | { error: { text: string } }>;
}

export interface TraceBuilderOptions {
	/** The read-only explanation session that reads the code. */
	readonly ask: (prompt: string) => Promise<string>;
	readonly root: string;
	readonly listFiles: () => Promise<string[]>;
	readonly readFile: (relative: string) => Promise<string | undefined>;
	readonly runner: TraceRunner;
	/** Where traces are saved, one JSON file each. */
	readonly storeDir: string;
	readonly emit: (trace: CodeTrace) => void;
	readonly profile: () => KnowledgeProfile;
	readonly log: (line: string) => void;
	readonly now?: () => number;
	readonly newId?: () => string;
}

const RUN_TIMEOUT_MS = 60_000;
const PROBE_MAX_HITS = 10;
const MAX_HISTORY = 100;
const LANGUAGES: Record<string, string> = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascriptreact', ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'typescriptreact', py: 'python', go: 'go', rs: 'rust', java: 'java', rb: 'ruby', cs: 'csharp', cpp: 'cpp', c: 'c', php: 'php', swift: 'swift', kt: 'kotlin' };

/**
 * Builds code traces: the explainer follows a behavior through the code (inferred from source, checked against
 * the real files), the steps' code is captured, and then, when there's a way to run the path, Active runs it under
 * the debugger with a logpoint on each step and marks which steps ran, in what order, with what values.
 */
export class TraceBuilder {
	private readonly traces = new Map<string, CodeTrace>();

	constructor(private readonly options: TraceBuilderOptions) { }

	/** Starts a trace and resolves with its id at once; progress and the result arrive through `emit`. */
	async build(request: TraceRequest): Promise<string> {
		const id = (this.options.newId ?? (() => `trace-${this.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`))();
		const trace: CodeTrace = { id, question: request.question, createdAt: this.now(), status: 'tracing', detail: 'Reading the code…', title: request.question, overview: '', steps: [], snippets: {} };
		this.update(trace);
		void this.run(trace, request).catch(error => this.update({ ...this.traces.get(id)!, status: 'failed', detail: `The trace failed: ${message(error)}` }));
		return id;
	}

	async get(id: string): Promise<CodeTrace | undefined> {
		const known = this.traces.get(id);
		if (known) {
			return known;
		}
		try {
			const saved = JSON.parse(await fs.readFile(path.join(this.options.storeDir, `${safe(id)}.json`), 'utf8')) as CodeTrace;
			this.traces.set(id, saved);
			return saved;
		} catch {
			return undefined;
		}
	}

	/** Past traces, newest first: the ones made this session (also unfinished or failed ones) and the saved ones. */
	async list(): Promise<TraceSummary[]> {
		const byId = new Map<string, TraceSummary>();
		const names = await fs.readdir(this.options.storeDir).catch(() => [] as string[]);
		await Promise.all(names.filter(name => name.endsWith('.json')).map(async name => {
			try {
				const saved = JSON.parse(await fs.readFile(path.join(this.options.storeDir, name), 'utf8')) as CodeTrace;
				if (saved?.id) {
					byId.set(saved.id, summarizeTrace(saved));
				}
			} catch {
				// A damaged file is left out.
			}
		}));
		for (const trace of this.traces.values()) {
			byId.set(trace.id, summarizeTrace(trace));
		}
		return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt).slice(0, MAX_HISTORY);
	}

	async delete(id: string): Promise<void> {
		this.traces.delete(id);
		await fs.rm(path.join(this.options.storeDir, `${safe(id)}.json`), { force: true });
	}

	private async run(start: CodeTrace, request: TraceRequest): Promise<void> {
		const lines = new Map<string, string[] | undefined>();
		const read = async (file: string) => {
			if (!lines.has(file)) {
				const text = await this.options.readFile(file);
				lines.set(file, text === undefined ? undefined : text.split(/\r?\n/));
			}
			return lines.get(file);
		};
		const files = await this.options.listFiles();
		let reply = await this.options.ask(buildTracePrompt(request.question, files, this.options.root, this.options.profile(), request.command));
		let parsed: ReturnType<typeof parseCodeTrace>;
		for (let attempt = 0; ; attempt++) {
			const value = extractJsonObject(reply);
			// Line counts for every cited file (fork paths' too), read first so the parser can check ranges synchronously.
			for (const file of citedFiles(value)) {
				await read(file);
			}
			const errors: string[] = [];
			parsed = parseCodeTrace(value, file => lines.get(file)?.length, errors);
			if (parsed && !errors.length || attempt === 1) {
				break;
			}
			this.options.log(`trace: ${errors.length} problem(s), asking for a repair: ${errors.slice(0, 3).join('; ')}`);
			reply = await this.options.ask(buildTraceRepairPrompt(errors));
		}
		if (!parsed) {
			this.update({ ...start, status: 'failed', detail: 'The explainer didn\'t come back with a usable trace.' });
			return;
		}
		const snippets: Record<string, TraceSnippet> = {};
		for (const step of parsed.steps) {
			const fileLines = (await read(step.file)) ?? [];
			const extension = path.extname(step.file).slice(1).toLowerCase();
			snippets[step.id] = { firstLine: step.startLine, lines: fileLines.slice(step.startLine - 1, step.endLine), ...(LANGUAGES[extension] ? { languageId: LANGUAGES[extension] } : {}) };
		}
		const plan: TraceRunPlan | undefined = request.noRun ? undefined : request.command ? { command: request.command } : parsed.run;
		const traced: CodeTrace = { ...start, title: parsed.title, overview: parsed.overview, steps: parsed.steps, ...(parsed.forks.length ? { forks: parsed.forks } : {}), snippets, status: plan ? 'observing' : 'ready', detail: plan ? 'Running it under the debugger to see which steps happen…' : undefined };
		this.update(traced);
		if (!plan) {
			await this.save(traced);
			return;
		}
		const observation = await this.observe(traced, plan);
		const done: CodeTrace = { ...traced, status: 'ready', detail: undefined, ...(observation ? { observation } : {}) };
		this.update(done);
		await this.save(done);
	}

	/**
	 * Runs the path with a logpoint on each step that has a probe, and works out what happened at each step. One
	 * run uses one language's debugger: the language the command (or driver script) runs, or else the language
	 * most steps are in; steps in other languages stay inferred.
	 */
	private async observe(trace: CodeTrace, plan: TraceRunPlan): Promise<TraceObservation | undefined> {
		const { steps, id } = trace;
		const language = runLanguage(plan, steps);
		const probed: Array<{ step: TraceStep; point: BreakpointSpec }> = [];
		for (const step of steps) {
			if (!step.probe || languageOfFile(step.file) !== language) {
				continue;
			}
			const checked = await this.options.runner.checkPoint(step.file, step.probe.line);
			if (typeof checked === 'string') {
				continue; // a language the debugger can't do yet, for example: this step stays inferred
			}
			const logMessage = step.probe.values.map(value => `${value}={${value}}`).join(' · ') || 'reached';
			probed.push({ step, point: { ...checked, logMessage, maxHits: PROBE_MAX_HITS } });
		}
		let command = plan.command;
		if (!command && plan.script && (language === 'javascript' || language === 'python')) {
			// Driver scripts run from a temporary folder, never inside the project.
			const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-trace-'));
			const driver = path.join(dir, language === 'python' ? 'driver.py' : 'driver.mjs');
			await fs.writeFile(driver, plan.script, 'utf8');
			command = `${language === 'python' ? 'python' : 'node'} ${JSON.stringify(driver)}`;
		}
		const base = { command: command ?? '', ...(plan.script ? { script: plan.script } : {}), ...(plan.why ? { why: plan.why } : {}), ranAt: this.now() };
		if (!command || !probed.length) {
			const error = !command
				? (plan.script ? `Driver scripts only run for JavaScript and Python; ${DEBUG_LANGUAGE_NAMES[language]} needs a test command.` : 'There was nothing to run.')
				: `None of the steps can be observed by running \`${command}\` (it runs ${DEBUG_LANGUAGE_NAMES[language]}).`;
			return { ...base, outcome: 'failed', error, steps: {}, orderDiffers: false, output: [] };
		}
		this.options.log(`trace ${id}: observing with ${command} (${probed.length} probe(s))`);
		const run = await this.options.runner.observe(command, undefined, probed.map(entry => entry.point), RUN_TIMEOUT_MS);
		if ('error' in run) {
			return { ...base, outcome: 'failed', error: run.error.text, steps: {}, orderDiffers: false, output: [] };
		}
		const observed: Record<string, TraceStepObservation> = {};
		const firstHit = new Map<string, number>();
		run.hits.forEach((hit, position) => {
			const entry = probed[hit.index];
			if (!entry) {
				return;
			}
			const id = entry.step.id;
			if (!firstHit.has(id)) {
				firstHit.set(id, position);
			}
			const previous = observed[id] ?? { hits: 0, values: [] };
			observed[id] = { hits: previous.hits + 1, values: previous.values.length < 3 ? [...previous.values, hit.text] : previous.values };
		});
		// Order: the steps that ran, ranked by when each first ran.
		const ranked = [...firstHit].sort((a, b) => a[1] - b[1]).map(([id]) => id);
		ranked.forEach((id, order) => { observed[id] = { ...observed[id], order }; });
		for (const { step } of probed) {
			observed[step.id] ??= { hits: 0, values: [] };
		}
		return {
			...base,
			outcome: run.timedOut ? 'timedOut' : 'ran',
			steps: observed,
			orderDiffers: orderDiffers(steps, firstHit),
			output: run.output,
		};
	}

	private update(trace: CodeTrace): void {
		this.traces.set(trace.id, trace);
		this.options.emit(trace);
	}

	private async save(trace: CodeTrace): Promise<void> {
		await fs.mkdir(this.options.storeDir, { recursive: true });
		await fs.writeFile(path.join(this.options.storeDir, `${safe(trace.id)}.json`), JSON.stringify(trace), 'utf8');
	}

	private now(): number {
		return (this.options.now ?? Date.now)();
	}
}

function citedFiles(value: unknown): string[] {
	type Raw = { file?: unknown; fork?: { paths?: Array<{ steps?: Raw[] }> } };
	const steps = (value as { steps?: Raw[] } | undefined)?.steps;
	const all = (Array.isArray(steps) ? steps : []).flatMap(step => [step, ...(step?.fork?.paths ?? []).flatMap(path => Array.isArray(path?.steps) ? path.steps : [])]);
	return [...new Set(all.map(step => typeof step?.file === 'string' ? step.file.trim().replace(/^\.\//, '') : '').filter(Boolean))];
}

/** The language a run observes: what its command or driver script runs, else the language most probed steps are in. */
function runLanguage(plan: TraceRunPlan, steps: readonly TraceStep[]): DebugLanguage {
	const fromCommand = plan.command ? languageOfCommand(plan.command) : plan.script ? plan.language ?? 'javascript' : undefined;
	if (fromCommand) {
		return fromCommand;
	}
	const counts = new Map<DebugLanguage, number>();
	for (const step of steps) {
		const language = step.probe && languageOfFile(step.file);
		if (language) {
			counts.set(language, (counts.get(language) ?? 0) + 1);
		}
	}
	return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'javascript';
}

/**
 * Whether the steps first ran in a different order than the trace shows. Steps on different paths of one fork
 * have no order between them (the paths of an "all" fork can run in any order).
 */
function orderDiffers(steps: readonly TraceStep[], firstHit: ReadonlyMap<string, number>): boolean {
	const ran = steps.filter(step => firstHit.has(step.id));
	for (let i = 0; i < ran.length; i++) {
		for (let j = i + 1; j < ran.length; j++) {
			const [a, b] = [ran[i].branch, ran[j].branch];
			const unordered = a && b && a.fork === b.fork && a.path !== b.path;
			if (!unordered && firstHit.get(ran[j].id)! < firstHit.get(ran[i].id)!) {
				return true;
			}
		}
	}
	return false;
}

function safe(id: string): string {
	return id.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
