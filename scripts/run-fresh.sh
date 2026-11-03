#!/usr/bin/env bash
# Starts Active as a brand-new install: empty settings, no history, no knowledge
# profile, no saved API key, and Muse Code signed out. Everything lives in a
# throwaway folder (.active-dev/fresh) that is wiped on every run, so your real
# Active data and your real Muse sign-in are never touched.
#
#   scripts/run-fresh.sh [--no-muse] [folder] [extra Code OSS args...]
#
#   --no-muse   also act as if Muse Code isn't installed (setup starts with Install;
#               installing puts Muse into the throwaway home, not your real one)
#   folder      project to open; defaults to a fresh copy of demo/ledger-api
set -euo pipefail
source "$(dirname "$0")/env.sh"

NO_MUSE=0
if [[ "${1:-}" == "--no-muse" ]]; then
	NO_MUSE=1
	shift
fi

FRESH="$ACTIVE_ROOT/.active-dev/fresh"
rm -rf "$FRESH"
mkdir -p "$FRESH/user-data" "$FRESH/extensions" "$FRESH/xdg-config" "$FRESH/xdg-data"

if [[ $# -gt 0 && "${1:0:1}" != "-" ]]; then
	if [[ ! -d "$1" ]]; then
		echo "run-fresh.sh: not a folder: $1" >&2
		exit 1
	fi
	FOLDER="$(cd "$1" && pwd)"
	shift
else
	FOLDER="$FRESH/workspace"
	mkdir -p "$FOLDER"
	cp -R "$ACTIVE_ROOT/demo/ledger-api/." "$FOLDER/"
	( cd "$FOLDER" && git init -q && git add -A && git -c user.email=demo@active -c user.name=demo commit -qm "baseline" )
fi

"$ACTIVE_ROOT/scripts/sync.sh" >/dev/null
( cd "$VSCODE_DIR" && npm run build-fast -- --client-only >/dev/null )

# Muse keeps its sign-in under $XDG_CONFIG_HOME/muse, so a throwaway config home means signed out.
export XDG_CONFIG_HOME="$FRESH/xdg-config"
export XDG_DATA_HOME="$FRESH/xdg-data"
unset META_API_KEY
# Reuse the downloaded narration models instead of fetching it again.
export HF_HOME="${HF_HOME:-$HOME/.cache/huggingface}"
if [[ $NO_MUSE == 1 ]]; then
	# A throwaway home without ~/.local/bin/muse, and a PATH without any muse on it.
	mkdir -p "$FRESH/home"
	CLEAN_PATH=""
	IFS=':' read -r -a PARTS <<< "$PATH"
	for dir in "${PARTS[@]}"; do
		[[ -x "$dir/muse" ]] || CLEAN_PATH="${CLEAN_PATH:+$CLEAN_PATH:}$dir"
	done
	export PATH="$CLEAN_PATH"
	export HOME="$FRESH/home"
fi

echo "Fresh Active: $FOLDER (data in $FRESH)"
exec "$VSCODE_DIR/scripts/code.sh" "$FOLDER" --user-data-dir "$FRESH/user-data" --extensions-dir "$FRESH/extensions" "$@"
