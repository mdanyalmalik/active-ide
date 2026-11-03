# Copyright (c) Active contributors. Licensed under the MIT License.
"""Prints how many texts the MMS sidecar's own tokenizer encodes differently from transformers' VitsTokenizer.

    python mms_tokenizer_parity.py <resources dir> <int8 export folder>
"""

import random
import string
import sys
from pathlib import Path

sys.dont_write_bytecode = True
sys.path.insert(0, sys.argv[1])
import mms_sidecar  # noqa: E402
from transformers import AutoTokenizer  # noqa: E402

voice = mms_sidecar.OnnxVoice(Path(sys.argv[2]))
reference = AutoTokenizer.from_pretrained(voice.source)
rng = random.Random(0)
texts = ["Keep the kernel quick.", "Kate asked", "kk k", "Hello, World!", "café's \"quoted\" text"]
texts += ["".join(rng.choice(string.printable + "kKé—") for _ in range(rng.randint(5, 60))) for _ in range(300)]
bad = [text for text in texts if len(reference(text)["input_ids"]) >= voice.min_tokens and reference(text)["input_ids"] != voice.ids(text)]
print(len(bad))
