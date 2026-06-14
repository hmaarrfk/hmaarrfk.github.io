# GIF Maker — requirements & design notes

A living spec for the GIF Maker at `/tools/gifmaker/`. Update this file
whenever the tool changes so we can always pick up where we left off.

_Last updated: 2026-06-14 (Export keeps the preview visible until you press Create GIF, then collapses to the output + star ask; star-on-GitHub ask shown only after generating; duration mode now extracts exactly fps×duration frames sampled across the kept content, not the whole source; markStale clears stale result cards cleanly (no blob errors); Generate is a focused step that collapses the input video; star-on-GitHub ask shown only on the Source + Generate steps; About & license collapsed into a small details; colormap picker swatches now show the current frame recoloured, not an abstract gradient; oval/circle mask in Crop — transparent corners via GIF transparency, logo still drawn on top; 3-point levels+gamma tone curve — min/max input black/white points for contrast, mid for gamma; harmonized editor that mirrors with invert input / reverse colormap via on-canvas input/output ramps; three renamed size variants — High quality / Medium ½-rate / High compression; grouped Crop region / Output size fields; single-column controls on phones; iOS preview decode fix; video-only)._

## Purpose

Turn a **video** into a high-quality animated GIF,
**entirely client-side**. It is the first of a planned family of small static
WebAssembly tools under `/tools/`.

## Hard constraints

1. **Fully static.** Must run as plain files on GitHub Pages
   (`hmaarrfk.github.io`). No build step, no server, no backend.
2. **Nothing is uploaded.** All decoding/encoding happens in the browser. This
   is a core privacy promise stated on the page.
3. **No special HTTP headers.** GitHub Pages cannot set COOP/COEP, so we use the
   **single-threaded** `gifski-wasm` build (no `SharedArrayBuffer`/threads).
4. **Self-contained.** The gifski WASM + glue are **vendored** under `vendor/`
   (not loaded from a CDN at runtime) so the tool works offline and survives CDN
   outages.
5. **No Jekyll/Liquid processing of the app.** `index.html`, `gifmaker.js`, and
   the vendored files carry **no YAML front matter** so Jekyll copies them
   verbatim and never mangles the JavaScript. (The `/tools/` gallery index *is* a
   normal Jekyll page and may use front matter.)
6. **License compliance.** gifski/gifski-wasm are **AGPL-3.0**. The page must
   visibly state this, link the bundled `vendor/LICENSE`, and point to the
   corresponding source (encoder repos + this page's source on GitHub).

## Files

| Path | Role |
|------|------|
| `index.html` | Tool UI (raw HTML, no front matter) |
| `gifmaker.js` | All app logic (ES module) |
| `colormaps.js` | 22 matplotlib colormap LUTs (256×[r,g,b]); generated from matplotlib, see header for licenses |
| `../assets/tools.css` | Shared styling for standalone tool pages |
| `vendor/dist/encode.js` | gifski-wasm high-level `encode()` wrapper |
| `vendor/pkg/gifski_wasm.js` | wasm-bindgen glue |
| `vendor/pkg/gifski_wasm_bg.wasm` | gifski compiled to WASM (~293 KB) |
| `vendor/LICENSE` | AGPL-3.0 text |
| `REQUIREMENTS.md` | This file |

Pinned upstream: **`gifski-wasm@2.2.0`** (single-thread default export).

## Encoder API (vendored)

`encode({ frames, width, height, fps | frameDurations, quality, repeat, resizeWidth, resizeHeight })`
→ `Promise<Uint8Array>` (a GIF). Notes:
- `frames`: array of `ImageData` (or `Uint8Array` RGBA), all the same `width`×`height`.
- Needs **≥ 2 frames**.
- Provide **either** `fps` **or** `frameDurations` (ms per frame), not both. We
  use `frameDurations` (constant) so fractional speeds are exact.
- `quality`: 1–100 (default 80).
- `repeat`: `-1` = loop forever, `0` = play once, `n` = finite repeats.
- The wasm file is located at runtime via `import.meta.url`; vendoring preserves
  the `dist/` → `pkg/` relative layout so this resolves.

## Features (current)

### Workflow (step tabs)
The UI is organised as a non-linear step bar: **Source → Trim → Crop & size →
Style → Logo → Export**. Every step is always clickable (editing isn't linear).
The video **preview is persistent** above the tabs (the `#stage` panel); only the
control panels switch. (Video-only tool — the images path was removed.)

### Responsive / touch layout
Optimized for phones (iPhone-first) as well as desktop:
- `.controls` collapse to **one column at ≤640px** (verbose labels/inputs no
  longer overflow).
- The crop number fields are **grouped subsections** (`.field-groups`): a titled
  **"Crop region · source px"** block (X/Y/W/H in a 2-up grid with single-letter
  labels) and an **"Output size · output px"** block (W/H). The two groups sit
  side by side on desktop and stack on phones; each keeps its inner 2-up inputs.
  IDs are unchanged (`crop-x/y/w/h`, `final-w/h`) so the existing wiring is intact.
- The step bar becomes an **even 3×2 grid** on phones (not an uneven flex-wrap);
  the step-3 label is abbreviated to **"Crop"**.
- The tone-curve header (label + invert/reverse/log toggles + Reset) is a
  `.curve-head` flex row that **wraps** instead of overflowing.
- Action-only fields use `.field.action` (full-width button, bottom-aligned)
  instead of an empty `<label>` spacer.
- `@media (pointer: coarse)`: **16px** form text (stops iOS focus-zoom),
  **≥44px** tap targets (buttons, selects, inputs, d-pad, crop handles), bigger
  checkboxes/toggles.

### Input
- A single **video** (drag/drop or click the dropzone). Any format the browser
  can play. (Adding individual images was removed.)

### Video timeline editor (video mode)
- **WYSIWYG canvas preview**: the visible preview is a `<canvas>` rendered
  through the same `paint()` pipeline as the output, so rotation (incl. the
  90/270 dimension swap), flip, and colour filter are shown live and update the
  instant a control changes. The `<video>` is the decode source; an rAF loop
  redraws the canvas during playback. Backing store capped at `PREVIEW_MAX`
  (854 px wide) for smoothness. During encoding the preview + timeline cursor
  advance frame-by-frame so you can watch it render.
  - **iOS Safari**: the `<video>` must NOT be `display:none`/`visibility:hidden`
    or iOS draws a black frame to the canvas; it's kept rendered-but-invisible
    via `.decode-src` (fixed 2px, `opacity:.01`). On load, `primeDecode()` does a
    muted `play()`→rAF→`pause()` so a frame exists before the first draw.
  - The scrub **cursor follows the finger immediately** (`renderPlayhead(t)` on
    pointerdown/move) while the seek catches up async.
- **Two preview modes** (`roiView()`): Source/Trim/Crop show the **full frame
  with the editable crop box**; from **Style onward (Style/Logo/Export)** the
  preview shows **only the cropped ROI, scaled up to fill, with the crop box
  hidden/locked** (`drawFullPreview` vs `drawRoiPreview`) — you can't re-crop once
  you're styling/exporting; you see the actual framed output.
- **Transport**: jump-to-in, prev frame, play/pause, next frame, jump-to-out,
  plus a timecode readout (`m:ss.xx / m:ss.xx · frame N`).
- **Scrubbable timeline track**: click or drag to move the playhead. Seeks are
  **coalesced** (only one in flight; latest finger position flushed on `seeked`)
  so touch scrubbing isn't laggy. `touch-action: none` + pointer capture make the
  drag work on touch.
- **Crop** via two draggable green **in/out handles** (or Set start / Set end
  buttons at the playhead).
- **Frame-by-frame** stepping (buttons + ← / → keys); step = `1 / fps`.
- **Interior cuts**: "Mark cut start" then "Remove section" deletes the span
  between the armed point and the playhead. While a cut is armed, the staged
  span shows as a **yellow band** (start→playhead) and the "Remove section"
  button is highlighted yellow, so it's clear what will be removed. Committed
  cuts render as **red striped** regions; hovering one shows a red ✕ delete
  cursor + ✕ badge + tooltip, and clicking it undoes that cut. "Clear cuts"
  removes all.
- **Icons**: transport controls use inline **SVG** (skip-to-start/end as
  bar+triangle, frame step as bold chevrons, play/pause swaps shape) — no icon
  font dependency, crisp and aligned at any size.
- **Kept ranges** = `[cropStart, cropEnd]` minus all cuts; the GIF is built from
  these in order, played back-to-back. Preview playback **skips** the removed
  regions (the `timeupdate` handler seeks past each cut and stops at the out
  point), so you preview exactly the GIF content.
- **Compressed timeline after Trim** (`timelineCompressed()` — true on
  Crop/Style/Logo/Export): the track collapses to one continuous **kept** bar
  with no handles/cut strips, and the playhead + timecode use *compressed/output*
  time. `toOutputTime()` / `fromOutputTime()` map between real video time and
  compressed time; scrubbing maps the bar fraction → output time → video time.
  On Source/Trim the timeline is the full editable view (handles + cut strips).
- **Keyboard**: Space = play/pause, ←/→ = frame step, Home/End = in/out,
  I/O = set in/out, X = arm/commit a cut.

### Spatial crop & output size (Crop step, video)
- Crop is defined in **displayed (post-rotation/flip) source pixels** and shown
  as a draggable box on the preview (dimmed outside, rule-of-thirds guides).
  Corner + edge handles resize; locked aspect hides edge handles. Drag interior
  to move; "Reset crop" restores the full frame. Two nudge d-pads: **Fine**
  (1 source px) and **GIF-pixel** (1 output px = `crop.w/finalW` source px —
  useful when the source is much higher-res than the GIF).
- **Tap to recenter**: tapping **anywhere on the image** — inside or outside the
  box — moves the crop's centre to that point (easier than dragging on touch). A
  tap vs. drag is distinguished by an 8px threshold: a drag inside the box moves
  it, a drag on a handle resizes; a tap recenters (`recenterCropTo`).
- **Touch scroll lock**: on the crop-editable steps (Source/Trim/Crop) the
  preview surface (`#preview-wrap` + `#preview-canvas`) gets `touch-action: none`
  so dragging the crop box — including over the dimmed area — never scrolls the
  page; normal scrolling is restored on Style/Logo/Export.
- **Aspect presets**: free / original / 1:1 / 4:3 / 3:2 / 16:9 / 3:4 / 9:16.
- **Oval mask** (`#oval-mask`): makes everything outside the inscribed ellipse of
  the output rectangle **transparent** (a circle for square crops, an oval
  otherwise) — exported as real GIF transparency (gifski emits a transparent
  palette index for fully-transparent pixels). Implemented as a `destination-in`
  ellipse composite (`applyOvalMask`) applied in `finishFrame` **after** the
  colormap/curve but **before** the logo, so a logo/watermark still draws on top
  of the masked frame. The same mask is shown live in the ROI preview, with a
  dashed ellipse guide on the crop box (`.crop-oval`) during the Crop step; the
  preview canvas drops its black backing (`#preview-canvas.masked`) so the
  masked-out corners are genuinely transparent (you see the panel/page behind).
  Toggling it `markStale()`s (needs a re-encode).
- Exact numeric entry in **both spaces**: crop X/Y/W/H in source px, and final
  W/H in output px (final follows the crop aspect).
- **Rotation/flip carry the crop** (transform its extents, don't reset); a
  90/270 turn swaps the crop W↔H, the final W↔H, and the aspect preset wide↔tall
  (4:3↔3:4, 3:2↔2:3, 16:9↔9:16).
- Extraction is two-step: render the full transformed frame just large enough
  that the crop ≥ final size, then crop + scale to the exact final size.

### Style step (order = how it's applied: input → colormap → filter)
- **Input**: "Full colour (RGB)" (default — keeps colours, colormap disabled) or a
  single channel (Luminance / R / G / B). A single channel is always colormapped
  (falls back to **gray** when no map is chosen, i.e. grayscale).
- **Colormap** (false-colour) via a **searchable combobox** (fuzzy match),
  disabled when input is RGB: None + 22 matplotlib LUTs (`colormaps.js`) + 3
  in-code ramps Black→Red/Green/Blue. Single-hue ColorBrewer maps shown as
  "White → Red/Green/Blue". The chosen channel (0–255) indexes the 256-entry LUT.
  - **Live thumbnails**: each option's swatch is a mini render of the **current
    cropped frame** recoloured by that colormap (the "None" swatch is the grayscale
    frame), not an abstract gradient — more fun and WYSIWYG. The thumbnail is
    rendered from the **crop ROI at the output aspect ratio** (rotation/flip
    applied, same two-step paint+crop as the ROI preview), so it isn't stretched;
    the swatch box uses `background-size:contain` to letterbox it. The selected
    channel is captured when the list opens (`refreshCmThumbs`), then recoloured
    per option (applying the current curve + reverse) and cached as a data URL
    (`cmThumbUrl`). Falls back to a gradient swatch (`swatchCss`) before a video
    is loaded.
- **Colour filter** none/grayscale/sepia/invert/contrast/warm/cool/vintage
  (CSS `ctx.filter` during draw).
- **Rotate** (0/90/180/270) and **Flip** live in the **Crop & size** step
  (geometry), not here.
- **Tone curve (contrast)** — a deliberately simple `<canvas>` levels + gamma
  editor with exactly **three control points**: **min** and **max** are the input
  black/white points (dragged *horizontally* along the bottom; input ≤ min → 0,
  ≥ max → 255), and **mid** sets the **gamma** (dragged *vertically*; its x is
  pinned to the centre of `[min, max]`). `buildCurveLut()` builds the 256-entry
  LUT as `out = 255·((x−min)/(max−min))^γ` with clipping at the ends, where γ
  comes from the mid point's height (`out = 255·0.5^γ` at the centre).
  **Narrowing `[min, max]` boosts contrast**; widening it lowers contrast.
  Moving min/max recentres mid's x, which **preserves the current gamma**. (This
  replaced an earlier freeform multi-point Fritsch–Carlson curve with add/remove
  points, which was too complicated, and a brief output-levels-only gamma variant
  that couldn't increase contrast.)
- **Harmonized editor (everything follows the inversion).** The editor shares one
  invert-aware transform so the curve, the three handles, the input histogram and
  the bottom axis ramp all **mirror together** when *invert input* is on. Two live
  gradient strips anchor the mapping: a **grayscale INPUT ramp along the bottom**
  (flips with *invert input*) and the **effective colormap OUTPUT ramp up the left
  edge** (flips with *reverse colormap*). Display uses the *natural* (pre-invert)
  LUT (`curveLutNatural`); only the *pipeline* LUT (`curveLut`) is value-flipped
  (`255−x`) for the actual pixels. Hit-testing uses the same transform, so
  dragging always matches the displayed curve.
- Histograms are computed over the **current crop ROI** and update live as the ROI
  is dragged while the Style step is showing. Layout: **input histogram behind the
  curve on the left → arrow → output histogram on the right**. The **output
  histogram is tinted by the (effective) colormap** (each bar in the colour that
  value maps to; reflects *reverse colormap*; grayscale when no colormap). A **log
  scale** toggle (log1p) reveals the dark end.
- **Invert input** (toggle): feeds value `255−x` through the curve so the range +
  midpoint invert together (negates the image on RGB input), and mirrors the
  editor's input axis. **Reverse colormap** (separate toggle): flips the colour
  ramp (`lut[255−i]`) at lookup — affects colormap output only (and its on-canvas
  ramp + output histogram). These are distinct operations.

### Logo / watermark step
- Optional logo image (its own click-to-open dropzone that shows a **preview** of
  the chosen image on a transparency checkerboard once loaded). Position
  TL/TR/BL/BR/center / center +45° / center −45° (rotated), **size** (2–200% of
  frame width), **opacity** (0–100% → watermark). Drawn
  *on top* (after colormap), inside the cropped output. Preview composites it
  within the crop region.

### Export step + common
- **Frames per second** (output frame rate; changing it re-extracts/re-encodes),
  **Quality** (1–100).
- **Timing**: either **By speed** (0.25×–4×) or **By total duration**
  (1/2/3/5/10 s or custom). **Looping** forever/once/n.
  - **Frame count depends on the mode** (set at "Create GIF"): in **duration**
    mode the GIF is exactly `round(fps × duration)` frames sampled evenly across
    the kept content (so 3 s @ 15 fps → 45 frames, not the whole source); in
    **speed** mode the kept content is sampled at the capture rate (`fps ×
    kept-seconds` frames) and speed only changes the playback delay.
  - Speed & loop are **instant metadata patches** (no re-encode). Changing the
    duration value re-times the existing frames instantly too (their total plays
    over the new duration); the frame *count* only re-samples on the next Create
    GIF.
- **Three size/quality variants per render** (`VARIANT_DEFS`): one "Create GIF"
  extracts every frame **once** (shared), then encodes the variants and shows them
  side by side so the user picks the smallest acceptable one:
  1. **High quality** — the requested fps & quality.
  2. **Medium** — half the frame rate (`frames.filter((_,i)=>i%2===0)`), same quality.
  3. **High compression** — half the frame rate **and** quality × 0.75 (smallest).
  (¼ frame rate was dropped as too aggressive; the standalone ¾-quality variant
  was folded into High compression.) Variants that subsample below 2 frames, or
  that would duplicate another variant's (frame-count, quality) pair, are skipped.
  Each is rendered as a `.result-card` (preview, label, meta, **Download** named
  `<source>-<key>.gif`). Frame *rate* (sampling) and quality genuinely need a
  re-encode; that's why all variants are produced up front in the single pass.
- **Metadata patching**: each variant's base GIF is encoded once at 1× / infinite
  loop; changing timing or loop rewrites every variant's per-frame delays /
  Netscape loop block **in place** (`patchGif`, then `refreshResultCards`
  updates the cards) — no re-encode. In **duration** mode each variant's delay is
  `totalDuration / its own frame count`, so all variants share the same total
  runtime despite different frame counts. Any change that alters the actual frames
  (`markStale()`) invalidates all variants so the next Create GIF re-encodes.
  Card `<img>`/links are updated in place (not rebuilt) on metadata patches so a
  mid-load image is never stranded when its old blob URL is revoked.

### Privacy / about
- A "100% vibed" callout (`#vibe`, no tracking/uploads) links to the GitHub repo
  to star. It is **shown only after the GIFs are generated** (on the Export step
  with results present) — never while choosing or editing, so it isn't nagging.
- **The Export step focuses once generated** (`updateGenerateView()`): *before*
  pressing Create GIF the input-video preview stays visible (so you can still
  watch it); *after* a successful render the stage collapses (`#stage.collapsed`
  — kept `display:block`, only the visible preview UI hidden, so the
  decode-source `<video>` stays rendered for iOS extraction) and the output GIFs
  + star ask take over. Editing anything (`markStale`) clears the results, which
  un-collapses the preview and hides the star again. The focus state is derived
  from `currentStep === 'export' && variants.length > 0`.
- The **About & license** panel (AGPL notice + "Built on" / "Inspired by" links —
  gifski, gifski-wasm, matplotlib/Turbo/ColorBrewer, Squoosh, ffmpeg.wasm, Claude
  Code, …) is a **collapsed `<details class="about">`** (closed by default) so it
  stays small/tasteful. A one-line legal footer remains always visible (AGPL +
  source link), so the license info is still readily available.

## Pipeline (how it works)

1. Decode input → per-frame source (seek video frame-by-frame across kept
   ranges, or decoded image bitmaps).
2. For each frame, `paint()` rotation + flip + color filter; for video, crop +
   scale to the final size; then `finishFrame()` applies the colormap (per-pixel
   LUT) and composites the logo, and reads back `ImageData`.
3. Build the variant specs from the single `frames[]` (subsample to half rate for
   the smaller variants, scale quality for the compressed one), then `encode()`
   each as an `ImageData[]` at 1× / infinite loop with constant `frameDurations`
   and its quality.
4. Patch each base GIF's timing/loop (`patchGif`), wrap the bytes in a
   `Blob('image/gif')`, and render the variant cards (preview + per-variant
   download).

## Local preview

The tool itself is static, so any static server works for it alone, e.g.
`python3 -m http.server` then open `/tools/gifmaker/`.

For the **full Jekyll site** (homepage, `/tools/` gallery): the `github-pages`
gem pins Jekyll 3.9 / Liquid 4.0.3, which only run on **Ruby ≤ 3.1**
(`String#tainted?` was removed in 3.2; csv/webrick left default gems in 3.4).
On this machine use Homebrew's `ruby@3.1`:

```bash
export PATH="/opt/homebrew/opt/ruby@3.1/bin:$PATH"
bundle install
bundle exec jekyll serve --future     # http://127.0.0.1:4000/
```

The Gemfile also declares `csv base64 bigdecimal logger webrick` so modern Ruby
can load the pinned Jekyll; harmless on GitHub Pages (its own gem env).

## Performance / hardware acceleration

Per-pixel work and redundant readbacks are GPU/throughput-optimized, each with a
CPU/2D fallback (feature-detected; the vendored gifski WASM encode is unchanged):
- **WebGL2 shader pass** does colormap + tone-curve (and is the pixel-effects path
  for both the live preview and per-frame extraction), replacing the per-frame
  `getImageData` → JS loop → `putImageData`. Falls back to the CPU
  `applyPixelEffects` path if WebGL2 is unavailable or errors (`glDead`).
- **Direct `gl.readPixels`** readback (with a vertical row-flip to match the 2D
  convention) skips the GL→2D-canvas→`getImageData` double copy when a pixel
  effect is active and there's no logo.
- **Extraction draws** are collapsed into one crop-scale `drawImage` on the
  rot=0/flip=none fast path; the render-time preview is a throttled (~33ms) blit
  of the finished frame instead of re-running the full preview pipeline.
- (Rejected in review: rVFC playback-based extraction — it sampled one source
  frame late vs the seek path, so the export wouldn't match the WYSIWYG preview.)

## Testing approach

- `window.__gifskiTest(opts)` runs the full transform+encode on synthetic
  frames (no file picker) and returns the GIF header/size/dims — used to verify
  rotate/flip/filter/speed/loop/**quality** produce valid `GIF89a`s.
- The variant flow is exercised end-to-end with a synthetic in-page video
  (canvas → `MediaRecorder` → `File` → the real `#file-video` input), then
  asserting the `.result-card`s render with non-increasing sizes and that
  speed/loop/duration changes patch all cards with **zero console errors**. The
  gamma curve + invert/reverse harmonization are checked by driving the curve
  canvas with pointer events and screenshotting the editor.
- `window.__keepRangesTest(duration, cropStart, cropEnd, cuts)` exposes the
  keep-range solver for unit checks (crop, single/multiple/overlapping cuts).
- Manual/automated browser checks use a **WebM (VP9)** sample — headless
  Chromium lacks H.264, so MP4 fails there (real browsers are fine).

## Known limitations / future ideas

- Frame stepping is sampling-rate based (`1/fps`), not true container frames
  (browsers don't expose exact frame timing reliably without
  `requestVideoFrameCallback`). Good enough for GIF authoring.
- Very long/large videos extract slowly (sequential seeks) and use lots of RAM;
  consider downscaling first or capping frame count with a warning.
- Possible additions: drag-to-reorder image frames, per-frame durations, crop
  **rectangle** (spatial), brightness/contrast sliders, a frame-count/size
  estimate before encoding, optional multi-thread build behind COOP/COEP if ever
  self-hosted somewhere that allows it.

## Adding sibling tools

Each new tool gets its own folder under `/tools/<name>/` with a raw
(front-matter-free) `index.html` + module JS, reuses `../assets/tools.css`, and
adds a card to `/tools/index.html`. Vendor any WASM locally and document its
license the same way.
