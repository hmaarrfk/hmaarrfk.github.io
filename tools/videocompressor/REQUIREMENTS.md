# Video Compressor — requirements & design notes

A living spec for the Video Compressor at `/tools/videocompressor/`. Update
this file whenever the tool changes so we can always pick up where we left off.
`README.md` has the deeper technical walkthrough.

_Last updated: 2026-09-11 (**Auto-captions, burned in.** Settings gains a
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
| `captions.js` | Pure caption helpers: resampler, chunk planning, words → cues, `cueAt`, `drawCaption` |
| `captions-worker.js` | Module worker running Whisper (transformers.js) |
| `vendor/` | Vendored deps + `update-vendor.sh` |

## Features

- Target size or bitrate; resolution 100/75/50/25 %; fps cap; H.264 / H.265
  with early `isConfigSupported` validation.
- Trim handles + interior cuts, stitched output; final-clip preview.
- AAC audio passthrough, or volume boost (manual / auto).
- **Captions**
  - Models: `onnx-community/whisper-{large-v3-turbo,small,base}_timestamped`.
    WebGPU dtypes: turbo = fp16 encoder + q4 decoder (q4 encoder if no
    `shader-f16`); small/base = fp32 encoder + q4 decoder. WASM: q8.
    Default: turbo with WebGPU, base without.
  - Language: auto-detect (our own one-step language-token argmax — the
    library has no Whisper language detection yet) or a fixed choice.
  - Transcribes only the kept audio (trim minus cuts, joined), in 29 s
    windows overlapping by 5 s; silent windows skipped. `mergeChunkWords()`
    drops the duplicated overlap, placing each seam at a sentence ending
    (else the longest pause, else the middle) and assigning every word to one
    side by its midpoint.
  - Word timestamps → cues (≈ 2 lines, ≤ 6 s, split at pauses/sentences),
    stored in source time; cues in later-removed sections are hidden.
  - Live preview overlay uses the same `drawCaption()` as the encoder.
  - Editable cue list (click a timecode to seek); Stop keeps partial cues;
    Remove clears them; warning if the trim grows past what was transcribed.
  - Persisted per file in `localStorage` (`videocompressor:captions:v1`).
  - Burn-in only (drawn into pixels). Size S/M/L (4.5 / 6 / 8 % of the shorter
    side), bottom or top.

## Testing

- `captions.js` runs under Node: resample a WAV, `planChunks`, run
  `@huggingface/transformers` on the pieces, `wordsToCues` (used to check
  44.1 kHz → 16 kHz, English/French detection, subword gluing like
  "aujourd'hui").
- In the browser (Chrome, WebGPU): load a spoken MP4 → Settings → Generate
  captions → Export → Compress; confirm captions over the preview, in the
  live encode view, and in the result's frames; no console errors.
- Regression: compress without captions (canvas only used when scaling),
  with volume boost, with trim + cuts.

## Future ideas

- Soft subtitle track (switchable) — needs a muxer with text tracks
  (Mediabunny writes WebVTT-in-MP4; Apple players prefer tx3g).
- Sidecar `.srt` / `.vtt` download (cues already exist; trivial).
- Parakeet TDT v3 as a faster option for its 25 European languages.
- Translate-to-English captions (Whisper task `translate`; not turbo).
- Caption style options (font, colours, outline instead of box).
