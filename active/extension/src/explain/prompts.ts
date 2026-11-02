/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CapturedFile, CodeSelection, KnowledgeProfile, MapSelection, PendingCheck, SystemMap, TaskRequest, ToolOutcome, Walkthrough, WalkthroughDraft } from '../shared/activeProtocol';
import { diffLines, splitLines, unifiedDiff } from '../tracking/lineDiff';

export interface PlanningContext {
	readonly task: string;
	readonly turnIndex: number;
	readonly profile: KnowledgeProfile;
	readonly files: Readonly<Record<string, CapturedFile>>;
	readonly agentMessages: readonly string[];
	readonly reasoningSummaries: readonly string[];
	readonly tools: readonly ToolOutcome[];
	readonly pending: readonly PendingCheck[];
	readonly history: readonly string[];
	readonly userNotes: readonly string[];
	readonly final: boolean;
	/** Lean toward a note for small changes and short requests (`active.explain.preferNotesForSmallChanges`). */
	readonly preferNotes: boolean;
	/** Set when the turn is explained in chapters: this one's number and the chapters already shown. */
	readonly chapter?: { readonly index: number; readonly earlier: ReadonlyArray<{ readonly title: string; readonly summary: string }> };
	/** The explainer's memory (`ExplainerMemory.describe`), if any. */
	readonly memory?: string;
}

const MAX_FILE_CHARS = 24000;

/** Final-version text with line numbers; long files keep windows around the changed hunks. */
export function numberedExcerpt(file: CapturedFile, version: 'baseline' | 'final' = 'final'): string {
	const text = version === 'final' ? file.final : file.baseline;
	if (text === null) {
		return '(file does not exist in this version)';
	}
	const lines = splitLines(text);
	const width = String(lines.length).length;
	const render = (index: number) => `${String(index + 1).padStart(width)}│ ${lines[index]}`;
	if (text.length <= MAX_FILE_CHARS) {
		return lines.map((_, index) => render(index)).join('\n');
	}
	const keep = new Set<number>();
	for (const hunk of diffLines(file.baseline, file.final)) {
		const start = (version === 'final' ? hunk.newStart : hunk.oldStart) - 1;
		const length = version === 'final' ? hunk.newLines : hunk.oldLines;
		for (let index = Math.max(0, start - 40); index < Math.min(lines.length, start + length + 40); index++) {
			keep.add(index);
		}
	}
	const out: string[] = [];
	let skipped = 0;
	for (let index = 0; index < lines.length; index++) {
		if (keep.has(index)) {
			if (skipped) {
				out.push(`${' '.repeat(width)}│ … ${skipped} unchanged lines …`);
				skipped = 0;
			}
			out.push(render(index));
		} else {
			skipped++;
		}
	}
	if (skipped) {
		out.push(`${' '.repeat(width)}│ … ${skipped} unchanged lines …`);
	}
	return out.join('\n');
}

function familiarityList(items: KnowledgeProfile['languages']): string {
	return items.length ? items.map(item => `${item.name} (${item.familiarity})`).join(', ') : 'not specified';
}

function detailLean(bias: number | undefined): string {
	if (!bias || Math.abs(bias) < 0.1) {
		return '';
	}
	const amount = Math.abs(bias) >= 0.6 ? 'noticeably' : 'slightly';
	return ` (from their feedback: lean ${amount} toward ${bias > 0 ? 'more' : 'less'} detail within this depth)`;
}

export function describeProfile(profile: KnowledgeProfile): string {
	return [
		`Background: ${profile.background || 'not specified'} (${profile.yearsProgramming} years programming)`,
		`Languages: ${familiarityList(profile.languages)}`,
		`Concepts: ${familiarityList(profile.concepts)}`,
		`Follow closely: ${profile.followClosely || 'not specified'}`,
		`Skim past: ${profile.glossOver || 'not specified'}`,
		`Depth: ${profile.depth}${detailLean(profile.detailBias)}. Mathematical notation: ${profile.math}.`,
		`Useful visuals: ${profile.preferredVisuals.join(', ') || 'any'}`,
		profile.notes ? `Notes: ${profile.notes}` : '',
	].filter(Boolean).join('\n');
}

const SCHEMA = `{
  "format": "walkthrough"|"note"|"skip", // see LENGTH; "skip" needs only "reason"; "note" needs "note", "title" and "at"
  "reason"?: string,               // one line: why this format and length suit this developer
  "note"?: string,                 // format "note": one or two plain sentences, shown in chat, read aloud and shown beside the code
  "at"?: { "file": string, "focus": [{ "startLine": n, "endLine": n }], "anchorLine": n }, // format "note": the lines the note is about
  "remember"?: [{ "scope": "personal"|"project", "note": string, "replaces"?: memoryId }], // any format: see MEMORY
  "title": string,                 // short headline for the whole walkthrough
  "summary": string,               // 1-2 sentences
  "terms": [{ "name": string, "meaning": string, "codeSymbol"?: string }],
  "scenes": [{
    "id": string,
    "role": "problem"|"intuition"|"model"|"implementation"|"behavior"|"evidence"|"tradeoff"|"summary",
    "label": string,               // eyebrow, e.g. "Underlying concept", "Code diff", "Evidence"
    "title": string,               // one idea, stated as a takeaway
    "file": string,                // one of the CAPTURED FILES paths, shown in the editor
    "version": "final"|"baseline",
    "focus": [{ "startLine": n, "endLine": n }],   // lines of file@version to highlight
    "context"?: { "startLine": n, "endLine": n },  // region kept visible; the rest is folded
    "anchorLine": n,               // explanation zone appears after this line
    "symbol"?: string,             // enclosing class/function for breadcrumbs, e.g. "RequestCoordinator › load"
    "quote"?: string,              // optional verbatim code from file@version that the scene relies on
    "visual"?: one of
       { "type": "code", "file": string, "version": "final"|"baseline", "range": {startLine,endLine}, "caption"?: string }
     | { "type": "diff", "file": string, "range": {startLine,endLine} /* final-version lines whose hunks to show */, "caption"?: string }
     | { "type": "equation", "latex": string, "legend"?: [{ "symbol": string, "term": string }], "caption"?: string }
     | { "type": "diagram", "nodes": [{ "id": string, "label": string, "detail"?: string, "column"?: n }], "edges": [{ "from": id, "to": id, "label"?: string }], "illustrative": boolean, "caption"?: string }
     | { "type": "chart", "chart": "bar"|"line", "title": string, "xLabel": string, "yLabel": string, "series": [{ "name": string, "points": [{ "x": string|number, "y": number }] }], "source": "observed"|"illustrative", "evidence"?: toolOutcomeId, "caption"?: string },
    "narration": [{ "text": string, "cue"?: { "focus"?: indexIntoFocus, "nodes"?: [nodeId], "reveal"?: n } }],
    "pending"?: [string]           // unfinished checks this scene must describe as pending
  }]
}`;

const EXPLAINING = `Brief the developer like a sharp colleague walking them through a change, one coherent idea per scene — never a chronological recital of edits. They may be junior or senior; keep them informed at the level their profile asks for, without lecturing:
1. Open with the problem or intuition (why this change exists).
2. When it helps, show a conceptual model (diagram, equation or chart) before the code.
3. Connect the model to the implementation: put the editor on the exact lines and say how they realize the idea.
4. Then explain behavior, evidence (tests, command results) and tradeoffs.
Use the same names for the same things in narration, diagram labels, equation symbols and code (declare them in "terms").
Pick the visual that explains best: "diff" when the before/after contrast matters, "code" for another relevant excerpt, "equation" for quantitative rules, "diagram" for flows/relationships, "chart" for numeric behavior. Omit the visual when the highlighted code is enough.
Narration is spoken aloud: plain sentences, no markdown, no code blocks, no line numbers; 1-3 sentences per segment; use cues so the visual changes in step with the words.
Ground every implementation claim in the captured code and tool results. Anything not observed (example timings, hypothetical callers) must be framed as an example in the narration and marked "illustrative": true / "source": "illustrative".
Never say a check passed unless a tool outcome shows it. Mention pending checks as still running.
Tool outcome ids exist only for a chart's "evidence" field: never mention ids, "tool outcome", or other internal names in titles or narration. Describe evidence the way the developer saw it (for example "the test run at the end of this turn").`;

function toolSection(tools: readonly ToolOutcome[]): string {
	if (!tools.length) {
		return '(none)';
	}
	return tools.map(tool => {
		const output = tool.output ? `\n    output: ${tool.output.slice(0, 1500).replace(/\n/g, '\n    ')}` : '';
		return `- id=${tool.id} ${tool.tool}${tool.command ? ` \`${tool.command}\`` : ''} → ${tool.status}${tool.background ? ' (background)' : ''}${output}`;
	}).join('\n');
}

export function buildPlanningPrompt(context: PlanningContext, previous?: WalkthroughDraft): string {
	const files = Object.values(context.files);
	const fileSections = files.map(file => {
		const diff = unifiedDiff(file.path, file.baseline, file.final);
		const status = file.baseline === null ? 'new file' : file.final === null ? 'deleted' : `+${file.added} -${file.removed}`;
		return `### ${file.path} (${status})\nDIFF:\n${diff || '(no net change)'}\n\nFINAL VERSION (line numbers are what "focus", "range" and "anchorLine" refer to):\n${numberedExcerpt(file, file.final === null ? 'baseline' : 'final')}`;
	}).join('\n\n');
	const sections = [
		`You are the explanation planner inside Active, an IDE that narrates what a coding agent just did. You only read; you never modify files (your session runs under a read-only permission profile). The working directory is the live project, so you may read other files for context, but it can keep changing while you work: the CAPTURED FILES below are the authoritative versions for this turn.`,
		`Produce a walkthrough of this turn's code change for the developer below as a single JSON object matching this schema (reply with only the JSON in one \`\`\`json block):\n${SCHEMA}`,
		EXPLAINING,
		`DEVELOPER PROFILE\n${describeProfile(context.profile)}\nAdapt what you cover, detail, vocabulary and pacing to this profile: skim what they want skimmed, spend scenes on what they follow closely, and don't explain what they already know well. ${context.profile.math === 'avoid' ? 'Avoid equations.' : ''}`,
		memorySection(context.memory, true),
		lengthGuidance(context),
		`TASK (turn ${context.turnIndex})\n${context.task}`,
		`AGENT MESSAGES\n${context.agentMessages.join('\n---\n') || '(none)'}`,
		`EXPOSED REASONING SUMMARIES\n${context.reasoningSummaries.join('\n---\n') || '(none)'}`,
		`TOOL AND TEST OUTCOMES (cite ids as chart evidence)\n${toolSection(context.tools)}`,
		`PENDING CHECKS (still running; describe as pending, never as passed)\n${context.pending.map(check => `- ${check.label}`).join('\n') || '(none)'}`,
		context.userNotes.length ? `USER CHANGES (not made by the agent; do not explain them as the agent's work)\n${context.userNotes.join('\n')}` : '',
		`EARLIER TURNS (context only; explain only this turn)\n${context.history.join('\n') || '(none)'}`,
		context.chapter ? chapterSection(context.chapter) : '',
		`CAPTURED FILES${context.chapter && context.chapter.index > 1 ? ' (diffs are relative to the end of the previous chapter)' : ''}\n${fileSections}`,
	];
	if (previous) {
		sections.push(`YOUR EARLIER DRAFT (written while the agent was still working). Revise it so it matches the final captured changes above: drop scenes about work that was reverted or superseded, fix line numbers, add what is new.\n\`\`\`json\n${JSON.stringify(previous)}\n\`\`\``);
	}
	if (!context.final) {
		sections.push('The agent is still working; this is a draft that will be reconciled with the final changes.');
	}
	return sections.filter(Boolean).join('\n\n');
}

/**
 * The explainer's memory in a prompt, and the rule that goes with it: what memory says was explained or is
 * known isn't explained again. `canRemember`: the reply format has a `remember` field.
 */
export function memorySection(memory: string | undefined, canRemember: boolean): string {
	const use = canRemember
		? `Use it to avoid repeating yourself: don't explain again what these notes say you already explained or the developer already knows or asked about. At most refer back to it in a clause ("the same retry budget as before") and spend the time on what's new. If this change contradicts a note, say so.`
		// A question always gets its answer, even about something covered before.
		: `Use it for context: answer what they ask even if it was covered before, but connect to what they already know instead of re-teaching it, and don't repeat background these notes show they have.`;
	const save = canRemember
		? `\nAdd to it with "remember" (at most 3 short notes, only what will matter in later explanations): a concept you explained to them, so it isn't explained again; what they showed they know or don't ("personal"); a lasting fact about this project's design ("project"). Never save something these notes already say; to update a note, give its id in "replaces". Leave "remember" out when there's nothing new.`
		: '';
	return memory
		? `MEMORY (notes from earlier explanations, oldest first; ids in brackets)\n${memory}\n${use}${save}`
		: canRemember ? `MEMORY\n(empty)${save}` : '';
}

/** Asks the explainer to condense its memory once it has grown too long to keep passing in full. */
export function buildMemoryCondensePrompt(memory: string, size: number, target: number): string {
	return [
		`MEMORY CONDENSING. Your memory of this developer and project (below) is ${size} characters, too long to keep passing to every explanation. Rewrite it as fewer, shorter notes, under ${target} characters in total.`,
		`Keep everything that will change how you explain things later: what you've already explained to them (so it isn't explained again), what they know, don't know or keep asking about, how they like explanations, and lasting facts about the project's design. Merge duplicates and related notes, fold their individual questions into what they show about the developer, and drop notes that were superseded or no longer matter. Don't invent anything that isn't in the notes. Keep each note's scope: "personal" is about the developer across projects, "project" is about this codebase.`,
		`Reply with only JSON: {"notes": [{"scope": "personal"|"project", "note": string}]}`,
		`MEMORY (oldest first)\n${memory}`,
	].join('\n\n');
}

/** LENGTH: the explainer decides whether and how much to explain, from the profile and the change. */
function lengthGuidance(context: PlanningContext): string {
	return `LENGTH (your decision)
Decide how much this change deserves for this developer, from their profile, the size and kind of change, and how they asked:
- "skip": nothing here is worth their attention (mechanical, or entirely in areas they skim or know well). Give a one-line "reason".
- "note": one or two sentences are enough (a small, self-explanatory change). Put them in "note", a short "title", and in "at" the lines of the final version they're about (the note is also shown beside those lines). Write it to be read aloud: plain sentences, no markdown. The note appears right under the coding agent's own final message, so it must add something that message doesn't say for this developer (why it matters, a caveat, what to check). If it would only restate the agent's summary, choose "skip" with the reason "the agent's summary covers it".
- "walkthrough": as many scenes as the change needs for them, no more: one scene is fine for a focused change; a large or subtle change in an area they follow closely can take many. Never pad to reach a count, and don't give tests or routine follow-ups their own scenes unless they matter to this developer.
${context.preferNotes ? 'Lean toward "note" for small changes and short, specific requests: when the request names one specific change (for example "change the default to 8") and the diff does exactly that, plus tests or docs that confirm it, choose "note" unless something in it is surprising or touches what they follow closely. Tests that just confirm the change are worth a clause in the note, not a scene.' : ''}`.trim();
}

function chapterSection(chapter: NonNullable<PlanningContext['chapter']>): string {
	const earlier = chapter.earlier.map((entry, index) => `${index + 1}. ${entry.title}: ${entry.summary}`).join('\n');
	return `CHAPTER ${chapter.index}
This turn is long, so it is explained in chapters as the work progresses. Explain only the changes in the CAPTURED FILES below (since the previous chapter); don't repeat earlier chapters. If later work changed something an earlier chapter explained, say so briefly.${earlier ? `\nEarlier chapters:\n${earlier}` : ''}`;
}

export interface CheckpointContext {
	readonly profile: KnowledgeProfile;
	readonly task: string;
	readonly minutesSinceLastChapter: number;
	/** The agent's progress messages since the last chapter. */
	readonly progress: readonly string[];
	/** Per-file stats of what changed since the last chapter. */
	readonly files: ReadonlyArray<{ readonly path: string; readonly added: number; readonly removed: number }>;
	readonly tools: readonly ToolOutcome[];
	readonly earlierChapters: readonly string[];
	readonly preferNotes: boolean;
}

/** The cheap mid-turn question: is a finished piece of work ready for a chapter now, or wait? */
export function buildCheckpointPrompt(context: CheckpointContext): string {
	return [
		`CHAPTER CHECK. A coding agent is partway through a long task. You decide whether to explain the work done since the last chapter now, as its own chapter, or wait. Explain now only when a coherent piece of work is finished (for example its tests pass or a step is done) and it's worth this developer's attention; wait while the code is still taking shape, or if what changed is in areas they skim. The rest is explained when the task ends.`,
		`Reply with only JSON: {"decision": "chapter"|"wait", "reason": string}`,
		`DEVELOPER PROFILE\n${describeProfile(context.profile)}${context.preferNotes ? '\nThey prefer brief notes for small changes.' : ''}`,
		`TASK\n${context.task}`,
		`EARLIER CHAPTERS\n${context.earlierChapters.join('\n') || '(none)'}`,
		`SINCE THE LAST CHAPTER (${context.minutesSinceLastChapter} min)\nAgent progress:\n${context.progress.map(message => `- ${message.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n') || '(none)'}\nFiles changed:\n${context.files.map(file => `- ${file.path} (+${file.added} -${file.removed})`).join('\n') || '(none)'}\nCommands and tests:\n${context.tools.filter(tool => tool.command).map(tool => `- \`${tool.command}\` → ${tool.status}`).join('\n') || '(none)'}`,
	].join('\n\n');
}

export interface BriefingTurn {
	readonly task: string;
	readonly outcome: string;
	/** "Walkthrough: …", "Chapter 2: …", "Explained in a short note.", "Not explained: …". */
	readonly explanation: string;
	readonly summary?: string;
	readonly finalMessage?: string;
	readonly notes: readonly string[];
	readonly failedCommands: readonly string[];
	readonly pendingChecks: readonly string[];
	readonly files: ReadonlyArray<{ readonly path: string; readonly added: number; readonly removed: number }>;
}

export interface BriefingContext {
	readonly profile: KnowledgeProfile;
	readonly minutesAway: number;
	readonly turns: readonly BriefingTurn[];
	/** The task still running, with its latest progress. */
	readonly running?: { readonly task: string; readonly progress: readonly string[] };
	/** Approvals or questions waiting on the developer. */
	readonly waiting: readonly string[];
}

/** The return briefing: what happened while the developer was away, in a minute's reading. */
export function buildBriefingPrompt(context: BriefingContext): string {
	const turns = context.turns.map((turn, index) => [
		`${index + 1}. TASK: ${turn.task}`,
		`   outcome: ${turn.outcome}; explanation: ${turn.explanation}`,
		turn.summary ? `   walkthrough summary: ${turn.summary}` : '',
		turn.notes.length ? `   notes: ${turn.notes.join(' | ')}` : '',
		turn.finalMessage ? `   agent's final message: ${turn.finalMessage.replace(/\s+/g, ' ').slice(0, 600)}` : '',
		turn.failedCommands.length ? `   failed commands: ${turn.failedCommands.join(', ')}` : '',
		turn.pendingChecks.length ? `   checks still pending: ${turn.pendingChecks.join(', ')}` : '',
		turn.files.length ? `   files: ${turn.files.map(file => `${file.path} (+${file.added} -${file.removed})`).join(', ')}` : '',
	].filter(Boolean).join('\n')).join('\n');
	return [
		`RETURN BRIEFING. The developer was away for ${context.minutesAway} minutes while a coding agent worked. Write the short briefing they read when they come back: what got done that matters, what needs them, what's unresolved, and where to pick up. They can open the detailed walkthroughs separately, so don't retell them; one line per point, in plain words, at the level of their profile. Mention only what the material below supports. Leave a list empty rather than padding it.`,
		`Reply with only JSON: {"headline": string, "done": [string], "attention": [string], "problems": [string], "next": string}`,
		`DEVELOPER PROFILE\n${describeProfile(context.profile)}`,
		`WHAT HAPPENED (oldest first)\n${turns || '(no finished tasks)'}`,
		context.running ? `STILL RUNNING\nTASK: ${context.running.task}\nlatest progress: ${context.running.progress.join(' | ') || '(none)'}` : '',
		context.waiting.length ? `WAITING ON THE DEVELOPER\n${context.waiting.map(item => `- ${item}`).join('\n')}` : '',
	].filter(Boolean).join('\n\n');
}

export function buildRepairPrompt(errors: readonly string[]): string {
	return `The walkthrough JSON failed validation against the captured files:\n${errors.slice(0, 30).map(error => `- ${error}`).join('\n')}\nReply with the corrected complete JSON object only, in one \`\`\`json block.`;
}

/** Asks the read-only explanation session to re-explain one scene in greater depth. */
export function buildElaborationPrompt(walkthrough: Walkthrough, sceneId: string, profile: KnowledgeProfile, memory?: string): string {
	const scene = walkthrough.scenes.find(candidate => candidate.id === sceneId);
	const question = `MORE DETAIL: Re-explain "${scene?.title ?? 'this part'}" in greater depth than the walkthrough did. Go a level deeper: how the focused lines work step by step, why they are written this way, edge cases and what would break if they were different. Assume they understood the short version. Use 2-4 short paragraphs of plain spoken prose (it will be read aloud), no headings or bullet lists, and refer to code by name rather than pasting it.`;
	return buildQuestionPrompt(question, walkthrough, sceneId, profile, memory);
}

/** A question asked from a walkthrough card: answered beside the scene and read aloud, so it's spoken prose. */
export function buildSpokenQuestionPrompt(question: string, walkthrough: Walkthrough, sceneId: string, profile: KnowledgeProfile, memory?: string): string {
	return buildQuestionPrompt(`${question}\n\n(Answer in 1-3 short paragraphs of plain spoken prose; it will be read aloud. No headings, bullet lists or pasted code: refer to code by name.)`, walkthrough, sceneId, profile, memory);
}

export function buildQuestionPrompt(question: string, walkthrough: Walkthrough | undefined, sceneId: string | undefined, profile: KnowledgeProfile, memory?: string): string {
	const parts = [`You are answering a developer's question inside Active. You only read; never modify files. Answer conversationally and concisely in plain text (short code snippets are fine). Ground claims in the captured code; say so when something is not observed. You run in the live project, which may have changed since a walkthrough was captured: when they differ, the captured code below is what the walkthrough explained.`, `DEVELOPER PROFILE\n${describeProfile(profile)}`];
	const remembered = memorySection(memory, false);
	if (remembered) {
		parts.push(remembered);
	}
	if (walkthrough) {
		const scene = walkthrough.scenes.find(candidate => candidate.id === sceneId);
		parts.push(`CURRENT WALKTHROUGH: ${walkthrough.title} — ${walkthrough.summary}\nTask: ${walkthrough.task}\nScenes: ${walkthrough.scenes.map((candidate, index) => `${index + 1}. ${candidate.title}`).join('; ')}`);
		if (scene) {
			const file = walkthrough.files[scene.file];
			parts.push(`THE DEVELOPER PAUSED ON: "${scene.title}" (${scene.file})\nNarration: ${scene.narration.map(segment => segment.text).join(' ')}\nFocused code:\n${file ? scene.focus.map(range => numberedExcerpt({ ...file, final: scene.version === 'final' ? file.final : file.baseline }).split('\n').filter(line => {
				const number = Number(line.split('│')[0]);
				return number >= Math.max(1, range.startLine - 3) && number <= range.endLine + 3;
			}).join('\n')).join('\n…\n') : ''}`);
		}
		parts.push(`Captured files: ${Object.values(walkthrough.files).map(file => `${file.path} (+${file.added} -${file.removed})`).join(', ')}\n${Object.values(walkthrough.files).map(file => unifiedDiff(file.path, file.baseline, file.final)).join('\n').slice(0, 20000)}`);
	}
	parts.push(`QUESTION\n${question}`);
	return parts.join('\n\n');
}

/** A question about boxes and arrows the developer picked on the system map. */
/** A question about code the developer selected in the editor. */
export function buildCodeQuestionPrompt(question: string, code: CodeSelection, profile: KnowledgeProfile, memory?: string): string {
	const parts = [`You are answering a developer's question inside Active, about code they selected in the editor. You only read; never modify files. Answer conversationally and concisely in plain text (short code snippets are fine). Read the file around the selection (and what it calls or is called by, when that matters to the question) before answering, and ground claims in the code; say so when something is not observed. Name files with their paths so the developer can find them.`, `DEVELOPER PROFILE\n${describeProfile(profile)}`];
	const remembered = memorySection(memory, false);
	if (remembered) {
		parts.push(remembered);
	}
	parts.push(`THE SELECTION\n${code.file}, lines ${code.startLine}-${code.endLine}${code.text ? `:\n\`\`\`\n${code.text}\n\`\`\`` : ''}`);
	parts.push(`QUESTION\n${question}`);
	return parts.join('\n\n');
}

/**
 * The task the coding agent gets when the developer asked for a change while pointing at code (a selection, or an
 * explanation card): their words, then that code and what they were reading, as context. The change may be to that
 * code or somewhere else based on it, so it's offered as context, not as the place to edit.
 */
export function composeCodeTask(request: TaskRequest): string {
	const lines = [request.text.trim()];
	if (request.code) {
		const where = `${request.code.file}, lines ${request.code.startLine}-${request.code.endLine}`;
		lines.push('', `Context: the developer asked for this while looking at ${where}${request.explanation ? ' in Active\'s walkthrough (the file may have changed since)' : ''}. The change may be to that code or elsewhere based on it; use your judgment.`);
		if (request.code.text) {
			lines.push('```', request.code.text, '```');
		}
	}
	if (request.explanation) {
		lines.push('', `The explanation they were reading ("${request.explanation.title}"): ${request.explanation.text}`);
	}
	return lines.join('\n');
}

export function buildMapQuestionPrompt(question: string, map: SystemMap, selection: MapSelection, profile: KnowledgeProfile, memory?: string): string {
	const parts = [`You are answering a developer's question inside Active, about the system map: a diagram of the project's components and how they connect, kept by a diagram agent. You only read; never modify files. Answer conversationally and concisely in plain text (short code snippets are fine). Read the files the picked parts cite before answering, and ground claims in the code; say so when something is not observed. Name files with their paths so the developer can find them.`, `DEVELOPER PROFILE\n${describeProfile(profile)}`];
	const remembered = memorySection(memory, false);
	if (remembered) {
		parts.push(remembered);
	}
	const name = (id: string) => map.components.find(component => component.id === id)?.name ?? id;
	const refs = (files: ReadonlyArray<{ path: string; startLine?: number; endLine?: number }>) => files.map(ref => `${ref.path}${ref.startLine ? `:${ref.startLine}${ref.endLine && ref.endLine !== ref.startLine ? `-${ref.endLine}` : ''}` : ''}`).join(', ');
	const picked: string[] = [];
	for (const id of selection.components) {
		const component = map.components.find(candidate => candidate.id === id);
		if (component) {
			picked.push(`Component "${component.name}" (${component.id}): ${component.summary}\n  ${component.description}\n  Code: ${refs(component.files)}`);
		}
	}
	for (const link of selection.connections) {
		const connection = map.connections.find(candidate => candidate.from === link.from && candidate.to === link.to);
		if (connection) {
			picked.push(`Connection ${name(connection.from)} → ${name(connection.to)}: ${connection.label}${connection.detail ? `. ${connection.detail}` : ''}${connection.evidence.length ? `\n  Where: ${refs(connection.evidence)}` : ''}`);
		}
	}
	parts.push(`WHAT THE DEVELOPER PICKED ON THE MAP\n${picked.join('\n') || '(nothing that is still on the map)'}`);
	parts.push(`THE WHOLE MAP (for context)\n${map.overview}\nComponents: ${map.components.map(component => `${component.name} (${component.summary})`).join('; ')}\nConnections: ${map.connections.map(connection => `${name(connection.from)} → ${name(connection.to)} (${connection.label})`).join('; ')}`);
	parts.push(`QUESTION\n${question}`);
	return parts.join('\n\n');
}
