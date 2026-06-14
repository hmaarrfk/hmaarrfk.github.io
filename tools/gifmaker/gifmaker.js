// gifski in the browser.
//
// Decodes a video (via a scrubbable timeline editor) or a sequence of images
// into RGBA frames, optionally transforms them (change speed, rotate, flip,
// colour filter), then hands them to gifski (compiled to WebAssembly, vendored
// locally under ./vendor/) to produce a high-quality animated GIF. Nothing is
// uploaded: every byte stays in the page.
//
// The single-threaded gifski-wasm build is used deliberately — it needs no
// SharedArrayBuffer and therefore no COOP/COEP headers, which GitHub Pages
// cannot set. That keeps the whole tool a plain static page.

import encode from './vendor/dist/encode.js';
import { COLORMAPS, COLORMAP_ORDER } from './colormaps.js';

// ---- DOM ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const stepBtns    = document.querySelectorAll('.stepbtn');
const stepPanes   = document.querySelectorAll('.step-pane');
const stage       = $('stage');

const fileVideo   = $('file-video');
const fileImages  = $('file-images');
const dropAny     = $('drop-any');
const pickVideo   = $('pick-video');
const pickImages  = $('pick-images');
const preview     = $('preview');
const videoInfo   = $('video-info');
const thumbs      = $('thumbs');

const fpsInput    = $('fps');
const maxwInput   = $('maxw');
const qualityIn   = $('quality');
const qualityVal  = $('quality-val');
const speedSel    = $('speed');
const rotateSel   = $('rotate');
const flipSel     = $('flip');
const filterSel   = $('filter');
const colormapSearch = $('colormap-search');
const colormapList   = $('colormap-list');
const channelSel  = $('channel');
const loopSelect  = $('loop');
const timingMode  = $('timing-mode');
const durationSel = $('duration');
const durationCustom = $('duration-custom');
const fieldSpeed  = $('field-speed');
const fieldDuration = $('field-duration');

// Tone curve (contrast)
const curveCanvas    = $('curve-canvas');
const curveCtx       = curveCanvas.getContext('2d');
const histOut        = $('hist-out');
const histOutCtx     = histOut.getContext('2d');
const histLog        = $('hist-log');
const invertInput    = $('invert-input');
const reverseCmap    = $('reverse-colormap');
const curveReset     = $('curve-reset');
const stylePane      = document.querySelector('[data-pane="style"]');

// Logo / watermark
const fileLogo    = $('file-logo');
const dropLogo    = $('drop-logo');
const logoPos     = $('logo-pos');
const logoSize    = $('logo-size');
const logoSizeVal = $('logo-size-val');
const logoOpacity = $('logo-opacity');
const logoOpacityVal = $('logo-opacity-val');
const logoClear   = $('logo-clear');
const logoInfo    = $('logo-info');
const logoPreview = $('logo-preview');
const logoDropText = $('logo-drop-text');

const encodeBtn   = $('encode-btn');
const resetBtn    = $('reset-btn');
const progress    = $('progress');
const progressBar = progress.firstElementChild;
const status      = $('status');

const result      = $('result');
const resultImg   = $('result-img');
const resultMeta  = $('result-meta');
const downloadBtn = $('download-btn');

const scratchCanvas = $('scratch-canvas');
const previewCanvas = $('preview-canvas');
const previewCtx    = previewCanvas.getContext('2d');
const previewWrap   = $('preview-wrap');

// Crop UI
const cropRectEl  = $('crop-rect');
const cropAspect  = $('crop-aspect');
const cropXIn = $('crop-x'), cropYIn = $('crop-y'), cropWIn = $('crop-w'), cropHIn = $('crop-h');
const finalWIn = $('final-w'), finalHIn = $('final-h');
const cropReset = $('crop-reset');
const cropInfo  = $('crop-info');
const fieldMaxw = $('field-maxw');

// Offscreen canvas used to render the full transformed frame before cropping.
const fullCanvas = document.createElement('canvas');
const fullCtx    = fullCanvas.getContext('2d', { willReadFrequently: true });

// Timeline DOM
const timecode    = $('timecode');
const tlTrack     = $('tl-track');
const tlRegions   = $('tl-regions');
const handleIn    = $('handle-in');
const handleOut   = $('handle-out');
const playhead    = $('playhead');
const tlPending   = $('tl-pending');
const cutInfo     = $('cut-info');

// Inline SVG for the play/pause toggle (kept in JS so we can swap the shape).
const PLAY_SVG  = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"/></svg>';
const PAUSE_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z"/></svg>';

// ---- State -------------------------------------------------------------
let mode = 'video';          // 'video' | 'images'
let videoFile = null;        // File
let imageBitmaps = [];       // { bitmap, name }
let lastObjectUrl = null;    // result blob URL, revoked on reset

// Base encode (speed 1×, infinite loop) kept so speed/loop become instant
// metadata patches instead of a full re-encode. Invalidated when anything that
// affects the actual frames changes.
let lastBaseGif = null;      // Uint8Array of the base GIF
let baseDelayCs = 0;         // base per-frame delay in centiseconds (= 100/fps)
let baseInfo = null;         // { frames, w, h, fps }
function markStale() { lastBaseGif = null; }

// Timeline editing state (seconds)
let duration = 0;
let cropStart = 0;
let cropEnd = 0;
let cuts = [];               // [{start, end}] interior sections to drop, sorted
let pendingCutStart = null;  // armed by "Mark cut start"
let previewRaf = null;       // rAF handle for the live preview loop
let extracting = false;      // true while pulling frames, to skip preview draws

// Spatial crop. `crop` is in DISPLAYED (post-rotation/flip) source pixels; the
// output is that region scaled to (finalW × finalH).
let crop = null;             // {x, y, w, h} or null (= whole frame)
let aspectMode = 'orig';     // 'free' | 'orig' | '1:1' | '4:3' | ...
let finalW = 0, finalH = 0;
let lastRotation = 0;        // to transform the crop when rotation changes
let lastFlip = 'none';       // to mirror the crop when flip changes

// Logo / watermark overlay
let logoBitmap = null;       // ImageBitmap or null
let logoUrl = null;          // object URL for the dropzone preview

// Colormap selection (custom searchable combobox).
let colormapKey = 'none';

// Tone curve: control points {x,y} in 0..255 (input → output) + its 256 LUT.
let curvePoints = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
const curveLut = new Uint8Array(256);
let curveIdentity = true;
const inputHist = new Float32Array(256);
const outputHist = new Float32Array(256);

const PREVIEW_MAX = 854;     // cap the preview canvas backing store for smoothness

// Extra simple ramps (black → pure colour) — common for single-channel data.
function rampLut(a, b) {
  const lut = [];
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    lut.push([Math.round(a[0] + (b[0] - a[0]) * t),
              Math.round(a[1] + (b[1] - a[1]) * t),
              Math.round(a[2] + (b[2] - a[2]) * t)]);
  }
  return lut;
}
const EXTRA_CM = {
  'black-red':   { name: 'Black → Red',   lut: rampLut([0, 0, 0], [255, 0, 0]) },
  'black-green': { name: 'Black → Green', lut: rampLut([0, 0, 0], [0, 255, 0]) },
  'black-blue':  { name: 'Black → Blue',  lut: rampLut([0, 0, 0], [0, 0, 255]) },
};
// Friendlier display names for the single-hue ColorBrewer maps (light → colour).
const CM_NAME_OVERRIDE = { Reds: 'White → Red', Greens: 'White → Green', Blues: 'White → Blue' };

const ALL_CM = { ...COLORMAPS, ...EXTRA_CM };
const CM_ORDER = ['black-red', 'black-green', 'black-blue', ...COLORMAP_ORDER];
const CM_OPTIONS = [{ key: 'none', name: 'None' }].concat(
  CM_ORDER.map((k) => ({ key: k, name: CM_NAME_OVERRIDE[k] || ALL_CM[k].name })));

const FILTERS = {
  none:      'none',
  grayscale: 'grayscale(1)',
  sepia:     'sepia(1)',
  invert:    'invert(1)',
  contrast:  'contrast(1.5)',
  warm:      'sepia(0.35) saturate(1.4) hue-rotate(-15deg) brightness(1.05)',
  cool:      'saturate(1.2) hue-rotate(25deg) brightness(1.03)',
  vintage:   'sepia(0.5) contrast(1.1) brightness(1.1) saturate(1.3) hue-rotate(-10deg)',
};

// ---- Helpers -----------------------------------------------------------
function setStatus(msg, isError = false) {
  status.textContent = msg;
  status.classList.toggle('error', isError);
}
function setProgress(frac) {
  if (frac == null) { progress.classList.remove('show'); return; }
  progress.classList.add('show');
  progressBar.style.width = Math.round(frac * 100) + '%';
}
function humanSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}
function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
function fmtTime(t) {
  if (!isFinite(t)) t = 0;
  const m = Math.floor(t / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${m}:${s}`;
}
function captureFps() { return Math.max(1, parseInt(fpsInput.value, 10) || 15); }
function frameStep() { return 1 / captureFps(); }

function fitSize(srcW, srcH) {
  const cap = parseInt(maxwInput.value, 10) || 0;
  if (!cap || srcW <= cap) return { w: srcW, h: srcH };
  const scale = cap / srcW;
  return { w: Math.round(srcW * scale), h: Math.max(1, Math.round(srcH * scale)) };
}
function outputDims(fitW, fitH, rotation) {
  return (rotation === 90 || rotation === 270) ? { w: fitH, h: fitW } : { w: fitW, h: fitH };
}
// Backing-store size for the preview canvas (capped for smooth playback).
function previewSize(srcW, srcH) {
  if (srcW <= PREVIEW_MAX) return { w: srcW, h: srcH };
  const s = PREVIEW_MAX / srcW;
  return { w: PREVIEW_MAX, h: Math.max(1, Math.round(srcH * s)) };
}

// Render the current video frame through the same transform pipeline as the
// output, so the preview shows rotation/flip/colour exactly as it will encode.
// The Style step shows only the cropped ROI (zoomed, no editable crop box); other
// steps show the full frame with the crop box.
function roiView() { return ROI_STEPS.has(currentStep) && !!crop; }
function applyEffectsTo(canvas, ctx, w, h) {
  if (!(colormapActive() || curveActive())) return;
  const glOut = glPixelEffects(canvas, w, h);
  if (glOut) { ctx.clearRect(0, 0, w, h); ctx.drawImage(glOut, 0, 0); }
  else { const id = ctx.getImageData(0, 0, w, h); applyPixelEffects(id); ctx.putImageData(id, 0, 0); }
}
function drawPreview(force = false) {
  if ((extracting && !force) || !preview.videoWidth) return;
  const tf = readTransform();
  if (roiView()) drawRoiPreview(tf);
  else drawFullPreview(tf);
}
// Full frame + crop box (Crop / Trim / Logo / Export steps).
function drawFullPreview(tf) {
  const base = previewSize(preview.videoWidth, preview.videoHeight);
  const out = outputDims(base.w, base.h, tf.rotation);
  if (previewCanvas.width !== out.w) previewCanvas.width = out.w;
  if (previewCanvas.height !== out.h) previewCanvas.height = out.h;
  paint(previewCtx, preview, base.w, base.h, out.w, out.h, tf.rotation, tf.flip, tf.filterStr);
  applyEffectsTo(previewCanvas, previewCtx, out.w, out.h);
  if (logoBitmap && crop) {
    const f = fullDims(), scale = f.w ? out.w / f.w : 1;
    drawLogoInto(previewCtx, crop.x * scale, crop.y * scale, crop.w * scale, crop.h * scale);
  }
  if (crop) { cropRectEl.hidden = false; positionCropRect(); } else cropRectEl.hidden = true;
}
// Only the cropped ROI, scaled up to fill, no crop box (Style step).
function drawRoiPreview(tf) {
  cropRectEl.hidden = true;
  const c = crop;
  let ow = c.w, oh = c.h;
  if (ow > PREVIEW_MAX) { const s = PREVIEW_MAX / ow; ow = PREVIEW_MAX; oh = Math.max(1, Math.round(oh * s)); }
  if (oh > PREVIEW_MAX) { const s = PREVIEW_MAX / oh; oh = PREVIEW_MAX; ow = Math.max(1, Math.round(ow * s)); }
  const s2 = ow / c.w;
  const content = {
    w: Math.max(1, Math.round(preview.videoWidth * s2)),
    h: Math.max(1, Math.round(preview.videoHeight * s2)),
  };
  const full = outputDims(content.w, content.h, tf.rotation);
  fullCanvas.width = full.w; fullCanvas.height = full.h;
  paint(fullCtx, preview, content.w, content.h, full.w, full.h, tf.rotation, tf.flip, tf.filterStr);
  if (previewCanvas.width !== ow) previewCanvas.width = ow;
  if (previewCanvas.height !== oh) previewCanvas.height = oh;
  previewCtx.clearRect(0, 0, ow, oh);
  previewCtx.drawImage(fullCanvas, c.x * s2, c.y * s2, c.w * s2, c.h * s2, 0, 0, ow, oh);
  const onStyle = currentStep === 'style';
  if (onStyle) computeHistograms(previewCtx, 0, 0, ow, oh);  // whole ROI, raw (pre-effect)
  applyEffectsTo(previewCanvas, previewCtx, ow, oh);
  if (logoBitmap) drawLogoInto(previewCtx, 0, 0, ow, oh);
  if (onStyle) { drawCurve(); drawHistOut(); }
}
function previewLoop() { drawPreview(); previewRaf = requestAnimationFrame(previewLoop); }
function stopPreviewLoop() {
  if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = null; }
}

// ---- Spatial crop ------------------------------------------------------
// Displayed (post-rotation) full-frame dimensions, in source pixels.
function fullDims() {
  const rot = parseInt(rotateSel.value, 10) || 0;
  const swap = rot === 90 || rot === 270;
  return swap
    ? { w: preview.videoHeight, h: preview.videoWidth }
    : { w: preview.videoWidth, h: preview.videoHeight };
}
function aspectRatio() {
  switch (aspectMode) {
    case '1:1':  return 1;
    case '4:3':  return 4 / 3;
    case '3:2':  return 3 / 2;
    case '2:3':  return 2 / 3;
    case '16:9': return 16 / 9;
    case '3:4':  return 3 / 4;
    case '9:16': return 9 / 16;
    case 'orig': { const f = fullDims(); return f.h ? f.w / f.h : null; }
    default:     return null; // free
  }
}
// Wide ↔ tall counterparts, so a 90/270 rotation keeps the crop shape sensible.
const ASPECT_SWAP = { '4:3': '3:4', '3:4': '4:3', '3:2': '2:3', '2:3': '3:2', '16:9': '9:16', '9:16': '16:9' };
// Displayed full-frame dims at an arbitrary rotation (source pixels).
function dimsAt(rot) {
  const sw = rot === 90 || rot === 270;
  return sw ? { w: preview.videoHeight, h: preview.videoWidth }
            : { w: preview.videoWidth, h: preview.videoHeight };
}
function roundCrop() {
  const f = fullDims();
  crop.w = Math.max(1, Math.min(Math.round(crop.w), f.w));
  crop.h = Math.max(1, Math.min(Math.round(crop.h), f.h));
  crop.x = clamp(Math.round(crop.x), 0, f.w - crop.w);
  crop.y = clamp(Math.round(crop.y), 0, f.h - crop.h);
}
// Reshape the crop to the current aspect preset, keeping its centre.
function applyAspectToCrop() {
  const ar = aspectRatio();
  if (ar == null || !crop) return;
  const f = fullDims();
  let w = crop.w, h = w / ar;
  if (h > crop.h) { h = crop.h; w = h * ar; }
  if (w > f.w) { w = f.w; h = w / ar; }
  if (h > f.h) { h = f.h; w = h * ar; }
  const cx = crop.x + crop.w / 2, cy = crop.y + crop.h / 2;
  crop.w = w; crop.h = h;
  crop.x = cx - w / 2; crop.y = cy - h / 2;
  roundCrop();
}
function defaultFinalFromCrop() {
  const cap = parseInt(maxwInput.value, 10) || 480;
  finalW = Math.min(crop.w, cap > 0 ? cap : crop.w);
  finalH = Math.max(1, Math.round(finalW * crop.h / crop.w));
}
function initCropForVideo() {
  if (!preview.videoWidth) return;
  const f = fullDims();
  crop = { x: 0, y: 0, w: f.w, h: f.h };
  applyAspectToCrop();
  defaultFinalFromCrop();
  cropRectEl.hidden = false;
  syncCropInputs();
  positionCropRect();
}
function syncCropInputs() {
  if (!crop) return;
  cropXIn.value = crop.x; cropYIn.value = crop.y;
  cropWIn.value = crop.w; cropHIn.value = crop.h;
  finalWIn.value = finalW; finalHIn.value = finalH;
  updateCropInfo();
}
function updateCropInfo() {
  if (!crop) { cropInfo.textContent = ''; return; }
  const sx = (finalW / crop.w);
  cropInfo.textContent =
    `Keeping ${crop.w}×${crop.h}px of the source → output ${finalW}×${finalH}px (${sx.toFixed(2)}× scale).`;
}
function positionCropRect() {
  if (!crop || cropRectEl.hidden) return;
  const f = fullDims();
  if (!f.w || !f.h) return;
  cropRectEl.style.left   = (crop.x / f.w * 100) + '%';
  cropRectEl.style.top    = (crop.y / f.h * 100) + '%';
  cropRectEl.style.width  = (crop.w / f.w * 100) + '%';
  cropRectEl.style.height = (crop.h / f.h * 100) + '%';
}
// Recompute the final size to follow the crop's aspect, keeping finalW.
function syncFinalToCrop() {
  finalW = Math.max(1, Math.round(finalW));
  finalH = Math.max(1, Math.round(finalW * crop.h / crop.w));
}
function afterCropChange({ keepFinal = true } = {}) {
  roundCrop();
  if (keepFinal) syncFinalToCrop();
  syncCropInputs();
  positionCropRect();
  markStale();
  // The histograms (and curve preview) are computed over the crop ROI, so a ROI
  // change must refresh them while the Style step is showing (drawPreview redraws
  // the curve + histograms at its end when the Style pane is visible).
  if (stylePane && !stylePane.hidden) drawPreview();
}
function refreshReady() {
  const ready = (mode === 'video' && videoFile) ||
                (mode === 'images' && imageBitmaps.length >= 2);
  encodeBtn.disabled = !ready;
}
function paint(g, source, contentW, contentH, outW, outH, rotation, flip, filterStr) {
  g.save();
  g.filter = 'none';
  g.clearRect(0, 0, outW, outH);
  g.fillStyle = '#000';
  g.fillRect(0, 0, outW, outH);
  g.translate(outW / 2, outH / 2);
  g.rotate(rotation * Math.PI / 180);
  g.scale(flip.includes('h') ? -1 : 1, flip.includes('v') ? -1 : 1);
  g.filter = filterStr;
  g.drawImage(source, -contentW / 2, -contentH / 2, contentW, contentH);
  g.restore();
}
function readTransform() {
  return {
    rotation: parseInt(rotateSel.value, 10) || 0,
    flip: flipSel.value,
    filterStr: FILTERS[filterSel.value] || 'none',
  };
}

// ---- Colormap + levels + logo (post-process) ---------------------------
// A single-channel input is always "colormapped" (gray if no map chosen); the
// "Full colour (RGB)" input means no colormap (the tone curve acts on RGB).
function colormapActive() { return channelSel.value !== 'rgb'; }
function effectiveColormapKey() {
  return (colormapKey !== 'none' && ALL_CM[colormapKey]) ? colormapKey : 'gray';
}
function curveActive() { return !curveIdentity; }
// Build the 256-entry LUT from the control points with a smooth, monotonic
// (Fritsch–Carlson) cubic so the curve bends naturally between points and can
// both increase and decrease contrast. Drag the end points inward to clip.
function buildCurveLut() {
  const p = [...curvePoints].sort((a, b) => a.x - b.x);
  const n = p.length;
  const dx = [], slope = [];
  for (let i = 0; i < n - 1; i++) {
    const d = p[i + 1].x - p[i].x;
    dx.push(d);
    slope.push(d === 0 ? 0 : (p[i + 1].y - p[i].y) / d);
  }
  const m = new Array(n);
  m[0] = slope[0] || 0;
  m[n - 1] = slope[n - 2] || 0;
  for (let i = 1; i < n - 1; i++) m[i] = (slope[i - 1] * slope[i] <= 0) ? 0 : (slope[i - 1] + slope[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / slope[i], b = m[i + 1] / slope[i], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * slope[i]; m[i + 1] = t * b * slope[i]; }
  }
  let identity = true;
  for (let x = 0; x < 256; x++) {
    let y;
    if (x <= p[0].x) y = p[0].y;
    else if (x >= p[n - 1].x) y = p[n - 1].y;
    else {
      let i = 0; while (i < n - 2 && x > p[i + 1].x) i++;
      const h = dx[i], t = (x - p[i].x) / h, t2 = t * t, t3 = t2 * t;
      const h00 = 2 * t3 - 3 * t2 + 1, h10 = t3 - 2 * t2 + t, h01 = -2 * t3 + 3 * t2, h11 = t3 - t2;
      y = h00 * p[i].y + h10 * h * m[i] + h01 * p[i + 1].y + h11 * h * m[i + 1];
    }
    y = Math.round(clamp(y, 0, 255));
    curveLut[x] = y;
    if (y !== x) identity = false;
  }
  // "Invert input" flips the input axis (value 255-x is fed through the curve),
  // so the selected range + midpoint invert together. Distinct from reversing
  // the colormap (which flips the output colours, handled at lookup time).
  if (invertInput.checked) {
    const tmp = Uint8Array.from(curveLut);
    for (let x = 0; x < 256; x++) curveLut[x] = tmp[255 - x];
    identity = false;
  }
  curveIdentity = identity;
}
// ---- WebGL2 pixel-effect pass (colormap + tone curve) ------------------
// Vendored, dependency-free. Runs the exact semantics of applyPixelEffects on
// the GPU: one offscreen WebGL2 canvas + program, created lazily once. Falls
// back permanently to the CPU path (applyColormap/applyCurveRGB, untouched) if
// WebGL2 is missing or any GL step fails.
const GL_VS = `#version 300 es
in vec2 p; out vec2 uv;
void main(){ uv = vec2((p.x+1.0)*0.5, (1.0-p.y)*0.5); gl_Position = vec4(p,0.0,1.0); }`;
const GL_FS = `#version 300 es
precision highp float;
in vec2 uv; out vec4 o;
uniform sampler2D uSrc, uCurve, uCmap;
uniform int uColormapOn, uCurveOn, uChannel; // channel: 0=r 1=g 2=b 3=luma
float lutAt(sampler2D t, float v){ return texture(t, vec2((v*255.0+0.5)/256.0, 0.5)).r; }
void main(){
  vec4 s = texture(uSrc, uv);
  if (uColormapOn == 1) {
    float v;
    if (uChannel == 0) v = s.r;
    else if (uChannel == 1) v = s.g;
    else if (uChannel == 2) v = s.b;
    else v = floor(s.r*255.0*0.299 + s.g*255.0*0.587 + s.b*255.0*0.114)/255.0;
    v = clamp(v, 0.0, 1.0);
    if (uCurveOn == 1) v = lutAt(uCurve, v);          // llut applied before colormap
    vec3 c = texture(uCmap, vec2((v*255.0+0.5)/256.0, 0.5)).rgb;
    o = vec4(c, s.a);
  } else {
    // curve-only: apply curve LUT per RGB channel
    o = vec4(lutAt(uCurve, s.r), lutAt(uCurve, s.g), lutAt(uCurve, s.b), s.a);
  }
}`;
let GL = null;            // { canvas, gl, prog, u, tex... } once initialised
let glDead = false;       // permanent fall-back flag
let glCurveKey = '';      // last curve LUT uploaded (cache key)
let glCmapKey  = '';      // last colormap LUT uploaded (cache key)
let glReadBuf = null;     // reusable readPixels target (RGBA, w*h*4)
let glRowBuf  = null;     // reusable single-row scratch for the vertical flip
function glCompile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src); gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) || 'shader');
  return sh;
}
function glLut1D(gl) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
function glInit() {
  if (GL || glDead) return !glDead;
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: false, alpha: true });
    if (!gl) throw new Error('no webgl2');
    const prog = gl.createProgram();
    gl.attachShader(prog, glCompile(gl, gl.VERTEX_SHADER, GL_VS));
    gl.attachShader(prog, glCompile(gl, gl.FRAGMENT_SHADER, GL_FS));
    gl.bindAttribLocation(prog, 0, 'p');
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const srcTex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const u = {
      src: gl.getUniformLocation(prog, 'uSrc'),
      curve: gl.getUniformLocation(prog, 'uCurve'),
      cmap: gl.getUniformLocation(prog, 'uCmap'),
      colormapOn: gl.getUniformLocation(prog, 'uColormapOn'),
      curveOn: gl.getUniformLocation(prog, 'uCurveOn'),
      channel: gl.getUniformLocation(prog, 'uChannel'),
    };
    gl.uniform1i(u.src, 0); gl.uniform1i(u.curve, 1); gl.uniform1i(u.cmap, 2);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    GL = { canvas, gl, prog, u, srcTex, curveTex: glLut1D(gl), cmapTex: glLut1D(gl) };
    if (gl.getError() !== gl.NO_ERROR) throw new Error('gl error during init');
    return true;
  } catch (e) {
    glDead = true; GL = null;
    return false;
  }
}
// True if the GPU pixel-effect pass is usable. Feature-detect once.
function glAvailable() { return glInit(); }
// Upload curveLut (always; identity LUT is fine) and the active colormap LUT,
// only when they change. Cheap 256×1 NEAREST RGBA textures.
function glUploadLuts() {
  const gl = GL.gl;
  const cKey = curveIdentity ? 'id' : curveLut.join(',');
  if (cKey !== glCurveKey) {
    const px = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) { px[i * 4] = curveLut[i]; px[i * 4 + 3] = 255; }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, GL.curveTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    glCurveKey = cKey;
  }
  const baseKey = effectiveColormapKey();
  const rev = reverseCmap.checked;
  const mKey = baseKey + (rev ? '-rev' : '');
  const cm = ALL_CM[baseKey];
  if (cm && mKey !== glCmapKey) {
    const px = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      const c = cm.lut[rev ? 255 - i : i];
      px[i * 4] = c[0]; px[i * 4 + 1] = c[1]; px[i * 4 + 2] = c[2]; px[i * 4 + 3] = 255;
    }
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, GL.cmapTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 256, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, px);
    glCmapKey = mKey;
  }
}
// Run the pixel-effect pass over `src` (a canvas/video/ImageBitmap of size w×h)
// and leave the result in GL.canvas. When `readBack` is true, also reads the
// result straight off the GPU via gl.readPixels (skipping a drawImage +
// getImageData round-trip), vertically flips it (WebGL rows come bottom-to-top)
// into a reusable RGBA buffer, and returns { canvas, pixels }. Otherwise returns
// the GL canvas. Returns null on failure (caller falls back to the CPU path).
function glPixelEffects(src, w, h, readBack) {
  if (!glAvailable()) return null;
  try {
    const gl = GL.gl;
    if (GL.canvas.width !== w) GL.canvas.width = w;
    if (GL.canvas.height !== h) GL.canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.useProgram(GL.prog);
    glUploadLuts();
    const chn = channelSel.value;
    const ch = chn === 'r' ? 0 : chn === 'g' ? 1 : chn === 'b' ? 2 : 3;
    gl.uniform1i(GL.u.colormapOn, colormapActive() ? 1 : 0);
    gl.uniform1i(GL.u.curveOn, curveActive() ? 1 : 0);
    gl.uniform1i(GL.u.channel, ch);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, GL.srcTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('gl error during draw');
    if (!readBack) return GL.canvas;
    const stride = w * 4, total = stride * h;
    if (!glReadBuf || glReadBuf.length !== total) glReadBuf = new Uint8Array(total);
    if (!glRowBuf || glRowBuf.length !== stride) glRowBuf = new Uint8Array(stride);
    const buf = glReadBuf;
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    if (gl.getError() !== gl.NO_ERROR) throw new Error('gl error during readPixels');
    // Flip vertically in place: readPixels returns rows bottom-to-top, but the
    // 2D/getImageData convention (and the encoder) want top-to-bottom.
    const row = glRowBuf, half = h >> 1;
    for (let r = 0; r < half; r++) {
      const top = r * stride, bot = (h - 1 - r) * stride;
      row.set(buf.subarray(top, top + stride));
      buf.copyWithin(top, bot, bot + stride);
      buf.set(row, bot);
    }
    return { canvas: GL.canvas, pixels: buf };
  } catch (e) {
    glDead = true; GL = null;
    return null;
  }
}

// Recolour each pixel by looking up its chosen channel (optionally levels-
// adjusted first) in the colormap LUT.
function applyColormap(imageData, llut) {
  const cm = ALL_CM[effectiveColormapKey()];
  if (!cm) return;
  const lut = cm.lut, ch = channelSel.value, d = imageData.data, rev = reverseCmap.checked;
  for (let i = 0; i < d.length; i += 4) {
    let v;
    if (ch === 'r') v = d[i];
    else if (ch === 'g') v = d[i + 1];
    else if (ch === 'b') v = d[i + 2];
    else v = (d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114) | 0;
    if (v < 0) v = 0; else if (v > 255) v = 255;
    if (llut) v = llut[v];
    const c = lut[rev ? 255 - v : v];
    d[i] = c[0]; d[i + 1] = c[1]; d[i + 2] = c[2];
  }
}
function applyCurveRGB(imageData) {
  const d = imageData.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = curveLut[d[i]]; d[i + 1] = curveLut[d[i + 1]]; d[i + 2] = curveLut[d[i + 2]];
  }
}
// Apply colormap and/or tone curve in place. Returns true if anything changed.
function applyPixelEffects(imageData) {
  const cm = colormapActive(), cv = curveActive();
  if (!cm && !cv) return false;
  if (cm) applyColormap(imageData, cv ? curveLut : null);
  else applyCurveRGB(imageData);
  return true;
}

// Composite the logo into the rectangle (x,y,w,h) of ctx, at the chosen
// position/size/opacity. Size and margin are relative to the rect width.
function drawLogoInto(ctx, x, y, w, h) {
  if (!logoBitmap) return;
  const sizePct = (parseInt(logoSize.value, 10) || 20) / 100;
  const lw = w * sizePct;
  const lh = lw * (logoBitmap.height / logoBitmap.width);
  const m = w * 0.04;
  const pos = logoPos.value;
  let lx, ly, rot = 0;
  switch (pos) {
    case 'tl':     lx = x + m;            ly = y + m;            break;
    case 'tr':     lx = x + w - lw - m;   ly = y + m;            break;
    case 'bl':     lx = x + m;            ly = y + h - lh - m;   break;
    case 'center':                                                          // fallthrough
    case 'center45':
    case 'center-45': lx = x + (w - lw) / 2; ly = y + (h - lh) / 2;
                      rot = pos === 'center45' ? -Math.PI / 4 : pos === 'center-45' ? Math.PI / 4 : 0; break;
    default:       lx = x + w - lw - m;   ly = y + h - lh - m;   break; // br
  }
  ctx.save();
  ctx.filter = 'none';
  ctx.globalAlpha = clamp((parseInt(logoOpacity.value, 10) || 0) / 100, 0, 1);
  if (rot) {
    ctx.translate(lx + lw / 2, ly + lh / 2);
    ctx.rotate(rot);
    ctx.drawImage(logoBitmap, -lw / 2, -lh / 2, lw, lh);
  } else {
    ctx.drawImage(logoBitmap, lx, ly, lw, lh);
  }
  ctx.restore();
}

// Apply colormap + logo to a finished output frame and read it back.
function finishFrame(g, w, h) {
  if (colormapActive() || curveActive()) {
    // Fast path: no logo means the GL result is the final frame, so read it
    // straight off the GPU (skip the extra drawImage + getImageData). The
    // encoder accepts a bare { data } object, so wrap the readPixels buffer.
    if (!logoBitmap) {
      const glOut = glPixelEffects(g.canvas, w, h, true);
      if (glOut && glOut.pixels) {
        // The buffer is reused next call; copy so the pushed frame is stable.
        return { data: glOut.pixels.slice(), width: w, height: h };
      }
    }
    // Logo present (or readback failed): run the effect onto the 2D canvas so
    // the logo can be composited in 2D afterwards.
    const glOut = glPixelEffects(g.canvas, w, h);
    if (glOut) {
      g.clearRect(0, 0, w, h);
      g.drawImage(glOut, 0, 0);
    } else {
      const id = g.getImageData(0, 0, w, h);
      applyPixelEffects(id);
      g.putImageData(id, 0, 0);
    }
  }
  if (logoBitmap) drawLogoInto(g, 0, 0, w, h);
  return g.getImageData(0, 0, w, h);
}

// ---- Timeline model ----------------------------------------------------
// The kept ranges are [cropStart, cropEnd] minus every cut, in order.
function keepRanges() {
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const ranges = [];
  let cursor = cropStart;
  for (const c of sorted) {
    const cs = clamp(c.start, cropStart, cropEnd);
    const ce = clamp(c.end, cropStart, cropEnd);
    if (ce <= cursor) continue;
    if (cs > cursor) ranges.push({ start: cursor, end: cs });
    cursor = Math.max(cursor, ce);
  }
  if (cursor < cropEnd) ranges.push({ start: cursor, end: cropEnd });
  return ranges;
}

function pct(t) { return duration ? (t / duration) * 100 : 0; }

function renderTimeline() {
  handleIn.style.left  = pct(cropStart) + '%';
  handleOut.style.left = pct(cropEnd) + '%';

  tlRegions.innerHTML = '';
  const add = (cls, a, b, onclick) => {
    const el = document.createElement('div');
    el.className = 'tl-region ' + cls;
    el.style.left = pct(a) + '%';
    el.style.width = (pct(b) - pct(a)) + '%';
    if (cls.includes('cut')) el.title = 'Click to remove this cut';
    if (onclick) el.addEventListener('click', onclick);
    tlRegions.appendChild(el);
    return el;
  };
  // dim the cropped-off ends
  if (cropStart > 0) add('outside', 0, cropStart);
  if (cropEnd < duration) add('outside', cropEnd, duration);
  // green kept ranges
  keepRanges().forEach((r) => add('keep', r.start, r.end));
  // red cut strips (click to remove the cut)
  cuts.forEach((c, i) => add('cut', clamp(c.start, cropStart, cropEnd),
    clamp(c.end, cropStart, cropEnd), (e) => { e.stopPropagation(); removeCut(i); }));

  const kept = keepRanges().reduce((a, r) => a + (r.end - r.start), 0);
  const parts = [];
  if (cuts.length) parts.push(`${cuts.length} cut${cuts.length > 1 ? 's' : ''} · ${kept.toFixed(1)}s kept`);
  if (pendingCutStart != null) parts.push('cut start marked — scrub, then “Remove section”');
  cutInfo.textContent = parts.join('  ·  ');

  // Highlight the "Remove section" button while a cut is staged.
  const removeBtn = document.querySelector('[data-act="cutEnd"]');
  if (removeBtn) removeBtn.classList.toggle('armed', pendingCutStart != null);
  updatePending();
}

function removeCut(i) { cuts.splice(i, 1); renderTimeline(); }

// Yellow band from the marked cut start to the playhead, shown while staging.
function updatePending() {
  if (pendingCutStart == null || !duration) { tlPending.style.display = 'none'; return; }
  const t = preview.currentTime || 0;
  const a = Math.min(pendingCutStart, t), b = Math.max(pendingCutStart, t);
  tlPending.style.display = 'block';
  tlPending.style.left = pct(a) + '%';
  tlPending.style.width = Math.max(0, pct(b) - pct(a)) + '%';
}

function setPlayhead() {
  playhead.style.left = pct(preview.currentTime || 0) + '%';
  const fps = captureFps();
  timecode.textContent =
    `${fmtTime(preview.currentTime)} / ${fmtTime(duration)} · frame ${Math.round((preview.currentTime || 0) * fps)}`;
  updatePending();
}

function seek(t) { preview.currentTime = clamp(t, 0, Math.max(0, duration - 1e-3)); }

// ---- Step navigation (non-linear: any step, any time) ------------------
// From the Style step onward the preview shows only the cropped ROI (zoomed, no
// editable crop box); earlier steps show the full frame with the crop box.
const ROI_STEPS = new Set(['style', 'logo', 'export']);
let currentStep = 'source';
function showStep(name) {
  currentStep = name;
  stepPanes.forEach((p) => { p.hidden = p.dataset.pane !== name; });
  stepBtns.forEach((b) => b.classList.toggle('active', b.dataset.step === name));
  drawPreview();  // switch full-frame ⇄ ROI-only view for the new step
}
stepBtns.forEach((b) => b.addEventListener('click', () => showStep(b.dataset.step)));

// ---- Source mode (auto-detected from the files) ------------------------
function applyMode() {
  const isVideo = mode === 'video';
  document.querySelectorAll('.video-only').forEach((e) => { e.hidden = !isVideo; });
  document.querySelectorAll('.images-only').forEach((e) => { e.hidden = isVideo; });
  refreshReady();
}

// ---- Drag & drop wiring ------------------------------------------------
// Click-to-open dropzone (used for the optional logo).
function wireDrop(zone, input, onFiles) {
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => onFiles([...input.files]));
  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', (e) => onFiles([...e.dataTransfer.files]));
}
// Drop-only zone (no click-to-open) for the source.
function wireDropZone(zone, onFiles) {
  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', (e) => onFiles([...e.dataTransfer.files]));
}

// The source is auto-detected: videos win if present, otherwise images.
function acceptSource(files) {
  const vids = files.filter((f) => f.type.startsWith('video/'));
  const imgs = files.filter((f) => f.type.startsWith('image/'));
  if (vids.length) loadVideo(vids[0]);
  else if (imgs.length) loadImages(imgs);
  else setStatus('Unsupported file — please drop a video or images.', true);
}
wireDropZone(dropAny, acceptSource);
pickVideo.addEventListener('click', () => fileVideo.click());
pickImages.addEventListener('click', () => fileImages.click());
fileVideo.addEventListener('change', () => { if (fileVideo.files[0]) loadVideo(fileVideo.files[0]); });
fileImages.addEventListener('change', () => {
  const imgs = [...fileImages.files].filter((f) => f.type.startsWith('image/'));
  if (imgs.length) loadImages(imgs);
});
wireDrop(dropLogo, fileLogo, (files) => {
  const f = files.find((x) => x.type.startsWith('image/')) || files[0];
  if (f) loadLogo(f);
});
async function loadLogo(file) {
  try {
    logoBitmap = await createImageBitmap(file);
    if (logoUrl) URL.revokeObjectURL(logoUrl);
    logoUrl = URL.createObjectURL(file);
    logoPreview.src = logoUrl;
    logoPreview.hidden = false;
    logoDropText.hidden = true;
    dropLogo.classList.add('has-logo');
    logoInfo.classList.remove('error');
    logoInfo.textContent = `Logo: ${file.name} (${logoBitmap.width}×${logoBitmap.height}). It is placed inside the cropped output.`;
    markStale();
    drawPreview();
  } catch { logoInfo.textContent = 'Could not load that image.'; logoInfo.classList.add('error'); }
}

// ---- Video input -------------------------------------------------------
function loadVideo(file) {
  mode = 'video';
  markStale();
  videoFile = file;
  if (preview.src) URL.revokeObjectURL(preview.src);
  preview.src = URL.createObjectURL(file);
  preview.onloadedmetadata = () => {
    duration = preview.duration || 0;
    cropStart = 0;
    cropEnd = duration;
    cuts = [];
    pendingCutStart = null;
    const { videoWidth: w, videoHeight: h } = preview;
    videoInfo.textContent = `Loaded ${file.name} — ${w}×${h}, ${duration.toFixed(1)}s`;
    stage.hidden = false;
    aspectMode = cropAspect.value;
    lastRotation = parseInt(rotateSel.value, 10) || 0;
    lastFlip = flipSel.value;
    updateAspectLockUI();
    initCropForVideo();
    renderTimeline();
    seek(0);
    setPlayhead();
    applyMode();
    showStep('trim');
    refreshReady();
  };
  preview.onerror = () =>
    setStatus('Could not load that video — your browser may not support its format.', true);
}

// Preview playback honours crop + cuts: skip over cut sections, stop at the end.
preview.addEventListener('timeupdate', () => {
  setPlayhead();
  if (preview.paused) return;
  const t = preview.currentTime;
  if (t >= cropEnd) { preview.pause(); seek(cropStart); return; }
  if (t < cropStart) { seek(cropStart); return; }
  for (const c of cuts) {
    if (t >= c.start && t < c.end) { seek(c.end); break; }
  }
});
preview.addEventListener('seeked', () => { setPlayhead(); drawPreview(); });
preview.addEventListener('loadeddata', drawPreview);
preview.addEventListener('play',  () => { playBtn().innerHTML = PAUSE_SVG; if (!previewRaf) previewLoop(); });
preview.addEventListener('pause', () => { playBtn().innerHTML = PLAY_SVG; stopPreviewLoop(); drawPreview(); });
preview.addEventListener('ended', () => { stopPreviewLoop(); drawPreview(); });
function playBtn() { return document.querySelector('.tbtn.play'); }

// Live transform controls update the preview immediately. Rotation/flip carry
// the crop along (transform its extents) instead of resetting it, and swap the
// aspect preset wide↔tall on 90/270 turns.
rotateSel.addEventListener('change', () => {
  const newRot = parseInt(rotateSel.value, 10) || 0;
  if (crop && preview.videoWidth) {
    const delta = (newRot - lastRotation + 360) % 360;
    const o = dimsAt(lastRotation);
    const { x, y, w, h } = crop;
    if (delta === 90)       crop = { x: o.h - (y + h), y: x, w: h, h: w };
    else if (delta === 180) crop = { x: o.w - (x + w), y: o.h - (y + h), w, h };
    else if (delta === 270) crop = { x: y, y: o.w - (x + w), w: h, h: w };
    if (delta === 90 || delta === 270) {
      [finalW, finalH] = [finalH, finalW];
      const sw = ASPECT_SWAP[aspectMode];
      if (sw) { aspectMode = sw; cropAspect.value = sw; updateAspectLockUI(); }
    }
    afterCropChange({ keepFinal: false });
  }
  lastRotation = newRot;
  drawPreview();
});
flipSel.addEventListener('change', () => {
  const nf = flipSel.value;
  if (crop && preview.videoWidth) {
    const f = fullDims();
    if (lastFlip.includes('h') !== nf.includes('h')) crop.x = f.w - (crop.x + crop.w);
    if (lastFlip.includes('v') !== nf.includes('v')) crop.y = f.h - (crop.y + crop.h);
    afterCropChange({ keepFinal: false });
  }
  lastFlip = nf;
  drawPreview();
});
filterSel.addEventListener('change', drawPreview);
function updateColormapEnabled() {
  const rgb = channelSel.value === 'rgb';
  colormapSearch.disabled = rgb;
  document.getElementById('colormap-combo').style.opacity = rgb ? 0.5 : 1;
  colormapSearch.placeholder = rgb ? 'n/a — RGB input' : 'None';
}
channelSel.addEventListener('change', () => { updateColormapEnabled(); markStale(); drawPreview(); refreshCurveUI(); });
updateColormapEnabled();

// ---- Colormap combobox (searchable, fuzzy) -----------------------------
let cmFiltered = CM_OPTIONS, cmActiveIndex = -1;

function swatchCss(key) {
  if (key === 'none') return 'background:repeating-linear-gradient(45deg,#555 0 6px,#333 6px 12px)';
  const lut = ALL_CM[key].lut;
  const stops = [0, 64, 128, 191, 255].map((i) =>
    `rgb(${lut[i][0]},${lut[i][1]},${lut[i][2]}) ${(i / 255 * 100).toFixed(0)}%`);
  return `background:linear-gradient(90deg,${stops.join(',')})`;
}
// Subsequence fuzzy match; -1 = no match, higher = better.
function fuzzyScore(q, s) {
  q = q.toLowerCase(); s = s.toLowerCase();
  if (!q) return 0;
  let qi = 0, score = 0, prev = -2;
  for (let i = 0; i < s.length && qi < q.length; i++) {
    if (s[i] === q[qi]) { score += (i === prev + 1 ? 2 : 1) + (i === 0 ? 3 : 0); prev = i; qi++; }
  }
  return qi === q.length ? score : -1;
}
function showCmList() { colormapList.hidden = false; colormapSearch.setAttribute('aria-expanded', 'true'); }
function hideCmList() { colormapList.hidden = true; colormapSearch.setAttribute('aria-expanded', 'false'); }
function markCmActive() {
  [...colormapList.querySelectorAll('.combo-opt')].forEach((c, i) => c.classList.toggle('active', i === cmActiveIndex));
  const el = colormapList.querySelectorAll('.combo-opt')[cmActiveIndex];
  if (el) el.scrollIntoView({ block: 'nearest' });
}
function renderCmList(q = '') {
  cmFiltered = CM_OPTIONS
    .map((o) => ({ o, s: Math.max(fuzzyScore(q, o.name), fuzzyScore(q, o.key)) }))
    .filter((r) => r.s >= 0).sort((a, b) => b.s - a.s).map((r) => r.o);
  cmActiveIndex = cmFiltered.length ? 0 : -1;
  colormapList.innerHTML = '';
  if (!cmFiltered.length) {
    colormapList.innerHTML = '<div class="combo-empty">No matching colormap</div>';
  } else {
    cmFiltered.forEach((o, i) => {
      const el = document.createElement('div');
      el.className = 'combo-opt' + (i === cmActiveIndex ? ' active' : '');
      el.innerHTML = `<span class="swatch" style="${swatchCss(o.key)}"></span><span>${o.name}</span>`;
      el.addEventListener('mousedown', (e) => { e.preventDefault(); selectColormap(o.key); });
      el.addEventListener('mouseenter', () => { cmActiveIndex = i; markCmActive(); });
      colormapList.appendChild(el);
    });
  }
  showCmList();
}
function selectColormap(key) {
  colormapKey = key;
  const opt = CM_OPTIONS.find((o) => o.key === key);
  colormapSearch.value = key === 'none' ? '' : (opt ? opt.name : '');
  hideCmList();
  markStale();
  drawPreview();
}
colormapSearch.addEventListener('focus', () => renderCmList(''));
colormapSearch.addEventListener('input', () => renderCmList(colormapSearch.value));
colormapSearch.addEventListener('keydown', (e) => {
  if (colormapList.hidden && e.key === 'ArrowDown') { renderCmList(colormapSearch.value); return; }
  if (e.key === 'ArrowDown') { e.preventDefault(); cmActiveIndex = Math.min(cmActiveIndex + 1, cmFiltered.length - 1); markCmActive(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); cmActiveIndex = Math.max(cmActiveIndex - 1, 0); markCmActive(); }
  else if (e.key === 'Enter') { e.preventDefault(); if (cmFiltered[cmActiveIndex]) selectColormap(cmFiltered[cmActiveIndex].key); }
  else if (e.key === 'Escape') { hideCmList(); colormapSearch.blur(); }
});
colormapSearch.addEventListener('blur', () => setTimeout(hideCmList, 150));

// ---- Tone curve editor + histograms ------------------------------------
// Histograms of the cropped region (raw, pre-curve), input + curve-mapped output.
function computeHistograms(ctx, rx, ry, rw, rh) {
  inputHist.fill(0); outputHist.fill(0);
  let data;
  try { data = ctx.getImageData(rx, ry, rw, rh).data; } catch { return; }
  const chn = channelSel.value, total = rw * rh, stride = Math.max(1, Math.floor(total / 40000));
  for (let p = 0; p < total; p += stride) {
    const i = p * 4;
    let v;
    if (chn === 'r') v = data[i];
    else if (chn === 'g') v = data[i + 1];
    else if (chn === 'b') v = data[i + 2];
    else v = (data[i] * 0.299 + data[i + 1] * 0.587 + data[i + 2] * 0.114) | 0;
    if (v < 0) v = 0; else if (v > 255) v = 255;
    inputHist[v]++; outputHist[curveLut[v]]++;
  }
}
// `color` is a fixed fill, or `colorFn(i)` returns a per-bar colour.
function drawHistBars(canvas, ctx, hist, color, colorFn) {
  const W = canvas.width, H = canvas.height, log = histLog.checked;
  const f = (v) => (log ? Math.log1p(v) : v);
  let max = 0;
  for (let i = 0; i < 256; i++) { const v = f(hist[i]); if (v > max) max = v; }
  if (max <= 0) return;
  if (!colorFn) ctx.fillStyle = color;
  const bw = Math.max(1, W / 256);
  for (let i = 0; i < 256; i++) {
    const h = f(hist[i]) / max * (H - 1);
    if (h > 0) { if (colorFn) ctx.fillStyle = colorFn(i); ctx.fillRect(i / 255 * (W - 1), H - h, bw, h); }
  }
}
const cpx = (c, v) => v / 255 * (c.width - 1);
const cpy = (c, v) => (c.height - 1) - v / 255 * (c.height - 1);
function drawCurve() {
  const c = curveCanvas, ctx = curveCtx, W = c.width, H = c.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#16181b'; ctx.fillRect(0, 0, W, H);
  drawHistBars(c, ctx, inputHist, 'rgba(125,145,165,.40)');
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1; ctx.beginPath();
  for (let g = 1; g < 4; g++) { ctx.moveTo(g / 4 * W, 0); ctx.lineTo(g / 4 * W, H); ctx.moveTo(0, g / 4 * H); ctx.lineTo(W, g / 4 * H); }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.20)'; ctx.beginPath(); ctx.moveTo(0, H - 1); ctx.lineTo(W - 1, 0); ctx.stroke();
  ctx.strokeStyle = '#00bc8c'; ctx.lineWidth = 2; ctx.beginPath();
  for (let x = 0; x < 256; x++) { const X = cpx(c, x), Y = cpy(c, curveLut[x]); x === 0 ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y); }
  ctx.stroke();
  ctx.fillStyle = '#fff';
  for (const pt of curvePoints) { ctx.beginPath(); ctx.arc(cpx(c, pt.x), cpy(c, pt.y), 4, 0, 7); ctx.fill(); }
}
function drawHistOut() {
  const c = histOut, ctx = histOutCtx;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#16181b'; ctx.fillRect(0, 0, c.width, c.height);
  // Tint each output bar with the colour the (effective) colormap gives that
  // value; grayscale when there's no colormap. So the output histogram shows
  // the actual output colours, including a reversed range when inverted.
  const lut = colormapActive() ? ALL_CM[effectiveColormapKey()].lut : null;
  const rev = reverseCmap.checked;
  const colorFn = lut
    ? (i) => { const cc = lut[rev ? 255 - i : i]; return `rgb(${cc[0]},${cc[1]},${cc[2]})`; }
    : (i) => `rgb(${i},${i},${i})`;
  drawHistBars(c, ctx, outputHist, null, colorFn);
}
function refreshCurveUI() { drawCurve(); drawHistOut(); }
function onCurveEdit() { buildCurveLut(); markStale(); drawPreview(); refreshCurveUI(); }

let curveDrag = -1;
function evToVal(e) {
  const r = curveCanvas.getBoundingClientRect();
  return {
    x: clamp(Math.round((e.clientX - r.left) / r.width * 255), 0, 255),
    y: clamp(Math.round((1 - (e.clientY - r.top) / r.height) * 255), 0, 255),
  };
}
function nearestPoint(v) {
  const r = curveCanvas.getBoundingClientRect();
  const thx = 14 / r.width * 255, thy = 14 / r.height * 255;
  for (let i = 0; i < curvePoints.length; i++)
    if (Math.abs(curvePoints[i].x - v.x) <= thx && Math.abs(curvePoints[i].y - v.y) <= thy) return i;
  return -1;
}
curveCanvas.addEventListener('pointerdown', (e) => {
  const v = evToVal(e);
  let i = nearestPoint(v);
  if (i < 0) { curvePoints.push({ x: v.x, y: v.y }); curvePoints.sort((a, b) => a.x - b.x); i = curvePoints.indexOf(curvePoints.find((p) => p.x === v.x && p.y === v.y)); }
  curveDrag = i;
  try { curveCanvas.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
  onCurveEdit();
});
curveCanvas.addEventListener('pointermove', (e) => {
  if (curveDrag < 0) return;
  const v = evToVal(e), last = curvePoints.length - 1, pt = curvePoints[curveDrag];
  // End points may move horizontally (black/white point clipping → more contrast).
  if (curveDrag === 0) pt.x = clamp(v.x, 0, curvePoints[1].x - 1);
  else if (curveDrag === last) pt.x = clamp(v.x, curvePoints[last - 1].x + 1, 255);
  else pt.x = clamp(v.x, curvePoints[curveDrag - 1].x + 1, curvePoints[curveDrag + 1].x - 1);
  pt.y = v.y;
  onCurveEdit();
});
const endCurveDrag = () => { curveDrag = -1; };
curveCanvas.addEventListener('pointerup', endCurveDrag);
curveCanvas.addEventListener('pointercancel', endCurveDrag);
curveCanvas.addEventListener('dblclick', (e) => {
  const i = nearestPoint(evToVal(e));
  if (i > 0 && i < curvePoints.length - 1) { curvePoints.splice(i, 1); onCurveEdit(); }
});
histLog.addEventListener('change', refreshCurveUI);
invertInput.addEventListener('change', onCurveEdit);              // changes the value LUT
reverseCmap.addEventListener('change', () => { markStale(); drawPreview(); refreshCurveUI(); }); // colormap only
curveReset.addEventListener('click', () => {
  curvePoints = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
  invertInput.checked = false; reverseCmap.checked = false;
  onCurveEdit();
});
buildCurveLut();
refreshCurveUI();

// Logo / watermark controls
logoSize.addEventListener('input', () => { logoSizeVal.textContent = logoSize.value; markStale(); drawPreview(); });
logoOpacity.addEventListener('input', () => { logoOpacityVal.textContent = logoOpacity.value; markStale(); drawPreview(); });
logoPos.addEventListener('change', () => { markStale(); drawPreview(); });
function clearLogo() {
  logoBitmap = null; fileLogo.value = '';
  if (logoUrl) { URL.revokeObjectURL(logoUrl); logoUrl = null; }
  logoPreview.removeAttribute('src'); logoPreview.hidden = true;
  logoDropText.hidden = false; dropLogo.classList.remove('has-logo');
  logoInfo.textContent = ''; logoInfo.classList.remove('error');
}
logoClear.addEventListener('click', () => { clearLogo(); markStale(); drawPreview(); });

// Anything that changes the actual frames invalidates the base GIF (forces a
// re-encode); timing & loop do not (they patch metadata instantly).
[fpsInput, maxwInput, qualityIn, rotateSel, flipSel, filterSel].forEach(
  (el) => el.addEventListener('change', markStale));

// ---- Image input -------------------------------------------------------
async function loadImages(files) {
  mode = 'images';
  markStale();
  files.sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  setStatus('Decoding images…');
  for (const f of files) {
    try {
      imageBitmaps.push({ bitmap: await createImageBitmap(f), name: f.name });
    } catch { setStatus(`Could not decode ${f.name}`, true); }
  }
  setStatus('');
  renderThumbs();
  stage.hidden = false;
  applyMode();
  showStep('crop');
  refreshReady();
}
function renderThumbs() {
  thumbs.innerHTML = '';
  imageBitmaps.forEach((item, i) => {
    const el = document.createElement('div');
    el.className = 'thumb';
    const c = document.createElement('canvas');
    c.width = 78; c.height = 78;
    const g = c.getContext('2d');
    const { width: bw, height: bh } = item.bitmap;
    const s = Math.max(78 / bw, 78 / bh);
    g.drawImage(item.bitmap, (78 - bw * s) / 2, (78 - bh * s) / 2, bw * s, bh * s);
    const img = document.createElement('img'); img.src = c.toDataURL();
    const rm = document.createElement('button');
    rm.textContent = '×'; rm.title = 'remove';
    rm.onclick = () => { imageBitmaps.splice(i, 1); renderThumbs(); refreshReady(); };
    el.append(img, rm);
    thumbs.appendChild(el);
  });
}

// ---- Transport + timeline interaction ----------------------------------
document.querySelectorAll('.transport .tbtn').forEach((b) =>
  b.addEventListener('click', () => transport(b.dataset.act)));
document.querySelectorAll('.tl-actions [data-act]').forEach((b) =>
  b.addEventListener('click', () => transport(b.dataset.act)));

function transport(act) {
  switch (act) {
    case 'play':      preview.paused ? preview.play() : preview.pause(); break;
    case 'prevFrame': preview.pause(); seek(preview.currentTime - frameStep()); break;
    case 'nextFrame': preview.pause(); seek(preview.currentTime + frameStep()); break;
    case 'toIn':      seek(cropStart); break;
    case 'toOut':     seek(cropEnd); break;
    case 'setIn':     cropStart = clamp(preview.currentTime, 0, cropEnd - frameStep()); renderTimeline(); break;
    case 'setOut':    cropEnd = clamp(preview.currentTime, cropStart + frameStep(), duration); renderTimeline(); break;
    case 'cutStart':  pendingCutStart = preview.currentTime; renderTimeline(); break;
    case 'cutEnd': {
      if (pendingCutStart == null) { setStatus('Mark a cut start first.', true); break; }
      const a = Math.min(pendingCutStart, preview.currentTime);
      const b = Math.max(pendingCutStart, preview.currentTime);
      if (b - a > 1e-3) cuts.push({ start: a, end: b });
      pendingCutStart = null;
      renderTimeline();
      break;
    }
    case 'clearCuts': cuts = []; pendingCutStart = null; renderTimeline(); break;
  }
}

// Keyboard shortcuts while editing a video
document.addEventListener('keydown', (e) => {
  if (mode !== 'video' || !videoFile) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  const map = {
    ' ': 'play', ArrowLeft: 'prevFrame', ArrowRight: 'nextFrame',
    Home: 'toIn', End: 'toOut', i: 'setIn', I: 'setIn', o: 'setOut', O: 'setOut',
  };
  if (e.key === 'x' || e.key === 'X') {
    e.preventDefault();
    transport(pendingCutStart == null ? 'cutStart' : 'cutEnd');
    return;
  }
  if (map[e.key]) { e.preventDefault(); transport(map[e.key]); }
});

// Pointer scrubbing + handle dragging on the track
function tFromEvent(e) {
  const r = tlTrack.getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1) * duration;
}
let dragging = null; // 'in' | 'out' | 'scrub'
function startDrag(kind, e) {
  if (!duration) return;
  dragging = kind;
  try { tlTrack.setPointerCapture(e.pointerId); } catch {}
  if (kind === 'scrub') { preview.pause(); seek(tFromEvent(e)); }
  e.preventDefault();
}
handleIn.addEventListener('pointerdown',  (e) => { e.stopPropagation(); startDrag('in', e); });
handleOut.addEventListener('pointerdown', (e) => { e.stopPropagation(); startDrag('out', e); });
tlTrack.addEventListener('pointerdown', (e) => {
  if (e.target.classList.contains('tl-region') && e.target.classList.contains('cut')) return;
  startDrag('scrub', e);
});
tlTrack.addEventListener('pointermove', (e) => {
  if (!dragging) return;
  const t = tFromEvent(e);
  if (dragging === 'in')  { cropStart = clamp(t, 0, cropEnd - frameStep()); renderTimeline(); seek(cropStart); }
  else if (dragging === 'out') { cropEnd = clamp(t, cropStart + frameStep(), duration); renderTimeline(); seek(cropEnd); }
  else { seek(t); }
});
const endDrag = () => { dragging = null; };
tlTrack.addEventListener('pointerup', endDrag);
tlTrack.addEventListener('pointercancel', endDrag);

// ---- Crop control wiring ----------------------------------------------
function updateAspectLockUI() {
  cropRectEl.classList.toggle('aspect-locked', aspectRatio() != null);
}
const readInt = (el, fallback) => { const v = parseInt(el.value, 10); return isNaN(v) ? fallback : v; };

cropAspect.addEventListener('change', () => {
  aspectMode = cropAspect.value;
  updateAspectLockUI();
  if (crop) { applyAspectToCrop(); afterCropChange(); }
});

cropXIn.addEventListener('change', () => { if (!crop) return; crop.x = readInt(cropXIn, crop.x); afterCropChange({ keepFinal: false }); });
cropYIn.addEventListener('change', () => { if (!crop) return; crop.y = readInt(cropYIn, crop.y); afterCropChange({ keepFinal: false }); });
cropWIn.addEventListener('change', () => {
  if (!crop) return;
  crop.w = readInt(cropWIn, crop.w);
  const ar = aspectRatio(); if (ar != null) crop.h = crop.w / ar;
  afterCropChange();
});
cropHIn.addEventListener('change', () => {
  if (!crop) return;
  crop.h = readInt(cropHIn, crop.h);
  const ar = aspectRatio(); if (ar != null) crop.w = crop.h * ar;
  afterCropChange();
});
finalWIn.addEventListener('change', () => {
  if (!crop) return;
  finalW = Math.max(1, readInt(finalWIn, finalW));
  finalH = Math.max(1, Math.round(finalW * crop.h / crop.w));
  syncCropInputs();
});
finalHIn.addEventListener('change', () => {
  if (!crop) return;
  finalH = Math.max(1, readInt(finalHIn, finalH));
  finalW = Math.max(1, Math.round(finalH * crop.w / crop.h));
  syncCropInputs();
});

document.querySelectorAll('.ndg').forEach((b) => b.addEventListener('click', () => {
  if (!crop) return;
  const f = fullDims();
  // "Fine" steps by one source pixel; "GIF-pixel" steps by one output pixel,
  // which is crop.w/finalW source pixels (coarser when the source is hi-res).
  const unit = b.closest('.nudge')?.dataset.unit || 'source';
  let sx = 1, sy = 1;
  if (unit === 'output') {
    sx = finalW ? crop.w / finalW : 1;
    sy = finalH ? crop.h / finalH : 1;
  }
  switch (b.dataset.nudge) {
    case 'up':    crop.y -= sy; break;
    case 'down':  crop.y += sy; break;
    case 'left':  crop.x -= sx; break;
    case 'right': crop.x += sx; break;
    case 'center': crop.x = (f.w - crop.w) / 2; crop.y = (f.h - crop.h) / 2; break;
  }
  afterCropChange({ keepFinal: false });
}));

cropReset.addEventListener('click', () => initCropForVideo());

// Drag to move / handles to resize the crop box on the preview
let cropDrag = null;
function wrapToFull(e) {
  const r = previewWrap.getBoundingClientRect();
  const f = fullDims();
  return {
    x: clamp((e.clientX - r.left) / r.width, 0, 1) * f.w,
    y: clamp((e.clientY - r.top) / r.height, 0, 1) * f.h,
  };
}
function resizeFromHandle(h, p, start) {
  const f = fullDims(), MIN = 8, ar = aspectRatio();
  let l = start.x, t = start.y, r = start.x + start.w, b = start.y + start.h;
  if (ar == null) {
    if (h.includes('w')) l = clamp(p.x, 0, r - MIN);
    if (h.includes('e')) r = clamp(p.x, l + MIN, f.w);
    if (h.includes('n')) t = clamp(p.y, 0, b - MIN);
    if (h.includes('s')) b = clamp(p.y, t + MIN, f.h);
    crop = { x: l, y: t, w: r - l, h: b - t };
  } else {
    const anchorX = h.includes('w') ? r : l;
    const anchorY = h.includes('n') ? b : t;
    let nw = Math.abs(p.x - anchorX), nh = nw / ar;
    const maxW = h.includes('w') ? anchorX : f.w - anchorX;
    const maxH = h.includes('n') ? anchorY : f.h - anchorY;
    if (nw > maxW) { nw = maxW; nh = nw / ar; }
    if (nh > maxH) { nh = maxH; nw = nh * ar; }
    nw = Math.max(nw, MIN); nh = Math.max(nh, MIN);
    crop = {
      x: h.includes('w') ? anchorX - nw : anchorX,
      y: h.includes('n') ? anchorY - nh : anchorY,
      w: nw, h: nh,
    };
  }
  afterCropChange();
}
cropRectEl.addEventListener('pointerdown', (e) => {
  if (!crop) return;
  const mode = e.target.classList.contains('ch') ? e.target.dataset.h : 'move';
  cropDrag = { mode, start: { ...crop }, p0: wrapToFull(e) };
  try { cropRectEl.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault(); e.stopPropagation();
});
cropRectEl.addEventListener('pointermove', (e) => {
  if (!cropDrag) return;
  const p = wrapToFull(e), f = fullDims();
  if (cropDrag.mode === 'move') {
    crop.x = clamp(cropDrag.start.x + (p.x - cropDrag.p0.x), 0, f.w - cropDrag.start.w);
    crop.y = clamp(cropDrag.start.y + (p.y - cropDrag.p0.y), 0, f.h - cropDrag.start.h);
    crop.w = cropDrag.start.w; crop.h = cropDrag.start.h;
    afterCropChange({ keepFinal: false });
  } else {
    resizeFromHandle(cropDrag.mode, p, cropDrag.start);
  }
});
const endCropDrag = () => { cropDrag = null; };
cropRectEl.addEventListener('pointerup', endCropDrag);
cropRectEl.addEventListener('pointercancel', endCropDrag);

// ---- Frame extraction --------------------------------------------------
function seekFor(video, t) {
  return new Promise((resolve, reject) => {
    const ok = () => { cleanup(); resolve(); };
    const bad = () => { cleanup(); reject(new Error('seek failed')); };
    const cleanup = () => {
      video.removeEventListener('seeked', ok);
      video.removeEventListener('error', bad);
    };
    video.addEventListener('seeked', ok);
    video.addEventListener('error', bad);
    video.currentTime = Math.min(t, Math.max(0, video.duration - 1e-3));
  });
}

async function framesFromVideo(fps, tf) {
  const v = preview;
  v.pause();
  stopPreviewLoop();
  extracting = true;
  try {
    const f = fullDims();
    const c = crop || { x: 0, y: 0, w: f.w, h: f.h };
    const fw = Math.max(1, finalW || c.w), fh = Math.max(1, finalH || c.h);
    // Render the full transformed frame just large enough that the cropped
    // region is at least the final resolution, then crop + scale to exact size.
    const s = Math.max(fw / c.w, fh / c.h);
    const content = {
      w: Math.max(1, Math.round(v.videoWidth * s)),
      h: Math.max(1, Math.round(v.videoHeight * s)),
    };
    const full = outputDims(content.w, content.h, tf.rotation);
    fullCanvas.width = full.w; fullCanvas.height = full.h;
    scratchCanvas.width = fw; scratchCanvas.height = fh;
    const g = scratchCanvas.getContext('2d', { willReadFrequently: true });

    const dt = 1 / fps;
    const times = [];
    for (const r of keepRanges()) {
      for (let t = r.start; t < r.end - 1e-4; t += dt) times.push(t);
    }
    if (times.length < 2) throw new Error('The kept range is too short for 2 frames.');

    const frames = [];
    // During extraction the preview is a throttled passthrough of the freshly
    // encoded frame (the scratch canvas) rather than a full re-run of the
    // drawPreview pipeline: that frame is already the WYSIWYG output, so we just
    // blit it. Size the preview canvas to the scratch canvas once up front.
    if (previewCanvas.width !== fw) previewCanvas.width = fw;
    if (previewCanvas.height !== fh) previewCanvas.height = fh;
    let lastPreviewAt = 0;
    // Fast path: with no rotation/flip the two-stage render (paint() to
    // fullCanvas, then crop-scale into scratch) is equivalent to a single
    // crop-scale drawImage straight from the video to the scratch canvas.
    // The full-frame transform stage is only needed for centered rotate/flip.
    const direct = tf.rotation === 0 && tf.flip === 'none';
    for (let i = 0; i < times.length; i++) {
      await seekFor(v, times[i]);
      g.clearRect(0, 0, fw, fh);
      if (direct) {
        g.filter = tf.filterStr;
        g.drawImage(v, c.x, c.y, c.w, c.h, 0, 0, fw, fh);
        g.filter = 'none';
      } else {
        paint(fullCtx, v, content.w, content.h, full.w, full.h, tf.rotation, tf.flip, tf.filterStr);
        g.drawImage(fullCanvas, c.x * s, c.y * s, c.w * s, c.h * s, 0, 0, fw, fh);
      }
      frames.push(finishFrame(g, fw, fh));
      // Keep the timeline cursor + progress moving every iteration (near-free
      // DOM text/style writes); throttle the on-screen frame blit to ~30fps so
      // it never stalls extraction. No extra paint/GL/getImageData here.
      setPlayhead();
      const now = performance.now();
      if (now - lastPreviewAt >= 33) {
        previewCtx.drawImage(scratchCanvas, 0, 0, fw, fh, 0, 0, previewCanvas.width, previewCanvas.height);
        lastPreviewAt = now;
      }
      setProgress((i + 1) / times.length * 0.6);
      setStatus(`Extracting frames… ${i + 1}/${times.length}`);
    }
    return { frames, w: fw, h: fh };
  } finally {
    extracting = false;
    drawPreview();
  }
}

function framesFromImages(tf) {
  const first = imageBitmaps[0].bitmap;
  const fit = fitSize(first.width, first.height);
  const out = outputDims(fit.w, fit.h, tf.rotation);
  scratchCanvas.width = out.w; scratchCanvas.height = out.h;
  const g = scratchCanvas.getContext('2d', { willReadFrequently: true });

  const frames = [];
  imageBitmaps.forEach((item, i) => {
    const b = item.bitmap;
    const s = Math.min(fit.w / b.width, fit.h / b.height);
    paint(g, b, b.width * s, b.height * s, out.w, out.h, tf.rotation, tf.flip, tf.filterStr);
    frames.push(finishFrame(g, out.w, out.h));
    setProgress((i + 1) / imageBitmaps.length * 0.6);
  });
  return { frames, w: out.w, h: out.h };
}

// ---- Encode ------------------------------------------------------------
async function runEncode(frames, w, h, durationMs, repeat) {
  const frameDurations = new Array(frames.length).fill(Math.max(1, Math.round(durationMs)));
  return encode({ frames, width: w, height: h, frameDurations,
    quality: Math.min(100, Math.max(1, parseInt(qualityIn.value, 10) || 80)), repeat });
}

// Rewrite a GIF's per-frame delay (centiseconds) and loop count in place — no
// re-encode. `loop`: -1 infinite, 0 once (drops the loop block), n finite.
// Returns a new Uint8Array; throws if the structure isn't understood.
function patchGif(src, delayCs, loop) {
  const b = src;
  if (b[0] !== 0x47 || b[1] !== 0x49 || b[2] !== 0x46) throw new Error('not a GIF');
  let p = 6;
  const packed = b[10];
  p = 13;
  if (packed & 0x80) p += 3 * (1 << ((packed & 7) + 1)); // global colour table
  const delayOffsets = [];
  let netscape = null;       // { start, countOff, end }
  while (p < b.length) {
    const block = b[p];
    if (block === 0x3B) break;                 // trailer
    if (block === 0x2C) {                       // image descriptor
      const lp = b[p + 9];
      p += 10;
      if (lp & 0x80) p += 3 * (1 << ((lp & 7) + 1)); // local colour table
      p += 1;                                   // LZW min code size
      while (b[p] !== 0) p += b[p] + 1;         // image data sub-blocks
      p += 1;
    } else if (block === 0x21) {                // extension
      const label = b[p + 1];
      if (label === 0xF9) {                      // graphic control extension
        const size = b[p + 2];
        delayOffsets.push(p + 4);               // delay is 2 bytes at +4
        p += 3 + size;
        while (b[p] !== 0) p += b[p] + 1;
        p += 1;
      } else if (label === 0xFF) {               // application extension
        const size = b[p + 2];
        const id = String.fromCharCode(...b.subarray(p + 3, p + 3 + size));
        const start = p;
        p += 3 + size;
        let countOff = null;
        if (id.startsWith('NETSCAPE') && b[p] === 0x03 && b[p + 1] === 0x01) countOff = p + 2;
        while (b[p] !== 0) p += b[p] + 1;
        p += 1;
        if (countOff != null) netscape = { start, countOff, end: p };
      } else {
        p += 2;
        while (b[p] !== 0) p += b[p] + 1;
        p += 1;
      }
    } else {
      throw new Error('unexpected GIF block 0x' + block.toString(16));
    }
  }
  let out = new Uint8Array(b);                   // copy, then edit
  const d = Math.max(0, Math.min(65535, Math.round(delayCs)));
  for (const off of delayOffsets) { out[off] = d & 0xff; out[off + 1] = (d >> 8) & 0xff; }
  if (loop === 0) {                              // play once → drop loop block
    if (netscape) {
      const merged = new Uint8Array(out.length - (netscape.end - netscape.start));
      merged.set(out.subarray(0, netscape.start), 0);
      merged.set(out.subarray(netscape.end), netscape.start);
      out = merged;
    }
  } else if (netscape) {                         // infinite (0) or finite n
    const count = loop < 0 ? 0 : loop;
    out[netscape.countOff] = count & 0xff;
    out[netscape.countOff + 1] = (count >> 8) & 0xff;
  }
  return out;
}

// Show a GIF blob as the result + download, with a meta line for the current speed.
function showResult(bytes) {
  const blob = new Blob([bytes], { type: 'image/gif' });
  if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
  lastObjectUrl = URL.createObjectURL(blob);
  resultImg.src = lastObjectUrl;
  downloadBtn.href = lastObjectUrl;
  downloadBtn.download = (mode === 'video' && videoFile
    ? videoFile.name.replace(/\.[^.]+$/, '') : 'animation') + '.gif';
  const delayCs = Math.round(currentDelayCs());
  const fps = 100 / delayCs, total = baseInfo.frames * delayCs / 100;
  resultMeta.textContent =
    `${baseInfo.w}×${baseInfo.h} · ${baseInfo.frames} frames · ${fps.toFixed(1)} fps · ${total.toFixed(1)}s · ${humanSize(blob.size)}`;
  result.classList.add('show');
}

// Per-frame delay (centiseconds) from the current timing mode (speed or duration).
function currentDuration() {
  const v = durationSel.value;
  if (v === 'custom') return Math.max(0.05, parseFloat(durationCustom.value) || 3);
  return parseFloat(v) || 3;
}
function currentDelayCs() {
  if (!baseInfo) return baseDelayCs;
  if (timingMode.value === 'duration') return Math.max(1, currentDuration() * 100 / baseInfo.frames);
  const speed = parseFloat(speedSel.value) || 1;
  return Math.max(1, baseDelayCs / speed);
}

// Apply the current timing + loop to the base GIF as a metadata-only patch.
function applyMetadata() {
  if (!lastBaseGif) return false;
  const loop = parseInt(loopSelect.value, 10);
  const delayCs = Math.max(1, Math.round(currentDelayCs()));
  try {
    showResult(patchGif(lastBaseGif, delayCs, loop));
    setStatus('Updated speed/loop instantly (no re-encode).');
    return true;
  } catch (err) {
    console.warn('GIF metadata patch failed; will re-encode.', err);
    markStale();
    return false;
  }
}

encodeBtn.addEventListener('click', async () => {
  encodeBtn.disabled = true; resetBtn.disabled = true;
  result.classList.remove('show');
  setStatus('Preparing…'); setProgress(0);
  try {
    const fps = captureFps();
    const tf = readTransform();

    const { frames, w, h } =
      mode === 'video' ? await framesFromVideo(fps, tf) : framesFromImages(tf);

    setStatus(`Encoding ${frames.length} frames with gifski…`);
    setProgress(0.7);
    await new Promise((r) => setTimeout(r, 30));

    // Encode the base at 1× speed and infinite loop; speed/loop are applied as
    // instant metadata patches afterwards (and on later changes).
    const gif = await runEncode(frames, w, h, 1000 / fps, -1);
    setProgress(1);

    lastBaseGif = new Uint8Array(gif.buffer ? gif : gif);
    baseDelayCs = 100 / fps;
    baseInfo = { frames: frames.length, w, h, fps };
    applyMetadata();
    setStatus('Done. Speed & loop now update instantly — no re-encode.');
    result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (err) {
    console.error(err);
    setStatus('Error: ' + (err && err.message ? err.message : err), true);
  } finally {
    setProgress(null);
    encodeBtn.disabled = false; resetBtn.disabled = false;
    refreshReady();
  }
});

// Timing (speed or total duration) & loop are metadata: patch the base GIF
// instantly when they change — no re-encode.
function updateTimingFields() {
  const dur = timingMode.value === 'duration';
  fieldSpeed.hidden = dur;
  fieldDuration.hidden = !dur;
  durationCustom.hidden = durationSel.value !== 'custom';
}
function onTimingChange() {
  updateTimingFields();
  if (lastBaseGif) applyMetadata();
}
timingMode.addEventListener('change', onTimingChange);
speedSel.addEventListener('change', onTimingChange);
durationSel.addEventListener('change', onTimingChange);
durationCustom.addEventListener('input', onTimingChange);
loopSelect.addEventListener('change', onTimingChange);
updateTimingFields();

// ---- Misc UI -----------------------------------------------------------
qualityIn.addEventListener('input', () => { qualityVal.textContent = qualityIn.value; });

resetBtn.addEventListener('click', () => {
  videoFile = null; imageBitmaps = []; thumbs.innerHTML = '';
  videoInfo.textContent = '';
  fileVideo.value = ''; fileImages.value = '';
  stopPreviewLoop(); extracting = false;
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  if (preview.src) { URL.revokeObjectURL(preview.src); preview.removeAttribute('src'); preview.load(); }
  if (lastObjectUrl) { URL.revokeObjectURL(lastObjectUrl); lastObjectUrl = null; }
  duration = cropStart = cropEnd = 0; cuts = []; pendingCutStart = null;
  crop = null; cropRectEl.hidden = true; cropInfo.textContent = '';
  clearLogo();
  selectColormap('none');
  curvePoints = [{ x: 0, y: 0 }, { x: 255, y: 255 }];
  invertInput.checked = false; reverseCmap.checked = false; buildCurveLut(); refreshCurveUI();
  lastBaseGif = null; baseInfo = null;
  stage.hidden = true;
  result.classList.remove('show');
  setStatus(''); setProgress(null);
  showStep('source');
  refreshReady();
});

applyMode();
showStep('source');
refreshReady();

// ---- Test hook ---------------------------------------------------------
// Exercises the full transform + encode pipeline without the OS file picker.
window.__gifskiTest = async ({ n = 3, w = 64, h = 48, rotation = 0, flip = 'none',
  filter = 'none', speed = 1, captureFps = 10, repeat = -1 } = {}) => {
  const fit = { w, h };
  const out = outputDims(fit.w, fit.h, rotation);
  scratchCanvas.width = out.w; scratchCanvas.height = out.h;
  const g = scratchCanvas.getContext('2d', { willReadFrequently: true });
  const frames = [];
  const colors = ['#d62828', '#28a745', '#1d6fd6', '#f4a300', '#7b2cbf'];
  for (let i = 0; i < n; i++) {
    const src = document.createElement('canvas'); src.width = w; src.height = h;
    const sg = src.getContext('2d');
    sg.fillStyle = colors[i % colors.length]; sg.fillRect(0, 0, w, h);
    paint(g, src, fit.w, fit.h, out.w, out.h, rotation, flip, FILTERS[filter] || 'none');
    frames.push(g.getImageData(0, 0, out.w, out.h));
  }
  const gif = await runEncode(frames, out.w, out.h, 1000 / (captureFps * speed), repeat);
  const bytes = new Uint8Array(gif.buffer || gif);
  return { header: String.fromCharCode(...bytes.slice(0, 6)), bytes: bytes.length,
    w: out.w, h: out.h, frames: frames.length };
};

// Expose the keep-range solver so its logic can be checked directly.
window.__keepRangesTest = (d, cs, ce, cutList) => {
  duration = d; cropStart = cs; cropEnd = ce; cuts = cutList;
  return keepRanges();
};
