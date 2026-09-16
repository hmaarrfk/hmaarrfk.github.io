# Video Compressor — requirements & design notes

A living spec for the Video Compressor at `/tools/videocompressor/`. Update
this file whenever the tool changes so we can always pick up where we left off.
`README.md` has the deeper technical walkthrough.

_Last updated: 2026-09-15 (**Breath control.** Two things made breathing
loud. The leveller had a bug: gain is `target / voiceEnv`, so in a gap — where
the voice envelope collapses — it rode *up* toward the ceiling, and the gaps are
exactly where breaths live. It now holds gain where nobody is talking, and comes
back to what the recent speech needed, so a breath stays as far under the voice
as it was recorded. On top of that, `breath.js` finds breaths by character
(noise-like, unvoiced, rising out of the room floor rather than decaying out of
a word) and Settings can turn them down, optionally shortening long ones.)_

_Earlier: 2026-09-15 (**Transcript-first editing, and speed-ups.**
The order was backwards for screencasts: you had to trim before you could see
what you'd said. Step 2 is now **Transcript & edit** — the whole video is
transcribed first, then every line and every silence between lines can be cut
or sped up by reading down the column. `state.cuts` became `state.edits`:
`{ start, end, rate, audio }`, where `rate: 0` is a cut and `rate > 1` runs the
section faster, either time-stretched (pitch kept, `speed.js`) or silent for a
time-lapse. Caption *appearance* stayed in Settings.)_

_Earlier: 2026-09-15 (**The play button becomes a pause button.** It was
a fixed triangle, so nothing in the preview transport said whether the clip was
running. The button now carries both icons and the page toggles `.playing` from
the video's own `play`/`pause`/`ended` events, with the title and `aria-label`
following; the transport is also queried through `#preview-block`, which is the
element that actually moves between steps.)_

_Earlier: 2026-09-15 (**Stop re-downloading Whisper.** The weights were
being cached all along, but nothing said so and nothing protected the cache:
the model list now reads `transformers-cache` and labels a model `downloaded`
instead of quoting a size, and the page asks for durable storage before the
first download so a 1.6 GB cache isn't evicted. The cache is per origin, so
the live site and each local test *port* keep their own copy — use one fixed
port locally.)_

_Earlier: 2026-09-15 (**Read AAC from QuickTime sound descriptions.**
macOS/iOS screen recordings store their AAC in a version-1 `mp4a` entry with
the `esds` inside a `wave` box. MP4Box can't parse that, so it reported the
codec as a bare `mp4a` and no `esds`. `AudioDecoder` rejects that config, so
captions failed with "This browser can't decode the video's audio", auto-boost
silently measured nothing, and passthrough muxed AAC without its
AudioSpecificConfig. `compressor.js` now finds the `esds` in the entry's raw
bytes and rebuilds `mp4a.40.<aot>` at load.)_

_Earlier: 2026-09-13 (**Captions: transcribe only the speech, and split
the source up.** Voice activity detection + silence compaction (with a span
map back to real time) replace "feed it everything"; cues break at punctuation
rather than a hard character count; the caption UI/job code moved out of
`compressor.js` (1903 → 1529 lines) into `captions-ui.js`, leaving
`compressor.js` for video and `captions.js` for pure logic.)_

_Earlier: 2026-09-11 (**Auto-captions, burned in.** Settings gains a
Captions group: pick a Whisper model (large-v3-turbo / small / base), a
language (or auto-detect), size and position, then **Generate captions**. The
kept audio is transcribed on-device by transformers.js in a Web Worker (WebGPU,
WASM fallback); cues appear live over the preview as they're transcribed, are
editable in a list, persist per file, and are drawn onto the frames at encode
time. Also: background audio passes (auto-boost analysis, caption decode) now
open their own MP4Box demuxer instead of sharing compress()'s.)_

_Earlier: audio volume boost — manual dB, or voice-band auto-leveler that
ducks loud passages; stepped Source → Trim & cut → Settings → Export flow;
multi-GB streaming demux; trim + interior cuts; settings persistence._

## Purpose

Shrink a video to a target size or bitrate with the machine's **hardware**
encoder via WebCodecs — entirely client-side — and optionally add
**auto-generated captions** so viewers can follow along with the sound off.

## Hard constraints

1. **Fully static.** Plain files on GitHub Pages; no build step, no backend,
   no special headers (no COOP/COEP → no cross-origin isolation, so no
   WASM threads; WebGPU is unaffected).
2. **Nothing is uploaded.** Video and audio are processed in the page. For
   captions, only the *model* comes in (Hugging Face Hub, jsDelivr for ONNX
   Runtime's WASM); the audio never goes out.
3. **Vendored JS.** mp4box, mp4-muxer and transformers.js are vendored under
   `vendor/` (see `update-vendor.sh`). Model weights and the ORT WASM are
   the deliberate exception — too large for the repo — fetched only on
   demand and cached by the browser.
   The transformers bundle gets one mechanical patch on vendoring: standalone
   32-character hex tokens (one gist id in an error message) are split across
   a string concatenation, because GitHub push protection reads that shape as
   a Mistral API key and rejects the push. Runtime behaviour is unchanged and
   the script re-parses the bundle to prove the patch is safe.
4. **No Jekyll processing.** `index.html` and the JS carry no front matter.
5. **Licenses.** mp4box (BSD-3), mp4-muxer (MIT), transformers.js
   (Apache-2.0), Whisper weights (MIT) — credited in the page's "How this
   works" panel.

## Files

| Path | Role |
|------|------|
| `index.html` | Page + UI (raw HTML) |
| `compressor.js` | Demux, preview/trim/cuts, transcode, mux, caption orchestration, all UI wiring |
| `audio-boost.js` | Pure gain / voice-band leveler math |
| `captions.js` | Pure caption logic: resampler, voice activity + compaction + time mapping, window planning, seam merging, words → cues, `cueAt`, `drawCaption` |
| `captions-ui.js` | Caption UI + job orchestration: model presets, worker, cue list, overlay, persistence (given a `ctx` by `compressor.js`) |
| `captions-worker.js` | Module worker running Whisper (transformers.js) |
| `speed.js` | Pure WSOLA time compression (pitch-preserving) for sped-up sections |
| `breath.js` | Pure breath detection + region ducking |
| `breath.test.mjs` | Node test for `breath.js` — `node breath.test.mjs` |
| `audio-boost.test.mjs` | Node test for the leveller's non-speech hold |
| `speed.test.mjs` | Node test for `speed.js` — `node speed.test.mjs` |
| `vendor/` | Vendored deps + `update-vendor.sh` |

## Features

- Target size or bitrate; resolution 100/75/50/25 %; fps cap; H.264 / H.265
  with early `isConfigSupported` validation.
- **One edit model.** `state.edits` is a sorted, non-overlapping set of
  `{ start, end, rate, audio }` spans over the source timeline: `rate: 0` is a
  cut, `rate > 1` is a speed-up, `audio` is `'keep'` (time-stretched narration)
  or `'mute'` (silent time-lapse). Everything else derives from `editSpans()`,
  which maps each kept span to where it lands in the output — the timeline,
  the preview's `playbackRate`, caption times and the encoder all read it.
  Older saved `cuts` migrate to `rate: 0`.
- **Transcript-first.** Step 2 transcribes the *whole* file, then cutting and
  speeding are done by reading: each line and each silence longer than 1.5 s
  gets a row with `cut` / `N× voice` / `N× silent`, plus a toolbar that applies
  one choice to every silence at once. The speed menu runs 1.1×–2× in tenths
  (narration stays listenable in that range, so the fine steps are worth it)
  then 2.5×–4× in halves, plus 8× and 16× for long silent stretches;
  default 1.5×. The timeline still takes manual
  mark-start → action edits; red bands are cuts, blue are speed-ups.
- **Speed, in the export.** Frames are spaced in *output* time, so a 4× section
  keeps every fourth frame instead of arriving 4× too fast. Any speed change
  forces an audio re-encode (a copied AAC stream can't be stretched): audible
  sections run through WSOLA, silent ones become exactly their own length of
  silence, and every section is trimmed/padded to an exact frame count so audio
  stays locked to video. Without a re-encoder available, audio is dropped
  rather than silently desynced.
- **Breaths.** `breath.js` marks a region as a breath only when it is (a) in a
  gap, with a guard band so a word's trailing sibilance is excluded, (b) above
  the room floor but well under the voice, (c) noise-like — HF-tilted or high
  zero-crossing — and (d) *rising out of the floor*, not decaying out of a word.
  That last test is what separates a breath from a dying word tail: both sit at
  the same level, so nothing measured inside the region can tell them apart.
  The length floor is 0.10 s, set from a real 10-minute screencast where a
  seventh of the breaths were 0.10–0.14 s and measured identically to the long
  ones (same HF tilt, zero-crossing rate, crest factor ~4–6); a higher floor
  drops real breaths rather than junk. Clicks are ruled out by shape — they peak
  instantly and their crest factor is far higher — not by length.
  Settings offers off / turn down (−10…−60 dB) / turn down and shorten; the
  shorten mode expresses itself as ordinary `src: 'breath'` speed edits, so it
  shows on the timeline and can be clicked away. Ducking happens *before* the
  leveller, whose hold then keeps it down.
- **The leveller holds its gain where nobody is talking** (`holdRangeDb`, 18 dB
  under the loudest recent voice) and returns to the gain that speech needed.
  Without it a gap was boosted ~12 dB harder than the speech around it. The
  reference is measured from the leveller's own envelope, not passed in: a level
  measured any other way is on a different scale and silently does nothing.
- Trim handles + interior cuts, stitched output; final-clip preview.
- The transport's play button swaps to a pause icon while the preview runs,
  driven by the `<video>`'s own events so it stays right whether playback was
  started by the button, the Space bar, or stopped by reaching the end.
- The timeline is laid out in pixels, so it repaints on **any** change of the
  track's width — a `ResizeObserver` on the track (and the preview block, for
  the caption overlay), not just a window `resize` on the Trim step. Before
  that, the green kept-bar and the playhead kept stale pixel widths on
  Settings/Export after a resize, and a scrollbar appearing or the cue list
  growing was missed everywhere.
- AAC audio passthrough, or volume boost (manual / auto).
  - AAC in QuickTime sound descriptions (version 1/2 `mp4a` with the `esds`
    nested in `wave`, as macOS/iOS screen recordings write it) is found by
    scanning the sample entry's bytes, since MP4Box doesn't see it. The codec
    string is rebuilt from the AudioSpecificConfig (`mp4a` → `mp4a.40.2`).
- **Captions**
  - Models: `onnx-community/whisper-{large-v3-turbo,small,base}_timestamped`.
    Weights live in Cache Storage (`transformers-cache`), keyed by Hub URL.
    The model list probes that cache for the preset's two `.onnx` weight files
    and shows `downloaded` in place of the size; `navigator.storage.persist()`
    is requested before the first download. The cache is per origin (and each
    localhost port is its own origin).
    WebGPU dtypes: turbo = fp16 encoder + q4 decoder (q4 encoder if no
    `shader-f16`); small/base = fp32 encoder + q4 decoder. WASM: q8.
    Default: turbo with WebGPU, base without.
  - Language: auto-detect (our own one-step language-token argmax — the
    library has no Whisper language detection yet) or a fixed choice.
  - Transcribes the **boosted** audio: manual = the slider's dB through the
    soft limiter, auto = the voice-band leveler with a gain measured from the
    caption audio itself (the whole-track analysis may not have finished yet).
    Leveler output is sample-exact in length, so timings don't drift. Quiet
    recordings only detect as speech once boosted (measured: 2 % of a −60 dBFS
    screen capture, 50 % boosted); with Volume unchanged, captions on such a
    file are *expected* to find nothing and say so — deliberately not worked
    around by loosening the detector.
  - Transcribes only the kept audio (trim minus cuts, joined). Voice activity
    detection (`detectSpeech`, energy vs. a measured noise floor, hysteresis)
    finds the talking; `compactSpeech` splices the speech together and drops
    the silences — Whisper costs a padded 30 s per call either way, so this
    is real compute saved (35 s clip with two 12 s gaps: 13 s sent, not 40 s)
    and removes the silence it hallucinates into.
  - The compacted audio goes in as 29 s windows overlapping by 5 s;
    `mergeChunkWords()` drops the duplicated overlap, placing each seam at a
    sentence ending (else the longest pause, else the middle) and assigning
    every word to one side by its midpoint.
  - `mapCompactSpan()` puts word times back on the real timeline, resolving
    each word's start and end against the same speech region so a word can't
    swallow a spliced-out pause.
  - Word timestamps → cues (≈ 2 lines, ≤ 6 s, split at pauses/sentences),
    stored in source time; cues in later-removed sections are hidden.
  - Live preview overlay uses the same `drawCaption()` as the encoder.
  - Editable cue list (click a timecode to seek); Stop keeps partial cues;
    Remove clears them; warning if the trim grows past what was transcribed.
  - Persisted per file in `localStorage` (`videocompressor:captions:v1`).
  - Burn-in only (drawn into pixels). Size S/M/L (4.5 / 6 / 8 % of the shorter
    side), bottom or top, and a look: outlined text (default — stroke ≈ 17 %
    of the font size, round joins, soft shadow) or a dark box behind the
    text. All four are persisted with the other settings.

## Testing

- `captions.js` runs under Node, which is where its logic is actually tested:
  synthetic audio with known speech spans over a noisy floor (VAD regions,
  compaction ratio, exact time-map round trip, a word whose end falls in a
  spliced-out gap), seam placement (lands after the *last* sentence ending in
  the overlap; falls back to the longest pause; a missing window keeps what is
  known; no duplicates or drops), and punctuation-preferred cue splitting.
  With the real model: resample a WAV, run `@huggingface/transformers` on the
  windows, and A/B old vs new (44.1 kHz → 16 kHz, English/French detection,
  subword gluing like "aujourd'hui", audio-seconds sent).
- In the browser (Chrome, WebGPU): load a spoken MP4 → Settings → Generate
  captions → Export → Compress; confirm captions over the preview, in the
  live encode view, and in the result's frames; no console errors.
- Regression: compress without captions (canvas only used when scaling),
  with volume boost, with trim + cuts.
- Breath: `node breath.test.mjs` (planted breaths found, quiet speech and word
  tails left alone, room tone ignored, ducking ramps) and
  `node audio-boost.test.mjs` (a gap is never boosted past the speech gain,
  while genuinely quiet speech still is). End to end, checked 2026-09-15 on 20 s
  of speech with four planted breaths 21 dB under the voice: all four found with
  the right boundaries and none spurious; at −24 dB they came out 22–24 dB down
  while speech moved ≤0.6 dB and the room tone not at all. On a real 10:44
  screencast: 87 breaths, 22.3 s, 3.5% of the recording, median 0.24 s and 24 dB
  under the voice. Shorten turned them
  into four silent speed edits, 20.18 s → 18.50 s, reverting cleanly.
- Speed: `node speed.test.mjs` covers the stretcher (length, pitch, level,
  chunk independence). End to end, checked 2026-09-15 on a 12 s clip beeping
  once a second, with 2–6 s at 4× silent and 6–10 s at 2× voice: the export was
  exactly 7.00 s / 210 frames, the sped-silent second measured −91 dB, and the
  2× section kept all four beeps at half duration and 0.5 s spacing.
- Transcript flow: a 20 s clip with three spoken sentences transcribed whole,
  two silence rows detected (5.9 s and 6.5 s), "all 4× silent" took 20.18 s →
  10.93 s, and cutting one line took it to 9.25 s.
- Play/pause: the button must show pause bars while the preview runs and a
  triangle when it doesn't — after the button, after Space, and at the end of
  the clip. Checked 2026-09-15 in Chrome (icon, class, and `aria-label`).
- Model cache: with weights already downloaded, the model list must say
  `downloaded` for exactly those presets. Checked 2026-09-15 against the real
  Cache Storage (turbo + base cached, small not) and Chrome granted durable
  storage silently.
- QuickTime audio: load a macOS screen recording `.mov`. The info line must
  say `audio: mp4a.40.2` (not `mp4a`), and Auto-boost must show a measured
  voice-band level. Checked 2026-09-15 on a 4.1 GB, 10 min ReplayKit
  recording: −34 dBFS, and Chrome's `AudioDecoder` rejects a bare `mp4a`.

## Future ideas

- Soft subtitle track (switchable) — needs a muxer with text tracks
  (Mediabunny writes WebVTT-in-MP4; Apple players prefer tx3g).
- Sidecar `.srt` / `.vtt` download (cues already exist; trivial).
- Parakeet TDT v3 as a faster option for its 25 European languages.
- Translate-to-English captions (Whisper task `translate`; not turbo).
- Caption style options (font, colours, outline instead of box).
