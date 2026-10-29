# Copyright (c) Active contributors. Licensed under the MIT License.
"""Phonon 31M English TTS sidecar for Active.

Loads the on-device model once (via the official `ptts` package) and answers
JSON-lines requests on stdin:  {"id": "...", "text": "...", "voice": "default"}
with JSON lines on stdout:      {"id": "...", "wav": "<base64 WAV>"} or {"id": "...", "error": "..."}

Audio is returned in memory only; nothing is written to disk.
"""

import base64
import io
import json
import sys
import wave


def to_wav(samples, sample_rate):
    import numpy as np

    pcm = (np.clip(samples, -1.0, 1.0) * 32767.0).astype("<i2")
    buffer = io.BytesIO()
    with wave.open(buffer, "wb") as out:
        out.setnchannels(1)
        out.setsampwidth(2)
        out.setframerate(sample_rate)
        out.writeframes(pcm.tobytes())
    return buffer.getvalue()


def main():
    try:
        import ptts

        tts = ptts.TTS(lang="en", quant="q8")
    except Exception as error:  # noqa: BLE001 - reported to the extension verbatim
        print(json.dumps({"ready": False, "error": f"{type(error).__name__}: {error}"}), flush=True)
        return 1
    voices = [{"name": "default", "description": "Phonon's built-in voice"}]
    try:
        # English voices from the Phonon voice catalog; each downloads on first use.
        for entry in ptts.catalog_voices():
            if entry.get("language") == "en" and entry.get("name"):
                voices.append({"name": entry["name"], "description": entry.get("description") or ""})
    except Exception as error:  # noqa: BLE001 - the built-in voice still works offline
        print(f"voice catalog unavailable: {error}", file=sys.stderr, flush=True)
    print(json.dumps({"ready": True, "sampleRate": tts.sample_rate, "voices": voices, "model": "phonon-31m-en"}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            voice = request.get("voice") or None
            if voice == "default":
                voice = None
            samples = tts.synth(request["text"], voice=voice)
            wav = to_wav(samples, tts.sample_rate)
            print(json.dumps({"id": request.get("id"), "wav": base64.b64encode(wav).decode("ascii")}), flush=True)
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"id": request.get("id"), "error": f"{type(error).__name__}: {error}"}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
