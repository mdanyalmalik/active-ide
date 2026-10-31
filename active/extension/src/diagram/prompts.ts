/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { SystemMap } from '../shared/activeProtocol';

/** One changed file, as the diagram agent is told about it. */
export interface DiagramFileChange {
	readonly path: string;
	readonly added: number;
	readonly removed: number;
	readonly created?: boolean;
	readonly deleted?: boolean;
	/** Import/export/dependency lines that appeared or disappeared (the structural part of the change). */
	readonly dependencyLines?: { readonly added: readonly string[]; readonly removed: readonly string[] };
}

const ROLE = `You are the diagram agent in Active, an IDE where a coding agent writes the code. You keep a system map of the project: its parts and how they connect, so the developer can see the shape of the system as it changes. You work read-only: you can read files and search the project. Read the code rather than guessing.`;

const MAP_RULES = `What makes a good map:
- One consistent level of detail: each component is a cohesive part with one clear responsibility (a module, service, layer, store, UI, CLI entry point...), named for what it does. Group by responsibility, not by folder, and don't make a box per small file unless the project really is that small.
- As many components as the system's structure calls for, no more: a newcomer should be able to take the map in, and every box should earn its place.
- External things the code talks to (a database, a web API, the file system, the user at a terminal) can be components when the code clearly uses them; cite the file that talks to them.
- Connections point from the part that calls, uses or sends to the part that is called, used or receives. Label them with what flows, in a few words ("reads accounts", "emits events", "HTTP requests"). Merge parallel connections between the same two components into one.
- Every component cites the files it lives in (paths relative to the project root, optionally with line ranges and a few words on each). Every connection cites where in the code it's made (the import, call or request), with lines when you can.
- The description says what the component is responsible for and how it works, for someone about to read its code: two to five sentences, plain language.
- The overview is one or two sentences on what the whole system does.`;

const MAP_SCHEMA = `{
  "overview": "...",
  "components": [
    { "id": "short-stable-id", "name": "Name", "summary": "One line shown in the box", "description": "...", "files": [{ "path": "src/x.ts", "startLine": 1, "endLine": 40, "why": "..." }] }
  ],
  "connections": [
    { "from": "id", "to": "id", "label": "what flows", "detail": "one or two sentences", "evidence": [{ "path": "src/x.ts", "startLine": 12, "endLine": 12 }] }
  ]
}`;

/** Changes the developer asked for earlier, which every later map should keep (unless the code no longer supports them). */
function requestsSection(requests: readonly string[]): string {
	return requests.length
		? `\n\nThe developer asked for these changes to the map earlier. Keep honoring them unless the code no longer supports them:\n${requests.map(request => `- ${request}`).join('\n')}`
		: '';
}

/** The first map of a project: survey it and describe its parts. */
export function buildDiagramSurveyPrompt(files: readonly string[], truncated: boolean, requests: readonly string[] = []): string {
	return `${ROLE}

SYSTEM MAP SURVEY

Build the first system map of this project. Start from the entry points, manifests and README, read enough of the code to know what each part does and how the parts depend on each other, then answer.

${MAP_RULES}${requestsSection(requests)}

The project's files${truncated ? ' (the first ones; search for more)' : ''}:
${files.map(file => `- ${file}`).join('\n')}

Answer with only this JSON:
${MAP_SCHEMA}`;
}

/**
 * At a checkpoint or the end of a turn: does the map need to change? A small edit inside a component doesn't;
 * a new part, a removed one, a responsibility moving, or a new or removed dependency does.
 */
export function buildDiagramUpdatePrompt(map: SystemMap, task: string, changes: readonly DiagramFileChange[], progress: readonly string[], final: boolean, requests: readonly string[] = []): string {
	const changeLines = changes.map(change => {
		const kind = change.created ? 'new file' : change.deleted ? 'deleted' : `+${change.added} −${change.removed}`;
		const deps = change.dependencyLines && (change.dependencyLines.added.length || change.dependencyLines.removed.length)
			? `\n    dependencies added: ${change.dependencyLines.added.join(' | ') || 'none'}\n    dependencies removed: ${change.dependencyLines.removed.join(' | ') || 'none'}`
			: '';
		return `- ${change.path} (${kind})${deps}`;
	});
	return `${ROLE}

SYSTEM MAP UPDATE

The coding agent ${final ? 'just finished' : 'is in the middle of'} this task: ${task}
${progress.length ? `\nWhat it has said so far:\n${progress.slice(-4).map(line => `- ${line.slice(0, 300)}`).join('\n')}\n` : ''}
Files it has changed${final ? '' : ' so far'}:
${changeLines.join('\n')}

The current map:
${JSON.stringify(map, null, 1)}

Decide whether the map needs to change. Read the changed files if you need to. Edits inside a component's existing files that don't change what it does or what it depends on leave the map as it is. A new part, a removed one, a responsibility moving, or a dependency appearing or disappearing changes it.${final ? '' : ' The work is unfinished: only change the map for structure that is clearly in place.'}

${MAP_RULES}${requestsSection(requests)}

If nothing needs to change, answer with only: {"update": false, "reason": "..."}
If it does, answer with only: {"update": true, "reason": "one sentence for the developer on what changed in the system", "changed": ["ids of components added or changed"], "map": <the whole updated map>}
Keep the ids (and names, unless they're now wrong) of components that are still there, so the diagram stays recognizable. The map has this shape:
${MAP_SCHEMA}`;
}

/** The developer asked to check now: compare the map with the code as it is. */
export function buildDiagramRecheckPrompt(map: SystemMap, requests: readonly string[] = []): string {
	return `${ROLE}

SYSTEM MAP UPDATE

The developer asked you to check the map against the code as it is now. Look at the files the components cite and anything new in the project, and decide whether the map is still right.

The current map:
${JSON.stringify(map, null, 1)}

${MAP_RULES}${requestsSection(requests)}

If nothing needs to change, answer with only: {"update": false, "reason": "..."}
If it does, answer with only: {"update": true, "reason": "one sentence on what changed", "changed": ["ids"], "map": <the whole updated map>}
Keep the ids of components that are still there. The map has this shape:
${MAP_SCHEMA}`;
}

/** The developer described how they want the map changed. */
export function buildDiagramEditPrompt(map: SystemMap, request: string, earlier: readonly string[] = []): string {
	return `${ROLE}

SYSTEM MAP EDIT

The developer wants the map changed. In their words:
${request}

The current map:
${JSON.stringify(map, null, 1)}

Make the change they describe: split, merge, rename, regroup, add or remove components or connections, change the level of detail, or rewrite descriptions. Read the code where you need to. The map must still describe the real code: every component cites files that exist, and every connection is one the code really makes. If part of the request can't be true to the code (a component with no code behind it, a connection that doesn't exist), do the closest faithful thing and say what you did instead. Where a box sits on the screen isn't part of the map: if they ask to move boxes, say they can drag them.

${MAP_RULES}${requestsSection(earlier)}

Your reason is shown to the developer as your reply, so write it to them: one or two sentences on what you changed (or why you didn't).
If you change the map, answer with only: {"update": true, "reason": "...", "changed": ["ids of components added or changed"], "map": <the whole updated map>}
If you can't or shouldn't change it (the request is unclear, or the map already shows this), answer with only: {"update": false, "reason": "..."}
Keep the ids (and names, unless the request changes them) of components that stay. The map has this shape:
${MAP_SCHEMA}`;
}

/** Sends a map back with what was wrong with it. */
export function buildDiagramRepairPrompt(errors: readonly string[]): string {
	return `SYSTEM MAP REPAIR

Your map had these problems:
${errors.slice(0, 20).map(error => `- ${error}`).join('\n')}

Fix them (check paths against the project) and answer again with only the corrected JSON, in the same shape as before.`;
}
