# Video Compressor — requirements & design notes

A living spec for the Video Compressor at `/tools/videocompressor/`. Update
this file whenever the tool changes so we can always pick up where we left off.
`README.md` has the deeper technical walkthrough.

_Last updated: 2026-09-17 (**Two overdub bugs, from the first person to
use it.** (1) *You could hear yourself start the line the clone then said* —
"I— I'm here today to…". `snapSpan` moved each edge of a replaced span to the
*middle* of the neighbouring pause, but only if the middle was within 0.25 s;
a line after a real pause is the common case, and there the middle is seconds
away, so the edge stayed exactly on Whisper's word timestamp. That timestamp is
an alignment, not a measurement, and it lands late on an onset — so the attack
of the old word survived in the recording, immediately before the replacement.
Each edge now *reaches into* the pause by half of it, capped at 0.25 s, which
is always inside it. The borrowed silence stays silence: `fitToDuration` takes
a `leadSamples` and puts the generation in after it (room tone under it, faded
in), so the respoken line still starts on its own timestamp instead of a
quarter-second early, and `planFit` adds the borrowed pause to the dead-air
allowance so the picture isn't sped up to trim padding the tool added itself.
(2) *The downloaded file had no audio at all.* Respeaking needs an audio
re-encode, and the export only ever tried AAC — which Chrome cannot encode on
Linux at all (`AudioEncoder.isConfigSupported('mp4a.40.2')` is false there).
The whole audio track was then dropped, with a note about "a speed change" the
user never made. The export now falls back to **Opus in MP4**, which Chrome can
always encode and every browser that lacks AAC encoding can play, and says so
in the summary and the result line; audio is only dropped if the browser can
encode neither, and the note then names what actually needed it. The
background audio analysis also no longer hides behind AAC-encode support — it
is where overdub's room tone and voice level come from, so on Linux Chrome
every respoken line was being laid over silence instead of the room.)_

_Earlier: 2026-09-16 (**Overdub: respeak a line in your own voice.**
Edit a transcript line and a **respeak** button appears on it; the words are
spoken back in your voice and dropped into the gap the old line left. The voice
is cloned zero-shot from the clearest 6-15 s of the recording itself
(`pickReference` over Whisper's word timings), so there is no sample to record
and the clone arrives with the same microphone and room already on it. The
model is Kyutai Pocket TTS as ONNX (five graphs, 146 MB int8), driven directly
on a vendored onnxruntime-web — `voice-worker.js` is a port of the reference
Python driver, KV cache and all, because the cloned voice *is* a primed KV
cache. A respoken span is an ordinary `state.edits` entry carrying a `dub` id,
so the timeline, the export and the frame-exact span padding already understood
it. WASM, not WebGPU: measured, WebGPU is ~2x slower here because the int8 ops
fall back to CPU and every autoregressive step pays a round trip.)_

_Earlier: 2026-09-15 (**Breath control, part two.** The volume boost no
longer follows you from the last recording — it starts **off** every time, since
it re-encodes the audio and lifts whatever sits in the gaps. Whisper's *word*
timings are now kept alongside the cues (a cue spans a whole phrase including
its pauses, so cues mark ~95% of a recording as "speech" and are useless as a
mask; words mark 84%). They power a new **turn down everything between phrases**
mode, which is provably safe — zero overlap with any word — where level-based
detection alone could not be. They are deliberately *not* used to mask ordinary
breath detection: Whisper's word spans are padded and run together, so masking
by them dropped 91 detected breaths to 34 on a real screencast.)_

_Earlier: 2026-09-15 (**Breath control.** Two things made breathing
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
4. **No Liquid anywhere near the JavaScript.** The `.js` files carry no front
   matter, so Jekyll copies them verbatim. `index.html` holds no inline script
   and *does* carry front matter (`layout: null`), purely so every asset URL in
   it can be stamped with `?v=<short commit hash>` — see "Versioning" below.
5. **Licenses.** mp4box (BSD-3), mp4-muxer (MIT), transformers.js
   (Apache-2.0), Whisper weights (MIT) — credited in the page's "How this
   works" panel.

## Versioning (cache busting)

Site-wide mechanism, documented in the repository root `README.md`: each build
stamps `?v=<short commit hash>` onto every stylesheet and script, and the page
footer shows that hash plus the build time. Because this page's JavaScript is a
graph of ES modules, the `?v=` on `compressor.js` alone would not reach
`voice.js`, `captions.js` and friends — a relative import resolves without the
importer's query string. The page emits an import map that points each of this
tool's own modules at its versioned URL instead. Import maps do not apply to
`new Worker`, so `captions-ui.js` and `voice-ui.js` copy their own `?v=` onto
the worker URL, and `voice-worker.js` imports `voice-tokenizer.js` dynamically
with `self.location.search` appended. Vendored libraries (MP4Box, mp4-muxer,
transformers.js, ONNX Runtime) are pinned copies and are left unversioned.

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
| `voice.js` | Pure overdub logic: `changedLines`, `snapSpan`, `pickReference`, `fitToDuration`, `matchLevel`, `shapeEnds`, `finishDub`, `suggestMode`, `naturalRate` |
| `voice.test.mjs` | Node test for `voice.js` — `node voice.test.mjs` |
| `voice-tokenizer.js` | SentencePiece protobuf reader + unigram Viterbi with byte fallback |
| `voice-tokenizer.test.mjs` | Node test for the above — `node voice-tokenizer.test.mjs` |
| `voice-ui.js` | Overdub UI + job orchestration: model cache, reference clip, respeak, `pcmFor()` for the encoder (given a `ctx` by `compressor.js`) |
| `voice-worker.js` | Module worker running Pocket TTS on onnxruntime-web |
| `voice-bench.html` | Dev-only harness for the Python/JS parity check (not linked) |
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

- **Overdub (respeak a line).**
  - **The whole script can be respoken at once**, which is both a feature in
    its own right — rewrite the transcript, hear the narration delivered again
    — and the best answer to blending there is. Every splice is a join between
    generated speech and a recording, and those never match perfectly; respeak
    everything and no such join remains anywhere. Each line still dubs into its
    own span at its own timestamp, under the same dead-air rules, so the
    picture is untouched and the timing holds.
  - **Every line can be respoken**, not only edited ones. A cue keeps `orig`
    (what Whisper said) beside `text` (what you typed), and `restore text`
    appears when they differ — but the respeak button is always there, because
    disliking how you said a line is as good a reason as changing the words,
    and the transcript can be perfectly correct while the delivery is not.
  - **You can hear it before exporting.** Every line and every silence has a
    play button that seeks to it and plays just that line, as it will be in
    the export (sped up if it's in a fast section, respoken if respoken); a
    second button appears once a line has a dub, to play the original for
    comparison. Through the preview, the `<video>` is muted inside a dubbed
    span and the finished samples play in its place, through the same gain and
    limiter nodes, so the preview keeps telling the truth. A `Preview plays`
    setting switches the whole timeline between respoken and original.
  - **The reference clip comes out of the recording.** `pickReference` walks
    the word timings for runs with no pause longer than 0.45 s and scores the
    best 6-15 s window by *speech density* — the fraction actually covered by
    words. Density is what matters because the model reproduces the recording,
    not just the voice: a window full of room tone teaches it room tone. Ties
    break toward the middle of the file. "Use a different reference clip"
    cycles the next-best non-overlapping candidates.
  - **The seam goes in the pause, not on the word.** `snapSpan` moves each
    edge of the replaced span *into* the neighbouring gap — by half of it, so
    two respoken lines either side of one pause meet rather than overlap, and
    never by more than 0.25 s, and not at all if the gap is under 40 ms (a
    20 ms stop closure is a consonant, not a pause). A few ms of fade over room
    tone is inaudible; the same fade across a word is not. It has to *reach*,
    not just aim for the middle: the edge starts from a Whisper word timestamp,
    which is an alignment rather than a measurement and lands late on an onset,
    so an edge left where the timestamp says leaves the attack of the old word
    in the recording — and you hear yourself start the line the clone is about
    to say. The silence it borrows at each end is reported as `lead`/`tail` and
    stays silent: the generation goes in *after* the lead (`leadSamples`), so
    the line keeps its own timestamp, and `planFit` counts the borrowed pause
    as allowance rather than dead air to trim.
  - **The picture moves before the speech does.** A respoken line that runs
    long used to be squeezed by WSOLA first and only then given time; that was
    backwards. A few percent of picture is invisible, where squeezing speech is
    audible the moment it does real work — so `planFit` spends the picture's
    budget first (`Video may stretch`, default 50%, applied as the span's rate)
    and squeezes only what the picture could not absorb, up to 1.38x, then
    reports the shortfall. At the default a line 5% long costs 4.8% of picture
    and no audio processing at all. A dub is still never *stretched* to fill a
    slot: slowing a short line down to fill it makes it drawl.
  - **Three places the time can go, and only three.** A line respoken shorter
    frees time that must become pause, a faster picture, or a cut — there is no
    fourth option, and no setting can conjure one. `Video may stretch` and
    `Dead air threshold` are the two ends of that trade, and the stretch limit
    is the one that holds: asking for zero pause cannot force a lurch, it just
    leaves the pause the limit could not remove, and says so.
  - **Dead air is the user's call, not a built-in number.** `Trim dead air`
    and a `Dead air threshold` in seconds (default 0.15) decide what happens
    when a respoken line is shorter than the one it replaced. The threshold is
    a *tolerance*, not a trigger: `planFit` keeps at most that much pause and
    trims the rest by running the section at `srcS / (dubS + deadAirS)`,
    bounded to 2x. Off, the whole pause stays. This went through two wrong
    defaults first — never moving the picture (which left a second of dead air
    in the middle of a screencast) and then a hard-coded 0.6 s (still too long
    for the person using it) — which is the argument for it being a setting
    rather than a better guess. Changing either control calls `replanAll()`,
    which re-times every line already respoken without regenerating anything,
    so the setting is something you turn and hear. When even the bounded rate
    leaves real pause (cutting nearly all of a long line), the status says how
    much and points at Cut, which is the honest answer there.
  - **A dub is an ordinary edit.** `{ start, end, rate, audio: 'keep', dub }`,
    where `dub` is an id into `state.dubs`. `applyEdit` stores a rate-1 edit
    when — and only when — it carries a dub; `mergeEdits` never merges two,
    since each owns its own audio. At export, `openSpan` asks
    `voice.pcmFor(id, …)` for exactly `curTarget` frames and emits them, and
    `feedSpan` drops the decoded source for those seconds. The gain stage and
    the leveller are deliberately skipped: the level was matched to the
    neighbouring speech at generation time and re-levelling would undo it.
    Any dub forces the audio re-encode, like a speed change does.
  - **The level is matched to the recording, and then boosted with it.** The
    generation comes back at whatever level the model chose, which is not
    yours. `matchVoiceLevel` measures it with `analyzeVoiceLevel` — the
    300-3400 Hz band *while somebody is talking* — and moves it to the track's
    own `voiceDbfs` (the number auto-boost already works from), falling back to
    the reference clip's level. Plain whole-buffer RMS is the wrong yardstick
    and audibly so: it calls a line with a pause in it quiet and shoves it up,
    so the amount of silence in a sentence would decide the volume of the
    voice. Capped at ±18 dB — more than that is a bad generation, not a level
    problem. The dub then goes through the export's **gain stage like
    everything else**; skipping it (on the theory that the level was already
    matched) meant that with a boost on, every other second was lifted and the
    respoken line was not, which is exactly how it was first reported.
  - **The splice is built the way dialogue is replaced, not by fading.** Three
    things, all standard practice and all missing from the first version, which
    is why it "just didn't blend":
    1. **Room tone under the whole line.** `findRoomTone` takes the longest
       quiet stretch of the recording during the load-time analysis pass (the
       track is decoded exactly once, so it is free there) and `layRoomTone`
       mixes it under the generation. The background then never stops at a
       splice — the ear notices *that* far sooner than it notices a voice being
       slightly off — and it carries everything above the 12 kHz a 24 kHz model
       cannot produce at all, which is what made a bare dub sound like a hole
       punched in the track. A recording that never pauses yields no tone
       rather than a bad one: with no real gap the percentile floor lands
       inside the speech, and taking it would lay the speaker's own voice under
       every line.
    2. **Equal-power crossfades into the recording at both edges**, using the
       original audio for the span — which the export has decoded anyway and
       used to throw away. Fading in from silence and out to silence leaves a
       dip at each boundary; crossfading means the background runs straight
       through. Equal power rather than linear because the two sides are
       uncorrelated noise and sum in power. The span edges were already snapped
       into pauses, so what is being crossfaded is room tone into room tone.
    3. **Tonal matching** (`matchTone`, three bands, ±6 dB) against the
       recording of the line being replaced — the ideal reference, being the
       same speaker, microphone, room and words. Applied before the level
       match, since moving the balance moves the energy.
  - **The pause is room tone, and must not loop.** A short line leaves a pause,
    filled from the *generation's own* quiet stretches — the clone carries the
    room, so its pauses are the right pauses. Tiling one 120 ms window is not
    enough: a 1.5 s pad is that fragment a dozen times and the ear hears the
    period as a breath or hum that was never recorded (reported in use). Up to
    8 non-overlapping quiet windows are taken, shuffled deterministically, and
    equal-power crossfaded; each tile is randomly reversed and jittered ±1.5 dB
    so that even a line with only *one* usable pause doesn't repeat. Digital
    silence is the fallback when a line has no quiet stretch at all — filling
    it with looping speech would be far worse.
  - **The samples are not persisted.** localStorage keeps only the intent
    (text, span, mode, seed) — a minute of narration is several MB of floats
    against a ~5 MB budget shared with the captions, and a seeded generation
    can be made again exactly. `regenerateAll()` rebuilds on demand.
  - **The model.** `KevinAHM/pocket-tts-onnx` (CC-BY-4.0 weights, MIT export
    code), `english_2026-04` plus French/German/Italian/Portuguese/Spanish,
    int8: `mimi_encoder` 21 MB, `text_conditioner` 16 MB, `flow_lm_main`
    76 MB, `flow_lm_flow` 10 MB, `mimi_decoder` 23 MB = 146 MB, in the same
    `transformers-cache` the Whisper weights use. 24 kHz mono out.
    `kyutai/pocket-tts` itself is **gated** and cannot be fetched from a page.
  - **Cloning is one forward pass.** The reference audio goes through
    `mimi_encoder` to embeddings, the model's `bos_before_voice` is prepended,
    and one `flow_lm_main` pass over them leaves a primed KV cache. That cache
    *is* the voice — 18 tensors, threaded in and out of every subsequent step
    by hand, per `bundle.json`'s manifest. The caches must be **NaN**-filled,
    not zero-filled: NaN is how the graph marks a slot as empty.
  - **WASM, single-threaded, on purpose.** GitHub Pages can't send COOP/COEP,
    so there is no SharedArrayBuffer and no WASM threads; `numThreads` is
    pinned to 1 to skip the warning. WebGPU was measured at roughly *half*
    the speed, because the int8 ops fall back to CPU and each autoregressive
    step pays a GPU round trip. onnxruntime-web is vendored separately from
    transformers.js (which bundles ORT but exposes no session API), pinned to
    the same build so both share one cached WASM binary.
  - **Consent.** The weights' terms forbid cloning a voice without lawful
    consent; the panel says so, and the feature is framed as respeaking your
    own narration.

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
  - **Anything that changes the samples needs an audio encoder**, and AAC
    encoding is a platform feature a browser may simply not have — Chrome on
    Linux has no AAC encoder at all. `pickAudioEncoder()` probes AAC first and
    falls back to **Opus**, which is valid in MP4 and which Chrome can always
    encode; the export summary and the result line say when that happened,
    because Opus in MP4 plays in Chrome, Edge and Firefox but not QuickTime.
    Copied (not re-encoded) audio is always the source's own AAC. Audio is
    dropped only if neither codec can be encoded, and the note then names the
    edit that needed one. Before this, a respoken line on Linux Chrome
    exported a video with **no audio track at all**.
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
- Overdub: `node voice.test.mjs` (what changed, seam snapping, reference
  choice, fitting/padding/clamping, level matching, the whole finish, and the
  asymmetric short/long policy) and `node voice-tokenizer.test.mjs` (protobuf
  field skipping, Viterbi picking the best split, byte fallback, round trip).
  - **Tokenizer, against the real model.** The synthetic test can't prove the
    4000-piece model is read correctly, so that is checked by hand: tokenise a
    corpus with Python's `sentencepiece` and compare ids one for one. Checked
    2026-09-16 on 83 cases — real transcript lines, accents, CJK, emoji, Greek,
    Cyrillic, tabs, zero-width spaces, 60 random printable-ASCII strings —
    **83/83 exact**, and every case round-tripped through `decode`.
  - **The model port, against Python.** With `temperature: 0` the model is
    deterministic, so `voice-bench.html` and `generate.py` must agree. Checked
    2026-09-16 on a 10 s reference from a real screencast: both produced
    **25 frames / 48000 samples**, and the **first latent frame correlates at
    0.9996** (max deviation 1.4%). The waveforms then diverge (envelope
    correlation 0.85) — expected, and not a port bug: int8 GEMM differs
    slightly between the native CPU kernels and WASM SIMD, and an
    autoregressive loop compounds it. The first frame is the one that proves
    the wiring, since nothing has fed back into it yet.
  - **Seeding.** Same text + same seed must give bit-identical audio on one
    machine (it is what makes a regenerated line reproducible). Checked
    2026-09-16: seed 42 twice → identical length, rms and peak to 9 decimals;
    seed 99 → different. Across *machines* it is not reproducible, for the
    int8 reason above.
  - **Speed.** Single-threaded WASM, Chrome on an Apple Silicon Mac: models
    open in ~10 s from cache, cloning a 10 s reference ~2.1 s, generation
    ~2.2x real time.
  - **End to end.** Checked 2026-09-16 on the 5:50 Nuclei Segmentation
    walkthrough: transcript (81 lines, Whisper base) → edit line 2's version
    number → `respeak` appeared on that line only → cloned from 5:04-5:19
    (15.0 s, 98% speech) → "fitted into 8.8 s", picture untouched → export ran
    to 5:50.82, the original duration.
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

- Overdub: respeak a whole *run* of consecutive edited lines as one generation,
  so prosody carries across the join instead of restarting per line.
- Overdub: the dub starts on the next animation frame after the playhead
  enters its span, so it can be up to ~16 ms late in the preview (the export
  is sample-exact). Scheduling it ahead with `start(when)` would remove that.
- A higher-quality voice preset was investigated and **rejected**: F5-TTS is
  792 MB (not the ~200 MB its README claims — the fp16 transformer alone is
  661 MB), WebGPU-only in practice, has its sampling steps baked at 32 so there
  is no quality/speed knob, and its base weights are CC-BY-NC-4.0 while the
  ONNX mirrors are mislabelled Apache-2.0. If a second tier is ever wanted,
  `onnx-community/Supertonic-TTS-2-ONNX` (~262 MB) is the candidate to check
  first — its zero-shot cloning interface is unconfirmed.
- Soft subtitle track (switchable) — needs a muxer with text tracks
  (Mediabunny writes WebVTT-in-MP4; Apple players prefer tx3g).
- Sidecar `.srt` / `.vtt` download (cues already exist; trivial).
- Parakeet TDT v3 as a faster option for its 25 European languages.
- Translate-to-English captions (Whisper task `translate`; not turbo).
- Caption style options (font, colours, outline instead of box).
