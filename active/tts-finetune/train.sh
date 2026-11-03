#!/usr/bin/env bash
# Fine-tunes MMS English on Kokoro's readings of many transcripts (train_vits.py), then exports the int8 model Active runs.
#   ./train.sh all              everything: setup, dataset (Active's docs + Wikipedia), train, export. Reruns skip what's done.
#   ./train.sh setup            make .venv with the teacher, trainer and export packages
#   ./train.sh data [args...]   make_dataset.py with these arguments (see its --help)
#   ./train.sh train [args...]  train_vits.py (see its --help; --resume continues a stopped run), then export
#   ./train.sh smoke            the whole pipeline in a minute (6 small steps, eval, save, export) to catch errors first
# Environment: VOICE (Kokoro voice, default af_heart), CLIPS (default 800), STEPS (default 1880), OUT (default out/mms-eng-kokoro).
set -euo pipefail
cd "$(dirname "$0")"
SELF="$PWD/$(basename "$0")"  # "$0" may be relative to where it was run from
PY=.venv/bin/python
SETUP_VERSION=3
DATA=data/kokoro-${VOICE:-af_heart}
OUT=${OUT:-out/mms-eng-kokoro}
# The int8 export runs in Active's own narration env (newer transformers) when it's there.
EXPORT_PY=../../.tools/tts-venv/bin/python
export PYTORCH_ENABLE_MPS_FALLBACK=1  # Apple GPU: any op MPS lacks runs on the CPU instead of failing
export PYTHONDONTWRITEBYTECODE=1

export_int8() {
	local py=$EXPORT_PY
	if ! { [ -x "$py" ] && "$py" -c "import onnxscript, transformers" 2>/dev/null; }; then py=$PY; fi
	"$py" export_onnx.py "$1" "$1-int8" --check
	echo "done: to try it, set active.narration.mmsModel to $(cd "$1-int8" && pwd)"
}

case "${1:-}" in
	setup)
		if command -v uv >/dev/null; then
			[ -x "$PY" ] || uv venv --python 3.12 .venv -q
			VIRTUAL_ENV=.venv uv pip install -q -r requirements.txt
		else
			[ -x "$PY" ] || python3 -m venv .venv
			.venv/bin/pip install -q -r requirements.txt
		fi
		echo "$SETUP_VERSION" > .venv/.active-ready
		echo "setup done"
		;;
	data)
		shift
		"$PY" make_dataset.py "$@"
		;;
	train)
		shift
		# caffeinate keeps a Mac awake for the length of the run.
		WAKE=()
		if command -v caffeinate >/dev/null; then WAKE=(caffeinate -i); fi
		"${WAKE[@]}" "$PY" train_vits.py --data "$DATA" --out "$OUT" --steps "${STEPS:-1880}" "$@"
		export_int8 "$OUT"
		;;
	smoke)
		rm -rf out/smoke out/smoke-int8
		"$PY" train_vits.py --data "$DATA" --out out/smoke --steps 6 --batch 4 --val-clips 4 --log-every 2 --eval-every 3 --save-every 3
		export_int8 out/smoke
		;;
	all)
		[ "$(cat .venv/.active-ready 2>/dev/null)" = "$SETUP_VERSION" ] || "$SELF" setup
		if [ ! -f "$DATA/metadata.csv" ]; then
			# Active's own docs (its vocabulary) for up to half the clips, Wikipedia for the rest.
			DOCS=()
			while IFS= read -r doc; do DOCS+=("../../$doc"); done < <(git -C ../.. ls-files '*.md' ':!:vscode/*')
			"$SELF" data --out "$DATA" --voice "${VOICE:-af_heart}" --limit "${CLIPS:-800}" --wikitext "${DOCS[@]}"
		fi
		"$SELF" train
		;;
	*)
		sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'
		exit 1
		;;
esac
