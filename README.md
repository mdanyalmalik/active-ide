# Active

Active is a Code OSS–based IDE for coding with an AI agent while you follow narrated, personalized walkthroughs of what changed. It was built for the Meta Global Hackathon.

You give Muse Code a task in a chat that fills the work area. When the coding turn finishes and the change is worth explaining, chat hands off to an inline walkthrough: the captured code sits in the native editor, and an explanation zone next to the relevant lines switches between code, diffs, equations, diagrams and charts, in step with on-device narration (Phonon 31M).

## Setup

Requirements: macOS or Linux, git, Python 3.9+ (or `uv`), and about 3 GB of disk space for Code OSS.

```sh
scripts/setup.sh            # Node 24 (local), Code OSS 1.143.1, deps, Electron, Phonon, Active sources
```

### Muse Code (coding and explanation)

Active drives Muse Code through the official [`@muse-code/sdk`](https://github.com/meta-models/muse-code-sdk) (1.4.14), which runs `muse serve` and speaks the Muse Session Protocol. Authentication uses your own Muse Code sign-in. Active never reads or copies credentials.

```sh
curl -fsSL https://dev.meta.ai/install.sh | sh   # installs `muse` to ~/.local/bin
muse                                             # once, interactively: trust the folder and sign in (subscription)
```

If `muse` lives somewhere else, set `active.muse.binaryPath`.

### Phonon 31M (narration)

`scripts/setup-tts.sh` creates `.tools/tts-venv` with Gradium's `ptts` package. On first use, the Apache-2.0 model `gradium/phonon-31m-en` downloads from Hugging Face; after that it runs on the CPU. To use another interpreter, set `active.narration.pythonPath`.

## Run

```sh
scripts/run.sh /path/to/project      # real Muse Code
```

Active respects Workspace Trust. Muse Code edits files and runs commands, so in Restricted Mode the chat explains why it is disconnected and links to **Manage Workspace Trust**.

### Demo without a Muse Code subscription

```sh
scripts/run-scripted-demo.sh
```

This runs Active against `active/extension/test-fixtures/scripted-muse-host.mjs`. It is a **test double, not Muse Code**: a scripted MSP host that makes real edits and runs real commands in a fresh copy of `demo/ledger-api`, then answers explanation requests with the walkthrough templates in `demo/scenarios/ledger.json`. The chat header shows `scripted-muse-host (test double)`. Try these tasks:

| Task | Exercises |
| --- | --- |
| `Support minutes and hours in parseDuration` | simple change → 4-scene walkthrough (diff, equation, code focus, evidence) |
| `Fix the typo in the README` | tiny change → saved in history, not explained |
| `Add client-side rate limiting to ApiClient` | 3 files, interacting concepts → diagram, equation, chart, diff; background `npm test` outlasts the timeout and is marked pending |

### Dev only: agent-driven testing with Claude Code subagents

`scripts/run-bridge-demo.sh <name> --remote-debugging-port=9333` opens Active on a fresh, empty workspace with `active.dev.agentBackend: "bridge"`. In this mode the coding and explanation sessions are served by external agents (for example Claude Code subagents) through a mailbox directory instead of Muse Code. Everything downstream is the real pipeline: change capture, worthiness, planning, validation, playback and history.

- `active/extension/test-fixtures/bridge-agent.mjs` is the CLI the coding and explanation agents use to take requests and report messages, reasoning summaries, file edits, commands and background tasks.
- `active/extension/test-fixtures/ui-driver.mjs` lets an automated user operate the window: observe the screen, chat, use the walkthrough controls, ask questions, and take screenshots.

The chat header labels this mode "Claude Code subagent bridge (dev only)".

## Using Active

- **Chat** opens across the whole work area on startup. Muse Code is never paused: walkthrough playback, opening files and opening chat only affect the explanation.
- **Walkthrough** controls: Rewind, Pause/Resume, Next, and Open chat at the bottom right. **Open file ↗** inside the explanation zone pauses playback and opens the editable file at the focused lines.
- **Default keybindings**, all rebindable in Keyboard Shortcuts:
  - With the walkthrough focused: `Space`/`K` pause or resume, `←`/`J` rewind, `→`/`L` advance, `C` open chat, `O` open file.
  - Anywhere: `⌘K C` open chat about the walkthrough, `⌘K W` return to the walkthrough, `⌘⌥I` open chat.
- **Learning Profile** (from chat, the Active view, or the command palette) sets your background, language and concept familiarity, what to learn or gloss over, depth, comfort with math, preferred visuals, and narration speed. It is saved locally.
- **History** (the clock icon) lists every turn, including those without walkthroughs. It offers Replay (narration is re-synthesized from the saved script), Details (chat, exposed reasoning summaries, tool outcomes, captured edits, script), Delete, and Delete All. Deleting history never touches project files.

### Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `active.walkthrough.backgroundTimeoutSeconds` | 20 | How long to wait for background tasks after a turn before explaining. Unfinished checks are marked pending, and the tasks keep running. |
| `active.explain.minMeaningfulLines` | 8 | Per-turn threshold for meaningful changes. Turns are assessed independently and never accumulate. |
| `active.explain.draftQuietSeconds` | 6 | Quiet period before drafting while the agent is still working. |
| `active.muse.binaryPath` / `active.narration.pythonPath` | – | Tool locations. |

## Architecture

```
active/
  shared/activeProtocol.ts      contract + walkthrough validator (copied into both sides)
  extension/                    built-in extension `active-agent` (Node, extension host)
    agents/                     platform-neutral agent interfaces + Muse Code adapter (museHost.ts)
    tracking/                   workspace mirror, per-turn baseline / ordered edits / net diff, Myers diff
    explain/                    per-turn worthiness, planning prompts, read-only explanation session, validate+repair
    tts/ + resources/           Phonon sidecar (audio in memory only)
    history/                    local history store (content-addressed blobs), learning profile
    controller.ts               orchestration
  workbench/browser/            Code OSS contribution: chat / walkthrough / profile editor panes,
                                player, visuals, History view, Explorer counts, status bar, actions
scripts/                        setup, sync into vscode/, patches, run
demo/                           sample project + scripted scenarios for the test double
```

- **Two sessions.** The coding session runs in the project. The explanation session runs in a separate `muse serve` process whose workspace is a snapshot copy, so it cannot modify the project. It requests a read-only permission profile with `denyUnmatched` approvals and auto-denies any approval request.
- **Change capture.** Active captures changes from file watcher events and from mtime rescans after every tool call, so edits made by shell commands are caught too. Typing in an editor attributes the resulting save to the user. Uncommitted user changes that existed before the turn sit in the baseline, so they stay out of the agent's diff.
- **Immutable playback.** A turn's capture is frozen when the coding turn ends. The walkthrough editor shows read-only `active-snapshot:` models, so later edits never alter it.
- **Pre-generated narration.** As soon as a walkthrough's script is ready, its whole narration is synthesized in the background (in memory only), ordered from the current position and re-prioritized on rewind or skip. Pausing, resuming and jumping never wait on synthesis.
- **Planning.** Worthiness is re-evaluated after every edit. A draft is prepared while the agent is still working and reconciled or revised at the end of the turn. The planner sends the model the task, diffs, numbered source, tool outcomes and exposed reasoning summaries (never hidden chain-of-thought), along with the profile and recent turns. Output is validated against the captured files: ranges are checked, quotes must match the captured code, observed charts must cite evidence, and scenes about reverted work are dropped. Invalid output goes back to the model for repair.
- **Patches to Code OSS** (`scripts/apply_patches.py`, all idempotent):
  - load the contribution
  - allow `blob:` media for in-memory narration audio
  - set `autoplayPolicy` so narration can start on handoff
  - branding

## Tests

```sh
cd active/extension && npm test       # 19 tests
```

These include unit tests for diffing, worthiness (including no accumulation across turns), walkthrough validation, change capture (shell edits, user attribution, pre-existing changes, freezing), history save/replay/delete, and personalization of prompts. An end-to-end test drives the controller through the real `@muse-code/sdk` against the scripted host. It covers the simple, tiny, and multi-file turns, the background timeout, pending checks, immutable captures, and read-only Q&A.

To type-check the workbench contribution: `cd vscode && npx tsc -p src/tsconfig.json --noEmit --skipLibCheck`.

## Limitations

- **Not verified against a live Muse Code host.** The adapter follows the SDK's documented protocol (commands, notifications, approvals, `task/list`, `item/readOutput`) and was exercised only through the SDK against the scripted test host. It still needs a run with an installed, signed-in `muse`.
- **Read-only profile id.** The stable MSP surface doesn't list permission profile ids. Active tries `read-only` / `readOnly` / `read_only` and otherwise falls back to `denyUnmatched`. The snapshot workspace is the main protection either way.
- **Questions while Muse is waiting.** Muse Code's own clarifying questions (`userInput/request`) are cancelled in auto mode.
- **Restoring after a reload.** Chat history is not restored into the chat view after a window reload. Everything is in History, and walkthroughs can be replayed from there. Editors for walkthroughs are not restored across restarts.
- **Narration speed.** Speed is applied at playback (`playbackRate` with preserved pitch). Phonon exposes a single built-in English voice (`default`) in this setup.
- **Large repositories.** The workspace mirror tracks up to 8,000 text files of at most 1 MB each.
