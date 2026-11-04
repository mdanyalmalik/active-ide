#!/usr/bin/env bash
# Launches Active against the SCRIPTED TEST HOST (not Muse Code) on a fresh copy of
# demo/ledger-api, to exercise the UI without a Muse Code subscription. The chat
# header and logs identify the host as "scripted-muse-host (test double)".
#   scripts/run-scripted-demo.sh [extra Code OSS args...]
set -euo pipefail
source "$(dirname "$0")/env.sh"
WORK="$ACTIVE_ROOT/.active-dev/demo-workspace"
rm -rf "$WORK" && mkdir -p "$WORK"
cp -R "$ACTIVE_ROOT/demo/ledger-api/." "$WORK/"
( cd "$WORK" && git init -q && git add -A && git -c user.email=demo@active -c user.name=demo commit -qm "demo baseline" )
HOST="$ACTIVE_ROOT/active/extension/test-fixtures/scripted-muse-host.mjs"
chmod +x "$HOST"
mkdir -p "$WORK/.vscode"
printf '{\n\t"active.walkthrough.backgroundTimeoutSeconds": 8\n}\n' > "$WORK/.vscode/settings.json"
# active.muse.binaryPath is machine-scoped (ignored in workspace settings), so the test host is set in a
# separate user-data folder: the real Muse CLI is never started and your usual profile is left alone.
USER_DATA="$ACTIVE_DATA/scripted-user-data"
mkdir -p "$USER_DATA/User"
printf '{\n\t"security.workspace.trust.enabled": false,\n\t"active.muse.binaryPath": "%s"\n}\n' "$HOST" > "$USER_DATA/User/settings.json"
( cd "$WORK" && git add -A && git -c user.email=demo@active -c user.name=demo commit -qm "demo settings" )
export ACTIVE_SCRIPTED_SCENARIO="$ACTIVE_ROOT/demo/scenarios/ledger.json"
export ACTIVE_SCRIPTED_SPEED="${ACTIVE_SCRIPTED_SPEED:-1}"
export ACTIVE_USER_DATA="$USER_DATA"
exec "$ACTIVE_ROOT/scripts/run.sh" "$WORK" "$@"
