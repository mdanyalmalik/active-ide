/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { CapturedFile, LearningProfile, PendingCheck, ToolOutcome, Walkthrough, WalkthroughDraft } from '../shared/activeProtocol';
import { diffLines, splitLines, unifiedDiff } from '../tracking/lineDiff';

export interface PlanningContext {
	readonly task: string;
	readonly turnIndex: number;
	readonly profile: LearningProfile;
	readonly files: Readonly<Record<string, CapturedFile>>;
	readonly agentMessages: readonly string[];
	readonly reasoningSummaries: readonly string[];
	readonly tools: readonly ToolOutcome[];
	readonly pending: readonly PendingCheck[];
	readonly history: readonly string[];
	readonly userNotes: readonly string[];
	readonly final: boolean;
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

function familiarityList(items: LearningProfile['languages']): string {
	return items.length ? items.map(item => `${item.name} (${item.familiarity})`).join(', ') : 'not specified';
}

export function describeProfile(profile: LearningProfile): string {
	return [
		`Background: ${profile.background || 'not specified'} (${profile.yearsProgramming} years programming)`,
		`Languages: ${familiarityList(profile.languages)}`,
		`Concepts: ${familiarityList(profile.concepts)}`,
		`Wants to learn: ${profile.wantToLearn || 'not specified'}`,
		`Gloss over: ${profile.glossOver || 'not specified'}`,
		`Depth: ${profile.depth}. Mathematical notation: ${profile.math}.`,
		`Useful visuals: ${profile.preferredVisuals.join(', ') || 'any'}`,
		profile.notes ? `Notes: ${profile.notes}` : '',
	].filter(Boolean).join('\n');
}

const SCHEMA = `{
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

const TEACHING = `Teach like a strong coding video, one coherent idea per scene — never a chronological recital of edits:
1. Open with the problem or intuition (why this change exists).
2. When it helps, show a conceptual model (diagram, equation or chart) before the code.
3. Connect the model to the implementation: put the editor on the exact lines and say how they realize the idea.
4. Then explain behavior, evidence (tests, command results) and tradeoffs.
Use the same names for the same things in narration, diagram labels, equation symbols and code (declare them in "terms").
Pick the visual that explains best: "diff" when the before/after contrast matters, "code" for another relevant excerpt, "equation" for quantitative rules, "diagram" for flows/relationships, "chart" for numeric behavior. Omit the visual when the highlighted code is enough.
Narration is spoken aloud: plain sentences, no markdown, no code blocks, no line numbers; 1-3 sentences per segment; use cues so the visual changes in step with the words.
Ground every implementation claim in the captured code and tool results. Anything not observed (example timings, hypothetical callers) must be framed as an example in the narration and marked "illustrative": true / "source": "illustrative".
Never say a check passed unless a tool outcome shows it. Mention pending checks as still running.`;

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
		`You are the explanation planner inside Active, an IDE that narrates what a coding agent just did. You only read; you never modify files. The working directory is a read-only snapshot of the project; you may read other files for context.`,
		`Produce a walkthrough of this turn's code change for the learner below as a single JSON object matching this schema (reply with only the JSON in one \`\`\`json block):\n${SCHEMA}`,
		TEACHING,
		`LEARNER PROFILE\n${describeProfile(context.profile)}\nAdapt concept selection, detail, vocabulary and pacing to this profile: skip what they want glossed over, spend scenes on what they want to learn. ${context.profile.math === 'avoid' ? 'Avoid equations.' : ''} Aim for ${context.profile.depth === 'overview' ? '3-4' : context.profile.depth === 'deep' ? '6-9' : '4-6'} scenes.`,
		`TASK (turn ${context.turnIndex})\n${context.task}`,
		`AGENT MESSAGES\n${context.agentMessages.join('\n---\n') || '(none)'}`,
		`EXPOSED REASONING SUMMARIES\n${context.reasoningSummaries.join('\n---\n') || '(none)'}`,
		`TOOL AND TEST OUTCOMES (cite ids as chart evidence)\n${toolSection(context.tools)}`,
		`PENDING CHECKS (still running; describe as pending, never as passed)\n${context.pending.map(check => `- ${check.label}`).join('\n') || '(none)'}`,
		context.userNotes.length ? `USER CHANGES (not made by the agent; do not explain them as the agent's work)\n${context.userNotes.join('\n')}` : '',
		`EARLIER TURNS (context only; explain only this turn)\n${context.history.join('\n') || '(none)'}`,
		`CAPTURED FILES\n${fileSections}`,
	];
	if (previous) {
		sections.push(`YOUR EARLIER DRAFT (written while the agent was still working). Revise it so it matches the final captured changes above: drop scenes about work that was reverted or superseded, fix line numbers, add what is new.\n\`\`\`json\n${JSON.stringify(previous)}\n\`\`\``);
	}
	if (!context.final) {
		sections.push('The agent is still working; this is a draft that will be reconciled with the final changes.');
	}
	return sections.filter(Boolean).join('\n\n');
}

export function buildRepairPrompt(errors: readonly string[]): string {
	return `The walkthrough JSON failed validation against the captured files:\n${errors.slice(0, 30).map(error => `- ${error}`).join('\n')}\nReply with the corrected complete JSON object only, in one \`\`\`json block.`;
}

export function buildQuestionPrompt(question: string, walkthrough: Walkthrough | undefined, sceneId: string | undefined, profile: LearningProfile): string {
	const parts = [`You are answering a learner's question inside Active. You only read; never modify files. Answer conversationally and concisely in plain text (short code snippets are fine). Ground claims in the captured code; say so when something is not observed.`, `LEARNER PROFILE\n${describeProfile(profile)}`];
	if (walkthrough) {
		const scene = walkthrough.scenes.find(candidate => candidate.id === sceneId);
		parts.push(`CURRENT WALKTHROUGH: ${walkthrough.title} — ${walkthrough.summary}\nTask: ${walkthrough.task}\nScenes: ${walkthrough.scenes.map((candidate, index) => `${index + 1}. ${candidate.title}`).join('; ')}`);
		if (scene) {
			const file = walkthrough.files[scene.file];
			parts.push(`THE LEARNER PAUSED ON: "${scene.title}" (${scene.file})\nNarration: ${scene.narration.map(segment => segment.text).join(' ')}\nFocused code:\n${file ? scene.focus.map(range => numberedExcerpt({ ...file, final: scene.version === 'final' ? file.final : file.baseline }).split('\n').filter(line => {
				const number = Number(line.split('│')[0]);
				return number >= Math.max(1, range.startLine - 3) && number <= range.endLine + 3;
			}).join('\n')).join('\n…\n') : ''}`);
		}
		parts.push(`Captured files: ${Object.values(walkthrough.files).map(file => `${file.path} (+${file.added} -${file.removed})`).join(', ')}\n${Object.values(walkthrough.files).map(file => unifiedDiff(file.path, file.baseline, file.final)).join('\n').slice(0, 20000)}`);
	}
	parts.push(`QUESTION\n${question}`);
	return parts.join('\n\n');
}
