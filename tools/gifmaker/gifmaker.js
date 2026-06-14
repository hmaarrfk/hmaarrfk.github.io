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
const dropVideo   = $('drop-video');
const preview     = $('preview');
const videoInfo   = $('video-info');

const fpsInput    = $('fps');
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
const resultsGrid = $('results-grid');
const vibePanel   = $('vibe');

// Fullscreen result viewer
const lightbox    = $('lightbox');
const lbImg       = $('lb-img');
const lbLabel     = $('lb-label');
const lbFit       = $('lb-fit');
const lbTrue      = $('lb-true');
const lbDownload  = $('lb-download');
const lbClose     = $('lb-close');

const scratchCanvas = $('scratch-canvas');
const previewCanvas = $('preview-canvas');
const previewCtx    = previewCanvas.getContext('2d');
const previewWrap   = $('preview-wrap');

// Crop UI
const cropRectEl  = $('crop-rect');
const cropOval    = $('crop-oval');
const ovalMask    = $('oval-mask');
const cropAspect  = $('crop-aspect');
const cropXIn = $('crop-x'), cropYIn = $('crop-y'), cropWIn = $('crop-w'), cropHIn = $('crop-h');
const finalWIn = $('final-w'), finalHIn = $('final-h');
const cropReset = $('crop-reset');
const cropInfo  = $('crop-info');

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
let videoFile = null;        // File

// On "Create GIF" we extract frames once and encode four size/quality variants,
// each kept as a base GIF (1× speed, infinite loop) so speed/loop are instant
// metadata patches. Invalidated when anything affecting the frames changes.
// Each variant: { key, label, baseGif, baseDelayCs, frames, w, h, effFps,
//                 quality, outUrl, outSize, delayCs }
let variants = [];
function revokeVariantUrls() { variants.forEach((v) => { if (v.outUrl) URL.revokeObjectURL(v.outUrl); }); }
function markStale() {
  // Clear each card image's src FIRST (cancels any in-flight blob load cleanly),
  // then drop the cards and revoke the URLs. Otherwise detaching a mid-load <img>
  // and revoking its blob logs ERR_FILE_NOT_FOUND. The shown results are stale
  // anyway once the frames change.
  variants.forEach((v) => { if (v.el && v.el.img) v.el.img.removeAttribute('src'); });
  resultsGrid.innerHTML = '';
  result.classList.remove('show');
  revokeVariantUrls();
  variants = [];
  updateGenerateView();  // un-collapse stage, hide star
}

// Timeline editing state (seconds)
let duration = 0;
let cropStart = 0;
let cropEnd = 0;
let cuts = [];               // [{start, end}] interior sections to drop, sorted
let pendingCutStart = null;  // armed by "Mark cut start"
let previewRaf = null;       // rAF handle for the live preview loop
let extracting = false;      // true while pulling frames, to skip preview draws
let pendingSeek = null;      // latest scrub target while a seek is in flight

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

// Tone curve (levels + gamma): three control points — min {x,0} and max {x,255}
// are the input black/white points (dragged horizontally; narrower = more
// contrast), and mid bends the gamma (dragged vertically; its x is pinned to the
// centre of [min, max]). See buildCurveLut.
let curvePoints = [{ x: 0, y: 0 }, { x: 128, y: 128 }, { x: 255, y: 255 }];
const curveLut = new Uint8Array(256);          // pipeline LUT (input-inverted when toggled)
const curveLutNatural = new Uint8Array(256);   // pre-invert LUT, used to draw the editor
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
  if (maskActive()) applyOvalMask(previewCtx, ow, oh);       // transparent corners (before the logo)
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
  const cap = 480;
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
  encodeBtn.disabled = !videoFile;
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
// Build the 256-entry LUT as a levels + gamma curve from three control points:
// min and max are the input black/white points (input ≤ min → 0, ≥ max → 255),
// and mid sets the gamma. Narrowing [min, max] steepens the slope → more
// contrast (with clipping at the ends); widening it reduces contrast. The mapped
// range is
//   out = 255 · ((x - min)/(max - min))^γ,   with γ from the mid point's height
// (mid sits at the centre of the range, where out = 255·0.5^γ).
function buildCurveLut() {
  const minX = curvePoints[0].x, maxX = curvePoints[2].x, midY = curvePoints[1].y;
  const span = maxX - minX;
  const gamma = Math.log(clamp(midY / 255, 0.001, 0.999)) / Math.log(0.5);
  let identity = true;
  for (let x = 0; x < 256; x++) {
    let y;
    if (span <= 0) y = x < maxX ? 0 : 255;
    else if (x <= minX) y = 0;
    else if (x >= maxX) y = 255;
    else y = 255 * Math.pow((x - minX) / span, gamma);
    y = Math.round(clamp(y, 0, 255));
    curveLutNatural[x] = y;
    curveLut[x] = y;
    if (y !== x) identity = false;
  }
  // "Invert input" feeds value 255-x through the curve, so the selected range +
  // midpoint invert together (distinct from reversing the colormap, which flips
  // the output colours at lookup time). Only the *pipeline* LUT is flipped here;
  // the editor keeps the natural LUT and instead mirrors its input (X) axis, so
  // the curve, handles, input histogram and axis ramp all move together.
  if (invertInput.checked) {
    for (let x = 0; x < 256; x++) curveLut[x] = curveLutNatural[255 - x];
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

function maskActive() { return !!(ovalMask && ovalMask.checked); }
// Clip ctx to the inscribed ellipse: everything outside becomes transparent
// (GIF transparency). Done before the logo so a watermark still draws on top.
function applyOvalMask(ctx, w, h) {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-in';
  ctx.filter = 'none';
  ctx.fillStyle = '#fff';
  ctx.beginPath();
  ctx.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// Apply colormap + oval mask + logo to a finished output frame and read it back.
function finishFrame(g, w, h) {
  const mask = maskActive();
  if (colormapActive() || curveActive()) {
    // Fast path: no logo and no mask means the GL result is the final frame, so
    // read it straight off the GPU (skip the extra drawImage + getImageData).
    if (!logoBitmap && !mask) {
      const glOut = glPixelEffects(g.canvas, w, h, true);
      if (glOut && glOut.pixels) {
        // The buffer is reused next call; copy so the pushed frame is stable.
        return { data: glOut.pixels.slice(), width: w, height: h };
      }
    }
    // Logo/mask present (or readback failed): run the effect onto the 2D canvas
    // so the mask + logo can be composited in 2D afterwards.
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
  if (mask) applyOvalMask(g, w, h);          // transparent corners (before the logo)
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

// After the Trim step the timeline is "compressed": it represents only the kept
// content (trim + cuts removed), mapped to one continuous bar. These convert
// between real video time and compressed output time.
function keptDurationTotal() { return keepRanges().reduce((a, r) => a + (r.end - r.start), 0); }
function toOutputTime(t) {                     // video time → compressed time
  let acc = 0;
  for (const r of keepRanges()) {
    if (t <= r.start) break;
    if (t >= r.end) acc += r.end - r.start;
    else { acc += t - r.start; break; }
  }
  return acc;
}
function fromOutputTime(o) {                    // compressed time → video time
  const ranges = keepRanges();
  let acc = 0;
  for (const r of ranges) {
    const d = r.end - r.start;
    if (o <= acc + d) return r.start + (o - acc);
    acc += d;
  }
  return ranges.length ? ranges[ranges.length - 1].end : 0;
}
function timelineCompressed() { return currentStep !== 'source' && currentStep !== 'trim'; }
function playheadPct(t) {
  if (timelineCompressed()) { const k = keptDurationTotal(); return k ? toOutputTime(t) / k * 100 : 0; }
  return pct(t);
}

// Compressed timeline (steps after Trim): one continuous kept bar, no handles/cuts.
function renderCompressedTimeline() {
  handleIn.hidden = true; handleOut.hidden = true;
  tlRegions.innerHTML = '';
  const el = document.createElement('div');
  el.className = 'tl-region keep';
  el.style.left = '0%'; el.style.width = '100%';
  tlRegions.appendChild(el);
  tlPending.style.display = 'none';
  cutInfo.textContent = '';
  const removeBtn = document.querySelector('[data-act="cutEnd"]');
  if (removeBtn) removeBtn.classList.remove('armed');
  setPlayhead();
}

function renderTimeline() {
  if (timelineCompressed()) { renderCompressedTimeline(); return; }
  handleIn.hidden = false; handleOut.hidden = false;
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

// Position the cursor/timecode at an explicit time (used during scrubbing so the
// cursor tracks the finger immediately, without waiting for the slow video seek).
function renderPlayhead(t) {
  playhead.style.left = playheadPct(t) + '%';
  const fps = captureFps();
  if (timelineCompressed()) {
    const o = toOutputTime(t), k = keptDurationTotal();
    timecode.textContent = `${fmtTime(o)} / ${fmtTime(k)} · frame ${Math.round(o * fps)}`;
    tlPending.style.display = 'none';
  } else {
    timecode.textContent = `${fmtTime(t)} / ${fmtTime(duration)} · frame ${Math.round((t || 0) * fps)}`;
    updatePending();
  }
}
function setPlayhead() { renderPlayhead(preview.currentTime || 0); }

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
  // While the crop box is editable (full-frame steps), stop the preview surface
  // from scrolling the page during a drag; allow normal scrolling otherwise.
  const ta = ROI_STEPS.has(name) ? '' : 'none';
  previewWrap.style.touchAction = ta;
  previewCanvas.style.touchAction = ta;
  if (preview.videoWidth) renderTimeline();  // full (edit) ⇄ compressed timeline
  updateGenerateView();
  updateOvalUI();
  drawPreview();  // switch full-frame ⇄ ROI-only view for the new step
}
// Once the GIFs are generated, the Export step becomes a focused view: collapse
// the input-video stage (kept display:block via a class so the decode-source
// <video> stays rendered) and reveal the "star us on GitHub" ask alongside the
// output. Before generating, the preview stays visible and the star ask hidden.
function updateGenerateView() {
  const focus = currentStep === 'export' && variants.length > 0;
  stage.classList.toggle('collapsed', focus);
  vibePanel.hidden = !focus;
}
stepBtns.forEach((b) => b.addEventListener('click', () => showStep(b.dataset.step)));

// Oval mask: dashed ellipse guide on the crop box + checkerboard behind the
// preview (so transparent corners read as transparent).
function updateOvalUI() {
  if (cropOval) cropOval.hidden = !maskActive();
  previewCanvas.classList.toggle('masked', maskActive());
}
if (ovalMask) ovalMask.addEventListener('change', () => { updateOvalUI(); markStale(); drawPreview(); });

// ---- Drag & drop wiring ------------------------------------------------
// Click-to-open dropzone (source video + the optional logo).
function wireDrop(zone, input, onFiles) {
  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => onFiles([...input.files]));
  ['dragenter', 'dragover'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.add('over'); }));
  ['dragleave', 'drop'].forEach((ev) =>
    zone.addEventListener(ev, (e) => { e.preventDefault(); zone.classList.remove('over'); }));
  zone.addEventListener('drop', (e) => onFiles([...e.dataTransfer.files]));
}
wireDrop(dropVideo, fileVideo, (files) => {
  const f = files.find((x) => x.type.startsWith('video/')) || files[0];
  if (f) loadVideo(f);
  else setStatus('Unsupported file — please choose a video.', true);
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
    showStep('trim');
    refreshReady();
    // iOS Safari won't draw a video frame to a canvas until the (rendered) video
    // has actually played once. Prime it (muted playsinline autoplay is allowed),
    // then snap back to the start and paint the first frame.
    primeDecode().then(() => { seek(0); setPlayhead(); drawPreview(); });
  };
  preview.onerror = () =>
    setStatus('Could not load that video — your browser may not support its format.', true);
}
function primeDecode() {
  return Promise.resolve(preview.play())
    .then(() => new Promise((res) => requestAnimationFrame(() => { preview.pause(); res(); })))
    .catch(() => { try { preview.pause(); } catch {} });
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
preview.addEventListener('seeked', () => {
  setPlayhead(); drawPreview();
  if (pendingSeek != null && !extracting) { const t = pendingSeek; pendingSeek = null; seek(t); }
});
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

// Live colormap-picker thumbnails: the current cropped frame's selected channel
// recoloured by each colormap, so the dropdown previews the actual look (more fun
// than an abstract gradient). The thumbnail matches the chosen crop + output
// aspect ratio (rotation/flip applied) so the previews aren't stretched. The
// channel is captured when the list opens; recoloured data URLs are cached per
// key. Falls back to swatchCss when no frame is loaded.
const CM_THUMB_CAP = 64;          // longest thumbnail edge (px)
const cmSrcCanvas = document.createElement('canvas');
const cmSrcCtx = cmSrcCanvas.getContext('2d', { willReadFrequently: true });
const cmThumbCanvas = document.createElement('canvas');
const cmThumbCtx = cmThumbCanvas.getContext('2d', { willReadFrequently: true });
let cmThumbChannel = null;        // Uint8Array of channel values for the cropped frame
const cmThumbCache = new Map();   // colormap key → data URL
function refreshCmThumbs() {
  cmThumbCache.clear();
  cmThumbChannel = null;
  if (!preview.videoWidth) return;
  try {
    const tf = readTransform();
    const f = fullDims();
    const c = crop || { x: 0, y: 0, w: f.w, h: f.h };
    // Thumbnail dims follow the output aspect (final size, else the crop).
    const aw = finalW || c.w, ah = finalH || c.h;
    let tw, th;
    if (aw >= ah) { tw = CM_THUMB_CAP; th = Math.max(1, Math.round(CM_THUMB_CAP * ah / aw)); }
    else { th = CM_THUMB_CAP; tw = Math.max(1, Math.round(CM_THUMB_CAP * aw / ah)); }
    // Render the full transformed frame, then crop it into the thumbnail (same
    // two-step approach as the ROI preview / extraction).
    const s2 = tw / c.w;
    const content = { w: Math.max(1, Math.round(preview.videoWidth * s2)),
                      h: Math.max(1, Math.round(preview.videoHeight * s2)) };
    const full = outputDims(content.w, content.h, tf.rotation);
    cmSrcCanvas.width = full.w; cmSrcCanvas.height = full.h;
    paint(cmSrcCtx, preview, content.w, content.h, full.w, full.h, tf.rotation, tf.flip, tf.filterStr);
    cmThumbCanvas.width = tw; cmThumbCanvas.height = th;
    cmThumbCtx.clearRect(0, 0, tw, th);
    cmThumbCtx.drawImage(cmSrcCanvas, c.x * s2, c.y * s2, c.w * s2, c.h * s2, 0, 0, tw, th);
    const data = cmThumbCtx.getImageData(0, 0, tw, th).data;
    const ch = channelSel.value, n = tw * th, out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const p = i * 4;
      let v = ch === 'r' ? data[p] : ch === 'g' ? data[p + 1] : ch === 'b' ? data[p + 2]
            : (data[p] * 0.299 + data[p + 1] * 0.587 + data[p + 2] * 0.114) | 0;
      out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
    cmThumbChannel = out;
  } catch { cmThumbChannel = null; }
}
function cmThumbUrl(key) {
  if (!cmThumbChannel) return null;
  if (cmThumbCache.has(key)) return cmThumbCache.get(key);
  const cm = ALL_CM[key === 'none' ? 'gray' : key];
  if (!cm) return null;
  const w = cmThumbCanvas.width, h = cmThumbCanvas.height, n = w * h;
  const lut = cm.lut, rev = reverseCmap.checked, cv = curveActive();
  const id = cmThumbCtx.createImageData(w, h), d = id.data;
  for (let i = 0; i < n; i++) {
    let v = cmThumbChannel[i];
    if (cv) v = curveLut[v];
    const c = lut[rev ? 255 - v : v], p = i * 4;
    d[p] = c[0]; d[p + 1] = c[1]; d[p + 2] = c[2]; d[p + 3] = 255;
  }
  cmThumbCtx.putImageData(id, 0, 0);
  const url = cmThumbCanvas.toDataURL();
  cmThumbCache.set(key, url);
  return url;
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
      const url = cmThumbUrl(o.key);
      const sw = url ? `background-image:url(${url})` : swatchCss(o.key);
      el.innerHTML = `<span class="swatch" style="${sw}"></span><span>${o.name}</span>`;
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
colormapSearch.addEventListener('focus', () => { refreshCmThumbs(); renderCmList(''); });
colormapSearch.addEventListener('input', () => renderCmList(colormapSearch.value));
colormapSearch.addEventListener('keydown', (e) => {
  if (colormapList.hidden && e.key === 'ArrowDown') { refreshCmThumbs(); renderCmList(colormapSearch.value); return; }
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
// Draw a 256-bin histogram. `area` is the rectangle the bars live in; `xmap(i)`
// returns the left x for bin i (so callers can mirror/inset the axis). `color`
// is a fixed fill, or `colorFn(i)` returns a per-bar colour.
function drawHistBars(ctx, hist, color, colorFn, area, xmap) {
  const log = histLog.checked;
  const f = (v) => (log ? Math.log1p(v) : v);
  let max = 0;
  for (let i = 0; i < 256; i++) { const v = f(hist[i]); if (v > max) max = v; }
  if (max <= 0) return;
  if (!colorFn) ctx.fillStyle = color;
  const bw = Math.max(1, area.w / 256), baseY = area.y + area.h;
  for (let i = 0; i < 256; i++) {
    const h = f(hist[i]) / max * (area.h - 1);
    if (h > 0) { if (colorFn) ctx.fillStyle = colorFn(i); ctx.fillRect(xmap(i), baseY - h, bw, h); }
  }
}

// The curve canvas leaves thin margins for two live axis ramps: an INPUT
// grayscale ramp along the bottom (mirrors with "invert input") and an OUTPUT
// colour ramp up the left edge (the effective colormap, mirrors with "reverse
// colormap"). The plot — curve, handles, input histogram, diagonal — lives in
// the inset area, all sharing one invert-aware transform.
const CURVE_ML = 12, CURVE_MB = 12;
function plotW(c) { return (c.width - 1) - CURVE_ML; }
function plotH(c) { return (c.height - 1) - CURVE_MB; }
// Input value (0..255) → x, flipped when "invert input" is on (so the curve,
// handles, input histogram and bottom ramp all mirror together). cpy maps an
// output value → y (the output axis never inverts); yToVal is its inverse, used
// to turn a pointer's y into the dragged point's output value.
function cpx(c, v) { const f = invertInput.checked ? (1 - v / 255) : (v / 255); return CURVE_ML + f * plotW(c); }
function cpy(c, v) { return plotH(c) - v / 255 * plotH(c); }
function xToVal(c, px) { let f = (px - CURVE_ML) / plotW(c); if (invertInput.checked) f = 1 - f; return clamp(Math.round(f * 255), 0, 255); }
function yToVal(c, py) { return clamp(Math.round((1 - py / plotH(c)) * 255), 0, 255); }
function drawCurveRamps(c, ctx) {
  const pw = plotW(c), ph = plotH(c), bw = Math.max(1, pw / 256) + 1, bh = Math.max(1, ph / 256) + 1;
  for (let i = 0; i < 256; i++) {                  // bottom: input grayscale ramp
    ctx.fillStyle = `rgb(${i},${i},${i})`;
    ctx.fillRect(cpx(c, i), ph + 2, bw, CURVE_MB - 2);
  }
  const lut = colormapActive() ? ALL_CM[effectiveColormapKey()].lut : null;
  const rev = reverseCmap.checked;
  for (let v = 0; v < 256; v++) {                   // left: output colormap ramp
    const cc = lut ? lut[rev ? 255 - v : v] : [v, v, v];
    ctx.fillStyle = `rgb(${cc[0]},${cc[1]},${cc[2]})`;
    ctx.fillRect(0, cpy(c, v), CURVE_ML - 2, bh);
  }
}
function drawCurve() {
  const c = curveCanvas, ctx = curveCtx, W = c.width, H = c.height, pw = plotW(c), ph = plotH(c);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#16181b'; ctx.fillRect(0, 0, W, H);
  drawHistBars(ctx, inputHist, 'rgba(125,145,165,.40)', null,
    { x: CURVE_ML, y: 0, w: pw, h: ph }, (i) => cpx(c, i));
  ctx.strokeStyle = 'rgba(255,255,255,.08)'; ctx.lineWidth = 1; ctx.beginPath();
  for (let g = 1; g < 4; g++) {
    const gx = CURVE_ML + g / 4 * pw, gy = g / 4 * ph;
    ctx.moveTo(gx, 0); ctx.lineTo(gx, ph);
    ctx.moveTo(CURVE_ML, gy); ctx.lineTo(W - 1, gy);
  }
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,.20)'; ctx.beginPath();    // identity diagonal (displayed space)
  ctx.moveTo(cpx(c, 0), cpy(c, 0)); ctx.lineTo(cpx(c, 255), cpy(c, 255)); ctx.stroke();
  drawCurveRamps(c, ctx);
  ctx.strokeStyle = '#00bc8c'; ctx.lineWidth = 2; ctx.beginPath();
  for (let x = 0; x < 256; x++) { const X = cpx(c, x), Y = cpy(c, curveLutNatural[x]); x === 0 ? ctx.moveTo(X, Y) : ctx.lineTo(X, Y); }
  ctx.stroke();
  ctx.fillStyle = '#fff';
  for (const pt of curvePoints) { ctx.beginPath(); ctx.arc(cpx(c, pt.x), cpy(c, pt.y), 4, 0, 7); ctx.fill(); }
}
function drawHistOut() {
  const c = histOut, ctx = histOutCtx;
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.fillStyle = '#16181b'; ctx.fillRect(0, 0, c.width, c.height);
  // Tint each output bar with the colour the (effective) colormap gives that
  // value; grayscale when there's no colormap. Reflects "reverse colormap".
  const lut = colormapActive() ? ALL_CM[effectiveColormapKey()].lut : null;
  const rev = reverseCmap.checked;
  const colorFn = lut
    ? (i) => { const cc = lut[rev ? 255 - i : i]; return `rgb(${cc[0]},${cc[1]},${cc[2]})`; }
    : (i) => `rgb(${i},${i},${i})`;
  drawHistBars(ctx, outputHist, null, colorFn,
    { x: 0, y: 0, w: c.width - 1, h: c.height - 1 }, (i) => i / 255 * (c.width - 1));
}
function refreshCurveUI() { drawCurve(); drawHistOut(); }
function onCurveEdit() { buildCurveLut(); markStale(); drawPreview(); refreshCurveUI(); }

// min (0) and max (2) are input black/white points dragged horizontally; mid (1)
// is dragged vertically for gamma. Moving min/max recentres mid's x, which keeps
// the gamma (mid.y) unchanged. Grab the point nearest the pointer (2-D).
let curveDrag = -1;
function evToVal(e) {
  const c = curveCanvas, r = c.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width * c.width;
  const py = (e.clientY - r.top) / r.height * c.height;
  return { x: xToVal(c, px), y: yToVal(c, py) };
}
function nearestPoint(e) {
  const c = curveCanvas, r = c.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width * c.width;
  const py = (e.clientY - r.top) / r.height * c.height;
  let best = -1, bd = Infinity;
  for (let i = 0; i < curvePoints.length; i++) {
    const dx = cpx(c, curvePoints[i].x) - px, dy = cpy(c, curvePoints[i].y) - py;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}
function applyCurveDrag(e) {
  const v = evToVal(e), lo = curvePoints[0], mid = curvePoints[1], hi = curvePoints[2];
  if (curveDrag === 0)      { lo.x = clamp(v.x, 0, hi.x - 2);   mid.x = Math.round((lo.x + hi.x) / 2); }
  else if (curveDrag === 2) { hi.x = clamp(v.x, lo.x + 2, 255); mid.x = Math.round((lo.x + hi.x) / 2); }
  else                      { mid.y = clamp(v.y, 1, 254); }
  onCurveEdit();
}
curveCanvas.addEventListener('pointerdown', (e) => {
  curveDrag = nearestPoint(e);
  try { curveCanvas.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault();
  applyCurveDrag(e);
});
curveCanvas.addEventListener('pointermove', (e) => { if (curveDrag >= 0) applyCurveDrag(e); });
const endCurveDrag = () => { curveDrag = -1; };
curveCanvas.addEventListener('pointerup', endCurveDrag);
curveCanvas.addEventListener('pointercancel', endCurveDrag);
histLog.addEventListener('change', refreshCurveUI);
invertInput.addEventListener('change', onCurveEdit);              // changes the value LUT
reverseCmap.addEventListener('change', () => { markStale(); drawPreview(); refreshCurveUI(); }); // colormap only
curveReset.addEventListener('click', () => {
  curvePoints = [{ x: 0, y: 0 }, { x: 128, y: 128 }, { x: 255, y: 255 }];
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
[fpsInput, qualityIn, rotateSel, flipSel, filterSel].forEach(
  (el) => el.addEventListener('change', markStale));

// ---- Transport + timeline interaction ----------------------------------
document.querySelectorAll('.transport .tbtn').forEach((b) =>
  b.addEventListener('click', () => transport(b.dataset.act)));
document.querySelectorAll('.tl-actions [data-act]').forEach((b) =>
  b.addEventListener('click', () => transport(b.dataset.act)));

// Step one frame. On the compressed steps (after Trim) we step in OUTPUT time so
// the cut sections are skipped — stepping past a cut jumps straight to the next
// kept frame, exactly as the final GIF plays. On Source/Trim we step in real time
// (you're still defining the cuts there, so the full timeline is shown).
function stepFrame(dir) {
  const dt = frameStep();
  if (timelineCompressed()) {
    const k = keptDurationTotal();
    const o = clamp(toOutputTime(preview.currentTime) + dir * dt, 0, Math.max(0, k - 1e-3));
    seek(fromOutputTime(o));
  } else {
    seek(preview.currentTime + dir * dt);
  }
}
function transport(act) {
  switch (act) {
    case 'play':      preview.paused ? preview.play() : preview.pause(); break;
    case 'prevFrame': preview.pause(); stepFrame(-1); break;
    case 'nextFrame': preview.pause(); stepFrame(1); break;
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
  // While the fullscreen viewer is open, Esc closes it and other keys are ignored
  // (so they don't drive the video behind it).
  if (lightbox && !lightbox.hidden) { if (e.key === 'Escape') { e.preventDefault(); closeLightbox(); } return; }
  if (!videoFile) return;
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
// Scrub target in video time, accounting for the compressed timeline after Trim.
function scrubTimeFromEvent(e) {
  const r = tlTrack.getBoundingClientRect();
  const frac = clamp((e.clientX - r.left) / r.width, 0, 1);
  return timelineCompressed() ? fromOutputTime(frac * keptDurationTotal()) : frac * duration;
}
let dragging = null; // 'in' | 'out' | 'scrub'
// Coalesce seeks while scrubbing: video seeking is slow (esp. on mobile), so
// only issue a new seek once the previous one finishes, always to the latest
// finger position (flushed in the 'seeked' handler above).
function requestSeek(t) {
  if (preview.seeking) pendingSeek = t;
  else seek(t);
}
function startDrag(kind, e) {
  if (!duration) return;
  dragging = kind;
  try { tlTrack.setPointerCapture(e.pointerId); } catch {}
  if (kind === 'scrub') { preview.pause(); const t = scrubTimeFromEvent(e); renderPlayhead(t); requestSeek(t); }
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
  if (dragging === 'in')  { const t = tFromEvent(e); cropStart = clamp(t, 0, cropEnd - frameStep()); renderTimeline(); renderPlayhead(cropStart); requestSeek(cropStart); }
  else if (dragging === 'out') { const t = tFromEvent(e); cropEnd = clamp(t, cropStart + frameStep(), duration); renderTimeline(); renderPlayhead(cropEnd); requestSeek(cropEnd); }
  else { const t = scrubTimeFromEvent(e); renderPlayhead(t); requestSeek(t); }
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
// Move the crop so its centre is at point p ({x,y} in displayed source px).
function recenterCropTo(p) {
  if (!crop) return;
  const f = fullDims();
  crop.x = clamp(p.x - crop.w / 2, 0, f.w - crop.w);
  crop.y = clamp(p.y - crop.h / 2, 0, f.h - crop.h);
  afterCropChange({ keepFinal: false });
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
  cropDrag = { mode, start: { ...crop }, p0: wrapToFull(e), p0c: { x: e.clientX, y: e.clientY }, moved: false };
  try { cropRectEl.setPointerCapture(e.pointerId); } catch {}
  e.preventDefault(); e.stopPropagation();
});
cropRectEl.addEventListener('pointermove', (e) => {
  if (!cropDrag) return;
  e.preventDefault();
  // Treat sub-threshold movement as a tap (recenter on release); only start an
  // actual move/resize once the finger has clearly moved.
  if (!cropDrag.moved && Math.hypot(e.clientX - cropDrag.p0c.x, e.clientY - cropDrag.p0c.y) <= 8) return;
  cropDrag.moved = true;
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
cropRectEl.addEventListener('pointerup', () => {
  // A tap inside the box (no drag) recenters the crop on the tapped point, so
  // positioning works anywhere on the image — inside or outside the box.
  if (cropDrag && !cropDrag.moved && cropDrag.mode === 'move') recenterCropTo(cropDrag.p0);
  cropDrag = null;
});
cropRectEl.addEventListener('pointercancel', () => { cropDrag = null; });

// Tap the image (the area outside the crop box) to move the crop's CENTRE there
// — easier than dragging on touch. Only while the crop box is editable. Taps on
// the box/handles are handled by their own listeners (they stop propagation).
previewWrap.addEventListener('pointerdown', (e) => {
  if (!crop || roiView()) return;
  recenterCropTo(wrapToFull(e));   // tap on the dimmed area (outside the box)
  e.preventDefault();
});

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

    const ranges = keepRanges();
    const total = ranges.reduce((a, r) => a + (r.end - r.start), 0);
    const times = [];
    if (timingMode.value === 'duration') {
      // The output is exactly fps × duration frames, sampled evenly across the
      // kept content (so a 3 s @ 15 fps GIF extracts 45 frames, not the whole
      // source). fromOutputTime maps compressed time → source video time.
      const n = Math.max(2, Math.round(fps * currentDuration()));
      for (let i = 0; i < n; i++) times.push(fromOutputTime(total * (i + 0.5) / n));
    } else {
      // Speed mode: sample the kept content at the capture rate (1/fps apart);
      // speed just changes the playback delay afterwards.
      const dt = 1 / fps;
      for (const r of ranges) for (let t = r.start; t < r.end - 1e-4; t += dt) times.push(t);
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


// ---- Encode ------------------------------------------------------------
async function runEncode(frames, w, h, durationMs, repeat, quality = 80) {
  const frameDurations = new Array(frames.length).fill(Math.max(1, Math.round(durationMs)));
  return encode({ frames, width: w, height: h, frameDurations,
    quality: Math.min(100, Math.max(1, quality)), repeat });
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

// Per-frame delay (centiseconds) from the current timing mode (speed or duration).
function currentDuration() {
  const v = durationSel.value;
  if (v === 'custom') return Math.max(0.05, parseFloat(durationCustom.value) || 3);
  return parseFloat(v) || 3;
}
function variantDelayCs(v) {
  if (timingMode.value === 'duration') return Math.max(1, currentDuration() * 100 / v.frames);
  return Math.max(1, v.baseDelayCs / (parseFloat(speedSel.value) || 1));
}

// Build the variant cards once per encode (structure only). Each card's <img>,
// meta and download link are kept on `v.el` and updated in place by later
// metadata patches, so we never detach a mid-load <img> (which would error when
// its blob URL is revoked).
function buildResultCards() {
  resultsGrid.innerHTML = '';
  const base = videoFile ? videoFile.name.replace(/\.[^.]+$/, '') : 'animation';
  variants.forEach((v) => {
    const card = document.createElement('div'); card.className = 'result-card';
    const img = document.createElement('img'); img.alt = v.label;
    const lab = document.createElement('div'); lab.className = 'rc-label'; lab.textContent = v.label;
    const meta = document.createElement('div'); meta.className = 'rc-meta';
    const dl = document.createElement('a'); dl.className = 'btn good small-btn';
    dl.textContent = 'Download'; dl.download = `${base}-${v.key}.gif`;
    img.title = 'Click to view full screen';
    img.addEventListener('click', () => openLightbox(v.outUrl, v.label, dl.download));
    card.append(img, lab, meta, dl);
    resultsGrid.appendChild(card);
    v.el = { img, meta, dl };
  });
  result.classList.add('show');
}
// ---- Fullscreen result viewer -----------------------------------------
function setLbMode(mode) {
  const fit = mode !== 'true';
  lightbox.classList.toggle('fit', fit);
  lightbox.classList.toggle('true', !fit);
  lbFit.classList.toggle('active', fit);
  lbTrue.classList.toggle('active', !fit);
}
function openLightbox(url, label, downloadName) {
  if (!url) return;
  lbImg.src = url;
  lbLabel.textContent = label || '';
  lbDownload.href = url;
  lbDownload.download = downloadName || 'animation.gif';
  setLbMode('fit');
  lightbox.hidden = false;
}
function closeLightbox() {
  if (lightbox.hidden) return;
  lightbox.hidden = true;
  lbImg.removeAttribute('src');
}
if (lightbox) {
  lbFit.addEventListener('click', () => setLbMode('fit'));
  lbTrue.addEventListener('click', () => setLbMode('true'));
  lbClose.addEventListener('click', closeLightbox);
  // Click the backdrop (the overlay or stage, not the image/buttons) to close.
  lightbox.addEventListener('click', (e) => {
    if (e.target === lightbox || e.target.id === 'lb-stage') closeLightbox();
  });
}
// Update the existing cards' image/meta/link to the current variant URLs.
function refreshResultCards() {
  variants.forEach((v) => {
    if (!v.el) return;
    const fps = v.delayCs ? 100 / v.delayCs : v.effFps;
    const total = v.frames * (v.delayCs || 0) / 100;
    v.el.img.src = v.outUrl;       // reassigning src cancels any pending load cleanly
    v.el.dl.href = v.outUrl;
    v.el.meta.textContent =
      `${v.w}×${v.h} · ${v.frames}f · ${fps.toFixed(1)}fps · ${total.toFixed(1)}s · q${v.quality} · ${humanSize(v.outSize)}`;
  });
}

// Apply the current timing + loop to every variant base GIF (metadata-only
// patch). Pass { rebuild: true } after an encode to (re)create the cards.
function applyMetadata({ rebuild = false } = {}) {
  if (!variants.length) return false;
  const loop = parseInt(loopSelect.value, 10);
  try {
    if (rebuild) buildResultCards();
    const stale = [];
    variants.forEach((v) => {
      const delayCs = Math.max(1, Math.round(variantDelayCs(v)));
      const blob = new Blob([patchGif(v.baseGif, delayCs, loop)], { type: 'image/gif' });
      if (v.outUrl) stale.push(v.outUrl);
      v.outUrl = URL.createObjectURL(blob);
      v.outSize = blob.size; v.delayCs = delayCs;
    });
    refreshResultCards();
    // The cards now point at the fresh URLs; revoking the previous ones can't
    // strand a visible <img>.
    stale.forEach((u) => URL.revokeObjectURL(u));
    return true;
  } catch (err) {
    console.warn('GIF metadata patch failed; will re-encode.', err);
    markStale();
    return false;
  }
}

// The size/quality variants produced on every "Create GIF". They share a single
// frame-extraction pass; the smaller ones drop to half the frame rate and/or
// lower gifski's quality. The user picks which to download.
const VARIANT_DEFS = [
  { key: 'high',   label: 'High quality',     fpsDiv: 1, qMul: 1 },
  { key: 'medium', label: 'Medium',           fpsDiv: 2, qMul: 1 },
  { key: 'small',  label: 'High compression', fpsDiv: 2, qMul: 0.75 },
];

encodeBtn.addEventListener('click', async () => {
  encodeBtn.disabled = true; resetBtn.disabled = true;
  result.classList.remove('show');
  markStale();
  setStatus('Preparing…'); setProgress(0);
  try {
    const fps = captureFps();
    const tf = readTransform();
    const Q = parseInt(qualityIn.value, 10) || 80;

    // Extract every frame once at full rate; variants reuse this set.
    const { frames, w, h } = await framesFromVideo(fps, tf);

    // Build distinct variant specs (skip any that subsample below 2 frames or
    // duplicate another variant's frame-count + quality combination).
    const specs = [];
    const seen = new Set();
    for (const def of VARIANT_DEFS) {
      const sub = def.fpsDiv > 1 ? frames.filter((_, i) => i % def.fpsDiv === 0) : frames;
      if (sub.length < 2) continue;
      const quality = Math.max(1, Math.min(100, Math.round(Q * def.qMul)));
      const sig = sub.length + ':' + quality;
      if (seen.has(sig)) continue;
      seen.add(sig);
      specs.push({ ...def, sub, quality, effFps: fps / def.fpsDiv });
    }

    variants = [];
    for (let i = 0; i < specs.length; i++) {
      const sp = specs[i];
      setStatus(`Encoding ${sp.label} — ${sp.sub.length} frames with gifski…`);
      setProgress(0.6 + 0.4 * (i / specs.length));
      await new Promise((r) => setTimeout(r, 20));
      // Each base GIF is 1× speed + infinite loop; speed/loop become instant
      // metadata patches afterwards (and on later timing/loop changes).
      const gif = await runEncode(sp.sub, w, h, 1000 / sp.effFps, -1, sp.quality);
      variants.push({
        key: sp.key, label: sp.label,
        baseGif: new Uint8Array(gif),
        baseDelayCs: 100 / sp.effFps,
        frames: sp.sub.length, w, h, effFps: sp.effFps,
        quality: sp.quality, outUrl: null, outSize: 0, delayCs: 0,
      });
    }
    setProgress(1);

    applyMetadata({ rebuild: true });
    updateGenerateView();   // now generated: collapse the preview, reveal the star ask
    setStatus('Done — pick a size to download. Speed & loop update instantly.');
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
  if (variants.length) applyMetadata();
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
  videoFile = null;
  videoInfo.textContent = '';
  fileVideo.value = '';
  stopPreviewLoop(); extracting = false;
  previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
  if (preview.src) { URL.revokeObjectURL(preview.src); preview.removeAttribute('src'); preview.load(); }
  markStale();
  duration = cropStart = cropEnd = 0; cuts = []; pendingCutStart = null;
  crop = null; cropRectEl.hidden = true; cropInfo.textContent = '';
  clearLogo();
  selectColormap('none');
  curvePoints = [{ x: 0, y: 0 }, { x: 128, y: 128 }, { x: 255, y: 255 }];
  invertInput.checked = false; reverseCmap.checked = false; buildCurveLut(); refreshCurveUI();
  if (ovalMask) ovalMask.checked = false; updateOvalUI();
  resultsGrid.innerHTML = '';
  stage.hidden = true;
  result.classList.remove('show');
  setStatus(''); setProgress(null);
  showStep('source');
  refreshReady();
});

showStep('source');
refreshReady();

// ---- Test hook ---------------------------------------------------------
// Exercises the full transform + encode pipeline without the OS file picker.
window.__gifskiTest = async ({ n = 3, w = 64, h = 48, rotation = 0, flip = 'none',
  filter = 'none', speed = 1, captureFps = 10, repeat = -1, quality = 80 } = {}) => {
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
  const gif = await runEncode(frames, out.w, out.h, 1000 / (captureFps * speed), repeat, quality);
  const bytes = new Uint8Array(gif.buffer || gif);
  return { header: String.fromCharCode(...bytes.slice(0, 6)), bytes: bytes.length,
    w: out.w, h: out.h, frames: frames.length };
};

// Expose the keep-range solver so its logic can be checked directly.
window.__keepRangesTest = (d, cs, ce, cutList) => {
  duration = d; cropStart = cs; cropEnd = ce; cuts = cutList;
  return keepRanges();
};
