#!/usr/bin/env python
"""Speak a script in your own voice, from a saved voice profile, on this machine.

The Video Compressor's in-browser voice (Pocket TTS, 100M parameters, cloned
from 6-15 s of the video itself) is the right default for a static page, and
it sounds robotic. This server is the other end of the trade: a 2B-parameter
model (VoxCPM2) with a LoRA trained on an hour of your own narration, running
on the Mac's GPU, answering the page over http://127.0.0.1.

    python voice_server.py                        # profiles in ~/voice-clone/profiles
    python voice_server.py --profiles DIR --profile mark --port 7865

Protocol (what `voice-ui.js` and Voice Studio speak):

    GET  /health                -> {"ok", "schema", "profile": {...} | null, "busy"}
                                   (profile = the active voice: the last one used on this machine)
    GET  /profiles              -> {"ok", "profiles": [{name, engine, schema, provenance, active}]}
    GET  /profiles/<name>/export  -> <name>.voice.zip (see voice_profile.py)
    POST /profiles/import[?name=&replace=1]   body: a .voice.zip
                                -> {"ok", "name", "profiles"} | 422 {"message"}
    POST /profiles/<name>/use   -> {"ok", "profile"}
    POST /speak    {"parts": [{"text", "pauseAfterS", "kind"}], "seed", "profile"?}
                   -> NDJSON stream: {"type":"progress","done","total"} lines,
                      then {"type":"audio","sampleRate","parts":[{start,end}],
                            "pcm": base64(float32 little-endian mono)}
                      or {"type":"error","message"}

Why sentence by sentence, when sentence-by-sentence is what made the browser
voice sound robotic: there, every sentence started from nothing. Here every
sentence is generated as a *continuation of a real clip of you talking* (the
profile's reference, also passed as the timbre anchor), so each one starts
mid-conversation, in your delivery, rather than from a cold start — and the
page still gets exact per-sentence spans to re-time the picture with.

Continuing from the *previous generated sentence* instead ("rolling") sounds
like the obvious way to carry prosody across joins, and was measured to be
wrong: over a 2.5-minute script speaker similarity fell 0.67 -> 0.45 by the
last quarter (0.65 -> 0.31 with the real clip prepended, "anchored"), because
any chain through generated audio drifts. "fixed" held 0.72-0.74 throughout —
the same as a held-out real recording of you (0.72). Both other modes are
kept, selectable in profile.json, for the next model to be measured against.

Every sentence is then *checked*: Whisper transcribes it, anything after the
last expected word is trimmed (the model's one bad habit is babbling on past
the end), and a sentence that is still missing words is regenerated with
another seed. The pauses between sentences are drawn from your own measured
pauses rather than one fixed length, because identical gaps are the other
thing that reads as a machine.

Only pages from the allowlisted origins can use it. A voice server that any
website could call would let any website speak in your voice.
"""
from __future__ import annotations

import argparse
import base64
import difflib
import json
import os
import re
import sys
import tempfile
import threading
import time
import traceback
import warnings
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import numpy as np
import soundfile as sf

import voice_profile

warnings.filterwarnings("ignore")
os.environ.setdefault("TQDM_DISABLE", "1")   # one progress bar per sentence floods the log

DEFAULT_HOME = Path(os.environ.get("VOICE_HOME", Path.home() / "voice-clone"))
DEFAULT_PROFILES = DEFAULT_HOME / "profiles"
DEFAULT_PORT = 7865
ALLOWED_ORIGINS = (
    re.compile(r"^https://hmaarrfk\.github\.io$"),
    re.compile(r"^http://(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$"),
)


# ---------------------------------------------------------------------------
# Text: what counts as "the model said the sentence"
# ---------------------------------------------------------------------------

_ONES = "zero one two three four five six seven eight nine".split()


def _spell_number(tok: str) -> str:
    try:
        from num2words import num2words
    except ImportError:  # pragma: no cover - optional
        return tok
    try:
        if re.fullmatch(r"\d+\.\d+", tok):
            whole, frac = tok.split(".")
            return num2words(int(whole)) + " point " + " ".join(_ONES[int(d)] for d in frac)
        return num2words(int(tok))
    except (ValueError, OverflowError):
        return tok


def words_of(text: str) -> list[str]:
    """Lower-case words with numbers spelled out, so "1%" and "one percent" agree."""
    t = text.lower().replace("%", " percent ").replace("&", " and ")
    t = re.sub(r"(\d),(\d)", r"\1\2", t)
    t = re.sub(r"\d+(?:\.\d+)?", lambda m: " " + _spell_number(m.group(0)) + " ", t)
    t = t.replace("-", " ")
    return re.sub(r"[^a-z0-9' ]", " ", t).split()


def speakable(text: str) -> str:
    """Rewrite what the model misreads into what a person would say.

    Measured: VoxCPM2 says "0.998" as "3.998", but says "zero point nine nine
    eight" correctly. Long decimals are read digit by digit anyway, so spell
    those out; short ones ("0.01%", "1.5") it reads fine and are left alone.
    """
    def dec(m):
        whole, frac = m.group(1), m.group(2)
        head = _spell_number(whole) if whole else "point"
        return (head + " point " if whole else "point ") + " ".join(_ONES[int(d)] for d in frac)
    return re.sub(r"(?<![\w.])(\d*)\.(\d{3,})(?!\w)(?!\.\d)", dec, text)


def wer(ref: list[str], hyp: list[str]) -> float:
    d = list(range(len(hyp) + 1))
    for i in range(1, len(ref) + 1):
        nd = [i] + [0] * len(hyp)
        for j in range(1, len(hyp) + 1):
            nd[j] = min(d[j] + 1, nd[j - 1] + 1, d[j - 1] + (ref[i - 1] != hyp[j - 1]))
        d = nd
    return d[-1] / max(1, len(ref))


# ---------------------------------------------------------------------------
# Audio helpers
# ---------------------------------------------------------------------------

def resample(x: np.ndarray, sr: int, to: int) -> np.ndarray:
    if sr == to:
        return x.astype(np.float32)
    import librosa
    return librosa.resample(x.astype(np.float32), orig_sr=sr, target_sr=to)


def trim_silence(x: np.ndarray, sr: int, lead_s=0.04, tail_s=0.10, floor_db=38.0):
    """Cut the model's own lead-in and tail down to a breath's worth.

    The pauses are laid in afterwards from the speaker's measured ones; leaving
    the model's silence in as well would put every gap on top of an unknown one.
    """
    hop = int(0.01 * sr)
    if len(x) < hop * 4:
        return x
    frames = np.sqrt(np.convolve(x.astype(np.float64) ** 2, np.ones(hop) / hop, "valid")[::hop] + 1e-12)
    db = 20 * np.log10(frames)
    loud = np.where(db > db.max() - floor_db)[0]
    if not len(loud):
        return x
    # A scrap of sound, then a real gap, then the sentence: that scrap is the
    # model finishing the reference clip's last word (heard as a "ding" before
    # every sentence when the clip ended mid-word). Drop it.
    gaps = np.where(np.diff(loud) > 20)[0]           # > 0.2 s of quiet
    if len(gaps) and (loud[gaps[0]] - loud[0]) < 35:  # scrap < 0.35 s
        loud = loud[gaps[0] + 1:]
    a = max(0, loud[0] * hop - int(lead_s * sr))
    b = min(len(x), (loud[-1] + 1) * hop + int(tail_s * sr))
    return x[a:b]


def fade(x: np.ndarray, sr: int, ms=8.0) -> np.ndarray:
    n = min(len(x) // 2, int(sr * ms / 1000))
    if n > 1:
        x = x.copy()
        x[:n] *= np.linspace(0, 1, n, dtype=np.float32)
        x[-n:] *= np.linspace(1, 0, n, dtype=np.float32)
    return x


# ---------------------------------------------------------------------------
# The voice
# ---------------------------------------------------------------------------

class Voice:
    """The base model, loaded once, speaking as whichever profile is selected.

    Profiles live in `profiles_dir/<name>/` (see voice_profile.py). Switching
    between two whose LoRAs have the same shape is a weight copy; a profile
    with a different LoRA shape reloads the model.
    """

    def __init__(self, profiles_dir: Path, default: str | None = None):
        self.profiles_dir = Path(profiles_dir).expanduser()
        self.lock = threading.Lock()
        self.busy = False
        self.model = None
        self._shape = None     # (base, lora_config) the model was built with
        self.name = None
        import mlx_whisper  # noqa: F401  (fail at startup, not mid-script)
        self.profiles_dir.mkdir(parents=True, exist_ok=True)
        names = self.list_names()
        if names:
            # Start with the voice asked for, else the one last used on this
            # machine, else the first by name.
            last = self.last_used()
            self.use(default if default in names else last if last in names else names[0])
        else:
            log(f"no voice profiles in {self.profiles_dir} yet; import a .voice.zip")

    def list_names(self) -> list[str]:
        if not self.profiles_dir.exists():
            return []
        return sorted(d.name for d in self.profiles_dir.iterdir()
                      if (d / voice_profile.PROFILE).is_file())

    def profiles(self) -> list[dict]:
        out = []
        for n in self.list_names():
            try:
                p = voice_profile.load(self.profiles_dir / n, verify=False)
                out.append({"name": n, "engine": p["engine"], "schema": p["schema"],
                            "provenance": p.get("provenance", {}), "active": n == self.name})
            except voice_profile.ProfileError as e:
                out.append({"name": n, "error": str(e), "active": False})
        return out

    # The last voice used on this machine, kept next to the profiles, so any
    # browser on this Mac finds it already selected.
    LAST = ".last-voice"

    def last_used(self) -> str | None:
        try:
            return (self.profiles_dir / self.LAST).read_text().strip() or None
        except OSError:
            return None

    def _remember(self, name: str):
        try:
            (self.profiles_dir / self.LAST).write_text(name + "\n")
        except OSError:
            pass

    def use(self, name: str):
        """Make `name` the speaking profile (caller holds the lock or is __init__)."""
        if name == self.name:
            return
        from huggingface_hub import snapshot_download
        from voxcpm.core import VoxCPM
        from voxcpm.model.voxcpm import LoRAConfig

        d = self.profiles_dir / name
        p = voice_profile.load(d, verify=True)
        lcfg = json.loads((d / voice_profile.LORA_CONFIG).read_text())["lora_config"]
        shape = (p["base_model"], json.dumps(lcfg, sort_keys=True))
        if self.model is None or shape != self._shape:
            base = snapshot_download(p["base_model"])
            log(f"loading {p['base_model']} (LoRA r={lcfg.get('r')})")
            self.model = VoxCPM.from_pretrained(
                hf_model_id=base, load_denoiser=False, optimize=False,
                lora_config=LoRAConfig(**lcfg), lora_weights_path=str(d / "lora"))
            self._shape = shape
        else:
            self.model.load_lora(str(d / "lora"))
        self.model.set_lora_enabled(True)
        self.sr = int(self.model.tts_model.sample_rate)
        self.dir, self.profile, self.name = d, p, name
        self.gen = p.get("generation", {})
        self.ref_wav = str(d / p["reference"]["wav"])
        self.ref_text = p["reference"]["text"]
        self._ref_cache = None
        self.asr_repo = p.get("asr_model", "mlx-community/whisper-large-v3-turbo")
        self._remember(name)
        log(f"speaking as {name!r} (schema {p['schema']}) at {self.sr} Hz")

    def describe(self) -> dict:
        p = self.profile
        return {
            "name": self.name, "engine": p.get("engine"), "schema": p.get("schema"), "sampleRate": self.sr,
            "mode": self.gen.get("mode", "fixed"), "provenance": p.get("provenance", {}),
        }

    # -- one sentence ------------------------------------------------------

    def _generate(self, text: str, seed: int, prompt: tuple[str, str] | None) -> np.ndarray:
        kw = dict(
            text=text, cfg_value=float(self.gen.get("cfg_value", 2.0)),
            inference_timesteps=int(self.gen.get("inference_timesteps", 10)),
            max_len=int(self.gen.get("max_len", 1500)), seed=seed,
            reference_wav_path=self.ref_wav,
        )
        if prompt:
            kw["prompt_wav_path"], kw["prompt_text"] = prompt
        return np.asarray(self.model.generate(**kw), dtype=np.float32)

    def _check(self, audio: np.ndarray, text: str):
        """Transcribe; trim anything said after the last expected word; score it."""
        import mlx_whisper
        a16 = resample(audio, self.sr, 16000)
        r = mlx_whisper.transcribe(a16, path_or_hf_repo=self.asr_repo, language="en",
                                   word_timestamps=True, condition_on_previous_text=False)
        # Whisper splits "0.998" into " 0" + ".998"; a token without a leading
        # space belongs to the one before it, or each half gets spelled apart.
        toks = []
        for seg in r.get("segments", []):
            for s in seg.get("words", []):
                if toks and not s["word"].startswith(" "):
                    toks[-1] = (toks[-1][0] + s["word"], toks[-1][1], s["end"])
                else:
                    toks.append((s["word"], s["start"], s["end"]))
        hyp = [(w, a, b) for t, a, b in toks for w in words_of(t)]
        ref = words_of(text)
        hw = [h[0] for h in hyp]
        if not hw:
            return audio, 1.0
        sm = difflib.SequenceMatcher(a=ref, b=hw, autojunk=False)
        last = None
        for blk in sm.get_matching_blocks():
            if blk.size:
                last = blk.b + blk.size - 1
        cut = audio
        first = next((blk.b for blk in sm.get_matching_blocks() if blk.size), 0)
        if 0 < first <= 2 and last is not None and hyp[first][1] - hyp[first - 1][2] > 0.15:
            # Words before the script's first word: the same reference-tail
            # scrap, when it was long enough for Whisper to call it a word.
            start_s = max(0.0, hyp[first][1] - 0.06)
            cut = audio[int(start_s * self.sr):]
            hyp = [(w, a - start_s, b - start_s) for w, a, b in hyp]
            hw = hw[first:]
            hyp = hyp[first:]
            last -= first
        if last is not None and last < len(hw) - 1:
            end_s = hyp[last][2] + 0.18
            nxt = hyp[last + 1][1]
            end_s = min(end_s, max(hyp[last][2] + 0.05, nxt - 0.02))
            cut = cut[: int(end_s * self.sr)]
            hw = hw[: last + 1]
        return cut, wer(ref, hw)

    def sentence(self, text: str, seed: int, prompt) -> tuple[np.ndarray, float, int]:
        tries = max(1, int(self.gen.get("max_retries", 3)))
        max_wer = float(self.gen.get("max_wer", 0.12))
        best = None
        for k in range(tries):
            s = seed + 7919 * k
            audio = self._generate(text, s, prompt)
            audio, e = self._check(audio, text)
            if best is None or e < best[1]:
                best = (audio, e, k)
            if e <= max_wer:
                break
            log(f"  retry {k + 1}: WER {e:.2f} for {text[:60]!r}")
        return best

    def _ref_audio(self) -> np.ndarray:
        if getattr(self, "_ref_cache", None) is None:
            x, sr = sf.read(self.ref_wav, dtype="float32")
            self._ref_cache = resample(x if x.ndim == 1 else x.mean(1), sr, self.sr)
        return self._ref_cache

    # -- a script ----------------------------------------------------------

    def pause_for(self, part: dict, rng: np.random.Generator) -> float:
        want = float(part.get("pauseAfterS") or 0)
        if want <= 0:
            return 0.0
        kind = part.get("kind")
        if not kind:
            kind = "clause" if re.search(r"[,;:][\"')\]”’]*$", part["text"].strip()) else "sentence"
        p = self.profile.get("pauses", {}).get(kind)
        if not p or not self.profile.get("natural_pauses", True):
            return want
        v = float(np.exp(np.log(p["median"]) + p.get("sigma", 0.4) * rng.standard_normal()))
        return float(np.clip(v, p.get("min", 0.05), p.get("max", 1.5)))

    def speak(self, parts: list[dict], seed: int, on_progress=None, cancelled=lambda: False):
        mode = self.gen.get("mode", "fixed")
        rng = np.random.default_rng(seed)
        pieces, spans = [], []
        at = 0
        prev = None  # (wav path, text) of the sentence just spoken
        tmpdir = tempfile.mkdtemp(prefix="voice-")
        t0 = time.time()
        try:
            for i, part in enumerate(parts):
                if cancelled():
                    raise InterruptedError
                text = str(part.get("text", "")).strip()
                if not text:
                    spans.append({"start": at / self.sr, "end": at / self.sr})
                    continue
                prompt = (self.ref_wav, self.ref_text) if (mode == "fixed" or prev is None) else prev
                text = speakable(text)
                audio, e, k = self.sentence(text, seed + 101 * i, prompt)
                audio = fade(trim_silence(audio, self.sr), self.sr)
                if mode == "rolling":
                    path = os.path.join(tmpdir, f"prev{i % 2}.wav")
                    sf.write(path, audio, self.sr)
                    prev = (path, text)
                elif mode == "anchored":
                    # The real clip, then the sentence just said: the model
                    # hears mostly the speaker, plus where the script is.
                    path = os.path.join(tmpdir, f"prev{i % 2}.wav")
                    gap = np.zeros(int(0.3 * self.sr), np.float32)
                    sf.write(path, np.concatenate([self._ref_audio(), gap, audio]), self.sr)
                    prev = (path, self.ref_text + " " + text)
                spans.append({"start": at / self.sr, "end": (at + len(audio)) / self.sr,
                              "wer": round(e, 3), "retries": k})
                pieces.append(audio)
                at += len(audio)
                # trim_silence already left ~0.14 s of lead-in and tail around
                # every sentence; the measured pause is the whole silence.
                pause = self.pause_for(part, rng) - 0.12 if i < len(parts) - 1 else 0
                pad = int(round(max(0.03, pause) * self.sr)) if i < len(parts) - 1 else 0
                if pad:
                    pieces.append(np.zeros(pad, np.float32))
                    at += pad
                if on_progress:
                    on_progress(i + 1, len(parts))
        finally:
            for f in Path(tmpdir).glob("*"):
                f.unlink()
            os.rmdir(tmpdir)
        pcm = np.concatenate(pieces) if pieces else np.zeros(0, np.float32)
        peak = float(np.max(np.abs(pcm))) if len(pcm) else 0
        if peak > 0.98:
            pcm *= 0.98 / peak
        log(f"spoke {len(parts)} parts, {len(pcm) / self.sr:.1f} s in {time.time() - t0:.1f} s")
        return pcm, spans


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

def log(msg: str):
    print(time.strftime("%H:%M:%S"), msg, file=sys.stderr, flush=True)


def origin_ok(origin: str | None) -> bool:
    if not origin:  # curl, scripts on this machine
        return True
    return any(p.match(origin) for p in ALLOWED_ORIGINS)


class Handler(BaseHTTPRequestHandler):
    voice: Voice = None
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        pass

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin and origin_ok(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Private-Network", "true")
            self.send_header("Access-Control-Max-Age", "600")

    def _json(self, code: int, obj: dict):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _refuse(self) -> bool:
        if origin_ok(self.headers.get("Origin")):
            return False
        self._json(403, {"ok": False, "message": "origin not allowed"})
        return True

    def do_OPTIONS(self):
        if self._refuse():
            return
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _body(self, limit: int) -> bytes:
        n = int(self.headers.get("Content-Length") or 0)
        if n > limit:
            raise ValueError(f"request too large ({n} bytes)")
        return self.rfile.read(n)

    def do_GET(self):
        if self._refuse():
            return
        url = urlparse(self.path)
        v = self.voice
        if url.path == "/health":
            return self._json(200, {"ok": True, "schema": voice_profile.SCHEMA,
                                    "profile": v.describe() if v.name else None, "busy": v.busy})
        if url.path == "/profiles":
            return self._json(200, {"ok": True, "profiles": v.profiles()})
        m = re.fullmatch(r"/profiles/([A-Za-z0-9._-]+)/export", url.path)
        if m:
            name = m.group(1)
            if name not in v.list_names():
                return self._json(404, {"ok": False, "message": f"no profile {name!r}"})
            try:
                with tempfile.TemporaryDirectory() as tmp:
                    z = voice_profile.export(v.profiles_dir / name, Path(tmp) / f"{name}.voice.zip")
                    data = z.read_bytes()
            except voice_profile.ProfileError as e:
                return self._json(422, {"ok": False, "message": str(e)})
            self.send_response(200)
            self._cors()
            self.send_header("Content-Type", "application/zip")
            self.send_header("Content-Disposition", f'attachment; filename="{name}.voice.zip"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        self._json(404, {"ok": False, "message": "not found"})

    def do_POST(self):
        if self._refuse():
            return
        url = urlparse(self.path)
        v = self.voice
        if url.path == "/profiles/import":
            # Body: the .voice.zip. ?name= renames it, ?replace=1 overwrites.
            from urllib.parse import parse_qs
            q = parse_qs(url.query)
            try:
                data = self._body(voice_profile.FILES[voice_profile.LORA_WEIGHTS] + (80 << 20))
                with v.lock:
                    dst = voice_profile.import_zip(data, v.profiles_dir, (q.get("name") or [None])[0],
                                                   replace=(q.get("replace") or ["0"])[0] == "1")
                    if v.name == dst.name:
                        v.name = None          # force a reload of the replaced profile
                        v.use(dst.name)
            except (voice_profile.ProfileError, ValueError) as e:
                return self._json(422, {"ok": False, "message": str(e)})
            log(f"imported profile {dst.name!r}")
            return self._json(200, {"ok": True, "name": dst.name, "profiles": v.profiles()})
        m = re.fullmatch(r"/profiles/([A-Za-z0-9._-]+)/use", url.path)
        if m:
            try:
                with v.lock:
                    v.use(m.group(1))
            except (voice_profile.ProfileError, FileNotFoundError) as e:
                return self._json(422, {"ok": False, "message": str(e)})
            return self._json(200, {"ok": True, "profile": v.describe()})
        if url.path != "/speak":
            return self._json(404, {"ok": False, "message": "not found"})
        try:
            req = json.loads(self._body(4 << 20) or b"{}")
            parts = req.get("parts") or ([{"text": req["text"]}] if req.get("text") else [])
            if not parts:
                return self._json(400, {"ok": False, "message": "nothing to say"})
            seed = int(req.get("seed", 1234)) & 0x7FFFFFFF
            want = req.get("profile")
            if want is not None and want not in v.list_names():
                return self._json(404, {"ok": False, "message": f"no profile {want!r}"})
            if want is None and v.name is None:
                return self._json(409, {"ok": False, "message": "no voice profile yet — import a .voice.zip"})
        except Exception as e:  # noqa: BLE001
            return self._json(400, {"ok": False, "message": f"bad request: {e}"})

        # Streamed, so the page can show progress and a closed tab stops the work.
        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "application/x-ndjson")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        gone = threading.Event()

        def send(obj):
            if gone.is_set():
                return
            try:
                self.wfile.write((json.dumps(obj) + "\n").encode())
                self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                gone.set()

        v = self.voice
        if not v.lock.acquire(timeout=0.1):
            send({"type": "status", "text": "Waiting for the previous script to finish…"})
            v.lock.acquire()
        v.busy = True
        try:
            if want and want != v.name:
                send({"type": "status", "text": f"Switching to {want}…"})
                v.use(want)
            log(f"speak: {len(parts)} parts as {v.name!r}")
            send({"type": "progress", "done": 0, "total": len(parts)})
            pcm, spans = v.speak(parts, seed,
                                 on_progress=lambda d, t: send({"type": "progress", "done": d, "total": t}),
                                 cancelled=gone.is_set)
            send({"type": "audio", "sampleRate": v.sr, "parts": spans,
                  "pcm": base64.b64encode(pcm.astype("<f4").tobytes()).decode()})
        except InterruptedError:
            log("cancelled by the page")
        except Exception as e:  # noqa: BLE001
            traceback.print_exc()
            send({"type": "error", "message": str(e)})
        finally:
            v.busy = False
            v.lock.release()


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--profiles", default=str(DEFAULT_PROFILES), help="folder of voice profiles")
    ap.add_argument("--profile", help="which one speaks first (default: the last used on this machine)")
    ap.add_argument("--port", type=int, default=DEFAULT_PORT)
    ap.add_argument("--say", help="speak this text to --out and exit (no server)")
    ap.add_argument("--out", default="say.wav")
    args = ap.parse_args()
    voice = Voice(Path(args.profiles), args.profile)
    if args.say:
        if voice.name is None:
            raise SystemExit(f"No voice profiles in {voice.profiles_dir}.")
        from voice_script import split_script  # local helper, mirrors voice.js
        parts = split_script(args.say)
        pcm, spans = voice.speak(parts, seed=1234)
        sf.write(args.out, pcm, voice.sr)
        print(json.dumps(spans, indent=1))
        return
    Handler.voice = voice
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    log(f"listening on http://127.0.0.1:{args.port}  (profiles in {voice.profiles_dir})")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
