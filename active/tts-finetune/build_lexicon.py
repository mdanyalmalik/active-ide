# Copyright (c) Active contributors. Licensed under the MIT License.
"""Builds MMS's respelling lexicon by listening to the sounds it makes, not the words a transcriber guesses.

MMS English reads letters, not phonemes, so words whose spelling misleads come out wrong ("comments" as /kəmɛns/,
"records" as the noun when it's a verb). A speech recogniser like Whisper hides this: its language model hears the
right word anyway. So this uses a phoneme recogniser with no language model (wav2vec2 espeak CTC), compares what it
hears with the CMU dictionary's pronunciation, and searches respellings (syllables split with spaces work best:
"kaw ments", "rih cords") for the fewest phoneme errors.

    ../../.tools/tts-venv/bin/python build_lexicon.py --words-from ../../README.md --extra-words narration_words.txt

Writes active/extension/resources/mms_lexicon.json: {"words": {word: spelling}, "heteronyms": {word: [noun, verb]}}.
Needs torch, transformers, cmudict and huggingface_hub in the venv.
"""

import argparse
import json
import re
import sys
import warnings
from pathlib import Path

HERE = Path(__file__).resolve().parent
RESOURCES = HERE.parent / "extension" / "resources"
sys.path.insert(0, str(RESOURCES))
import mms_sidecar  # noqa: E402

PHONEME_MODEL = "facebook/wav2vec2-lv-60-espeak-cv-ft"
# MMS says a word differently in different contexts, so a spelling is judged over several.
CARRIERS = ["Next, the {} part.", "We use {} here.", "It skips the {} again.", "The parser walks each line and checks the {}."]
# Respell only when the plain spelling misses at least this share of the word's phonemes, and keep a respelling only
# when it is clearly better (a whole phoneme fewer errors on average).
THRESHOLD = 0.25
# A respelling must beat the plain word by this much on average, and be no worse in any carrier.
MIN_GAIN = 0.15
# Everyday function words MMS hears constantly in training; respelling them was where regressions came from.
SKIP = set("""a about after again all also an and any are as at be because been before being both but by can could did
do does doing down during each few for from further had has have having he her here hers him his how i if in into is it
its itself just me more most my no nor not now of off on once only or other our out over own same she should so some
such than that the their them then there these they this those through to too under until up very was we were what
when where which while who whom why will with would you your""".split())

# ARPAbet to the espeak-style IPA the phoneme model writes.
IPA = {"AA": "ɑ", "AE": "æ", "AH": "ʌ", "AO": "ɔ", "AW": "aʊ", "AY": "aɪ", "EH": "ɛ", "ER": "ɚ", "EY": "eɪ", "IH": "ɪ",
       "IY": "i", "OW": "oʊ", "OY": "ɔɪ", "UH": "ʊ", "UW": "u", "B": "b", "CH": "tʃ", "D": "d", "DH": "ð", "F": "f", "G": "ɡ",
       "HH": "h", "JH": "dʒ", "K": "k", "L": "l", "M": "m", "N": "n", "NG": "ŋ", "P": "p", "R": "ɹ", "S": "s", "SH": "ʃ",
       "T": "t", "TH": "θ", "V": "v", "W": "w", "Y": "j", "Z": "z", "ZH": "ʒ"}
UNSTRESSED_IPA = {"AH": "ə", "IH": "ɪ", "ER": "ɚ"}
# Phonemes treated as the same sound (schwas, flapped t, length marks are dropped first).
SAME = {"ə": "ʌ", "ɐ": "ʌ", "ᵻ": "ɪ", "ɜ": "ɚ", "ɾ": "t", "o": "oʊ", "e": "eɪ", "ɑ": "ɑ"}

# Respelling pieces per ARPAbet sound, a few options each.
VOWELS = {
    "AA": ["ah", "aw", "o"], "AE": ["a", "ah"], "AH": ["uh", "u"], "AO": ["aw", "or"], "AW": ["ow"], "AY": ["eye", "y"],
    "EH": ["eh", "e"], "ER": ["er", "ur"], "EY": ["ay", "ey"], "IH": ["ih", "i"], "IY": ["ee", "ea"], "OW": ["oh", "o"],
    "OY": ["oy"], "UH": ["oo", "u"], "UW": ["oo", "ew"],
}
UNSTRESSED = {"AH": ["uh", "i"], "IH": ["ih", "i"], "ER": ["er"]}
CONSONANTS = {
    "B": "b", "CH": "ch", "D": "d", "DH": "th", "F": "f", "G": "g", "HH": "h", "JH": "j", "K": "k", "L": "l", "M": "m",
    "N": "n", "NG": "ng", "P": "p", "R": "r", "S": "s", "SH": "sh", "T": "t", "TH": "th", "V": "v", "W": "w", "Y": "y",
    "Z": "z", "ZH": "zh",
}
# Common English spellings of each sound at the start of a syllable (c before a/o/u reads as k).
ONSET = {"K": ["c", "k"], "S": ["s", "c"]}

HETERONYMS = ["record", "records", "present", "object", "project", "content", "conduct", "contract", "produce",
              "progress", "export", "exports", "import", "imports", "subject", "permit", "conflict", "address"]


def split(arpa):
    base, stress = re.match(r"([A-Z]+)(\d?)", arpa).groups()
    return base, stress


def to_ipa(pron):
    out = []
    for arpa in pron:
        base, stress = split(arpa)
        out.append(UNSTRESSED_IPA[base] if stress == "0" and base in UNSTRESSED_IPA else IPA[base])
    return out


def syllables(pron):
    """The pronunciation cut before each vowel's onset consonant (maximal onset of one consonant)."""
    cuts, vowel_seen = [0], False
    for i, arpa in enumerate(pron):
        if split(arpa)[0] in VOWELS:
            if vowel_seen and i > 0 and split(pron[i - 1])[0] not in VOWELS:
                cuts.append(i - 1)
            vowel_seen = True
    cuts.append(len(pron))
    return [pron[a:b] for a, b in zip(cuts, cuts[1:]) if b > a]


# A vowel followed by R spelled the usual English way (the R is then part of it).
R_COLOURED = {"AO": ["or", "aur"], "AA": ["ar", "ahr"], "EH": ["air", "er"], "IH": ["eer", "ir"], "UH": ["oor"], "AY": ["ire"]}


def spell(part, scheme):
    out = []
    skip = False
    for i, arpa in enumerate(part):
        if skip:
            skip = False
            continue
        base, stress = split(arpa)
        if base in R_COLOURED and i + 1 < len(part) and split(part[i + 1])[0] == "R" and stress != "0":
            options = R_COLOURED[base]
            out.append(options[min(scheme, len(options) - 1)])
            skip = True
        elif base in VOWELS:
            options = UNSTRESSED.get(base, VOWELS[base]) if stress == "0" else VOWELS[base]
            out.append(options[min(scheme, len(options) - 1)])
        elif i == 0 and base in ONSET:
            out.append(ONSET[base][min(scheme, len(ONSET[base]) - 1)])
        else:
            out.append(CONSONANTS[base])
    return "".join(out)


def respellings(pron, limit=10):
    """Candidate spellings of one pronunciation: joined and split into syllables, a few vowel schemes each."""
    parts = syllables(pron)
    out = []
    for scheme in range(3):
        spelled = [spell(part, scheme) for part in parts]
        out += [" ".join(spelled), "".join(spelled)]
        # Each syllable alone in the alternative scheme, the rest in scheme 0.
        for k in range(len(parts)):
            mixed = [spell(part, scheme if i == k else 0) for i, part in enumerate(parts)]
            out.append(" ".join(mixed))
    seen, unique = set(), []
    for spelling in out:
        if spelling not in seen:
            seen.add(spelling)
            unique.append(spelling)
    return unique[:limit]


class Listener:
    """A phoneme recogniser with no language model."""

    def __init__(self):
        import torch
        from huggingface_hub import hf_hub_download
        from transformers import Wav2Vec2FeatureExtractor, Wav2Vec2ForCTC

        self.torch = torch
        self.device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
        self.fx = Wav2Vec2FeatureExtractor.from_pretrained(PHONEME_MODEL)
        self.model = Wav2Vec2ForCTC.from_pretrained(PHONEME_MODEL).eval().to(self.device)
        self.vocab = {v: k for k, v in json.loads(Path(hf_hub_download(PHONEME_MODEL, "vocab.json")).read_text()).items()}

    def phonemes(self, audio):
        import numpy as np

        with self.torch.no_grad():
            values = self.fx(np.asarray(audio, dtype=np.float32), sampling_rate=16000, return_tensors="pt").input_values
            ids = self.model(values.to(self.device)).logits.argmax(-1)[0].tolist()
        out, last = [], None
        for i in ids:
            token = self.vocab.get(i)
            if i != last and token and token not in ("<pad>", "<s>", "</s>", "<unk>", "|") and token.strip():
                out += normalize_phoneme(token)
            last = i
        return out


def normalize_phoneme(token):
    """One model token as comparable phonemes: no length marks; r-coloured vowels split into vowel + ɹ."""
    token = token.replace("ː", "")
    if len(token) > 1 and token.endswith("ɹ"):
        return [SAME.get(token[:-1], token[:-1]), "ɹ"]
    return [SAME.get(token, token)]


def edit_distance(a, b):
    d = list(range(len(b) + 1))
    for i, x in enumerate(a, 1):
        prev, d[0] = d[0], i
        for j, y in enumerate(b, 1):
            prev, d[j] = d[j], min(d[j] + 1, d[j - 1] + 1, prev + (x != y))
    return d[-1]


def word_error(heard, target):
    """Fewest phoneme edits between the target and any stretch of what was heard, per target phoneme."""
    target = [p for t in target for p in normalize_phoneme(t)]
    best = len(target)
    for i in range(len(heard)):
        for j in range(i + 1, min(len(heard), i + len(target) + 2) + 1):
            best = min(best, edit_distance(heard[i:j], target))
    return best / max(1, len(target))


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--words-from", nargs="*", default=[], help="text/Markdown files to take words from")
    parser.add_argument("--extra-words", help="a file with one word per line")
    parser.add_argument("--model", default=str(HERE.parent.parent / ".tools" / "tts-models" / "mms-eng-int8"))
    parser.add_argument("--out", default=str(RESOURCES / "mms_lexicon.json"))
    parser.add_argument("--min-length", type=int, default=3)
    parser.add_argument("--min-count", type=int, default=1, help="only words used at least this often in --words-from")
    parser.add_argument("--only", nargs="*", help="just these words (and heteronyms among them); prints, writes nothing")
    args = parser.parse_args()
    warnings.filterwarnings("ignore")

    import cmudict

    pronunciations = cmudict.dict()
    voice, _ = mms_sidecar.load_voice(args.model)
    listener = Listener()

    def errors(spelling, pron):
        target = to_ipa(pron)
        return [word_error(listener.phonemes(voice.speak(mms_sidecar.normalize(c.format(spelling)))), target) for c in CARRIERS]

    def best_spelling(word, pron):
        plain = errors(word, pron)
        plain_mean = sum(plain) / len(plain)
        if plain_mean < THRESHOLD:
            return None, plain_mean, plain_mean
        # One word only: spaced syllables ("kaw ments") score well on phonemes but MMS then says them as separate
        # words, which sounds choppy and halts recognition (WER on the README went from 19% to 54%).
        best = None
        for candidate in respellings(pron, limit=30):
            if candidate == word or " " in candidate:
                continue
            errs = errors(candidate, pron)
            mean = sum(errs) / len(errs)
            # Better on average, and never worse in any one context (MMS says spellings differently by context).
            if mean <= plain_mean - MIN_GAIN and all(e <= p + 1e-9 for e, p in zip(errs, plain)) and (best is None or mean < best[0]):
                best = (mean, candidate)
        return (best[1], plain_mean, best[0]) if best else (None, plain_mean, plain_mean)

    from collections import Counter

    counts = Counter()
    for path in args.words_from:
        text = re.sub(r"```.*?```", " ", Path(path).read_text(encoding="utf-8", errors="ignore"), flags=re.S)
        counts.update(word.lower() for word in re.findall(r"[A-Za-z][a-z']+", text))
    words = {word for word, n in counts.items() if n >= args.min_count}
    if args.extra_words:
        words.update(line.strip().lower() for line in Path(args.extra_words).read_text().splitlines() if line.strip())
    words = sorted(word for word in words if len(word) >= args.min_length and word in pronunciations and word not in HETERONYMS and word not in SKIP)
    heteronym_words = HETERONYMS
    if args.only:
        words = [word for word in args.only if word in pronunciations and word not in HETERONYMS]
        heteronym_words = [word for word in args.only if word in HETERONYMS]

    lexicon = {}
    for word in words:
        spelling, before, after = best_spelling(word, pronunciations[word][0])
        if spelling:
            lexicon[word] = spelling
            print(f"{word:16s} -> {spelling:18s} phoneme errors {before:.2f} -> {after:.2f}", flush=True)

    # Heteronyms: the noun (first-syllable stress) and verb (second-syllable stress) pronunciations, each spelled.
    heteronyms = {}
    for word in heteronym_words:
        prons = pronunciations.get(word, [])
        noun = next((p for p in prons if any(a.endswith("1") for a in syllables(p)[0])), None)
        verb = next((p for p in prons if len(syllables(p)) > 1 and any(a.endswith("1") for a in syllables(p)[1])), None)
        if not noun or not verb:
            continue
        forms = []
        for pron in (noun, verb):
            spelling, before, after = best_spelling(word, pron)
            forms.append(spelling or word)
            print(f"{word:16s} {'noun' if pron is noun else 'verb'} -> {spelling or word:16s} phoneme errors {before:.2f} -> {after:.2f}", flush=True)
        heteronyms[word] = forms

    if args.only:
        return
    Path(args.out).write_text(json.dumps({"words": dict(sorted(lexicon.items())), "heteronyms": heteronyms}, indent=1) + "\n")
    print(f"checked {len(words)} words; {len(lexicon)} respelled, {len(heteronyms)} heteronyms -> {args.out}")


if __name__ == "__main__":
    main()
