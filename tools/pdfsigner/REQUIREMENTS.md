# PDF Signer — requirements & design notes

Last updated: 2026-08-05

A static, offline page that stamps a signature image and typed text onto a PDF
and writes the result back out. Lives at `/tools/pdfsigner/` on
hmaarrfk.github.io.

---

## 1. Purpose

Sign a PDF the way most people mean it: put a picture of your signature on the
page, in as many places as the document demands, add your printed name and the
date, and save a normal flat PDF.

Explicitly **not** a cryptographic/certificate-based digital signature. The page
says so in its own "Privacy, and what this tool is not" section — that
distinction should stay visible in any future revision.

## 2. Hard constraints

| Constraint | Why |
| --- | --- |
| No server, no upload, no network at run time | The documents people sign are contracts, offers, medical forms. They must never leave the machine. Everything is vendored; the page works with the network off. |
| No tracking, no analytics | Same reason. There is no third-party script of any kind on this page. |
| No build step | The site is plain Jekyll on GitHub Pages. Source files are served as authored. |
| No Jekyll front matter in `index.html` | Keeps Liquid away from the JavaScript, matching `gifmaker` and `videocompressor`. |
| The original PDF bytes are never mutated in place | Every save re-loads the pristine bytes, so saving twice produces the same file rather than double-stamping. |

## 3. Files

```
tools/pdfsigner/
  index.html          markup + editor-specific CSS (shared palette from /tools/assets/tools.css)
  signer.js           the whole application, one ES module
  REQUIREMENTS.md     this file
  vendor/
    update-vendor.sh  re-vendors both libraries from npm
    pdfjs/            pdf.min.js, pdf.worker.min.js, cmaps/, standard_fonts/, iccs/, wasm/
    pdf-lib/          pdf-lib.esm.min.js
```

Pinned versions: **pdfjs-dist 6.2.108**, **pdf-lib 1.17.1**. Both are re-vendored
by `vendor/update-vendor.sh` (keep the versions in that script and here in sync).

`.mjs` files are renamed to `.js` on the way in — GitHub Pages' MIME handling for
`.mjs` is unreliable, and both files are valid ES modules either way.

PDF.js side-car data is vendored deliberately:

- `standard_fonts/` — PDFs that reference Helvetica/Times/Courier without
  embedding them (extremely common) render with missing glyphs without it.
- `cmaps/` — predefined CJK character maps.
- `iccs/` — fallback CMYK profile.
- `wasm/` — JBIG2 / JPEG 2000 decoders and the qcms colour engine, which scanned
  documents lean on heavily. The `*_nowasm_fallback.js` shims and `quickjs-eval`
  are **not** vendored (no WebAssembly-less engines to support; scripted
  AcroForms are disabled via `isEvalSupported: false`).

## 4. The coordinate model

This is the part worth understanding before changing anything.

Every placement is stored in **display points**: origin at the top-left of the
page *as rendered on screen* (after the page's own `/Rotate`), y down, one unit
= one PDF point.

- The on-screen overlay is an SVG with `viewBox="0 0 dispW dispH"`, so zoom is a
  pure CSS scale and stored coordinates never change with zoom.
- Exactly one conversion exists, `makeMapper()` in `signer.js`, which turns a
  display point into PDF user space for a given page. It handles the crop
  box/media box intersection (origin offset) and all four `/Rotate` values.
- Item rotation composes with page rotation without a second case analysis: map
  the item's rotated bottom-left corner **and** one unit along its local +x, then
  read the angle off the difference. That angle goes straight into pdf-lib's
  `rotate:`, and the mapped corner is its `x`/`y`.

Verified end to end by round-tripping a synthetic 4-page document with
`/Rotate` 0/90/180/270: saved, re-opened, and the ink measured back to within a
fraction of a point of where the editor showed it — including with a rotated
item and a resized stamp.

Text uses **pdf-lib's own font metrics** on screen as well as at export
(`heightAtSize`/`widthOfTextAtSize` from a throwaway `PDFDocument`), and each
preview line is pinned with SVG `textLength` + `lengthAdjust="spacingAndGlyphs"`.
That is what stops the preview drifting from the saved file when the browser
substitutes Arial for Helvetica.

## 5. Features

**Document**
- Open by click or drop. Replacing a document with placements on it asks first.
- Whole-page fit by default, plus stepped zoom; pages render lazily via
  `IntersectionObserver` and off-screen canvases are recycled past
  `KEEP_RENDERED`.
- Encrypted / permission-restricted PDFs are detected at open time (pdf-lib's
  `isEncrypted`) and **saving is disabled** with an explanation. pdf-lib cannot
  decrypt, so writing one out would silently produce a broken file.

**Signature library**
- Add by file picker, drag-and-drop, or paste (⌘V) from the clipboard.
- Images are downscaled to `MAX_SIG_PX` (1200) on the long edge.
- Clean-up pass, per signature: knock out the white background (soft luminance
  ramp so anti-aliased pen edges survive), recolour the ink, trim empty margins.
  Background removal defaults **on** for images with no alpha channel (a photo or
  scan) and **off** for PNGs that already carry transparency.
- The library persists in `localStorage` (`pdfsigner.assets.v1`) as the
  downscaled source plus its clean-up settings, so the settings stay tunable
  later. **The PDF is never stored.**

**Placement**
- Click a signature to arm it, then click pages to stamp; it stays armed so a
  40-page document can be initialled quickly. Dragging straight after the click
  positions the copy just placed.
- Move by drag, resize from the corners (aspect always locked — a stretched
  signature looks forged), rotate and set opacity from the inspector, nudge with
  the arrow keys.
- **Copy to every page**, duplicate, centre across, delete.
- Text boxes: multi-line, Helvetica/Times/Courier × bold/italic, size in points,
  colour. "Add today's date" pre-fills one. Characters the standard fonts can't
  encode are flagged while typing and written as `?` (reported after saving)
  rather than throwing.
- Undo/redo over snapshots, with continuous edits (sliders, typing) coalesced
  into single steps.

**Saving**
- The image is embedded **once** and drawn at each placement, so stamping forty
  pages costs one copy of the bitmap.
- `updateMetadata: false` preserves the original document's metadata.
- Output is `<name>-signed.pdf`; `beforeunload` warns about unsaved placements.

## 6. Testing

Manual, in a browser, against `/tools/pdfsigner/` served statically:

1. **Rotation round trip** — build a 4-page PDF with `/Rotate` 0/90/180/270 and
   a 1-inch grid (see the script in this file's git history, or regenerate with
   pdf-lib). Stamp at a known display coordinate on each page, save, re-open the
   saved file, and confirm the ink lands at the same display coordinate. This is
   the regression test that matters; break `makeMapper()` and it fails loudly.
2. **Real document** — open a long, font-heavy, image-heavy PDF (a journal
   article works well). Confirm pages render, then save and open the result in a
   *different* engine (macOS Quick Look / Preview uses Quartz) to prove the file
   isn't merely PDF.js-readable.
3. **Photographed signature** — a dark scrawl on white with no alpha should come
   in with the background already knocked out and the margins trimmed.
4. **Persistence** — reload; the signature library should still be there and the
   document should not.

## 7. Ideas not built

- Draw-your-own signature with a pointer/trackpad.
- Checkbox / initial / "X" marks and a snap-to-signature-line helper.
- Filling AcroForm fields rather than drawing over them.
- Page-range placement ("pages 2–7") alongside "every page".
- A unit toggle (inches ⇄ mm) instead of showing mm as a hint.
