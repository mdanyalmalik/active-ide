#!/usr/bin/env node
// Copyright (c) Active contributors. Licensed under the MIT License.
//
// TEST DOUBLE — NOT MUSE CODE.
//
// A scripted host that speaks the Muse Session Protocol (MSP v1) over stdio so
// Active's integration tests and UI checks can run end to end without a Muse
// Code subscription. It replays a scenario file: the "coding" session performs
// real file edits and shell commands in the workspace; the "explanation"
// session answers with a walkthrough template from the scenario whose line
// references are resolved against the captured files in the prompt.
//
// Active never uses this unless `active.muse.binaryPath` points at it
// (see scripts/run-scripted-demo.sh); the UI then shows the host as
// "scripted-muse-host (test double)".
//
// Usage: scripted-muse-host.mjs serve   (scenario path in ACTIVE_SCRIPTED_SCENARIO)

import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';

if (process.argv[2] !== 'serve') {
	process.stderr.write('usage: scripted-muse-host.mjs serve\n');
	process.exit(2);
}

const scenarioPath = process.env.ACTIVE_SCRIPTED_SCENARIO;
if (!scenarioPath) {
	process.stderr.write('ACTIVE_SCRIPTED_SCENARIO is not set\n');
	process.exit(2);
}
const scenario = JSON.parse(readFileSync(scenarioPath, 'utf8'));
const speed = Number(process.env.ACTIVE_SCRIPTED_SPEED ?? '1');
// Tests of the coding agent's debug tools: record the MCP server Active gave this host, so a probe can call it.
if (process.env.ACTIVE_SCRIPTED_MCP_FILE && process.argv.some(arg => arg.startsWith('mcpServers.'))) {
	writeFileSync(process.env.ACTIVE_SCRIPTED_MCP_FILE, JSON.stringify({ args: process.argv.slice(2), auth: process.env.ACTIVE_MCP_AUTH ?? null }));
}

let cursor = 0;
const nextCursor = () => `v1:scripted:${++cursor}`;
const sessions = new Map();
const pendingApprovals = new Map();

function send(message) {
	process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
}
function notify(method, params) {
	send({ method, params: { ...params, viewCursor: nextCursor() } });
}
function sleep(ms) {
	return new Promise(resolve => setTimeout(resolve, ms / speed));
}

function item(session, turnId, kind, fields) {
	return { itemId: randomUUID(), turnId, kind, status: 'inProgress', revision: 1, ...fields };
}

async function streamMessage(session, turnId, text, phase) {
	const message = item(session, turnId, 'agentMessage', { text: '', messagePhase: phase });
	notify('item/started', { sessionId: session.id, item: message });
	const words = text.split(/(\s+)/);
	let acc = '';
	for (let i = 0; i < words.length; i += 6) {
		const delta = words.slice(i, i + 6).join('');
		acc += delta;
		notify('item/delta', { sessionId: session.id, itemId: message.itemId, field: 'text', delta });
		await sleep(30);
	}
	notify('item/completed', { sessionId: session.id, item: { ...message, text: acc, status: 'completed', revision: 2 } });
}

function resolveTemplate(value, files) {
	// Replace {"find": "text", "file": "path", "end"?: "text"} markers with line numbers in the captured final files.
	if (Array.isArray(value)) {
		return value.map(entry => resolveTemplate(entry, files));
	}
	if (value && typeof value === 'object') {
		if (typeof value.find === 'string') {
			const lines = files[value.file] ?? [];
			const start = lines.findIndex(line => line.includes(value.find)) + 1;
			let end = start;
			if (typeof value.end === 'string') {
				end = lines.findIndex((line, index) => index >= start - 1 && line.includes(value.end)) + 1;
			}
			if (value.as === 'line') {
				return start;
			}
			return { startLine: Math.max(1, start), endLine: Math.max(start, end, 1) };
		}
		const out = {};
		for (const [key, entry] of Object.entries(value)) {
			out[key] = resolveTemplate(entry, files);
		}
		return out;
	}
	return value;
}

/** Parses the numbered FINAL VERSION blocks Active puts in planning prompts. */
function capturedFiles(prompt) {
	const files = {};
	const sections = prompt.split(/\n### /).slice(1);
	for (const section of sections) {
		const name = section.slice(0, section.indexOf(' ('));
		const body = section.split('FINAL VERSION')[1] ?? '';
		const lines = [];
		for (const line of body.split('\n')) {
			const match = /^\s*(\d+)│ ?(.*)$/.exec(line);
			if (match) {
				lines[Number(match[1]) - 1] = match[2];
			}
		}
		files[name] = lines.map(line => line ?? '');
	}
	return files;
}

async function runExplanation(session, turnId, prompt) {
	await sleep(400);
	let reply;
	if (prompt.startsWith('You are answering')) {
		const question = prompt.split('QUESTION\n')[1] ?? '';
		const scene = /THE DEVELOPER PAUSED ON: "([^"]+)"/.exec(prompt)?.[1];
		const template = scenario.answers?.find(answer => question.toLowerCase().includes(answer.match));
		const picked = /WHAT THE DEVELOPER PICKED ON THE MAP\n([\s\S]*?)\n\nTHE WHOLE MAP/.exec(prompt)?.[1];
		if (picked) {
			// A question from the system map: say what was picked, so tests can see it arrived (this is a test double).
			const parts = [...picked.matchAll(/^(?:Component "([^"]+)"|Connection ([^:]+):)/gm)].map(match => match[1] ?? match[2]);
			reply = `On the map you picked ${parts.join(', ')}. ${picked.match(/Code: ([^\n]+)/)?.[1] ? `The code is in ${picked.match(/Code: ([^\n]+)/)[1]}.` : ''}`.trim();
		} else if (question.startsWith('MORE DETAIL:')) {
			// A deeper pass over the scene, assembled from what the prompt shows (this is a test double).
			const narration = /\nNarration: ([^\n]+)/.exec(prompt)?.[1] ?? '';
			const code = (/\nFocused code:\n([\s\S]*?)\n\nCaptured files:/.exec(prompt)?.[1] ?? '').split('\n').map(line => line.split('│')[1]?.trim()).filter(Boolean);
			const names = [...new Set(code.join(' ').match(/\b[A-Za-z_]\w{3,}(?=\s*\()/g) ?? [])].slice(0, 3);
			reply = [
				`Let's slow down on ${scene ? `"${scene}"` : 'this part'}. The short version was: ${narration}`,
				`Step by step, the focused lines ${names.length ? `lean on ${names.join(', ')}` : 'do one small job each'}: each line takes the value the previous one produced and narrows it, so by the end only the case the change cares about is left. That ordering matters, because swapping two of these steps would let an unchecked value through.`,
				'The edge cases are where this earns its keep: empty input, a value at exactly the limit, and a call that arrives before anything has been set up. Each one falls through to the same guarded path instead of needing its own branch.',
			].join('\n\n');
		} else {
			reply = template?.text ?? `About ${scene ? `"${scene}"` : 'this change'}: ${scenario.defaultAnswer ?? 'the captured code shows how the change works.'}`;
		}
	} else if (prompt.includes('SYSTEM MAP SURVEY') || prompt.includes('SYSTEM MAP UPDATE') || prompt.startsWith('SYSTEM MAP REPAIR')) {
		// The diagram agent: a map read from the project's files and imports (this is a test double).
		await sleep(1500);
		const map = deriveSystemMap(session.workspaceRoot);
		if (prompt.includes('SYSTEM MAP UPDATE')) {
			const current = /The current map:\n([\s\S]*?)\n\n(?:Decide|What makes)/.exec(prompt)?.[1];
			let before = [];
			try {
				before = JSON.parse(current ?? '{}').components ?? [];
			} catch {
				before = [];
			}
			const known = before.map(component => component.id);
			const filesOf = component => (component?.files ?? []).map(file => file.path).sort().join();
			const added = map.components.filter(component => !known.includes(component.id)).map(component => component.id);
			const removed = known.filter(id => !map.components.some(component => component.id === id));
			const moved = map.components.filter(component => known.includes(component.id) && filesOf(component) !== filesOf(before.find(old => old.id === component.id))).map(component => component.id);
			const parts = [added.length && `Added ${added.join(', ')}`, removed.length && `removed ${removed.join(', ')}`, moved.length && `${moved.join(', ')} now covers different files`].filter(Boolean);
			reply = JSON.stringify(parts.length
				? { update: true, reason: `${parts.join('; ')}.`, changed: [...added, ...moved], map }
				: { update: false, reason: 'scripted: no new or removed parts' });
		} else {
			reply = JSON.stringify(map);
		}
	} else if (prompt.includes('\nCODE TRACE\n') || prompt.startsWith('CODE TRACE REPAIR')) {
		// A code trace (this is a test double): a saved reply when ACTIVE_SCRIPTED_TRACE_FILE names one (e.g. a real
		// model's trace, to observe it in a window), otherwise the demo's duration parsing, run by its test.
		await sleep(1200);
		// With ACTIVE_SCRIPTED_TRACE_DIR, a question containing [fixture:name] replays <dir>/name.json.
		const fixture = /\[fixture:([\w-]+)\]/.exec(prompt)?.[1];
		const saved = fixture && process.env.ACTIVE_SCRIPTED_TRACE_DIR ? `${process.env.ACTIVE_SCRIPTED_TRACE_DIR}/${fixture}.json` : process.env.ACTIVE_SCRIPTED_TRACE_FILE;
		if (saved && existsSync(saved)) {
			reply = readFileSync(saved, 'utf8');
		} else {
			reply = JSON.stringify({
				title: 'Parsing a duration like "30s"',
				overview: 'The test calls parseDuration, which matches the text against a seconds pattern and converts the number to milliseconds.',
				steps: [
					{ file: 'test/duration.test.js', startLine: 5, endLine: 7, symbol: 'test: parses seconds', summary: 'The test asks parseDuration to read "30s".', hop: { kind: 'call', label: "parseDuration('30s')" }, probe: { line: 6, values: [] } },
					{ file: 'src/duration.js', startLine: 2, endLine: 6, symbol: 'parseDuration', summary: 'Matches the trimmed text against a number followed by "s"; anything else throws.', hop: { kind: 'return', label: 'returns milliseconds' }, probe: { line: 3, values: ['text'] } },
					{ file: 'src/duration.js', startLine: 7, endLine: 7, symbol: 'parseDuration', summary: 'Turns the captured number into milliseconds.', probe: { line: 7, values: ['match[1]'] } },
				],
				run: { command: 'node --test test/duration.test.js', why: 'the duration test runs exactly this path' },
			});
		}
	} else if (prompt.includes('SYSTEM MAP EDIT')) {
		// A change the developer described (this is a test double): "rename X to Y" renames a component; "merge X and Y"
		// folds Y into X; anything else is declined with a reason.
		await sleep(1500);
		const request = /In their words:\n([\s\S]*?)\n\nThe current map:/.exec(prompt)?.[1] ?? '';
		let map;
		try {
			map = JSON.parse(/The current map:\n([\s\S]*?)\n\nMake the change/.exec(prompt)?.[1] ?? '{}');
		} catch {
			map = undefined;
		}
		// Like a model reading the project, drop citations of files that no longer exist.
		const exists = file => existsSync(path.join(session.workspaceRoot, file.path));
		if (map) {
			map.components = map.components.map(component => ({ ...component, files: component.files.filter(exists) })).filter(component => component.files.length);
			map.connections = map.connections.filter(connection => map.components.some(c => c.id === connection.from) && map.components.some(c => c.id === connection.to)).map(connection => ({ ...connection, evidence: (connection.evidence ?? []).filter(exists) }));
		}
		const find = name => map?.components.find(component => [component.id, component.name].some(value => value.toLowerCase() === name.trim().toLowerCase()));
		const rename = /rename\s+(.+?)\s+to\s+(.+)/i.exec(request);
		const merge = /merge\s+(.+?)\s+(?:and|into|with)\s+(.+)/i.exec(request);
		if (rename && find(rename[1])) {
			const target = find(rename[1]);
			const name = rename[2].replace(/["'.]/g, '').trim();
			target.name = name;
			reply = JSON.stringify({ update: true, reason: `Renamed ${rename[1].trim()} to ${name}.`, changed: [target.id], map });
		} else if (merge && find(merge[1]) && find(merge[2])) {
			const keep = find(merge[1]);
			const fold = find(merge[2]);
			keep.files = [...keep.files, ...fold.files];
			keep.description = `${keep.description} It also covers what ${fold.name} did.`;
			map.components = map.components.filter(component => component !== fold);
			map.connections = map.connections
				.map(connection => ({ ...connection, from: connection.from === fold.id ? keep.id : connection.from, to: connection.to === fold.id ? keep.id : connection.to }))
				.filter((connection, index, all) => connection.from !== connection.to && all.findIndex(other => other.from === connection.from && other.to === connection.to) === index);
			reply = JSON.stringify({ update: true, reason: `Merged ${fold.name} into ${keep.name}.`, changed: [keep.id], map });
		} else {
			reply = JSON.stringify({ update: false, reason: "scripted: I can only rename (\"rename X to Y\") or merge (\"merge X and Y\") in this test." });
		}
	} else if (prompt.startsWith('MEMORY CONDENSING')) {
		// A deterministic stand-in: one note per scope saying how many notes it merged.
		const notes = [...prompt.matchAll(/^- \[m\d+\] \((personal|project)[^)]*\) /gm)].map(match => match[1]);
		const scopes = [...new Set(notes)];
		reply = JSON.stringify({ notes: scopes.map(scope => ({ scope, note: `Condensed ${notes.filter(entry => entry === scope).length} ${scope} notes.` })) });
	} else if (prompt.startsWith('RETURN BRIEFING')) {
		const tasks = [...prompt.matchAll(/^\d+\. TASK: (.+)$/gm)].map(match => match[1]);
		reply = JSON.stringify({ headline: `${tasks.length} tasks finished while you were away`, done: tasks.map(task => `Done: ${task}`), attention: [], problems: [], next: 'Start with the latest walkthrough.' });
	} else if (prompt.startsWith('CHAPTER CHECK')) {
		// ACTIVE_SCRIPTED_CHAPTERS makes the explainer explain finished work mid-turn.
		reply = JSON.stringify({ decision: process.env.ACTIVE_SCRIPTED_CHAPTERS ? 'chapter' : 'wait', reason: 'scripted' });
	} else if (prompt.startsWith('The walkthrough JSON failed validation')) {
		reply = '```json\n{}\n```';
	} else if (!scenario.turns.find(turn => (/TASK \(turn \d+\)\n([^\n]+)/.exec(prompt)?.[1] ?? '').includes(turn.match))?.walkthrough) {
		// Tasks without a scripted walkthrough get the explainer's brief answer (a note, or a skip).
		const entry = scenario.turns.find(turn => (/TASK \(turn \d+\)\n([^\n]+)/.exec(prompt)?.[1] ?? '').includes(turn.match));
		reply = JSON.stringify(entry?.note ? { format: 'note', note: entry.note, reason: 'scripted' } : { format: 'skip', reason: 'nothing here needs a walkthrough' });
	} else {
		const task = /TASK \(turn \d+\)\n([^\n]+)/.exec(prompt)?.[1] ?? '';
		const entry = scenario.turns.find(turn => task.includes(turn.match));
		const files = capturedFiles(prompt);
		const walkthrough = resolveTemplate(entry?.walkthrough ?? {}, files);
		const pending = /PENDING CHECKS[^\n]*\n((?:- [^\n]+\n)+)/.exec(prompt);
		if (pending && walkthrough.scenes) {
			const labels = pending[1].trim().split('\n').map(line => line.slice(2));
			const last = walkthrough.scenes[walkthrough.scenes.length - 1];
			last.pending = labels;
		}
		reply = `\`\`\`json\n${JSON.stringify(walkthrough, null, 2)}\n\`\`\``;
	}
	await streamMessage(session, turnId, reply, 'finalAnswer');
	notify('turn/completed', { sessionId: session.id, turnId, terminal: 'completed', durationMs: 500, sourceRange: { start: 0, end: 0 } });
}

async function runCoding(session, turnId, text) {
	const entry = scenario.turns.find(turn => text.includes(turn.match));
	if (!entry) {
		await streamMessage(session, turnId, scenario.unknownTaskReply ?? 'This scripted host has no scenario for that task.', 'finalAnswer');
		notify('turn/completed', { sessionId: session.id, turnId, terminal: 'completed', sourceRange: { start: 0, end: 0 } });
		return;
	}
	const steps = entry.steps;
	for (let index = 0; index < steps.length; index++) {
		if (session.cancelled.has(turnId)) {
			notify('turn/completed', { sessionId: session.id, turnId, terminal: 'cancelled', sourceRange: { start: 0, end: 0 } });
			return;
		}
		const step = steps[index];
		const root = session.workspaceRoot;
		switch (step.type) {
			case 'message':
				// ACTIVE_SCRIPTED_PAUSE_BEFORE_FINAL_MS: the agent keeps working a while before its final answer.
				if (step.phase === 'finalAnswer' && process.env.ACTIVE_SCRIPTED_PAUSE_BEFORE_FINAL_MS) {
					await new Promise(resolve => setTimeout(resolve, Number(process.env.ACTIVE_SCRIPTED_PAUSE_BEFORE_FINAL_MS)));
				}
				await streamMessage(session, turnId, step.text, step.phase ?? 'commentary');
				break;
			case 'reasoning': {
				const reasoning = item(session, turnId, 'reasoning', { summary: [step.summary] });
				notify('item/completed', { sessionId: session.id, item: { ...reasoning, status: 'completed' } });
				break;
			}
			case 'edit': {
				const target = path.join(root, step.path);
				const call = item(session, turnId, 'toolCall', { tool: 'edit_file', args: JSON.stringify({ path: step.path }), displayLabel: { active: `Editing ${step.path}`, done: `Edited ${step.path}`, neutral: `Edit ${step.path}` } });
				notify('item/started', { sessionId: session.id, item: call });
				await sleep(step.ms ?? 250);
				if (step.delete) {
					rmSync(target, { force: true });
				} else {
					mkdirSync(path.dirname(target), { recursive: true });
					writeFileSync(target, step.content);
				}
				notify('item/completed', { sessionId: session.id, item: { ...call, status: 'completed', revision: 2 } });
				break;
			}
			case 'shell': {
				const call = item(session, turnId, 'toolCall', { tool: 'shell', args: JSON.stringify({ command: step.command }) });
				notify('item/started', { sessionId: session.id, item: call });
				if (step.background) {
					notify('item/updated', { sessionId: session.id, item: { ...call, background: true, revision: 2 } });
					const task = { taskId: call.itemId, command: step.command, tool: 'shell' };
					session.tasks.set(call.itemId, task);
					setTimeout(() => {
						session.tasks.delete(call.itemId);
						notify('item/completed', { sessionId: session.id, item: { ...call, status: 'completed', background: true, visibleOutput: step.output ?? '', revision: 3 } });
						const done = item(session, null, 'backgroundTerminalCompletion', { backgroundTerminalCompletion: { command: step.command, output: step.output ?? '', outputTruncated: false, terminalStatus: 'completed', toolCallId: call.itemId } });
						notify('item/completed', { sessionId: session.id, item: { ...done, status: 'completed' } });
					}, (step.durationMs ?? 30000) / speed);
				} else {
					let output = step.output ?? '';
					if (step.run) {
						try {
							output = execSync(step.command, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
						} catch (error) {
							output = `${error.stdout ?? ''}${error.stderr ?? ''}`;
						}
					}
					await sleep(step.ms ?? 400);
					notify('item/completed', { sessionId: session.id, item: { ...call, status: 'completed', visibleOutput: output, revision: 2 } });
				}
				break;
			}
			case 'approval': {
				const call = item(session, turnId, 'toolCall', { tool: 'shell', args: JSON.stringify({ command: step.command }) });
				notify('item/started', { sessionId: session.id, item: call });
				const approvalId = randomUUID();
				const decided = new Promise(resolve => pendingApprovals.set(approvalId, resolve));
				notify('approval/requested', {
					sessionId: session.id, approvalId, itemId: call.itemId, turnId, taskId: call.itemId, toolCallId: call.itemId, toolName: 'shell',
					rawArgs: JSON.stringify({ command: step.command }), judgeEscalated: false, protectedWrite: false,
					subject: { kind: 'shell', command: step.command },
					currentRequirementId: { approvalId, sourceIndex: 0 },
					availableChoices: [
						{ choiceId: 'allow_once', label: 'Allow once', decision: 'approved', scope: 'once' },
						{ choiceId: 'reject', label: 'Reject', decision: 'denied', scope: 'once' },
					],
					sourceRange: { start: 0, end: 0 },
				});
				const choice = await decided;
				notify('approval/resolved', { sessionId: session.id, approvalId, decision: choice === 'allow_once' ? 'approved' : 'denied' });
				notify('item/completed', { sessionId: session.id, item: { ...call, status: choice === 'allow_once' ? 'completed' : 'rejected', revision: 2 } });
				break;
			}
			case 'wait':
				await sleep(step.ms);
				break;
		}
	}
	notify('turn/completed', { sessionId: session.id, turnId, terminal: 'completed', durationMs: 1000, sourceRange: { start: 0, end: 0 } });
}

const input = readline.createInterface({ input: process.stdin });
input.on('line', line => {
	if (!line.trim()) {
		return;
	}
	const message = JSON.parse(line);
	const { id, method, params = {} } = message;
	const reply = result => send({ id, result });
	switch (method) {
		case 'initialize':
			// Real Muse Code rejects client names that aren't machine identifiers (SS1.4.1).
			if (!/^[a-z0-9_]+$/.test(params.clientInfo?.name ?? '')) {
				send({ id, error: { code: -32602, message: 'invalid initialize params: clientInfo.name must be a machine identifier matching ^[a-z0-9_]+$ (SS1.4.1)', data: { kind: 'invalidParams', retryable: false } } });
				break;
			}
			reply({
				serverInfo: { name: 'scripted-muse-host (test double)', version: '0.0.0' },
				userAgent: 'scripted-muse-host/0.0.0', museHome: '/tmp/scripted-muse', platformFamily: 'unix', platformOs: process.platform,
				schema: { version: 1, fingerprint: 'sha256:scripted' }, grantedCapabilities: [], experimentalApi: false, sessionDurability: 'ephemeral',
			});
			break;
		case 'initialized':
			break;
		case 'session/start': {
			const readOnly = params.permissionProfile === ':read-only';
			// Like real Muse Code, only catalog ids are accepted (`:read-only` is the built-in read-only profile).
			if (params.permissionProfile && (params.permissionProfile !== ':read-only' || process.env.ACTIVE_SCRIPTED_NO_READ_ONLY)) {
				send({ id, error: { code: -32030, message: 'permission_profile_unknown', data: { kind: 'commandRejected', retryable: false } } });
				break;
			}
			const session = { id: randomUUID(), workspaceRoot: params.workspaceRoot, readOnly, tasks: new Map(), cancelled: new Set() };
			sessions.set(session.id, session);
			reply({ session: { sessionId: session.id, status: 'idle', workspaceRoot: params.workspaceRoot }, viewCursor: nextCursor() });
			break;
		}
		case 'session/resume': {
			// Sessions here live in memory; a resume after a restart reattaches to the id as if it were stored.
			if (String(params.sessionId).startsWith('missing-')) {
				send({ id, error: { code: -32010, message: `session ${params.sessionId} not found`, data: { kind: 'sessionNotFound', retryable: false } } });
				break;
			}
			const session = sessions.get(params.sessionId) ?? { id: params.sessionId, workspaceRoot: process.cwd(), readOnly: false, tasks: new Map(), cancelled: new Set() };
			sessions.set(session.id, session);
			reply({ session: { sessionId: session.id, status: 'idle', workspaceRoot: session.workspaceRoot }, history: { mode: 'none', items: [] }, pendingRequests: [], viewCursor: nextCursor() });
			break;
		}
		case 'turn/start': {
			const session = sessions.get(params.sessionId);
			const turnId = params.commandId;
			session.currentTurn = turnId;
			reply({ commandId: params.commandId, status: 'accepted', disposition: 'started', startedNewTurn: true, turnId });
			const text = (params.input ?? []).map(part => part.text ?? '').join('\n');
			setTimeout(() => {
				notify('turn/started', { sessionId: session.id, turnId });
				const run = session.readOnly ? runExplanation(session, turnId, text) : runCoding(session, turnId, text);
				run.catch(error => process.stderr.write(`${error.stack}\n`));
			}, 20);
			break;
		}
		case 'turn/interrupt':
		case 'turn/cancel': {
			const session = sessions.get(params.sessionId);
			session.cancelled.add(params.turnId ?? session.currentTurn);
			reply({ commandId: params.commandId, status: 'accepted' });
			break;
		}
		case 'approval/decide': {
			pendingApprovals.get(params.approvalId)?.(params.choiceId);
			pendingApprovals.delete(params.approvalId);
			reply({ commandId: params.commandId, status: 'accepted' });
			break;
		}
		case 'task/list': {
			const session = sessions.get(params.sessionId);
			reply({ tasks: [...session.tasks.values()].map(task => ({ ...task, kind: 'tool', status: 'inProgress', executionMode: 'background' })) });
			break;
		}
		case 'item/readOutput':
			reply({ byteLen: 0, content: '', encoding: 'utf8', eof: true, mediaType: 'text/plain', offsetBytes: 0 });
			break;
		case 'userInput/cancel':
			reply({ commandId: params.commandId, status: 'accepted' });
			break;
		default:
			if (id !== undefined) {
				send({ id, error: { code: -32601, message: `method not found: ${method}`, data: { kind: 'methodNotFound', retryable: false } } });
			}
	}
});
input.on('close', () => process.exit(0));


/** A plausible system map for a small JavaScript project: one component per source file, tests together, edges from imports. */
function deriveSystemMap(root) {
	const files = [];
	const walk = dir => {
		for (const name of readdirSync(path.join(root, dir))) {
			if (['node_modules', '.git', '.vscode'].includes(name) || name.startsWith('a-folder-')) {
				continue;
			}
			const relative = dir ? `${dir}/${name}` : name;
			if (statSync(path.join(root, relative)).isDirectory()) {
				walk(relative);
			} else if (/\.(m?js|ts)$/.test(name)) {
				files.push(relative);
			}
		}
	};
	walk('');
	const idOf = file => /(^|\/)test\//.test(file) || /\.test\./.test(file) ? 'tests' : file.replace(/\.(m?js|ts)$/, '').split('/').pop().replace(/[^a-z0-9]+/gi, '-').toLowerCase();
	const components = new Map();
	const connections = new Map();
	for (const file of files) {
		const text = readFileSync(path.join(root, file), 'utf8');
		const lines = text.split('\n');
		const id = idOf(file);
		const exports = [...text.matchAll(/export\s+(?:async\s+)?(?:function|class|const)\s+(\w+)/g)].map(match => match[1]);
		const name = id === 'tests' ? 'Tests' : id.replace(/(^|-)(\w)/g, (_, dash, letter) => `${dash ? ' ' : ''}${letter.toUpperCase()}`);
		const component = components.get(id) ?? { id, name, summary: '', description: '', files: [] };
		component.files.push({ path: file, startLine: 1, endLine: lines.length, why: exports.length ? `defines ${exports.slice(0, 3).join(', ')}` : 'the code' });
		component.summary = id === 'tests' ? 'Checks the behaviour of the other parts' : exports.length ? `Provides ${exports.slice(0, 2).join(' and ')}` : `The code in ${file}`;
		component.description = id === 'tests'
			? `The test suite (${component.files.length} file${component.files.length === 1 ? '' : 's'}). Each test sets up a small scenario and checks what the code under test does.`
			: `${name} lives in ${file}.${exports.length ? ` It exports ${exports.join(', ')}, which the rest of the project uses.` : ''} Read it top to bottom: it is short and self-contained.`;
		components.set(id, component);
		lines.forEach((line, index) => {
			const target = /from\s+['"](\.{1,2}\/[^'"]+)['"]/.exec(line)?.[1];
			if (!target) {
				return;
			}
			const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target)).replace(/^\.\//, '');
			const to = idOf(resolved);
			if (to === id || !files.some(candidate => candidate === resolved || candidate.replace(/\.(m?js|ts)$/, '') === resolved.replace(/\.(m?js|ts)$/, ''))) {
				return;
			}
			const names = /import\s+\{([^}]+)\}/.exec(line)?.[1].split(',').map(part => part.trim()).filter(Boolean) ?? [];
			const key = `${id}>${to}`;
			const existing = connections.get(key);
			if (existing) {
				existing.evidence.push({ path: file, startLine: index + 1, endLine: index + 1 });
			} else {
				connections.set(key, { from: id, to, label: id === 'tests' ? 'tests' : names.length ? `uses ${names.slice(0, 2).join(', ')}` : 'imports', detail: `${file} imports ${resolved} on line ${index + 1}.`, evidence: [{ path: file, startLine: index + 1, endLine: index + 1 }] });
			}
		});
	}
	return {
		overview: `A small JavaScript project of ${files.length} files: ${[...components.values()].filter(component => component.id !== 'tests').map(component => component.name).join(', ')}${components.has('tests') ? ', with tests' : ''}.`,
		components: [...components.values()],
		connections: [...connections.values()],
	};
}
