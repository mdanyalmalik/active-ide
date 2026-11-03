#!/usr/bin/env bash
# Creates a Python env for on-device narration:
#   MMS English (Meta's facebook/mms-tts-eng, CC-BY-NC 4.0), the default for the hackathon. It's exported once to an
#   int8 ONNX folder (.tools/tts-models/mms-eng-int8, about 40 MB) that runs on onnxruntime; torch and transformers
#   are only for that export (and for running a checkpoint that hasn't been exported).
#   Phonon 31M English (Gradium's `ptts`, Apache-2.0, a native int8 runtime), kept for after the hackathon.
# Models download from Hugging Face and then run on the CPU.
set -euo pipefail
source "$(dirname "$0")/env.sh"
VENV="$ACTIVE_ROOT/.tools/tts-venv"
MMS_INT8="$ACTIVE_ROOT/.tools/tts-models/mms-eng-int8"
PACKAGES=(ptts onnxruntime numpy scipy num2words torch transformers onnx onnxscript)
if [ ! -x "$VENV/bin/python" ]; then
	if command -v uv >/dev/null; then
		uv venv --python 3.12 "$VENV" -q
	else
		python3 -m venv "$VENV"
	fi
fi
if ! "$VENV/bin/python" -c "import ptts, onnxruntime, scipy, num2words, torch, transformers, onnx, onnxscript" 2>/dev/null; then
	if command -v uv >/dev/null; then
		VIRTUAL_ENV="$VENV" uv pip install -q "${PACKAGES[@]}"
	else
		"$VENV/bin/pip" install -q "${PACKAGES[@]}"
	fi
fi
# Re-export when the folder is missing or from an older recipe (see RECIPE in export_onnx.py).
RECIPE=$(sed -n 's/^RECIPE = //p' "$ACTIVE_ROOT/active/tts-finetune/export_onnx.py")
HAVE=$("$VENV/bin/python" -c "import json,sys; print(json.load(open(sys.argv[1])).get('recipe', 1))" "$MMS_INT8/active-mms.json" 2>/dev/null || echo 0)
if [ ! -f "$MMS_INT8/model.int8.onnx" ] || [ "$HAVE" != "$RECIPE" ]; then
	"$VENV/bin/python" "$ACTIVE_ROOT/active/tts-finetune/export_onnx.py" facebook/mms-tts-eng "$MMS_INT8" 2>&1 | grep -E "^wrote|Error" || true
fi
[ -f "$MMS_INT8/model.int8.onnx" ] && echo "MMS English ready (int8 ONNX)"
"$VENV/bin/python" -c "import ptts; ptts.TTS(lang='en', quant='q8'); print('Phonon 31M ready')"
