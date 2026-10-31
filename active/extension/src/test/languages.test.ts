/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { languageOfCommand, languageOfFile, LaunchPlan, planLaunch, splitCommand, Toolchain } from '../debug/languages';

const CWD = '/work/project';
const toolchain = (overrides: Partial<Toolchain> = {}): Toolchain => ({
	python: async () => '/work/project/.venv/bin/python',
	dlv: async () => ({ path: '/home/me/go/bin/dlv' }),
	nativeDebugger: () => true,
	tempDir: async () => '/tmp/active-debug-x',
	...overrides,
});
const config = (plan: LaunchPlan | string) => typeof plan === 'string' ? plan : 'config' in plan ? plan.config : plan;

describe('Debugging other languages: commands become launches', () => {
	test('commands are split like a shell would; ones that need a shell are recognised', () => {
		assert.deepStrictEqual(splitCommand(`pytest -k "retry and not slow" 'tests/a b.py' x\\ y`), ['pytest', '-k', 'retry and not slow', 'tests/a b.py', 'x y']);
		for (const command of ['pytest | tee out', 'make && ./a', 'go test > log', 'echo $(pwd)', 'a; b', 'python "$HOME/x.py"']) {
			assert.equal(splitCommand(command), undefined, command);
		}
	});

	test('the language of a file, and of a command', () => {
		assert.deepStrictEqual(['a.ts', 'b.mjs', 'c.py', 'd.go', 'e.rs', 'f.cpp', 'g.h', 'h.rb'].map(languageOfFile), ['javascript', 'javascript', 'python', 'go', 'native', 'native', 'native', undefined]);
		assert.deepStrictEqual(['npm test', 'FOO=1 pytest', 'uv run python -m app', 'python3.12 x.py', 'go test ./x', 'cargo test', 'make test'].map(languageOfCommand), ['javascript', 'python', 'python', 'python', 'go', 'native', undefined]);
	});

	test('Python: scripts, modules and pytest run with the project\'s Python (its virtual environment)', async () => {
		assert.deepStrictEqual(config(await planLaunch('python', 'DEBUG=1 pytest tests/test_limits.py -k retry', CWD, toolchain())), {
			python: ['/work/project/.venv/bin/python'], module: 'pytest', args: ['tests/test_limits.py', '-k', 'retry'], cwd: CWD, env: { DEBUG: '1' },
			console: 'internalConsole', redirectOutput: true, justMyCode: true, subProcess: true,
		});
		const module = config(await planLaunch('python', 'poetry run python -u -m app.cli --dry-run', CWD, toolchain())) as Record<string, unknown>;
		assert.deepStrictEqual([module.module, module.args, module.python], ['app.cli', ['--dry-run'], ['/work/project/.venv/bin/python']]);
		const script = config(await planLaunch('python', './venv2/bin/python scripts/run.py a', CWD, toolchain())) as Record<string, unknown>;
		assert.deepStrictEqual([script.program, script.args, script.python], ['/work/project/scripts/run.py', ['a'], ['/work/project/venv2/bin/python']]);
		assert.match(config(await planLaunch('python', 'python -c "print(1)"', CWD, toolchain())) as string, /-c can't be debugged/);
		assert.match(config(await planLaunch('python', 'tox -e py39', CWD, toolchain())) as string, /doesn't run Python directly/);
		assert.match(config(await planLaunch('python', 'pytest', CWD, toolchain({ python: async () => undefined }))) as string, /No Python was found/);
	});

	test('Go: one package under go test (test flags go to the test binary) or go run; the build goes to a temporary folder', async () => {
		assert.deepStrictEqual(config(await planLaunch('go', 'go test -race -tags=integration ./internal/limits -run TestRetry -v -count=1', CWD, toolchain())), {
			mode: 'test', program: '/work/project/internal/limits', args: ['-test.run', 'TestRetry', '-test.v', '-test.count', '1'], cwd: CWD, env: {},
			buildFlags: '-race -tags=integration', output: '/tmp/active-debug-x/debug.test', outputMode: 'remote',
		});
		const run = config(await planLaunch('go', 'go run ./cmd/app --port 8080', CWD, toolchain())) as Record<string, unknown>;
		assert.deepStrictEqual([run.mode, run.program, run.args, run.output], ['debug', '/work/project/cmd/app', ['--port', '8080'], '/tmp/active-debug-x/debug.bin']);
		assert.equal((config(await planLaunch('go', 'go test', CWD, toolchain())) as Record<string, unknown>).program, CWD);
		assert.match(config(await planLaunch('go', 'go test ./...', CWD, toolchain())) as string, /one package at a time/);
		assert.match(config(await planLaunch('go', 'go test github.com/x/y', CWD, toolchain())) as string, /not an import path/);
		assert.match(config(await planLaunch('go', 'go test ./x', CWD, toolchain({ dlv: async () => 'Go debugging needs Go installed' }))) as string, /needs Go installed/);
		const planned = await planLaunch('go', 'go test ./x', CWD, toolchain());
		assert.equal(typeof planned !== 'string' && planned.language === 'go' && planned.dlv, '/home/me/go/bin/dlv');
	});

	test('C, C++ and Rust: cargo test and cargo run build through CodeLLDB; a built program runs directly; build tools are refused', async () => {
		assert.deepStrictEqual(config(await planLaunch('native', 'cargo test --lib -p core retry -- --nocapture', CWD, toolchain())), {
			cwd: CWD, env: {}, terminal: 'console', cargo: { args: ['test', '--no-run', '--lib', '-p', 'core'] }, args: ['retry', '--nocapture'], sourceLanguages: ['rust'],
		});
		const run = config(await planLaunch('native', 'cargo run --release -- --port 1', CWD, toolchain())) as Record<string, unknown>;
		assert.deepStrictEqual([run.cargo, run.args], [{ args: ['build', '--release'] }, ['--port', '1']]);
		const program = config(await planLaunch('native', './build/tests --gtest_filter=Retry.*', CWD, toolchain())) as Record<string, unknown>;
		assert.deepStrictEqual([program.program, program.args], ['/work/project/build/tests', ['--gtest_filter=Retry.*']]);
		assert.match(config(await planLaunch('native', 'make test', CWD, toolchain())) as string, /Build it first/);
		assert.match(config(await planLaunch('native', './a', CWD, toolchain({ nativeDebugger: () => false }))) as string, /CodeLLDB\) isn't installed/);
	});
});
