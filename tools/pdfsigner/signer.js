/* PDF Signer — place a signature image and text on a PDF, offline.
 *
 * Two libraries, vendored, no CDN:
 *   PDF.js   renders each page to a <canvas> so you can see what you're signing
 *   pdf-lib  writes the stamps into the page content and re-serialises the file
 *
 * COORDINATES
 * -----------
 * Every placement is stored in "display points": the origin is the top-left of
 * the page *as you see it on screen* (i.e. after the page's own /Rotate has
 * been applied), y grows downwards, and one unit is one PDF point. That makes
 * the on-screen SVG overlay a pure `viewBox` scale — zooming changes nothing
 * about the stored numbers — and leaves exactly one conversion to get right:
 * display points -> PDF user space, in `makeMapper()` at export time.
 */

import * as pdfjsLib from './vendor/pdfjs/pdf.min.js';
import {
  PDFDocument, StandardFonts, PDFName, rgb, degrees,
} from './vendor/pdf-lib/pdf-lib.esm.min.js';

/* ------------------------------------------------------------------ *
 * PDF.js setup — everything it fetches lazily lives beside us.
 * ------------------------------------------------------------------ */
const vurl = (p) => new URL('./vendor/pdfjs/' + p, import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = vurl('pdf.worker.min.js');

const PDFJS_OPTS = {
  cMapUrl: vurl('cmaps/'),
  cMapPacked: true,
  standardFontDataUrl: vurl('standard_fonts/'),
  iccUrl: vurl('iccs/'),
  wasmUrl: vurl('wasm/'),
  isEvalSupported: false,   // no scripted forms; keeps the parser boring
};

/* ------------------------------------------------------------------ *
 * Constants
 * ------------------------------------------------------------------ */
const PT_PER_IN = 72;
const MAX_SIG_PX = 1200;          // signature images are downscaled to this
const MAX_CANVAS_PX = 24e6;       // per rendered page, keeps memory sane
const KEEP_RENDERED = 24;         // rendered pages retained before recycling
const LINE_RATIO = 1.2;           // text leading, multiples of font size
const ZOOMS = [0.25, 0.4, 0.55, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const LS_ASSETS = 'pdfsigner.assets.v1';
const LS_TEXT = 'pdfsigner.textdefaults.v1';

const FAMILIES = {
  helvetica: {
    label: 'Helvetica',
    css: '"Helvetica Neue", Helvetica, Arial, sans-serif',
    fonts: [StandardFonts.Helvetica, StandardFonts.HelveticaBold,
            StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  },
  times: {
    label: 'Times',
    css: '"Times New Roman", Times, serif',
    fonts: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold,
            StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  },
  courier: {
    label: 'Courier',
    css: '"Courier New", Courier, monospace',
    fonts: [StandardFonts.Courier, StandardFonts.CourierBold,
            StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
  },
};
const styleIndex = (it) => (it.bold ? 1 : 0) + (it.italic ? 2 : 0);
const fontKeyOf = (it) => FAMILIES[it.family].fonts[styleIndex(it)];

/* ------------------------------------------------------------------ *
 * State
 * ------------------------------------------------------------------ */
const S = {
  fileName: '',
  bytes: null,            // original PDF bytes, kept pristine for export
  doc: null,              // PDF.js document
  task: null,             // its loading task, which owns the worker
  pages: [],              // see openPdf()
  encrypted: false,
  assets: [],             // signature images
  items: [],              // placements
  hasForm: false,         // document carries an AcroForm
  fields: [],             // one entry per visible widget, in display points
  fieldValues: {},        // fully-qualified field name -> current value
  fieldOriginals: {},     // the same, as the file was opened
  sel: null,              // selected item id
  armed: null,            // {kind:'image', assetId} | {kind:'text', text}
  editingAsset: null,     // asset id shown in the clean-up panel
  zoom: 1,
  fitting: true,
  undo: [],
  redo: [],
  dirty: false,           // placements changed since the last save
  textDefaults: { family: 'helvetica', bold: false, italic: false, size: 14, color: '#111111' },
};

/* Font metrics come from pdf-lib itself, embedded into a throwaway document.
 * Using the *same* numbers on screen and at export is what keeps the preview
 * honest: the baseline lands where the ruler says it will. */
const metrics = {};   // 'helvetica:0' -> {ascent, descent, widthOf(text,size)}
let charSet = null;   // code points the standard fonts can actually encode

/* ------------------------------------------------------------------ *
 * Tiny helpers
 * ------------------------------------------------------------------ */
const $ = (id) => document.getElementById(id);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const uid = () => Math.random().toString(36).slice(2, 10);
const NS = 'http://www.w3.org/2000/svg';

function sv(tag, attrs, parent) {
  const el = document.createElementNS(NS, tag);
  for (const k in attrs) if (attrs[k] != null) el.setAttribute(k, String(attrs[k]));
  if (parent) parent.appendChild(el);
  return el;
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0x111111;
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

function loadImage(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('That image could not be decoded by this browser.'));
    img.src = src;
  });
}

function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.onerror = () => rej(fr.error || new Error('Could not read that file.'));
    fr.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------ *
 * Font metrics
 * ------------------------------------------------------------------ */
async function loadMetrics() {
  const doc = await PDFDocument.create();
  for (const fam of Object.keys(FAMILIES)) {
    for (let i = 0; i < 4; i++) {
      const f = await doc.embedFont(FAMILIES[fam].fonts[i]);
      const ascent = f.heightAtSize(1000, { descender: false }) / 1000;
      const full = f.heightAtSize(1000) / 1000;
      metrics[fam + ':' + i] = {
        ascent,
        descent: full - ascent,
        widthOf: (text, size) => {
          try { return f.widthOfTextAtSize(text, size); } catch { return text.length * size * 0.5; }
        },
      };
      if (!charSet) charSet = new Set(f.getCharacterSet());
    }
  }
}

const metricsOf = (it) => metrics[it.family + ':' + styleIndex(it)];

/** Bounding box of a text item, in display points. */
function textBox(it) {
  const m = metricsOf(it);
  const lines = String(it.text ?? '').split('\n');
  const lead = it.size * LINE_RATIO;
  let w = 0;
  for (const ln of lines) w = Math.max(w, m.widthOf(ln, it.size));
  return {
    lines, lead, m,
    w: Math.max(w, it.size * 0.4),
    h: (lines.length - 1) * lead + (m.ascent + m.descent) * it.size,
  };
}

/** Every item, image or text, exposes the same x/y/w/h rectangle. */
function boxOf(it) {
  if (it.type === 'text') { const b = textBox(it); return { x: it.x, y: it.y, w: b.w, h: b.h }; }
  return { x: it.x, y: it.y, w: it.w, h: it.h };
}

/* Characters outside the standard-font encoding cannot be written at all;
 * pdf-lib throws rather than dropping them. Report them while typing. */
function badChars(text) {
  if (!charSet) return [];
  const bad = new Set();
  for (const ch of String(text)) {
    if (ch === '\n' || ch === '\r') continue;
    if (!charSet.has(ch.codePointAt(0))) bad.add(ch);
  }
  return [...bad];
}
const sanitize = (text) => {
  let n = 0;
  const out = [...String(text)].map((ch) => {
    // Line breaks are structure, not glyphs — a multiline field keeps them.
    if (ch === '\n' || ch === '\r') return ch;
    if (charSet && !charSet.has(ch.codePointAt(0))) { n++; return '?'; }
    return ch;
  }).join('');
  return { out, n };
};

/* ------------------------------------------------------------------ *
 * Undo / redo — placements are small, so snapshots beat a command log.
 * ------------------------------------------------------------------ */
function snapshot() {
  S.undo.push(JSON.stringify(S.items));
  if (S.undo.length > 60) S.undo.shift();
  S.redo.length = 0;
  S.dirty = true;
}
function restore(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(S.items));
  S.dirty = true;
  S.items = JSON.parse(from.pop());
  if (!S.items.some((i) => i.id === S.sel)) S.sel = null;
  drawAllOverlays();
  syncInspector();
}

/* ------------------------------------------------------------------ *
 * Opening a PDF
 * ------------------------------------------------------------------ */

/** Swapping documents throws away every placement, so ask first. */
function tryOpenPdf(file) {
  if (S.items.length &&
      !confirm(`Open ${file.name}? The ${S.items.length} placement` +
               `${S.items.length > 1 ? 's' : ''} on the current document will be discarded.`)) return;
  openPdf(file);
}

async function openPdf(file) {
  const status = $('open-status');
  status.textContent = 'Opening ' + file.name + '…';
  let bytes;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
    // PDF.js takes ownership of (and detaches) the buffer it is given, so hand
    // it a copy and keep our own for pdf-lib at export time.
    const task = pdfjsLib.getDocument({ data: bytes.slice(), ...PDFJS_OPTS });
    const doc = await task.promise;

    S.fileName = file.name;
    S.bytes = bytes;
    // Tear the previous document down only once the new one has parsed, so a
    // failed open leaves the current document on screen and usable.
    if (S.task) S.task.destroy();
    S.task = task;
    S.doc = doc;
    S.items = [];
    S.sel = null;
    S.armed = null;
    S.undo = []; S.redo = [];
    S.dirty = false;
    S.pages = [];

    // One cheap call answers "is there a form at all?" — and for the great
    // majority of documents the answer is no, so nothing else is paid for.
    S.hasForm = false;
    S.fields = []; S.fieldValues = {}; S.fieldOriginals = {};
    try { S.hasForm = !!(await doc.getFieldObjects()); } catch { S.hasForm = false; }

    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const vp = page.getViewport({ scale: 1 });
      S.pages.push({
        num: n, page,
        dispW: vp.width, dispH: vp.height,
        el: null, canvas: null, svg: null,
        renderedZoom: 0, task: null, lastSeen: 0,
      });
      if (S.hasForm) await collectFields(page, vp, n);
    }
    S.fieldOriginals = { ...S.fieldValues };
  } catch (err) {
    console.error(err);
    status.innerHTML = '<span style="color:var(--danger)">' +
      (err && err.name === 'PasswordException'
        ? 'That PDF is password-protected. Open it in a viewer, print it back to PDF without the password, and try again.'
        : 'Could not open that PDF: ' + (err && err.message ? err.message : err)) + '</span>';
    return;
  }

  status.textContent = '';
  $('landing').hidden = true;
  $('app').hidden = false;
  document.body.classList.add('editing');
  $('doc-name').querySelector('b').textContent = S.fileName;
  $('doc-meta').textContent = S.doc.numPages + (S.doc.numPages === 1 ? ' page' : ' pages');
  $('doc-warn').hidden = true;
  $('save-status').textContent = '';

  syncFormSection();
  buildPageElements();
  fitZoom();
  checkEncryption();
}

/* pdf-lib cannot decrypt, so an encrypted file would be re-serialised into
 * something no reader can open. Find out now, not after 20 minutes of work. */
async function checkEncryption() {
  S.encrypted = false;
  try {
    const probe = await PDFDocument.load(S.bytes, { ignoreEncryption: true, updateMetadata: false });
    S.encrypted = !!probe.isEncrypted;
  } catch (err) {
    console.warn('pdf-lib could not pre-parse this document', err);
    S.encrypted = true;
  }
  if (S.encrypted) {
    const w = $('doc-warn');
    w.hidden = false;
    w.textContent = 'This PDF carries encryption or permission restrictions, which this tool ' +
      'cannot rewrite — saving is disabled. Open it in a PDF viewer, print it back ' +
      'to a fresh PDF, and sign that copy.';
    $('btn-save').disabled = true;
  } else {
    $('btn-save').disabled = false;
  }
}

/* ------------------------------------------------------------------ *
 * Page elements, rendering, zoom
 * ------------------------------------------------------------------ */
let pageObserver = null;

function buildPageElements() {
  const list = $('pagelist');
  list.textContent = '';
  if (pageObserver) pageObserver.disconnect();

  for (const p of S.pages) {
    const wrap = document.createElement('div');
    wrap.className = 'pagewrap';
    wrap.dataset.page = p.num;

    const label = document.createElement('span');
    label.className = 'plabel';
    label.textContent = 'Page ' + p.num;
    wrap.appendChild(label);

    const cv = document.createElement('canvas');
    wrap.appendChild(cv);

    const svg = sv('svg', {
      class: 'ov', viewBox: `0 0 ${p.dispW} ${p.dispH}`, preserveAspectRatio: 'none',
    }, wrap);

    p.el = wrap; p.canvas = cv; p.svg = svg;
    p.renderedZoom = 0;
    svg.addEventListener('pointerdown', (ev) => onPagePointerDown(ev, p));
    if (S.hasForm) buildFieldLayer(p, wrap);
    list.appendChild(wrap);
  }

  pageObserver = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const p = S.pages[Number(e.target.dataset.page) - 1];
      if (!p) continue;
      p.visible = e.isIntersecting;
      if (e.isIntersecting) { p.lastSeen = performance.now(); renderPage(p); }
    }
    recyclePages();
    updatePageIndicator();
  }, { root: $('pagescroll'), rootMargin: '300px 0px' });

  for (const p of S.pages) pageObserver.observe(p.el);
  applyZoom();
}

function applyZoom() {
  for (const p of S.pages) {
    p.el.style.width = Math.round(p.dispW * S.zoom) + 'px';
    p.el.style.height = Math.round(p.dispH * S.zoom) + 'px';
    p.renderedZoom = 0;           // canvases are now the wrong resolution
    if (p.visible) renderPage(p);
  }
  // Field controls are sized in percentages, so they scale for free; only
  // their text needs the zoom, which they read from this custom property.
  $('pagelist').style.setProperty('--z', S.zoom);
  $('zoom-val').textContent = Math.round(S.zoom * 100) + '%';
  drawAllOverlays();
}

/* Fit the whole page, not just its width: placing a signature is mostly a
 * question of "where on this page", which you can't answer while scrolling. */
function fitZoom() {
  const sc = $('pagescroll');
  const availW = sc.clientWidth - 34;
  const availH = sc.clientHeight - 52;
  const widest = S.pages.reduce((m, p) => Math.max(m, p.dispW), 1);
  const tallest = S.pages.reduce((m, p) => Math.max(m, p.dispH), 1);
  S.fitting = true;
  S.zoom = clamp(Math.min(availW / widest, availH / tallest), 0.1, 3);
  applyZoom();
}

function stepZoom(dir) {
  S.fitting = false;
  const cur = S.zoom;
  const next = dir > 0
    ? ZOOMS.find((z) => z > cur + 1e-3)
    : [...ZOOMS].reverse().find((z) => z < cur - 1e-3);
  if (next) { S.zoom = next; applyZoom(); }
}

async function renderPage(p) {
  const want = S.zoom;
  if (p.renderedZoom === want || p.busy) return;
  p.busy = true;
  try {
    if (p.task) { try { p.task.cancel(); } catch { /* already done */ } p.task = null; }

    const dpr = window.devicePixelRatio || 1;
    let scale = want * dpr;
    const px = p.dispW * scale * p.dispH * scale;
    if (px > MAX_CANVAS_PX) scale *= Math.sqrt(MAX_CANVAS_PX / px);

    const vp = p.page.getViewport({ scale });
    p.canvas.width = Math.max(1, Math.round(vp.width));
    p.canvas.height = Math.max(1, Math.round(vp.height));

    // With a form present, keep widget annotations off the canvas — the live
    // controls above the page are the only copy of a field's value that should
    // be visible. Without one, render exactly as before.
    p.task = p.page.render({
      canvas: p.canvas,
      viewport: vp,
      annotationMode: S.hasForm ? pdfjsLib.AnnotationMode.ENABLE_FORMS : undefined,
    });
    await p.task.promise;
    p.task = null;
    p.renderedZoom = want;
    p.lastSeen = performance.now();
  } catch (err) {
    if (!err || err.name !== 'RenderingCancelledException') console.error('render page ' + p.num, err);
  } finally {
    p.busy = false;
  }
}

/* Long documents: drop the pixels of pages nobody is looking at. */
function recyclePages() {
  const total = S.pages.filter((p) => p.renderedZoom).length;
  if (total <= KEEP_RENDERED) return;
  const cold = S.pages.filter((p) => p.renderedZoom && !p.visible)
    .sort((a, b) => a.lastSeen - b.lastSeen);
  for (const p of cold.slice(0, total - KEEP_RENDERED)) {
    p.canvas.width = p.canvas.height = 1;
    p.renderedZoom = 0;
  }
}

function updatePageIndicator() {
  const sc = $('pagescroll').getBoundingClientRect();
  const mid = sc.top + sc.height / 2;
  let best = 1, bestD = Infinity;
  for (const p of S.pages) {
    const r = p.el.getBoundingClientRect();
    const d = Math.abs(r.top + r.height / 2 - mid);
    if (d < bestD) { bestD = d; best = p.num; }
  }
  $('page-ind').textContent = 'Page ' + best + ' of ' + S.pages.length;
}

/* ------------------------------------------------------------------ *
 * AcroForm fields
 *
 * PDF.js is asked to leave widget annotations off the canvas
 * (`AnnotationMode.ENABLE_FORMS`) and we render our own controls over the
 * page instead — otherwise the value baked into the widget's appearance
 * stream would show through underneath whatever the user types.
 *
 * Field geometry comes straight from the page viewport, so it lands in the
 * same display-point space as everything else. A widget on a rotated page is
 * sized with its *logical* (unrotated) width and height and then spun about
 * its centre, which is what keeps the text reading the right way round.
 * ------------------------------------------------------------------ */

const FIELD_FLAG_EDIT = 1 << 18;   // Ch: combo box accepts typed-in values

async function collectFields(page, vp, num) {
  let anns = [];
  try { anns = await page.getAnnotations({ intent: 'display' }); } catch { return; }

  for (const a of anns) {
    if (a.subtype !== 'Widget' || a.hidden || a.noHTML) continue;
    if (a.pushButton) continue;                      // an action, not a value

    const [ax, ay] = vp.convertToViewportPoint(a.rect[0], a.rect[1]);
    const [bx, by] = vp.convertToViewportPoint(a.rect[2], a.rect[3]);
    const lw = Math.abs(a.rect[2] - a.rect[0]);
    const lh = Math.abs(a.rect[3] - a.rect[1]);

    const kind = a.fieldType === 'Sig' ? 'sig'
      : a.checkBox ? 'checkbox'
      : a.radioButton ? 'radio'
      : a.fieldType === 'Ch' ? (a.combo ? 'combo' : 'list')
      : a.multiLine ? 'multiline'
      : a.fieldType === 'Tx' ? 'text'
      : null;
    if (!kind) continue;

    const f = {
      page: num, name: a.fieldName || '', kind,
      x: Math.min(ax, bx), y: Math.min(ay, by),
      w: Math.abs(bx - ax), h: Math.abs(by - ay),
      lw, lh,
      // /R turns the widget anticlockwise within the page; the page's own
      // /Rotate turns everything clockwise on screen.
      rot: (vp.rotation - (a.rotation || 0) + 360) % 360,
      readOnly: !!a.readOnly,
      maxLen: a.maxLen > 0 ? a.maxLen : 0,
      align: a.textAlignment,
      // A field whose /DA asks for size 0 is "auto": pdf-lib would then grow
      // the text until it fills the box, so a two-word note in a big box comes
      // out enormous. Pick a readable size instead, and write that same size
      // into the saved file so the preview is not a lie.
      fontSize: a.defaultAppearanceData?.fontSize > 0
        ? a.defaultAppearanceData.fontSize
        : clamp(Math.min(12, lh * (a.multiLine ? 0.9 : 0.62)), 6, 12),
      fontName: a.defaultAppearanceData?.fontName || 'Helvetica',
      options: (a.options || []).map((o) => ({
        value: o.exportValue ?? o.displayValue, label: o.displayValue ?? o.exportValue,
      })),
      multiSelect: !!a.multiSelect,
      editable: !!(a.fieldFlags & FIELD_FLAG_EDIT),
      buttonValue: a.buttonValue,       // radio: this widget's export value
      exportValue: a.exportValue,       // checkbox: its "on" value
    };
    S.fields.push(f);

    if (f.name && !(f.name in S.fieldValues)) {
      const v = a.fieldValue;
      // A checkbox is on when its value matches the widget's own export value;
      // that name is only "Yes" by convention, and /Off is the only reserved one.
      S.fieldValues[f.name] =
        kind === 'checkbox' ? (v != null && v !== 'Off' &&
          (f.exportValue == null || String(v) === String(f.exportValue)))
        : kind === 'radio' ? (v == null || v === 'Off' ? null : String(v))
        : kind === 'combo' || kind === 'list' ? (Array.isArray(v) ? v.map(String) : v == null ? [] : [String(v)])
        : v == null ? '' : String(v);
    }
  }
}

/**
 * The size a field's text will actually be written at.
 *
 * Starts from the document's own intent — the /DA size, or a readable default
 * where /DA says "auto" — and shrinks only as far as it must for the value to
 * fit the box. Without this, a value longer than the field's font allows is
 * silently clipped when the appearance is regenerated, which loses part of
 * what the user typed. Shrinking is applied to the preview and written into
 * the saved file, so the two always agree.
 */
function fitFontSize(f, text) {
  const max = f.fontSize;
  if (!text) return max;
  const fam = /times/i.test(f.fontName) ? 'times' : /cour|mono/i.test(f.fontName) ? 'courier' : 'helvetica';
  const m = metrics[fam + ':0'];
  if (!m) return max;

  const innerW = Math.max(4, f.lw - 4);
  const innerH = Math.max(4, f.lh - 2);
  const fits = (size) => {
    if (f.kind !== 'multiline') {
      return m.widthOf(text, size) <= innerW && (m.ascent + m.descent) * size <= innerH;
    }
    let lines = 0;
    for (const para of text.split('\n')) {
      lines++;
      let line = '';
      for (const word of para.split(/(\s+)/)) {
        const next = line + word;
        if (line && m.widthOf(next, size) > innerW) { lines++; line = word.trimStart(); }
        else line = next;
      }
    }
    return lines * size * LINE_RATIO <= innerH;
  };

  let size = max;
  while (size > 4 && !fits(size)) size -= 0.5;
  return Math.max(4, size);
}

function buildFieldLayer(p, wrap) {
  const fields = S.fields.filter((f) => f.page === p.num);
  if (!fields.length) return;
  const layer = document.createElement('div');
  layer.className = 'fieldlayer';

  for (const f of fields) {
    const el = makeFieldControl(f, p);
    if (!el) continue;
    // Positioned by centre so the rotation of a widget on a rotated page turns
    // about the middle of the box rather than dragging it off across the page.
    el.style.left = ((f.x + f.w / 2) / p.dispW * 100) + '%';
    el.style.top = ((f.y + f.h / 2) / p.dispH * 100) + '%';
    el.style.width = (f.lw / p.dispW * 100) + '%';
    el.style.height = (f.lh / p.dispH * 100) + '%';
    el.style.transform = `translate(-50%, -50%) rotate(${f.rot}deg)`;
    layer.appendChild(el);
  }
  wrap.appendChild(layer);
  p.fieldLayer = layer;
}

function makeFieldControl(f, p) {
  // PDF.js paints read-only widgets onto the canvas even in ENABLE_FORMS mode
  // (they aren't interactive, so there's nothing to hand to an HTML layer).
  // Adding our own control on top would draw the value a second time.
  if (f.readOnly) return null;

  if (f.kind === 'sig') {
    const d = document.createElement('div');
    d.className = 'sigfield';
    d.textContent = 'Signature field';
    d.title = 'A signature field. Stamp your signature over it, then save.';
    return d;
  }

  // Exactly the size the saved file will use — see fitFontSize().
  const size = fitFontSize(f, String(S.fieldValues[f.name] ?? ''));

  let el;
  if (f.kind === 'checkbox' || f.kind === 'radio') {
    el = document.createElement('input');
    el.type = f.kind === 'checkbox' ? 'checkbox' : 'radio';
    if (f.kind === 'radio') { el.name = 'fld:' + f.name; el.value = f.buttonValue ?? ''; }
    el.checked = f.kind === 'checkbox'
      ? !!S.fieldValues[f.name]
      : S.fieldValues[f.name] === f.buttonValue;
    el.addEventListener('change', () => {
      setFieldValue(f.name, f.kind === 'checkbox' ? el.checked : f.buttonValue);
    });
  } else if (f.kind === 'combo' || f.kind === 'list') {
    el = document.createElement('select');
    const cur = S.fieldValues[f.name] || [];
    if (f.kind === 'list') {
      el.multiple = true;
      el.size = Math.max(2, Math.round(f.lh / Math.max(8, size * 1.25)));
    }
    if (f.kind === 'combo') el.appendChild(new Option('—', ''));
    for (const o of f.options) el.appendChild(new Option(o.label, o.value, false, cur.includes(o.value)));
    // A value the file carries that isn't in the option list (editable combo)
    // would otherwise vanish the moment the page is drawn.
    for (const v of cur) {
      if (!f.options.some((o) => o.value === v)) el.appendChild(new Option(v, v, false, true));
    }
    el.addEventListener('change', () => {
      setFieldValue(f.name, [...el.selectedOptions].map((o) => o.value).filter((v) => v !== ''));
    });
  } else {
    el = document.createElement(f.kind === 'multiline' ? 'textarea' : 'input');
    if (f.kind !== 'multiline') el.type = 'text';
    el.value = S.fieldValues[f.name] ?? '';
    if (f.maxLen) el.maxLength = f.maxLen;
    if (f.align === 1) el.style.textAlign = 'center';
    if (f.align === 2) el.style.textAlign = 'right';
    el.addEventListener('input', () => {
      setFieldValue(f.name, el.value);
      // Shrink live, the way the saved appearance will.
      el.style.setProperty('--fs', fitFontSize(f, el.value));
    });
  }

  el.style.setProperty('--fs', size);
  el.dataset.field = f.name;
  if (f.name) el.title = f.name;
  return el;
}

/** One value per field name, mirrored into every widget that shows it. */
function setFieldValue(name, value) {
  S.fieldValues[name] = value;
  S.dirty = true;
  for (const el of document.querySelectorAll(`.fieldlayer [data-field="${CSS.escape(name)}"]`)) {
    if (el.type === 'checkbox') el.checked = !!value;
    else if (el.type === 'radio') el.checked = el.value === value;
    else if (el.tagName === 'SELECT') {
      const want = value || [];
      for (const o of el.options) o.selected = want.includes(o.value);
    } else if (el.value !== value) el.value = value;
  }
  updateFormCount();
}

function syncFormSection() {
  const on = S.hasForm && S.fields.length > 0;
  $('form-section').hidden = !on;
  const warn = $('form-warn');
  warn.hidden = true;
  if (!on) return;
  if (S.doc?.isPureXfa) {
    warn.hidden = false;
    warn.textContent = 'This is an XFA form. Its fields can be filled here only if it also ' +
      'carries a classic AcroForm; otherwise fill it in Acrobat first, then sign the result.';
  }
  updateFormCount();
}

function updateFormCount() {
  const names = new Set(S.fields.filter((f) => f.kind !== 'sig' && !f.readOnly).map((f) => f.name));
  const locked = new Set(S.fields.filter((f) => f.readOnly).map((f) => f.name)).size;
  const sigs = S.fields.filter((f) => f.kind === 'sig').length;
  const filled = [...names].filter((n) => {
    const v = S.fieldValues[n];
    return Array.isArray(v) ? v.length : typeof v === 'boolean' ? v : String(v ?? '').length > 0;
  }).length;
  $('form-count').textContent =
    `${names.size} fillable field${names.size === 1 ? '' : 's'}, ${filled} filled` +
    (locked ? ` · ${locked} read-only` : '') +
    (sigs ? ` · ${sigs} signature field${sigs === 1 ? '' : 's'} outlined on the page` : '');
}

function resetFields() {
  S.fieldValues = { ...S.fieldOriginals };
  for (const p of S.pages) {
    if (p.fieldLayer) { p.fieldLayer.remove(); p.fieldLayer = null; }
    if (S.hasForm) buildFieldLayer(p, p.el);
  }
  updateFormCount();
}

/* ------------------------------------------------------------------ *
 * Signature assets
 * ------------------------------------------------------------------ */
async function addAssetFromFile(file) {
  let dataUrl;
  try {
    dataUrl = await fileToDataUrl(file);
    const img = await loadImage(dataUrl);

    // Downscale on the way in: a 12-megapixel phone photo of a signature is
    // 12 megapixels of paper. 1600px is still ~5 inches at 300 dpi.
    const big = Math.max(img.naturalWidth, img.naturalHeight);
    let hasAlpha = false;
    const c = document.createElement('canvas');
    const k = big > MAX_SIG_PX ? MAX_SIG_PX / big : 1;
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0, c.width, c.height);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { hasAlpha = true; break; }

    const asset = {
      id: uid(),
      name: file.name ? file.name.replace(/\.[^.]+$/, '').slice(0, 40) : 'Signature',
      src: c.toDataURL('image/png'),
      // A photo or scan has no alpha, so its white paper needs knocking out.
      // A PNG that already has transparency is left exactly as authored.
      bg: !hasAlpha, thr: 62, ink: 'original', trim: true,
    };
    await processAsset(asset);
    S.assets.push(asset);
    saveAssets();
    renderAssetGrid();
    armImage(asset.id);
    if (!hasAlpha) openAssetEditor(asset.id);
  } catch (err) {
    console.error(err);
    alert('Could not use that image: ' + (err && err.message ? err.message : err));
  }
}

/** Knock out the paper, recolour the ink, trim the margins. */
async function processAsset(a) {
  const img = await loadImage(a.src);
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0);

  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  const ink = a.ink === 'original' ? null : hexToRgb(a.ink);

  if (a.bg) {
    // Soft ramp rather than a hard cut, so anti-aliased pen edges survive:
    // luminance at/above `hi` is paper, at/below `lo` is solid ink.
    const hi = a.thr / 100;
    const lo = Math.max(0, hi - 0.35);
    const span = Math.max(1e-3, hi - lo);
    for (let i = 0; i < d.length; i += 4) {
      const L = (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255;
      const cover = clamp((hi - L) / span, 0, 1);
      d[i + 3] = Math.round(d[i + 3] * cover);
    }
  }
  if (ink) {
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] === 0) continue;
      d[i] = Math.round(ink.r * 255); d[i + 1] = Math.round(ink.g * 255); d[i + 2] = Math.round(ink.b * 255);
    }
  }
  ctx.putImageData(id, 0, 0);

  let out = c;
  if (a.trim) {
    let x0 = c.width, y0 = c.height, x1 = -1, y1 = -1;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        if (d[(y * c.width + x) * 4 + 3] > 12) {
          if (x < x0) x0 = x; if (x > x1) x1 = x;
          if (y < y0) y0 = y; if (y > y1) y1 = y;
        }
      }
    }
    if (x1 >= x0 && y1 >= y0 && (x1 - x0 + 1 < c.width || y1 - y0 + 1 < c.height)) {
      const pad = Math.round(Math.max(c.width, c.height) * 0.01);
      x0 = Math.max(0, x0 - pad); y0 = Math.max(0, y0 - pad);
      x1 = Math.min(c.width - 1, x1 + pad); y1 = Math.min(c.height - 1, y1 + pad);
      const t = document.createElement('canvas');
      t.width = x1 - x0 + 1; t.height = y1 - y0 + 1;
      t.getContext('2d').drawImage(c, x0, y0, t.width, t.height, 0, 0, t.width, t.height);
      out = t;
    }
  }

  const blob = await new Promise((r) => out.toBlob(r, 'image/png'));
  a.bytes = new Uint8Array(await blob.arrayBuffer());
  if (a.url) URL.revokeObjectURL(a.url);
  a.url = URL.createObjectURL(blob);
  a.w = out.width; a.h = out.height;
}

function renderAssetGrid() {
  const grid = $('siggrid');
  grid.textContent = '';
  for (const a of S.assets) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'sigtile' + (S.armed && S.armed.assetId === a.id ? ' armed' : '');
    tile.title = a.name + ' — click, then click the page to stamp';
    const img = document.createElement('img');
    img.src = a.url; img.alt = a.name;
    tile.appendChild(img);

    const gear = document.createElement('button');
    gear.type = 'button'; gear.className = 'gear'; gear.textContent = '⚙';
    gear.title = 'Clean-up settings';
    gear.addEventListener('click', (e) => { e.stopPropagation(); openAssetEditor(a.id); });
    tile.appendChild(gear);

    tile.addEventListener('click', () => {
      if (S.armed && S.armed.assetId === a.id) setArmed(null);
      else armImage(a.id);
    });
    grid.appendChild(tile);
  }

  const add = document.createElement('button');
  add.type = 'button'; add.className = 'sigadd';
  add.textContent = S.assets.length ? '+ Add image' : '+ Add signature image';
  add.addEventListener('click', () => $('file-sig').click());
  grid.appendChild(add);
}

function openAssetEditor(id) {
  const a = S.assets.find((x) => x.id === id);
  if (!a) return;
  S.editingAsset = id;
  $('asset-editor').hidden = false;
  $('a-name').value = a.name;
  $('a-bg').checked = a.bg;
  $('a-thr').value = a.thr;
  $('a-thr-row').hidden = !a.bg;
  $('a-ink').value = a.ink;
  $('a-trim').checked = a.trim;
}

async function reprocessEditedAsset() {
  const a = S.assets.find((x) => x.id === S.editingAsset);
  if (!a) return;
  a.name = $('a-name').value.trim() || 'Signature';
  a.bg = $('a-bg').checked;
  a.thr = Number($('a-thr').value);
  a.ink = $('a-ink').value;
  a.trim = $('a-trim').checked;
  $('a-thr-row').hidden = !a.bg;
  await processAsset(a);
  saveAssets();
  renderAssetGrid();
  drawAllOverlays();   // placements point at the new bitmap
}

function deleteAsset(id) {
  const a = S.assets.find((x) => x.id === id);
  if (!a) return;
  const used = S.items.filter((i) => i.assetId === id).length;
  if (used && !confirm(`Remove “${a.name}” and its ${used} placement${used > 1 ? 's' : ''}?`)) return;
  if (used) snapshot();
  S.items = S.items.filter((i) => i.assetId !== id);
  S.assets = S.assets.filter((x) => x.id !== id);
  if (a.url) URL.revokeObjectURL(a.url);
  if (S.armed && S.armed.assetId === id) setArmed(null);
  S.editingAsset = null;
  $('asset-editor').hidden = true;
  saveAssets();
  renderAssetGrid();
  drawAllOverlays();
  syncInspector();
}

/* Signatures live in localStorage so they're there tomorrow. The PDF never is. */
function saveAssets() {
  try {
    const slim = S.assets.map((a) => ({
      id: a.id, name: a.name, src: a.src, bg: a.bg, thr: a.thr, ink: a.ink, trim: a.trim,
    }));
    localStorage.setItem(LS_ASSETS, JSON.stringify(slim));
  } catch {
    $('sig-hint').textContent =
      'Your signatures are in use now, but there was no room to remember them for next time.';
  }
}

async function loadAssets() {
  let slim;
  try { slim = JSON.parse(localStorage.getItem(LS_ASSETS) || '[]'); } catch { return; }
  if (!Array.isArray(slim)) return;
  for (const a of slim) {
    try { await processAsset(a); S.assets.push(a); } catch (err) { console.warn('stored signature dropped', err); }
  }
  renderAssetGrid();
}

/* ------------------------------------------------------------------ *
 * Placement
 * ------------------------------------------------------------------ */
function setArmed(a) {
  S.armed = a;
  const bar = $('armbar');
  if (a) {
    bar.hidden = false;
    $('arm-text').textContent = a.kind === 'image'
      ? 'Click blank page to stamp “' + (S.assets.find((x) => x.id === a.assetId) || {}).name +
        '” — keep clicking to place it again. Stamps already on the page still drag.'
      : 'Click where the text should start.';
  } else {
    bar.hidden = true;
  }
  for (const p of S.pages) if (p.svg) p.svg.classList.toggle('placing', !!a);
  // While stamping, form controls stop swallowing clicks so a signature can be
  // dropped on top of a field (a "sign here" text box, typically).
  $('pagelist').classList.toggle('stamping', !!a);
  renderAssetGrid();
}
const armImage = (assetId) => setArmed({ kind: 'image', assetId });

/* Keep an item on the sheet. On placement nothing may hang over the edge; while
 * dragging, a sliver is allowed to stay grabbable but it can't be lost. */
function clampToPage(it, p, keep) {
  const b = boxOf(it);
  const slack = keep == null ? 0 : Math.max(0, Math.min(b.w, b.h) - keep);
  it.x = clamp(it.x, -slack, Math.max(-slack, p.dispW - b.w + slack));
  it.y = clamp(it.y, -slack, Math.max(-slack, p.dispH - b.h + slack));
}

function addImageAt(p, lx, ly, assetId) {
  const a = S.assets.find((x) => x.id === assetId);
  if (!a) return null;
  let w = Math.min(p.dispW * 0.22, p.dispW - 8);
  let h = w * (a.h / a.w);
  const maxH = p.dispH * 0.18;
  if (h > maxH) { h = maxH; w = h * (a.w / a.h); }
  const it = {
    id: uid(), type: 'image', page: p.num, assetId,
    x: lx - w / 2, y: ly - h / 2, w, h, rot: 0, opacity: 1,
  };
  clampToPage(it, p);
  snapshot();
  S.items.push(it);
  S.sel = it.id;
  return it;
}

function addTextAt(p, lx, ly, text) {
  const t = S.textDefaults;
  const it = {
    id: uid(), type: 'text', page: p.num,
    x: lx, y: ly, text: text || 'Text',
    family: t.family, bold: t.bold, italic: t.italic, size: t.size, color: t.color,
    rot: 0, opacity: 1,
  };
  const b = textBox(it);
  it.y = ly - b.h / 2;
  clampToPage(it, p);
  snapshot();
  S.items.push(it);
  S.sel = it.id;
  return it;
}

function copyToAllPages(it) {
  snapshot();
  const src = S.pages[it.page - 1];
  const box = boxOf(it);
  for (const p of S.pages) {
    if (p.num === it.page) continue;
    const copy = { ...it, id: uid(), page: p.num };
    // Same spot relative to the page, clamped so nothing lands off the sheet.
    copy.x = clamp(it.x * (p.dispW / src.dispW), 0, Math.max(0, p.dispW - box.w));
    copy.y = clamp(it.y * (p.dispH / src.dispH), 0, Math.max(0, p.dispH - box.h));
    S.items.push(copy);
  }
  drawAllOverlays();
  syncInspector();
}

/* ------------------------------------------------------------------ *
 * Overlay drawing
 * ------------------------------------------------------------------ */
function drawAllOverlays() { for (const p of S.pages) drawOverlay(p); }

function drawOverlay(p) {
  if (!p.svg) return;
  p.svg.textContent = '';
  const items = S.items.filter((i) => i.page === p.num);
  for (const it of items) drawItem(p, it);

  const sel = items.find((i) => i.id === S.sel);
  if (sel) drawSelection(p, sel);
}

function drawItem(p, it) {
  const b = boxOf(it);
  const g = sv('g', {
    'data-id': it.id,
    transform: it.rot ? `rotate(${it.rot} ${b.x + b.w / 2} ${b.y + b.h / 2})` : null,
  }, p.svg);

  if (it.type === 'image') {
    const a = S.assets.find((x) => x.id === it.assetId);
    const im = sv('image', {
      class: 'hit', x: b.x, y: b.y, width: b.w, height: b.h,
      preserveAspectRatio: 'none', opacity: it.opacity,
    }, g);
    if (a) im.setAttribute('href', a.url);
  } else {
    const tb = textBox(it);
    sv('rect', { class: 'hit', x: b.x, y: b.y, width: b.w, height: b.h, fill: 'transparent' }, g);
    const t = sv('text', {
      'font-family': FAMILIES[it.family].css,
      'font-size': it.size,
      'font-weight': it.bold ? 'bold' : 'normal',
      'font-style': it.italic ? 'italic' : 'normal',
      fill: it.color, opacity: it.opacity, 'pointer-events': 'none',
      'xml:space': 'preserve',
    }, g);
    tb.lines.forEach((ln, i) => {
      const w = tb.m.widthOf(ln, it.size);
      const ts = sv('tspan', {
        x: it.x, y: it.y + tb.m.ascent * it.size + i * tb.lead,
        // Pin each line to the width pdf-lib will actually write, so the
        // preview can't drift from the saved file just because the browser
        // substituted Arial for Helvetica.
        textLength: ln && w > 0 ? w : null,
        lengthAdjust: ln && w > 0 ? 'spacingAndGlyphs' : null,
      }, t);
      ts.textContent = ln || ' ';
    });
  }
}

function drawSelection(p, it) {
  const b = boxOf(it);
  const g = sv('g', {
    class: 'sel',
    transform: it.rot ? `rotate(${it.rot} ${b.x + b.w / 2} ${b.y + b.h / 2})` : null,
  }, p.svg);
  const sw = 1 / S.zoom;
  sv('rect', {
    class: 'selbox', x: b.x, y: b.y, width: b.w, height: b.h, 'stroke-width': sw * 1.5,
  }, g);
  const hs = clamp(9 / S.zoom, 3, 40);
  const corners = [['nw', b.x, b.y], ['ne', b.x + b.w, b.y], ['se', b.x + b.w, b.y + b.h], ['sw', b.x, b.y + b.h]];
  for (const [name, cx, cy] of corners) {
    sv('rect', {
      class: 'handle', 'data-handle': name, 'data-id': it.id,
      x: cx - hs / 2, y: cy - hs / 2, width: hs, height: hs,
      rx: hs * 0.2, 'stroke-width': sw,
      style: 'cursor:' + (name === 'nw' || name === 'se' ? 'nwse-resize' : 'nesw-resize'),
    }, g);
  }
}

/* ------------------------------------------------------------------ *
 * Pointer interaction
 * ------------------------------------------------------------------ */
function toLocal(p, ev) {
  const r = p.svg.getBoundingClientRect();
  return [
    (ev.clientX - r.left) / r.width * p.dispW,
    (ev.clientY - r.top) / r.height * p.dispH,
  ];
}

function onPagePointerDown(ev, p) {
  if (ev.button !== 0 && ev.pointerType === 'mouse') return;
  const [lx, ly] = toLocal(p, ev);

  // Something already on the page always wins, even mid-stamping run: the
  // cursor over a stamp says "move", so a drag there has to move that stamp
  // rather than drop a second one on top of it. Empty space is where new
  // stamps land, and the crosshair cursor marks exactly that.
  const handleEl = ev.target.closest('[data-handle]');
  if (handleEl) {
    const it = S.items.find((i) => i.id === handleEl.dataset.id);
    if (it) { ev.preventDefault(); beginDrag(ev, p, it, handleEl.dataset.handle, lx, ly, true); }
    return;
  }

  const itemEl = ev.target.closest('[data-id]');
  if (itemEl) {
    const it = S.items.find((i) => i.id === itemEl.dataset.id);
    if (it) {
      ev.preventDefault();
      S.sel = it.id;
      drawOverlay(p);
      syncInspector();
      beginDrag(ev, p, it, 'move', lx, ly, true);
      return;
    }
  }

  // Stamping mode: a click on bare page drops a copy, and dragging straight
  // away positions the copy you just dropped.
  if (S.armed) {
    ev.preventDefault();
    let it;
    if (S.armed.kind === 'image') {
      it = addImageAt(p, lx, ly, S.armed.assetId);
    } else {
      it = addTextAt(p, lx, ly, S.armed.text);
      setArmed(null);
      focusTextField();
    }
    if (!it) return;
    drawOverlay(p);
    syncInspector();
    if (it.type === 'image') beginDrag(ev, p, it, 'move', lx, ly, false);
    return;
  }

  if (S.sel) { S.sel = null; drawAllOverlays(); syncInspector(); }
}

function beginDrag(ev, p, it, mode, lx, ly, snapFirst) {
  const start = boxOf(it);
  const startText = it.type === 'text' ? { size: it.size } : null;
  let moved = false;
  const rad = (it.rot || 0) * Math.PI / 180;
  const cos = Math.cos(rad), sin = Math.sin(rad);
  const cx0 = start.x + start.w / 2, cy0 = start.y + start.h / 2;

  // Rotate a point about the item's centre, in display space (y down, so a
  // positive angle reads as clockwise, same as the SVG transform).
  const rot = (x, y) => [cx0 + (x - cx0) * cos - (y - cy0) * sin,
                         cy0 + (x - cx0) * sin + (y - cy0) * cos];

  // For a resize, the corner diagonally opposite stays nailed to the page.
  let anchor = null, sx = 1, sy = 1;
  if (mode !== 'move') {
    const ax = mode.includes('w') ? start.x + start.w : start.x;
    const ay = mode.includes('n') ? start.y + start.h : start.y;
    anchor = rot(ax, ay);
    sx = mode.includes('w') ? -1 : 1;
    sy = mode.includes('n') ? -1 : 1;
  }

  const move = (e) => {
    const [mx, my] = toLocal(p, e);
    if (!moved) {
      if (Math.abs(mx - lx) + Math.abs(my - ly) < 0.6) return;
      moved = true;
      if (snapFirst) snapshot();
    }
    if (mode === 'move') {
      it.x = start.x + (mx - lx);
      it.y = start.y + (my - ly);
      clampToPage(it, p, 14);
    } else {
      // Work in the item's own frame: undo the rotation, then measure.
      const dx = mx - anchor[0], dy = my - anchor[1];
      const lxx = (dx * cos + dy * sin) * sx;
      const lyy = (-dx * sin + dy * cos) * sy;
      const kx = Math.max(lxx, 4) / start.w;
      const ky = Math.max(lyy, 4) / start.h;
      // Signatures and text both keep their proportions; a stretched
      // signature is a forged-looking signature.
      const k = e.shiftKey ? Math.min(kx, ky) : Math.max(kx, ky);
      const nw = start.w * k, nh = start.h * k;
      if (it.type === 'text') {
        it.size = clamp(startText.size * k, 4, 288);
      } else {
        it.w = nw; it.h = nh;
      }
      const nb = boxOf({ ...it, x: 0, y: 0 });
      // Put the anchor corner back exactly where it was.
      const half = [sx > 0 ? nb.w / 2 : -nb.w / 2, sy > 0 ? nb.h / 2 : -nb.h / 2];
      const ncx = anchor[0] + half[0] * cos - half[1] * sin;
      const ncy = anchor[1] + half[0] * sin + half[1] * cos;
      it.x = ncx - nb.w / 2;
      it.y = ncy - nb.h / 2;
    }
    drawOverlay(p);
    syncInspectorNumbers();
  };

  const up = () => {
    p.svg.removeEventListener('pointermove', move);
    p.svg.removeEventListener('pointerup', up);
    p.svg.removeEventListener('pointercancel', up);
    try { p.svg.releasePointerCapture(ev.pointerId); } catch { /* fine */ }
  };
  try { p.svg.setPointerCapture(ev.pointerId); } catch { /* fine */ }
  p.svg.addEventListener('pointermove', move);
  p.svg.addEventListener('pointerup', up);
  p.svg.addEventListener('pointercancel', up);
}

/* ------------------------------------------------------------------ *
 * Inspector
 * ------------------------------------------------------------------ */
const selected = () => S.items.find((i) => i.id === S.sel) || null;

function syncInspector() {
  const it = selected();
  $('inspector').hidden = !it;
  if (!it) return;
  $('insp-title').textContent = it.type === 'text' ? 'Text box' : 'Signature stamp';
  $('insp-text').hidden = it.type !== 'text';
  $('insp-image').hidden = it.type !== 'image';

  if (it.type === 'text') {
    if ($('i-text').value !== it.text) $('i-text').value = it.text;
    $('i-font').value = it.family;
    $('i-size').value = Math.round(it.size * 10) / 10;
    $('i-bold').checked = it.bold;
    $('i-italic').checked = it.italic;
    $('i-color').value = it.color;
    updateCharWarning(it);
  }
  $('i-rot').value = it.rot || 0;
  $('i-op').value = Math.round((it.opacity ?? 1) * 100);
  syncInspectorNumbers();
}

/** Just the values that change while dragging. */
function syncInspectorNumbers() {
  const it = selected();
  if (!it) return;
  const b = boxOf(it);
  if (it.type === 'image') {
    $('i-w').value = (b.w / PT_PER_IN).toFixed(2);
    $('i-h').value = (b.h / PT_PER_IN).toFixed(2);
    $('i-mm').textContent = `= ${(b.w / PT_PER_IN * 25.4).toFixed(1)} × ${(b.h / PT_PER_IN * 25.4).toFixed(1)} mm`;
  } else {
    $('i-size').value = Math.round(it.size * 10) / 10;
  }
  $('i-where').textContent =
    `Page ${it.page} · ${(b.x / PT_PER_IN).toFixed(2)}″ from left, ${(b.y / PT_PER_IN).toFixed(2)}″ from top`;
}

function updateCharWarning(it) {
  const bad = badChars(it.text);
  const el = $('i-charwarn');
  el.hidden = bad.length === 0;
  if (bad.length) {
    el.textContent = 'The built-in PDF fonts can\'t write ' + bad.slice(0, 8).map((c) => '“' + c + '”').join(', ') +
      '. Those characters will be saved as “?”.';
  }
}

/* `key` coalesces a run of continuous edits — dragging a slider or typing into
 * the text box — into one undo step instead of one per event. */
let lastEdit = { key: null, at: 0 };
function editSelected(fn, key) {
  const it = selected();
  if (!it) return;
  const now = Date.now();
  const k = key ? it.id + ':' + key : null;
  if (!k || lastEdit.key !== k || now - lastEdit.at > 700) snapshot();
  lastEdit = { key: k, at: now };
  fn(it);
  drawOverlay(S.pages[it.page - 1]);
  syncInspectorNumbers();
}

function focusTextField() {
  const el = $('i-text');
  requestAnimationFrame(() => { el.focus(); el.select(); });
}

/* ------------------------------------------------------------------ *
 * Export
 * ------------------------------------------------------------------ */

/**
 * Build the display-points -> PDF-user-space mapper for one page.
 *
 * PDF.js shows the page's crop box with /Rotate applied; pdf-lib draws in
 * unrotated user space with the origin at the bottom-left of the media box.
 * `map(lx, ly)` bridges the two, and `dispW/dispH` are the on-screen page
 * dimensions in points as pdf-lib understands them.
 */
function makeMapper(page) {
  const mb = page.getMediaBox();
  const cb = page.getCropBox();
  const x0 = Math.max(mb.x, cb.x);
  const y0 = Math.max(mb.y, cb.y);
  const x1 = Math.min(mb.x + mb.width, cb.x + cb.width);
  const y1 = Math.min(mb.y + mb.height, cb.y + cb.height);
  const W = Math.max(1, x1 - x0);
  const H = Math.max(1, y1 - y0);
  const rot = ((Math.round(page.getRotation().angle / 90) * 90) % 360 + 360) % 360;
  const swap = rot === 90 || rot === 270;

  const map = (lx, ly) => {
    switch (rot) {
      case 90: return [x0 + ly, y0 + lx];
      case 180: return [x0 + W - lx, y0 + ly];
      case 270: return [x0 + W - ly, y0 + H - lx];
      default: return [x0 + lx, y0 + H - ly];
    }
  };
  return { map, dispW: swap ? H : W, dispH: swap ? W : H };
}

/**
 * Write the edited field values into the document, then optionally flatten.
 *
 * Flattening draws each field's appearance into the page content and drops the
 * field itself, which is what makes the saved copy un-editable. Every step is
 * defensive: a form this tool can't fully understand must still produce a
 * saved file with the signatures on it, so failures degrade to a note in the
 * status line rather than an aborted save.
 *
 * @returns a human-readable suffix for the save status
 */
function applyFormFields(doc) {
  let form, libFields;
  try {
    form = doc.getForm();
    // Resolve fields through pdf-lib's own list rather than getField(name).
    // A lookup by name walks a dotted hierarchy, which misreads any field
    // whose /T simply contains a dot.
    libFields = new Map(form.getFields().map((lf) => [lf.getName(), lf]));
  } catch (err) {
    console.warn('form not readable', err);
    return { note: ' — form fields could not be written', failed: 1 };
  }

  // Read-only fields are left exactly as the document author set them, and so
  // is anything the user didn't actually change — rewriting an untouched field
  // would regenerate its appearance for no reason.
  const byName = new Map();
  for (const f of S.fields) if (f.name && f.kind !== 'sig' && !f.readOnly) byName.set(f.name, f);

  let written = 0, failed = 0, subs = 0;
  const lost = [];
  for (const [name, f] of byName) {
    const value = S.fieldValues[name];
    if (JSON.stringify(value) === JSON.stringify(S.fieldOriginals[name])) continue;
    try {
      const lf = libFields.get(name);
      if (!lf) throw new Error('field not present in the document');
      switch (f.kind) {
        case 'checkbox': {
          if (value) lf.check(); else lf.uncheck();
          break;
        }
        case 'radio': {
          if (value) lf.select(value); else lf.clear();
          break;
        }
        case 'combo': {
          lf.setFontSize(fitFontSize(f, String((value || [])[0] ?? '')));
          const v = (value || [])[0];
          if (!v) { lf.clear(); break; }
          // An editable combo can hold text that was never an option.
          if (!lf.getOptions().includes(v)) lf.addOptions([v]);
          lf.select(v);
          break;
        }
        case 'list': {
          lf.setFontSize(f.fontSize);
          if (!value || !value.length) lf.clear(); else lf.select(value);
          break;
        }
        default: {
          const { out, n } = sanitize(String(value ?? ''));
          subs += n;
          lf.setFontSize(fitFontSize(f, out));
          lf.setText(out);
        }
      }
      written++;
    } catch (err) {
      failed++;
      lost.push(name);
      console.warn('could not write field "' + name + '"', err);
    }
  }

  // A field is drawn from its appearance stream, not from its value. Where
  // that stream can't be trusted, force pdf-lib to rebuild it from the value —
  // otherwise every field the user *didn't* touch keeps whatever the stream
  // holds, and for a form that left appearance generation to the viewer that
  // is nothing at all. This is what makes pre-filled entries survive the save.
  const needAppearances = String(form.acroForm.dict.lookup(PDFName.of('NeedAppearances'))) === 'true';
  for (const f of S.fields) {
    if (f.kind === 'sig' || !f.name) continue;
    const lf = libFields.get(f.name);
    if (!lf) continue;
    try {
      if (needAppearances || appearanceLooksBlank(lf)) form.markFieldAsDirty(lf.ref);
    } catch (err) {
      console.warn('could not refresh appearance for "' + f.name + '"', err);
    }
  }

  let flattened = false;
  if ($('in-flatten').checked) {
    try {
      form.flatten();
      flattened = true;
    } catch (err) {
      // Usually a field whose appearance references a font the file doesn't
      // carry. Keep the values that are already in place and flatten the rest.
      console.warn('flatten with appearance update failed, retrying', err);
      try {
        form.flatten({ updateFieldAppearances: false });
        flattened = true;
      } catch (err2) {
        console.warn('flatten failed', err2);
      }
    }
  }

  const bits = [];
  if (written) bits.push(`${written} field${written === 1 ? '' : 's'} written`);
  if (flattened) bits.push('flattened');
  else if ($('in-flatten').checked) bits.push('but could not be flattened — the form is still editable');
  if (subs) bits.push(`${subs} unsupported character${subs === 1 ? '' : 's'} in fields written as “?”`);
  return {
    note: bits.length ? ' · ' + bits.join(', ') : '',
    failed,
    // Naming them matters: a field that silently didn't make it into the saved
    // file is the difference between a signed document and a wrong one.
    lostNote: failed ? ` — could not write ${failed} field${failed === 1 ? '' : 's'}: ${lost.slice(0, 4).join(', ')}${lost.length > 4 ? '…' : ''}` : '',
  };
}

/** An appearance stream too small to draw anything — or missing outright. */
function appearanceLooksBlank(libField) {
  for (const widget of libField.acroField.getWidgets()) {
    let normal;
    try { normal = widget.getAppearances()?.normal; } catch { return true; }
    if (!normal) return true;
    // Checkboxes and radios keep a dictionary of per-state streams; those are
    // picked at flatten time and are fine.
    if (!normal.contents) continue;
    if (normal.contents.length <= 20) return true;
  }
  return false;
}

async function exportPdf() {
  if (S.encrypted) return;
  const btn = $('btn-save');
  const status = $('save-status');
  btn.disabled = true;
  status.textContent = 'Saving…';
  try {
    const doc = await PDFDocument.load(S.bytes, { updateMetadata: false });

    const images = new Map();   // assetId -> PDFImage, embedded once and reused
    const fonts = new Map();    // StandardFonts key -> PDFFont
    let replaced = 0;

    // Form fields first, so a flattened field's contents can never be painted
    // over a signature that was deliberately placed on top of it.
    const formResult = S.hasForm ? applyFormFields(doc) : { note: '', failed: 0, lostNote: '' };

    for (const it of S.items) {
      const page = doc.getPage(it.page - 1);
      if (!page) continue;
      const view = S.pages[it.page - 1];
      const { map, dispW, dispH } = makeMapper(page);
      // Guard against PDF.js and pdf-lib disagreeing about the page box: scale
      // rather than let a stamp slide off the edge.
      const kx = dispW / view.dispW;
      const ky = dispH / view.dispH;
      const k = (kx + ky) / 2;

      const b = boxOf(it);
      const x = b.x * kx, y = b.y * ky, w = b.w * k, h = b.h * k;
      const cx = x + w / 2, cy = y + h / 2;
      const rad = (it.rot || 0) * Math.PI / 180;
      const cos = Math.cos(rad), sin = Math.sin(rad);
      const spin = (px, py) => [cx + (px - cx) * cos - (py - cy) * sin,
                                cy + (px - cx) * sin + (py - cy) * cos];

      // The item's own axes, expressed in PDF user space: take its origin and
      // one unit along its local +x, map both, and read off the angle. That
      // covers page rotation and item rotation in one shot.
      const angleAt = (ox, oy) => {
        const [ux, uy] = map(ox, oy);
        const [ux2, uy2] = map(ox + cos, oy + sin);
        return { ux, uy, deg: Math.atan2(uy2 - uy, ux2 - ux) * 180 / Math.PI };
      };

      if (it.type === 'image') {
        const asset = S.assets.find((a) => a.id === it.assetId);
        if (!asset) continue;
        if (!images.has(asset.id)) images.set(asset.id, await doc.embedPng(asset.bytes));
        const [bx, by] = spin(x, y + h);            // bottom-left in display space
        const { ux, uy, deg } = angleAt(bx, by);
        page.drawImage(images.get(asset.id), {
          x: ux, y: uy, width: w, height: h,
          rotate: degrees(deg), opacity: it.opacity ?? 1,
        });
      } else {
        const key = fontKeyOf(it);
        if (!fonts.has(key)) fonts.set(key, await doc.embedFont(key));
        const font = fonts.get(key);
        const m = metricsOf(it);
        const size = it.size * k;
        const lead = size * LINE_RATIO;
        const col = hexToRgb(it.color);
        const lines = String(it.text ?? '').split('\n');
        lines.forEach((raw, i) => {
          const { out, n } = sanitize(raw);
          replaced += n;
          if (!out) return;
          const [bx, by] = spin(x, y + m.ascent * size + i * lead);   // baseline start
          const { ux, uy, deg } = angleAt(bx, by);
          page.drawText(out, {
            x: ux, y: uy, size, font,
            color: rgb(col.r, col.g, col.b),
            rotate: degrees(deg), opacity: it.opacity ?? 1,
          });
        });
      }
    }

    const out = await doc.save();
    const blob = new Blob([out], { type: 'application/pdf' });
    const name = S.fileName.replace(/\.pdf$/i, '') + '-signed.pdf';
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);

    S.dirty = false;
    const mb = (blob.size / 1048576).toFixed(blob.size > 1048576 ? 1 : 2);
    const line = `Saved ${name} (${mb} MB)` + formResult.note +
      (replaced ? ` — ${replaced} unsupported character${replaced > 1 ? 's' : ''} written as “?”` : '');
    status.textContent = line;
    if (formResult.failed) {
      status.textContent = '';
      status.append(line);
      const warn = document.createElement('span');
      warn.style.color = 'var(--danger)';
      warn.textContent = formResult.lostNote;
      status.appendChild(warn);
    }
  } catch (err) {
    console.error(err);
    status.innerHTML = '<span style="color:var(--danger)">Could not save: ' +
      (err && err.message ? err.message : err) + '</span>';
  } finally {
    btn.disabled = S.encrypted;
  }
}

/* ------------------------------------------------------------------ *
 * Wiring
 * ------------------------------------------------------------------ */
function wireLanding() {
  const drop = $('drop-pdf');
  const input = $('file-pdf');
  drop.addEventListener('click', (e) => { if (e.target !== input) input.click(); });
  input.addEventListener('change', () => { if (input.files[0]) tryOpenPdf(input.files[0]); input.value = ''; });

  for (const ev of ['dragenter', 'dragover']) {
    document.addEventListener(ev, (e) => {
      if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
      e.preventDefault();
      if (!$('landing').hidden) drop.classList.add('over');
    });
  }
  document.addEventListener('dragleave', () => drop.classList.remove('over'));
  document.addEventListener('drop', (e) => {
    const f = e.dataTransfer?.files?.[0];
    if (!f) return;
    e.preventDefault();
    drop.classList.remove('over');
    if (f.type === 'application/pdf' || /\.pdf$/i.test(f.name)) tryOpenPdf(f);
    else if (f.type.startsWith('image/') && !$('app').hidden) addAssetFromFile(f);
  });
}

function wireSidebar() {
  $('btn-open-other').addEventListener('click', () => $('file-pdf').click());

  const sig = $('file-sig');
  sig.addEventListener('change', () => { if (sig.files[0]) addAssetFromFile(sig.files[0]); sig.value = ''; });

  for (const id of ['a-name', 'a-bg', 'a-thr', 'a-ink', 'a-trim']) {
    const el = $(id);
    el.addEventListener(el.type === 'range' ? 'change' : 'input', reprocessEditedAsset);
  }
  $('a-done').addEventListener('click', () => { S.editingAsset = null; $('asset-editor').hidden = true; });
  $('a-delete').addEventListener('click', () => deleteAsset(S.editingAsset));

  $('btn-reset-fields').addEventListener('click', resetFields);
  $('in-flatten').addEventListener('change', () => { S.dirty = true; });

  $('btn-add-text').addEventListener('click', () => setArmed({ kind: 'text', text: 'Text' }));
  $('btn-add-date').addEventListener('click', () => setArmed({
    kind: 'text',
    text: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
  }));

  $('i-text').addEventListener('input', () => editSelected((it) => {
    it.text = $('i-text').value;
    updateCharWarning(it);
  }, 'text'));
  $('i-font').addEventListener('change', () => editSelected((it) => {
    it.family = $('i-font').value; S.textDefaults.family = it.family; saveTextDefaults();
  }));
  $('i-size').addEventListener('input', () => editSelected((it) => {
    it.size = clamp(Number($('i-size').value) || 14, 4, 288);
    S.textDefaults.size = it.size; saveTextDefaults();
  }, 'size'));
  $('i-bold').addEventListener('change', () => editSelected((it) => {
    it.bold = $('i-bold').checked; S.textDefaults.bold = it.bold; saveTextDefaults();
  }));
  $('i-italic').addEventListener('change', () => editSelected((it) => {
    it.italic = $('i-italic').checked; S.textDefaults.italic = it.italic; saveTextDefaults();
  }));
  $('i-color').addEventListener('input', () => editSelected((it) => {
    it.color = $('i-color').value; S.textDefaults.color = it.color; saveTextDefaults();
  }, 'color'));

  $('i-w').addEventListener('input', () => editSelected((it) => {
    if (it.type !== 'image') return;
    const a = S.assets.find((x) => x.id === it.assetId);
    const w = clamp((Number($('i-w').value) || 1) * PT_PER_IN, 4, 4000);
    if (a) it.h = w * (a.h / a.w);
    it.w = w;
  }, 'w'));
  $('i-h').addEventListener('input', () => editSelected((it) => {
    if (it.type !== 'image') return;
    const a = S.assets.find((x) => x.id === it.assetId);
    const h = clamp((Number($('i-h').value) || 1) * PT_PER_IN, 4, 4000);
    if (a) it.w = h * (a.w / a.h);
    it.h = h;
  }, 'h'));
  $('i-rot').addEventListener('input', () => editSelected((it) => {
    it.rot = Number($('i-rot').value) || 0;
  }, 'rot'));
  $('i-op').addEventListener('input', () => editSelected((it) => {
    it.opacity = clamp((Number($('i-op').value) || 100) / 100, 0.05, 1);
  }, 'op'));

  $('i-allpages').addEventListener('click', () => { const it = selected(); if (it) copyToAllPages(it); });
  $('i-dupe').addEventListener('click', duplicateSelected);
  $('i-center').addEventListener('click', () => editSelected((it) => {
    const p = S.pages[it.page - 1];
    it.x = (p.dispW - boxOf(it).w) / 2;
  }));
  $('i-del').addEventListener('click', deleteSelected);
}

function saveTextDefaults() {
  try { localStorage.setItem(LS_TEXT, JSON.stringify(S.textDefaults)); } catch { /* not important */ }
}

function duplicateSelected() {
  const it = selected();
  if (!it) return;
  snapshot();
  const p = S.pages[it.page - 1];
  const copy = { ...it, id: uid(), x: it.x + 14, y: it.y + 14 };
  copy.x = clamp(copy.x, 0, p.dispW - 8);
  copy.y = clamp(copy.y, 0, p.dispH - 8);
  S.items.push(copy);
  S.sel = copy.id;
  drawOverlay(p);
  syncInspector();
}

function deleteSelected() {
  const it = selected();
  if (!it) return;
  snapshot();
  S.items = S.items.filter((i) => i.id !== it.id);
  S.sel = null;
  drawOverlay(S.pages[it.page - 1]);
  syncInspector();
}

function wireStage() {
  $('zoom-in').addEventListener('click', () => stepZoom(1));
  $('zoom-out').addEventListener('click', () => stepZoom(-1));
  $('zoom-fit').addEventListener('click', fitZoom);
  $('btn-save').addEventListener('click', exportPdf);
  $('arm-stop').addEventListener('click', () => setArmed(null));
  $('pagescroll').addEventListener('scroll', updatePageIndicator, { passive: true });

  let rt;
  window.addEventListener('resize', () => {
    clearTimeout(rt);
    rt = setTimeout(() => { if (S.fitting && !$('app').hidden) fitZoom(); }, 150);
  });

  // Placements only exist in this tab. Closing it without saving loses them.
  window.addEventListener('beforeunload', (e) => {
    if (!S.items.length || !S.dirty) return;
    e.preventDefault();
    e.returnValue = '';
  });
}

function wireKeys() {
  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    const meta = e.metaKey || e.ctrlKey;

    if (meta && e.key.toLowerCase() === 's') {
      e.preventDefault();
      if (!$('app').hidden) exportPdf();
      return;
    }
    if (meta && e.key.toLowerCase() === 'z') {
      if (typing) return;
      e.preventDefault();
      if (e.shiftKey) restore(S.redo, S.undo); else restore(S.undo, S.redo);
      return;
    }
    if (meta && e.key.toLowerCase() === 'd') {
      if (typing || !selected()) return;
      e.preventDefault();
      duplicateSelected();
      return;
    }
    if (e.key === 'Escape') {
      if (S.armed) setArmed(null);
      else if (S.sel) { S.sel = null; drawAllOverlays(); syncInspector(); }
      return;
    }
    if (typing) return;

    if ((e.key === 'Delete' || e.key === 'Backspace') && selected()) {
      e.preventDefault();
      deleteSelected();
      return;
    }
    const nudge = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (nudge && selected()) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      editSelected((it) => {
        it.x += nudge[0] * step;
        it.y += nudge[1] * step;
        clampToPage(it, S.pages[it.page - 1], 14);
      }, 'nudge');
    }
  });

  // Pasting a signature straight from a screenshot or scanner app.
  document.addEventListener('paste', (e) => {
    if ($('app').hidden) return;
    if (/^(INPUT|TEXTAREA)$/.test(e.target.tagName)) return;
    for (const item of e.clipboardData?.items || []) {
      if (item.type.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) { e.preventDefault(); addAssetFromFile(f); }
        return;
      }
    }
  });
}

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */
async function main() {
  if (!('createObjectURL' in URL) || !window.IntersectionObserver || !document.createElement('canvas').getContext) {
    $('unsupported').hidden = false;
    $('unsupported-why').textContent = 'This browser is missing features the editor needs.';
    return;
  }
  wireLanding();
  wireSidebar();
  wireStage();
  wireKeys();

  try {
    const t = JSON.parse(localStorage.getItem(LS_TEXT) || 'null');
    if (t) Object.assign(S.textDefaults, t);
  } catch { /* defaults are fine */ }

  await loadMetrics();
  await loadAssets();
  renderAssetGrid();
}

main().catch((err) => {
  console.error(err);
  $('unsupported').hidden = false;
  $('unsupported-why').textContent = 'Failed to start: ' + (err && err.message ? err.message : err);
});
