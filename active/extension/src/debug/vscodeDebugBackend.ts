/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';
import * as vscode from 'vscode';
import type { BackendSession, BreakpointSpec, DebugBackend, DebugBackendEvent } from './debugRunner';

/** Marks the debug configurations Active starts for the coding agent. */
const RUN_KEY = '__activeAgentRun';

interface Run {
	readonly onEvent: (event: DebugBackendEvent) => void;
	root: vscode.DebugSession | undefined;
	readonly sessions: Map<string, vscode.DebugSession>;
}

/**
 * The coding agent's debugging on VS Code's debugger. Commands run under the built-in JavaScript debugger
 * (js-debug), which also attaches to every Node process they start (test runners, workers), each as a child
 * session. Runs are hidden from the debug view, toolbar and status bar. Adapter events are read with a tracker.
 */
export class VscodeDebugBackend implements DebugBackend, vscode.Disposable {
	private readonly runs = new Map<string, Run>();
	/** Every live debug session, the developer's and the agent's. */
	private readonly live = new Set<vscode.DebugSession>();
	private readonly disposables: vscode.Disposable[] = [];

	constructor(private readonly folder: vscode.WorkspaceFolder) {
		this.disposables.push(
			vscode.debug.registerDebugAdapterTrackerFactory('*', {
				createDebugAdapterTracker: session => {
					const run = this.runOf(session);
					if (!run) {
						return undefined;
					}
					run.sessions.set(session.id, session);
					if (!session.parentSession) {
						run.root = session;
					}
					return { onDidSendMessage: message => this.onMessage(run, session, message as { type?: string; event?: string; body?: Record<string, unknown> }) };
				},
			}),
			vscode.debug.onDidStartDebugSession(session => {
				this.live.add(session);
				const runId = session.configuration[RUN_KEY] as string | undefined;
				const run = runId ? this.runs.get(runId) : undefined;
				if (run && !session.parentSession) {
					run.root = session;
				}
			}),
			vscode.debug.onDidTerminateDebugSession(session => {
				this.live.delete(session);
				const run = this.runOf(session);
				if (run && run.root === session) {
					run.onEvent({ kind: 'terminated' });
					this.runs.delete(session.configuration[RUN_KEY] as string);
				}
			}),
		);
	}

	developerIsDebugging(): boolean {
		return [...this.live].some(session => !this.runOf(session));
	}

	async addBreakpoints(points: readonly BreakpointSpec[]): Promise<() => Promise<void>> {
		const breakpoints = points.map(point => new vscode.SourceBreakpoint(
			new vscode.Location(vscode.Uri.file(path.join(this.folder.uri.fsPath, point.file)), new vscode.Position(point.line - 1, 0)),
			true,
			point.condition,
			point.maxHits ? `<=${point.maxHits}` : undefined,
			point.logMessage,
		));
		vscode.debug.addBreakpoints(breakpoints);
		return async () => vscode.debug.removeBreakpoints(breakpoints);
	}

	async start(options: { runId: string; command: string; cwd: string }, onEvent: (event: DebugBackendEvent) => void): Promise<BackendSession> {
		const run: Run = { onEvent, root: undefined, sessions: new Map() };
		this.runs.set(options.runId, run);
		const shell = process.platform === 'win32' ? { runtimeExecutable: process.env.ComSpec ?? 'cmd.exe', runtimeArgs: ['/d', '/s', '/c', options.command] } : { runtimeExecutable: process.env.SHELL || '/bin/sh', runtimeArgs: ['-c', options.command] };
		const started = await vscode.debug.startDebugging(this.folder, {
			type: 'pwa-node',
			request: 'launch',
			name: `Active: ${options.command}`,
			cwd: options.cwd,
			...shell,
			console: 'internalConsole',
			outputCapture: 'std',
			autoAttachChildProcesses: true,
			skipFiles: ['<node_internals>/**'],
			[RUN_KEY]: options.runId,
		}, {
			suppressDebugView: true,
			suppressDebugToolbar: true,
			suppressDebugStatusbar: true,
			suppressSaveBeforeStart: true,
		});
		if (!started) {
			this.runs.delete(options.runId);
			throw new Error('VS Code refused to start the debug session (is the JavaScript debugger available?)');
		}
		return {
			request: async (target, command, args) => {
				const session = run.sessions.get(target) ?? run.root;
				if (!session) {
					throw new Error('the debug session is gone');
				}
				return await session.customRequest(command, args) as Record<string, unknown> | undefined;
			},
			stop: async () => {
				if (run.root) {
					await vscode.debug.stopDebugging(run.root);
				}
				this.runs.delete(options.runId);
			},
		};
	}

	dispose(): void {
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}

	/** The agent run a session belongs to (its own, or its root's: js-debug starts a child session per process). */
	private runOf(session: vscode.DebugSession): Run | undefined {
		let current: vscode.DebugSession | undefined = session;
		while (current) {
			const runId = current.configuration[RUN_KEY] as string | undefined;
			if (runId) {
				return this.runs.get(runId);
			}
			current = current.parentSession;
		}
		return undefined;
	}

	private onMessage(run: Run, session: vscode.DebugSession, message: { type?: string; event?: string; body?: Record<string, unknown> }): void {
		if (message.type !== 'event') {
			return;
		}
		const body = message.body ?? {};
		switch (message.event) {
			case 'stopped':
				run.onEvent({ kind: 'stopped', target: session.id, threadId: Number(body.threadId ?? 0), reason: String(body.reason ?? 'paused'), ...(typeof body.description === 'string' ? { description: body.description } : {}) });
				break;
			case 'output':
				if (typeof body.output === 'string') {
					run.onEvent({ kind: 'output', target: session.id, category: String(body.category ?? 'console'), text: body.output });
				}
				break;
			case 'exited':
				run.onEvent({ kind: 'exited', target: session.id, exitCode: Number(body.exitCode ?? 0) });
				break;
		}
	}
}
