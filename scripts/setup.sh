#!/usr/bin/env bash
# One-time setup on macOS: Node 24, Code OSS 1.143.1 + dependencies, Electron, narration (MMS), the shipped debuggers,
# and Active's sources. Checks what it needs first, so it fails in seconds rather than partway through.
set -euo pipefail
source "$(dirname "$0")/env.sh"
NEED_GB=12
START=$SECONDS

step() { printf '\n\033[1m[%s/6] %s\033[0m\n' "$1" "$2"; }
fail() { printf '\033[31m%s\033[0m\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- preflight
[ "$(uname -s)" = Darwin ] || fail "Active's setup supports macOS only."
command -v git >/dev/null || fail "git is missing. Install Xcode's command-line tools: xcode-select --install"
xcode-select -p >/dev/null 2>&1 || fail "Xcode's command-line tools are missing (VS Code's native modules need them). Run: xcode-select --install"
command -v curl >/dev/null || fail "curl is missing."
if ! command -v uv >/dev/null; then
	python3 -c 'import sys, venv; sys.exit(sys.version_info < (3, 9))' 2>/dev/null \
		|| fail "Narration needs Python 3.9 or newer with venv (or uv). Install one: brew install python, or https://docs.astral.sh/uv/"
fi
if [ ! -d "$VSCODE_DIR/node_modules" ]; then
	free_gb=$(df -g "$ACTIVE_ROOT" | awk 'NR == 2 { print $4 }')
	[ "${free_gb:-0}" -ge "$NEED_GB" ] || fail "Setup needs about $NEED_GB GB free here; there are ${free_gb} GB."
fi
mkdir -p "$ACTIVE_ROOT/.tools"
echo "Setting up Active."

# ---------------------------------------------------------------- steps
step 1 "Node $NODE_VERSION"
if [ ! -x "$NODE_DIR/bin/node" ]; then
	ARCHIVE="node-v$NODE_VERSION-darwin-$(uname -m | sed 's/x86_64/x64/').tar.gz"
	curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/$ARCHIVE" | tar xz -C "$ACTIVE_ROOT/.tools"
	export PATH="$NODE_DIR/bin:$PATH"
fi

step 2 "Code OSS $VSCODE_TAG source"
if [ ! -d "$VSCODE_DIR" ]; then
	git clone --depth 1 --branch "$VSCODE_TAG" https://github.com/microsoft/vscode "$VSCODE_DIR"
fi

step 3 "Narration (MMS English)"
"$ACTIVE_ROOT/scripts/setup-tts.sh"

step 4 "Debuggers"
"$ACTIVE_ROOT/scripts/setup-debuggers.sh"

step 5 "Active's sources and patches"
"$ACTIVE_ROOT/scripts/sync.sh"

step 6 "Code OSS dependencies, Electron and build"
cd "$VSCODE_DIR"
[ -d node_modules ] || npm ci
npm run electron
npm run build-fast

printf '\nSetup complete in %d min. Run: scripts/run.sh /path/to/project\n' $(((SECONDS - START + 59) / 60))
