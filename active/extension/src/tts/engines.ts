/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { NarrationEngine } from './sidecarNarrator';

/** `mms` for the hackathon (the organisers' choice); `phonon` is the model Active used before and goes back to after. */
export type NarrationEngineId = 'mms' | 'phonon';

/** Stock MMS from the Hub: runs on torch (fp32), the slow path, for when no int8 export is installed. */
export const DEFAULT_MMS_MODEL = 'facebook/mms-tts-eng';

/** Where scripts/setup-tts.sh puts the int8 ONNX export of stock MMS (onnxruntime, about 40 MB). */
export const MMS_INT8_FOLDER = path.join('tts-models', 'mms-eng-int8');

/**
 * The engine to run. With no MMS model set, the int8 export in the first of `toolDirs` that has one is used,
 * then the Hub checkpoint on torch.
 */
export function narrationEngine(id: NarrationEngineId, resources: string, mmsModel: string, toolDirs: readonly string[] = []): NarrationEngine {
	if (id === 'phonon') {
		return { name: 'Phonon 31M', script: path.join(resources, 'phonon_sidecar.py'), needs: 'the `ptts` package' };
	}
	const installed = toolDirs.map(dir => path.join(dir, MMS_INT8_FOLDER)).find(folder => existsSync(path.join(folder, 'model.int8.onnx')));
	return { name: 'MMS English', script: path.join(resources, 'mms_sidecar.py'), args: [mmsModel || installed || DEFAULT_MMS_MODEL], needs: '`onnxruntime`' };
}
