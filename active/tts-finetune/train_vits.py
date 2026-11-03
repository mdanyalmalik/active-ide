# Copyright (c) Active contributors. Licensed under the MIT License.
"""Fine-tunes MMS English (a VITS model) on an audiofolder dataset: wavs/ plus metadata.csv (file_name,text[,speaker_id]).

Standard VITS training (Kim et al., 2021) on transformers' own VitsModel modules: posterior encoder -> flow -> monotonic
alignment search against the text prior, stochastic duration loss, KL loss, mel L1 on a random decoded slice, and a
HiFi-GAN discriminator (one scale + five period discriminators) with least-squares adversarial and feature-matching
losses. The discriminator matches the layout in ylacombe/mms-tts-eng-train, so it starts from those pretrained weights.

    python train_vits.py --data data/kokoro-af_heart --out out/mms-eng-kokoro --steps 1880

Runs on CUDA, Apple's MPS, or CPU. Prints a progress line every --log-every steps (and appends it to <out>/log.jsonl),
writes a sample WAV every --eval-every steps, keeps one resumable checkpoint (<out>/checkpoint.pt, --resume), and ends by
saving a VitsModel folder that export_onnx.py turns into the int8 model Active runs.
"""

import argparse
import csv
import json
import math
import random
import time
from pathlib import Path

import numpy as np
import soundfile
import torch
from torch import nn
from torch.nn import functional as F
from torch.nn.utils import parametrize
from torch.nn.utils.parametrizations import weight_norm

N_FFT = 1024
HOP = 256
MEL_BINS = 80
LEAKY = 0.1
# Loss weights from the HF fine-tuning recipe for MMS (mel 35, KL 1.5, discriminator 3, the rest 1).
WEIGHTS = {"mel": 35.0, "kl": 1.5, "duration": 1.0, "fmaps": 1.0, "gen": 1.0, "disc": 3.0}


# ---------------------------------------------------------------- features (as in VITS / the HF feature extractor)

class Features:
    """Linear magnitude spectrogram (the posterior encoder's input) and log-mel (for the mel loss)."""

    def __init__(self, sample_rate, device):
        from transformers.audio_utils import mel_filter_bank

        mel = mel_filter_bank(num_frequency_bins=N_FFT // 2 + 1, num_mel_filters=MEL_BINS, min_frequency=0.0,
                              max_frequency=sample_rate // 2, sampling_rate=sample_rate, norm="slaney", mel_scale="slaney")
        self.mel = torch.from_numpy(mel.T).float().to(device)  # (mel, freq)
        self.window = torch.hann_window(N_FFT).to(device)

    def __call__(self, waveform):
        """waveform (batch, samples) -> magnitudes (batch, 513, frames), log-mel (batch, 80, frames); frames = samples // 256."""
        pad = (N_FFT - HOP) // 2
        padded = F.pad(waveform.unsqueeze(1), (pad, pad), mode="reflect").squeeze(1)
        stft = torch.stft(padded, N_FFT, hop_length=HOP, win_length=N_FFT, window=self.window, center=False,
                          normalized=False, onesided=True, return_complex=True)
        magnitudes = torch.sqrt(stft.real.pow(2) + stft.imag.pow(2) + 1e-6)
        return magnitudes, torch.log(torch.clamp(self.mel @ magnitudes, min=1e-5))


# ---------------------------------------------------------------- discriminator (HiFi-GAN, as VITS uses it)

class ScaleDiscriminator(nn.Module):
    def __init__(self):
        super().__init__()
        # (in, out, kernel, stride, groups, padding); the shapes match the pretrained checkpoint.
        specs = [(1, 16, 15, 1, 1, 7), (16, 64, 41, 4, 4, 20), (64, 256, 41, 4, 16, 20), (256, 1024, 41, 4, 64, 20),
                 (1024, 1024, 41, 4, 256, 20), (1024, 1024, 5, 1, 1, 2)]
        self.convs = nn.ModuleList(nn.Conv1d(i, o, k, s, groups=g, padding=p) for i, o, k, s, g, p in specs)
        self.final_conv = nn.Conv1d(1024, 1, 3, 1, padding=1)

    def forward(self, x):
        maps = []
        for conv in self.convs:
            x = F.leaky_relu(conv(x), LEAKY)
            maps.append(x)
        x = self.final_conv(x)
        maps.append(x)
        return torch.flatten(x, 1, -1), maps


class PeriodDiscriminator(nn.Module):
    def __init__(self, period, kernel=5, stride=3):
        super().__init__()
        self.period = period
        channels = [1, 32, 128, 512, 1024]
        pad = ((kernel - 1) // 2, 0)
        self.convs = nn.ModuleList(nn.Conv2d(channels[i], channels[i + 1], (kernel, 1), (stride, 1), padding=pad) for i in range(4))
        self.convs.append(nn.Conv2d(1024, 1024, (kernel, 1), 1, padding=pad))
        self.final_conv = nn.Conv2d(1024, 1, (3, 1), 1, padding=(1, 0))

    def forward(self, x):
        batch, channels, length = x.shape
        if length % self.period:
            x = F.pad(x, (0, self.period - length % self.period), "reflect")
        x = x.view(batch, channels, -1, self.period)
        maps = []
        for conv in self.convs:
            x = F.leaky_relu(conv(x), LEAKY)
            maps.append(x)
        x = self.final_conv(x)
        maps.append(x)
        return torch.flatten(x, 1, -1), maps


class Discriminator(nn.Module):
    def __init__(self, periods=(2, 3, 5, 7, 11)):
        super().__init__()
        self.discriminators = nn.ModuleList([ScaleDiscriminator()] + [PeriodDiscriminator(p) for p in periods])

    def forward(self, waveform):
        outputs, maps = [], []
        for discriminator in self.discriminators:
            out, fmap = discriminator(waveform)
            outputs.append(out)
            maps.append(fmap)
        return outputs, maps


def pretrained_discriminator(base, periods):
    """The discriminator stored next to the generator in a *-train checkpoint (keys `discriminator.*`), if any."""
    from huggingface_hub import hf_hub_download

    discriminator = Discriminator(periods)
    path = Path(base)
    files = [path / "pytorch_model.bin", path / "model.safetensors"] if path.is_dir() else []
    if not path.is_dir():
        for name in ("model.safetensors", "pytorch_model.bin"):
            try:
                files.append(Path(hf_hub_download(base, name)))
            except Exception:  # noqa: BLE001 - the other format may exist
                pass
    for file in files:
        if not file.is_file():
            continue
        if file.suffix == ".safetensors":
            from safetensors.torch import load_file
            state = load_file(str(file))
        else:
            state = torch.load(file, map_location="cpu", weights_only=True)
        own = {k[len("discriminator."):]: v for k, v in state.items() if k.startswith("discriminator.")}
        if own:
            discriminator.load_state_dict(own)
            return discriminator, True
    return discriminator, False


# ---------------------------------------------------------------- monotonic alignment search

def monotonic_alignment(neg_cent, text_lengths, spec_lengths):
    """Most likely monotonic, surjective text->frame alignment (VITS's MAS). neg_cent (batch, frames, text) -> 0/1 path."""
    neg_cent = neg_cent.detach().float().cpu().numpy()
    path = np.zeros(neg_cent.shape, dtype=np.float32)
    for b in range(neg_cent.shape[0]):
        t_x, t_y = int(text_lengths[b]), int(spec_lengths[b])
        value = neg_cent[b, :t_y, :t_x].astype(np.float64)
        x = np.arange(t_x)
        for y in range(t_y):
            if y == 0:
                best = np.where(x == 0, 0.0, -np.inf)
            else:
                stay = np.where(x == y, -np.inf, value[y - 1])  # frame y can't stay on a token it couldn't reach
                move = np.concatenate([[-np.inf], value[y - 1, :-1]])
                best = np.maximum(stay, move)
            value[y] += best
            value[y, (x < t_x + y - t_y) | (x > y)] = -np.inf  # keep every token reachable and in order
        index = t_x - 1
        for y in range(t_y - 1, -1, -1):
            path[b, y, index] = 1
            if index != 0 and (index == y or value[y - 1, index] < value[y - 1, index - 1]):
                index -= 1
    return torch.from_numpy(path)


# ---------------------------------------------------------------- losses

def kl_loss(prior_latents, posterior_log_std, prior_means, prior_log_std, mask):
    kl = prior_log_std - posterior_log_std - 0.5
    kl = kl + 0.5 * (prior_latents - prior_means) ** 2 * torch.exp(-2.0 * prior_log_std)
    return torch.sum(kl * mask) / torch.sum(mask)


def discriminator_loss(real, fake):
    real_loss = sum(torch.mean((1 - r) ** 2) for r in real)
    fake_loss = sum(torch.mean(f ** 2) for f in fake)
    return real_loss + fake_loss, real_loss, fake_loss


def generator_loss(fake):
    return sum(torch.mean((1 - f) ** 2) for f in fake)


def feature_loss(real_maps, fake_maps):
    return 2 * sum(torch.mean(torch.abs(r.detach() - f)) for rm, fm in zip(real_maps, fake_maps) for r, f in zip(rm, fm))


# ---------------------------------------------------------------- data

def load_clips(folder, tokenizer, sample_rate, min_seconds, max_seconds, max_tokens):
    folder = Path(folder)
    clips, skipped = [], 0
    with open(folder / "metadata.csv", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            audio, rate = soundfile.read(folder / row["file_name"], dtype="float32")
            if audio.ndim > 1:
                audio = audio.mean(axis=1)
            if rate != sample_rate:
                from scipy.signal import resample_poly
                audio = resample_poly(audio, sample_rate, rate).astype(np.float32)
            ids = tokenizer(row["text"])["input_ids"]
            seconds = len(audio) / sample_rate
            if not (min_seconds <= seconds <= max_seconds) or len(ids) > max_tokens or len(ids) < 2:
                skipped += 1
                continue
            clips.append((np.asarray(ids, dtype=np.int64), audio))
    return clips, skipped


def batches(clips, batch_size, rng):
    """Endless batches of similar length (less padding): shuffle, sort within pools of 8 batches, shuffle the batches."""
    order = list(range(len(clips)))
    while True:
        rng.shuffle(order)
        pool = batch_size * 8
        groups = []
        for start in range(0, len(order), pool):
            chunk = sorted(order[start:start + pool], key=lambda i: len(clips[i][1]))
            groups += [chunk[i:i + batch_size] for i in range(0, len(chunk), batch_size)]
        rng.shuffle(groups)
        for group in groups:
            if len(group) == batch_size:
                yield [clips[i] for i in group]


def collate(batch, device):
    text_lengths = torch.tensor([len(ids) for ids, _ in batch])
    wave_lengths = torch.tensor([len(audio) for _, audio in batch])
    input_ids = torch.zeros(len(batch), int(text_lengths.max()), dtype=torch.long)
    waveform = torch.zeros(len(batch), int(wave_lengths.max()))
    for i, (ids, audio) in enumerate(batch):
        input_ids[i, :len(ids)] = torch.from_numpy(ids)
        waveform[i, :len(audio)] = torch.from_numpy(audio)
    return input_ids.to(device), text_lengths, waveform.to(device), wave_lengths


def length_mask(lengths, size, device):
    return (torch.arange(size, device=device)[None, :] < lengths.to(device)[:, None]).float()


# ---------------------------------------------------------------- the VITS training forward pass

def forward(model, features, input_ids, text_lengths, waveform, wave_lengths, segment_frames):
    device = input_ids.device
    spec_lengths = wave_lengths // HOP
    magnitudes, log_mel = features(waveform)
    frames = int(spec_lengths.max())
    magnitudes, log_mel = magnitudes[..., :frames], log_mel[..., :frames]

    text_mask = length_mask(text_lengths, input_ids.shape[1], device)  # (b, tx)
    spec_mask = length_mask(spec_lengths, frames, device).unsqueeze(1)  # (b, 1, ty)
    encoded = model.text_encoder(input_ids=input_ids, padding_mask=text_mask.unsqueeze(-1), attention_mask=text_mask.long())
    hidden = encoded.last_hidden_state.transpose(1, 2)  # (b, h, tx)
    text_padding = text_mask.unsqueeze(1)  # (b, 1, tx)
    prior_means = encoded.prior_means.transpose(1, 2)  # (b, c, tx)
    prior_log_std = encoded.prior_log_variances.transpose(1, 2)  # VITS's logs_p: a log standard deviation

    latents, _, posterior_log_std = model.posterior_encoder(magnitudes, spec_mask)
    prior_latents = model.flow(latents, spec_mask, None, reverse=False)

    with torch.no_grad():
        inverse_variance = torch.exp(-2 * prior_log_std)
        neg_cent = (torch.sum(-0.5 * math.log(2 * math.pi) - prior_log_std, [1], keepdim=True)
                    + torch.matmul(-0.5 * (prior_latents ** 2).transpose(1, 2), inverse_variance)
                    + torch.matmul(prior_latents.transpose(1, 2), prior_means * inverse_variance)
                    + torch.sum(-0.5 * prior_means ** 2 * inverse_variance, [1], keepdim=True))  # (b, ty, tx)
        attn = monotonic_alignment(neg_cent, text_lengths, spec_lengths).to(device)  # (b, ty, tx)

    durations = attn.sum(1).unsqueeze(1)  # (b, 1, tx)
    duration_nll = model.duration_predictor(hidden, text_padding, None, durations=durations, reverse=False)
    loss_duration = torch.sum(duration_nll / torch.sum(text_padding))

    expanded_means = torch.matmul(attn, prior_means.transpose(1, 2)).transpose(1, 2)  # (b, c, ty)
    expanded_log_std = torch.matmul(attn, prior_log_std.transpose(1, 2)).transpose(1, 2)
    loss_kl = kl_loss(prior_latents, posterior_log_std, expanded_means, expanded_log_std, spec_mask)

    # Decode a random slice of each clip's latents and compare it with the same slice of the real audio.
    starts = (torch.rand(len(spec_lengths)) * (spec_lengths - segment_frames + 1).clamp(min=1).float()).long()
    latent_slice = torch.stack([latents[i, :, s:s + segment_frames] for i, s in enumerate(starts)])
    mel_target = torch.stack([log_mel[i, :, s:s + segment_frames] for i, s in enumerate(starts)])
    real = torch.stack([waveform[i, s * HOP:(s + segment_frames) * HOP] for i, s in enumerate(starts)]).unsqueeze(1)
    fake = model.decoder(latent_slice, None)  # (b, 1, segment_frames * HOP)
    loss_mel = F.l1_loss(features(fake.squeeze(1))[1], mel_target)
    return {"duration": loss_duration, "kl": loss_kl, "mel": loss_mel}, real, fake


# ---------------------------------------------------------------- weight norm (the recipe trains the decoder and flow ends with it)

def decoder_and_flow_convs(model):
    """The layers the recipe trains with weight norm: the decoder's upsamplers and residual convs, and each flow's ends.
    (The text and posterior encoders' WaveNets already carry weight norm in the checkpoint.)"""
    layers = list(model.decoder.upsampler)
    for block in model.decoder.resblocks:
        layers += list(block.convs1) + list(block.convs2)
    for flow in model.flow.flows:
        layers += [flow.conv_pre, flow.conv_post]
    return layers


def add_weight_norm(model, discriminator):
    """Adds weight norm (exact: g = |v| at the start) and returns the generator layers it went on, to fold back later.
    Done here rather than with VitsHifiGan.apply/remove_weight_norm, whose two halves use different torch APIs in some
    transformers versions."""
    layers = [layer for layer in decoder_and_flow_convs(model) if not parametrize.is_parametrized(layer, "weight")]
    for layer in layers:
        weight_norm(layer)
    for module in discriminator.modules():
        if isinstance(module, (nn.Conv1d, nn.Conv2d)):
            weight_norm(module)
    return layers


def remove_added_weight_norm(layers):
    for layer in layers:
        parametrize.remove_parametrizations(layer, "weight", leave_parametrized=True)


def pick_device(name):
    if name != "auto":
        return torch.device(name)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def write_wav(path, audio, rate):
    soundfile.write(path, np.clip(audio, -1, 1), rate)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--data", required=True, help="audiofolder: wavs + metadata.csv")
    parser.add_argument("--out", required=True)
    parser.add_argument("--base", default="ylacombe/mms-tts-eng-train", help="VITS checkpoint with a discriminator")
    parser.add_argument("--steps", type=int, default=1880)
    parser.add_argument("--batch", type=int, default=16)
    parser.add_argument("--lr", type=float, default=2e-5)
    parser.add_argument("--warmup", type=float, default=0.01, help="fraction of steps")
    parser.add_argument("--segment-frames", type=int, default=32, help="decoded slice length (32 frames = 8192 samples)")
    parser.add_argument("--min-seconds", type=float, default=1.0)
    parser.add_argument("--max-seconds", type=float, default=20.0)
    parser.add_argument("--max-tokens", type=int, default=500)
    parser.add_argument("--log-every", type=int, default=10)
    parser.add_argument("--eval-every", type=int, default=200, help="validation losses + a sample WAV")
    parser.add_argument("--save-every", type=int, default=200, help="resumable checkpoint")
    parser.add_argument("--val-clips", type=int, default=16, help="held out for validation")
    parser.add_argument("--sample-text", default="This function reads the config file, then retries the request three times.")
    parser.add_argument("--device", default="auto", help="auto, cuda, mps or cpu")
    parser.add_argument("--resume", action="store_true", help="continue from <out>/checkpoint.pt")
    parser.add_argument("--seed", type=int, default=456)
    args = parser.parse_args()

    from transformers import AutoTokenizer, VitsModel

    random.seed(args.seed)
    np.random.seed(args.seed)
    torch.manual_seed(args.seed)
    rng = random.Random(args.seed)
    device = pick_device(args.device)
    out = Path(args.out)
    (out / "samples").mkdir(parents=True, exist_ok=True)

    tokenizer = AutoTokenizer.from_pretrained(args.base)
    model = VitsModel.from_pretrained(args.base)
    discriminator, pretrained = pretrained_discriminator(args.base, tuple(model.config.discriminator_periods) if hasattr(model.config, "discriminator_periods") else (2, 3, 5, 7, 11))
    rate = model.config.sampling_rate
    clips, skipped = load_clips(args.data, tokenizer, rate, args.min_seconds, args.max_seconds, args.max_tokens)
    rng.shuffle(clips)
    val, train = clips[:args.val_clips], clips[args.val_clips:]
    if len(train) < args.batch:
        raise SystemExit(f"only {len(train)} training clips; need at least --batch ({args.batch})")
    print(f"{len(train)} training clips, {len(val)} validation, {skipped} skipped; discriminator "
          f"{'from ' + args.base if pretrained else 'from scratch'}; device {device}", flush=True)

    normed = add_weight_norm(model, discriminator)
    model.to(device).train()
    discriminator.to(device).train()
    features = Features(rate, device)
    gen_optimizer = torch.optim.AdamW(model.parameters(), lr=args.lr, betas=(0.8, 0.99), eps=1e-8)
    disc_optimizer = torch.optim.AdamW(discriminator.parameters(), lr=args.lr, betas=(0.8, 0.99), eps=1e-8)
    warmup = max(1, int(args.steps * args.warmup))
    schedule = lambda step: min(1.0, (step + 1) / warmup) * max(0.0, (args.steps - step) / max(1, args.steps - warmup))  # noqa: E731
    gen_scheduler = torch.optim.lr_scheduler.LambdaLR(gen_optimizer, schedule)
    disc_scheduler = torch.optim.lr_scheduler.LambdaLR(disc_optimizer, schedule)

    step = 0
    checkpoint = out / "checkpoint.pt"
    if args.resume and checkpoint.is_file():
        state = torch.load(checkpoint, map_location=device, weights_only=False)
        model.load_state_dict(state["model"])
        discriminator.load_state_dict(state["discriminator"])
        gen_optimizer.load_state_dict(state["gen_optimizer"])
        disc_optimizer.load_state_dict(state["disc_optimizer"])
        gen_scheduler.load_state_dict(state["gen_scheduler"])
        disc_scheduler.load_state_dict(state["disc_scheduler"])
        step = state["step"]
        print(f"resumed at step {step}", flush=True)

    def sample(name):
        model.eval()
        with torch.no_grad():
            ids = tokenizer(args.sample_text, return_tensors="pt").to(device)
            torch.manual_seed(0)
            audio = model(**ids).waveform[0].float().cpu().numpy()
        write_wav(out / "samples" / f"{name}.wav", audio, rate)
        model.train()

    def validate():
        model.eval()
        totals = {"duration": 0.0, "kl": 0.0, "mel": 0.0}
        with torch.no_grad():
            for start in range(0, len(val), args.batch):
                group = val[start:start + args.batch]
                losses, _, _ = forward(model, features, *collate(group, device), args.segment_frames)
                for key in totals:
                    totals[key] += losses[key].item() * len(group)
        model.train()
        return {f"val_{key}": value / max(1, len(val)) for key, value in totals.items()}

    log = open(out / "log.jsonl", "a", encoding="utf-8")
    if step == 0:
        sample("step-0000")
        print(json.dumps({"step": 0, **validate()}), flush=True)
    stream = batches(train, args.batch, rng)
    started = time.time()
    first_step = step
    running = {}
    while step < args.steps:
        input_ids, text_lengths, waveform, wave_lengths = collate(next(stream), device)
        losses, real, fake = forward(model, features, input_ids, text_lengths, waveform, wave_lengths, args.segment_frames)

        # Discriminator: real slices toward 1, generated toward 0.
        real_scores, _ = discriminator(real)
        fake_scores, _ = discriminator(fake.detach())
        loss_disc, loss_real, loss_fake = discriminator_loss(real_scores, fake_scores)
        disc_optimizer.zero_grad(set_to_none=True)
        (loss_disc * WEIGHTS["disc"]).backward()
        torch.nn.utils.clip_grad_norm_(discriminator.parameters(), 1.0)
        disc_optimizer.step()
        disc_scheduler.step()

        # Generator: fool the discriminator, match its features, and the VITS likelihood terms.
        _, real_maps = discriminator(real)
        fake_scores, fake_maps = discriminator(fake)
        losses["fmaps"] = feature_loss(real_maps, fake_maps)
        losses["gen"] = generator_loss(fake_scores)
        total = sum(losses[key] * WEIGHTS[key] for key in ("duration", "mel", "kl", "fmaps", "gen"))
        gen_optimizer.zero_grad(set_to_none=True)
        total.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        gen_optimizer.step()
        gen_scheduler.step()
        step += 1

        values = {key: value.item() for key, value in losses.items()} | {"disc": loss_disc.item(), "disc_real": loss_real.item(), "disc_fake": loss_fake.item()}
        if not all(math.isfinite(v) for v in values.values()):
            raise SystemExit(f"step {step}: loss is not finite: {values}")
        for key, value in values.items():
            running[key] = running.get(key, 0.0) + value
        if step % args.log_every == 0 or step == args.steps:
            count = args.log_every if step % args.log_every == 0 else step % args.log_every
            seconds = (time.time() - started) / (step - first_step)
            entry = {"step": step, **{k: round(v / count, 4) for k, v in running.items()}, "lr": gen_scheduler.get_last_lr()[0],
                     "s_per_step": round(seconds, 2), "eta_min": round(seconds * (args.steps - step) / 60, 1)}
            running = {}
            print(json.dumps(entry), flush=True)
            log.write(json.dumps(entry) + "\n")
            log.flush()
        if step % args.eval_every == 0 or step == args.steps:
            entry = {"step": step, **validate()}
            print(json.dumps(entry), flush=True)
            log.write(json.dumps(entry) + "\n")
            log.flush()
            sample(f"step-{step:04d}")
        if step % args.save_every == 0 and step < args.steps:
            torch.save({"model": model.state_dict(), "discriminator": discriminator.state_dict(),
                        "gen_optimizer": gen_optimizer.state_dict(), "disc_optimizer": disc_optimizer.state_dict(),
                        "gen_scheduler": gen_scheduler.state_dict(), "disc_scheduler": disc_scheduler.state_dict(),
                        "step": step}, checkpoint.with_suffix(".tmp"))
            checkpoint.with_suffix(".tmp").replace(checkpoint)

    # A plain VitsModel folder (no discriminator, decoder weight norm folded), as from_pretrained and export_onnx.py expect.
    remove_added_weight_norm(normed)
    model.to("cpu").eval()
    model.save_pretrained(out)
    tokenizer.save_pretrained(out)
    checkpoint.unlink(missing_ok=True)
    print(f"saved {out}", flush=True)


if __name__ == "__main__":
    main()
