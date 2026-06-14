# gifski web tool — requirements & design notes

A living spec for the gifski GIF-maker at `/tools/gifski/`. Update this file
whenever the tool changes so we can always pick up where we left off.

_Last updated: 2026-06-13 (tone-curve editor + histograms; speed/duration/loop as instant metadata patches; two-unit crop nudges; render-time preview)._

## Purpose

Turn a **video** or a **sequence of images** into a high-quality animated GIF,
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
5. **No Jekyll/Liquid processing of the app.** `index.html`, `gifski.js`, and
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
| `gifski.js` | All app logic (ES module) |
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
control panels switch. Panes contain `.video-only` / `.images-only` blocks that
`applyMode()` toggles based on the detected source.

### Inputs
- **Auto-detected source**: one drop zone (`#drop-any`, no click-to-open) accepts
  a video *or* images and picks the mode automatically (video wins if present).
  Two explicit buttons ("Choose a video…", "Choose images…") open the matching
  file picker. Mode is set by what loads, not a manual toggle.
- **Video**: any format the browser can play. **Images**: many images, natural-
  sorted by filename; each becomes a frame; per-frame remove; first image's
  (capped) size sets the canvas, others contain-fit (letterboxed on black).

### Video timeline editor (video mode)
- **WYSIWYG canvas preview**: the visible preview is a `<canvas>` rendered
  through the same `paint()` pipeline as the output, so rotation (incl. the
  90/270 dimension swap), flip, and colour filter are shown live and update the
  instant a control changes. The `<video>` is the hidden decode source; an rAF
  loop redraws the canvas during playback. Backing store capped at
  `PREVIEW_MAX` (854 px wide) for smoothness. During encoding the preview +
  timeline cursor advance frame-by-frame (`drawPreview(true)` per extracted
  frame) so you can watch it render.
- **Transport**: jump-to-in, prev frame, play/pause, next frame, jump-to-out,
  plus a timecode readout (`m:ss.xx / m:ss.xx · frame N`).
- **Scrubbable timeline track**: click or drag to move the playhead.
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
  these in order, played back-to-back. Preview playback skips cuts and stops at
  the out point.
- **Keyboard**: Space = play/pause, ←/→ = frame step, Home/End = in/out,
  I/O = set in/out, X = arm/commit a cut.

### Spatial crop & output size (Crop step, video)
- Crop is defined in **displayed (post-rotation/flip) source pixels** and shown
  as a draggable box on the preview (dimmed outside, rule-of-thirds guides).
  Corner + edge handles resize; locked aspect hides edge handles. Drag interior
  to move; "Reset crop" restores the full frame. Two nudge d-pads: **Fine**
  (1 source px) and **GIF-pixel** (1 output px = `crop.w/finalW` source px —
  useful when the source is much higher-res than the GIF).
- **Aspect presets**: free / original / 1:1 / 4:3 / 3:2 / 16:9 / 3:4 / 9:16.
- Exact numeric entry in **both spaces**: crop X/Y/W/H in source px, and final
  W/H in output px (final follows the crop aspect).
- **Rotation/flip carry the crop** (transform its extents, don't reset); a
  90/270 turn swaps the crop W↔H, the final W↔H, and the aspect preset wide↔tall
  (4:3↔3:4, 3:2↔2:3, 16:9↔9:16).
- Extraction is two-step: render the full transformed frame just large enough
  that the crop ≥ final size, then crop + scale to the exact final size.
- Images mode has no spatial crop — just **Max width** (px); `0` = original.

### Style step
- **Rotate** 0/90/180/270 (90/270 swap output W/H), **Flip** none/h/v/both,
  **Color filter** none/grayscale/sepia/invert/contrast/warm/cool/vintage
  (CSS `ctx.filter` during draw).
- **Colormap** (false-colour) via a **searchable combobox** (fuzzy match, gradient
  swatches): None + 22 matplotlib LUTs (`colormaps.js`) + 3 in-code ramps
  Black→Red/Green/Blue. The single-hue ColorBrewer maps are shown as
  "White → Red/Green/Blue". Applied per-pixel: the chosen **channel** (luminance /
  R / G / B) indexes the 256-entry LUT. Live in the preview.
- **Tone curve (contrast)** — a GIMP-style curves editor on a `<canvas>`:
  draggable control points (click line to add, double-click to remove) define a
  256-entry LUT. The cropped region's **input histogram** sits behind the curve
  (toggle "show output on curve"); a live **output histogram** strip sits below
  (pre-GIF-quantization). Applied to the colormap input, or to RGB when no
  colormap is set. Live in the preview.

### Logo / watermark step
- Optional logo image (its own click-to-open dropzone). Position TL/TR/BL/BR/
  center, **size** (% of frame width), **opacity** (0–100% → watermark). Drawn
  *on top* (after colormap), inside the cropped output. Preview composites it
  within the crop region.

### Export step + common
- **Frames per second** (capture/sample rate — changing it re-extracts/re-encodes),
  **Quality** (1–100).
- **Timing** (metadata-only, instant): either **By speed** (0.25×–4×) or **By
  total duration** (1/2/3/5/10 s or custom) — duration spreads all frames evenly,
  intuitive when there are few frames. **Looping** forever/once/n.
- **Metadata patching**: the base GIF is encoded once at 1× / infinite loop;
  changing timing or loop rewrites the GIF's per-frame delays / Netscape loop
  block **in place** (`patchGif`) — no re-encode. Any change that alters the
  actual frames (`markStale()`) invalidates the base so the next Create GIF
  re-encodes. Frame *rate* (sampling) genuinely needs re-encode; playback timing
  does not.
- Inline GIF preview on a checkerboard, a meta line (`W×H · N frames · fps ·
  size`), and a **Download** button (named after the source video, else
  `animation.gif`).

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
3. `encode()` the `ImageData[]` with constant `frameDurations = 1000/(fps×speed)`
   and the chosen `quality`/`repeat`.
4. Wrap the returned bytes in a `Blob('image/gif')`, show + offer download.

## Local preview

The tool itself is static, so any static server works for it alone, e.g.
`python3 -m http.server` then open `/tools/gifski/`.

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
  rotate/flip/filter/speed/loop produce valid `GIF89a`s.
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
