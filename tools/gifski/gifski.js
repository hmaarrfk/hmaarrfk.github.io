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

// ---- DOM ---------------------------------------------------------------
const $ = (id) => document.getElementById(id);

const tabs        = document.querySelectorAll('.tab');
const panelVideo  = $('panel-video');
const panelImages = $('panel-images');

const fileVideo   = $('file-video');
const fileImages  = $('file-images');
const dropVideo   = $('drop-video');
const dropImages  = $('drop-images');
const editor      = $('editor');
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
const loopSelect  = $('loop');

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

// Timeline DOM
const timecode    = $('timecode');
const tlTrack     = $('tl-track');
const tlRegions   = $('tl-regions');
const handleIn    = $('handle-in');
const handleOut   = $('handle-out');
const playhead    = $('playhead');
const cutInfo     = $('cut-info');

// ---- State -------------------------------------------------------------
let mode = 'video';          // 'video' | 'images'
let videoFile = null;        // File
let imageBitmaps = [];       // { bitmap, name }
let lastObjectUrl = null;    // result blob URL, revoked on reset

// Timeline editing state (seconds)
let duration = 0;
let cropStart = 0;
let cropEnd = 0;
let cuts = [];               // [{start, end}] interior sections to drop, sorted
let pendingCutStart = null;  // armed by "Mark cut start"

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
  cutInfo.textContent = cuts.length
    ? `${cuts.length} cut${cuts.length > 1 ? 's' : ''} · ${kept.toFixed(1)}s kept`
    : (pendingCutStart != null ? 'cut start armed — scrub then “Remove section”' : '');
}

function removeCut(i) { cuts.splice(i, 1); renderTimeline(); }

function setPlayhead() {
  playhead.style.left = pct(preview.currentTime || 0) + '%';
  const fps = captureFps();
  timecode.textContent =
    `${fmtTime(preview.currentTime)} / ${fmtTime(duration)} · frame ${Math.round((preview.currentTime || 0) * fps)}`;
}

function seek(t) { preview.currentTime = clamp(t, 0, Math.max(0, duration - 1e-3)); }

// ---- Mode switching ----------------------------------------------------
tabs.forEach((tab) => tab.addEventListener('click', () => {
  tabs.forEach((t) => t.classList.remove('active'));
  tab.classList.add('active');
  mode = tab.dataset.mode;
  const isVideo = mode === 'video';
  panelVideo.style.display  = isVideo ? '' : 'none';
  panelImages.style.display = isVideo ? 'none' : '';
  refreshReady();
}));

// ---- Drag & drop wiring ------------------------------------------------
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
});
wireDrop(dropImages, fileImages, (files) => {
  const imgs = files.filter((x) => x.type.startsWith('image/'));
  if (imgs.length) loadImages(imgs);
});

// ---- Video input -------------------------------------------------------
function loadVideo(file) {
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
    const fit = fitSize(w, h);
    videoInfo.textContent =
      `${file.name} — ${w}×${h}, ${duration.toFixed(1)}s → output up to ${fit.w}×${fit.h}`;
    dropVideo.style.display = 'none';
    editor.style.display = '';
    renderTimeline();
    seek(0);
    setPlayhead();
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
preview.addEventListener('seeked', setPlayhead);
preview.addEventListener('play',  () => { playBtn().textContent = '❚❚'; });
preview.addEventListener('pause', () => { playBtn().textContent = '▶'; });
function playBtn() { return document.querySelector('.tbtn.play'); }

// ---- Image input -------------------------------------------------------
async function loadImages(files) {
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
  tlTrack.setPointerCapture?.(e.pointerId);
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
  const fit = fitSize(v.videoWidth, v.videoHeight);
  const out = outputDims(fit.w, fit.h, tf.rotation);
  scratchCanvas.width = out.w; scratchCanvas.height = out.h;
  const g = scratchCanvas.getContext('2d', { willReadFrequently: true });

  const dt = 1 / fps;
  const times = [];
  for (const r of keepRanges()) {
    for (let t = r.start; t < r.end - 1e-4; t += dt) times.push(t);
  }
  if (times.length < 2) throw new Error('The kept range is too short for 2 frames.');

  const frames = [];
  for (let i = 0; i < times.length; i++) {
    await seekFor(v, times[i]);
    paint(g, v, fit.w, fit.h, out.w, out.h, tf.rotation, tf.flip, tf.filterStr);
    frames.push(g.getImageData(0, 0, out.w, out.h));
    setProgress((i + 1) / times.length * 0.6);
    setStatus(`Extracting frames… ${i + 1}/${times.length}`);
  }
  return { frames, w: out.w, h: out.h };
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
    frames.push(g.getImageData(0, 0, out.w, out.h));
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

encodeBtn.addEventListener('click', async () => {
  encodeBtn.disabled = true; resetBtn.disabled = true;
  result.classList.remove('show');
  setStatus('Preparing…'); setProgress(0);
  try {
    const fps = captureFps();
    const speed = parseFloat(speedSel.value) || 1;
    const repeat = parseInt(loopSelect.value, 10);
    const tf = readTransform();

    const { frames, w, h } =
      mode === 'video' ? await framesFromVideo(fps, tf) : framesFromImages(tf);

    const effectiveFps = fps * speed;
    setStatus(`Encoding ${frames.length} frames with gifski…`);
    setProgress(0.7);
    await new Promise((r) => setTimeout(r, 30));

    const gif = await runEncode(frames, w, h, 1000 / effectiveFps, repeat);

    setProgress(1);
    const blob = new Blob([gif], { type: 'image/gif' });
    if (lastObjectUrl) URL.revokeObjectURL(lastObjectUrl);
    lastObjectUrl = URL.createObjectURL(blob);

    resultImg.src = lastObjectUrl;
    downloadBtn.href = lastObjectUrl;
    downloadBtn.download = (mode === 'video' && videoFile
      ? videoFile.name.replace(/\.[^.]+$/, '') : 'animation') + '.gif';
    resultMeta.textContent =
      `${w}×${h} · ${frames.length} frames · ${effectiveFps.toFixed(2)} fps · ${humanSize(blob.size)}`;
    result.classList.add('show');
    setStatus('Done.');
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

// ---- Misc UI -----------------------------------------------------------
qualityIn.addEventListener('input', () => { qualityVal.textContent = qualityIn.value; });

resetBtn.addEventListener('click', () => {
  videoFile = null; imageBitmaps = []; thumbs.innerHTML = '';
  videoInfo.textContent = '';
  fileVideo.value = ''; fileImages.value = '';
  if (preview.src) { URL.revokeObjectURL(preview.src); preview.removeAttribute('src'); preview.load(); }
  if (lastObjectUrl) { URL.revokeObjectURL(lastObjectUrl); lastObjectUrl = null; }
  duration = cropStart = cropEnd = 0; cuts = []; pendingCutStart = null;
  editor.style.display = 'none';
  dropVideo.style.display = '';
  result.classList.remove('show');
  setStatus(''); setProgress(null);
  refreshReady();
});

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
