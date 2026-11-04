# Active

Active is a Code OSS–based IDE that keeps you informed while an AI agent codes: every meaningful change comes with a narrated walkthrough, tuned to what you already know. It's for developers at any stage of their career who want to follow along with the agent's work rather than review it blind. It was built for the Meta Global Hackathon.

You give Muse Code a task in a chat that fills the work area. The explanation model decides, from your knowledge profile, whether and how much to explain: nothing, a short note in chat, or an inline walkthrough. Long tasks are explained in chapters as each piece of work is finished. A walkthrough pops up from chat: the captured code sits in the native editor, and an explanation zone next to the relevant lines switches between code, diffs, equations, diagrams and charts, in step with on-device narration (MMS English, int8).

## Setup

Requirements: macOS, Xcode's command-line tools (`xcode-select --install`), Python 3.9+ (or `uv`), and about 12 GB of free disk space. Setup checks these first. A first run takes about 15–30 minutes, mostly building Code OSS.

```sh
scripts/setup.sh            # Node 24 (local), Code OSS 1.143.1, deps, Electron, narration (MMS), debuggers, Active sources
```

### Muse Code (coding and explanation)

Active drives Muse Code through the official [`@muse-code/sdk`](https://github.com/meta-models/muse-code-sdk) (1.4.14), which runs `muse serve` and speaks the Muse Session Protocol. You don't need to set it up by hand. When Active can't find `muse`, chat shows a setup panel:

1. **Install.** Active shows the exact command it will run (Meta's official installer, with a link to read the script). When you agree, it runs the installer in the background with a progress bar and an expandable log.
2. **Choose how to sign in.** Pick your Muse subscription or a Meta API key.
3. **Sign in.**
   - Subscription: Active runs `muse login` in a hidden pseudo-terminal. Muse opens its device-code page in your browser, and Active shows the code to confirm and reconnects once you approve.
   - API key: the key goes into a secure field, is stored in the system keychain, and is passed to Muse as `META_API_KEY`.

Active then connects. If Muse later reports `authRequired`, the sign-in step comes back. To change accounts, run **Active: Sign In to Coding Agent or Switch Account**. Active never reads or copies Muse's own credentials.

If you'd rather do it yourself: `curl -fsSL https://dev.meta.ai/install.sh | sh` (on Windows: `irm https://dev.meta.ai/install.ps1 | iex`), run `muse` once to sign in, and set `active.muse.binaryPath` if `muse` lives somewhere unusual.

### Other coding agents

The agent integration is provider-based (`active/extension/src/agents/providers.ts`). A provider describes:
- how to find and install its CLI
- its sign-in methods: browser sign-in as an interactive-menu flow or a login command, and the environment variable for an API key
- how to start its sessions and recognize auth failures

Muse Code is the default (`active.agent.provider: "muse"`). Adding another agent such as Claude or ChatGPT means writing one provider plus a session adapter that implements `AgentHost`/`AgentSession`. The setup flow and every UI label take the provider's name.

### Narration (MMS English)

`scripts/setup-debuggers.sh` downloads the debuggers Active ships, pinned with checksums in `scripts/debuggers.json` (all MIT): debugpy 1.8.21 (the last to support Python 3.8+) into `active/extension/vendor`, and CodeLLDB 1.12.3 for this platform into `vscode/.build/builtInExtensions` (`apply_patches.py` lists it in `product.json`). Delve isn't downloaded: Active runs `go install` for it into its storage on the first Go run.

`scripts/setup-tts.sh` creates `.tools/tts-venv` with only what narration needs at run time (onnxruntime, numpy, scipy, num2words: about 170 MB) and downloads the prebuilt int8 model named in `scripts/tts-model.env`, checked against its sha256. Without a download URL, it exports the model itself, which also installs torch and transformers (about 1 GB). Narration then runs on the CPU. To use another interpreter, set `active.narration.pythonPath`.

- **MMS English**: Meta's `facebook/mms-tts-eng` (VITS, ~36M parameters, CC-BY-NC 4.0, one voice). It's exported (`active/tts-finetune/export_onnx.py`) to int8 ONNX in `.tools/tts-models/mms-eng-int8`, with the model's license notice in `NOTICE.txt`. That's 40 MB instead of 145 MB, and it runs on onnxruntime with the sidecar's own tokenizer, so the runtime needs no torch. Compared with torch fp32 on an M-series CPU, it loads in 0.5 s instead of 3.4 s, runs at about 11× realtime instead of 6×, and uses about 290 MB of memory instead of 910 MB. The int8 audio differs from fp32 by less than two fp32 runs differ from each other.
- **Your own model:** `active.narration.mmsModel` takes another int8 folder, such as a fine-tune from [`active/tts-finetune`](active/tts-finetune/README.md). It also accepts a Hugging Face id or checkpoint folder, which runs on torch.
- **Phonon 31M** (Gradium's `ptts`, a native int8 runtime) stays in the code for after the hackathon but is hidden. To use it, run `ACTIVE_PHONON=1 scripts/setup-tts.sh`, then set `"active.narration.engine": "phonon"` in settings.json.

Changing either setting restarts narration right away.

## Run

```sh
scripts/run.sh /path/to/project      # real Muse Code
```

On startup, a welcome popup walks through whatever isn't ready yet: trusting the folder (Muse Code edits files and runs commands, so it only runs in trusted folders), connecting Muse Code, and setting up the knowledge profile. It stops appearing once everything is done, or when you tick **Don't show again**.

### Fresh install

```sh
scripts/run-fresh.sh [--no-muse] [folder]
```

Starts Active as a brand-new install: no settings, history, knowledge profile or saved API key, and Muse Code signed out. Everything lives in `.active-dev/fresh`, which is wiped on every run, so your real Active data and Muse sign-in aren't touched. `--no-muse` also hides the installed Muse, so setup starts with Install (and installs into the throwaway home). Without a folder it opens a fresh copy of `demo/ledger-api`.

### Demo without a Muse Code subscription

```sh
scripts/run-scripted-demo.sh
```

This runs Active against `active/extension/test-fixtures/scripted-muse-host.mjs`. It is a **test double, not Muse Code**: a scripted MSP host that makes real edits and runs real commands in a fresh copy of `demo/ledger-api`, then answers explanation requests with the walkthrough templates in `demo/scenarios/ledger.json`. The chat header shows `scripted-muse-host (test double)`. It uses its own profile in `.active-dev/scripted-user-data`, because the Muse binary path is a machine setting that workspace settings can't override. Try these tasks:

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
- **Walkthrough** controls: Rewind, Pause/Resume and Next at the bottom. At the top right, **History** replays an earlier walkthrough and **Open File** pauses playback and opens the editable file at the focused lines.
- **More detail** on each explanation card pauses the walkthrough and asks the read-only explanation session to re-explain that part in greater depth. The answer streams into the card and is read aloud.
- **Floating buttons**: **Chat** appears whenever chat isn't showing, and **Walkthrough** (the latest explanation) appears whenever a walkthrough isn't showing. Reopening chat always starts on a new coding task; **Ask About** switches to questions about the paused walkthrough.
- **Pending checks** (background commands that outlasted the timeout) update live on the cards when they finish or fail, and the result is saved to history.
- **Detail feedback**: now and then, at the end of a walkthrough, Active asks whether the detail was too much, about right, or too little. Each answer nudges the general detail preference a little (a full step changes the depth setting) and moves the profile's knowledge of the walkthrough's topics more.
- **Voices**: click the narration item in the status bar (or **Active: Choose Narration Voice**) to preview and pick a voice. MMS has one.
- **Default keybindings**, all rebindable in Keyboard Shortcuts:
  - With the walkthrough focused: `Space`/`K` pause or resume, `←`/`J` rewind, `→`/`L` advance, `C` open chat, `O` open file.
  - Anywhere: `⌘K C` open chat about the walkthrough, `⌘K W` return to the walkthrough, `⌘⌥I` open chat.
- **Settings** (the gear next to the chat input or in a walkthrough's header, **Active: Open Settings**, or the **Active** section at the top of Settings): the model and reasoning effort for the coding agent and for explanations (explanations default to `Low`, which keeps walkthroughs to about 20 seconds), narration voice and speed, and Active's other options. The coding agent's model and effort are also one click away next to the chat input.
- **Chats**: each chat is one Muse Code session. Active reopens the last chat used in a folder, with its transcript, when it starts. **New Chat** and **Chats** (resume an earlier chat from this folder) are in the chat header and the command palette.
- **Explanation mode** (bottom left of the chat box): **Auto** pops explanations up as work finishes; **Away** holds them and, when you switch back, shows a short briefing (what got done, what needs you, what's unresolved, where to pick up) with the walkthroughs one click away; **Off** makes no explanations. **Active: Catch Me Up** shows the briefing on demand.
- **Tabs**: chat, each walkthrough, the System Map and the Knowledge Profile are ordinary editor tabs, and they come back when the window reloads (a walkthrough at the scene it was on). Switching to a walkthrough's tab resumes that walkthrough where you left it.
- **Knowledge Profile** (from the welcome popup, chat, the Active view, or the command palette) sets your background, language and concept familiarity, what to follow closely or skim past, depth, comfort with math, and preferred visuals. It is saved locally.
- **Quick skips**: pressing Next before half of a scene has been narrated (within 6 seconds of it appearing) is taken as a very slight hint that you already knew its topics; their familiarity moves up a tenth of a step.
- **History** (the clock icon) lists every turn, including those without walkthroughs. It offers Replay (narration is re-synthesized from the saved script), Details (chat, exposed reasoning summaries, tool outcomes, captured edits, script), Delete, and Delete All. Deleting history never touches project files.
- **System Map** (**Active: Open System Map**, the floating button, or the link on each update in chat): a separate diagram agent draws the project's components and how they connect. The wheel zooms, dragging pans, and boxes can be dragged. Clicking a box or arrow describes it, lists the code it cites (outlined in Explorer), and offers **Ask About This**, which opens chat set to ask about it. ⌘-click (Ctrl-click) or ⌘-drag picks several boxes and arrows to ask about together. The pencil in a box's or arrow's popup edits its name, summary, description or label in place (saved as a new version at once, and kept by later updates). **Restructure** in the header is for bigger changes: it opens chat set to describe them (split or merge parts, regroup, change the level of detail), and the diagram agent makes the change, still true to the code, and replies with what it did. The pill next to the title shows whether the map is **Auto-updating**, on **Manual updates** (only **Check Now**), or **Updates off**, and clicking it changes that for the folder. Earlier versions are in the History dropdown.
- **Debugger for the coding agent** (`active.debug.agentTools`, on by default): Muse gets five tools from a small Active MCP server on localhost (token-protected, given to each agent's coding session only, with the debugger running in that agent's folder or worktree). `debug_run_with_logpoints` runs a test with temporary logpoints and returns the values in the order the lines ran, without editing files; `debug_start`, `debug_step`, `debug_evaluate` and `debug_stop` pause at breakpoints to read the stack (async callers included) and variables. Runs use each language's debugger, hidden from the debug view (a Code OSS patch keeps js-debug's child sessions hidden too), never while you're debugging, and are cleaned up at the end of each turn. When Muse looks stuck (the same test failing twice, three failed runs, or print statements added) Active suggests the debugger once per turn (`active.debug.suggestWhenStuck`). Chat shows the calls in words ("Debugging: ran `npm test` with 2 logpoints"), and their results reach the walkthrough planner as evidence. Languages: JavaScript and TypeScript (VS Code's js-debug), Python (debugpy, shipped in the agent extension and run with the project's own Python or virtual environment), Go (Delve, which Active installs with your Go toolchain the first time it's needed) and C, C++ and Rust (CodeLLDB, shipped as a built-in extension). Outside JavaScript, a command is one plain command (`pytest -k retry`, `go test ./pkg -run TestX`, `cargo test --lib name`, `./build/tests`).
- **Several agents at once**: **New Agent** starts another coding agent in its own git worktree (a copy of the project on its own branch, made from your folder as it is, uncommitted files included). Agents show as small cards beside or under the chat box; scroll past the end of the chat to zoom out to a grid of every agent, with live boxes (what it's saying, its plan, approvals, cost) that you can move and resize, layout presets and an overflow toggle (Shift+scroll to pan). The chat box sends to the highlighted agent, and the Explorer, Search, Source Control, terminals and open files follow its worktree without reloading. Drag one box onto another to merge its work in, as if it had been that agent's subagent (conflicts go to the target agent to resolve). Muse's own subagents show nested under their agent. Each agent has its own explanation mode and approval mode (Auto: Muse's sandbox with its AI judge asking you only when unsure; Ask more; Allow everything), and an agent that needs approval while you're elsewhere raises a notification you can answer from; explanations say whose work they are and which parts a subagent did, overlapping changes are flagged, and Catch Me Up covers every agent. Needs a git repository; no limit on agents unless you set `active.agents.max`.
- **Ask about code, or request a change**: selecting text in any file shows two buttons above the selection (below it when there's no room, and clear of the lightbulb). **Ask about this** opens chat set to ask the explainer about those lines ("Ask About client.js loc 3–8"); **Request a change** opens it set to send the coding agent a task with those lines as context ("Request a Change · Using client.js loc 3–8"): the change can be to that code or elsewhere based on it. Explanation cards have **Request a change** too, with the card's lines and what it explained as the context.
- **Code traces (preview)** (**Code Trace** in the bottom-right menu): one tab with a question box (and an optional command that runs the path) and the history of past traces. The explainer follows a behavior through the code as steps (checked against the real files), with shapes where the path divides: forks where one path runs depending on a condition (the run shows which was taken; the others are marked not taken), forks where every path runs (several listeners, parallel work), steps that repeat, and paths that end early. Active observes it by running a test, or a small JavaScript or Python driver script the explainer writes (run from a temp folder outside the project), under that language's debugger with a logpoint on each step. The Trace tab shows the steps top to bottom with their code, how each leads to the next, and whether each ran, how often and with what values; a rail lists the steps and follows the scroll. Traces are saved, listed in the history, and the tab comes back after a reload.

### Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `active.walkthrough.backgroundTimeoutSeconds` | 20 | How long to wait for background tasks after a turn before explaining. Unfinished checks are marked pending, and the tasks keep running. |
| `active.explain.checkpointMinutes` | 5 | Minimum minutes between asking whether finished work is ready for a chapter. |
| `active.explain.chapterMinutes` | 10 | At most one chapter per this many minutes; shorter tasks get one explanation at the end. |
| `active.explain.queueChapters` | true | A chapter that's ready while you watch the previous one waits until it ends. |
| `active.explain.preferNotesForSmallChanges` | true | Small changes and short requests lean toward a note in chat. |
| `active.narration.mmsModel` | – | MMS model: an int8 ONNX folder, or a Hugging Face id or checkpoint (torch). Empty uses the installed stock export. |
| `active.muse.binaryPath` / `active.narration.pythonPath` | – | Tool locations. |

## Architecture

```
active/
  shared/activeProtocol.ts      contract + walkthrough validator (copied into both sides)
  extension/                    built-in extension `active-agent` (Node, extension host)
    agents/                     platform-neutral agent interfaces + Muse Code adapter (museHost.ts)
    tracking/                   workspace mirror, per-turn baseline / ordered edits / net diff, Myers diff
    explain/                    per-turn worthiness, planning prompts, read-only explanation session, validate+repair
    tts/ + resources/           narration sidecars (audio in memory only)
    history/                    local history store (content-addressed blobs), knowledge profile
    controller.ts               orchestration
  workbench/browser/            Code OSS contribution: chat / walkthrough / profile editor panes,
                                player, visuals, History view, Explorer counts, status bar, actions
  tts-finetune/                 fine-tune MMS on a better teacher TTS (offline, not shipped)
scripts/                        setup, sync into vscode/, patches, run
demo/                           sample project + scripted scenarios for the test double
```

- **Two sessions.** Both run in the project, in separate `muse serve` processes. The explanation session starts under Muse Code's built-in read-only permission profile (`:read-only`, "Reads files only", enforced by Muse's sandbox) with `denyUnmatched` approvals, and Active auto-denies any approval request. If Muse doesn't accept the profile, Active refuses to start the explanation session rather than run one that could write. Prompts treat the captured versions as authoritative, since the live project can change while the explainer reads it.
- **Change capture.** Active captures changes from file watcher events and from mtime rescans after every tool call, so edits made by shell commands are caught too. Typing in an editor attributes the resulting save to the user. Uncommitted user changes that existed before the turn sit in the baseline, so they stay out of the agent's diff.
- **Immutable playback.** A turn's capture is frozen when the coding turn ends. The walkthrough editor shows read-only `active-snapshot:` models, so later edits never alter it.
- **Pre-generated narration.** As soon as a walkthrough's script is ready, its whole narration is synthesized in the background (in memory only), ordered from the current position and re-prioritized on rewind or skip. Pausing, resuming and jumping never wait on synthesis.
- **Planning.** Code only checks that a change has something meaningful in it; the explanation model decides whether to explain and at what length. At the agent's checkpoints (progress updates, finished test runs) a cheap question asks whether finished work is ready for a chapter. The final explanation starts as soon as the agent gives its final answer and is reconciled or revised when the turn completes. The planner sends the model the task, diffs, numbered source, tool outcomes and exposed reasoning summaries (never hidden chain-of-thought), along with the profile and recent turns. Output is validated against the captured files: ranges are checked, quotes must match the captured code, observed charts must cite evidence, and scenes about reverted work are dropped. Invalid output goes back to the model for repair.
- **Patches to Code OSS** (`scripts/apply_patches.py`, all idempotent):
  - load the contribution
  - allow `blob:` media for in-memory narration audio
  - set `autoplayPolicy` so narration can start on handoff
  - put Active's settings first in the Settings editor
  - add a filter to the file decorations service (`registerDecorationsFilter`), so the Explorer's "Agent" mode can hide git's change decorations in the Explorer, tabs and breadcrumbs
  - expose the Explorer's tree (`ExplorerView.activeTree`) and a row's position (`AsyncDataTree.getElementTop`), so a walkthrough can outline the file it's showing and open the folders on the way
  - keep the coding agent's hidden debug sessions hidden: js-debug's child sessions inherit `suppressDebugView`/`Toolbar`/`Statusbar` from their parent, and a hidden session never opens the Debug Console or takes focus when it pauses
  - allow Active's code colouring (`activeCodeTokenizer`) in the workbench's trusted-types list
  - branding, including the app icon (`python3 active/branding/build_icon.py` builds `icon.svg`, `Active.icns` and `icon-512.png` from `source.svg`)

## Tests

```sh
cd active/extension && npm test       # 139 tests (extension: multi-agent worktrees, merging and overlaps, prompts, notes, memory, explainer queue, git and agent change counts, the diagram agent, the debug tools and languages, code traces, flows)
scripts/sync.sh && (cd vscode && npm run build-fast -- --client-only && \
  VSCODE_SKIP_PRELAUNCH=1 ./scripts/test.sh --run src/vs/workbench/contrib/active/test/browser/walkthroughPlayer.test.ts \
  --run src/vs/workbench/contrib/active/test/browser/decorationsFilter.test.ts \
  --run src/vs/workbench/contrib/active/test/browser/explorerGuide.test.ts \
  --run src/vs/workbench/contrib/active/test/browser/systemMapLayout.test.ts)
                                      # 61 tests (agent grid layout and scroll gesture, worktree following, walkthrough player, with and without audio, and read-aloud clips with fake audio; the decorations filter; Explorer folder animations; system map layout)
```

These include unit tests for diffing, worthiness (including no accumulation across turns), walkthrough validation, change capture (shell edits, user attribution, pre-existing changes, freezing), history save/replay/delete, and personalization of prompts. An end-to-end test drives the controller through the real `@muse-code/sdk` against the scripted host. It covers the simple, tiny, and multi-file turns, the background timeout, pending checks, immutable captures, and read-only Q&A.

To check real Muse Code without launching Active (sign-in, one coding turn, one read-only turn, plan usage before and after): `node scripts/muse-check.mjs`. Add `--dry-run` to use Muse's offline echo provider, which needs no sign-in or credits.

To type-check the workbench contribution: `cd vscode && npx tsc -p src/tsconfig.json --noEmit --skipLibCheck`.

## Limitations

- **Only partly verified against live Muse Code.** `scripts/muse-check.mjs` drives Active's Muse adapter against a signed-in Muse Code 1.4.14 (connection, a coding turn with approvals, and a read-only turn whose write attempts were refused). A full walkthrough through the Active UI with live Muse hasn't been run yet.
- **Questions while Muse is waiting.** Muse Code's own clarifying questions (`userInput/request`) are cancelled in auto mode.
- **Hidden browser sign-in reads `muse login` output.** Active looks for the sign-in URL, the code, and the "Press Enter to open it in your browser" prompt, and treats exit code 0 as success. This was checked against Muse Code 1.4.14 up to the approval step. A later release that changes this output could break it; Active then shows a clear error and offers the API-key route. It isn't available on Windows yet, where it falls back to API keys.
- **Restoring after a reload.** Chat history is not restored into the chat view after a window reload. Everything is in History, and walkthroughs can be replayed from there. Open tabs (including walkthroughs) do come back.
- **Narration speed.** Speed is applied at playback (`playbackRate` with preserved pitch). Catalog voices need a network connection the first time each is used; the built-in voice works offline.
- **Large repositories.** The workspace mirror tracks up to 8,000 text files of at most 1 MB each.
