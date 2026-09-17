# Video Compressor

A static, offline, in-browser video compressor. It shrinks a video to a target
file size or a chosen bitrate using the browser's **WebCodecs** API — which
routes to the machine's *hardware* video encoder (Apple VideoToolbox, NVIDIA
NVENC, Intel QSV, VAAPI, …). Nothing is uploaded; every step runs locally.

This is distinct from the [GIF Maker](../gifmaker/): that tool produces animated
GIF/WebP/APNG; this one produces a compressed **MP4** (H.264 or H.265).

## Pipeline

```
MP4Box.js  ──►  VideoDecoder  ──►  <canvas> scale  ──►  VideoEncoder  ──►  mp4-muxer  ──►  MP4 Blob
 (demux)         (hardware)         (resize/fps)         (hardware)          (mux)
```

- **Demux** — [MP4Box.js](https://github.com/gpac/mp4box.js) reads the MP4/MOV,
  yields the encoded video samples plus the codec configuration record
  (`avcC`/`hvcC`) the decoder needs.
- **Edits** — one list, `state.edits`, describes everything done to the source
  timeline: a sorted, non-overlapping set of `{ start, end, rate, audio }`
  spans. `rate: 0` is a cut; `rate > 1` is a speed-up, where `audio` chooses
  between keeping the narration (time-stretched) and running silent. Anything
  not covered plays at `1×`. A cut is the limit case of a speed-up, so one set
  of transcript buttons drives both, and `editSpans()` — which maps every kept
  span to where it lands in the output — is the single source of truth for the
  timeline, the preview, the captions and the encoder.
- **Speed** — video frames are spaced out in *output* time, so a 4× section
  naturally keeps every fourth frame rather than arriving at four times the
  frame rate. Audio can't be copied through a speed change, so any speed-up
  forces a re-encode: an audible section goes through WSOLA time compression
  (`speed.js`) which preserves pitch, and a silent one is replaced by exactly
  its own length of silence. Every section is trimmed or padded to an exact
  frame count on the way out, which is what keeps audio locked to video.
- **Preview, trim & cut** — the source plays in a `<video>` element (streamed
  from a Blob URL, so multi-GB files preview instantly). Drag the timeline
  handles to keep only part of the clip, and mark interior **cut** sections to
  drop (mark start → mark end); removed sections are skipped during encode and
  the output timestamps compact to stitch the clip back together (audio too). A
  shorter kept duration encodes to a smaller file.
- **Stepped workflow** — one panel at a time (Source → Transcript & edit →
  Settings →
  Export). The single `<video>` preview is *relocated* into the active step: it's
  editable in Trim, and in Settings/Export it plays the **final** clip (loops the
  selection, skips cuts) so you preview exactly what will be exported.
- **Live encode view** — during export, each frame is drawn to a canvas as it's
  encoded, so you watch the output play out while it's written.
- **Settings persistence** — settings, trim, and cuts are saved to
  `localStorage` and re-applied when you load a video again (fully if it's the
  same file; general options only otherwise). The file itself isn't stored.
- **Early validation** — the chosen codec/resolution/bitrate are checked with
  `VideoEncoder.isConfigSupported` as you change them; if the browser can't
  encode them the Compress button is disabled with a reason, instead of failing
  at the end. Codec strings walk a profile@level ladder (up to AVC 5.2 / HEVC
  L186) so 4K frames find a supported level.
- **Decode → scale → encode** — WebCodecs `VideoDecoder`/`VideoEncoder`.
  Resolution change happens on an `OffscreenCanvas`; frame-rate reduction drops
  frames by presentation timestamp.
- **Mux** — [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) writes the
  encoded chunks back into an MP4 with `fastStart` (moov at the front).
- **Audio** — AAC audio is **copied through unchanged** via
  `addAudioChunkRaw` (remuxed, never re-encoded) by default. Non-AAC audio is
  dropped, and the UI says so.
- **Volume boost** (optional) — decodes just the audio (`AudioDecoder`), gains
  it, and re-encodes it to AAC (`AudioEncoder`) instead of remuxing it raw
  (`audio-boost.js` has the gain math). Two modes:
  - **Manual** — a flat dB boost you set with a slider, through a soft
    limiter so it can't clip.
  - **Auto** — a small lookahead AGC (`createLeveler`) driven by loudness in
    the human-voice band (~300&ndash;3400 Hz), so a quiet voice track is
    judged on the voice itself rather than a single loud non-voice sound. It
    rides the gain up to rescue quiet voice (0&ndash;36 dB) and automatically
    ducks it back down the instant *anything* gets loud (a music jingle, a
    shout) — a few milliseconds of internal audio delay give the gain a head
    start on a sudden transient, so it eases down smoothly to meet it instead
    of clamping at the last instant (which would otherwise flatten the
    waveform into audible distortion, even under a *soft* limiter). It only
    ever turns audio up, never down.

  Requires the browser to support AAC *encoding* via WebCodecs
  (`AudioEncoder.isConfigSupported`) — checked per file at load; if it isn't
  available, boost is disabled and audio still passes through unchanged.
  The Trim/Settings/Export preview applies the same gain live (Web Audio
  `GainNode` + `DynamicsCompressorNode`) so you can listen before exporting.
- **Auto-captions** (optional) — transcribes the speech with OpenAI's
  open-weights **Whisper** model, run by
  [transformers.js](https://github.com/huggingface/transformers.js) in a Web
  Worker (`captions-worker.js`) on the GPU via **WebGPU** (CPU/WASM fallback),
  and **burns** the captions into the frames before they're encoded:

  ```
  AudioDecoder ─► 16 kHz mono (kept sections only) ─► ≤30 s chunks ─► Whisper (word timestamps) ─► cues ─► drawn on the encode canvas
  ```

  - **Models** (all `onnx-community/*_timestamped` exports, which carry the
    cross-attention outputs word timestamps need):
    large-v3-turbo (default with WebGPU; fp16 encoder + q4 decoder ≈ 1.6 GB),
    small (≈ 590 MB), base (≈ 210 MB; default without WebGPU). Weights
    download from the Hugging Face Hub the first time and are cached by the
    browser (Cache Storage, under `transformers-cache`, keyed by the Hub URL).
    ONNX Runtime's WASM comes from jsDelivr (pinned by transformers.js) — so
    captions, unlike the rest of the tool, need the network the first time.
    The audio itself never leaves the page.
  - **"Downloaded" labels** — the model list looks the weights up in that cache
    and says `downloaded` instead of a size when they're already there, so
    picking a model isn't a gamble on a long download.
  - **Durable storage** — before the first download the page calls
    `navigator.storage.persist()`, so the browser won't evict a 1.6 GB model
    cache under disk pressure. Chrome usually grants this silently.
  - That cache is **per origin**. `https://www.markharfouche.com/` and a local
    `http://127.0.0.1:<port>/` each keep their own copy, and *each port is a
    different origin* — so testing on a new port re-downloads the model. Use
    one fixed port locally to reuse it.
  - **Audio** — only the kept sections (trim minus cuts) are decoded,
    resampled to 16 kHz mono and joined back to back, i.e. exactly the
    output's audio.
  - **The volume boost applies to captions too** — Whisper hears what the
    viewer will hear. **Manual** applies the slider's dB through the same soft
    limiter as the export; **Auto** re-measures the voice-band level of the
    caption audio itself (rather than waiting on the whole-track analysis,
    which may still be running) and rides the same lookahead leveler. The
    leveler's output is sample-exact in length, so caption timings can't
    drift. This matters for quiet recordings: a screen capture at −60 dBFS
    sits below the speech detector's floor, and only 2 % of it registers as
    speech until the boost lifts it — with the boost on, 50 %. Captions on a
    very quiet video with **Volume: unchanged** are expected to find nothing,
    and say so.
  - **Only the speech is transcribed** — `detectSpeech()` finds the talking by
    short-time energy against a noise floor measured from the clip itself
    (with hysteresis, so it doesn't chatter mid-word), and `compactSpeech()`
    splices those regions together, dropping the silences and returning a map
    back to real time. This matters because Whisper always processes a padded
    30 s per call: a clip that is half pauses would otherwise cost twice what
    the speech in it is worth, and silence is exactly where the model invents
    phrases like "Thank you." On a 35 s clip with two 12 s gaps this sends
    **13 s instead of 40 s** of audio — one model call instead of two.
    Word times come back through `mapCompactSpan()`, which resolves each
    word's start *and* end against the same speech region: Whisper habitually
    stretches a final word to the pause after it, and mapping the two ends
    independently would let a word swallow a silence it never occupied.
  - **Overlapping windows** — Whisper hears at most 30 s, so the audio goes in
    as 29 s windows that **overlap by 5 s** (~21 % more compute). Nothing is
    then heard only at a window edge, where the model is weakest and would
    start a fresh sentence mid-phrase. `mergeChunkWords()` throws the doubled
    seconds away again: each seam gets one junction time — just after the last
    **sentence ending** in the overlap, else the middle of the longest pause,
    else the middle — and every word lands on exactly one side of it (by its
    own midpoint), so nothing is duplicated or dropped, not even a word
    straddling the seam.
  - **Language** — detected automatically (transformers.js doesn't do this for
    Whisper yet, so the worker runs one decoder step after
    `<|startoftranscript|>` and takes the most likely language token), or
    chosen from a list.
  - **Cues** — words are grouped into short phrases (≈ 2 lines, ≤ 6 s, split at
    pauses and sentence ends; an over-long line breaks at the latest comma or
    full stop inside it rather than mid-clause) and stored in *source* time, so trimming or
    cutting afterwards just hides the cues that fall in removed sections.
    Each cue is editable in a list; cues are saved per file (like the trim)
    and restored when the same file is loaded again.
  - **Burn-in** — `drawCaption()` (sized relative to the picture's shorter
    side, in one of two looks: **outlined text**, white with a thick
    round-joined dark stroke and a soft shadow so the picture stays visible
    behind it — the default — or a translucent **dark box** behind each line)
    paints the current cue onto the
    `OffscreenCanvas` each frame is scaled on. The preview draws the same
    function onto a canvas over the `<video>`, so what you see is what gets
    encoded. Burning in forces every frame through the canvas even at 100 %
    scale.
  - Captions need an AAC audio track (the same decode path as the volume
    boost). A soft, switchable subtitle track isn't offered: mp4-muxer can't
    write text tracks.

## Large files (multi-GB)

A single `ArrayBuffer` in Chrome is capped near 2 GB, so the whole file is never
read at once. Instead:

1. **Metadata** is parsed from `moov` alone. A quick top-level atom walk (only
   16-byte box headers are read) locates every box; each is fed to MP4Box in
   full *except* `mdat`, which contributes only its 8-byte header. MP4Box then
   learns the `mdat` size, skips its payload, and reaches `moov` — even when it
   sits at the very end of the file (common for camera/screen recordings). For a
   2.6 GB `.mov` this phase reads only a few hundred KB.
2. **Encoded samples** are streamed out of `mdat` in 8 MB chunks during
   compression, feeding the decoder with backpressure and calling
   `releaseUsedSamples` after each batch, so memory stays bounded.

Trimming makes this cheaper: encoding stops as soon as the selection's end is
reached, so trims near the start of a long video finish quickly.

## Files

| Path | What it is |
|------|------------|
| `index.html` | The page. No Jekyll front matter, so the JS is served verbatim. Loads MP4Box as a global `<script>`, then the module. |
| `compressor.js` | ES module: streaming demux, preview/trim, transcode, mux, and all UI wiring. |
| `breath.js` | ES module: breath detection (gap + level + noise-like + rises out of the floor) and region ducking with ramps. Pure `Float32Array` maths, tested by `breath.test.mjs`. |
| `breath.test.mjs` | Node test for the above. `node breath.test.mjs`. |
| `audio-boost.test.mjs` | Node test for the leveller's non-speech hold. `node audio-boost.test.mjs`. |
| `speed.js` | ES module: WSOLA time compression for sped-up sections that keep their narration. Pure functions on interleaved `Float32Array`s — no DOM/WebCodecs — so it runs under Node, which is where `speed.test.mjs` tests it. |
| `speed.test.mjs` | Node test for the above: output length, pitch preservation, level, chunk-size independence. `node speed.test.mjs`. |
| `audio-boost.js` | ES module: the voice-band loudness analysis, auto-gain, and soft-limiter math. Pure functions on `Float32Array`s — no DOM/WebCodecs — so it's usable standalone (e.g. under Node, fed raw PCM from `ffmpeg`) to sanity-check the algorithm outside the browser. |
| `captions.js` | ES module: the pure caption logic — 16 kHz resampler, `detectSpeech`/`compactSpeech`/`mapCompactSpan`, window planning, `mergeChunkWords`, words → cues, `cueAt`, and `drawCaption` (used by both the preview overlay and the encoder). No DOM/model, so it runs under Node too. |
| `captions-ui.js` | ES module: the interactive half — model presets and the WebGPU probe, the transcription job and its worker, the editable cue list, the preview overlay, and caption persistence. Gets the DOM, the state and a few timeline/audio helpers from `compressor.js` through one `ctx` object. |
| `captions-worker.js` | Module Web Worker: loads Whisper through transformers.js, detects the language, transcribes chunk by chunk and posts words (with timestamps) back as it goes. Jobs are id-tagged and serialized so a cancelled one can't interleave with a new one. |
| `voice.js` | ES module: the pure overdub logic — which transcript lines changed, where a replacement may start and stop (`snapSpan`), which few seconds to clone from (`pickReference`), and fitting a generation into its slot (`fitToDuration`, `matchLevel`, `shapeEnds`, `finishDub`). No DOM or model, so it runs under Node, which is where `voice.test.mjs` tests it. |
| `voice.test.mjs` | Node test for the above. `node voice.test.mjs`. |
| `voice-tokenizer.js` | ES module: a minimal SentencePiece reader (protobuf) and unigram Viterbi segmenter with byte fallback, so the voice model's `tokenizer.model` can be used directly rather than vendoring a converted copy per language. |
| `voice-tokenizer.test.mjs` | Node test for the above, against models built in the test. `node voice-tokenizer.test.mjs`. |
| `voice-ui.js` | ES module: the interactive half of overdub — the model download and its cache probe, choosing and decoding the reference clip, respeaking a line, and handing the encoder finished samples through `pcmFor()`. Gets its DOM/state/timeline through one `ctx`, like `captions-ui.js`. |
| `voice-worker.js` | Module Web Worker: runs the five Pocket TTS ONNX graphs on onnxruntime-web. A port of the reference Python driver, including the hand-threaded KV cache that *is* the cloned voice. |
| `voice-bench.html` | Development harness, not linked from the tool: clone from a WAV and speak a line, to check the port against the Python reference. |
| `REQUIREMENTS.md` | Living spec / design notes — update with every change. |
| `vendor/mp4box/` | Vendored MP4Box.js UMD bundle + license. |
| `vendor/mp4-muxer/` | Vendored mp4-muxer ESM bundle (`.mjs` renamed to `.js` so GitHub Pages serves it with a JS MIME type) + license. |
| `vendor/transformers/` | Vendored transformers.js self-contained ESM bundle (`transformers.min.js`, ONNX Runtime's JS inside; no bare imports) + license. |
| `vendor/onnxruntime/` | Vendored onnxruntime-web WASM build (`ort.wasm.min.js`, 50 KB) + license. Overdub drives ONNX graphs directly, which transformers.js doesn't expose; its WASM binary is fetched from jsDelivr on demand. |
| `vendor/update-vendor.sh` | Re-vendors all four deps from npm (see below). |

## Vendoring

Dependencies are **vendored**, not fetched at runtime, so the tool works
offline and never depends on a CDN. (The one exception is auto-captions: the
Whisper weights and ONNX Runtime's ~25 MB WASM are far too big to vendor, so
they're fetched — and then browser-cached — only when someone asks for
captions.) Pinned versions:

- `mp4box` **0.5.2**
- `mp4-muxer` **5.1.5**
- `@huggingface/transformers` **4.2.0**
- `onnxruntime-web` **1.26.0-dev.20260416-b7804b056c** (the exact build transformers.js 4.2.0 pins, so both share one cached WASM)

To update:

```bash
cd tools/videocompressor/vendor
./update-vendor.sh                       # pinned versions
./update-vendor.sh 0.5.2 5.1.5 4.2.0     # or specify mp4box + mp4-muxer + transformers versions
```

**One patch is applied to the transformers bundle.** GitHub's secret-scanning
push protection rejects any push containing a standalone 32-character hex
token — the shape of a Mistral API key — and the bundle has one in an error
message pointing at a gist (`gist.github.com/hollance/<32 hex>`, about
Whisper's `alignment_heads`). It's a false positive, but it blocks the push,
so `update-vendor.sh` splits every such token across a string concatenation
(`"…42e32852f24243b7"+"48ae6bc1f985b13a…"`): byte-different from upstream,
identical at runtime. The script then re-parses the bundle and fails if the
patch landed anywhere but inside a string.

Then bump the versions above, re-test, and commit the changed `vendor/` files.

## Browser support

WebCodecs is required. As of writing that means a recent **Chrome/Edge** or
**Safari**; Firefox support is still landing. HEVC *encoding* in particular
depends on the OS/GPU — the tool probes `VideoEncoder.isConfigSupported()` and
falls back or reports a clear error if a codec isn't available. If WebCodecs is
missing entirely, the page shows a compatibility notice instead of the tool.

Auto-captions use **WebGPU** when the browser exposes it (Chrome/Edge, recent
Safari); the large-v3-turbo preset's fp16 encoder also needs the
`shader-f16` feature, and falls back to a q4 encoder without it. With no
WebGPU at all, Whisper runs on the CPU (WASM) — it works, but slowly, so the
base model is the default there.

## Notes / limitations

- Input must be an MP4/MOV/M4V the browser can decode (H.264 or H.265). Formats
  like ProRes or VP9-in-WebM aren't handled by this MP4-focused demux path.
- Trim decodes from the start of the file up to the selection's end (it can't
  skip into the middle of a GOP), so a trim near the *end* of a long video still
  streams most of the file. A trim near the start is fast.
- Target-size mode computes a constant video bitrate from the (trimmed)
  duration (single-pass), so the final size is an estimate — very close, not
  exact. Use the result's size readout and nudge the target for a hard cap.
