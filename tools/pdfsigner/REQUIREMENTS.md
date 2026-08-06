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

**Form fields (AcroForm)**
- Detected with one `getFieldObjects()` call at open time; documents without a
  form pay nothing and render exactly as they did before the feature existed.
- Pages are rendered with `AnnotationMode.ENABLE_FORMS`, which keeps PDF.js from
  painting widget appearances onto the canvas, and an HTML layer of real
  `<input>`/`<select>` controls is positioned over each widget instead.
  Otherwise the value baked into the appearance stream would show through
  underneath whatever the user types.
- **Read-only widgets are the exception**: PDF.js *does* paint those on the
  canvas (they aren't interactive, so there's nothing to hand to an HTML
  layer), so no control is created for them — one would draw the value twice.
  They're also never written on save.
- Signature (`Sig`) fields get a dashed marker rather than a control, and it is
  click-through, so a signature stamp can be dropped straight onto it.
- Widgets on rotated pages are sized with their *logical* (unrotated) width and
  height and then rotated about their centre by `pageRotation - widgetRotation`,
  which is what keeps the text reading the right way round.
- The control layer stops taking pointer events while stamping, so a signature
  can be placed on top of a field.
- **Font size** is the one place the tool doesn't simply obey the document. A
  `/DA` size of 0 means "auto", and pdf-lib's auto-sizing grows text until it
  fills the box — a two-word note in a big box comes out enormous. So: start
  from the `/DA` size (or a readable default when it says auto), then shrink
  only as far as needed for the value to fit, and write that size into the
  saved file with `setFontSize()`. Without the shrink, text longer than the
  field's font allows is silently clipped when the appearance is regenerated,
  which loses part of what the user typed. The same number drives the preview,
  live as you type, so the two can't disagree.
- Only fields whose value actually **changed** are written; untouched fields
  keep their original appearance streams.
- **A field is drawn from its appearance stream, not from its value** — and
  that stream cannot always be trusted. Plenty of real forms carry their
  entries only in `/V`, leave `/AP` empty, and set `/NeedAppearances true` to
  tell the viewer to build the appearance itself. Flattening such a file draws
  the empty stream, so every pre-filled entry the signer never touched
  disappears from the saved copy. Before flattening, any field whose appearance
  is missing, is too small to draw anything, or belongs to a document that sets
  `NeedAppearances`, is marked dirty so pdf-lib rebuilds it from the value.
  Fields with a good appearance stream keep it, which matters for comb fields
  and anything else pdf-lib would regenerate less faithfully than the author
  wrote it.
- Fields are resolved through pdf-lib's own `getFields()` list rather than
  `getField(name)`: a name lookup walks a dotted hierarchy, which misreads any
  field whose `/T` simply contains a dot. Anything that still can't be written
  is named in the save status, in red — a field that silently didn't make it
  into the saved file is the difference between a signed document and a wrong
  one.

**Saving**
- The image is embedded **once** and drawn at each placement, so stamping forty
  pages costs one copy of the bitmap.
- Form fields are written and flattened *before* the stamps are drawn, so a
  signature deliberately placed over a field can never end up underneath it.
- **Flatten on save** (default on) draws each field's appearance into the page
  and removes the field, so the saved copy can't be edited or cleared. It falls
  back to `flatten({ updateFieldAppearances: false })` and then to "no flatten"
  with a note in the status line — a form this tool can't fully understand must
  still produce a saved file with the signatures on it.
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
5. **Forms** — build a fixture with one of every field type (text, multiline,
   checkbox, radio group, dropdown, option list, read-only) plus a field on a
   rotated page. Fill them all, stamp a signature, save with flattening on, and
   check in an independent engine that every value is baked in, that
   `getForm().getFields()` on the result is **empty**, and that long text
   shrank to fit rather than being clipped. Then repeat with flattening off and
   confirm the fields are still present, carry the new values, and that fields
   you didn't touch were left alone.
6. **Pre-filled forms** — the regression that matters most. Build a form whose
   values live in `/V` with *empty* appearance streams and `NeedAppearances
   true` (create it, then blank every widget's `/AP` in a second pass and save
   with `updateFieldAppearances: false`, or pdf-lib quietly regenerates them
   and the fixture tests nothing). Fill in one field, save flattened, and check
   that the entries you never touched are still in the output. Before the fix
   for this, they all vanished.

**A warning about testing in a browser**: the default `python3 -m http.server`
lets Chrome cache `signer.js`, and bumping a `?v=` query on the page URL does
not bust it — a fix can look like it did nothing. Serve with `Cache-Control:
no-store` while testing, and prefer checking the file the browser actually
downloaded over one captured by patching `HTMLAnchorElement.prototype.click`.

## 7. Ideas not built

- Draw-your-own signature with a pointer/trackpad.
- Checkbox / initial / "X" marks and a snap-to-signature-line helper.
- XFA forms. `isPureXfa` is detected and warned about; filling one needs a
  completely different engine.
- Page-range placement ("pages 2–7") alongside "every page".
- A unit toggle (inches ⇄ mm) instead of showing mm as a hint.
- Per-field font control for forms whose `/DA` asks for something unusable.
