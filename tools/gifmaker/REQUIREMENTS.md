# GIF Maker — requirements & design notes

A living spec for the GIF Maker at `/tools/gifmaker/`. Update this file
whenever the tool changes so we can always pick up where we left off.

_Last updated: 2026-06-14 (four size/quality variants per render from one frame-extraction pass; touch/layout optimizations — single-column controls on phones, even step grid, larger tap targets, no-zoom inputs; compressed timeline after Trim; iOS preview decode fix; video-only)._

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
  longer overflow); the crop number fields keep **two columns** (`.controls.cols-2`)
  since they're short, paired X/Y and W/H. On desktop they flow via
  `auto-fit minmax(180px, 1fr)`.
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
- **Colormap** (false-colour) via a **searchable combobox** (fuzzy match, gradient
  swatches), disabled when input is RGB: None + 22 matplotlib LUTs (`colormaps.js`)
  + 3 in-code ramps Black→Red/Green/Blue. Single-hue ColorBrewer maps shown as
  "White → Red/Green/Blue". The chosen channel (0–255) indexes the 256-entry LUT.
- **Colour filter** none/grayscale/sepia/invert/contrast/warm/cool/vintage
  (CSS `ctx.filter` during draw).
- **Rotate** (0/90/180/270) and **Flip** live in the **Crop & size** step
  (geometry), not here.
- **Tone curve (contrast)** — a GIMP-style curves editor on a `<canvas>`:
  draggable control points (click/tap line to add, double-tap/double-click to remove) define a
  256-entry LUT via a **smooth monotonic cubic** (Fritsch–Carlson) interpolation.
  The **end points move horizontally** too, so dragging them inward clips
  blacks/whites to *increase* contrast (not just decrease it). The histograms are
  computed over the **current crop ROI** and update live as the ROI is dragged
  while the Style step is showing. Layout: **input histogram behind the curve on
  the left → arrow → output histogram on the right** (both square; pre-GIF
  quantization). The **output histogram is tinted by the colormap** (each bar in
  the colour that value maps to; grayscale when no colormap). A **log scale**
  toggle (log1p) reveals the dark end. Applied to the colormap input, or to RGB
  when no colormap is set. Live in the preview.
- **Invert input** (toggle): flips the input axis (value `255−x` fed through the
  curve) so the selected range + midpoint invert together; negates the image on
  RGB input. **Reverse colormap** (separate toggle): flips the colour ramp
  (`lut[255−i]`) at lookup — affects colormap output only, baked into the GPU
  colormap texture. These are distinct operations.

### Logo / watermark step
- Optional logo image (its own click-to-open dropzone that shows a **preview** of
  the chosen image on a transparency checkerboard once loaded). Position
  TL/TR/BL/BR/center / center +45° / center −45° (rotated), **size** (2–200% of
  frame width), **opacity** (0–100% → watermark). Drawn
  *on top* (after colormap), inside the cropped output. Preview composites it
  within the crop region.

### Export step + common
- **Frames per second** (capture/sample rate — changing it re-extracts/re-encodes),
  **Quality** (1–100).
- **Timing** (metadata-only, instant): either **By speed** (0.25×–4×) or **By
  total duration** (1/2/3/5/10 s or custom) — duration spreads all frames evenly,
  intuitive when there are few frames. **Looping** forever/once/n.
- **Four size/quality variants per render** (`VARIANT_DEFS`): one "Create GIF"
  extracts every frame **once** (shared), then encodes up to four GIFs and shows
  them side by side so the user picks the smallest acceptable one:
  1. **Requested** — the requested fps & quality.
  2. **¼ frame rate** — every 4th frame (`frames.filter((_,i)=>i%4===0)`), same quality.
  3. **¾ quality** — full frame rate, quality × 0.75.
  4. **¼ rate + ¾ quality** — both reductions combined (smallest).
  Variants that subsample below 2 frames, or that would duplicate another
  variant's (frame-count, quality) pair, are skipped. Each is rendered as a
  `.result-card` (preview, label, meta, **Download** named
  `<source>-<key>.gif`). Frame *rate* (sampling) and quality genuinely need a
  re-encode; that's why all four are produced up front in the single pass.
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
- A "100% vibed" callout (no tracking/uploads) links to the GitHub repo to star.
- About panel lists the AGPL license + "Built on" / "Inspired by" reference
  links (gifski, gifski-wasm, matplotlib/Turbo/ColorBrewer, Squoosh, ffmpeg.wasm,
  Claude Code, …).

## Pipeline (how it works)

1. Decode input → per-frame source (seek video frame-by-frame across kept
   ranges, or decoded image bitmaps).
2. For each frame, `paint()` rotation + flip + color filter; for video, crop +
   scale to the final size; then `finishFrame()` applies the colormap (per-pixel
   LUT) and composites the logo, and reads back `ImageData`.
3. Build the variant specs from the single `frames[]` (subsample for ¼-rate
   variants, scale quality for ¾-quality variants), then `encode()` each as an
   `ImageData[]` at 1× / infinite loop with constant `frameDurations` and its
   quality.
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
- The four-variant flow is exercised end-to-end with a synthetic in-page video
  (canvas → `MediaRecorder` → `File` → the real `#file-video` input), then
  asserting four `.result-card`s render with monotonically decreasing sizes and
  that speed/loop/duration changes patch all cards with **zero console errors**.
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
