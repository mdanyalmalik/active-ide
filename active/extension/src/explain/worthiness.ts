/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { diffLines } from '../tracking/lineDiff';
import type { NetFileChange } from '../tracking/changeTracker';

export interface WorthinessVerdict {
	readonly worthy: boolean;
	readonly score: number;
	readonly meaningfulLines: number;
	readonly logicSignals: number;
	readonly files: number;
	readonly reasons: readonly string[];
}

const LOW_SIGNAL_FILES = [/(^|\/)package-lock\.json$/, /(^|\/)yarn\.lock$/, /(^|\/)pnpm-lock\.yaml$/, /(^|\/)Cargo\.lock$/, /(^|\/)poetry\.lock$/, /\.min\.(js|css)$/, /\.map$/, /\.snap$/, /(^|\/)CHANGELOG(\.md)?$/i];
const COMMENT_ONLY = /^\s*(\/\/|#|\*|\/\*|\*\/|<!--|--|;|%)/;
const LOGIC = /\b(if|else|for|while|switch|case|return|throw|try|catch|finally|await|async|yield|function|def|class|interface|struct|enum|impl|fn|func|match|lambda|new|extends|implements)\b|=>|\?\?|&&|\|\||[<>]=?|\*\*/;
const DECLARATION = /\b(function|def|class|interface|struct|enum|impl|fn|func|type|export)\b/;

function isLowSignalFile(path: string): boolean {
	return LOW_SIGNAL_FILES.some(pattern => pattern.test(path));
}

function meaningfulLine(line: string): boolean {
	const trimmed = line.trim();
	return trimmed.length > 1 && !COMMENT_ONLY.test(trimmed) && !/^[{}()[\];,]+$/.test(trimmed);
}

/**
 * The cheap filter before the explanation model is involved: does the change contain anything
 * meaningful at all (not only whitespace, comments, moves, lock or generated files, or the user's own
 * edits)? Whether it's worth explaining, and at what length, is the explanation model's call.
 */
export function assessWorthiness(changes: readonly NetFileChange[]): WorthinessVerdict {
	const reasons: string[] = [];
	let meaningful = 0;
	let logic = 0;
	let declarations = 0;
	let files = 0;
	for (const change of changes) {
		if (change.userOnly) {
			continue;
		}
		if (isLowSignalFile(change.path)) {
			reasons.push(`${change.path}: generated or lock file, ignored`);
			continue;
		}
		let fileMeaningful = 0;
		for (const hunk of diffLines(change.baseline, change.final)) {
			// Lines that only moved or changed whitespace are not meaningful.
			const removed = new Map<string, number>();
			for (const line of hunk.removed) {
				const key = line.replace(/\s+/g, '');
				removed.set(key, (removed.get(key) ?? 0) + 1);
			}
			for (const line of hunk.added) {
				const key = line.replace(/\s+/g, '');
				const count = removed.get(key) ?? 0;
				if (count > 0) {
					removed.set(key, count - 1);
					continue;
				}
				if (meaningfulLine(line)) {
					fileMeaningful++;
					if (LOGIC.test(line)) {
						logic++;
					}
					if (DECLARATION.test(line)) {
						declarations++;
					}
				}
			}
			for (const [key, count] of removed) {
				if (count > 0 && meaningfulLine(key)) {
					fileMeaningful += count;
					if (LOGIC.test(key)) {
						logic += count;
					}
				}
			}
		}
		if (fileMeaningful > 0) {
			files++;
			meaningful += fileMeaningful;
		}
	}
	const score = meaningful + logic * 1.5 + declarations * 2 + Math.max(0, files - 1) * 3;
	const worthy = meaningful > 0;
	reasons.push(worthy
		? `${meaningful} meaningful line${meaningful === 1 ? '' : 's'} (${logic} with logic) across ${files} file${files === 1 ? '' : 's'}`
		: 'no meaningful code changes');
	return { worthy, score, meaningfulLines: meaningful, logicSignals: logic, files, reasons };
}
