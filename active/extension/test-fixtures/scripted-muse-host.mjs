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
import { mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
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
		if (question.startsWith('MORE DETAIL:')) {
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
