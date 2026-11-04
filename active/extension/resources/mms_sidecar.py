# Copyright (c) Active contributors. Licensed under the MIT License.
"""MMS English TTS sidecar for Active (Meta's facebook/mms-tts-eng, a VITS model).

Same protocol as phonon_sidecar.py. JSON-lines requests on stdin:  {"id": "...", "text": "...", "voice": "default"}
with JSON lines on stdout:  {"id": "...", "wav": "<base64 WAV>"} or {"id": "...", "error": "..."}

The model is `argv[1]`. A folder from active/tts-finetune/export_onnx.py (model.int8.onnx) runs on onnxruntime in int8,
which needs only onnxruntime and numpy. Anything else (a Hugging Face id, a fine-tune before export) runs on torch with
transformers; the default is facebook/mms-tts-eng. MMS has one voice, so `voice` is ignored. Audio stays in memory.
"""

import base64
import io
import json
import re
import sys
import wave
from pathlib import Path

DEFAULT_MODEL = "facebook/mms-tts-eng"

# MMS reads lower-case letters, a few marks and spaces; anything else is dropped silently, so spell it out first.
SYMBOLS = {
    "%": " percent ", "&": " and ", "+": " plus ", "=": " equals ", "@": " at ", "#": " number ",
    "<": " less than ", ">": " greater than ", "/": " slash ", "$": " dollars ",
}


# 1,200 and 3.5 are one number each; "31, 2010" is two.
NUMBER = r"\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?"


def number_words(match):
    raw = match.group(0)
    text = raw.replace(",", "")
    try:
        from num2words import num2words

        if raw.isdigit() and len(raw) == 4 and 1100 <= int(raw) <= 2099:
            return f" {num2words(int(raw), to='year')} "  # 2010: twenty ten
        return f" {num2words(float(text) if '.' in text else int(text))} "
    except Exception:  # noqa: BLE001 - fall back to digit by digit
        names = "zero one two three four five six seven eight nine".split()
        return " " + " ".join(names[int(c)] if c.isdigit() else "point" for c in text) + " "


def money_words(match):
    try:
        from num2words import num2words

        return f" {num2words(float(match.group(1).replace(',', '')), to='currency', currency='USD').replace(', zero cents', '')} "
    except Exception:  # noqa: BLE001
        return f" {match.group(1)} dollars "


LETTERS = {
    "a": "ay", "b": "bee", "c": "see", "d": "dee", "e": "ee", "f": "ef", "g": "jee", "h": "aych", "i": "eye", "j": "jay",
    "k": "kay", "l": "el", "m": "em", "n": "en", "o": "oh", "p": "pee", "q": "kew", "r": "ar", "s": "ess", "t": "tee",
    "u": "you", "v": "vee", "w": "double you", "x": "ex", "y": "why", "z": "zee",
}
# Acronyms said as words rather than letters.
SPOKEN_ACRONYMS = {"JSON": "jason", "ONNX": "onix", "GIF": "gif", "NASA": "nasa", "RAM": "ram", "SQL": "sequel", "CRUD": "crud", "YAML": "yamel"}


def acronym_words(match):
    word = match.group(0)
    plural = word.endswith("s") and not word.isupper()  # APIs
    word = word[:-1] if plural else word
    spoken = SPOKEN_ACRONYMS.get(word) or " ".join(LETTERS[c] for c in word.lower())
    return f" {spoken}{'es' if plural and spoken.endswith('s') else 's' if plural else ''} "


def normalize(text):
    text = re.sub(r"`([^`]*)`", r"\1", text)
    text = re.sub(r"(\*{1,2})(\S(?:.*?\S)?)\1", r"\2", text)  # Markdown *emphasis* and **bold**
    text = re.sub(r"(?<=\d)\s*\*\s*(?=\d)", " times ", text)  # 3 * 4
    text = text.replace("*", " ")
    text = re.sub(r"([a-z])([A-Z])", r"\1 \2", text)  # camelCase reads as words
    text = re.sub(r"\b[A-Z]{2,5}s?\b", acronym_words, text)  # TTS, APIs
    text = re.sub(r"[_\-]+(?=\w)", " ", text)  # snake_case and kebab-case too
    text = re.sub(r"\be\.g\.,?", "for example,", text, flags=re.I)
    text = re.sub(r"\bi\.e\.,?", "that is,", text, flags=re.I)
    text = re.sub(r"(?<=\w)\.(?=[A-Za-z])", " dot ", text)  # file.py, obj.method
    text = re.sub(r"\$(" + NUMBER + r")", money_words, text)
    text = re.sub(r"\d+(?:\.\d+){2,}", lambda m: " " + " point ".join(m.group(0).split(".")) + " ", text)  # versions: 1.143.1
    text = re.sub(NUMBER, number_words, text)
    text = re.sub(r"\bREADME\b", "read me", text)
    text = re.sub(r"\?(?=[A-Za-z])", " question mark ", text)  # ?limit in a URL
    # A lone letter (the s in 30s, "s, m, and h") said as its name; MMS reads a bare letter as a stray sound.
    text = re.sub(r"(?<![\w'])[b-hj-z](?![\w'])", lambda m: LETTERS[m.group(0)], text)
    for symbol, words in SYMBOLS.items():
        text = text.replace(symbol, words)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    return re.sub(r"\s+", " ", text).strip()


# Heteronyms (noun vs verb sound, e.g. records) come from the lexicon file with measured respellings; a determiner
# before one means the noun.
DETERMINERS = {"the", "a", "an", "this", "that", "these", "those", "its", "their", "our", "your", "my", "his", "her", "each", "every", "some", "any", "no", "new"}


def load_lexicon(path=None):
    """Respellings for words MMS mispronounces, measured by active/tts-finetune/build_lexicon.py:
    {"words": {word: spelling}, "heteronyms": {word: [noun, verb]}}; empty if absent."""
    path = Path(path) if path else Path(__file__).with_name("mms_lexicon.json")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"words": {}, "heteronyms": {}}
    if "words" not in data:  # an older flat file
        data = {"words": data, "heteronyms": {}}
    return {"words": {w.lower(): s for w, s in data["words"].items()}, "heteronyms": {w.lower(): tuple(f) for w, f in data.get("heteronyms", {}).items()}}


def respell(text, lexicon):
    """Swaps in respellings MMS reads correctly, word by word; heteronyms by whether a determiner comes first."""
    words = lexicon.get("words", {}) if "words" in lexicon else lexicon
    heteronyms = lexicon.get("heteronyms", {})
    tokens = re.split(r"(\W+)", text)
    previous = ""
    for index, token in enumerate(tokens):
        word = token.lower()
        if not word or not word[0].isalpha():
            continue
        if word in heteronyms:
            noun, verb = heteronyms[word]
            tokens[index] = noun if previous in DETERMINERS else verb
        elif word in words:
            tokens[index] = words[word]
        previous = word
    return "".join(tokens)


def sentences(text):
    """Short pieces: VITS keeps its pacing better on a sentence at a time."""
    parts = [part.strip() for part in re.split(r"(?<=[.!?;:])\s+|\n+", text) if part.strip()]
    pieces = []
    for part in parts:
        while len(part) > 300:  # very long sentences: break at a comma or space
            cut = max(part.rfind(",", 0, 300), part.rfind(" ", 0, 300))
            cut = cut if cut > 0 else 300
            pieces.append(part[:cut + 1].strip())
            part = part[cut + 1:].strip()
        if part:
            pieces.append(part)
    return pieces


def phrases(sentence):
    """A sentence split at its commas: MMS's vocabulary has no punctuation, so it would read straight through them."""
    return [part for part in re.split(r"(?<=,)\s+", sentence) if part.strip()]


def trim(samples, sample_rate, margin_s=0.03):
    """Cuts MMS's own silence (about 0.25 s at each end of every piece), keeping a short margin, so the pauses
    between pieces are the ones synth() puts there."""
    import numpy as np

    loud = np.flatnonzero(np.abs(samples) > 0.02 * (np.abs(samples).max() + 1e-9))
    if not len(loud):
        return samples
    margin = int(sample_rate * margin_s)
    return samples[max(0, loud[0] - margin):loud[-1] + margin]


def polish(samples, sample_rate):
    """Light mastering, which a listening test preferred: rumble cut, a lift above 3 kHz (MMS is 16 kHz and sounds
    muffled), a soft-knee limiter, and loudness to about -18 dBFS RMS."""
    import numpy as np

    try:
        from scipy.signal import butter, sosfilt

        lows_cut = sosfilt(butter(2, 70, "highpass", fs=sample_rate, output="sos"), samples)
        samples = lows_cut + 0.35 * sosfilt(butter(2, 3000, "highpass", fs=sample_rate, output="sos"), lows_cut)
    except ImportError:
        pass  # without scipy: no EQ, the rest still applies
    samples = np.tanh(2.0 * samples) / np.tanh(2.0)
    rms = float(np.sqrt(np.mean(samples ** 2))) + 1e-9
    return np.clip(samples * (10 ** (-18 / 20) / rms), -0.98, 0.98).astype(np.float32)


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


class OnnxVoice:
    """The fast path: an int8 ONNX folder from active/tts-finetune/export_onnx.py, run with onnxruntime (no torch)."""

    def __init__(self, folder):
        import onnxruntime

        meta = json.loads((folder / "active-mms.json").read_text())
        self.vocab = json.loads((folder / "vocab.json").read_text(encoding="utf-8"))
        self.sample_rate = meta["sampling_rate"]
        self.add_blank = meta.get("add_blank", True)
        self.lower = meta.get("normalize", True)
        self.blank = meta.get("pad_token_id", 0)
        self.pad_char = next((char for char, index in self.vocab.items() if index == self.blank and len(char) == 1), None)
        self.min_tokens = meta.get("min_tokens", 8)
        self.source = meta.get("source", str(folder))
        options = onnxruntime.SessionOptions()
        options.intra_op_num_threads = 4
        options.graph_optimization_level = onnxruntime.GraphOptimizationLevel.ORT_ENABLE_ALL
        self.session = onnxruntime.InferenceSession(str(folder / "model.int8.onnx"), options, providers=["CPUExecutionProvider"])

    def ids(self, text):
        """What VitsTokenizer does for MMS English: lower-case, drop characters outside the vocab, intersperse blanks."""
        text = text.lower() if self.lower else text
        text = "".join(char for char in text if char in self.vocab).strip()
        tokens = self.tokens(text) if text else []
        while tokens and len(tokens) < self.min_tokens:
            text = f" {text} "  # the exported model needs a few tokens; spaces are silence
            tokens = self.tokens(text)
        return tokens

    def tokens(self, text):
        if not self.add_blank:
            return [self.vocab[char] for char in text]
        # Exactly as transformers does it (training used it too): the pad token's character (`k` for English) is a
        # special token, so it stands alone and the text between is interspersed with blanks piece by piece.
        tokens = []
        for index, piece in enumerate(text.split(self.pad_char) if self.pad_char else [text]):
            if index:
                tokens.append(self.blank)
            if piece:
                spaced = [self.blank] * (len(piece) * 2 + 1)
                spaced[1::2] = [self.vocab[char] for char in piece]
                tokens.extend(spaced)
        return tokens

    def speak(self, text):
        import numpy as np

        tokens = self.ids(text)
        if not tokens:
            return None
        return self.session.run(None, {"input_ids": np.array([tokens], dtype=np.int64)})[0][0]


class TorchVoice:
    """The slow path: any checkpoint transformers can load (a Hugging Face id, or a fine-tune before export)."""

    def __init__(self, model_id):
        import torch
        from transformers import AutoTokenizer, VitsModel

        torch.set_num_threads(max(1, min(4, torch.get_num_threads())))
        self.torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(model_id)
        self.model = VitsModel.from_pretrained(model_id).eval()
        self.sample_rate = self.model.config.sampling_rate
        self.source = model_id

    def speak(self, text):
        inputs = self.tokenizer(text, return_tensors="pt")
        if inputs["input_ids"].shape[-1] < 2:
            return None
        self.torch.manual_seed(0)  # the same text always sounds the same
        with self.torch.no_grad():
            return self.model(**inputs).waveform[0].numpy()


def load_voice(model):
    folder = Path(model).expanduser()
    if (folder / "model.int8.onnx").is_file():
        return OnnxVoice(folder), "int8 ONNX"
    return TorchVoice(model), "torch fp32"


def main():
    model_id = sys.argv[1] if len(sys.argv) > 1 and sys.argv[1] else DEFAULT_MODEL
    try:
        import numpy as np

        voice, runtime = load_voice(model_id)
    except Exception as error:  # noqa: BLE001 - reported to the extension verbatim
        print(json.dumps({"ready": False, "error": f"{type(error).__name__}: {error}"}), flush=True)
        return 1
    sample_rate = voice.sample_rate
    lexicon = load_lexicon()
    print(f"MMS: {voice.source} on {runtime}", file=sys.stderr, flush=True)

    def synth(text):
        # Pauses measured from Kokoro reading the same sentences: about 0.2-0.35 s at a comma, longer between sentences.
        sentence_gap = np.zeros(int(sample_rate * 0.4), dtype=np.float32)
        comma_gap = np.zeros(int(sample_rate * 0.18), dtype=np.float32)
        chunks = []
        for piece in sentences(text):
            parts = [voice.speak(respell(normalize(part), lexicon)) for part in phrases(piece)]
            parts = [trim(part.astype(np.float32), sample_rate) for part in parts if part is not None]
            for index, part in enumerate(parts):
                chunks.append(part)
                chunks.append(comma_gap if index < len(parts) - 1 else sentence_gap)
        return polish(np.concatenate(chunks), sample_rate) if chunks else sentence_gap

    source = voice.source.rstrip("/")
    name = "MMS English" if source == DEFAULT_MODEL else f"MMS English ({source.split('/')[-1]})"
    voices = [{"name": "default", "description": "MMS's only English voice"}]
    print(json.dumps({"ready": True, "sampleRate": sample_rate, "voices": voices, "model": model_id, "label": name, "runtime": runtime}), flush=True)
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        request = {}
        try:
            request = json.loads(line)
            wav = to_wav(synth(request["text"]), sample_rate)
            print(json.dumps({"id": request.get("id"), "wav": base64.b64encode(wav).decode("ascii")}), flush=True)
        except Exception as error:  # noqa: BLE001
            print(json.dumps({"id": request.get("id"), "error": f"{type(error).__name__}: {error}"}), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
