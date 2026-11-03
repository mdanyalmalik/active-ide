/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, test } from 'node:test';
import type { NarrationStatus } from '../shared/activeProtocol';
import { DEFAULT_MMS_MODEL, MMS_INT8_FOLDER, narrationEngine } from '../tts/engines';
import { SidecarNarrator } from '../tts/sidecarNarrator';

const resources = path.resolve(__dirname, '..', '..', 'resources');
const tools = path.resolve(__dirname, '..', '..', '..', '..', '.tools');
const venvPython = path.join(tools, 'tts-venv', 'bin', 'python');
const int8Folder = path.join(tools, MMS_INT8_FOLDER);

function hasPackages(python: string, modules: string): boolean {
	try {
		execFileSync(python, ['-c', `import ${modules}`], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

describe('narration engines', () => {
	test('MMS is picked with its model; Phonon is still there', () => {
		const mms = narrationEngine('mms', resources, '');
		assert.equal(mms.name, 'MMS English');
		assert.deepEqual(mms.args, [DEFAULT_MMS_MODEL]);
		assert.ok(existsSync(mms.script));
		assert.deepEqual(narrationEngine('mms', resources, '/models/tuned').args, ['/models/tuned']);
		const phonon = narrationEngine('phonon', resources, '/models/tuned', [tools]);
		assert.equal(phonon.name, 'Phonon 31M');
		assert.ok(existsSync(phonon.script));
	});

	test('with no model set, the installed int8 export is used before the Hub checkpoint', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-tools-'));
		try {
			assert.deepEqual(narrationEngine('mms', resources, '', [dir]).args, [DEFAULT_MMS_MODEL]);
			await fs.mkdir(path.join(dir, MMS_INT8_FOLDER), { recursive: true });
			await fs.writeFile(path.join(dir, MMS_INT8_FOLDER, 'model.int8.onnx'), '');
			assert.deepEqual(narrationEngine('mms', resources, '', ['/nowhere', dir]).args, [path.join(dir, MMS_INT8_FOLDER)]);
			assert.deepEqual(narrationEngine('mms', resources, '/models/tuned', [dir]).args, ['/models/tuned']);
		} finally {
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('the narrator reports the model the sidecar names and returns its audio', async () => {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'active-narration-'));
		const script = path.join(dir, 'fake_sidecar.py');
		await fs.writeFile(script, [
			'import json, sys',
			'print(json.dumps({"ready": True, "voices": [{"name": "default"}], "model": "fake-id", "label": "Fake " + sys.argv[1]}), flush=True)',
			'for line in sys.stdin:',
			'    request = json.loads(line)',
			'    print(json.dumps({"id": request["id"], "wav": request["text"][::-1]}), flush=True)',
		].join('\n'));
		const statuses: NarrationStatus[] = [];
		const narrator = new SidecarNarrator({ name: 'Fake', script, args: ['tuned'], needs: 'nothing' }, execFileSync('python3', ['-c', 'import sys; print(sys.executable)']).toString().trim(), status => statuses.push(status), () => undefined);
		try {
			assert.equal(await narrator.synthesize('abc', 'default'), 'cba');
			assert.equal(narrator.currentStatus.available, true);
			assert.equal(narrator.currentStatus.model, 'Fake tuned');
			assert.match(statuses[0].detail, /Loading Fake/);
		} finally {
			narrator.dispose();
			await fs.rm(dir, { recursive: true, force: true });
		}
	});

	test('a missing Python says which engine needs what', async () => {
		const narrator = new SidecarNarrator(narrationEngine('mms', resources, ''), '/nowhere/python', () => undefined, () => undefined);
		await assert.rejects(narrator.start(), /MMS English \(`onnxruntime`\) not found/);
	});

	const realMms = existsSync(venvPython) && existsSync(path.join(int8Folder, 'model.int8.onnx')) && hasPackages(venvPython, 'onnxruntime');
	test('real MMS speaks a WAV on the int8 runtime (needs scripts/setup-tts.sh)', { skip: !realMms && 'no int8 MMS in .tools', timeout: 180_000 }, async () => {
		const logs: string[] = [];
		const narrator = new SidecarNarrator(narrationEngine('mms', resources, '', [tools]), venvPython, () => undefined, line => logs.push(line));
		try {
			const wav = Buffer.from(await narrator.synthesize('The fetchUser call retries 3 times.', 'default'), 'base64');
			assert.equal(wav.subarray(0, 4).toString('ascii'), 'RIFF');
			assert.equal(wav.readUInt32LE(24), 16000);
			assert.ok(wav.length > 16000, 'about a second of audio or more');
			assert.equal(narrator.currentStatus.model, 'MMS English');
			assert.ok(logs.some(line => line.includes('on int8 ONNX')), logs.join('\n'));
		} finally {
			narrator.dispose();
		}
	});

	// The sidecar's own tokenizer (so the runtime needs no transformers) must give the ids transformers gives.
	const parity = realMms && hasPackages(venvPython, 'transformers');
	test('the int8 runtime tokenizes exactly like transformers', { skip: !parity && 'needs transformers in .tools/tts-venv', timeout: 120_000 }, () => {
		const fixture = path.resolve(__dirname, '..', '..', 'test-fixtures', 'mms_tokenizer_parity.py');
		const out = execFileSync(venvPython, [fixture, resources, int8Folder], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim().split('\n').pop();
		assert.equal(out, '0');
	});
});
