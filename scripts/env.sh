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
# Local run data (user-data folders, demo workspaces) lives in $ACTIVE_ROOT/.active-dev. macOS caps a
# socket path at 103 characters and Code OSS puts its main socket in the user-data folder, so a deep
# clone would fail to start. When the folder's path is long, the scripts reach it through a short link,
# ~/.active-ide/<id>, instead (Code OSS doesn't resolve links in --user-data-dir). Nothing moves.
ACTIVE_DATA="$ACTIVE_ROOT/.active-dev"
if [ ${#ACTIVE_DATA} -gt 65 ]; then   # 103 minus the longest socket path below it (scripted-user-data/1.14-main.sock), with a margin
	mkdir -p "$ACTIVE_DATA"
	link="$HOME/.active-ide/$(printf %s "$ACTIVE_ROOT" | shasum | cut -c1-8)"
	mkdir -p "$HOME/.active-ide"
	[ "$(readlink "$link" 2>/dev/null)" = "$ACTIVE_DATA" ] || ln -sfn "$ACTIVE_DATA" "$link"
	ACTIVE_DATA="$link"
fi
# Code OSS's .npmrc carries Electron build options (disturl, target, runtime, …) that native modules
# need; npm 11 still passes them on but warns "Unknown project config" on every command. Real errors
# still print.
export npm_config_loglevel="${npm_config_loglevel:-error}"
