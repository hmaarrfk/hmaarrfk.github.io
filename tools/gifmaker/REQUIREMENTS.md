# GIF Maker — requirements & design notes

A living spec for the GIF Maker at `/tools/gifmaker/`. Update this file
whenever the tool changes so we can always pick up where we left off.

_Last updated: 2026-06-16 (**Multi-format export — GIF + Animated WebP + APNG.**
The Export step now offers three "Create" buttons (Create GIF / Create WebP /
Create APNG); each encodes that format's **three size/quality tiers** from a single
(cached, reused) frame extraction. **Only the most recently created format is
shown** — each "Create" replaces the previous result (the frame cache is kept, so
switching formats re-encodes without re-extracting). WebP is encoded per-frame via the
vendored `@jsquash/webp` (libwebp WASM, Apache-2.0) and muxed into an animated WebP
by our own code (`formats.js`); APNG via the vendored `UPNG.js` + `pako` (MIT).
Both new formats support the same **instant speed/loop patching** as GIF — base
encoded once at 1×/infinite, then per-format byte patchers (`patchWebp` rewrites
ANMF durations + the ANIM loop count; `patchApng` rewrites fcTL delays + the acTL
num_plays with recomputed CRCs) update every shown card with no re-encode. Oval-mask
transparency carries into WebP (alpha) and APNG (native). New deps live in
`vendor-webp/` and `vendor-apng/` (both permissive); the WebP encoder's bare
`wasm-feature-detect` import is resolved by an import map in `index.html`. Tests:
`window.__webpTest()` / `window.__apngTest()` alongside `__gifskiTest`.)_

_Earlier: 2026-06-14 (Short-screen fix: the About & license details and the legal footer are NO LONGER hidden on short/`max-height:760px` windows (they were `display:none`'d there and once a video loaded, making the About — and the license — totally unreachable); they now stay below the editor, reached with a small scroll, so the license is always accessible. Fullscreen result viewer — click a result GIF → lightbox with Full screen / True size / Download / Close (Esc/backdrop close); frame stepping after Trim now steps in OUTPUT time so it skips cut sections and the timeline reads as fully cut; fixed two layout regressions from the wide-screen pass — hidden step-panes could overlay the active one (the Source dropzone was covered, blocking video insertion) and the Create-GIF button overlapped the FPS field in the dense Export grid, both via `.step-pane[hidden]{display:none!important}` / giving `.action-row` its own grid row. Round 4 — **post-encode Export now fits one screen at 1280×720 (the round-3 one-screen failure).** After Create GIF the stage collapses; the generic single-column fallback used to stack the export controls + "Your GIFs" + three ~363px cards + the #vibe promo to ~1125px (≈405px below the fold, Download buttons unreachable). Under `@media (min-width:820px) and (max-height:760px)`, the collapsed-stage export pane is now re-laid as its own two-column grid (`grid-template-areas: head / "result controls" / "result status"`): the three GIF cards + Download buttons fill the WIDE LEFT column (cards capped 200px) while FPS/Quality/Timing/Speed/Looping + the Create/Start-over row sit in a narrow right column — measured post-encode scrollHeight === 720 (was 1125), Download buttons at y=557, 0 overflow, 0 console errors. The Export `.action-row` reverts from sticky to static in this side-by-side layout. The **#vibe promo is slimmed on the short export screen** (heading + Star button only, both promo `<p>`s hidden, flex one-row) so it adds ~68px instead of ~161px — guarded `.vibe:not([hidden])` so the `display:flex` never overrides the `[hidden]` attribute and leaks onto other steps. **Symmetric minimal gutters at 1280:** `.wrap{max-width:min(--maxw-editor,96vw)}` so the 1240px cap no longer leaves a one-sided 40px right gutter (now 26px each side). **Trim right column balanced:** the short Trim pane is `display:flex;justify-content:center` so its controls sit level with the preview middle instead of floating atop ~270px of dead column. **Source pre-load dropzone is now the hero** (`min-height:300px`, centred CTA) so the empty first screen looks intentional. **iPhone density pass (≤640px):** stage chrome slimmed (`#stage{padding:10px}`, `.tl-track{height:40px}`, tighter transport) freeing ~150px of controls above the fold; preview capped 32vh on Crop/Style/Logo and 40vh on Trim (where the timeline IS the control); the desktop crop reflow (Aspect full-width then compact source-px d-pad + Reset, hints hidden, tighter field-groups) ported to mobile; verbose Trim hint hidden, Logo Position/Size 2-up, Style hints hidden. Net iPhone scrollHeight: trim 906→844 (fits), logo 1104→887, style 1244→1106, crop 1295→1161 (crop box still pixel-aligned with the canvas). The remaining iPhone overflow on Crop/Style is inherent to the single-column stack (preview above tall controls); the clean fix is a JS "hide preview" toggle reusing `#stage.collapsed`, deferred to keep JS risk-free. 1920×1080 unchanged (wrap 1760, 80px symmetric margins, 0 overflow). Round 3 — true one-screen fit at 1280×720 + much-reduced phone scroll. **Page chrome no longer steals the 720px budget:** under `@media (max-height:760px)` the always-rendered About & license `<details>`, the legal footer and the `.wrap`'s 80px bottom padding (reduced to 16px) are removed while editing — page scrollHeight dropped from a constant 898px (≈178px of forced scroll on every step) to ≤736px (Crop) / 722px (Style) / 720px (the rest). **Crop/Output number inputs no longer clip:** the 3-digit values (480/320) were cut to "4:"/"3:" by the native spinner in the ~50px grid cells; the spinner is now removed (`appearance:textfield` + `::-webkit-*-spin-button{appearance:none}`) with tighter centred padding so the digits show in full. **iPhone (390×844) scroll cut hard on every step** (source 1161→992, trim 1030→906, crop 1568→1295, style 1725→1244 [−481px], logo 1371→1104, **export 1177→844 = exactly one screen**): the two tone-curve canvases now sit side-by-side on phone too (was a ~360px vertical tower), the redundant GIF-pixel nudge pad is hidden on phone (one source-px pad kept), the logo dropzone is shrunk, the phone preview cap is 38vh, and About/footer are hidden once a video is loaded (`.wrap:has(#stage:not([hidden]))`). On the phone single-column Export step the preview stage's visible UI collapses pre-encode (`#editor:has(.step-pane[data-pane="export"]:not([hidden]))`, the `<video>` decode-source stays rendered) so FPS/Quality/Create-GIF sit near the top — desktop keeps the preview visible since its controls are already beside it. **1920×1080 side margins cut ~210px→80px each side:** the editor cap is raised to `min(1760px,95vw)` at ≥1500px and the controls column grows there (440→520px) so the recovered width feeds both columns; preview 690×460, crop box still pixel-aligned. The short-screen results-grid is capped 3-up with 230px thumbnails. Round 2 baseline: One-screen fit at 1280×720: every step (Source/Trim/Crop/Style/Logo/Export) now fits — or is within a few px of — the 720px-tall viewport. Crop overflow went from +419px to ~+8px and Style from +677px to ~+2px by compacting their control columns (see "One-screen density" below); the preview is now HEIGHT-driven on wide screens (`#preview-canvas{height:min(56vh,460px);width:auto}`, wrap `width:fit-content` centred) so it upscales past the source's native pixel width to fill its column — at 1280×720 a 3:2 video renders ~605×403 (was 475×317), and the wrap hugs the canvas so the % crop box stays exactly aligned; the editor cap is raised to 1500px at ≥1500px so the recovered space grows the preview column instead of becoming dead outer margin (1920×1080 side margin ~340→~210px, preview ~690×460); the header band is tightened under `@media (max-height:760px)` (`.wrap` pad-top 16px, smaller step buttons) to reclaim ~25px; the short-screen preview cap (`44vh`) is now scoped to `<820px` so it only applies to the single-column phone/narrow layout. Earlier: Wide-screen two-column editor: at ≥820px the preview stage and the active step's controls sit side by side in a CSS grid (`.editor` wrapping `#stage` + the `.step-pane`s), reclaiming the old empty left/right margins and getting each step's controls beside — not below — the preview so the short steps fit a 1280×720 viewport; page widened to 1240px only here while step bar / vibe / about / footer stay centred at 880px; sticky preview keeps the frame in view while taller controls scroll; Export CTA row pinned sticky to the pane bottom; on Export-focus / before-load the grid drops to one column so results/controls span full width; Style help text collapsed into a `<details>` and curve/histogram canvases capped at 240px; phone density: Crop & Style controls now 2-up, field-groups stay 2-up, results-grid 2-up with 130px previews, compact step bar; preview shrunk so controls clear the fold — Crop/Style phone heights cut ~340/650px. Export keeps the preview visible until you press Create GIF, then collapses to the output + star ask; star-on-GitHub ask shown only after generating; duration mode now extracts exactly fps×duration frames sampled across the kept content, not the whole source; markStale clears stale result cards cleanly (no blob errors); Generate is a focused step that collapses the input video; star-on-GitHub ask shown only on the Source + Generate steps; About & license collapsed into a small details; colormap picker swatches now show the current frame recoloured, not an abstract gradient; oval/circle mask in Crop — transparent corners via GIF transparency, logo still drawn on top; 3-point levels+gamma tone curve — min/max input black/white points for contrast, mid for gamma; harmonized editor that mirrors with invert input / reverse colormap via on-canvas input/output ramps; three renamed size variants — High quality / Medium ½-rate / High compression; grouped Crop region / Output size fields; single-column controls on phones; iOS preview decode fix; video-only)._

## Purpose

Turn a **video** into a high-quality animated **GIF, WebP, or APNG**,
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
   corresponding source (encoder repos + this page's source on GitHub). The WebP
   and APNG encoders are permissive (Apache-2.0 / MIT) and are credited + linked in
   the About panel with their bundled licenses (`vendor-webp/LICENSE`,
   `vendor-apng/LICENSE.UPNG`, `vendor-apng/LICENSE.pako`).

## Files

| Path | Role |
|------|------|
| `index.html` | Tool UI (raw HTML, no front matter) |
| `gifmaker.js` | All app logic (ES module) |
| `formats.js` | Animated WebP muxer + APNG encoder wrappers + `patchWebp`/`patchApng` (ES module) |
| `colormaps.js` | 22 matplotlib colormap LUTs (256×[r,g,b]); generated from matplotlib, see header for licenses |
| `../assets/tools.css` | Shared styling for standalone tool pages |
| `vendor/…` | gifski-wasm (GIF encoder, AGPL-3.0) — `dist/encode.js`, `pkg/gifski_wasm.js`, `pkg/gifski_wasm_bg.wasm` (~293 KB), `LICENSE`, `README.md`, `update-vendor.sh` |
| `vendor-webp/…` | @jsquash/webp (libwebp WASM, Apache-2.0) — `encode.js`/`meta.js`/`utils.js`, `codec/enc/webp_enc*.{js,wasm}`, `wasm-feature-detect.js`, `LICENSE*`, `README.md` |
| `vendor-apng/…` | UPNG.js + pako (APNG encoder, MIT) — `UPNG.js`, `pako.min.js`, `LICENSE.UPNG`, `LICENSE.pako`, `README.md` |
| `REQUIREMENTS.md` | This file |

Pinned upstream: **`gifski-wasm@2.2.0`** (single-thread default export),
**`@jsquash/webp@1.5.0`** + **`wasm-feature-detect@1.8.0`** (WebP),
**`upng-js@2.1.0`** + **`pako@1.0.11`** (APNG).
**Vendoring strategy:** the four `vendor/` files are **checked-in copies** (no git
submodule, no package manager, nothing fetched at build/runtime). Only the
single-thread build is vendored (the multi-thread build needs SharedArrayBuffer →
COOP/COEP, which GitHub Pages can't set). To update, run `vendor/update-vendor.sh
[version]` then bump the pinned version here + in `vendor/README.md`. Re-vendoring
2.2.0 reproduces byte-identical files (verified).

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

**WebP / APNG (`formats.js`).** Same frame input (`ImageData[]`), one base
animation at 1×/infinite per tier, then patched.
- `encodeWebpAnim({ frames, width, height, frameDurations, quality, loop })` →
  `Promise<Uint8Array>`. Encodes each frame to a lossy WebP via `@jsquash/webp`
  (`quality` 0–100), then muxes a RIFF `VP8X`+`ANIM`+`ANMF…` animated WebP. Sets the
  VP8X **Alpha** flag when any frame had alpha (oval mask). `loop`: `-1` infinite /
  `0` once / `n` (mapped to WebP's play count, 0 = infinite).
- `encodeApngAnim({ frames, width, height, frameDurations, cnum, loop })` →
  `Uint8Array`. `UPNG.encode` (`cnum` = lossy colour count, `0` = lossless); loop set
  via `patchApng`.
- `patchWebp(bytes, delayMs, loop)` / `patchApng(bytes, delayMs, loop)` rewrite
  per-frame duration + loop count **in place** (no re-encode), mirroring `patchGif`.
  WebP: ANMF duration (24-bit) + ANIM loop count (16-bit), no checksum. APNG: fcTL
  `delay_num`/`delay_den` (den fixed to 1000 → ms) + acTL `num_plays`, **recomputing
  each touched chunk's CRC32**. `applyMetadata` dispatches by `variant.format`
  (GIF delays are centiseconds; WebP/APNG use ms = `delayCs × 10`).
- The WebP wasm resolves via `import.meta.url` (preserve `codec/enc/` layout); the
  glue's bare `wasm-feature-detect` import is resolved by an import map in
  `index.html`. UPNG.js + pako are classic scripts loaded as `window.UPNG`/`window.pako`
  **before** the module (pako first).

## Features (current)

### Workflow (step tabs)
The UI is organised as a non-linear step bar: **Source → Trim → Crop & size →
Style → Logo → Export**. Every step is always clickable (editing isn't linear).
The video **preview is persistent** above the tabs (the `#stage` panel); only the
control panels switch. (Video-only tool — the images path was removed.)

### Layout (wide-screen two-column editor)
The preview stage (`#stage`) and the per-step controls (`.step-pane`s) are wrapped
in an `.editor` (`#editor`) element. By default (and on phones) `.editor` is a plain
block, so the preview stacks **above** the active controls (the original single
column). At **≥820px** `.editor` becomes a **CSS grid**: the preview stage in
**column 1** and the active step's controls in **column 2** (`grid-template-columns:
minmax(0,1fr) minmax(360px,440px)`). All `.step-pane`s share column 2 / row 1 (only
one is ever un-hidden), so the controls sit **beside** the preview instead of below
it — letting the short steps fit a 720px-tall viewport and reclaiming the old empty
side margins.
- The page (`.wrap`) widens to `--maxw-editor` (1240px) **at ≥820px** and to **1500px
  at ≥1500px** (a second `@media` step); the step bar, `#vibe`, `details.about` and the
  legal footer stay centred at `--maxw` (880px) so they don't look stranded. Raising the
  cap on big monitors lets the *preview column* grow instead of leaving dead outer
  margin (1920×1080 side margins drop from ~340px to ~210px).
- `#stage` is `position:sticky; top:12px` so the frame stays visible while a taller
  controls column (Style) scrolls.
- **Preview sizing is HEIGHT-driven on wide screens** so it upscales past the source's
  native pixel width and fills its (wide) column instead of rendering small and
  left-aligned with ~220px dead space to its right: `#preview-canvas{height:min(56vh,460px);
  width:auto;max-width:100%}` (a 3:2 video → ~605×403 at 1280×720, ~690×460 at 1920;
  `max-width:100%` reins in a portrait video by reducing its height). The wrap is
  `width:fit-content; margin-inline:auto` so it **hugs the canvas** and centres it —
  critical because the crop box (`#crop-rect`) is absolutely positioned in **% of the
  wrap**, so wrap==canvas keeps the box exactly aligned at any size. The canvas backing
  store is unchanged (`previewSize()`, capped 854px); CSS only scales the displayed size,
  so upscaling stays crisp. On phones / single-column the preview still stacks above the
  controls and is capped at `42vh` (and `44vh` under `@media (max-height:760px) and
  (max-width:819px)` — scoped to <820px because shrinking the *sticky* preview on the
  wide layout doesn't help the separate control column).
- **One-screen density (≥820px).** Crop and Style were the only steps overflowing 720px;
  both are packed denser **only** in the wide block:
  - *Crop:* `.controls` 2-up, per-field `.hint`s hidden, nudge d-pad keys shrunk to 26px
    with 2px gaps, the oval-mask label shortened. The second controls block (aspect + the
    two nudge pads + Reset) is re-flowed as `grid-template-columns:auto auto 1fr` with the
    aspect select spanning the full top row and the two compact d-pads + the (shortened
    "Reset crop") button on the row below — collapsing it from ~227px to ~130px. Crop pane
    overflow: +419 → ~+8px.
  - *Style:* the Input/Colormap/Colour-filter selects are 2-up with their hints hidden;
    the two 256² tone-curve / output-histogram canvases are kept **side by side**
    (`.curve-row{flex-wrap:nowrap}`, `.curve-col{flex:1 1 0;min-width:0}`) and capped at
    `max-height:144px` (instead of stacking into a ~1040px tower); the intro line, curve
    header gaps and toggles are tightened. Style pane overflow: +677 → ~+2px.
- The `.step-pane`s deliberately do **NOT** use `overflow:auto` in the grid — the
  colormap combobox dropdown (`.combo-list`) is absolutely positioned and would be
  clipped. Density reductions + the preview cap keep panes within the viewport; only
  the heaviest step (Style) needs a little page scroll.
- **Export-focus / before-load fallback:** when `#stage` is `[hidden]` (no video yet)
  or `.collapsed` (results shown), `#editor:has(...)` drops the grid to a single
  column and the pane/results span full width (so output GIFs aren't cramped). Uses
  the CSS `:has()` selector (fine for this modern static page).
- **Export CTA** ("Create GIF" / "Start over") is wrapped in `.action-row`, pinned
  `position:sticky; bottom:0` at the bottom of the Export pane on wide screens so the
  primary action stays reachable.
- The Style help text moved into a `<details class="help-details">` ("How the tone
  curve & colormaps work"), and `#curve-canvas`/`#hist-out` are capped at 240px, so
  the heaviest pane is much shorter.
- **Header band tightened on short screens (`@media (max-height:760px)`)** — the
  `.wrap`'s top/bottom padding is cut to 16px and the step bar slimmed so the
  *editor itself* fits a 720px viewport. The About & license `<details>` and legal
  footer are **kept visible** below the editor (they were briefly `display:none`'d
  here to force zero page-scroll, but that made the About/license unreachable on
  short windows); a collapsed About is small, so they're reached with a short
  scroll and the license stays accessible.
- **Crop / Output number inputs no longer clip.** In the narrow ~50px `.fg-grid`
  cells the native number spinner ate the right edge so 3-digit values (480, 320)
  showed as "4:" / "3:". `.fg-item input[type=number]` now drops the spinner
  (`appearance:textfield` + `::-webkit-outer/inner-spin-button{appearance:none}`) and
  uses tighter, centred padding, so the full digits are readable in the same cell.
- **1920×1080:** the editor cap is `min(1760px, 95vw)` at ≥1500px (was 1500px) and the
  controls column grows there too (`minmax(380px,520px)`, was 440px), so the recovered
  width feeds *both* columns. Side margins drop from ~210px to ~80px each side; the
  preview is 690×460 and the crop box stays pixel-aligned.
- **Short-screen results grid (post-encode):** capped 3-up
  (`@media (min-width:820px) and (max-height:760px)`) with `.result-card img/canvas
  {max-height:230px}` so all three variants + their Download buttons review within
  roughly one screen after Create GIF.
- **Post-encode Export two-column layout (round 4, the round-3 one-screen failure).**
  After Create GIF, `#stage` gets `.collapsed` and the generic
  `#editor:has(#stage.collapsed){grid-template-columns:1fr}` fallback dropped the
  page to one column, stacking the export controls + "Your GIFs" + three ~363px
  cards + the `#vibe` promo to ~1125px (≈405px past the 720px fold — the Download
  buttons sat below the fold). Under `@media (min-width:820px) and (max-height:760px)`
  this is overridden: the editor keeps two columns and the **export pane itself
  becomes a grid** (`grid-template-areas: "head head" / "result controls" /
  "result status"`, `grid-template-columns: minmax(0,1fr) minmax(320px,400px)`) so
  the **three GIF cards + their Download buttons fill the wide LEFT column** (cards
  capped `max-height:200px`) while FPS/Quality/Timing/Speed/Looping (`.controls`
  2-up) + the Create/Start-over `.action-row` + the status sit in the narrow right
  column. The `.action-row` reverts from `position:sticky` to `static` here (no
  longer pinned, since the two columns balance). Measured post-encode scrollHeight
  === 720 (was 1125), Download buttons at y≈557, 0 overflow. The collapsed `#stage`
  stays `display:block` (decode `<video>` rendered) and occupies no space.
- **#vibe promo slimmed on the short Export screen.** It was the tallest contributor
  below the editor; on `@media (max-height:760px)` it becomes a single centred flex
  row (heading + Star button, both promo `<p>`s `display:none`), ~68px instead of
  ~161px. **Important:** the flex rule is `.vibe:not([hidden])` — a bare
  `display:flex` on `.vibe` would override the `[hidden]` attribute's `display:none`
  (`#vibe` is only un-hidden after a GIF is generated) and add ~77px to *every*
  step. Same `[hidden]`-override gotcha already documented for `.field[hidden]`.
- **Trim right column balance (round 4).** The Trim controls pane is short (Set
  start/end + cut buttons + one paragraph); on the wide grid it is
  `display:flex;flex-direction:column;justify-content:center` so its controls sit
  level with the middle of the preview instead of floating at the top of an empty
  column (~270px of dead height beside a 567px preview).
- **Symmetric gutter at 1280 (round 4).** `.wrap{max-width:min(--maxw-editor,96vw)}`
  (was a flat `--maxw-editor`=1240). At 1280×720 the wrap is 1229px with **26px
  symmetric side margins** (was capped at 1240 → a one-sided 40px right gutter);
  the ≥1500px override (`min(1760px,95vw)`) is unaffected so 1920 still has 80px
  symmetric margins.
- **Source pre-load dropzone as hero (round 4).** Before a video is chosen the
  Source pane's dashed dropzone is `min-height:300px; display:flex; justify-content:
  center` so the call-to-action fills the panel and the empty first screen looks
  intentional rather than the dropzone occupying only the top third.

### Responsive / touch layout
Optimized for phones (iPhone-first) as well as desktop:
- **Phones keep the single column** (the `.editor` grid is gated behind
  `@media (min-width:820px)` only — never applied ≤640px), so the touch layout is not
  regressed. The densest panes are packed tighter: **Crop & Style `.controls` go
  2-up** at ≤640px, `.field-groups` stay 2-up, the **results-grid is 2-up** (130px
  card previews), and the step bar is more compact.
- `.controls` collapse to **one column at ≤640px** (verbose labels/inputs no
  longer overflow).
- **Phone one-screen-fit pass (≤640px).** The single-column stack puts the preview
  above the controls, so the densest steps are shortened: the two tone-curve canvases
  go **side by side** on phone too (was a ~360px vertical tower; `.curve-row` nowrap +
  horizontal arrow, capped 120px); the **GIF-pixel nudge pad is hidden** (one
  source-px pad kept — exact entry still via the Output-size fields); the logo dropzone
  is shrunk; the preview cap is `38vh`; and the About & license details + legal footer
  are **hidden once a video is loaded** (`.wrap:has(#stage:not([hidden]))`). On the
  **Export** step the preview stage's visible UI collapses *before* encoding
  (`#editor:has(.step-pane[data-pane="export"]:not([hidden]))` → hide `#preview-wrap`/
  `.transport`/`.timeline`; the `<video>` decode-source is a *sibling* of
  `#preview-wrap`, never `display:none`, so iOS extraction is unaffected) so FPS /
  Quality / Create GIF sit near the top. Net phone scrollHeight: source 992 / trim 906
  / crop 1295 / style 1244 / logo 1104 / **export 844** (was 1161/1030/1568/1725/1371/
  1177). This collapse-on-export is **CSS-only and scoped to ≤640px**; the wide
  two-column layout keeps the preview visible since its controls already sit beside it.
- **iPhone density pass (round 4, ≤640px).** The single-column stack puts the
  ~450px `#stage` (preview + transport + timeline) above the controls — the root
  cause of every editing step overflowing 844px. Mitigations: stage chrome slimmed
  (`#stage{padding:10px;margin-bottom:12px}`, `.tl-track{height:40px}`,
  `.timeline{padding:4px 0}`, tighter `.transport`), freeing ~150px of controls
  above the fold; the preview is capped **32vh on Crop/Style/Logo** and **40vh on
  Trim** (the one step where the timeline IS the primary control) via
  `#editor:has(.step-pane[data-pane="…"]:not([hidden])) #preview-canvas`; the
  desktop **crop reflow is ported to mobile** (Aspect spans the row, then the kept
  source-px d-pad + Reset below, hints hidden, d-pad keys 30×28, tighter
  field-groups / crop-info) — crop box stays % of `#preview-wrap` so it remains
  pixel-aligned with the canvas; the verbose Trim help paragraph is hidden and the
  cut buttons flow tighter; Logo Position/Size go 2-up; Style per-field hints
  dropped. Net iPhone scrollHeight (small synthetic video): trim 906→**844 (fits)**,
  logo 1104→887, style 1244→1106, crop 1295→1161, export **844 (fits)**. The
  residual Crop/Style overflow is inherent to the stacked single column; the clean
  fix is a JS "hide preview" toggle reusing `#stage.collapsed`, deferred to keep JS
  risk-free.
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
- **Frame-by-frame** stepping (buttons + ← / → keys); step = `1 / fps`. On the
  **compressed steps (after Trim)** stepping is done in *output time* (`stepFrame`
  → `toOutputTime`/`fromOutputTime`), so it **skips cut sections** — stepping past
  a cut jumps straight to the next kept frame and the timecode/frame counter stay
  continuous, exactly as the final GIF plays. On Source/Trim it steps in real time
  (you're still defining the cuts there, so the full timeline is shown).
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
  to move; "Reset crop" restores the full frame. Nudge d-pads: **Fine**
  (1 source px) always shown, and **GIF-pixel** (1 output px = `crop.w/finalW`
  source px — useful when the source is much higher-res than the GIF) which only
  appears under **Custom resolution** (`#gif-nudge-field`, hidden otherwise);
  with native output a GIF pixel equals a source pixel so it would duplicate the
  Fine pad. (It is also still hidden on phones regardless, via the CSS reflow.)
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
- **Native output by default**: the GIF keeps the cropped image's native pixel
  size — `finalW/finalH` track `crop.w/crop.h` (1:1, no downscale). The
  **"Custom resolution"** checkbox (`#custom-res`, off by default) reveals the
  "Output size" W/H block (`#output-size-group`, hidden otherwise) to override the
  resolution; while it's off the output always follows the cropped native shape,
  and unchecking it snaps the output back to native (`syncFinalToCrop` /
  `afterCropChange` force native when `!customRes`; enabling it seeds the inputs
  from the current native size, or a 480px-wide cap on a fresh load).
- Exact numeric entry in **both spaces**: crop X/Y/W/H in source px, and final
  W/H in output px (custom resolution only; final follows the crop aspect).
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
- **Three output formats, three size/quality tiers each.** The Export step has
  **three "Create" buttons** — Create GIF / Create WebP / Create APNG
  (`FORMATS`/`FORMAT_ORDER`). A single click runs `generateFormat(fmt)`, which
  encodes that format's three tiers and shows them under a format heading
  (`.result-group` + `.rc-group-head`). **Only the latest format is shown** — each
  Create first `clearResultVariants()`s the previous results (revoking their blobs),
  so you see just the three sizes of the format you last created, never all nine at
  once. (Switching formats reuses the cached frames; no re-extract.)
- **The three tiers per format** (`VARIANT_DEFS`, shared `fpsDiv`/`qMul`):
  1. **High quality** — full fps & quality.
  2. **Medium** — half the frame rate (`frames.filter((_,i)=>i%2===0)`), same quality.
  3. **High compression** — half the frame rate **and** lower quality (smallest).
  Each format maps the tier to its own quality knob (`FORMATS[fmt].quality`):
  GIF/WebP use 1–100 (`round(Q·qMul)`); APNG uses a lossy colour-count ladder
  (`0` lossless / `256` / `64`). Tiers that subsample below 2 frames, or that
  duplicate another tier's (frame-count, quality) pair, are skipped.
- **Frame extraction is shared & cached** (`cachedFrames`): the first Create
  extracts every frame once at full rate; subsequent format clicks at the same
  settings **reuse** that set (no re-extract). `markStale()` (any frame-affecting
  edit) clears the cache + all results.
- Each variant is a `.result-card` (preview, label, meta, **Download** named
  `<source>-<key>.<ext>` — `.gif`/`.webp`/`.png`). Frame *rate* (sampling) and
  quality genuinely need a re-encode; that's why a format's three tiers are
  produced up front in one pass.
- **Fullscreen viewer (lightbox)**: clicking a result thumbnail opens `#lightbox`
  — a fixed full-viewport overlay (checkerboard backing so transparent oval-masked
  GIFs read correctly) showing that GIF with a toolbar: **Full screen** (default —
  scales to fill the viewport preserving aspect, upscaling small GIFs so you can
  focus on the output), **True size** (native 1:1 pixels, scrolls if larger),
  **Download**, and **Close**. Close via the button, the backdrop, or `Esc`; while
  open, the video keyboard shortcuts are suppressed.
- **Metadata patching**: each variant's base animation is encoded once at 1× /
  infinite loop; changing timing or loop rewrites every variant's per-frame delays
  + loop count **in place**, dispatched by format (`patchGif` / `patchWebp` /
  `patchApng` via `patchVariant`), then `refreshResultCards` updates the cards — no
  re-encode, **across all shown formats**. In **duration** mode each variant's delay
  is `totalDuration / its own frame count`, so all variants share the same total
  runtime despite different frame counts. Any change that alters the actual frames
  (`markStale()`) invalidates all variants + the frame cache so the next Create
  re-encodes. Card `<img>`/links are updated in place (not rebuilt) on metadata
  patches so a mid-load image is never stranded when its old blob URL is revoked.

### Privacy / about
- A privacy **tagline above the source dropzone** (`.tagline`): "No data is
  transmitted; all encoding happens on your device." + an "Open source on GitHub"
  link (no AGPL wording here — the license stays in the collapsed About + footer).
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
- `window.__webpTest(opts)` / `window.__apngTest(opts)` encode synthetic frames
  (with a transparent quadrant by default, to exercise the alpha path) and assert
  the container is valid (`RIFF…WEBP`; PNG signature + `acTL`) and that
  `patchWebp`/`patchApng` round-trip the timing/loop (APNG with recomputed CRCs).
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
- Very long/large videos extract slowly (sequential seeks) and use lots of RAM.
  Extraction holds every frame as RGBA (`w·h·4` bytes), so a hi-res source (e.g. a
  3072² microscopy video × ~60 frames ≈ 2.3 GB) overflows the browser's allocation
  limit. **Pre-flight guard:** `checkExportBudget(fps)` estimates `frames ×
  outW × outH × 4` from `plannedFrameCount` + `plannedOutputSize`; above
  `FRAME_BYTES_LIMIT` (~1.2 GB) `generateFormat` aborts *before* extracting and
  shows guidance (enable **Custom resolution** at a suggested ~400 MB-equivalent
  size, or crop tighter / lower FPS / trim) instead of crashing. The `catch` also
  maps any allocation error that slips through to the same actionable message.
- Possible additions: drag-to-reorder image frames, per-frame durations, crop
  **rectangle** (spatial), brightness/contrast sliders, auto-capping the default
  output resolution for huge sources (today it's native-by-default + the pre-flight
  guard), optional multi-thread build behind COOP/COEP if ever self-hosted.

## Adding sibling tools

Each new tool gets its own folder under `/tools/<name>/` with a raw
(front-matter-free) `index.html` + module JS, reuses `../assets/tools.css`, and
adds a card to `/tools/index.html`. Vendor any WASM locally and document its
license the same way.
