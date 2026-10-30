#!/usr/bin/env bash
# Copies Active's sources into the Code OSS checkout and applies its patches.
set -euo pipefail
source "$(dirname "$0")/env.sh"

CONTRIB="$VSCODE_DIR/src/vs/workbench/contrib/active"
EXT="$VSCODE_DIR/extensions/active-agent"

mkdir -p "$CONTRIB/common" "$CONTRIB/browser" "$EXT"
rsync -a --delete "$ACTIVE_ROOT/active/workbench/browser/" "$CONTRIB/browser/"
mkdir -p "$CONTRIB/test"
rsync -a --delete "$ACTIVE_ROOT/active/workbench/test/" "$CONTRIB/test/"
cp "$ACTIVE_ROOT/active/shared/activeProtocol.ts" "$CONTRIB/common/activeProtocol.ts"
mkdir -p "$ACTIVE_ROOT/active/extension/src/shared"
cp "$ACTIVE_ROOT/active/shared/activeProtocol.ts" "$ACTIVE_ROOT/active/extension/src/shared/activeProtocol.ts"

# Build the built-in extension (its own tsc; the SDK is its only runtime dependency).
( cd "$ACTIVE_ROOT/active/extension" && { [ -d node_modules ] || npm install --no-audit --no-fund; } && npx tsc -p . )
rsync -a --delete --exclude /src --exclude /tsconfig.json "$ACTIVE_ROOT/active/extension/" "$EXT/"

python3 "$ACTIVE_ROOT/scripts/apply_patches.py" "$VSCODE_DIR"
echo "Active synced into $VSCODE_DIR"
