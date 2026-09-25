#!/usr/bin/env python
"""Build a voice profile from recordings of one person talking.

    python build_voice.py build --workspace ~/voice-clone/voices/mark --name mark
    python build_voice.py export ~/voice-clone/profiles/mark
    python build_voice.py import mark.voice.zip
    python build_voice.py eval clip.wav …

`build` is the whole pipeline, and what the Voice Studio page runs through the
companion server:

    <workspace>/sources/*       recordings (takes, old screencasts, any audio/video)
      └─ ingest    ffmpeg → 48 kHz mono; voiceprint; drop other voices;
                   Whisper word timings; 3-15 s clips at pauses
    <workspace>/dataset/        clips + meta.json
      └─ train     VoxCPM2 LoRA on the Mac GPU (official trainer)
    <workspace>/train/ckpt/     checkpoints every 50 steps
      └─ choose    speak held-out lines with the last few checkpoints; keep
                   the one that sounds most like you and gets the words right
      └─ profile   reference clip, pause model measured from your recordings
    <profiles>/<name>/          the saved voice (schema: voice_profile.py)
    <workspace>/<name>.voice.zip

With `--json`, progress is printed as one JSON object per line:
{"stage": "...", "done": n, "total": m, "note": "..."}; the last line is
{"stage": "done", "profile": ..., "zip": ...} or {"stage": "error", "message": ...}.

Each choice was measured on the first profile (see ../REQUIREMENTS.md):
natural narration over read prompts, a voiceprint check so other speakers and
previously respoken audio never reach training, clips cut on word timings
with short tails (long tails teach the model to run on), and loudness
normalised per file so the movement inside a sentence survives.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import re
import shutil
import subprocess
import sys
import time
import warnings
from pathlib import Path

import numpy as np

import voice_profile

warnings.filterwarnings("ignore")
os.environ.setdefault("TQDM_DISABLE", "1")
HOME = Path(os.environ.get("VOICE_HOME", Path.home() / "voice-clone"))
ASR = "mlx-community/whisper-large-v3-turbo"
BASE = "openbmb/VoxCPM2"
MEDIA = {".wav", ".flac", ".mp3", ".m4a", ".aac", ".ogg", ".opus", ".mov", ".mp4", ".m4v", ".mkv", ".webm"}
MIN_MINUTES = 3.0          # below this, refuse: it cannot learn a voice
GOOD_MINUTES = 20.0        # below this, warn: it will be thin

JSON = False


def emit(stage: str, done=None, total=None, **kw):
    if JSON:
        print(json.dumps({"stage": stage, "done": done, "total": total, "t": time.time(), **kw}), flush=True)
    else:
        # One line per file / every 25 training steps, not per step.
        if stage == "train" and done not in (0, total) and done % 25:
            return
        extra = f" {done}/{total}" if total else ""
        note = f" — {kw['note']}" if kw.get("note") else ""
        print(f"[{stage}]{extra}{note}", flush=True)


class BuildError(RuntimeError):
    pass


def slug(p: str) -> str:
    return re.sub(r"[^A-Za-z0-9._-]", "_", Path(p).stem)[:60]


# ---------------------------------------------------------------------------
# speaker embeddings
# ---------------------------------------------------------------------------

_ENC = None


def encoder():
    global _ENC
    if _ENC is None:
        from speechbrain.inference.speaker import EncoderClassifier
        import torch
        dev = "mps" if torch.backends.mps.is_available() else "cpu"
        _ENC = EncoderClassifier.from_hparams("speechbrain/spkrec-ecapa-voxceleb",
                                              savedir=str(HOME / "models" / "ecapa"),
                                              run_opts={"device": dev})
    return _ENC


def embed(x16: np.ndarray, win=6.0) -> np.ndarray:
    import torch
    W = int(win * 16000)
    ws = [x16[i:i + W] for i in range(0, max(1, len(x16) - W + 1), W // 2)
          if np.sqrt(np.mean(x16[i:i + W] ** 2)) > 0.003]
    if not ws:
        return np.zeros((0, 192), np.float32)
    ws = [np.pad(w, (0, W - len(w))) for w in ws]
    out = []
    for k in range(0, len(ws), 32):
        e = encoder().encode_batch(torch.tensor(np.stack(ws[k:k + 32]).astype(np.float32))).squeeze(1)
        out.append(torch.nn.functional.normalize(e, dim=-1).cpu().numpy())
    return np.concatenate(out)


def embed_one(y: np.ndarray, sr: int) -> np.ndarray:
    import librosa
    import torch
    e = encoder().encode_batch(torch.tensor(librosa.resample(y, orig_sr=sr, target_sr=16000).astype(np.float32))[None]).squeeze(1)
    return torch.nn.functional.normalize(e, dim=-1).cpu().numpy()[0]


def load16(path) -> np.ndarray:
    import librosa
    import soundfile as sf
    x, sr = sf.read(path, dtype="float32")
    if x.ndim > 1:
        x = x.mean(1)
    return librosa.resample(x, orig_sr=sr, target_sr=16000)


def voiceprint(per_file: list[np.ndarray]) -> np.ndarray:
    """The dominant voice across all recordings.

    Start from the mean of every speech window, then twice drop the windows
    that are not like it and re-average. Recordings of one person with the odd
    guest or clip of someone else converge on the owner.
    """
    E = np.concatenate([e for e in per_file if len(e)])
    c = E.mean(0)
    for _ in range(3):
        c /= np.linalg.norm(c)
        keep = E[E @ c > 0.45]
        if len(keep) < 5:
            break
        c = keep.mean(0)
    return c / np.linalg.norm(c)


# ---------------------------------------------------------------------------
# ingest
# ---------------------------------------------------------------------------

def to_wav(src: Path, dst: Path):
    if not dst.exists():
        r = subprocess.run(["ffmpeg", "-v", "error", "-nostdin", "-y", "-i", str(src), "-vn", "-ac", "1",
                            "-ar", "48000", "-c:a", "pcm_s24le", str(dst)], capture_output=True, text=True)
        if r.returncode != 0:
            raise BuildError(f"could not read {src.name}: {r.stderr.strip()[:200]}")


def transcribe(wav: Path, out: Path) -> dict:
    if out.exists():
        return json.loads(out.read_text())
    import mlx_whisper
    r = mlx_whisper.transcribe(str(wav), path_or_hf_repo=ASR, word_timestamps=True,
                               language="en", condition_on_previous_text=False)
    out.write_text(json.dumps(r))
    return r


def segment(r: dict) -> list[list[dict]]:
    words = [w for s in r["segments"]
             if s["no_speech_prob"] < 0.5 and s["avg_logprob"] > -0.6 and s["compression_ratio"] < 2.2
             for w in s.get("words", [])]
    segs, cur = [], []
    for w in words:
        if cur:
            gap = w["start"] - cur[-1]["end"]
            dur = cur[-1]["end"] - cur[0]["start"]
            endp = cur[-1]["word"].strip()[-1:] in ".?!"
            if gap > 1.0 or dur + (w["end"] - w["start"]) + gap > 15 or (dur > 4 and gap > 0.35) \
                    or (dur > 6 and endp and gap > 0.15):
                segs.append(cur)
                cur = []
        cur.append(w)
    if cur:
        segs.append(cur)
    return segs


def ingest(ws: Path, min_file_sim=0.5, min_clip_sim=0.45) -> dict:
    import pyloudnorm as pyln
    import soundfile as sf

    sources = sorted(p for p in (ws / "sources").iterdir() if p.suffix.lower() in MEDIA) \
        if (ws / "sources").exists() else []
    if not sources:
        raise BuildError("No recordings yet. Record some takes or add recordings of you talking.")
    for d in ("raw", "transcripts", "dataset/wavs48"):
        (ws / d).mkdir(parents=True, exist_ok=True)

    emit("convert", 0, len(sources))
    wavs, skipped = [], []
    for i, s in enumerate(sources):
        w = ws / "raw" / f"{slug(s.name)}.wav"
        try:
            to_wav(s, w)
        except BuildError:
            # A screen recording without an audio track, a broken file: say
            # so at the end, do not stop the whole build over it.
            skipped.append({"source": s.name, "reason": "no audio track (or unreadable)"})
            emit("convert", i + 1, len(sources), note=f"skipped {s.name}: no audio")
            continue
        if w.stat().st_size < 44 + 48000 * 3 * 2:              # under ~2 s
            skipped.append({"source": s.name, "reason": "shorter than 2 s"})
            continue
        wavs.append((s, w))
        emit("convert", i + 1, len(sources), note=s.name)
    if not wavs:
        raise BuildError("None of the recordings has usable audio.")

    emit("voiceprint", 0, len(wavs))
    embs = []
    for i, (_, w) in enumerate(wavs):
        embs.append(embed(load16(w)))
        emit("voiceprint", i + 1, len(wavs))
    C = voiceprint(embs)
    np.save(ws / "voiceprint.npy", C)

    meta = []
    emit("transcribe", 0, len(wavs))
    for i, ((s, w), e) in enumerate(zip(wavs, embs)):
        n = slug(s.name)
        sim = float(np.median(e @ C)) if len(e) else 0.0
        if len(e) == 0 or sim < min_file_sim:
            skipped.append({"source": s.name, "reason": f"not the same voice (similarity {sim:.2f})"})
            emit("transcribe", i + 1, len(wavs), note=f"skipped {s.name}: not the same voice ({sim:.2f})")
            continue
        r = transcribe(w, ws / "transcripts" / f"{n}.json")
        x, sr = sf.read(w, dtype="float32")
        raw = x
        lufs = pyln.Meter(sr).integrated_loudness(x)
        if np.isfinite(lufs):
            x = pyln.normalize.loudness(x, lufs, -20.0)
        kept = 0
        for k, sg in enumerate(segment(r)):
            st, en = sg[0]["start"], sg[-1]["end"]
            if en - st < 2.5:
                continue
            if np.mean([w_["probability"] for w_ in sg]) < 0.75 or min(w_["probability"] for w_ in sg) < 0.2:
                continue
            i0, i1 = max(0, int((st - 0.12) * sr)), min(len(x), int((en + 0.25) * sr))
            if np.max(np.abs(raw[i0:i1])) > 0.995:
                continue                       # clipped in the recording itself
            y = x[i0:i1].copy()
            pk = np.max(np.abs(y))
            if pk > 0.9:
                y *= 0.9 / pk
            cs = float(embed_one(y, sr) @ C)
            if cs < min_clip_sim:
                continue
            f = int(0.01 * sr)
            y[:f] *= np.linspace(0, 1, f)
            y[-f:] *= np.linspace(1, 0, f)
            uid = f"{n[:40]}_{k:04d}"
            sf.write(ws / "dataset" / "wavs48" / f"{uid}.wav", y, sr, subtype="PCM_16")
            meta.append(dict(id=uid, text="".join(w_["word"] for w_ in sg).strip(),
                             dur=round(len(y) / sr, 2), sim=round(cs, 3), src=n))
            kept += 1
        emit("transcribe", i + 1, len(wavs), note=f"{s.name}: {kept} clips")
    (ws / "dataset" / "meta.json").write_text(json.dumps(meta, indent=0))
    minutes = sum(m["dur"] for m in meta) / 60
    return {"clips": len(meta), "minutes": round(minutes, 1), "skipped": skipped}


# ---------------------------------------------------------------------------
# pauses: measured from the speaker's own word gaps
# ---------------------------------------------------------------------------

def measure_pauses(ws: Path) -> dict:
    gaps = {"sentence": [], "clause": []}
    for tj in (ws / "transcripts").glob("*.json"):
        r = json.loads(tj.read_text())
        W = [w for s in r["segments"] for w in s.get("words", [])]
        for a, b in zip(W, W[1:]):
            g = b["start"] - a["end"]
            if not 0.04 < g < 2.0:
                continue
            e = a["word"].strip()[-1:]
            if e in ".?!":
                gaps["sentence"].append(g)
            elif e in ",;:":
                gaps["clause"].append(g)
    default = {"sentence": {"median": 0.3, "sigma": 0.45, "min": 0.14, "max": 0.9},
               "clause": {"median": 0.16, "sigma": 0.35, "min": 0.06, "max": 0.4}}
    out = {}
    for k, v in gaps.items():
        v = np.array(v)
        if len(v) < 20:
            out[k] = default[k]
            continue
        lo, med, hi = np.percentile(v, [10, 50, 90])
        out[k] = {"median": round(float(med), 3), "sigma": round(float(np.std(np.log(v))), 3),
                  "min": round(float(lo), 3), "max": round(float(hi), 3)}
    s = out["sentence"]
    out["paragraph"] = {"median": round(max(0.6, s["max"] * 0.9), 3), "sigma": 0.3,
                        "min": round(max(0.45, s["median"] * 1.6), 3), "max": round(max(1.2, s["max"] * 1.6), 3)}
    for d in out.values():   # voice_profile requires min <= median <= max
        d["min"] = min(d["min"], d["median"])
        d["max"] = max(d["max"], d["median"])
    return out


# ---------------------------------------------------------------------------
# reference clip
# ---------------------------------------------------------------------------

def choose_reference(ws: Path, exclude: set[str]) -> tuple[Path, str]:
    """A 10-19 s clip of the speaker, whole sentences, ending in a pause.

    The model continues this clip before every sentence, so it must end
    cleanly: a clip that stops mid-word makes every sentence begin by
    finishing that word (heard as a "ding" before each one).
    """
    import soundfile as sf
    meta = json.loads((ws / "dataset" / "meta.json").read_text())
    pool = [m for m in meta if m["id"] not in exclude and re.search(r"[.?!]$", m["text"])]
    for lo, hi in ((12, 19), (9, 19), (6, 19)):
        cand = [m for m in pool if lo <= m["dur"] <= hi]
        if cand:
            break
    else:
        raise BuildError("No clip long enough to use as the reference: record a few longer takes.")
    best = max(cand, key=lambda m: m["sim"])
    x, sr = sf.read(ws / "dataset" / "wavs48" / f"{best['id']}.wav", dtype="float32")
    tail = x[-int(0.1 * sr):]
    x = np.concatenate([x, np.tile(tail, 4)[: int(0.3 * sr)]])
    out = ws / "reference.wav"
    sf.write(out, x, sr, subtype="PCM_16")
    return out, best["text"]


# ---------------------------------------------------------------------------
# train
# ---------------------------------------------------------------------------

LORA_YAML = """pretrained_path: {base}
train_manifest: {manifest}
val_manifest: null
sample_rate: 16000
out_sample_rate: 48000
batch_size: 4
grad_accum_steps: 4
num_workers: 0
num_iters: {iters}
log_interval: 5
valid_interval: 100000
save_interval: 50
learning_rate: 0.0001
weight_decay: 0.01
warmup_steps: 20
max_steps: {iters}
max_batch_tokens: 8192
max_grad_norm: 1.0
save_path: {save}
tensorboard: {tb}
lambdas:
  loss/diff: 1.0
  loss/stop: 1.0
lora:
  enable_lm: true
  enable_dit: true
  enable_proj: false
  r: 32
  alpha: 32
  dropout: 0.0
"""


def trainer_script() -> Path:
    env = os.environ.get("VOXCPM_REPO")
    cands = [Path(env).expanduser() / "scripts" / "train_voxcpm_finetune.py"] if env else []
    try:
        import voxcpm
        cands.append(Path(voxcpm.__file__).resolve().parents[2] / "scripts" / "train_voxcpm_finetune.py")
    except ImportError:
        pass
    cands.append(HOME / "VoxCPM" / "scripts" / "train_voxcpm_finetune.py")
    for c in cands:
        if c.exists():
            return c
    raise BuildError("VoxCPM's trainer was not found. `git clone https://github.com/OpenBMB/VoxCPM` "
                     "and `pip install -e` it (see the README), or set VOXCPM_REPO.")


def train_steps(n_clips: int) -> int:
    # 298 clips: steps 50-150 all good, 150 best, at an effective batch of 16
    # — about 8 passes. Scale with the data, in multiples of the save interval.
    return int(min(600, max(100, math.ceil(n_clips / 16 * 8 / 50) * 50)))


def train(ws: Path, iters: int | None = None, held_out: set[str] = frozenset()) -> Path:
    from huggingface_hub import snapshot_download
    meta = json.loads((ws / "dataset" / "meta.json").read_text())
    run = ws / "train"
    if run.exists():
        shutil.rmtree(run)
    run.mkdir(parents=True)
    manifest = run / "train.jsonl"
    with open(manifest, "w") as f:
        for m in meta:
            if m["id"] not in held_out:
                f.write(json.dumps({"audio": str(ws / "dataset" / "wavs48" / f"{m['id']}.wav"),
                                    "text": m["text"]}) + "\n")
    iters = iters or train_steps(len(meta))
    emit("download", note="base model (first time only, ~4.5 GB)")
    base = snapshot_download(BASE)
    cfg = run / "lora.yaml"
    cfg.write_text(LORA_YAML.format(base=base, manifest=manifest, iters=iters,
                                    save=run / "ckpt", tb=run / "tb"))
    script = trainer_script()
    env = dict(os.environ, PYTORCH_ENABLE_MPS_FALLBACK="1", PYTHONUNBUFFERED="1")
    emit("train", 0, iters)
    p = subprocess.Popen([sys.executable, "-u", str(script), "--config_path", str(cfg)],
                         cwd=script.parent.parent, env=env, stdout=subprocess.PIPE,
                         stderr=subprocess.STDOUT, text=True, bufsize=1)
    tail = []
    for line in p.stdout:
        tail = (tail + [line.rstrip()])[-30:]
        m = re.search(r"\[train\] step (\d+):.*?loss/diff: ([\d.]+)", line)
        if m:
            emit("train", int(m.group(1)) + 1, iters, note=f"loss {float(m.group(2)):.3f}")
    if p.wait() != 0:
        raise BuildError("training failed:\n" + "\n".join(tail[-12:]))
    return run / "ckpt"


# ---------------------------------------------------------------------------
# choose a checkpoint by listening to it
# ---------------------------------------------------------------------------

def words_of(t: str):
    from voice_server import words_of as w
    return w(t)


def choose_checkpoint(ws: Path, ckpt_dir: Path, ref: Path, ref_text: str, held: list[dict]) -> Path:
    """Speak held-out lines with the last few checkpoints; keep the best.

    Score = similarity to the voiceprint, minus a heavy penalty for wrong
    words (a checkpoint that babbles is worse than one that is slightly less
    like you).
    """
    import mlx_whisper
    from voice_server import wer
    from voxcpm.core import VoxCPM
    from voxcpm.model.voxcpm import LoRAConfig

    steps = sorted(ckpt_dir.glob("step_*"), key=lambda p: int(p.name.split("_")[1]))
    steps = [s for s in steps if (s / "lora_weights.safetensors").exists() and int(s.name.split("_")[1]) > 0]
    if not steps:
        raise BuildError("training produced no checkpoints")
    # The trainer saves both the last interval (e.g. 149) and the final step
    # (150); a candidate a few steps from the next one is the same weights.
    num = lambda p: int(p.name.split("_")[1])  # noqa: E731
    steps = [s for i, s in enumerate(steps) if i == len(steps) - 1 or num(steps[i + 1]) - num(s) > 5]
    cands = steps[-3:] if len(steps) >= 3 else steps
    C = np.load(ws / "voiceprint.npy")
    info = json.loads((cands[-1] / "lora_config.json").read_text())
    model = VoxCPM.from_pretrained(hf_model_id=info["base_model"], load_denoiser=False, optimize=False,
                                   lora_config=LoRAConfig(**info["lora_config"]),
                                   lora_weights_path=str(cands[-1]))
    sr = int(model.tts_model.sample_rate)
    lines = [h["text"] for h in held][:3]
    scores = []
    emit("choose", 0, len(cands) * len(lines))
    k = 0
    for c in cands:
        model.load_lora(str(c))
        model.set_lora_enabled(True)
        sims, errs = [], []
        for j, t in enumerate(lines):
            a = np.asarray(model.generate(text=t, prompt_wav_path=str(ref), prompt_text=ref_text,
                                          reference_wav_path=str(ref), cfg_value=2.0,
                                          inference_timesteps=10, max_len=1500, seed=11 + j), np.float32)
            sims.append(float(embed_one(a, sr) @ C))
            import librosa
            hyp = mlx_whisper.transcribe(librosa.resample(a, orig_sr=sr, target_sr=16000),
                                         path_or_hf_repo=ASR, language="en")["text"]
            errs.append(wer(words_of(t), words_of(hyp)))
            k += 1
            emit("choose", k, len(cands) * len(lines), note=f"{c.name}: similarity {sims[-1]:.2f}, WER {errs[-1]:.2f}")
        score = float(np.mean(sims) - 1.0 * np.mean(errs))
        scores.append((score, float(np.mean(sims)), float(np.mean(errs)), c))
    best = max(scores, key=lambda s: s[0])
    emit("choose", k, k, note=f"kept {best[3].name}: similarity {best[1]:.2f}, WER {best[2]:.2f}")
    return best[3], {"similarity": round(best[1], 3), "wer": round(best[2], 3), "checkpoint": best[3].name}


# ---------------------------------------------------------------------------
# the whole thing
# ---------------------------------------------------------------------------

def build(ws: Path, name: str, profiles: Path, iters: int | None = None, resume: bool = False) -> dict:
    if not voice_profile.NAME_RE.match(name):
        raise BuildError("name must be letters, digits, '.', '_' or '-'")
    ws = ws.expanduser()
    t0 = time.time()
    stats = ingest(ws)
    if stats["minutes"] < MIN_MINUTES:
        raise BuildError(f"Only {stats['minutes']} minutes of usable speech; at least {MIN_MINUTES:.0f} are "
                         f"needed, and {GOOD_MINUTES:.0f}+ sound much better.")
    if stats["minutes"] < GOOD_MINUTES:
        emit("warn", note=f"{stats['minutes']} minutes is enough to try; {GOOD_MINUTES:.0f}+ will sound better.")
    meta = json.loads((ws / "dataset" / "meta.json").read_text())

    # Held out of training: the reference, and a few lines to judge checkpoints by.
    ref, ref_text = choose_reference(ws, exclude=set())
    rng = np.random.default_rng(0)
    pool = [m for m in meta if 4 <= m["dur"] <= 10 and ref_text != m["text"]]
    held = [pool[i] for i in rng.choice(len(pool), size=min(3, len(pool)), replace=False)] if pool else []
    iters = iters or train_steps(len(meta))
    ckpt = ws / "train" / "ckpt"
    if resume and (ckpt / f"step_{iters:07d}" / "lora_weights.safetensors").exists():
        emit("train", iters, iters, note="reusing the finished training run")
    else:
        ckpt = train(ws, iters, held_out={m["id"] for m in held})
    # In a fresh interpreter: after ingest has run in this one, VoxCPM's
    # jit-scripted decoder activation fails on MPS ("Unknown device for graph
    # fuser"); a clean process — like the voice server — does not.
    (ws / "held_out.json").write_text(json.dumps(held or meta[:3]))
    r = subprocess.run([sys.executable, __file__, "_choose", "--workspace", str(ws), "--ref", str(ref),
                        "--ref-text", ref_text] + (["--json"] if JSON else []),
                       stdout=None, stderr=subprocess.PIPE, text=True)
    if r.returncode != 0:
        raise BuildError("choosing a checkpoint failed:\n" + r.stderr.strip()[-1500:])
    pick = json.loads((ws / "choice.json").read_text())
    best, quality = ckpt / pick["checkpoint"], pick

    emit("profile")
    dst = profiles.expanduser() / name
    tmp = dst.with_name(dst.name + ".building")
    if tmp.exists():
        shutil.rmtree(tmp)
    (tmp / "lora").mkdir(parents=True)
    shutil.copy(best / "lora_weights.safetensors", tmp / voice_profile.LORA_WEIGHTS)
    shutil.copy(best / "lora_config.json", tmp / voice_profile.LORA_CONFIG)
    voice_profile.portable_lora_config(tmp / voice_profile.LORA_CONFIG, BASE)
    shutil.copy(ref, tmp / voice_profile.REFERENCE)
    prof = {
        "schema": voice_profile.SCHEMA, "name": name, "engine": "voxcpm2-lora", "base_model": BASE,
        "reference": {"wav": voice_profile.REFERENCE, "text": ref_text},
        "generation": {"mode": "fixed", "cfg_value": 2.0, "inference_timesteps": 10,
                       "max_retries": 3, "max_wer": 0.12},
        "pauses": measure_pauses(ws),
        "files": {k: None for k in voice_profile.REQUIRED if k != voice_profile.PROFILE},
        "provenance": {
            "created": time.strftime("%Y-%m-%d"),
            "training_data": f"{stats['clips']} clips / {stats['minutes']} min",
            "base": f"{BASE}, LoRA r=32, lr 1e-4, effective batch 16, {best.name}",
            "held_out_check": quality,
        },
    }
    voice_profile.save(tmp, prof, checksums=True)
    if dst.exists():
        shutil.rmtree(dst)
    tmp.rename(dst)
    z = voice_profile.export(dst, ws / f"{name}.voice.zip")
    res = {"profile": str(dst), "zip": str(z), "minutes": stats["minutes"], "clips": stats["clips"],
           "skipped": stats["skipped"], "quality": quality, "seconds": round(time.time() - t0)}
    emit("done", **res)
    return res


def cmd_eval(a):
    """Speaker similarity per quarter and pitch movement, clip by clip."""
    import librosa
    C = np.load(Path(a.voiceprint).expanduser())
    for p in a.clips:
        x = load16(p)
        s = embed(x) @ C
        f0, _, _ = librosa.pyin(x, fmin=60, fmax=300, sr=16000, frame_length=1024, hop_length=160)
        v = f0[~np.isnan(f0)]
        st = 12 * np.log2(v / np.median(v))
        q = [round(float(c.mean()), 3) for c in np.array_split(s, 4)] if len(s) >= 4 else []
        print(f"{Path(p).name:32s} {len(x) / 16000:6.1f}s similarity {s.mean():.3f} {q} "
              f"pitch SD {np.std(st):.2f} st")


def main():
    global JSON
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)
    p = sub.add_parser("build", help="recordings -> trained, checked, saved voice profile")
    p.add_argument("--workspace", required=True, help="folder with sources/ in it")
    p.add_argument("--name", required=True)
    p.add_argument("--profiles", default=str(HOME / "profiles"))
    p.add_argument("--iters", type=int, default=0)
    p.add_argument("--json", action="store_true", help="progress as JSON lines")
    p.add_argument("--resume", action="store_true", help="reuse a finished training run in the workspace")
    p = sub.add_parser("_choose", help=argparse.SUPPRESS)
    p.add_argument("--workspace", required=True)
    p.add_argument("--ref", required=True)
    p.add_argument("--ref-text", required=True)
    p.add_argument("--json", action="store_true")
    p = sub.add_parser("export", help="zip a profile folder as <name>.voice.zip")
    p.add_argument("folder")
    p.add_argument("--out")
    p = sub.add_parser("import", help="install a .voice.zip into the profiles folder")
    p.add_argument("zip")
    p.add_argument("--profiles", default=str(HOME / "profiles"))
    p.add_argument("--name")
    p.add_argument("--replace", action="store_true")
    p = sub.add_parser("eval", help="score clips against a voiceprint")
    p.add_argument("clips", nargs="+")
    p.add_argument("--voiceprint", default=str(HOME / "models" / "voiceprint.npy"))
    a = ap.parse_args()
    try:
        if a.cmd == "build":
            JSON = a.json
            build(Path(a.workspace), a.name, Path(a.profiles), a.iters or None, a.resume)
        elif a.cmd == "_choose":
            JSON = a.json
            ws = Path(a.workspace)
            _, q = choose_checkpoint(ws, ws / "train" / "ckpt", Path(a.ref), a.ref_text,
                                     json.loads((ws / "held_out.json").read_text()))
            (ws / "choice.json").write_text(json.dumps(q))
        elif a.cmd == "export":
            print(voice_profile.export(a.folder, a.out))
        elif a.cmd == "import":
            print(voice_profile.import_zip(a.zip, a.profiles, a.name, a.replace))
        else:
            cmd_eval(a)
    except (BuildError, voice_profile.ProfileError) as e:
        if JSON:
            emit("error", message=str(e))
        else:
            print(f"error: {e}", file=sys.stderr)
        sys.exit(2)


if __name__ == "__main__":
    main()
