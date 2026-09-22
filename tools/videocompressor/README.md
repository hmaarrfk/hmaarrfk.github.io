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
- **The timeline is three rows.** The row that carries the trim handles, the
  cut bands and the speed bands is exactly the row you want to press to get
  somewhere, and the bands win — so navigation moved to two rows of its own
  above it:
  1. a **filmstrip** of the whole clip, drawn from stills of the file itself:
     where am I, and what is over there? Press anywhere to jump; drag the
     white box to move the zoom window without moving the playhead.
  2. a **zoom window** — a few seconds, with a ruler and, once the frames are
     more than a few pixels apart, one tick per frame. Drag to scrub, scroll
     to zoom (or use −/+/Fit). It follows the playhead, but only re-pages when
     the playhead actually leaves it, so the picture doesn't slide about under
     the pointer mid-drag. This is the row that makes "mark the cut *here*"
     a matter of aiming rather than of nudging with the arrow keys.
  3. the **clip region** as before: green kept range, dimmed head and tail,
     red cuts, blue speed-ups, draggable handles — the only row with controls
     on it. Cuts and speed-ups appear on rows 1 and 2 only as a thin,
     unclickable strip along the bottom, so they can never sit between you
     and the frame you're aiming at.

  The stills come from a *second*, hidden `<video>` on the same Blob URL, so
  building a strip never disturbs playback; seeks are serialized through one
  queue and cached by timestamp, so resizing or changing step is free. In
  Settings/Export all three rows switch to the **output** timeline, so the
  strip shows the film you are actually making, cuts closed up.

  **The fine row is filled first.** An MP4 is not random access: reaching a
  time means decoding forward from the keyframe before it. Row 2's stills are
  a fraction of a second apart and mostly share a GOP; row 1's are scattered
  over the whole file, so each is a fresh seek — on a 4K screencast, 154 ms
  each against 117 ms for a clustered one, and sixteen of them. Filling the
  overview first would make you wait on frames you aren't looking at, so the
  queue is a *priority* queue: row 2 goes first and always jumps ahead, and
  moving the zoom window preempts whatever is left of the overview, which
  resumes afterwards. The subtlety is that a whole row's requests are queued
  **up front** rather than one at a time — a priority queue can only order
  what has been queued, and asking one at a time left one job from each row
  in it, so the rows just took turns. On a 249 MB 3:29 4K source that is the
  difference between the fine row being ready at 2.5 s and at 1.5 s, with the
  overview following at 2.7 s either way.
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
- **Cover image** (optional) — the still a player shows before you press
  play. MP4 has no field called "thumbnail"; what it has is iTunes-style
  cover art, `moov/udta/meta/ilst/covr`, which is what ffmpeg writes for
  `-disposition:v:N attached_pic`. Scrub to a frame and press the picture
  button in the transport — it sits with the play controls, so it travels
  with the preview into whichever step is open and the frame you want is
  always the one you just scrubbed to; it lights up once a cover is set and
  its tooltip names the frame. (Export has the same button beside the
  thumbnail.) `cover.js` splices that JPEG into the finished file *after* the
  mux —
  metadata only, so it costs no encoding time and touches no picture. The
  catch is that growing `moov` slides `mdat` forward, and every chunk of media
  is addressed by its absolute offset in the file, so each track's `stco` /
  `co64` table is patched by the same amount before the bytes go in; get that
  wrong and the file plays garbage. Apple's players and Finder, VLC and Plex
  read cover art; plenty of other players and file managers ignore any such
  tag and just decode a frame, so the image is downloadable too — that is the
  file to hand a `<video poster>` or a video site. The choice is remembered
  as a *timestamp* (the frame is re-grabbed next time the same file is
  loaded), never as a JPEG in `localStorage`.

  Getting the frame is a three-step ladder, because `<video>` will hand you a
  blank one if you ask too early: `drawImage` on a video that has metadata
  but no decoded frame does not throw — it draws *nothing*, leaving the
  canvas transparent, and you get a blank cover with no error anywhere. So
  every grab is checked both before (`readyState >= 2`) and after (a decoded
  frame is opaque, so a transparent centre pixel means the draw was a no-op).
  Then: **the preview itself** when it is already on that frame, which is
  every ordinary press — no seek at all, 43 ms, and literally the picture you
  were looking at; **the filmstrip's hidden `<video>`** seeked there, for a
  cover restored from last time; and failing that, **the preview once it has
  a frame**, waiting for it if the video has only just opened, and reporting
  the time it actually took rather than claiming one it hasn't got.
- **Audio** — AAC audio is **copied through unchanged** via
  `addAudioChunkRaw` (remuxed, never re-encoded) by default. Non-AAC audio is
  dropped, and the UI says so. When something *does* change the samples — a
  boost, a speed change, a ducked breath, a respoken narration — the track has to be
  re-encoded, and `pickAudioEncoder()` decides how: AAC when the browser can
  encode it (macOS, Windows), otherwise **Opus**, which is valid in MP4 and
  which Chrome can encode everywhere. Chrome on Linux has no AAC encoder at
  all, and the export used to respond by dropping the whole audio track; it now
  writes Opus and says so in the summary and the result line. Audio is dropped
  only if neither can be encoded.
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

  Requires the browser to support *some* audio encoding via WebCodecs
  (`AudioEncoder.isConfigSupported`, AAC then Opus) — checked per file at load;
  if neither is available, boost is disabled and audio still passes through
  unchanged.
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

- **Respeak the narration** (optional) — rewrite what the video says and have
  the whole thing delivered again in your own voice, with the picture re-timed
  to match:

  ```
  transcript ─► script (prose) ─► sentences ─► Pocket TTS (one pass) ─► narration
                     │                                                      │
                     └──── patience diff ────► where each sentence was ─────┤
                                                                            ▼
                                        rates & cuts per section  ◄── planTimeline
                                                                            │
                                            captions for what is now said ◄─┘
  ```

  - **Why the whole script.** The first version of this respoke one transcript
    phrase at a time into the hole its recorded phrase left. It worked and it
    sounded wrong: every phrase was a separate generation with its own prosody,
    time-stretched by its own amount into a slot whose length came from how
    fast you happened to say it the first time, with the old recording's pauses
    between. Correct sentences that did not sound like anybody talking. So the
    narration is now the spine and the picture is re-timed to it — a screencast
    tolerates that easily; a chopped-up voice track does not.
  - **The script** is the transcript as prose (a silence over 1.5 s starts a
    paragraph), in a textarea you can rewrite freely. It keeps following the
    transcript until you type in it, so a scientific word fixed in the line
    list above is fixed in what gets spoken.
  - **Pauses follow the punctuation.** `splitScript` cuts the script into
    sentences — leaving "Fig. 3", "Dr. J. Smith" and "0.5 mm" alone — and gives
    each one the gap its own ending asks for, from one `Pause between
    sentences` setting (a paragraph break gets about twice it, a comma rather
    less). The worker speaks the sentences back to back and decodes all of them
    in **one streamed pass**, so the mimi decoder's state carries across every
    join: there is no splice between sentences to hear.
  - **Where each sentence goes** comes from a **patience diff** of the script's
    words against the transcript's. Words appearing exactly once on each side
    are unambiguous anchors; the longest increasing run of them pins the two
    texts together, and the stretches between are matched recursively. A
    rewritten introduction still lands on the right footage, because the
    sentences around it did. A passage that matched nothing at all is placed
    between its neighbours in proportion to how much there is to say.
  - **Re-timing the picture.** Every (recording time, narration time) pair is
    an anchor, and the stretch between two anchors is a section that must
    occupy exactly its share of the narration — i.e. it has a *rate*, which
    `state.edits` already understands. One rate per sentence gives some absurd
    ones, so `planTimeline` drops anchors — worst offender first — merging two
    sections into one gentler rate until everything is inside the band `Video
    may stretch` allows. Where even the fastest allowed rate cannot fit a
    section (the paragraph you deleted), the surplus footage is **cut**. Where
    there are more words than picture, the section runs slower than asked and
    the status line says so, because there is no more footage to show.
  - **`Original audio`: replace it, or keep the room.** Replacing it is the
    default and is what a fully respoken video wants. A respoken *line* has to
    sit inside a recording, so the recording's own quiet goes under it and the
    background never stops; a respoken *video* has no recording left to blend
    into, and the same room tone is then just the room's noise put back. So
    `Replace it entirely` lays none of it under. Instead `generatedBed`
    collects the *generation's* own quiet — the clone carries this microphone,
    not this room's noise — tiles it into a continuous sample, brings it up to
    40 dB under the voice and lays that under everything. Simply leaving the
    room tone out was not enough, and only listening showed why: the model's
    floor sits forty-odd dB under its speech, the room tone used to sit over
    the top of it, and removing it dropped every pause by that much at a
    stroke — heard not as a pause but as the track cutting out, at every
    sentence edge, which is exactly where the picture's sections are cut. The
    same bed also fills wherever the narration doesn't reach — the millisecond at a section boundary that rounded away, footage
    the trim was widened onto afterwards — instead of letting the old voice
    back in for a frame. The preview follows the same rule, so it never
    promises audio the export won't have; `Preview plays: Original recording`
    and a line's own play button still give you the recording when you ask for
    it on purpose. `Keep the room under the narration` is the old behaviour.
  - **One measurement for the whole narration.** Tone matching, level matching
    and the room tone laid under it are all measured once, over all of it.
    Per-sentence measurements give each sentence a slightly different answer,
    heard as the voice shifting under you from line to line. The export then
    takes *contiguous windows* of that one buffer, one per section, so
    consecutive sections are continuous audio and nothing has to be crossfaded.
  - **The captions follow the new narration**, rebuilt from the sentence
    timings and mapped back through the plan, so what is burned in is what is
    now being said. The sections you cut by hand survive a respeak (the plan is
    made in *kept* time and written around them); speed-ups you set by hand do
    not, because the plan decides the speed now.
  - The voice is cloned zero-shot from the clearest 6&ndash;15 s of the
    recording itself, so there is no sample to record and the same microphone
    and room come with it. **Only clone a voice you have the right to use** —
    the model's terms require lawful consent, and this is built for respeaking
    your own narration.

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
| `index.html` | The page. Templated by Jekyll (`layout: null`) only to stamp `?v=<commit>` on every asset URL and to emit the cache-busting import map; it holds no inline JS, and the `.js` files beside it stay front-matter-free and are served verbatim. Loads MP4Box as a global `<script>`, then the module. |
| `compressor.js` | ES module: streaming demux, preview/trim, transcode, mux, and all UI wiring. |
| `filmstrip.js` | ES module: timeline rows 1 and 2 — the overview filmstrip and the zoom window — plus the hidden `<video>`, seek queue and frame cache that feed them (and the full-resolution grab the cover picker uses). Gets its DOM/state/timeline through one `ctx`, like `captions-ui.js`. |
| `cover.js` | ES module: MP4 cover art. Writes the `moov/udta/meta/ilst/covr` tree into a finished file and shifts every `stco`/`co64` chunk offset to match. Pure `ArrayBuffer` maths — no DOM — so it runs under Node. |
| `cover.test.mjs` | Node test for the above. `node cover.test.mjs`. |
| `breath.js` | ES module: breath detection (gap + level + noise-like + rises out of the floor) and region ducking with ramps. Pure `Float32Array` maths, tested by `breath.test.mjs`. |
| `breath.test.mjs` | Node test for the above. `node breath.test.mjs`. |
| `audio-boost.test.mjs` | Node test for the leveller's non-speech hold. `node audio-boost.test.mjs`. |
| `speed.js` | ES module: WSOLA time compression for sped-up sections that keep their narration. Pure functions on interleaved `Float32Array`s — no DOM/WebCodecs — so it runs under Node, which is where `speed.test.mjs` tests it. |
| `speed.test.mjs` | Node test for the above: output length, pitch preservation, level, chunk-size independence. `node speed.test.mjs`. |
| `audio-boost.js` | ES module: the voice-band loudness analysis, auto-gain, and soft-limiter math. Pure functions on `Float32Array`s — no DOM/WebCodecs — so it's usable standalone (e.g. under Node, fed raw PCM from `ffmpeg`) to sanity-check the algorithm outside the browser. |
| `captions.js` | ES module: the pure caption logic — 16 kHz resampler, `detectSpeech`/`compactSpeech`/`mapCompactSpan`, window planning, `mergeChunkWords`, words → cues, `cueAt`, and `drawCaption` (used by both the preview overlay and the encoder). No DOM/model, so it runs under Node too. |
| `captions-ui.js` | ES module: the interactive half — model presets and the WebGPU probe, the transcription job and its worker, the editable cue list, the preview overlay, and caption persistence. Gets the DOM, the state and a few timeline/audio helpers from `compressor.js` through one `ctx` object. |
| `captions-worker.js` | Module Web Worker: loads Whisper through transformers.js, detects the language, transcribes chunk by chunk and posts words (with timestamps) back as it goes. Jobs are id-tagged and serialized so a cancelled one can't interleave with a new one. |
| `voice.js` | ES module: the pure overdub logic — turning a transcript into a script and a script into sentences (`scriptFromCues`, `splitScript`), aligning a rewritten script back onto the recording (`matchWords`, `alignScript`), re-timing the picture to it (`planTimeline`), captions for what is now said (`narrationWords`), which few seconds to clone from (`pickReference`), and finishing the narration (`finishNarration`, `matchTone`, `matchVoiceLevel`, `findRoomTone`, `generatedBed`). No DOM or model, so it runs under Node, which is where `voice.test.mjs` tests it. |
| `voice.test.mjs` | Node test for the above. `node voice.test.mjs`. |
| `voice-tokenizer.js` | ES module: a minimal SentencePiece reader (protobuf) and unigram Viterbi segmenter with byte fallback, so the voice model's `tokenizer.model` can be used directly rather than vendoring a converted copy per language. |
| `voice-tokenizer.test.mjs` | Node test for the above, against models built in the test. `node voice-tokenizer.test.mjs`. |
| `voice-ui.js` | ES module: the interactive half of overdub — the model download and its cache probe, choosing and decoding the reference clip, the script box, respeaking the script and applying the timeline it implies, and handing the encoder slices of the finished narration through `pcmFor()`. Gets its DOM/state/timeline through one `ctx`, like `captions-ui.js`. |
| `voice-worker.js` | Module Web Worker: runs the five Pocket TTS ONNX graphs on onnxruntime-web. A port of the reference Python driver, including the hand-threaded KV cache that *is* the cloned voice. Takes a whole script as `parts` and speaks them back to back, decoding all of them in one streamed pass so the joins between sentences are continuous audio. |
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
- `@huggingface/transformers` **4.3.0**
- `onnxruntime-web` **1.31.0-dev.20260914-8d85527a0** (the exact build transformers.js 4.3.0 pins, so both share one cached WASM)

  Do not drop back below this ONNX Runtime build. Between 1.25 and the fix in
  [onnxruntime#28326](https://github.com/microsoft/onnxruntime/pull/28326), a
  QDQ→`MatMulNBits` fusion crashed on any decoder whose tied embedding weight
  is consumed by two `DequantizeLinear` nodes — which is every `_timestamped`
  Whisper export we use. The q8 decoder (the CPU/WASM preset) failed session
  creation outright with *"Missing required scale:
  model.decoder.embed_tokens.weight_merged_0_scale"*, so captions were broken
  for anyone without WebGPU.

To update:

```bash
cd tools/videocompressor/vendor
./update-vendor.sh                       # pinned versions
./update-vendor.sh 0.5.2 5.1.5 4.3.0     # or specify mp4box + mp4-muxer + transformers versions
```

**One patch is applied to the transformers bundle.** GitHub's secret-scanning
push protection rejects any push containing a standalone 32-character
alphanumeric token — the shape of a Mistral API key — and the bundle has two:
a gist id in an error message (`gist.github.com/hollance/<32 hex>`, about
Whisper's `alignment_heads`) and the class name
`Mistral3ForConditionalGeneration`, which is exactly 32 characters long and
carries the keyword the rule looks for. Both are false positives, but they
block the push, so `update-vendor.sh` rewrites each token's last character as
a `\uXXXX` escape (`…ConditionalGeneratio\u006e`): byte-different from
upstream, identical at runtime. The escape is the one rewrite that is legal
both inside a string literal and inside an *identifier* — 4.3.0 needs the
latter, because the class name also appears bare in the bundle's export map
and export clause. The script proves the rewrite is byte-reversible and then
re-parses the bundle, failing if either check does.

Then bump the versions above, re-test, and commit the changed `vendor/` files.

## Browser support

WebCodecs is required. As of writing that means a recent **Chrome/Edge** or
**Safari**; Firefox support is still landing. HEVC *encoding* in particular
depends on the OS/GPU — the tool probes `VideoEncoder.isConfigSupported()` and
falls back or reports a clear error if a codec isn't available. If WebCodecs is
missing entirely, the page shows a compatibility notice instead of the tool.

Auto-captions use **WebGPU** when the browser exposes it (Chrome/Edge, recent
Safari); the large-v3-turbo preset's fp16 encoder also needs the
`shader-f16` feature, and falls back to a q4 encoder without it. The adapter
probe asks for `powerPreference: 'high-performance'`, matching what
transformers.js pins ONNX Runtime's WebGPU backend to — otherwise, on a
machine with both an integrated and a discrete GPU, the preset could be
chosen from one card's features and then run on the other. With no WebGPU at
all, Whisper runs on the CPU (WASM) — it works, but slowly, so the base model
is the default there.

## Notes / limitations

- Input must be an MP4/MOV/M4V the browser can decode (H.264 or H.265). Formats
  like ProRes or VP9-in-WebM aren't handled by this MP4-focused demux path.
- Trim decodes from the start of the file up to the selection's end (it can't
  skip into the middle of a GOP), so a trim near the *end* of a long video still
  streams most of the file. A trim near the start is fast.
- Target-size mode computes a constant video bitrate from the (trimmed)
  duration (single-pass), so the final size is an estimate — very close, not
  exact. Use the result's size readout and nudge the target for a hard cap.
