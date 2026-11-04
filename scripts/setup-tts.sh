#!/usr/bin/env bash
# Creates a small Python env for on-device narration with MMS English (Meta's facebook/mms-tts-eng, CC-BY-NC 4.0),
# run as an int8 ONNX folder (.tools/tts-models/mms-eng-int8, about 40 MB) on onnxruntime. Runtime packages only:
# about 100 MB.
#
# The model folder comes from MMS_INT8_URL in scripts/tts-model.env (a prebuilt zip, checked against its sha256).
# Without a URL, or if the download fails, it's exported here from Hugging Face instead, which needs torch and
# transformers (about 1 GB more, installed only then).
#
# ACTIVE_PHONON=1 also installs Phonon 31M (Gradium's `ptts`, Apache-2.0), which is hidden until after the hackathon.
set -euo pipefail
source "$(dirname "$0")/env.sh"
source "$ACTIVE_ROOT/scripts/tts-model.env"
VENV="$ACTIVE_ROOT/.tools/tts-venv"
MMS_INT8="$ACTIVE_ROOT/.tools/tts-models/mms-eng-int8"
RUNTIME=(onnxruntime numpy scipy num2words)
EXPORT=(torch transformers onnx onnxscript)

install() {
	if command -v uv >/dev/null; then
		VIRTUAL_ENV="$VENV" uv pip install -q "$@"
	else
		"$VENV/bin/pip" install -q "$@"
	fi
}

if [ ! -x "$VENV/bin/python" ]; then
	if command -v uv >/dev/null; then
		uv venv --python 3.12 "$VENV" -q
	else
		python3 -m venv "$VENV"
	fi
fi
"$VENV/bin/python" -c "import onnxruntime, numpy, scipy, num2words" 2>/dev/null || install "${RUNTIME[@]}"

# Fetch or export when the folder is missing or from an older recipe (see RECIPE in export_onnx.py).
RECIPE=$(sed -n 's/^RECIPE = //p' "$ACTIVE_ROOT/active/tts-finetune/export_onnx.py")
HAVE=$("$VENV/bin/python" -c "import json,sys; print(json.load(open(sys.argv[1])).get('recipe', 1))" "$MMS_INT8/active-mms.json" 2>/dev/null || echo 0)
if [ ! -f "$MMS_INT8/model.int8.onnx" ] || [ "$HAVE" != "$RECIPE" ]; then
	fetched=0
	if [ -n "${MMS_INT8_URL:-}" ] && [ "$MMS_INT8_RECIPE" = "$RECIPE" ]; then
		zip="$(mktemp -t mms-int8).zip"
		if curl -fsSL "$MMS_INT8_URL" -o "$zip" && [ "$(shasum -a 256 "$zip" | cut -d' ' -f1)" = "$MMS_INT8_SHA256" ]; then
			rm -rf "$MMS_INT8" && mkdir -p "$MMS_INT8" && unzip -q -o "$zip" -d "$MMS_INT8" && fetched=1
		else
			echo "Couldn't download the prebuilt MMS model (or its checksum didn't match); exporting it instead."
		fi
		rm -f "$zip"
	fi
	if [ "$fetched" = 0 ]; then
		"$VENV/bin/python" -c "import torch, transformers, onnx, onnxscript" 2>/dev/null || install "${EXPORT[@]}"
		"$VENV/bin/python" "$ACTIVE_ROOT/active/tts-finetune/export_onnx.py" facebook/mms-tts-eng "$MMS_INT8" 2>&1 | grep -E "^wrote|Error" || true
	fi
fi
[ -f "$MMS_INT8/model.int8.onnx" ] && echo "MMS English ready (int8 ONNX)"

if [ "${ACTIVE_PHONON:-0}" = 1 ]; then
	"$VENV/bin/python" -c "import ptts" 2>/dev/null || install ptts
	"$VENV/bin/python" -c "import ptts; ptts.TTS(lang='en', quant='q8'); print('Phonon 31M ready')"
fi
