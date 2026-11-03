# Copyright (c) Active contributors. Licensed under the MIT License.
"""Builds a fine-tuning set for MMS English from a better teacher TTS (Kokoro).

Reads sentences from text/Markdown files (and, with --wikitext, from Wikipedia articles for variety), speaks each with Kokoro, resamples to MMS's 16 kHz and writes an
`audiofolder` dataset (wavs + metadata.csv) that finetune-hf-vits loads with `"dataset_name": "<out dir>"`.
The text is normalized exactly as Active's MMS sidecar does at runtime, so the model learns the words it will be given.

    python make_dataset.py --out data/kokoro-af_heart --voice af_heart --limit 800 --wikitext ../../README.md notes.txt
"""

import argparse
import csv
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "extension" / "resources"))
from mms_sidecar import normalize  # noqa: E402 - the runtime normalizer

TEACHER_RATE = 24000
MMS_RATE = 16000


def read_sentences(paths, min_chars, max_chars):
    seen, out = set(), []
    for path in paths:
        text = Path(path).read_text(encoding="utf-8", errors="ignore")
        text = re.sub(r"```.*?```", " ", text, flags=re.S)  # code blocks aren't speech
        text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", text)  # links: keep the label
        text = re.sub(r"^[#>\-*|\s]+", "", text, flags=re.M)  # headings, bullets, tables
        for sentence in re.split(r"(?<=[.!?])\s+|\n{2,}", text):
            sentence = re.sub(r"\s+", " ", sentence).strip()
            if min_chars <= len(sentence) <= max_chars and re.search(r"[a-zA-Z]{3}", sentence) and sentence not in seen:
                seen.add(sentence)
                out.append(sentence)
    return out


def clean_wikitext(line):
    """WikiText is tokenized ("role @-@ playing game , with"); put it back into ordinary prose."""
    line = line.replace(" @-@ ", "-").replace(" @,@ ", ",").replace(" @.@ ", ".").replace('"', "")
    line = re.sub(r"\s+([,.;:!?')]|'s|n't)", r"\1", line)
    line = re.sub(r"\(\s+", "(", line)
    return re.sub(r"\s+", " ", line).strip()


def wikitext_sentences(min_chars, max_chars):
    from datasets import load_dataset

    rows = load_dataset("Salesforce/wikitext", "wikitext-2-raw-v1", split="train")
    out = []
    for row in rows:
        text = row["text"].strip()
        if not text or text.startswith("="):  # headings
            continue
        for sentence in re.split(r"(?<=[.!?])\s+", clean_wikitext(text)):
            if min_chars <= len(sentence) <= max_chars and re.search(r"[a-zA-Z]{3}", sentence):
                out.append(sentence)
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("sources", nargs="*", help="text or Markdown files to take sentences from (used first)")
    parser.add_argument("--wikitext", action="store_true", help="fill the rest of --limit with random Wikipedia sentences (WikiText-2)")
    parser.add_argument("--seed", type=int, default=0)
    parser.add_argument("--out", required=True, help="dataset folder to write")
    parser.add_argument("--voice", default="af_heart", help="Kokoro voice (af_heart, am_michael, bf_emma, ...)")
    parser.add_argument("--limit", type=int, default=600, help="at most this many clips")
    parser.add_argument("--min-chars", type=int, default=20)
    parser.add_argument("--max-chars", type=int, default=220)
    args = parser.parse_args()

    import numpy as np
    import soundfile
    from kokoro import KPipeline
    from scipy.signal import resample_poly

    import random

    # Your own text first (at most half, so the model still hears plenty of ordinary prose), then Wikipedia.
    rng = random.Random(args.seed)
    own = read_sentences(args.sources, args.min_chars, args.max_chars) if args.sources else []
    rng.shuffle(own)
    sentences = own[: args.limit // 2 if args.wikitext else args.limit]
    if args.wikitext:
        wiki = wikitext_sentences(args.min_chars, args.max_chars)
        rng.shuffle(wiki)
        sentences += wiki[: args.limit - len(sentences)]
    print(f"{len(sentences)} sentences ({min(len(own), len(sentences))} from your files)", flush=True)
    if not sentences:
        sys.exit("no usable sentences in the sources")
    out = Path(args.out)
    (out / "wavs").mkdir(parents=True, exist_ok=True)
    teacher = KPipeline(lang_code=args.voice[0])  # a = American, b = British English
    rows = []
    for index, sentence in enumerate(sentences):
        # The teacher reads the same normalized words the student will see.
        text = normalize(sentence)
        pieces = [np.asarray(result[2] if isinstance(result, tuple) else result.audio, dtype=np.float32) for result in teacher(text, voice=args.voice, split_pattern=None)]
        if not pieces:
            continue
        audio = resample_poly(np.concatenate(pieces), MMS_RATE, TEACHER_RATE).astype(np.float32)
        name = f"wavs/{index:05d}.wav"
        soundfile.write(out / name, audio, MMS_RATE)
        rows.append((name, text, 0))
        print(f"{index + 1}/{len(sentences)} {len(audio) / MMS_RATE:.1f}s  {text[:70]}", flush=True)
    with open(out / "metadata.csv", "w", newline="", encoding="utf-8") as handle:
        writer = csv.writer(handle)
        # One speaker: every clip is speaker 0 (MMS English has one speaker, so the model ignores it). train.sh also
        # patches the trainer to cope without a speaker id, which it otherwise loses on the way to the GPU.
        writer.writerow(["file_name", "text", "speaker_id"])
        writer.writerows(rows)
    minutes = sum(soundfile.info(out / name).duration for name, _, _ in rows) / 60
    print(f"wrote {len(rows)} clips ({minutes:.1f} min) to {out}")


if __name__ == "__main__":
    main()
