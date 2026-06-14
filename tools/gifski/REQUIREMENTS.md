# gifski web tool — requirements & design notes

A living spec for the gifski GIF-maker at `/tools/gifski/`. Update this file
whenever the tool changes so we can always pick up where we left off.

_Last updated: 2026-06-13._

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

### Inputs
- **Video mode**: drag/drop or pick one video (any format the browser can play).
- **Images mode**: drag/drop or pick many images; sorted naturally by filename;
  each becomes a frame; per-frame remove; first image's (capped) size sets the
  canvas, others are contain-fit (letterboxed on black).

### Video timeline editor (video mode)
- Visible `<video>` preview; the same element is the frame-extraction source.
- **Transport**: jump-to-in, prev frame, play/pause, next frame, jump-to-out,
  plus a timecode readout (`m:ss.xx / m:ss.xx · frame N`).
- **Scrubbable timeline track**: click or drag to move the playhead.
- **Crop** via two draggable green **in/out handles** (or Set start / Set end
  buttons at the playhead).
- **Frame-by-frame** stepping (buttons + ← / → keys); step = `1 / fps`.
- **Interior cuts**: "Mark cut start" then "Remove section" deletes the span
  between the armed point and the playhead. Cuts render as **red striped**
  regions; click one to undo it. "Clear cuts" removes all.
- **Kept ranges** = `[cropStart, cropEnd]` minus all cuts; the GIF is built from
  these in order, played back-to-back. Preview playback skips cuts and stops at
  the out point.
- **Keyboard**: Space = play/pause, ←/→ = frame step, Home/End = in/out,
  I/O = set in/out, X = arm/commit a cut.

### Common settings
- **Frames per second** (capture/sample rate; also the frame-step size).
- **Max width** (px) — frames scale down preserving aspect; `0` = original.
- **Quality** slider (1–100).
- **Speed** (0.25×–4×) — multiplies playback rate; output fps = `fps × speed`,
  applied via per-frame durations.
- **Rotate** 0 / 90 / 180 / 270 (90/270 swap output width/height).
- **Flip** none / horizontal / vertical / both.
- **Color filter** none / grayscale / sepia / invert / high-contrast / warm /
  cool / vintage (applied via canvas `ctx.filter` during draw).
- **Looping** forever / once / 3×.

### Output
- Inline GIF preview on a checkerboard, a meta line
  (`W×H · N frames · fps · size`), and a **Download** button (named after the
  source video, else `animation.gif`).

## Pipeline (how it works)

1. Decode input → per-frame source (seek video frame-by-frame across kept
   ranges, or decoded image bitmaps).
2. For each frame, `paint()` onto a canvas sized to the **output** dimensions,
   applying rotation + flip + color filter; read back `ImageData`.
3. `encode()` the `ImageData[]` with constant `frameDurations = 1000/(fps×speed)`
   and the chosen `quality`/`repeat`.
4. Wrap the returned bytes in a `Blob('image/gif')`, show + offer download.

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
