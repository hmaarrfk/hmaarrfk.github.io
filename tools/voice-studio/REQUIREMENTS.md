# Voice Studio — requirements and state

_Last updated: 2026-09-24. **One command: a folder in, a `.voice.zip` out**
(`server/make_voice.py`, `server/setup.sh`); in-browser training was built,
measured and dropped — see "Rejected: training in the browser"._

_Earlier: 2026-09-23 (later). **Versioned `.voice.zip`, several voices per server, one-command `build`.** See "Profile format" below._

_Earlier: 2026-09-23. First version: a fine-tuned personal voice, served
locally to the Video Compressor, plus a page to record more training material._

## Purpose

Mark narrates technical screencasts, then rewrites the script and respeaks it
with the Video Compressor. The in-browser respoken voice was "close, but
robotic". The goal: a voice that sounds like him talking naturally, built once
with real effort (hours of recording is acceptable), saved as a profile, and
reused whenever he respeaks.

## Constraints

- **Local only.** Recordings, datasets, checkpoints and profiles live in
  `~/voice-clone/` (override with `$VOICE_HOME`), never in git and never
  uploaded. The server binds 127.0.0.1 and answers only
  `https://hmaarrfk.github.io` and `http://localhost|127.0.0.1:*` origins,
  because a voice server any website could call would let any website speak in
  his voice. It returns 403 to any other origin, checked server-side and not
  just through CORS.
- **Apple Silicon, no CUDA.** M5 Max, 128 GB. Training and inference run on
  PyTorch MPS; ASR runs on MLX.
- **Commercially usable weights.** The screencasts are for a company, so the
  base model must allow commercial use. VoxCPM2 is Apache-2.0. Rejected on
  licence: Fish Audio S2 Pro, Breeze TTS 2, F5-TTS, XTTS-v2, Voxtral and
  Higgs v3, all non-commercial.
- **Drop-in for the Video Compressor.** The page's voice worker protocol was
  kept: `speak(parts) -> {pcm, sampleRate, parts: [{start, end}]}` with
  exact per-sentence spans, because the page re-times the picture from them.

## Why the old voice sounded robotic (measured)

Measured on `~/videos/auto_contrast_adjustment.mp4` against his own recordings:

| | Real speaker | Pocket TTS respoken |
|---|---|---|
| Speaker similarity (ECAPA, vs a voiceprint from his other recordings) | 0.72 (held-out file) | **0.40** |
| Pitch movement (F0 SD) | 2.97 st | 2.73 st |
| Median pause ≥ 120 ms | 0.19 s | **0.46 s** |
| Pause after a full stop (Whisper gaps, 12 files) | median 0.28 s, IQR 0.14–0.54 | fixed 0.36 s plus the model's tail |

The main problems were timbre (a 100M-parameter model cloning from about 10 s
of audio) and long, identical pauses. Pitch flatness was a smaller factor.

## Research summary

The full notes are in the session transcript. The conclusions:

- **Open models, zero-shot, on the same paragraph and reference:**
  - Qwen3-TTS-1.7B: 0.62 similarity.
  - VoxCPM2: 0.62 similarity, but the most expressive (3.12 st) with natural pauses.
  - Chatterbox Turbo: 0.66 similarity, but flat (2.36 st) with long pauses.
  - All three beat Pocket TTS. Zero-shot copies timbre, not delivery.
- **Fine-tuning Qwen3-TTS-1.7B** with the official script failed on MPS twice:
  1. First it produced gibberish. The official `sft_12hz.py` is missing the
     `text_projection` (upstream issue #39).
  2. After fixing that, at the community-recommended lr 2e-6 plus 0.8 s of
     trailing padding, it lost EOS and ran on for minutes. Community reports
     say it is fragile and often flatter than zero-shot. Abandoned.
- **Fine-tuning VoxCPM2 with a LoRA** (the official trainer runs on MPS as is)
  worked first time:
  - r=32, lr 1e-4, effective batch 16, 200 steps on 298 clips, about 21 minutes.
  - Steps 50, 100 and 150 scored alike. Step 150 had no word errors across 3
    seeds.
- **Data:** 52 minutes of his *natural* screencast narration, taken from 12
  Desktop recordings. Downloads were excluded, because they can contain other
  speakers and previously respoken audio.
  - The speaker check rejected every Downloads file that was not him
    (similarity 0.05–0.27).
  - `auto_contrast_adjustment_original.mov` is held out for evaluation.
  - Research consistently says natural or semi-spontaneous speech beats read
    prompts for conversational TTS. Hence the Studio's prompt mix: 60%
    explain, 30% say it your way, 10% tricky words.

## How a script is spoken (server)

- **One sentence per generation, each continuing a real clip of him** ("fixed"
  mode). The reference is passed both as the continuation prompt and as the
  timbre anchor.
  - Each sentence therefore starts mid-conversation in his delivery, and spans
    are exact.
  - **Measured alternatives, both rejected:**
    - Continuing from the previous *generated* sentence ("rolling") drifted,
      0.67 → 0.45 similarity over 2.5 minutes.
    - Real clip plus previous sentence ("anchored") drifted too, 0.65 → 0.31.
    - Any chain through generated audio drifts. Both modes stay selectable in
      `profile.json` for future models.
- **Every sentence is verified.**
  - MLX Whisper transcribes it. Tokens are glued before normalizing, since
    Whisper splits "0.998" into " 0" and ".998".
  - Anything before the first word or after the last word is trimmed.
  - If more than 12% of words are wrong, the sentence is regenerated with a
    new seed, up to 3 tries, keeping the best.
  - The model's failure mode is babbling past the end. It was seen in 2 of 9
    long single generations; per-sentence checking removes it.
- **Reference clip hygiene.**
  - The first reference ended mid-word ("distracting" with about 150 ms to the
    next word). Every sentence then began by finishing it, which Whisper heard
    as "ding", 31 times in 31 sentences.
  - The reference now ends at a pause and is padded with 0.3 s of its own
    quiet.
  - `trim_silence` also drops any scrap shorter than 0.35 s that comes before
    a gap of more than 0.2 s.
- **Text.** Decimals with 3 or more digits are spelled out. VoxCPM2 read "0.998"
  as "3.998", but reads "zero point nine nine eight" correctly. Short ones
  ("0.01%") it reads fine.
- **Pauses** are drawn per kind (sentence, clause, paragraph) from a
  log-normal fitted to his measured gaps. The 0.12 s of lead-in and tail that
  `trim_silence` keeps is subtracted, so the total silence matches. Identical
  gaps read as a machine.
- **Output** is 48 kHz mono float32, sent base64 in the final line of an
  NDJSON stream, preceded by `progress` lines. A closed tab (broken pipe)
  cancels the job.

## Results

Full 31-sentence script, fixed mode, final settings: `bench/full_fixed3.wav`.

| | Real (held-out) | New voice | Pocket TTS |
|---|---|---|---|
| Similarity | 0.72 | **0.73** (0.73 / 0.73 / 0.74 / 0.73 by quarter) | 0.40 |
| F0 SD / range | 2.97 / 9.4 st | **2.99 / 9.4 st** | 2.73 / 8.8 st |
| Words per second | 2.6–2.8 | **2.79** | 2.96 |
| WER vs script | — | **0.2%**, no retries needed | — |
| Speed on M5 Max | — | 163 s of audio in 134 s, Whisper checks included | — |

## Video Compressor integration

- The **Voice** select has two options: "Cloned from this recording" (default)
  and "My voice profile".
- `voice-local.js` is a Worker-shaped `EventTarget`, so `ask()` is unchanged.
  - `load` → `GET /health`
  - `clone` → no-op (the profile is the voice)
  - `speak` → streamed `POST /speak`
  - `cancel` → abort
- `fetch` carries `targetAddressSpace: 'loopback'` for Chrome's Local Network
  Access prompt. The server answers PNA preflights.
- The reference clip is still read from the video, for level and tone
  matching.
- Each part now carries a `kind` (sentence, clause, paragraph or end), derived
  from its punctuation pause.

## Testing

- `build_voice.py eval <wav…>`: similarity by quarter plus pitch SD.
- `voice_server.py --say "<text>" --out x.wav`: the whole pipeline, no browser.
- **End to end, 2026-09-23, in Chromium.**
  - Setup: a local static server that renders the page's Liquid. Loaded
    `Screen Recording 2026-09-22 at 9.17.16 PM.mov` (4096×2648, 3:21), ran
    in-page Whisper captions, pasted the rewritten script and chose "My voice
    profile".
  - Respeak result: "Respoke the script in 3:04, 31 sentences, 31 aligned,
    21 sections re-timed 0.72×–1.43×".
  - Export (Medium): 2048×1324 H.264 + AAC 48 kHz.
  - Its narration scored 0.74 similarity, steady by quarter.
- CORS check: `Origin: https://evil.example` → 403; `http://localhost:4010` →
  204 with `Access-Control-Allow-Private-Network: true`.

## Profile format (`voice_profile.py`, schema 1)

- **A folder on disk, a zip on the wire.** The zip holds
  `profile.json`, `reference.wav`, `lora/lora_config.json` and
  `lora/lora_weights.safetensors`, stored uncompressed (weights and WAV barely
  compress). It is about 74 MB.
- **Versioning.** `"schema": N` in `profile.json`.
  - Older schemas migrate forward one step at a time (`MIGRATIONS`).
  - A newer schema is refused with "update tools/voice-studio".
  - Schema 0 is the hand-written first profile. Schema 1 dropped `lora`
    (a folder) and added `files` (a manifest with SHA-256).
- **Adding a field:** bump `SCHEMA`, add `_migrate_<n>_to_<n+1>`, extend
  `validate`, and add a test.
- **Checks on import.** Import treats every zip as untrusted.
  - Only the four known names are read, and no archive path is ever joined
    onto the destination.
  - One top-level folder is tolerated as a prefix.
  - Sizes are capped per file.
  - Every checksum must match. A zip without checksums, meaning it was never
    exported, is refused.
  - `lora_config.base_model` must be a Hub id, because training writes an
    absolute local path and `export` rewrites it.
  - Nothing is installed unless all of this passes. A name clash needs
    `replace`.
- **Server.**
  - Every profile in `~/voice-clone/profiles/` is listed and can be spoken
    as.
  - `/speak` takes an optional `profile`.
  - Switching between profiles with the same LoRA shape is a weight copy:
    measured instant, with no reload of the 2B model.
  - The server starts with no profiles, so a new user can import one.
- **Video Compressor.** With *My voice profile* chosen, a **Voice profile**
  select lists the server's profiles, and **Load a .voice.zip…** imports one.
  A name clash asks before replacing. The choice is persisted.
- **Verified 2026-09-23.**
  - `test_voice_profile.py`: 13 tests covering migration, a newer schema,
    local-path base models, bad pauses, the round trip, rename and replace,
    tampered weights, an unexported zip, path traversal, a single top folder,
    a missing file, and not-a-zip.
  - Over HTTP: export 200 (74 MB); import under a new name; duplicate → 422;
    foreign origin → 403; truncated zip → 422 "not a zip file"; `/speak` with
    `profile` switched voices and spoke.
  - In Chromium: *Load a .voice.zip…* → confirm replace → "Installed “mark”".

## One-command build (`build_voice.py build`)

Recordings in `<workspace>/sources/` go in; `profiles/<name>/` and
`<name>.voice.zip` come out. Progress is printed as JSON lines (`--json`), for
a page to drive later.

1. **Convert.** ffmpeg to 48 kHz mono.
2. **Voiceprint.** Take the mean of all speech windows, then 3 times keep
   only the windows above 0.45 cosine and re-average. This converges on the
   dominant speaker without being told who that is. ECAPA runs on MPS: about
   1.8 s per file instead of about 17 s on CPU, same scores.
3. **Skip.** Files whose median similarity is below 0.5 (other people, or
   respoken audio) are left out. Clips below 0.45 are dropped.
4. **Transcribe and cut** as before. Fewer than 3 minutes of usable speech is
   refused; fewer than 20 minutes gets a warning.
5. **Reference.** The highest-similarity 12–19 s clip ending in `.?!`, padded
   with 0.3 s of its own quiet. It is held out of training.
6. **Train.** Steps = ⌈clips/16·8/50⌉·50, clamped to 100–600. That is about 8
   passes, which is where the first profile was best (step 150 of 200 on 298
   clips). Three short clips are also held out.
7. **Choose.** Speak the held-out lines with the last three checkpoints.
   Score = similarity − WER, keep the best, and record it in `provenance`.
8. **Pauses.** Measured from the speaker's own Whisper word gaps: log-normal
   median and σ, with 10th and 90th percentiles as min and max. The paragraph
   pause is derived from the sentence one.

### Verified end to end (2026-09-23)

`build --workspace voices/mark-auto` over the 14 Desktop recordings that
have audio:

- **Data:** 4 were skipped as not-the-voice (similarity 0.00–0.14: a few
  seconds of silence or someone else). 283 clips / 49.1 min were kept.
- **Training:** 150 steps; steps 100 and 150 were checked. Step 100 was kept
  (similarity 0.84 against the workspace voiceprint, WER 0).
- **Timing:** ingest about 30 s once transcripts are cached; training about
  15 min; choosing about 90 s.
- **Two bugs found and fixed on the way:**
  - VoxCPM's jit-scripted `snake` failed with "Unknown device for graph
    fuser" when generated in the same process that ran ingest. It now runs in
    a fresh interpreter (`_choose`), and `--resume` reuses a finished
    training run.
  - ECAPA on MPS needs float32 input.

The full 31-sentence script spoken by each voice, scored against two
voiceprints:

| | vs the held-out video | vs the Desktop recordings |
|---|---|---|
| Auto-built (reference from a Desktop recording) | 0.68 | 0.81 |
| Hand-built (reference from the held-out video) | 0.80 | 0.73 |
| A real Desktop recording of him (9.17 PM) | 0.64 | 0.59 |
| Pocket TTS | 0.45 | 0.40 |

- **Each clone is closer to its own reference's session than two of his real
  sessions are to each other.** ECAPA similarity here mostly tracks the
  microphone and room. The two builds are equivalent, and both are far above
  Pocket TTS.
- **To sound like a particular setup, take the reference from it.** A future
  `--reference` option to `build` would do that.
- **The auto build speaks slower** (2.37 words/s against a real 2.6–2.8). Its
  pause model is measured from all of his gaps, hesitations included: sentence
  median 0.35 s, 90th percentile 1.14 s, paragraph 1.03 s. Capping the
  measured max, or fitting only gaps under about 0.8 s, is the obvious next
  tweak.

## In-browser training: research (2026-09-23)

The user wants step 1 ("create your voice clone") to run in the browser too.

- **Verdict: possible, but nobody ships it yet.** The only credible path is
  **jax-js** (JAX-style `grad`/`jit` on WebGPU, active, v0.1.25).
  - Its demo site already has a differentiable **Pocket TTS** forward pass in
    jax-js.
  - Measured training throughput in Chrome 153 on the M5 Max: 4–4.8 TFLOP/s
    fp32. WebGPU allows 4 GiB per buffer.
- **Other frameworks are ruled out:**
  - onnxruntime-web removed training in 2024, and it was CPU-only anyway.
  - TF.js WebGPU is effectively abandoned.
  - transformers.js and WebLLM are inference-only.
  - tinygrad, Candle and MLX have no browser training.
  - Burn is plausible but has no example.
- **Options, cheapest first:**
  1. **Choose or average references.** Best-of-N reference choice for
     Pocket; for Chatterbox-Turbo ONNX, average the voice-encoder row and the
     x-vector. Their `speech_encoder.onnx` exposes both. The gain is small and
     unverified.
  2. **Tune Pocket's voice prefix in jax-js**, with the model frozen. About
     1–3 weeks of work. Analogous papers (Lina-Speech state tuning,
     VoiceTTA) gained about +0.07 similarity.
  3. **LoRA on Pocket's 6-layer flow LM in jax-js.** About 3–6 weeks of
     work. Training is estimated at 5–30 min on an M5 Max and 1–5 h on base
     Macs. It is the only browser path that could plausibly approach the
     fine-tuned 0.73, but the gain is unmeasured.
- **Next step:** prove the gain in Python first. LoRA-fine-tune Pocket TTS
  with Kyutai's training code on the same 52 minutes and score it with the
  same harness, before porting anything to jax-js.
- **Correction:** Baseten's "0.85" was clip-embedding agreement with their
  centroid, not an output-similarity gain.

## One command (`make_voice.py`)

`python make_voice.py <folder> --name <you>` → `./<you>.voice.zip`.

- The folder is searched recursively for anything ffmpeg reads
  (`build_voice.MEDIA`); hidden files and folders are ignored. Files are
  *linked* into `~/voice-clone/voices/<name>/sources/` under stable, unique
  names (relative path + a 6-hex hash), so a re-run reuses cached transcripts
  and a file removed from the folder leaves the build.
- Skipped, and listed at the end with the reason: files with no audio track
  (screen recordings without a microphone — common on a Desktop), under 2 s,
  or not the dominant voice. The first version stopped the whole build at the
  first silent video; found by running it on ~/Desktop.
- `setup.sh`: conda env `voxcpm` (Python 3.11, ffmpeg), VoxCPM cloned and
  pinned to the commit this was measured with, `requirements.txt`, and a check
  that MPS is available. Idempotent (re-run on an existing env: no changes).
- Console progress: one line per file, every 25 training steps.

## Rejected: training in the browser (built, measured, removed 2026-09-24)

The request was for step 1 to run in people's browsers. It was built end to
end — Voice Studio transcribed (Whisper, transformers.js), cut clips, encoded
them (Mimi, onnxruntime-web in a worker) and fine-tuned **Pocket TTS**
english_2026-04 (89 M) with LoRA + a learned voice prompt using **jax-js on
WebGPU**; the Video Compressor spoke the result on its onnxruntime-web worker
with the adapters merged into the fp32 ONNX graphs in place. It worked, and
it was removed because the voice is clearly worse than the Mac one. Code:
commits 1ad9bb0 and 1c23acb on the PR branch (reverted by 25cadf1); the
Python baseline lives in `~/voice-clone/pocket_ft`.

What was learned, for next time:

- **Feasibility.** Only jax-js trains on WebGPU in 2026 (onnxruntime-web
  removed training in 2024; TF.js WebGPU is abandoned). The jax-js port of
  Kyutai's training step matched PyTorch (loss 1.2e-7, gradients ≤ 1.5e-5).
  A shape-static version (index arrays over bucketed buffers; one-hot matmuls,
  since jax-js cannot jit a scatter) ran under jit at **0.99 s/step** (eager
  2.26 s; PyTorch MPS 0.19 s): 300 steps in 5 min on an M5 Max.
- **Weights.** Kyutai's ungated release zeroes the Mimi encoder and omits the
  speaker projection; KevinAHM's CC-BY ONNX export has both, and its
  transformer is bit-identical. Adapters can be merged into those ONNX graphs
  by overwriting initializer bytes (rel. err 5.7e-7 vs PyTorch).
- **Whole pipeline** (47 min of speech, 11 recordings): 15.7 min in the tab
  (Whisper 210 s, encode 465 s, train 258 s); respeaking a 3-min script 69 s.
- **Quality**, full script, similarity vs Desktop / held-out video:

  | | similarity | WER |
  |---|---|---|
  | old Pocket clone | 0.40 / 0.45 | 0.2 % |
  | Pocket zero-shot, 5 s reference | 0.53 / 0.46 | 0 % |
  | Pocket fine-tuned (Python, or browser on clean data) | 0.61–0.65 / 0.50–0.55 | 1.3–2.8 % |
  | whole in-browser pipeline | 0.62 / 0.54 | 9.5 % |
  | **VoxCPM2 + LoRA (this tool)** | **0.72 / 0.80** | **0.6 %** |

  Pocket plateaued at ~0.62–0.65 across rank, flow-head LoRA, reference
  length, learning rate and steps. The in-browser data prep (no speaker
  check, no ASR confidence, rougher timestamps) cost ~7 points of WER.
- **VoxCPM2 in a browser** would be a jax-js port of a 2 B model: est. 1.5–2 h
  of training on an M5 Max and ~20 GB+ of GPU memory — only for large Macs.
  Speaking it might work via an existing ONNX export
  (ai4all8/VoxCPM2-ONNX, untested; 1–4 GB).
- **Scoring pitfall.** Long-form Whisper with `condition_on_previous_text`
  hallucinated loops and made voices look like they babbled (13–26 % WER);
  score with it off.

## Future ideas

- Record 1–2 more hours in the Studio, mostly "explain it", and retrain.
  Diminishing returns are expected past 2–3 hours.
- Try several reference clips per profile, one per energy level, and choose
  per paragraph.
- Blind A/B with colleagues who know the voice. The metrics say "as close as
  the metric can tell", which is not the same as indistinguishable.
- If a browser-only version is ever needed: Chatterbox-Turbo has an official
  ONNX/WebGPU build. A LoRA-merged re-export is unverified.
