#!/usr/bin/env node
// Copyright (c) Active contributors. Licensed under the MIT License.
//
// DEV ONLY. CLI for external agents (e.g. Claude Code subagents) serving Active's
// `bridge` agent backend. See active/extension/src/agents/bridgeHost.ts.
//
//   bridge-agent.mjs next   <role> [timeoutSeconds]        wait for the next request; prints its turnId, workspace and prompt file
//   bridge-agent.mjs say    <role> <turnId> <text> [phase]  agent message (phase: commentary | finalAnswer)
//   bridge-agent.mjs reason <role> <turnId> <summary>       short exposed summary of why you are doing something
//   bridge-agent.mjs tool   <role> <turnId> <label>         report a completed action (e.g. "Edited backend/models.py")
//   bridge-agent.mjs run    <role> <turnId> <command>       run a shell command in the workspace and report it with its output
//   bridge-agent.mjs bg     <role> <turnId> <command>       start a background command (reported when it finishes)
//   bridge-agent.mjs reply  <role> <turnId> <file>          final answer from a file, then end the turn
//   bridge-agent.mjs done   <role> <turnId>                 end the turn
//
// The bridge directory comes from ACTIVE_BRIDGE_DIR.

import { execSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';

const bridge = process.env.ACTIVE_BRIDGE_DIR;
if (!bridge) {
	console.error('ACTIVE_BRIDGE_DIR is not set');
	process.exit(2);
}
const [command, role, ...rest] = process.argv.slice(2);
if (!command || !['coding', 'explanation'].includes(role ?? '')) {
	console.error('usage: bridge-agent.mjs <next|say|reason|tool|run|bg|reply|done> <coding|explanation> ...');
	process.exit(2);
}
const dir = path.join(bridge, role);
for (const sub of ['inbox', 'outbox', 'claimed', 'prompts']) {
	mkdirSync(path.join(dir, sub), { recursive: true });
}

const emit = (turnId, event) => appendFileSync(path.join(dir, 'outbox', `${turnId}.jsonl`), `${JSON.stringify(event)}\n`);
const request = turnId => {
	const file = readdirSync(path.join(dir, 'inbox')).find(name => name.endsWith(`-${turnId}.json`));
	if (!file) {
		throw new Error(`no request for ${turnId}`);
	}
	return JSON.parse(readFileSync(path.join(dir, 'inbox', file), 'utf8'));
};
const tail = (text, max = 3000) => text.length > max ? `…${text.slice(-max)}` : text;
let toolSeq = Date.now() % 100000;

switch (command) {
	case 'next': {
		const deadline = Date.now() + Number(rest[0] ?? 540) * 1000;
		for (;;) {
			const pending = readdirSync(path.join(dir, 'inbox')).filter(name => name.endsWith('.json')).sort()
				.map(name => ({ name, turnId: name.replace(/^\d+-/, '').replace(/\.json$/, '') }))
				.find(({ turnId }) => !existsSync(path.join(dir, 'claimed', turnId)));
			if (pending) {
				const req = JSON.parse(readFileSync(path.join(dir, 'inbox', pending.name), 'utf8'));
				writeFileSync(path.join(dir, 'claimed', pending.turnId), String(Date.now()));
				const promptFile = path.join(dir, 'prompts', `${pending.turnId}.md`);
				writeFileSync(promptFile, req.text);
				console.log(JSON.stringify({ turnId: req.turnId, workspaceRoot: req.workspaceRoot, readOnly: req.readOnly, promptFile, promptChars: req.text.length, promptPreview: req.text.slice(0, 400) }, null, 1));
				process.exit(0);
			}
			if (Date.now() > deadline) {
				console.log('NONE (timed out waiting; call next again)');
				process.exit(0);
			}
			await new Promise(resolve => setTimeout(resolve, 1000));
		}
	}
	case 'say':
		emit(rest[0], { type: 'message', text: rest[1], phase: rest[2] ?? 'commentary' });
		break;
	case 'reason':
		emit(rest[0], { type: 'reasoning', summary: rest[1] });
		break;
	case 'tool':
		emit(rest[0], { type: 'tool', id: `t${toolSeq++}`, label: rest[1], status: 'completed' });
		break;
	case 'run': {
		const [turnId, shell] = rest;
		const req = request(turnId);
		if (req.readOnly) {
			console.error('read-only session: commands are not allowed');
			process.exit(1);
		}
		const id = `t${toolSeq++}`;
		emit(turnId, { type: 'tool', id, label: `Run ${shell}`, command: shell, status: 'inProgress' });
		let output = '';
		let status = 'completed';
		try {
			output = execSync(shell, { cwd: req.workspaceRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 600_000, maxBuffer: 32 * 1024 * 1024 });
		} catch (error) {
			status = 'failed';
			output = `${error.stdout ?? ''}${error.stderr ?? ''}${error.message ? `\n${error.message}` : ''}`;
		}
		emit(turnId, { type: 'tool', id, label: `Run ${shell}`, command: shell, status, output: tail(output) });
		console.log(tail(output, 6000));
		console.log(`[${status}]`);
		process.exit(status === 'completed' ? 0 : 1);
	}
	case 'bg': {
		const [turnId, shell] = rest;
		const req = request(turnId);
		const id = `b${toolSeq++}`;
		emit(turnId, { type: 'background', id, command: shell, status: 'inProgress' });
		const script = `out=$( (${shell}) 2>&1 ); code=$?; node -e 'const fs=require("fs");const [f,id,cmd,code,out]=process.argv.slice(1);fs.appendFileSync(f, JSON.stringify({type:"background",id,command:cmd,status:code==="0"?"completed":"failed",output:out.slice(-3000)})+"\\n")' "$0" "$1" "$2" "$code" "$out"`;
		const child = spawn('bash', ['-c', script, path.join(dir, 'outbox', `${turnId}.jsonl`), id, shell], { cwd: req.workspaceRoot, detached: true, stdio: 'ignore' });
		child.unref();
		console.log(`started background task ${id}`);
		break;
	}
	case 'reply':
		emit(rest[0], { type: 'message', text: readFileSync(rest[1], 'utf8'), phase: 'finalAnswer' });
		emit(rest[0], { type: 'done' });
		break;
	case 'done':
		emit(rest[0], { type: 'done' });
		break;
	default:
		console.error(`unknown command ${command}`);
		process.exit(2);
}
