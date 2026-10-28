#!/usr/bin/env bash
# Shared paths for Active's scripts. Code OSS 1.143.1 requires Node 24.
ACTIVE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VSCODE_DIR="$ACTIVE_ROOT/vscode"
VSCODE_TAG="1.143.1"
NODE_VERSION="24.18.0"
NODE_DIR="$ACTIVE_ROOT/.tools/node-v$NODE_VERSION-$(uname -s | tr '[:upper:]' '[:lower:]')-$(uname -m | sed 's/x86_64/x64/')"
if [ -x "$NODE_DIR/bin/node" ]; then
	export PATH="$NODE_DIR/bin:$PATH"
fi
