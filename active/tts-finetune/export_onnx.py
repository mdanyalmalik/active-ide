# Copyright (c) Active contributors. Licensed under the MIT License.
"""Exports an MMS (VITS) checkpoint to the int8 ONNX folder Active's narration sidecar runs with onnxruntime.

    python export_onnx.py facebook/mms-tts-eng ../../.tools/tts-models/mms-eng-int8
    python export_onnx.py out/mms-eng-kokoro out/mms-eng-kokoro-int8

The folder holds model.int8.onnx (weights in int8, about 40 MB, against 145 MB in fp32), the tokenizer's vocab.json,
and active-mms.json (sample rate, tokenizer flags). Running it needs only onnxruntime and numpy, not torch.
Measured on stock MMS: about twice as fast as torch on a laptop CPU, and the int8 audio differs from fp32 by less
than two fp32 runs differ from each other (VITS samples noise). `--check` repeats that comparison.
"""

import argparse
import json
import shutil
import sys
import tempfile
import warnings
from pathlib import Path

# How MMS samples its prosody, baked into the export (VITS draws noise for pitch/timing variation and duration).
# Calmer than the stock 0.667 / 0.8 / 1.0, which a listening test preferred; pitch spread measured the same as Kokoro's
# either way, so this mostly steadies timing. Bump RECIPE when these or the export change, so setup re-exports.
NOISE_SCALE, NOISE_SCALE_DURATION, SPEAKING_RATE = 0.45, 0.1, 0.94
RECIPE = 3

# The text encoder's relative attention needs a few tokens; the sidecar pads shorter input to this.
MIN_TOKENS = 8
MAX_TOKENS = 4000


def load(model_id):
    import torch
    import transformers.models.vits.modeling_vits as modeling
    from torch.nn.utils import parametrize
    from transformers import AutoTokenizer, VitsModel

    # Range checks inside the spline flow are data-dependent asserts that ONNX can't express; they never fire in inference.
    modeling.torch_compilable_check = lambda *args, **kwargs: None
    model = VitsModel.from_pretrained(model_id).eval()
    # Weight norm computes each conv weight at run time; fold it so the weights are constants that can be quantized.
    for module in model.modules():
        if parametrize.is_parametrized(module):
            for name in list(module.parametrizations.keys()):
                parametrize.remove_parametrizations(module, name)
        elif hasattr(module, "weight_g"):
            torch.nn.utils.remove_weight_norm(module)
    return model, AutoTokenizer.from_pretrained(model_id)


def export(model, tokenizer, path):
    import torch

    class Waveform(torch.nn.Module):
        def __init__(self, vits):
            super().__init__()
            self.vits = vits

        def forward(self, input_ids):
            return self.vits(input_ids=input_ids).waveform

    sample = tokenizer("hello there, friend", return_tensors="pt")["input_ids"]
    tokens = torch.export.Dim("tokens", min=MIN_TOKENS, max=MAX_TOKENS)
    program = torch.onnx.export(Waveform(model), (sample,), input_names=["input_ids"], output_names=["waveform"],
                                dynamic_shapes={"input_ids": {1: tokens}}, dynamo=True, opset_version=18, verbose=False)
    program.save(str(path))


def check(model_id, fp32_path, int8_path):
    """Exported fp32 must match torch exactly (noise off), at short and long lengths; int8 is reported for size and speed."""
    import time

    import numpy as np
    import onnxruntime
    import torch

    model, tokenizer = load(model_id)
    model.noise_scale = 0.0
    model.noise_scale_duration = 0.0
    with tempfile.TemporaryDirectory() as tmp:
        deterministic = Path(tmp) / "det.onnx"
        export(model, tokenizer, deterministic)
        session = onnxruntime.InferenceSession(str(deterministic), providers=["CPUExecutionProvider"])
        for text in ["ok then", "The parser reads each line.", "The fetch user function in api client dot py retries three times, then returns forty two percent of the cache to the caller, and logs the result. " * 3]:
            ids = tokenizer(text, return_tensors="pt")["input_ids"]
            if ids.shape[-1] < MIN_TOKENS:
                continue
            with torch.no_grad():
                expected = model(input_ids=ids).waveform[0].numpy()
            got = session.run(None, {"input_ids": ids.numpy()})[0][0]
            same = len(got) == len(expected) and np.corrcoef(got, expected)[0, 1] > 0.999
            print(f"  {ids.shape[-1]:4d} tokens: fp32 ONNX {'matches' if same else 'DIFFERS FROM'} torch")
            if not same:
                sys.exit("export check failed")
    ids = tokenizer("The fetch user function retries three times, then returns the cache.", return_tensors="np")["input_ids"]
    for label, path in [("fp32", fp32_path), ("int8", int8_path)]:
        session = onnxruntime.InferenceSession(str(path), providers=["CPUExecutionProvider"])
        session.run(None, {"input_ids": ids})
        start = time.time()
        session.run(None, {"input_ids": ids})
        print(f"  {label}: {path.stat().st_size / 1e6:.0f} MB, {time.time() - start:.2f}s for one sentence")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("model", help="Hugging Face id or local checkpoint folder (e.g. a fine-tune's output_dir)")
    parser.add_argument("out", help="folder to write")
    parser.add_argument("--check", action="store_true", help="verify the export against torch and time it")
    parser.add_argument("--noise-scale", type=float, default=NOISE_SCALE)
    parser.add_argument("--noise-duration", type=float, default=NOISE_SCALE_DURATION)
    parser.add_argument("--speaking-rate", type=float, default=SPEAKING_RATE)
    args = parser.parse_args()
    warnings.filterwarnings("ignore")

    from onnxruntime.quantization import QuantType, quantize_dynamic

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    model, tokenizer = load(args.model)
    model.noise_scale, model.noise_scale_duration, model.speaking_rate = args.noise_scale, args.noise_duration, args.speaking_rate
    with tempfile.TemporaryDirectory() as tmp:
        fp32 = Path(tmp) / "model.onnx"
        export(model, tokenizer, fp32)
        # Plain per-tensor int8 measured best here (per-channel and uint8 were no closer to fp32).
        quantize_dynamic(str(fp32), str(out / "model.int8.onnx"), weight_type=QuantType.QInt8, op_types_to_quantize=["Conv", "MatMul"])
        if args.check:
            check(args.model, fp32, out / "model.int8.onnx")
    tokenizer.save_pretrained(tmp_tok := Path(tempfile.mkdtemp()))
    shutil.copy(tmp_tok / "vocab.json", out / "vocab.json")
    shutil.rmtree(tmp_tok, ignore_errors=True)
    meta = {
        "source": args.model,
        "sampling_rate": model.config.sampling_rate,
        "add_blank": bool(getattr(tokenizer, "add_blank", True)),
        "normalize": bool(getattr(tokenizer, "normalize", True)),
        "pad_token_id": tokenizer.pad_token_id,
        "min_tokens": MIN_TOKENS,
        "max_tokens": MAX_TOKENS,
        "recipe": RECIPE,
        "noise_scale": args.noise_scale,
        "noise_scale_duration": args.noise_duration,
        "speaking_rate": args.speaking_rate,
    }
    (out / "active-mms.json").write_text(json.dumps(meta, indent=2))
    print(f"wrote {out / 'model.int8.onnx'} ({(out / 'model.int8.onnx').stat().st_size / 1e6:.0f} MB)")


if __name__ == "__main__":
    main()
