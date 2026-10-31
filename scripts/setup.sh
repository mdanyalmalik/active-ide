#!/usr/bin/env bash
# One-time setup: Node 24, Code OSS 1.143.1 + dependencies, Electron, Phonon TTS, the shipped debuggers, and Active's sources.
set -euo pipefail
source "$(dirname "$0")/env.sh"
mkdir -p "$ACTIVE_ROOT/.tools"

if [ ! -x "$NODE_DIR/bin/node" ]; then
	echo "Downloading Node $NODE_VERSION (Code OSS $VSCODE_TAG requires Node 24)…"
	ARCHIVE="node-v$NODE_VERSION-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/').tar.gz"
	curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$ARCHIVE" | tar xz -C "$ACTIVE_ROOT/.tools"
	export PATH="$NODE_DIR/bin:$PATH"
fi

if [ ! -d "$VSCODE_DIR" ]; then
	git clone --depth 1 --branch "$VSCODE_TAG" https://github.com/microsoft/vscode "$VSCODE_DIR"
fi

"$ACTIVE_ROOT/scripts/setup-tts.sh"
"$ACTIVE_ROOT/scripts/setup-debuggers.sh"
"$ACTIVE_ROOT/scripts/sync.sh"

cd "$VSCODE_DIR"
[ -d node_modules ] || npm ci
npm run electron
npm run build-fast
echo "Setup complete. Run: scripts/run.sh /path/to/project"
