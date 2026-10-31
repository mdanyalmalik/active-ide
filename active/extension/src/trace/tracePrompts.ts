/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Active contributors. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { KnowledgeProfile } from '../shared/activeProtocol';
import { describeProfile } from '../explain/prompts';

const STEP = `{
      "file": "src/x.js",
      "startLine": 10,
      "endLine": 18,
      "symbol": "ApiClient.request",
      "summary": "One sentence: what happens at this step.",
      "detail": "Optional, one to three sentences: why, or what to notice.",
      "hop": { "kind": "call | await | return | callback | event | state | throw | other", "label": "how this step leads to the next, e.g. \\"awaits limiter.take()\\"" },
      "probe": { "line": 12, "values": ["this.tokens", "response.status"] },
      "repeats": "optional: when this step runs over and over on this path, e.g. \\"once per retry\\""
    }`;

const SCHEMA = `{
  "title": "A short name for the path, e.g. \\"A request that gets a 429\\"",
  "overview": "Two or three sentences: what happens, start to finish.",
  "steps": [
    ${STEP},
    { "fork": {
        "kind": "either | all",
        "label": "what decides it, or what fans out, e.g. \\"on the response status\\"",
        "paths": [
          { "label": "429: wait, then retry", "steps": [ /* steps, as above */ ] },
          { "label": "any other error", "ends": "optional: how the flow ends on this path, e.g. \\"throws to the caller\\"", "steps": [ /* … */ ] }
        ]
    } },
    /* the main line continues after the fork */
  ],
  "run": { "command": "an existing test that runs this path", "script": "or a short driver script", "language": "javascript | python (the script's)", "why": "what it exercises" }
}`;

/** How to observe the path, in the language of the code it's in. */
function runGuidance(root: string): string {
	return `For "run", give the narrowest existing test command that exercises this path, in the language of the code it's in:
- JavaScript/TypeScript: any shell command, e.g. "npm test -- test/limits.test.js" or "node --test test/limits.test.js".
- Python: "pytest tests/test_limits.py -k retry", "python -m unittest tests.test_limits" or "python scripts/run.py" (one plain command, no pipes or &&).
- Go: "go test ./internal/limits -run TestRetry" (one package, as a ./ path).
- Rust: "cargo test --lib retry"; C or C++: an already-built test program, e.g. "./build/tests --gtest_filter=Retry.*".
If no test does, and the code is JavaScript/TypeScript or Python, write a short driver script instead ("language": "javascript" for an ES module, "python" for Python): import the project's code by absolute path (the project root is ${root}; in Python, put it on sys.path first), replace network, time and randomness with small fakes (e.g. a fake fetch, or unittest.mock), never touch the network or write files, and finish within a few seconds. For Go, Rust, C and C++ give a test command or leave "run" out.`;
}

/** Asks the explainer to follow a behavior through the code, as steps a developer can read top to bottom. */
export function buildTracePrompt(question: string, files: readonly string[], root: string, profile: KnowledgeProfile, command?: string): string {
	return `You are tracing code inside Active, an IDE that helps a developer understand their project. You only read; never modify files.

CODE TRACE

The developer wants to see how this flows through the code:
${question}

Read the code and follow the path in the order it actually happens at runtime: calls, awaits, callbacks and timers, events, returns, thrown errors, and state that one step writes and a later step reads. Include only steps on this path. Make each step a small piece of code (usually 3 to 15 lines, at most 40) a developer reads to see that step, and say in one sentence what happens there. The hop on each step (except the last) says how control or data gets to the next step.

Shapes. Most paths are one line of steps. Where the path really divides and the developer would want to see both sides, use a fork (at most 4 paths, at most 6 steps each, no forks inside forks, at most 24 steps in all):
- "either": only one path runs, depending on a condition (if/else, a switch, try/catch, an early return). Label each path with its condition. Use it when the question is about what can happen (e.g. "what happens when the request fails"), not for every if.
- "all": every path runs: several listeners for one event, Promise.all or other parallel work, fan-out to workers.
A path that doesn't come back to the main line (it returns early, or throws) says how it ends in "ends". The main line continues after the fork with the step that runs after the paths. For loops and retries, don't repeat steps: mark the repeating step with "repeats".

Probes let Active observe the path by running it under a debugger with a logpoint on each step. For each step give a probe: a line inside the step that runs every time the step happens on this path (a statement, not a blank line, a comment, a closing brace or a function's opening line). Never put it inside an if/else branch, catch block or early return that this path skips: if the step's code starts with such a branch, pick a line after it, or the step's first statement. On a fork path, put it on a line that only runs on that path. Give up to four values to print there that show the step's state, in the code's own language (e.g. this.tokens, self.tokens, b.Tokens, b->tokens). Values must be plain reads (variables, fields, indexes) with no calls or assignments.

${command ? `It will be observed by running: ${command}. Leave "run" out.` : runGuidance(root)}

DEVELOPER PROFILE
${describeProfile(profile)}

The project's files:
${files.map(file => `- ${file}`).join('\n')}

Answer with only this JSON:
${SCHEMA}`;
}

export function buildTraceRepairPrompt(errors: readonly string[]): string {
	return `CODE TRACE REPAIR

Your trace had these problems:
${errors.slice(0, 20).map(error => `- ${error}`).join('\n')}

Fix them (check the files and line numbers) and answer again with only the corrected JSON, in the same shape as before.`;
}
