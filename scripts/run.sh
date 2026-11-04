#!/usr/bin/env bash
# Launches Active (Code OSS dev build) on a folder, using the real Muse Code CLI.
#   scripts/run.sh [folder] [extra Code OSS args...]
#   ACTIVE_USER_DATA=<dir> uses another user-data folder (default .active-dev/user-data; see env.sh).
set -euo pipefail
source "$(dirname "$0")/env.sh"
FOLDER="${1:-$PWD}"
shift || true
# code.sh changes directory before launching, so relative paths must be resolved here.
if [ ! -d "$FOLDER" ]; then
	echo "run.sh: not a folder: $FOLDER" >&2
	exit 1
fi
FOLDER="$(cd "$FOLDER" && pwd)"
"$ACTIVE_ROOT/scripts/sync.sh" >/dev/null
( cd "$VSCODE_DIR" && npm run build-fast -- --client-only >/dev/null )
exec "$VSCODE_DIR/scripts/code.sh" "$FOLDER" --user-data-dir "${ACTIVE_USER_DATA:-$ACTIVE_DATA/user-data}" --extensions-dir "$ACTIVE_DATA/extensions" "$@"
