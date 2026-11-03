# Copyright (c) Active contributors. Licensed under the MIT License.
"""Speaks the same text with stock MMS and a fine-tune, through Active's own sidecar, into two WAVs.

    python compare.py out/mms-eng-kokoro "The parser reads each line, then retries the request three times."

Run it with a Python that has torch and transformers (Active's .tools/tts-venv works).
"""

import base64
import json
import subprocess
import sys
from pathlib import Path

SIDECAR = Path(__file__).resolve().parent.parent / "extension" / "resources" / "mms_sidecar.py"


def speak(model, text, out):
    child = subprocess.Popen([sys.executable, str(SIDECAR), model], stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    ready = json.loads(child.stdout.readline())
    if not ready.get("ready"):
        sys.exit(f"{model}: {ready.get('error')}")
    child.stdin.write(json.dumps({"id": "1", "text": text}) + "\n")
    child.stdin.flush()
    reply = json.loads(child.stdout.readline())
    child.stdin.close()
    child.wait()
    if "wav" not in reply:
        sys.exit(f"{model}: {reply.get('error')}")
    Path(out).write_bytes(base64.b64decode(reply["wav"]))
    print(f"{ready['model']}: {out}")


if __name__ == "__main__":
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    speak("facebook/mms-tts-eng", sys.argv[2], "compare-stock.wav")
    speak(sys.argv[1], sys.argv[2], "compare-finetuned.wav")
