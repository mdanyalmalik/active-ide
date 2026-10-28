#!/usr/bin/env bash
# Creates a Python env with Gradium's `ptts` package (Phonon 31M English, Apache-2.0).
# The model (gradium/phonon-31m-en) downloads from Hugging Face on first use and runs on-device.
set -euo pipefail
source "$(dirname "$0")/env.sh"
VENV="$ACTIVE_ROOT/.tools/tts-venv"
if [ ! -x "$VENV/bin/python" ]; then
	if command -v uv >/dev/null; then
		uv venv --python 3.12 "$VENV" -q
		VIRTUAL_ENV="$VENV" uv pip install -q ptts
	else
		python3 -m venv "$VENV"
		"$VENV/bin/pip" install -q ptts
	fi
fi
"$VENV/bin/python" -c "import ptts; ptts.TTS(lang='en', quant='q8'); print('Phonon 31M ready')"
