#!/usr/bin/env bash
# DEV ONLY. Launches Active on a fresh, empty workspace whose coding and explanation
# sessions are served by external agents (e.g. Claude Code subagents) through the
# bridge mailbox instead of Muse Code. Agents use active/extension/test-fixtures/bridge-agent.mjs;
# an automated user can drive the window with active/extension/test-fixtures/ui-driver.mjs.
#   scripts/run-bridge-demo.sh <workspace-name> [extra Code OSS args...]
set -euo pipefail
source "$(dirname "$0")/env.sh"
NAME="${1:-bridge-workspace}"
shift || true
WORK="$ACTIVE_ROOT/.active-dev/$NAME"
BRIDGE="$ACTIVE_ROOT/.active-dev/bridge/$NAME"
rm -rf "$WORK" "$BRIDGE" && mkdir -p "$WORK/.vscode" "$BRIDGE"
printf '# %s\n' "$NAME" > "$WORK/README.md"
printf '.venv/\nnode_modules/\n*.sqlite3\n__pycache__/\ndist/\n' > "$WORK/.gitignore"
printf '{\n\t"active.dev.agentBackend": "bridge",\n\t"active.dev.bridgeDir": "%s",\n\t"active.walkthrough.backgroundTimeoutSeconds": 30\n}\n' "$BRIDGE" > "$WORK/.vscode/settings.json"
( cd "$WORK" && git init -q && git add -A && git -c user.email=dev@active -c user.name=dev commit -qm "empty workspace" )
echo "workspace: $WORK"
echo "bridge:    $BRIDGE   (export ACTIVE_BRIDGE_DIR=$BRIDGE)"
exec "$ACTIVE_ROOT/scripts/run.sh" "$WORK" "$@"
