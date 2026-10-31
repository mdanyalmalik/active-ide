#!/usr/bin/env bash
# Downloads the debuggers Active ships (pinned in debuggers.json, checksums verified):
#   debugpy (Python) into the agent extension's vendor folder, and CodeLLDB (C, C++, Rust) as a built-in extension.
# Delve (Go) isn't downloaded here: Active installs it with the developer's Go toolchain the first time it's needed.
set -euo pipefail
source "$(dirname "$0")/env.sh"
MANIFEST="$ACTIVE_ROOT/scripts/debuggers.json"
CACHE="$VSCODE_DIR/.build/active-debuggers"
mkdir -p "$CACHE"

field() { node -e "const m=require('$MANIFEST');const v=$1;process.stdout.write(String(v ?? ''))"; }

fetch() { # url sha256 destination
	if [ -f "$3" ] && [ "$(shasum -a 256 "$3" | cut -d' ' -f1)" = "$2" ]; then
		return
	fi
	echo "Downloading $(basename "$1")…"
	curl -fsSL -o "$3.part" "$1"
	if [ "$(shasum -a 256 "$3.part" | cut -d' ' -f1)" != "$2" ]; then
		rm -f "$3.part"
		echo "setup-debuggers: checksum mismatch for $1" >&2
		exit 1
	fi
	mv "$3.part" "$3"
}

# Python: debugpy's pure-Python wheel (runs its adapter and the debuggee side with the project's own Python).
DEBUGPY_VERSION="$(field 'm.debugpy.version')"
VENDOR="$ACTIVE_ROOT/active/extension/vendor"
if [ "$(cat "$VENDOR/debugpy.version" 2>/dev/null)" != "$DEBUGPY_VERSION" ]; then
	fetch "$(field 'm.debugpy.url')" "$(field 'm.debugpy.sha256')" "$CACHE/debugpy.whl"
	rm -rf "$VENDOR/debugpy"
	mkdir -p "$VENDOR"
	unzip -q -o "$CACHE/debugpy.whl" 'debugpy/*' -d "$VENDOR"
	echo "$DEBUGPY_VERSION" > "$VENDOR/debugpy.version"
	echo "debugpy $DEBUGPY_VERSION ready"
fi

# C, C++, Rust: CodeLLDB for this platform, unpacked where Code OSS loads built-in extensions from.
case "$(uname -s)-$(uname -m)" in
	Darwin-arm64) TARGET=darwin-arm64 ;;
	Darwin-x86_64) TARGET=darwin-x64 ;;
	Linux-aarch64 | Linux-arm64) TARGET=linux-arm64 ;;
	Linux-armv7l) TARGET=linux-armhf ;;
	Linux-x86_64) TARGET=linux-x64 ;;
	MINGW* | MSYS* | CYGWIN*) TARGET=win32-x64 ;;
	*) TARGET="" ;;
esac
LLDB_NAME="$(field 'm.codelldb.name')"
LLDB_VERSION="$(field 'm.codelldb.version')"
LLDB_DIR="$VSCODE_DIR/.build/builtInExtensions/$LLDB_NAME"
if [ -z "$TARGET" ]; then
	echo "setup-debuggers: no CodeLLDB build for $(uname -s)-$(uname -m); C, C++ and Rust traces will be read from the source only."
elif [ "$(node -p "try{require('$LLDB_DIR/package.json').version}catch{''}")" != "$LLDB_VERSION" ]; then
	fetch "$(field "m.codelldb.urlTemplate.replace('{target}', '$TARGET')")" "$(field "m.codelldb.sha256['$TARGET']")" "$CACHE/codelldb.vsix"
	rm -rf "$LLDB_DIR" "$CACHE/codelldb"
	unzip -q -o "$CACHE/codelldb.vsix" 'extension/*' -d "$CACHE/codelldb"
	mkdir -p "$(dirname "$LLDB_DIR")"
	mv "$CACHE/codelldb/extension" "$LLDB_DIR"
	rm -rf "$CACHE/codelldb"
	echo "CodeLLDB $LLDB_VERSION ($TARGET) ready"
fi
