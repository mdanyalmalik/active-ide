# Fine-tuning MMS English

For the hackathon, Active narrates with Meta's MMS English (`facebook/mms-tts-eng`). Stock MMS sounds flat, because it was trained mostly on Bible readings. This folder distils a better TTS into it: a teacher (Kokoro 82M, Apache-2.0) reads a few hundred sentences, and MMS is fine-tuned on those recordings. The result is still an MMS model with the same size and speed. After training it's exported to int8 ONNX like the stock one, and Active runs it on onnxruntime.

Nothing here is shipped or built with Active. It's an offline tool.

## Steps

One command does everything: setup, the dataset, training and the int8 export. A rerun skips whatever is already done. `./train.sh smoke` runs the whole pipeline in about a minute first (6 small steps), to catch errors before a long run.

```sh
./active/tts-finetune/train.sh all                         # from the repo root
VOICE=am_michael CLIPS=1200 ./active/tts-finetune/train.sh all
```

The transcripts are Active's own Markdown docs for its vocabulary (up to half the clips), plus random Wikipedia sentences (WikiText-2) for variety. Kokoro reads each one. The separate steps are still available: `./train.sh setup`, `./train.sh data --help` and `./train.sh train`. Any extra arguments to `train` go to `train_vits.py`; for example, `./train.sh train --resume` continues a stopped run from its last checkpoint.

1. **Sentences.** For your own text, run `./train.sh data --out data/... --wikitext your.txt` and pass any text or Markdown files. The best source is text like what Active narrates, such as walkthrough narration exported from history, docs, and READMEs. Code blocks, links and list marks are stripped. Aim for 300 or more sentences, about 20 to 40 minutes of audio. More data gives a better result.
2. **Voice.** Choose any Kokoro English voice. `af_*` and `am_*` are American, and `bf_*` and `bm_*` are British. The fine-tune has that one voice.
3. **Training.** `train_vits.py` is our own VITS fine-tuning loop on transformers' `VitsModel`. It starts from `ylacombe/mms-tts-eng-train`, which includes the pretrained discriminator. It runs on CUDA, Apple's GPU (MPS) or the CPU.
   - **Progress:** every 10 steps it prints a JSON line with the losses and an ETA, also written to `out/<run>/log.jsonl`.
   - **Samples:** every 200 steps it writes validation losses and a sample WAV to `out/<run>/samples/`.
   - **Checkpoint:** it keeps one resumable checkpoint.
   - **Speed:** on an M-series MacBook Air it runs at about 5 s per step at batch 16, so roughly 2.5 hours for 1,880 steps.
4. **Listen.** Run `../../.tools/tts-venv/bin/python compare.py out/mms-eng-kokoro-int8 "Some sentence"` to write `compare-stock.wav` and `compare-finetuned.wav`.
5. **Use it.** Training ends by exporting `out/mms-eng-kokoro-int8` (`export_onnx.py --check` first confirms the export matches torch). In Active, set `active.narration.mmsModel` to that folder's absolute path, and narration restarts with it. To export any checkpoint yourself, run `python export_onnx.py <checkpoint> <out folder> --check`.

The text is normalized with the sidecar's own `normalize()` from `active/extension/resources/mms_sidecar.py`. It splits camelCase and spells out numbers and symbols, so the model is trained on the same words it will be given at runtime.

## Licences

- MMS weights are CC-BY-NC 4.0, so the fine-tune is non-commercial too.
- Kokoro is Apache-2.0, so training on its output is allowed.

After the hackathon, set `active.narration.engine` back to `phonon` (Apache-2.0).
