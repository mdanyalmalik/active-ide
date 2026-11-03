/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { createTrustedTypesPolicy } from '../../../../base/browser/trustedTypes.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { fromNow } from '../../../../base/common/date.js';
import { DisposableStore, toDisposable } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { tokenizeToString } from '../../../../editor/common/languages/textToHtmlTokenizer.js';
import { localize } from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { traceStepStates, type CodeTrace, type TraceFork, type TraceHopKind, type TraceStep, type TraceStepState, type TraceSummary } from '../common/activeProtocol.js';
import { TraceInput } from './activeInputs.js';
import { IActiveService } from './activeService.js';

const $ = dom.$;

/** The editor's tokenizer produces HTML; only this policy may insert it (allowed in the workbench's CSP by Active's patch). */
const tokenizerPolicy = createTrustedTypesPolicy('activeCodeTokenizer', { createHTML: (html: string) => html });

const HOP_ICONS: Record<TraceHopKind, ThemeIcon> = {
	call: Codicon.arrowDown,
	await: Codicon.watch,
	return: Codicon.reply,
	callback: Codicon.debugStepInto,
	event: Codicon.broadcast,
	state: Codicon.database,
	throw: Codicon.error,
	other: Codicon.arrowDown,
};


/**
 * The Code Trace tab. At the top, a box to ask for a trace (with an optional command that runs the path) and the
 * history of past traces; below, the trace on show as one page: the steps of a behavior in the order they happen,
 * each with its code, what happens there and how it leads to the next, top to bottom. When the trace was observed
 * (run under the debugger with a logpoint per step), each step says whether it ran, how often, and what values it
 * saw. A rail on the left lists the steps and follows the scroll.
 */
export class TraceEditor extends EditorPane {
	static readonly ID = 'workbench.editor.activeTrace';

	private root!: HTMLElement;
	private scroller!: HTMLElement;
	private question!: HTMLTextAreaElement;
	private command!: HTMLInputElement;
	private commandRow!: HTMLElement;
	private commandToggle!: HTMLButtonElement;
	private submit!: HTMLButtonElement;
	private historyToggle!: HTMLButtonElement;
	private historyPanel!: HTMLElement;
	private content!: HTMLElement;
	private history: TraceSummary[] = [];
	/** The history shows under the box when no trace is picked, or when opened over one. */
	private historyOpen = false;
	private readonly renderStore = this._register(new DisposableStore());
	private readonly historyStore = this._register(new DisposableStore());
	private readonly inputStore = this._register(new DisposableStore());
	/** Bumped for every render, so an older render's colouring (async) never lands on a newer page. */
	private renderToken = 0;
	private historyToken = 0;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storage: IStorageService,
		@IActiveService private readonly activeService: IActiveService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(TraceEditor.ID, group, telemetryService, themeService, storage);
	}

	protected createEditor(parent: HTMLElement): void {
		this.root = dom.append(parent, $('.active-trace'));
		this.scroller = dom.append(this.root, $('.trace-scroll'));
		this.scroller.tabIndex = 0;
		const page = dom.append(this.scroller, $('.trace-page'));
		this.createAskBox(page);
		this.historyPanel = dom.append(page, $('.trace-history'));
		this.content = dom.append(page, $('.trace-content'));
		// Any trace changing can change the history (a new one, or one finishing).
		this._register(this.activeService.onDidChangeTrace(() => void this.refreshHistory()));
	}

	private createAskBox(page: HTMLElement): void {
		const box = dom.append(page, $('.trace-ask.active-chat-composer'));
		this.question = dom.append(box, $('textarea')) as HTMLTextAreaElement;
		this.question.rows = 2;
		this.question.placeholder = localize('traceAskPlaceholder', "What should be traced? For example: what happens when a request gets a 429");
		this.question.setAttribute('aria-label', localize('traceAskLabel', "What to trace"));
		this.commandRow = dom.append(box, $('.trace-command.hidden'));
		dom.append(this.commandRow, $('span.icon')).classList.add(...ThemeIcon.asClassNameArray(Codicon.terminal));
		this.command = dom.append(this.commandRow, $('input')) as HTMLInputElement;
		this.command.type = 'text';
		this.command.spellcheck = false;
		this.command.placeholder = localize('traceCommandPlaceholder', "A command that runs this path, e.g. npm test -- retry (optional)");
		this.command.setAttribute('aria-label', localize('traceCommandLabel', "Command to observe it with"));
		const bar = dom.append(box, $('.composer-bar'));
		const left = dom.append(bar, $('.composer-tools'));
		this.historyToggle = dom.append(left, $('button.composer-effort.trace-history-toggle')) as HTMLButtonElement;
		this.commandToggle = dom.append(left, $('button.composer-effort')) as HTMLButtonElement;
		dom.append(this.commandToggle, $('span.icon')).classList.add(...ThemeIcon.asClassNameArray(Codicon.terminal));
		dom.append(this.commandToggle, $('span')).textContent = localize('traceCommandToggle', "Run with a command");
		this.commandToggle.title = localize('traceCommandToggleTitle', "Choose the command that runs this path. Otherwise Active picks a test, or writes a small script that drives it.");
		const right = dom.append(bar, $('.composer-tools'));
		this.submit = dom.append(right, $('button.send.primary')) as HTMLButtonElement;
		this.submit.textContent = localize('traceSubmit', "Trace ↑");
		this.submit.disabled = true;
		this._register(dom.addDisposableListener(this.question, dom.EventType.INPUT, () => this.submit.disabled = !this.question.value.trim()));
		this._register(dom.addDisposableListener(this.question, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
				event.preventDefault();
				void this.ask();
			}
		}));
		this._register(dom.addDisposableListener(this.command, dom.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter' && !event.isComposing) {
				event.preventDefault();
				void this.ask();
			}
		}));
		this._register(dom.addDisposableListener(this.submit, dom.EventType.CLICK, () => void this.ask()));
		this._register(dom.addDisposableListener(this.commandToggle, dom.EventType.CLICK, () => {
			const show = this.commandRow.classList.contains('hidden');
			this.commandRow.classList.toggle('hidden', !show);
			this.commandToggle.classList.toggle('selected', show);
			if (show) {
				this.command.focus();
			} else {
				this.command.value = '';
				this.question.focus();
			}
		}));
		this._register(dom.addDisposableListener(this.historyToggle, dom.EventType.CLICK, () => {
			this.historyOpen = !this.historyOpen;
			this.renderHistory();
		}));
	}

	private async ask(): Promise<void> {
		const question = this.question.value.trim();
		if (!question) {
			return;
		}
		const command = this.commandRow.classList.contains('hidden') ? '' : this.command.value.trim();
		this.question.value = '';
		this.submit.disabled = true;
		this.historyOpen = false;
		await this.activeService.startTrace({ question, ...(command ? { command } : {}) });
	}

	override async setInput(input: TraceInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this.inputStore.clear();
		this.inputStore.add(this.activeService.onDidChangeTrace(id => id === input.traceId && this.render()));
		this.inputStore.add(input.onDidChangeSelection(() => void this.show(input)));
		void this.refreshHistory();
		await this.show(input, token);
	}

	private async show(input: TraceInput, token?: CancellationToken): Promise<void> {
		this.historyOpen = false;
		const trace = input.traceId ? await this.activeService.loadTrace(input.traceId) : undefined;
		if (!token?.isCancellationRequested && input === this.input) {
			this.scroller.scrollTop = 0;
			this.render(trace);
			this.renderHistory();
		}
	}

	override clearInput(): void {
		this.inputStore.clear();
		super.clearInput();
	}

	override focus(): void {
		if (this.traceInput?.traceId) {
			this.scroller.focus();
		} else {
			this.question.focus();
		}
	}

	override layout(dimension: dom.Dimension): void {
		this.root.style.width = `${dimension.width}px`;
		this.root.style.height = `${dimension.height}px`;
		this.root.classList.toggle('narrow', dimension.width < 820);
	}

	private get traceInput(): TraceInput | undefined {
		return this.input instanceof TraceInput ? this.input : undefined;
	}

	private async refreshHistory(): Promise<void> {
		const token = ++this.historyToken;
		const history = await this.activeService.traceHistory();
		if (token === this.historyToken) {
			this.history = history;
			this.renderHistory();
		}
	}

	/** Past traces: the one on show is marked, a click shows another, and each can be removed. */
	private renderHistory(): void {
		const input = this.traceInput;
		const selected = input?.traceId;
		const open = !selected || this.historyOpen;
		this.historyStore.clear();
		dom.clearNode(this.historyPanel);
		dom.clearNode(this.historyToggle);
		dom.append(this.historyToggle, $('span.icon')).classList.add(...ThemeIcon.asClassNameArray(Codicon.history));
		dom.append(this.historyToggle, $('span')).textContent = this.history.length ? localize('traceHistoryCount', "History ({0})", this.history.length) : localize('traceHistory', "History");
		dom.append(this.historyToggle, $('span.chevron')).classList.add(...ThemeIcon.asClassNameArray(open ? Codicon.chevronUp : Codicon.chevronDown));
		// With no trace picked the history is the page, so there's nothing to toggle.
		this.historyToggle.classList.toggle('hidden', !selected);
		this.historyToggle.classList.toggle('selected', open);
		this.historyToggle.setAttribute('aria-expanded', String(open));
		this.historyPanel.classList.toggle('hidden', !open);
		this.content.classList.toggle('hidden', !selected);
		if (!open) {
			return;
		}
		if (!this.history.length) {
			const empty = dom.append(this.historyPanel, $('.trace-history-empty'));
			dom.append(empty, $('p')).textContent = localize('traceIntro', "Ask how something flows through your code. Active follows it step by step, shows the code for each step in order, then runs it under the debugger to check which steps really happen and with what values.");
			dom.append(empty, $('p.muted')).textContent = localize('traceIntroNote', "This feature is in preview. The check by running only works for JavaScript and TypeScript so far; in other languages you still get the steps, read from the source but not checked.");
			return;
		}
		dom.append(this.historyPanel, $('.trace-history-title')).textContent = localize('traceHistoryTitle', "Past traces");
		const list = dom.append(this.historyPanel, $('ul.trace-history-list'));
		for (const entry of this.history) {
			const row = dom.append(list, $('li.trace-history-item'));
			row.classList.toggle('current', entry.id === selected);
			const open = dom.append(row, $('button.trace-history-open')) as HTMLButtonElement;
			const [icon, status] = historyStatus(entry);
			const iconElement = dom.append(open, $('span.icon'));
			iconElement.classList.add(...ThemeIcon.asClassNameArray(icon), `status-${entry.evidence ?? entry.status}`);
			if (entry.status === 'tracing' || entry.status === 'observing') {
				iconElement.classList.add('codicon-modifier-spin');
			}
			const text = dom.append(open, $('span.text'));
			dom.append(text, $('span.title')).textContent = entry.title;
			const meta = dom.append(text, $('span.meta'));
			meta.textContent = `${status} · ${fromNow(entry.createdAt, true)}`;
			if (entry.question !== entry.title) {
				open.title = entry.question;
			}
			this.historyStore.add(dom.addDisposableListener(open, dom.EventType.CLICK, () => {
				this.historyOpen = false;
				if (entry.id === selected) {
					this.renderHistory();
				} else {
					input?.select(entry.id);
				}
			}));
			const remove = dom.append(row, $('button.trace-history-remove')) as HTMLButtonElement;
			remove.classList.add(...ThemeIcon.asClassNameArray(Codicon.close));
			remove.title = localize('traceRemove', "Remove from history");
			remove.setAttribute('aria-label', localize('traceRemoveLabel', "Remove {0} from history", entry.title));
			this.historyStore.add(dom.addDisposableListener(remove, dom.EventType.CLICK, async () => {
				this.history = this.history.filter(other => other.id !== entry.id);
				if (entry.id === selected) {
					input?.select(undefined);
				} else {
					this.renderHistory();
				}
				await this.activeService.deleteTrace(entry.id);
			}));
		}
	}

	private render(given?: CodeTrace): void {
		const input = this.traceInput;
		if (!input?.traceId) {
			this.renderStore.clear();
			dom.clearNode(this.content);
			return;
		}
		const trace = given ?? this.activeService.trace(input.traceId);
		const token = ++this.renderToken;
		const scrollTop = this.scroller.scrollTop;
		this.renderStore.clear();
		dom.clearNode(this.content);
		if (!trace) {
			const empty = dom.append(this.content, $('.trace-empty'));
			empty.textContent = localize('traceMissing', "This trace is no longer available.");
			return;
		}
		input.setTitle(trace.title);
		const page = this.content;
		this.renderHeader(page, trace);
		if (!trace.steps.length) {
			return;
		}
		const body = dom.append(page, $('.trace-body'));
		const rail = dom.append(body, $('nav.trace-rail'));
		const flow = dom.append(body, $('.trace-flow'));
		const cards = new Map<string, HTMLElement>();
		const states = traceStepStates(trace);
		// The main line top to bottom; a fork's steps (together in `steps`) are drawn as one block of side-by-side paths.
		for (let index = 0; index < trace.steps.length;) {
			const step = trace.steps[index];
			const fork = step.branch && trace.forks?.find(candidate => candidate.id === step.branch!.fork);
			if (fork) {
				let end = index;
				while (end < trace.steps.length && trace.steps[end].branch?.fork === fork.id) {
					end++;
				}
				this.renderFork(flow, trace, fork, index, end, states, cards, token);
				if (end < trace.steps.length && fork.paths.some(path => !path.ends)) {
					this.renderJoin(flow);
				}
				index = end;
				continue;
			}
			cards.set(step.id, this.renderStep(flow, trace, step, index, states[step.id], token));
			if (step.hop && index < trace.steps.length - 1) {
				this.renderHop(flow, step);
			}
			index++;
		}
		this.renderRail(rail, trace, states, cards);
		this.scroller.scrollTop = scrollTop;
	}

	private renderHeader(page: HTMLElement, trace: CodeTrace): void {
		const header = dom.append(page, $('header.trace-header'));
		dom.append(header, $('.trace-eyebrow')).textContent = localize('traceEyebrow', "Code trace");
		dom.append(header, $('h1')).textContent = trace.title;
		if (trace.question && trace.question !== trace.title) {
			dom.append(header, $('.trace-question')).textContent = trace.question;
		}
		if (trace.overview) {
			dom.append(header, $('p.trace-overview')).textContent = trace.overview;
		}
		const banner = dom.append(header, $('.trace-evidence'));
		const icon = dom.append(banner, $('span.icon'));
		const text = dom.append(banner, $('span.text'));
		const observation = trace.observation;
		const byId = traceStepStates(trace);
		const states = trace.steps.map(step => byId[step.id]);
		if (trace.status === 'tracing' || trace.status === 'observing') {
			banner.classList.add('busy');
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.loading), 'codicon-modifier-spin');
			text.textContent = trace.detail ?? '';
			return;
		}
		if (trace.status === 'failed') {
			banner.classList.add('warning');
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.warning));
			text.textContent = trace.detail ?? localize('traceFailed', "The trace failed.");
			return;
		}
		if (!observation) {
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.book));
			text.textContent = localize('traceInferred', "Inferred from the source: nothing was run to check it.");
			return;
		}
		if (observation.outcome === 'failed') {
			banner.classList.add('warning');
			icon.classList.add(...ThemeIcon.asClassNameArray(Codicon.warning));
			text.textContent = localize('traceNotObserved', "Inferred from the source. It couldn't be observed: {0}", observation.error ?? '');
		} else {
			// Steps on fork paths the run didn't take aren't counted: not running them is expected.
			const notTaken = states.filter(state => state === 'notTaken').length;
			const probed = states.filter(state => state !== 'inferred' && state !== 'notTaken').length;
			const ran = states.filter(state => state === 'observed').length;
			const unreached = trace.steps.map((step, index) => states[index] === 'notReached' ? String(index + 1) : '').filter(Boolean);
			banner.classList.add(ran === probed && !observation.orderDiffers ? 'observed' : 'partial');
			icon.classList.add(...ThemeIcon.asClassNameArray(ran === probed && !observation.orderDiffers ? Codicon.passFilled : Codicon.info));
			const order = ran < 2 ? '' : observation.orderDiffers ? localize('traceOrderDiffers', " The order they ran in differs from the order shown (see each step's run number).") : localize('traceOrderMatches', " They ran in the order shown.");
			const inferredOnly = trace.steps.length - probed - notTaken;
			const counted = !inferredOnly
				? localize('traceRanAll', "{0} of {1} steps ran.", ran, probed)
				: localize('traceRanSome', "{0} of the {1} steps that could be observed ran; {2} are inferred only.", ran, probed, inferredOnly);
			const taken = (trace.forks ?? []).filter(fork => fork.kind === 'either').map(fork => {
				const ranPaths = this.pathsThatRan(trace, fork, byId);
				return ranPaths.length === 1
					? localize('traceForkTook', " At the fork {0}, it took \u201c{1}\u201d.", fork.label ? `\u201c${fork.label}\u201d` : '', fork.paths[ranPaths[0]].label)
					: ranPaths.length > 1 ? localize('traceForkTookSeveral', " At the fork {0}, it went down {1} paths (at different times).", fork.label ? `\u201c${fork.label}\u201d` : '', ranPaths.length) : '';
			}).join('');
			const missing = unreached.length ? localize('traceUnreachedSummary', " The logpoint line of step {0} never ran: see that step.", unreached.join(', ')) : '';
			text.textContent = `${observation.outcome === 'timedOut' ? localize('traceTimedOut', "Observed (the run hit its time limit). ") : localize('traceObserved', "Observed by running it under the debugger. ")}${counted}${taken}${order}${missing}`;
		}
		// What was run, and what it printed, for anyone who wants to check.
		const details = dom.append(header, $('details.trace-run'));
		dom.append(details, $('summary')).textContent = observation.script ? localize('traceRunScript', "What was run: a driver script") : localize('traceRunCommand', "What was run: {0}", observation.command);
		if (observation.why) {
			dom.append(details, $('p')).textContent = observation.why;
		}
		if (observation.script) {
			dom.append(details, $('pre.trace-script')).textContent = observation.script;
		}
		if (observation.output.length) {
			dom.append(details, $('.trace-run-label')).textContent = localize('traceOutput', "Output");
			dom.append(details, $('pre.trace-output')).textContent = observation.output.join('\n');
		}
	}

	/** The paths of a fork that had a step run. */
	private pathsThatRan(trace: CodeTrace, fork: TraceFork, states: Record<string, TraceStepState>): number[] {
		return fork.paths.map((_, path) => path).filter(path => trace.steps.some(step => step.branch?.fork === fork.id && step.branch.path === path && states[step.id] === 'observed'));
	}

	/**
	 * A fork: its paths side by side (stacked when narrow), each with its steps and how it ends. For an "either"
	 * fork the run shows which path was taken; for an "all" fork, which paths ran.
	 */
	private renderFork(flow: HTMLElement, trace: CodeTrace, fork: TraceFork, start: number, end: number, states: Record<string, TraceStepState>, cards: Map<string, HTMLElement>, token: number): void {
		const block = dom.append(flow, $(`section.trace-fork.${fork.kind}`));
		const head = dom.append(block, $('.fork-head'));
		dom.append(head, $('span.fork-icon')).classList.add(...ThemeIcon.asClassNameArray(fork.kind === 'either' ? Codicon.repoForked : Codicon.typeHierarchySub));
		const title = dom.append(head, $('span.fork-title'));
		title.textContent = fork.kind === 'either'
			? (fork.label ? localize('traceForkEither', "One of these, {0}", fork.label) : localize('traceForkEitherBare', "One of these"))
			: (fork.label ? localize('traceForkAll', "All of these: {0}", fork.label) : localize('traceForkAllBare', "All of these"));
		title.title = fork.kind === 'either' ? localize('traceForkEitherTitle', "Only one path runs each time, depending on the condition.") : localize('traceForkAllTitle', "Every path runs, in any order or at the same time.");
		const observed = trace.observation && trace.observation.outcome !== 'failed';
		const ran = this.pathsThatRan(trace, fork, states);
		const paths = dom.append(block, $('.fork-paths'));
		paths.style.setProperty('--active-fork-paths', String(fork.paths.length));
		fork.paths.forEach((path, pathIndex) => {
			const column = dom.append(paths, $('.fork-path'));
			const pathHead = dom.append(column, $('.path-head'));
			dom.append(pathHead, $('span.path-letter')).textContent = String.fromCharCode(65 + pathIndex);
			dom.append(pathHead, $('span.path-label')).textContent = path.label;
			const probed = trace.steps.slice(start, end).some(step => step.branch?.path === pathIndex && states[step.id] !== 'inferred');
			if (observed && probed) {
				const tookIt = ran.includes(pathIndex);
				const chip = dom.append(pathHead, $(`span.path-state.${tookIt ? 'taken' : fork.kind === 'either' && ran.length ? 'notTaken' : 'missed'}`));
				chip.textContent = tookIt
					? (fork.kind === 'either' ? localize('tracePathTaken', "Taken") : localize('tracePathRan', "Ran"))
					: fork.kind === 'either' && ran.length ? localize('tracePathNotTaken', "Not taken") : localize('tracePathMissed', "Didn't run");
			}
			column.classList.toggle('dim', observed && probed && !ran.includes(pathIndex) && fork.kind === 'either' && ran.length > 0);
			const pathSteps = trace.steps.map((step, index) => ({ step, index })).slice(start, end).filter(({ step }) => step.branch?.path === pathIndex);
			pathSteps.forEach(({ step, index }, position) => {
				cards.set(step.id, this.renderStep(column, trace, step, index, states[step.id], token));
				if (step.hop && position < pathSteps.length - 1) {
					this.renderHop(column, step);
				}
			});
			if (path.ends) {
				const ends = dom.append(column, $('.path-ends'));
				dom.append(ends, $('span.icon')).classList.add(...ThemeIcon.asClassNameArray(Codicon.debugStepOut));
				dom.append(ends, $('span')).textContent = path.ends;
			}
		});
	}

	/** Where a fork's paths come back together and the main line carries on. */
	private renderJoin(flow: HTMLElement): void {
		const join = dom.append(flow, $('.trace-hop.join'));
		dom.append(join, $('span.hop-line'));
		const chip = dom.append(join, $('span.hop-chip'));
		dom.append(chip, $('span.hop-icon')).classList.add(...ThemeIcon.asClassNameArray(Codicon.arrowDown));
		dom.append(chip, $('span')).textContent = localize('traceJoin', "then, after the fork");
	}

	private renderStep(flow: HTMLElement, trace: CodeTrace, step: TraceStep, index: number, state: TraceStepState, token: number): HTMLElement {
		const seen = trace.observation?.steps[step.id];
		const card = dom.append(flow, $(`section.trace-step.${state}`));
		card.id = `trace-step-${step.id}`;
		const head = dom.append(card, $('.step-head'));
		dom.append(head, $('span.step-number')).textContent = String(index + 1);
		const titles = dom.append(head, $('.step-titles'));
		dom.append(titles, $('span.step-symbol')).textContent = step.symbol ?? step.file.split('/').pop() ?? step.file;
		const where = dom.append(titles, $('button.step-where')) as HTMLButtonElement;
		where.textContent = `${step.file}:${step.startLine}${step.endLine !== step.startLine ? `–${step.endLine}` : ''}`;
		where.title = localize('traceOpenFile', "Open {0} at these lines", step.file);
		this.renderStore.add(dom.addDisposableListener(where, dom.EventType.CLICK, () => void this.openStep(step)));
		const badge = dom.append(head, $(`span.step-badge.${state}`));
		if (state === 'observed') {
			badge.textContent = seen!.hits > 1 ? localize('traceRanTimes', "Ran ×{0}", seen!.hits) : localize('traceRanOnce', "Ran");
			if (trace.observation?.orderDiffers && seen?.order !== undefined) {
				badge.textContent += localize('traceRunOrder', " · {0} to run", ordinal(seen.order + 1));
			}
			badge.title = localize('traceObservedTitle', "Its logpoint printed when the code ran under the debugger.");
		} else if (state === 'notReached') {
			badge.textContent = step.probe ? localize('traceLineNotReached', "Line {0} didn't run", step.probe.line) : localize('traceNotReached', "Didn't run");
			badge.title = localize('traceNotReachedTitle', "The run never reached this step's logpoint line.");
		} else if (state === 'notTaken') {
			badge.textContent = localize('traceNotTakenBadge', "Not taken");
			badge.title = localize('traceNotTakenTitle', "This run went down another path at the fork, so this step didn't happen (as expected).");
		} else {
			badge.textContent = localize('traceInferredBadge', "Inferred");
			badge.title = localize('traceInferredTitle', "Read from the source; not checked by running it.");
		}
		if (step.repeats) {
			const repeats = dom.append(titles, $('span.step-repeats'));
			dom.append(repeats, $('span.icon')).classList.add(...ThemeIcon.asClassNameArray(Codicon.sync));
			dom.append(repeats, $('span')).textContent = step.repeats;
			repeats.title = localize('traceRepeatsTitle', "This step runs repeatedly on this path.");
		}
		dom.append(card, $('p.step-summary')).textContent = step.summary;
		const snippet = trace.snippets[step.id];
		if (snippet) {
			const code = dom.append(card, $('.step-code'));
			const rows = snippet.lines.map((line, offset) => {
				const number = snippet.firstLine + offset;
				const row = dom.append(code, $('.code-row'));
				row.classList.toggle('probe', step.probe?.line === number);
				dom.append(row, $('span.code-line')).textContent = String(number);
				const source = dom.append(row, $('span.code-src'));
				source.textContent = line || ' ';
				return source;
			});
			void this.colorize(snippet.lines.join('\n'), snippet.languageId, rows, token);
		}
		if (state === 'observed' && seen?.values.some(value => value && value !== 'reached')) {
			const values = dom.append(card, $('.step-values'));
			dom.append(values, $('span.label')).textContent = step.probe ? localize('traceSeenAt', "Seen at line {0}", step.probe.line) : localize('traceSeen', "Seen");
			for (const value of seen.values.filter(text => text && text !== 'reached')) {
				dom.append(values, $('code.value')).textContent = value;
			}
			if (seen.hits > seen.values.length) {
				dom.append(values, $('span.more')).textContent = localize('traceMoreHits', "+{0} more", seen.hits - seen.values.length);
			}
		}
		if (state === 'notReached') {
			dom.append(card, $('p.step-unreached')).textContent = localize('traceUnreachedNote', "Line {0} never ran in this run. Either the path went another way here, or the line is inside a branch this path skips (so the trace is right but its logpoint was in the wrong place).", step.probe?.line ?? step.startLine);
		}
		if (step.detail) {
			dom.append(card, $('p.step-detail')).textContent = step.detail;
		}
		return card;
	}

	private renderHop(flow: HTMLElement, step: TraceStep): void {
		const hop = dom.append(flow, $(`.trace-hop.${step.hop!.kind}`));
		dom.append(hop, $('span.hop-line'));
		const chip = dom.append(hop, $('span.hop-chip'));
		dom.append(chip, $('span.hop-icon')).classList.add(...ThemeIcon.asClassNameArray(HOP_ICONS[step.hop!.kind] ?? Codicon.arrowDown));
		dom.append(chip, $('span')).textContent = step.hop!.label || step.hop!.kind;
	}

	/** Numbered steps beside the page; the one on screen is highlighted, and a click scrolls to it. */
	private renderRail(rail: HTMLElement, trace: CodeTrace, states: Record<string, TraceStepState>, cards: Map<string, HTMLElement>): void {
		const items = new Map<string, HTMLElement>();
		trace.steps.forEach((step, index) => {
			const item = dom.append(rail, $(`button.rail-step.${states[step.id]}`)) as HTMLButtonElement;
			// Steps on a fork's paths are indented under it, marked with their path's letter.
			item.classList.toggle('branch', !!step.branch);
			if (step.branch) {
				dom.append(item, $('span.rail-path')).textContent = String.fromCharCode(65 + step.branch.path);
			}
			dom.append(item, $('span.rail-number')).textContent = String(index + 1);
			dom.append(item, $('span.rail-name')).textContent = step.symbol ?? step.file.split('/').pop() ?? step.file;
			item.title = step.summary;
			items.set(step.id, item);
			this.renderStore.add(dom.addDisposableListener(item, dom.EventType.CLICK, () => cards.get(step.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })));
		});
		const window = dom.getWindow(this.scroller);
		const observer = new window.IntersectionObserver(entries => {
			const visible = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
			if (visible) {
				const id = visible.target.id.replace('trace-step-', '');
				for (const [stepId, item] of items) {
					item.classList.toggle('current', stepId === id);
				}
			}
		}, { root: this.scroller, rootMargin: '-15% 0px -60% 0px' });
		for (const card of cards.values()) {
			observer.observe(card);
		}
		this.renderStore.add(toDisposable(() => observer.disconnect()));
	}

	/** Colours the snippet with the editor's own tokenizer, row by row (the plain text shows until it's ready). */
	private async colorize(text: string, languageId: string | undefined, rows: HTMLElement[], token: number): Promise<void> {
		if (!languageId || !tokenizerPolicy) {
			return;
		}
		try {
			const html = await tokenizeToString(this.languageService, text, languageId);
			if (token !== this.renderToken) {
				return;
			}
			const inner = html.replace(/^<div class="monaco-tokenized-source">/, '').replace(/<\/div>$/, '');
			const lines = inner.split('<br/>');
			if (lines.length !== rows.length) {
				return;
			}
			rows.forEach((row, index) => {
				row.innerHTML = tokenizerPolicy.createHTML(lines[index] || ' ') as unknown as string;
			});
		} catch {
			// Plain text stays.
		}
	}

	private async openStep(step: TraceStep): Promise<void> {
		// Traces are made in the highlighted agent's folder.
		const resource = this.activeService.resolveAgentPath(step.file);
		if (!resource) {
			return;
		}
		await this.editorService.openEditor({
			resource,
			options: { pinned: true, selection: { startLineNumber: step.startLine, startColumn: 1, endLineNumber: step.endLine, endColumn: 1 } },
		});
	}
}

function historyStatus(entry: TraceSummary): [ThemeIcon, string] {
	switch (entry.status) {
		case 'tracing': return [Codicon.loading, localize('traceStatusTracing', "Reading the code")];
		case 'observing': return [Codicon.loading, localize('traceStatusObserving', "Running it")];
		case 'failed': return [Codicon.warning, localize('traceStatusFailed', "Failed")];
		default: return entry.evidence === 'observed' ? [Codicon.passFilled, localize('traceStatusObserved', "Observed")] : [Codicon.book, localize('traceStatusInferred', "From the source")];
	}
}

function ordinal(n: number): string {
	return n === 1 ? localize('first', "1st") : n === 2 ? localize('second', "2nd") : n === 3 ? localize('third', "3rd") : localize('nth', "{0}th", n);
}
