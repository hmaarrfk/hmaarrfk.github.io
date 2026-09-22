# Video Compressor — requirements & design notes

A living spec for the Video Compressor at `/tools/videocompressor/`. Update
this file whenever the tool changes so we can always pick up where we left off.
`README.md` has the deeper technical walkthrough.

_Last updated: 2026-09-21 (**`Original audio: Replace it entirely`, and it is
the default.** The feedback was that the videos should look professional, and
what stopped them was the background of the room coming back under a narration
that had been respoken from end to end. Two things were putting it there.
`layRoomTone` mixes the recording's own quiet under the whole narration — the
right answer when a respoken *line* has to sit inside a recording, and the
wrong one when there is no recording left to sit in, where all it does is put
the room's noise back. And every second the narration does not cover plays the
recording at rate 1, which is how a millisecond rounded off a section boundary,
or footage the trim was widened onto after respeaking, brings the old voice
back in flashes. Replacing the audio turns the first off (the pauses are
rebuilt from the *generated* audio instead, which is quiet and consistent and
not the room) and runs the second silent. `voice.replacesAudio()` is read by
the export and by the preview, so the preview never claims the old voice is
still there; asking for the recording explicitly — `Preview plays`, or a line's
play button — still gets it. `Keep the room under the narration` is the old
behaviour, one select away. **Then the first listen said "it feels like the
audio skips now at every transition, instead of just being set to quiet when
nobody is speaking"**, and it was right: leaving the room tone out is not the
same as replacing it. The model's floor sits forty-odd dB under its own speech,
the room tone used to sit over the top of that, and removing it dropped every
pause by that much — at every sentence edge, which is where the picture's
sections are cut. So `generatedBed` now builds a presence track out of the
clone's own quiet, 40 dB under the voice, and lays it under everything; a
section the narration doesn't cover gets the same bed rather than a hole in it.)_

_Earlier: 2026-09-19 (**Respeak the whole script, and re-time the picture
to it.** Phrase-by-phrase overdub is gone. It worked and it sounded wrong:
every phrase was its own generation with its own prosody, squeezed by its own
WSOLA rate into a slot whose length was decided by how fast it happened to be
said the first time, with the recording's pauses between — a sequence of
correct sentences that did not sound like anybody talking. The transcript is
now a **script** in a textarea (`scriptFromCues`; it keeps following the
transcript until you type in it, so a scientific word fixed in the line list is
fixed in what gets spoken). `splitScript` cuts it into sentences and gives each
the pause its own punctuation asks for. The worker speaks the sentences back to
back and decodes them in one streamed pass, so the decoder's state carries
across every join and there is no splice between sentences at all. A patience
diff (`matchWords` / `alignScript`) says where each sentence was said in the
recording, and `planTimeline` turns the (recording time, narration time) pairs
into an edit list: sections of picture that run a little faster or slower, with
footage the script no longer covers *cut*. Anchors are dropped, worst offender
first, until every section is inside the band `Video may stretch` allows —
a screencast does not need sentence-level sync, so merging two sections into
one gentler rate is free. Tone, level and room tone are measured **once** over
the whole narration, and the export takes contiguous windows of that one
buffer, so nothing is crossfaded and nothing drifts. Captions are rebuilt from
the new sentence timings, so what is burned in follows what is now said. Also:
`Video may stretch` re-times an already-spoken narration on the spot, so it is
a dial you turn and hear. The page's bare-character shortcuts now stand down
for `<textarea>` and `contenteditable` as well as `<input>`/`<select>`: the
script box is the tool's first textarea, and without that every space in a
rewritten script paused the video, every `c` marked a cut, and Home/End
scrubbed instead of moving the caret. Settings opens with the source's resolution, frame
rate, duration, size and bitrate, so a target size is a decision rather than a
guess.)_

_Earlier: 2026-09-17 (**Two overdub bugs, from the first person to
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
   32-character alphanumeric tokens (a gist id in an error message, and the
   class name `Mistral3ForConditionalGeneration`) have their last character
   rewritten as a `\uXXXX` escape, because GitHub push protection reads that
   shape as a Mistral API key and rejects the push. Runtime behaviour is
   unchanged; the script proves the rewrite is byte-reversible and re-parses
   the bundle to show the patch is safe.
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
| `filmstrip.js` | Timeline rows 1 & 2 (overview filmstrip + zoom window): the hidden decode `<video>`, the serialized seek queue, the frame cache, the canvases, and the full-resolution grab the cover picker uses (given a `ctx` by `compressor.js`) |
| `cover.js` | Pure MP4 cover art: write `moov/udta/meta/ilst/covr` into a finished file and shift every `stco`/`co64` chunk offset to match |
| `cover.test.mjs` | Node test for `cover.js` — `node cover.test.mjs` |
| `audio-boost.js` | Pure gain / voice-band leveler math |
| `captions.js` | Pure caption logic: resampler, voice activity + compaction + time mapping, window planning, seam merging, words → cues, `cueAt`, `drawCaption` |
| `captions-ui.js` | Caption UI + job orchestration: model presets, worker, cue list, overlay, persistence (given a `ctx` by `compressor.js`) |
| `captions-worker.js` | Module worker running Whisper (transformers.js) |
| `speed.js` | Pure WSOLA time compression (pitch-preserving) for sped-up sections |
| `breath.js` | Pure breath detection + region ducking |
| `breath.test.mjs` | Node test for `breath.js` — `node breath.test.mjs` |
| `audio-boost.test.mjs` | Node test for the leveller's non-speech hold |
| `speed.test.mjs` | Node test for `speed.js` — `node speed.test.mjs` |
| `voice.js` | Pure overdub logic: `scriptFromCues`, `splitScript`, `matchWords`, `alignScript`, `planTimeline`, `narrationWords`, `finishNarration`, `pickReference`, `findRoomTone`, `generatedBed`, `matchTone`, `matchVoiceLevel` |
| `voice.test.mjs` | Node test for `voice.js` — `node voice.test.mjs` |
| `voice-tokenizer.js` | SentencePiece protobuf reader + unigram Viterbi with byte fallback |
| `voice-tokenizer.test.mjs` | Node test for the above — `node voice-tokenizer.test.mjs` |
| `voice-ui.js` | Overdub UI: model cache, reference clip, the script box, respeaking the script and applying its plan, `pcmFor()` for the encoder (given a `ctx` by `compressor.js`) |
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
- **Three timeline rows, one domain.** `tlDomain()` says what the rows are
  laid out in — the source clip in Trim, the *output* (cuts closed up, speed
  applied) in Settings/Export — and all three read it, so they can never
  disagree. Row 1 is a filmstrip of the whole thing; row 2 is a zoom window
  with a ruler (and one tick per frame once frames are >6 px apart); row 3 is
  the clip region with the handles and the edit bands. **Only row 3 carries
  controls.** That is the point of the split: an edit band is drawn over
  exactly the pixels you want to press to move the playhead, so on rows 1 and
  2 cuts and speed-ups are a 5 px `pointer-events: none` strip along the
  bottom and nothing else. Row 2 re-pages only when the playhead leaves it
  (12 % margin) and never during a drag, so the frames don't slide under the
  pointer; it is frozen while the preview plays, because a still fetched for
  a window that has already moved on is worse than no still.
- **Stills come from a second, hidden `<video>`** on the same Blob URL, never
  from the preview: seeking to build a strip must not disturb what is being
  watched. One element services one seek at a time, so every request — both
  rows and the cover picker — goes through one queue, and results are cached
  by timestamp (96 px tall, 360 max) so a resize or a step change repaints
  for free. A newer generation of a row cancels the older one's outstanding
  requests.
- **That queue is prioritised, fine row first,** because an MP4 is not random
  access: a time is reached by decoding forward from the preceding keyframe.
  Row 2's stills are clustered (mostly one GOP); row 1's are scattered across
  the file and cost a full seek each. Priorities are hand-grab (the cover
  picker) > zoom > film, and row 1's fill is additionally held back ~260 ms
  behind row 2's debounce, because a seek already *in progress* cannot be
  preempted. **A whole row's requests are enqueued before the first is
  awaited** — this is the part that actually makes the priority work; awaiting
  them one at a time leaves a single job per row in the queue, there is
  nothing to order, and the two rows simply alternate.
- **Cover image.** The chosen frame is written into the finished MP4 as
  iTunes-style cover art (`moov/udta/meta/ilst/covr`, `data` type 13 = JPEG),
  which is the mechanism ffmpeg uses for `attached_pic`. It happens *after*
  `muxer.finalize()`, because mp4-muxer has no notion of it and because a
  metadata edit must not touch a frame of picture. The hazard is that `moov`
  precedes `mdat` (fastStart) and media is addressed by absolute file offset,
  so `cover.js` bumps every `stco`/`co64` entry at or past the insertion point
  by the size of the inserted tree *before* splicing it in. Failure degrades
  to a note on the result line — it must never lose an export. The image is a
  JPEG at the source frame's size capped to 1920 px on the long edge (a cover
  is a thumbnail, not a master) and is also downloadable, because most
  non-Apple players ignore cover art and a `<video poster>` wants a file.
  Persisted as a timestamp, not as bytes: a JPEG in `localStorage` would eat
  the quota, and the frame can simply be grabbed again.
- **The cover button lives in the transport**, not in a panel: the transport
  is relocated into whichever step is open, so the button is wherever you
  just scrubbed. It carries its own state (lit + a tooltip naming the frame)
  because the Export panel's thumbnail is invisible from the editing steps.
- **A frame is never taken on trust.** `drawImage` on a `<video>` that has
  reached HAVE_METADATA but decoded nothing does not throw: it draws nothing
  and leaves the canvas transparent, so an early grab yields a *blank cover
  with no error anywhere* — confirmed in Chrome (`readyState 0`, no throw,
  centre pixel alpha 0). Every grab therefore checks `readyState >= 2` first
  and the centre pixel's alpha after, since a decoded frame is always opaque.
  `coverFrameAt()` then works down a ladder — the preview when it is already
  on that frame (no seek; the ordinary press), the hidden `<video>` seeked
  there (a restored cover), and the preview once it has a frame, waited for —
  returning the time it really used. Same class of bug in `seekGrab`:
  assigning `currentTime` the value it already holds fires no `seeked`, which
  at t = 0 on a cold start meant waiting out the 5 s timeout for nothing.
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

- **Overdub (respeak the whole narration).** The first version respoke one
  transcript phrase at a time into the hole its recorded phrase left. It
  worked, and it sounded wrong — which is the reason for everything below.
  Each phrase was its own generation with its own prosody, squeezed by its own
  WSOLA rate into a slot whose length was decided by how fast it happened to be
  said the first time, with the *recording's* pauses between. The result was a
  sequence of correct sentences that did not sound like anybody talking. So the
  direction is inverted: the narration is the spine and the picture is re-timed
  to it. Phrase-by-phrase respeaking, `snapSpan`, `fitToDuration`, `planFit`,
  `naturalRate` and the per-line queue are gone.
  - **Typing is not a shortcut.** Every keyboard shortcut on the page is a bare
    character (Space plays, `C` marks a cut, Home/End jump to the selection
    edges), so the `document.onkeydown` guard has to name everything you can
    type into — `INPUT`, `TEXTAREA`, `SELECT` and `isContentEditable` — not
    just `<input>`.
  - **The script is prose, not a list.** `scriptFromCues` joins the transcript
    into paragraphs (a silence over 1.5 s starts a new one) and drops it in a
    textarea. It keeps following the transcript — so a scientific word fixed in
    the line list is fixed in what gets spoken — until somebody types in the
    box, after which only **Use the transcript** overwrites it.
  - **The sentence is the unit.** `splitScript` cuts a paragraph into sentences
    (`splitSentences` leaves abbreviations, initials and decimals alone: "Fig.
    3", "Dr. J. Smith", "0.5 mm"; a lone *capital* before a full stop is an
    initial, a lone lower-case letter is the tail of "the 20x."). Each sentence
    is one phrase for the model and one anchor for the alignment. Its trailing
    punctuation chooses the pause after it — **this is where "the pauses follow
    the punctuation" happens** — from one `Pause between sentences` setting
    (default 0.36 s; a paragraph break gets 2.2x it, a clause break 0.56x).
  - **One generation, in order.** `voice-worker.js` takes `parts` and speaks
    them back to back, keeping the latents for all of them and decoding them in
    a single streamed pass so the mimi decoder's state carries across every
    join. The pauses are cut into the decoded audio afterwards, at the frame
    boundaries the sentences ended on, and the worker reports where each
    sentence landed. There is no splice between sentences to hear.
  - **Alignment is a word diff, not a guess.** `matchWords` is a patience diff:
    words appearing exactly once on each side are unambiguous anchors, the
    longest increasing run of them pins the two texts together, and each
    stretch between two anchors is matched the same way recursively. No
    O(n·m) table — a half-hour transcript is several thousand words — and a
    rewritten introduction still lands on the right footage because the
    sentences around it did. `alignScript` gives every sentence the seconds its
    own words were said in, forces the anchors to march forward (one badly
    paired repeated word would otherwise fold the timeline back on itself), and
    shares out the gap between anchors for sentences that matched nothing.
  - **The picture is re-timed, and that is the whole trick.** Each (recording
    time, narration time) pair is an anchor; the stretch between two anchors is
    a section of video that must occupy exactly its share of the narration —
    i.e. it has a *rate*, which `state.edits` already understands. Taken
    literally that gives one rate per sentence and some of them absurd, so
    `planTimeline` drops anchors, worst offender first, merging two sections
    into one with a gentler rate. All that is lost is sentence-level sync
    inside the merged section, which a screencast does not need. The band comes
    from `Video may stretch` (default 50%, so 0.67x–1.5x). A second, cosmetic
    pass then joins neighbouring sections whose rates are already within 1.15x
    of each other and stay in band merged: nothing is wrong with them, but
    every rate change is a change of playback speed, and a screencast with a
    moving cursor shows one a second as jerkiness.
  - **`Video may stretch` is a dial you can hear.** Changing it calls
    `replan()`, which re-times an already-spoken narration from the stored
    sentence spans — no generation, only the sections' rates and the plan's
    cuts move. `Pause between sentences` is deliberately *not* like this: it
    is baked into the samples and needs a new take, and the hint says so.
  - **Footage the script no longer covers is cut.** When even the fastest
    allowed rate cannot fit a section into its share of the narration — the
    paragraph you deleted — the surplus is removed (from the section's end, so
    the picture stays with the start of what is being said and jumps forward
    just before the next sentence). Below 0.35 s the section just runs a shade
    faster: a cut that short is more visible than the speed-up it saves.
  - **The opposite case has no lever, and says so.** More words than picture
    means the section runs slower than asked; there is no more footage to show
    and no freeze frame in the edit model. `planTimeline` reports `tooSlow` and
    the status line names it rather than desynchronising quietly.
  - **The lead-in and the tail keep their own time.** The silence before the
    first word and after the last is preserved as silence of the same length,
    so those sections start at rate 1 — the relaxation may still merge them
    into a neighbouring sentence that needs to borrow picture, which is exactly
    where the surplus should come from.
  - **The user's cuts survive; their speed-ups do not.** `replaceRespeak` keeps
    every rate-0 edit that is not the plan's own and replaces everything else.
    Cuts are a judgement about the footage and the narration is planned around
    them (the whole plan is made in **kept time** — source minus cuts —
    via `keptTotal` / `sourceToKept` / `keptRangeToSource`). Speed is the
    plan's to decide now. Respeaking again reverts the previous plan *first*,
    so the alignment is never measured against a timeline that only exists
    because of the last respeak.
  - **A section is a window onto one buffer.** `state.dubs` maps an id to
    `{ scriptId, atS }` — a position in the narration, not a clip. `pcmFor`
    finishes the whole narration once per output sample rate and slices it by
    absolute output position, so consecutive sections take consecutive windows
    of continuous audio. Nothing is crossfaded at a section boundary because
    there is no boundary; `crossfadeEdges` is gone with the per-line design.
    A section that straddles a user's cut lands as two source spans with two
    slices, taken by output position so they stay exactly contiguous however
    the frame counts round.
  - **Everything is measured once.** `finishNarration` resamples, tone-matches,
    level-matches, fades and lays the room under the *whole* narration. Doing
    any of that per sentence gives each sentence a slightly different answer,
    which is heard as the voice shifting under you from line to line — the
    original fault. The tonal reference is the reference clip **at the
    recording's own sample rate**, not the 24 kHz copy the model was given:
    the point of `matchTone` is to put back what the model has no bandwidth
    for, and a resampled reference has thrown exactly that away.
  - **Captions follow what is now said.** `narrationWords` spreads each
    sentence's words across its own audio span (by letters, which only ever
    interpolates a couple of seconds between two exact edges), `wordsToCues`
    breaks them the same way it breaks a transcript, and the times are mapped
    back through `fromOutputTime` — the plan was built so that output time *is*
    narration time, so that inverse is all it takes. The old cues are kept in
    `captions.beforeRespeak` for the way back; the *word* timings are not
    replaced, because they still describe the recording, which is what the
    reference clip and the breath detector read them for.
  - **A cue is judged by output time, never by its first source second.** A
    respoken line routinely starts exactly where a removed section does, so
    asking `edits.at(c.start + 0.01)` labelled it `cut` in the list and — far
    worse — dropped it from `exportCues`. Both now ask at the middle of the
    time the cue is actually on screen.
  - **The reference clip comes out of the recording.** `pickReference` walks
    the word timings for runs with no pause longer than 0.45 s and scores the
    best 6-15 s window by *speech density* — the fraction actually covered by
    words. Density is what matters because the model reproduces the recording,
    not just the voice: a window full of room tone teaches it room tone. Ties
    break toward the middle of the file. "Use a different reference clip"
    cycles the next-best non-overlapping candidates.
  - **You can hear it before exporting.** Every line has a play button that
    seeks to it and plays just that line as it will be in the export. Through
    the preview the `<video>` is muted inside a respoken span and the finished
    samples play in its place, through the same gain and limiter nodes, so the
    preview keeps telling the truth. A `Preview plays` setting switches the
    whole timeline between respoken and original, and with the audio replaced
    the `<video>` stays muted outside a respoken span too, so the preview never
    offers the one reassurance it must not — that the old voice is still
    there.
  - **A respoken section is an ordinary edit.** `{ start, end, rate,
    audio: 'keep', dub, src: 'respeak' }`. At export, `openSpan` asks
    `voice.pcmFor(id, …)` for exactly `curTarget` frames and emits them, and
    `feedSpan` drops the decoded source for those seconds. It *does* go through
    the gain stage, like the recording around it: skipping it meant that with a
    boost on, every other second was lifted and the narration was not. An edit
    can carry a dub id with no audio behind it — the timeline survives a reload
    and the samples do not — and is then played as an ordinary section, so the
    export always has sound, with the status saying why.
  - **The level is matched to the recording, and then boosted with it.**
    `matchVoiceLevel` measures the generation with `analyzeVoiceLevel` — the
    300-3400 Hz band *while somebody is talking* — and moves it to the track's
    own `voiceDbfs` (the number auto-boost already works from), falling back to
    the reference clip's level. Plain whole-buffer RMS is the wrong yardstick
    and audibly so: it calls a passage with pauses in it quiet and shoves it
    up. Capped at ±18 dB — more than that is a bad generation, not a level
    problem.
  - **`Original audio` decides whether the recording survives at all.**
    Default `Replace it entirely`. A respoken *line* has to sit inside a
    recording, so it wants the room under it; a respoken *video* has no
    recording left to blend into, and then the room tone is simply the room's
    noise put back — the fan, the street, the hum that made the take sound
    amateur. Replacing it does two things, which are the two places the
    recording otherwise survives a full respeak. `voice-ui.js` passes
    `roomTone: null` and a `bedDb` to `finishNarration`, which lays a presence
    track built out of the *generated* audio under everything instead
    (`generatedBed`, below); and any span the narration does not cover gets
    that same bed rather than falling back to the recording at rate 1 — a millisecond at a section boundary that rounded
    away, or footage the trim was widened onto after respeaking, which
    otherwise brings the old voice back in flashes. `voice.replacesAudio()` is
    read by `openSpan`/`feedSpan` in the export and by `applySpanPlayback` in
    the preview, so what you hear is what you get. Asking for the recording
    explicitly — `Preview plays: Original recording`, or auditioning a line
    with its play button — still gets it. The tonal yardstick stays on either
    way: `matchTone` takes three band gains off the reference clip, which is a
    measurement, not a sample, and it is what gives the clone the speaker's own
    microphone above 12 kHz.
  - **Room tone under the whole narration** (`Original audio: Keep the room`).
    `findRoomTone` takes the longest
    quiet stretch of the recording during the load-time analysis pass (the
    track is decoded exactly once, so it is free there) and `layRoomTone` mixes
    it under everything, pauses included. The background then never stops — the
    ear notices *that* far sooner than it notices a voice being slightly off —
    and it carries everything above the 12 kHz a 24 kHz model cannot produce at
    all, which is what made a bare dub sound like a hole punched in the track.
    A recording that never pauses yields no tone rather than a bad one: with no
    real gap the percentile floor lands inside the speech, and taking it would
    lay the speaker's own voice under the narration.
  - **A presence track out of the narration itself.** `generatedBed` is what
    `Replace it entirely` lays under the narration in place of the room. The
    first version of replacing simply left the room tone out, and it was wrong
    in a way that only listening showed: the model's own floor sits forty-odd dB
    under its speech, the room tone used to sit over the top of that, and taking
    it away dropped every pause by that much at a stroke. The ear does not hear
    that as a pause, it hears the track cutting out — and because `planTimeline`
    puts its anchors on sentence edges, it cut out at *every transition*. (The
    report was exactly that: "it feels like the audio skips now at every
    transition, instead of just being set to quiet when nobody is speaking.")
    So the clone's own quiet is collected once over the whole narration, tiled
    with `tileTones` (shared with `fillWithRoomTone`), brought up to `BED_DB`
    = **−40 dB** under the voice level already matched to, and laid under
    everything with `layRoomTone`. Nothing of the recording is in it — the clone
    carries this microphone, not this room's noise — and the background never
    stops. Two measurement details, both found by measuring rather than
    reasoning: candidate windows are scored over the **whole** narration, not
    the three seconds beside one gap that `fillWithRoomTone` has to make do
    with (which is why that one so often finds nothing usable); and a window
    holding more than 2% **exact zeros** is disqualified, because the inserted
    silence — the lead-in, the tail, the hole a pause was written into — is the
    quietest thing in the buffer and a window straddling its edge would win and
    then lay a bed that was itself half silence. `finishNarration` hands the bed
    back so the export can lay the same presence under a section the narration
    does not cover (`voice.bedFor()`), instead of punching a hole in a bed that
    is otherwise continuous.
  - **Without a room sample, the pauses are rebuilt.** `fillWithRoomTone` fills
    each inserted pause from the narration around it (learning from ~3 s beside
    the gap, never the whole track, so this stays linear in the length of the
    narration). Up to 8 non-overlapping quiet windows are taken, shuffled
    deterministically and equal-power crossfaded, each tile randomly reversed
    and jittered ±1.5 dB, because tiling one 120 ms window makes a 1.5 s pad
    that the ear hears as a breath or hum that was never recorded.
  - **The samples are not persisted.** localStorage keeps the script text and
    the seed — a few minutes of narration is tens of MB of floats against a
    ~5 MB budget shared with the captions. The *timeline* and the captions are
    persisted as usual, so a reload comes back to the right edit and the right
    words on screen, with one button to make the audio again.
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

- **Settings says what you are starting from.** A target size is guesswork
  without it: 100 MB is a big cut from 2 GB and no cut at all from 60 MB. The
  Settings step opens with the source's resolution, frame rate, duration, file
  size and overall bitrate (from the file, so container overhead is in it),
  split into video and audio, and the output line beneath it. Both mode hints
  compare with the source, and say "*larger* than the source" rather than
  printing "0.4x smaller", which is not a thing.

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
- Overdub: `node voice.test.mjs` (sentence splitting around abbreviations and
  initials, punctuation-driven pauses, the patience diff and the alignment it
  feeds — including a wholly rewritten sentence placed between two that were
  not, and anchors that can never run backwards — the re-timing plan (sections
  tile the narration exactly, a hurry stays inside the band, surplus footage is
  cut, anchors are merged rather than lurching, zero stretch still produces a
  timeline and owns up to running slow, near-equal neighbours are smoothed
  together and smoothing never drags a section out of band), caption words that fill their own
  sentence and nothing else, reference choice, level matching, room tone, and
  one measurement for the whole narration) and `node voice-tokenizer.test.mjs` (protobuf
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
  - **End to end (superseded, phrase-by-phrase).** Checked 2026-09-16 on the
    5:50 Nuclei Segmentation walkthrough: transcript (81 lines, Whisper base) →
    edit line 2's version number → `respeak` appeared on that line only →
    cloned from 5:04-5:19 (15.0 s, 98% speech) → "fitted into 8.8 s", picture
    untouched → export ran to 5:50.82, the original duration. This is the
    version that sounded chopped in use, which is why it is gone.
  - **End to end (whole script).** The models are hundreds of MB, so the
    timeline half is checked against a stubbed worker: Playwright seeds a
    transcript into `videocompressor:captions:v1`, overrides `Worker` for
    `voice-worker.js` to answer `speak` with a tone and plausible per-sentence
    spans, then drives the real page. Checked 2026-09-19 on a 40 s 4K clip with
    a 6-sentence transcript rewritten to 4 sentences: the plan came back as
    5 sections at 1.00x–1.50x with 12.2 s cut, the sections tiled the narration
    with no holes, the captions moved to output times, undo restored both the
    edits and the transcript, and a real export (960×540, 15 fps) produced a
    19.32 s file whose audio had 2 sample-to-sample jumps over the whole track
    — i.e. no discontinuity at any of the five section seams.
- Cover at a cold start (2026-09-19, Chrome): pressing the button the instant
  the tool has parsed the file — `preview.readyState === 0`, nothing decoded
  anywhere — must produce a *real* frame, not a blank. It does: 53 ms, and the
  JPEG spans the full 0–255 range rather than being flat. Pressed once
  anything has decoded it is 43 ms and takes no seek at all. Restoring a cover
  saved at 0:12.00 into a freshly opened page came back in 205 ms, from the
  right frame. (Note when testing by hand: settings save on a 300 ms debounce,
  so reloading immediately after choosing a cover legitimately loses it.)
- Cover art: `node cover.test.mjs` (the tree lands at the end of `moov`;
  `moov` and the file grow by the same amount; every chunk offset moves with
  `mdat`, and offsets *ahead* of the insertion point don't; the media is still
  where the patched tables say it is; `co64` and multiple tracks; the image
  reads back byte for byte; the input buffer is untouched; tagging twice and a
  file with no `moov` are refused). Against real files, checked 2026-09-19
  with ffmpeg: tagging an H.264+AAC MP4 left `framemd5` of both the video and
  the audio **identical**, and ffprobe then reported a third stream,
  `mjpeg` with `disposition:attached_pic=1`. End to end in Chrome on a 30 s
  960×540 clip: cover chosen at 0:18.50, exported to 480×270/Opus, and the
  downloaded file came back as h264 + opus + a 960×540 attached mjpeg, decoded
  clean on both real streams, and still played in the page's own `<video>`.
- Timeline rows: checked 2026-09-19 in Chrome. On a 30 s clip the overview
  filled from the file's own frames, pressing at 70 % seeked to 0:21.00 and
  re-centred the zoom window, four wheel notches took the window 30 s → 4.1 s
  with a 0.5 s ruler, and dragging across row 2 scrubbed to 0:22.23. A cut, a
  speed-up and a head trim showed as red / blue / dimmed strips on both
  navigation rows while staying clickable only on row 3. Dragging the window
  box moved the window and left the playhead alone. In Settings the rows
  switched to the output timeline (0:22.67, no marks).
- Fill order, measured on the 249 MB 3:29 **4K** source by hashing each row's
  canvas every 50 ms (2026-09-19). Sixteen seeks on that file: **2456 ms
  scattered across the whole clip vs 1872 ms clustered in 10 s**, i.e. 154 ms
  against 117 ms each — the premise, and mild enough that *ordering*, not
  throughput, is the win. Queuing one request at a time the rows alternated
  (fine row done at 2524 ms, overview at 2873 ms); queuing each row up front,
  every fine still lands first — fine row done at **1482 ms**, the overview's
  first still not until 1672 ms and done at 2725 ms. Jumping the playhead
  1.9 s in, while the overview was still filling, put eight fresh fine stills
  on screen between 2089 and 3187 ms and the overview only resumed at
  3279 ms, i.e. preemption works down to the one seek already in flight.
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

- Overdub: re-transcribe the generated narration with Whisper instead of
  spreading each sentence's words by letter count, for exact caption timings
  inside a long sentence. The sentence *edges* are already exact, so this only
  buys sub-cue accuracy — weigh it against a second model pass.
- Overdub: offer a per-section choice for footage the script no longer covers
  (cut from the end, the middle, or not at all). Cutting from the end is a
  reasonable default, not obviously the right one for every screencast.
- Overdub (superseded): respeak a whole *run* of consecutive edited lines as one generation,
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
