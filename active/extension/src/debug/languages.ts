/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'node:path';

/**
 * The languages Active can run under a debugger, each with its own debug adapter:
 * - javascript: VS Code's built-in js-debug (the command runs in a shell; every Node process it starts is attached);
 * - python: debugpy, shipped inside the agent extension, run with the project's own Python;
 * - go: Delve (`dlv dap`), installed on first use with the developer's Go toolchain;
 * - native (C, C++, Rust): CodeLLDB, shipped as a built-in extension.
 */
export type DebugLanguage = 'javascript' | 'python' | 'go' | 'native';

export const DEBUG_LANGUAGE_NAMES: Record<DebugLanguage, string> = { javascript: 'JavaScript/TypeScript', python: 'Python', go: 'Go', native: 'C, C++ or Rust' };
export const SUPPORTED_LANGUAGES_TEXT = 'JavaScript, TypeScript, Python, Go, C, C++ and Rust';

const FILE_LANGUAGES: Record<string, DebugLanguage> = {
	js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'javascript', mts: 'javascript', cts: 'javascript', tsx: 'javascript',
	py: 'python',
	go: 'go',
	c: 'native', h: 'native', cc: 'native', cpp: 'native', cxx: 'native', hh: 'native', hpp: 'native', hxx: 'native', rs: 'native',
};

export function languageOfFile(file: string): DebugLanguage | undefined {
	return FILE_LANGUAGES[path.extname(file).slice(1).toLowerCase()];
}

/** How a command will be run under the debugger. Each kind becomes a debug configuration in the backend. */
export type LaunchPlan =
	| { readonly language: 'javascript'; readonly command: string }
	| { readonly language: 'python'; readonly python: string; readonly config: Readonly<Record<string, unknown>> }
	| { readonly language: 'go'; readonly dlv: string; readonly config: Readonly<Record<string, unknown>> }
	| { readonly language: 'native'; readonly config: Readonly<Record<string, unknown>> };

/** What planning needs from the machine (the real one looks on disk and PATH; tests fake it). */
export interface Toolchain {
	/** The project's Python: its virtual environment's when it has one, else python3 on PATH. */
	python(cwd: string): Promise<string | undefined>;
	/** Delve, installed with the developer's Go toolchain if needed; a string explains why it isn't available. */
	dlv(): Promise<{ path: string } | string>;
	/** CodeLLDB is installed (it ships with Active). */
	nativeDebugger(): boolean;
	/** A fresh temporary folder (Go's debug builds go there, never into the project). */
	tempDir(): Promise<string>;
}

/**
 * Splits a command line like a POSIX shell would for simple commands: words, quotes and backslashes. Returns
 * undefined when the command uses pipes, `&&`, redirects or substitutions, which only a shell can run.
 */
export function splitCommand(command: string): string[] | undefined {
	const words: string[] = [];
	let word = '';
	let inWord = false;
	for (let i = 0; i < command.length; i++) {
		const char = command[i];
		if (char === '\'') {
			const end = command.indexOf('\'', i + 1);
			if (end < 0) {
				return undefined;
			}
			word += command.slice(i + 1, end);
			inWord = true;
			i = end;
		} else if (char === '"') {
			let j = i + 1;
			for (; j < command.length && command[j] !== '"'; j++) {
				if (command[j] === '\\' && j + 1 < command.length) {
					j++;
				}
				if (command[j] === '$' || command[j] === '`') {
					return undefined;
				}
				word += command[j];
			}
			if (j >= command.length) {
				return undefined;
			}
			inWord = true;
			i = j;
		} else if (char === '\\' && i + 1 < command.length) {
			word += command[++i];
			inWord = true;
		} else if (/\s/.test(char)) {
			if (inWord) {
				words.push(word);
				word = '';
				inWord = false;
			}
		} else if ('|&;<>`$()'.includes(char)) {
			return undefined;
		} else {
			word += char;
			inWord = true;
		}
	}
	if (inWord) {
		words.push(word);
	}
	return words;
}

/** Leading `NAME=value` words, as environment variables for the program. */
function takeEnv(words: string[]): Record<string, string> {
	const env: Record<string, string> = {};
	while (words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0])) {
		const assignment = words.shift()!;
		env[assignment.slice(0, assignment.indexOf('='))] = assignment.slice(assignment.indexOf('=') + 1);
	}
	return env;
}

const PYTHON_RUNNERS = new Set(['uv', 'poetry', 'pipenv', 'pdm', 'rye', 'hatch']);
const isPython = (word: string) => /^python(?:\d+(?:\.\d+)?)?(?:\.exe)?$/i.test(path.basename(word));

/** The language a command runs, when it says so (`pytest`, `go test`, `cargo run`, `node`, …). */
export function languageOfCommand(command: string): DebugLanguage | undefined {
	const words = splitCommand(command);
	if (!words) {
		return undefined;
	}
	takeEnv(words);
	if (PYTHON_RUNNERS.has(words[0]) && words[1] === 'run') {
		words.splice(0, 2);
	}
	const first = words[0] ?? '';
	if (isPython(first) || ['pytest', 'py.test'].includes(first) || first.endsWith('.py')) {
		return 'python';
	}
	if (first === 'go') {
		return 'go';
	}
	if (first === 'cargo') {
		return 'native';
	}
	if (['node', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'jest', 'vitest', 'mocha', 'tsx', 'ts-node'].includes(first) || /\.[cm]?[jt]s$/.test(first)) {
		return 'javascript';
	}
	return undefined;
}

/** Turns a command into a launch for `language`'s debugger, or explains why it can't run that way. */
export async function planLaunch(language: DebugLanguage, command: string, cwd: string, toolchain: Toolchain): Promise<LaunchPlan | string> {
	if (language === 'javascript') {
		return { language, command };
	}
	const words = splitCommand(command);
	if (!words?.length) {
		return `\`${command}\` needs a shell (pipes, &&, redirects or substitutions). Give one plain command, e.g. ${EXAMPLES[language]}.`;
	}
	const env = takeEnv(words);
	switch (language) {
		case 'python': return planPython(words, env, cwd, toolchain);
		case 'go': return planGo(words, env, cwd, toolchain);
		case 'native': return planNative(words, env, cwd, toolchain);
	}
}

const EXAMPLES: Record<DebugLanguage, string> = {
	javascript: '"npm test -- test/x.test.js"',
	python: '"pytest tests/test_x.py -k retry", "python -m mypkg.cli" or "python scripts/run.py"',
	go: '"go test ./internal/limits -run TestRetry" or "go run ./cmd/app"',
	native: '"cargo test --lib retry", "cargo run -- --flag" or a built program like "./build/tests"',
};

async function planPython(words: string[], env: Record<string, string>, cwd: string, toolchain: Toolchain): Promise<LaunchPlan | string> {
	if (PYTHON_RUNNERS.has(words[0]) && words[1] === 'run') {
		words.splice(0, 2);
	}
	let interpreter: string | undefined;
	let target: { program: string } | { module: string } | undefined;
	if (isPython(words[0])) {
		const given = words.shift()!;
		// A bare `python`/`python3` means the project's Python (its virtual environment, when it has one).
		interpreter = given.includes('/') || given.includes('\\') ? path.resolve(cwd, given) : await toolchain.python(cwd);
		while (words.length && words[0].startsWith('-')) {
			const flag = words.shift()!;
			if (flag === '-m') {
				const module = words.shift();
				if (!module) {
					return 'Give the module after -m.';
				}
				target = { module };
				break;
			}
			if (flag === '-c') {
				return 'Python code given with -c can\'t be debugged: put it in a script and run that.';
			}
			if (['-X', '-W'].includes(flag)) {
				words.shift();
			}
		}
		if (!target) {
			const script = words.shift();
			if (!script) {
				return 'Give the script to run, e.g. "python scripts/run.py".';
			}
			target = { program: path.resolve(cwd, script) };
		}
	} else if (['pytest', 'py.test'].includes(words[0])) {
		words.shift();
		target = { module: 'pytest' };
	} else if (words[0]?.endsWith('.py')) {
		target = { program: path.resolve(cwd, words.shift()!) };
	} else {
		return `\`${words.join(' ')}\` doesn't run Python directly. Give it as ${EXAMPLES.python}.`;
	}
	interpreter ??= await toolchain.python(cwd);
	if (!interpreter) {
		return 'No Python was found (no virtual environment in the project and no python3 on PATH).';
	}
	return {
		language: 'python',
		python: interpreter,
		config: {
			python: [interpreter],
			...target,
			args: words,
			cwd,
			env,
			console: 'internalConsole',
			redirectOutput: true,
			justMyCode: true,
			subProcess: true,
		},
	};
}

/** `go test` flags that take a value, and the ones that belong to the build rather than the test binary. */
const GO_TEST_VALUE_FLAGS = new Set(['run', 'skip', 'bench', 'benchtime', 'count', 'cpu', 'parallel', 'timeout', 'shuffle', 'list', 'coverprofile', 'cpuprofile', 'memprofile', 'outputdir']);
const GO_BUILD_VALUE_FLAGS = new Set(['tags', 'mod', 'ldflags', 'gcflags', 'asmflags', 'modfile', 'overlay', 'pgo', 'p']);
const GO_BUILD_BOOL_FLAGS = new Set(['race', 'msan', 'asan', 'trimpath', 'cover', 'a', 'x', 'n', 'work']);

async function planGo(words: string[], env: Record<string, string>, cwd: string, toolchain: Toolchain): Promise<LaunchPlan | string> {
	if (words[0] !== 'go' || !['test', 'run'].includes(words[1])) {
		return `\`${words.join(' ')}\` isn't a go test or go run command. Give it as ${EXAMPLES.go}.`;
	}
	const mode = words[1] === 'test' ? 'test' : 'debug';
	const rest = words.slice(2);
	const buildFlags: string[] = [];
	const args: string[] = [];
	const targets: string[] = [];
	for (let i = 0; i < rest.length; i++) {
		const word = rest[i];
		if (word === '--' || (mode === 'debug' && targets.length)) {
			// `go run` passes everything after the package to the program.
			args.push(...rest.slice(word === '--' ? i + 1 : i));
			break;
		}
		if (!word.startsWith('-')) {
			targets.push(word);
			continue;
		}
		const [name, inline] = word.replace(/^--?/, '').split(/=(.*)/s, 2);
		const value = () => inline ?? rest[++i];
		if (GO_BUILD_VALUE_FLAGS.has(name)) {
			buildFlags.push(`-${name}=${value()}`);
		} else if (GO_BUILD_BOOL_FLAGS.has(name)) {
			buildFlags.push(`-${name}`);
		} else if (mode === 'test' && GO_TEST_VALUE_FLAGS.has(name)) {
			args.push(`-test.${name}`, value());
		} else if (mode === 'test') {
			args.push(`-test.${name}${inline !== undefined ? `=${inline}` : ''}`);
		} else {
			buildFlags.push(word);
		}
	}
	if (targets.length > 1 || targets.some(target => target.includes('...'))) {
		return `The debugger runs one package at a time; give a single package, e.g. ${EXAMPLES.go}.`;
	}
	const target = targets[0] ?? '.';
	if (!target.startsWith('.') && !target.startsWith('/') && !target.endsWith('.go')) {
		return `Give the package as a path (e.g. ./internal/limits), not an import path (${target}).`;
	}
	const dlv = await toolchain.dlv();
	if (typeof dlv === 'string') {
		return dlv;
	}
	return {
		language: 'go',
		dlv: dlv.path,
		config: {
			mode,
			program: path.resolve(cwd, target),
			args,
			cwd,
			env,
			...(buildFlags.length ? { buildFlags: buildFlags.join(' ') } : {}),
			// The debug build goes to a temporary folder, never into the project.
			output: path.join(await toolchain.tempDir(), mode === 'test' ? 'debug.test' : 'debug.bin'),
			outputMode: 'remote',
		},
	};
}

const CARGO_VALUE_FLAGS = new Set(['--bin', '--test', '--example', '--bench', '-p', '--package', '--features', '-F', '--manifest-path', '--target', '--profile', '-j', '--jobs']);

async function planNative(words: string[], env: Record<string, string>, cwd: string, toolchain: Toolchain): Promise<LaunchPlan | string> {
	if (!toolchain.nativeDebugger()) {
		return 'The C, C++ and Rust debugger (CodeLLDB) isn\'t installed in this copy of Active.';
	}
	const base = { cwd, env, terminal: 'console' };
	if (words[0] === 'cargo' && ['test', 'run'].includes(words[1])) {
		const test = words[1] === 'test';
		const cargoArgs: string[] = [test ? 'test' : 'build', ...(test ? ['--no-run'] : [])];
		const args: string[] = [];
		const rest = words.slice(2);
		for (let i = 0; i < rest.length; i++) {
			const word = rest[i];
			if (word === '--') {
				args.push(...rest.slice(i + 1));
				break;
			}
			if (word.startsWith('-')) {
				cargoArgs.push(word);
				if (CARGO_VALUE_FLAGS.has(word) && i + 1 < rest.length) {
					cargoArgs.push(rest[++i]);
				}
			} else if (test) {
				args.push(word); // a test name filter, for the test binary
			} else {
				return `\`cargo run\` passes program arguments after --, e.g. "cargo run -- ${word}".`;
			}
		}
		return { language: 'native', config: { ...base, cargo: { args: cargoArgs }, args, sourceLanguages: ['rust'] } };
	}
	const program = words[0];
	if (program && (program.includes('/') || program.includes('\\'))) {
		return { language: 'native', config: { ...base, program: path.resolve(cwd, program), args: words.slice(1) } };
	}
	return `\`${words.join(' ')}\` doesn't start a program the debugger can launch. Build it first, then give ${EXAMPLES.native}.`;
}
