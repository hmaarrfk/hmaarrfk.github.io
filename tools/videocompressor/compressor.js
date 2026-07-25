// Video Compressor — hardware-accelerated, in the browser.
//
// Pipeline:  MP4Box.js (demux)  ->  VideoDecoder (HW)  ->  scale on a canvas
//            ->  VideoEncoder (HW)  ->  mp4-muxer (mux)  ->  Blob.
//
// Large files (multi-GB) are handled without ever reading the whole file into
// one ArrayBuffer (Chrome caps a single ArrayBuffer near 2 GB). Instead:
//   * metadata is parsed from `moov` alone — we feed MP4Box every top-level box
//     *except the mdat payload* (just its 8-byte header), so it can reach and
//     parse `moov` even when it sits at the end of the file;
//   * the encoded video samples are streamed out of `mdat` in chunks during
//     compression, feeding the decoder with backpressure and releasing each
//     batch so memory stays bounded.
//
// AAC audio is copied through untouched (remuxed, never re-encoded).
// Everything runs locally; no file ever leaves the machine.
//
// MP4Box is loaded as a global (window.MP4Box) by a <script> tag in index.html.
import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer/mp4-muxer.js';

const MP4Box = window.MP4Box;

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------
const $ = (id) => document.getElementById(id);
const els = {
  unsupported: $('unsupported'), unsupportedWhy: $('unsupported-why'),
  steps: $('steps'),
  paneSource: $('pane-source'), panePreview: $('pane-preview'),
  paneSettings: $('pane-settings'), paneExport: $('pane-export'), paneResult: $('pane-result'),
  nextSettings: $('next-settings'), nextExport: $('next-export'), exportSummary: $('export-summary'),
  previewBlock: $('preview-block'), previewCaption: $('preview-caption'),
  hostTrim: $('host-trim'), hostSettings: $('host-settings'), hostExport: $('host-export'),
  encodeView: $('encode-view'), encodeCanvas: $('encode-canvas'),
  drop: $('drop-video'), file: $('file-video'), info: $('video-info'),
  // preview / trim
  preview: $('preview'), timecode: $('timecode'),
  tlTrack: $('tl-track'), handleIn: $('handle-in'), handleOut: $('handle-out'),
  playhead: $('playhead'), dimHead: $('dim-head'), dimTail: $('dim-tail'), keepRegion: $('keep-region'),
  cutsLayer: $('cuts-layer'), tlPending: $('tl-pending'),
  btnSetIn: $('btn-set-in'), btnSetOut: $('btn-set-out'), btnResetTrim: $('btn-reset-trim'),
  trimInfo: $('trim-info'),
  btnCutStart: $('btn-cut-start'), btnCutEnd: $('btn-cut-end'), btnClearCuts: $('btn-clear-cuts'),
  cutInfo: $('cut-info'),
  // settings
  fieldSize: $('field-size'), fieldBitrate: $('field-bitrate'),
  inSize: $('in-size'), inBitrate: $('in-bitrate'),
  inScale: $('in-scale'), inFps: $('in-fps'), inCodec: $('in-codec'), inAudio: $('in-audio'),
  hintSize: $('hint-size'), hintBitrate: $('hint-bitrate'), hintScale: $('hint-scale'),
  hintFps: $('hint-fps'), hintCodec: $('hint-codec'), hintAudio: $('hint-audio'),
  encodeWarnSettings: $('encode-warn-settings'), encodeWarnExport: $('encode-warn-export'),
  btnCompress: $('btn-compress'), btnCancel: $('btn-cancel'),
  est: $('est'), progress: $('progress'), status: $('status'),
  resultVideo: $('result-video'), resultMeta: $('result-meta'), download: $('download'),
};

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------
function detectSupport() {
  const missing = [];
  if (typeof VideoEncoder === 'undefined' || typeof VideoDecoder === 'undefined') missing.push('WebCodecs');
  if (typeof MP4Box === 'undefined' || !MP4Box) missing.push('MP4Box (failed to load)');
  return missing;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let state = null;   // { file, mp4, atoms, mdat, video, audio, durationS, fps, previewURL, inS, outS }
let running = false;
let cancelRequested = false;
let lastUrl = null;
let currentStep = 'source';

// ---------------------------------------------------------------------------
// Step navigation (one panel at a time, like the GIF Maker)
// ---------------------------------------------------------------------------
let previewMode = 'edit';   // 'edit' (trim) | 'output' (settings/export)
let pendingSeek = null;     // latest scrub target while a seek is in flight

// Scrub to a time: update the playhead immediately for responsiveness, but only
// issue a new video seek when the previous one has finished (coalescing rapid
// drag moves so the <video> isn't overwhelmed — a little delay is fine).
function scrubSeek(t) {
  if (!state) return;
  t = clamp(t, 0, Math.max(0, state.durationS - 1e-3));
  paintPlayhead(t);                          // immediate visual (mode-aware)
  if (els.preview.seeking) pendingSeek = t;
  else els.preview.currentTime = t;
}

// Position the playhead + timecode for a source time, respecting the timeline
// mode (full edit timeline vs compressed output timeline).
function paintPlayhead(t) {
  if (previewMode === 'output') {
    const kept = keptDuration();
    const o = clamp(toOutputTime(t), 0, kept);
    els.playhead.style.left = `${(kept ? o / kept : 0) * trackWidth()}px`;
    els.timecode.textContent = `${fmtTime(o)} / ${fmtTime(kept)}`;
  } else {
    els.playhead.style.left = `${timeToX(t)}px`;
    els.timecode.textContent = `${fmtTime(t)} / ${fmtTime(state.durationS)}`;
  }
}

// Map a track x-offset to the source time to seek to (compressed in output mode).
function xToSeekTime(x) {
  const frac = clamp(x / trackWidth(), 0, 1);
  return previewMode === 'output' ? fromOutputTime(frac * keptDuration()) : frac * state.durationS;
}

function relocatePreview(name) {
  // Move the single shared preview block into the active step's host.
  const host = name === 'trim' ? els.hostTrim
    : name === 'settings' ? els.hostSettings
    : name === 'export' ? els.hostExport : null;
  if (host && els.previewBlock && els.previewBlock.parentElement !== host) {
    els.preview.pause();
    host.appendChild(els.previewBlock);
  }
  previewMode = name === 'trim' ? 'edit' : 'output';
  const editing = previewMode === 'edit';
  // Handles are only meaningful while editing the trim.
  els.handleIn.style.display = editing ? '' : 'none';
  els.handleOut.style.display = editing ? '' : 'none';
  els.previewCaption.hidden = editing;
  if (!editing && state) {
    els.previewCaption.textContent =
      `Final preview — trimmed${activeCuts().length ? `, ${activeCuts().length} cut${activeCuts().length > 1 ? 's' : ''} removed` : ''} · ${fmtTime(keptDuration())}`;
    // Snap playback into the kept range.
    if ((els.preview.currentTime || 0) < state.inS || els.preview.currentTime >= state.outS || inCut(els.preview.currentTime)) {
      seek(state.inS);
    }
  }
}

function showStep(name) {
  currentStep = name;
  document.querySelectorAll('.step-pane').forEach((p) => { p.hidden = p.dataset.pane !== name; });
  document.querySelectorAll('.stepbtn').forEach((b) => b.classList.toggle('active', b.dataset.step === name));
  // During an export, keep the preview out of the way (the encode view shows).
  if (name === 'export' && running) { els.encodeView.hidden = false; els.previewBlock.style.display = 'none'; }
  else { els.encodeView.hidden = true; els.previewBlock.style.display = ''; if (state) relocatePreview(name); }
  if (state && name !== 'source') { renderTrim(); renderPlayhead(); }
  if (state && name === 'export') updateExportSummary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateExportSummary() {
  if (!state) return;
  const s = currentSettings();
  const target = s.mode === 'size'
    ? `target ${els.inSize.value} MB`
    : `${parseFloat(els.inBitrate.value)} Mbps`;
  els.exportSummary.textContent =
    `${s.outW}×${s.outH} · ${s.outFps.toFixed(0)} fps · ${s.codec === 'hevc' ? 'H.265' : 'H.264'} · ` +
    `${target} · ${fmtTime(s.trimDur)} kept${s.keepAudio ? ' · audio kept' : (state.audio ? ' · audio dropped' : '')}`;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
const fmtTime = (s) => {
  s = Math.max(0, s || 0);
  const m = Math.floor(s / 60), sec = (s % 60);
  return `${m}:${sec.toFixed(2).padStart(5, '0')}`;
};
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Persisted settings (survive a page refresh). The video file itself can't be
// stored, so we save the settings/trim/cuts and re-apply them next time a video
// is loaded — fully if it's the same file, otherwise just the general options.
// ---------------------------------------------------------------------------
const LS_KEY = 'videocompressor:settings:v1';
let saveTimer = null;

function readSettings() {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || 'null'); } catch (_) { return null; }
}
function saveSettings() {
  if (!state) return;
  const data = {
    v: 1,
    general: {
      mode: document.querySelector('input[name="mode"]:checked').value,
      size: els.inSize.value, bitrate: els.inBitrate.value,
      scale: els.inScale.value, fps: els.inFps.value, codec: els.inCodec.value,
      keepAudio: els.inAudio.checked,
    },
    file: { name: state.file.name, size: state.file.size, lastModified: state.file.lastModified },
    trim: { inS: state.inS, outS: state.outS, cuts: state.cuts },
  };
  try { localStorage.setItem(LS_KEY, JSON.stringify(data)); } catch (_) {}
}
function queueSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(saveSettings, 300);
}
function applyGeneral(g) {
  if (!g) return;
  if (g.size != null) els.inSize.value = g.size;
  if (g.bitrate != null) els.inBitrate.value = g.bitrate;
  if (g.scale != null) els.inScale.value = g.scale;
  if (g.fps != null) els.inFps.value = g.fps;
  if (g.codec != null) els.inCodec.value = g.codec;
  const modeRadio = document.querySelector(`input[name="mode"][value="${g.mode}"]`);
  if (modeRadio) { modeRadio.checked = true; els.fieldSize.hidden = g.mode !== 'size'; els.fieldBitrate.hidden = g.mode !== 'bitrate'; }
}

function setStatus(msg) { els.status.textContent = msg || ''; }
function setProgress(frac) {
  if (frac == null) { els.progress.style.display = 'none'; return; }
  els.progress.style.display = 'block';
  els.progress.firstElementChild.style.width = `${clamp(frac, 0, 1) * 100}%`;
}

// Read a byte range of the File as an ArrayBuffer (streams from disk; never the
// whole file at once).
async function readRange(file, start, end) {
  return file.slice(start, end).arrayBuffer();
}

// ---------------------------------------------------------------------------
// Top-level atom walk — locate moov / mdat with tiny header reads only.
// ---------------------------------------------------------------------------
async function walkAtoms(file) {
  const total = file.size;
  const atoms = [];
  let pos = 0;
  while (pos < total) {
    const head = new DataView(await readRange(file, pos, Math.min(pos + 16, total)));
    if (head.byteLength < 8) break;
    let size = head.getUint32(0);
    const type = String.fromCharCode(head.getUint8(4), head.getUint8(5), head.getUint8(6), head.getUint8(7));
    let hdr = 8;
    if (size === 1) { size = Number(head.getBigUint64(8)); hdr = 16; }
    else if (size === 0) { size = total - pos; }          // extends to EOF
    atoms.push({ type, start: pos, size, hdr });
    if (size <= 0) break;
    pos += size;
  }
  return atoms;
}

// Read a parsed box's payload (after its header) straight from the file.
// MP4Box exposes each box's true byte range via .start / .size / .hdr_size.
async function boxPayload(file, box) {
  return new Uint8Array(await readRange(file, box.start + box.hdr_size, box.start + box.size));
}

async function videoDescription(file, mp4, trackId) {
  const trak = mp4.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) return boxPayload(file, box);
  }
  return null;
}

async function aacDescription(file, mp4, trackId) {
  const trak = mp4.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    if (!entry.esds) continue;
    const v = await boxPayload(file, entry.esds);
    const o = { p: 0 };
    const readLen = () => { let b, n = 0; do { b = v[o.p++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80); return n; };
    if (v[o.p++] !== 0x03) return null; readLen(); o.p += 3;   // ES_Descriptor
    if (v[o.p++] !== 0x04) return null; readLen(); o.p += 13;  // DecoderConfigDescriptor
    if (v[o.p++] !== 0x05) return null;                        // DecoderSpecificInfo
    const len = readLen();                                     // advance o.p BEFORE slicing
    return v.slice(o.p, o.p + len);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Load & parse a source file (metadata only — no mdat payload).
// ---------------------------------------------------------------------------
async function loadFile(file) {
  resetResult();
  els.panePreview.hidden = true;
  els.paneSettings.hidden = true;
  els.info.textContent = 'Analyzing…';

  const atoms = await walkAtoms(file);
  const mdat = atoms.find((a) => a.type === 'mdat');
  if (!mdat) throw new Error('No media data (mdat) box found — is this a valid MP4/MOV?');

  const mp4 = MP4Box.createFile();
  const info = await new Promise((resolve, reject) => {
    mp4.onError = (e) => reject(new Error(typeof e === 'string' ? e : 'Could not parse this file.'));
    mp4.onReady = resolve;
    // Feed every box fully, except mdat: give only its header so MP4Box learns
    // the size, skips the payload, and can reach moov (often at end of file).
    (async () => {
      try {
        for (const a of atoms) {
          const end = a.type === 'mdat' ? a.start + a.hdr : a.start + a.size;
          const ab = await readRange(file, a.start, end);
          ab.fileStart = a.start;
          mp4.appendBuffer(ab);
        }
      } catch (e) { reject(e); }
    })();
  });

  const video = info.videoTracks && info.videoTracks[0];
  if (!video) throw new Error('No video track found in this file.');
  const audio = info.audioTracks && info.audioTracks[0];

  const durationS = info.duration / info.timescale;
  const fps = video.nb_samples / (video.duration / video.timescale);

  if (lastUrl) { /* keep result url logic separate */ }
  const previewURL = URL.createObjectURL(file);

  state = {
    file, mp4, atoms, mdat, video, audio, durationS, fps, previewURL,
    inS: 0, outS: durationS, cuts: [], pendingCutStart: null,
  };

  // Info line
  const parts = [
    `${video.track_width}×${video.track_height}`,
    `${fps.toFixed(1)} fps`,
    fmtTime(durationS),
    fmtBytes(file.size),
    (video.codec || '').split('.')[0].toUpperCase(),
  ];
  parts.push(audio ? `audio: ${audio.codec}` : 'no audio');
  els.info.textContent = parts.join('  ·  ');

  // Audio availability
  const isAac = audio && /mp4a/.test(audio.codec);
  els.inAudio.disabled = !isAac;
  els.inAudio.checked = !!isAac;
  els.hintAudio.textContent = !audio ? 'This file has no audio track.'
    : isAac ? `${audio.audio.channel_count}ch · ${audio.audio.sample_rate} Hz — copied unchanged.`
    : `Audio is ${audio.codec} (not AAC) and will be dropped.`;

  // Check up front whether the browser can decode this source (and cache the
  // codec description so compress doesn't re-read it).
  try { state.description = await videoDescription(file, mp4, video.id); } catch (_) { state.description = null; }
  const decCfg = { codec: video.codec, codedWidth: video.track_width, codedHeight: video.track_height, description: state.description };
  state.decoderSupported = (await VideoDecoder.isConfigSupported(decCfg).catch(() => ({ supported: false }))).supported;

  // Restore saved settings (survive a refresh). General options always apply;
  // trim + cuts only when the same file is loaded again.
  const saved = readSettings();
  let restoredNote = '';
  if (saved) {
    applyGeneral(saved.general);
    if (isAac && saved.general && saved.general.keepAudio != null) els.inAudio.checked = !!saved.general.keepAudio;
    const sameFile = saved.file && saved.file.name === file.name &&
      saved.file.size === file.size && saved.file.lastModified === file.lastModified;
    if (sameFile && saved.trim) {
      state.inS = clamp(saved.trim.inS ?? 0, 0, durationS);
      state.outS = clamp(saved.trim.outS ?? durationS, state.inS + 0.01, durationS);
      state.cuts = Array.isArray(saved.trim.cuts)
        ? saved.trim.cuts.filter((c) => c && isFinite(c.start) && isFinite(c.end))
        : [];
      restoredNote = '  ·  restored your last trim, cuts & settings';
    } else if (saved.general) {
      restoredNote = '  ·  applied your last settings';
    }
  }
  if (restoredNote) els.info.textContent += restoredNote;

  // Preview + trim
  setupPreview();

  els.steps.hidden = false;      // reveal step nav now that a video is loaded
  updateEstimate();
  showStep('trim');              // advance past the upload step
}

// ---------------------------------------------------------------------------
// Preview & trim
// ---------------------------------------------------------------------------
function trackWidth() { return els.tlTrack.clientWidth || 1; }
function timeToX(t) { return (t / state.durationS) * trackWidth(); }
function xToTime(x) { return clamp((x / trackWidth()) * state.durationS, 0, state.durationS); }

// Cuts that fall inside the current [inS, outS] window, clipped to it, sorted.
function activeCuts() {
  const out = [];
  for (const c of state.cuts) {
    const a = clamp(c.start, state.inS, state.outS);
    const b = clamp(c.end, state.inS, state.outS);
    if (b - a > 1e-3) out.push({ start: a, end: b });
  }
  return out.sort((x, y) => x.start - y.start);
}

// Total kept seconds = selection minus the cut sections inside it.
function keptDuration() {
  let cut = 0;
  for (const c of activeCuts()) cut += c.end - c.start;
  return Math.max(0.05, (state.outS - state.inS) - cut);
}

// The kept ranges: [inS, outS] with every cut removed, in order.
function keptSegments() {
  const segs = [];
  let cur = state.inS;
  for (const c of activeCuts()) {
    if (c.start > cur) segs.push({ start: cur, end: c.start });
    cur = Math.max(cur, c.end);
  }
  if (cur < state.outS) segs.push({ start: cur, end: state.outS });
  return segs;
}

// Source time -> compressed (output) time, and back. These power the compressed
// timeline shown in Settings/Export, where trim + cuts are already removed.
function toOutputTime(t) {
  let o = 0;
  for (const s of keptSegments()) {
    if (t >= s.end) o += s.end - s.start;
    else if (t > s.start) return o + (t - s.start);
    else return o;
  }
  return o;
}
function fromOutputTime(o) {
  let acc = 0;
  const segs = keptSegments();
  for (const s of segs) {
    const d = s.end - s.start;
    if (o <= acc + d) return s.start + (o - acc);
    acc += d;
  }
  return segs.length ? segs[segs.length - 1].end : state.inS;
}

// Whether a source time (seconds) lands inside a removed section.
function inCut(t) {
  for (const c of activeCuts()) if (t >= c.start && t < c.end) return true;
  return false;
}

function removeCut(i) { state.cuts.splice(i, 1); renderTrim(); }

// Merge overlapping / touching cut sections so they stay a clean, sorted set.
function mergeCuts() {
  state.cuts.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const c of state.cuts) {
    const last = merged[merged.length - 1];
    if (last && c.start <= last.end + 1e-3) last.end = Math.max(last.end, c.end);
    else merged.push({ ...c });
  }
  state.cuts = merged;
}

function renderCuts() {
  els.cutsLayer.innerHTML = '';
  activeCuts().forEach((c, i) => {
    const el = document.createElement('div');
    el.style.cssText =
      `position:absolute;top:0;bottom:0;left:${timeToX(c.start)}px;width:${timeToX(c.end) - timeToX(c.start)}px;` +
      'background:rgba(231,76,60,.55);border-left:1px solid #e74c3c;border-right:1px solid #e74c3c;cursor:pointer';
    el.title = 'Click to undo this cut';
    el.onclick = (e) => { e.stopPropagation(); removeCut(i); };
    els.cutsLayer.appendChild(el);
  });
}

function renderPending() {
  const p = state.pendingCutStart;
  if (p == null) { els.tlPending.style.display = 'none'; return; }
  const t = els.preview.currentTime || 0;
  const a = Math.min(p, t), b = Math.max(p, t);
  els.tlPending.style.display = 'block';
  els.tlPending.style.left = `${timeToX(a)}px`;
  els.tlPending.style.width = `${Math.max(2, timeToX(b) - timeToX(a))}px`;
}

function renderTrim() {
  // Compressed timeline (Settings/Export): one continuous green bar = the final
  // output, with the trimmed head/tail and every cut already removed.
  if (previewMode === 'output') {
    els.keepRegion.style.left = '0px';
    els.keepRegion.style.width = `${trackWidth()}px`;
    els.dimHead.style.width = '0px';
    els.dimTail.style.width = '0px';
    els.cutsLayer.innerHTML = '';
    els.tlPending.style.display = 'none';
    renderPlayhead();
    updateEstimate();
    return;
  }

  const inX = timeToX(state.inS), outX = timeToX(state.outS);
  els.handleIn.style.left = `${inX}px`;
  els.handleOut.style.left = `${outX}px`;
  els.keepRegion.style.left = `${inX}px`;
  els.keepRegion.style.width = `${Math.max(0, outX - inX)}px`;
  els.dimHead.style.width = `${inX}px`;
  els.dimTail.style.width = `${trackWidth() - outX}px`;
  renderCuts();
  renderPending();

  const kept = keptDuration();
  const cuts = activeCuts();
  els.trimInfo.textContent = `Keep ${fmtTime(state.inS)} → ${fmtTime(state.outS)}  (${fmtTime(kept)} kept)`;
  els.cutInfo.textContent = state.pendingCutStart != null
    ? 'Cut start marked — scrub, then “Remove section”'
    : cuts.length ? `${cuts.length} cut${cuts.length > 1 ? 's' : ''} removed`
    : 'No cuts';
  els.btnCutEnd.style.outline = state.pendingCutStart != null ? '2px solid var(--good)' : 'none';
  updateEstimate();
}

function renderPlayhead() {
  paintPlayhead(els.preview.currentTime || 0);
  if (state.pendingCutStart != null) renderPending();
}

function frameStep() { return 1 / Math.max(1, state.fps); }
function seek(t) { els.preview.currentTime = clamp(t, 0, Math.max(0, state.durationS - 1e-3)); }

function setupPreview() {
  const v = els.preview;
  v.src = state.previewURL;
  v.load();
  seek(0);

  // Transport buttons
  els.panePreview.querySelectorAll('.transport [data-act]').forEach((btn) => {
    btn.onclick = () => {
      switch (btn.dataset.act) {
        case 'play': v.paused ? v.play() : v.pause(); break;
        case 'prevFrame': v.pause(); seek((v.currentTime || 0) - frameStep()); break;
        case 'nextFrame': v.pause(); seek((v.currentTime || 0) + frameStep()); break;
        case 'toIn': seek(state.inS); break;
        case 'toOut': seek(state.outS); break;
      }
    };
  });

  v.ontimeupdate = () => {
    if (!v.paused) {
      // In output mode, keep playback inside the selection and loop it.
      if (previewMode === 'output' && state) {
        if (v.currentTime < state.inS - 1e-3) seek(state.inS);
        else if (v.currentTime >= state.outS - 1e-3) seek(state.inS);
      }
      // Skip over removed sections.
      for (const c of activeCuts()) {
        if (v.currentTime >= c.start && v.currentTime < c.end - 1e-3) { seek(c.end); break; }
      }
    }
    renderPlayhead();
  };
  v.onseeked = () => {
    renderPlayhead();
    if (pendingSeek != null) { const t = pendingSeek; pendingSeek = null; v.currentTime = t; }
  };
  v.onloadedmetadata = () => { renderTrim(); renderPlayhead(); };

  els.btnSetIn.onclick = () => { state.inS = clamp(v.currentTime || 0, 0, state.outS - frameStep()); renderTrim(); };
  els.btnSetOut.onclick = () => { state.outS = clamp(v.currentTime || 0, state.inS + frameStep(), state.durationS); renderTrim(); };
  els.btnResetTrim.onclick = () => { state.inS = 0; state.outS = state.durationS; renderTrim(); };

  // Cuts
  els.btnCutStart.onclick = () => { state.pendingCutStart = v.currentTime || 0; renderTrim(); };
  els.btnCutEnd.onclick = () => {
    if (state.pendingCutStart == null) { setStatus('Mark a cut start first.'); return; }
    const a = Math.min(state.pendingCutStart, v.currentTime || 0);
    const b = Math.max(state.pendingCutStart, v.currentTime || 0);
    if (b - a > 1e-3) { state.cuts.push({ start: a, end: b }); mergeCuts(); }
    state.pendingCutStart = null;
    setStatus('');
    renderTrim();
  };
  els.btnClearCuts.onclick = () => { state.cuts = []; state.pendingCutStart = null; renderTrim(); };

  // Press-and-drag anywhere on the track to scrub through frames.
  els.tlTrack.onpointerdown = (e) => {
    if (e.target === els.handleIn || e.target === els.handleOut) return;   // handles have their own drag
    if (e.target.parentElement === els.cutsLayer) return;                  // let a cut band's click remove it
    const rect = els.tlTrack.getBoundingClientRect();
    v.pause();
    try { els.tlTrack.setPointerCapture(e.pointerId); } catch (_) {}
    scrubSeek(xToSeekTime(e.clientX - rect.left));
    els.tlTrack.onpointermove = (ev) => scrubSeek(xToSeekTime(ev.clientX - rect.left));
    els.tlTrack.onpointerup = () => {
      els.tlTrack.onpointermove = null;
      els.tlTrack.onpointerup = null;
      try { els.tlTrack.releasePointerCapture(e.pointerId); } catch (_) {}
    };
  };

  // Drag handles
  const dragHandle = (handle, which) => {
    handle.onpointerdown = (e) => {
      e.preventDefault(); e.stopPropagation();
      handle.setPointerCapture(e.pointerId);
      const rect = els.tlTrack.getBoundingClientRect();
      v.pause();
      const move = (ev) => {
        const t = xToTime(ev.clientX - rect.left);
        if (which === 'in') state.inS = clamp(t, 0, state.outS - frameStep());
        else state.outS = clamp(t, state.inS + frameStep(), state.durationS);
        renderTrim();
        scrubSeek(which === 'in' ? state.inS : state.outS);
      };
      const up = (ev) => { handle.releasePointerCapture(e.pointerId); handle.onpointermove = null; handle.onpointerup = null; };
      handle.onpointermove = move;
      handle.onpointerup = up;
    };
  };
  dragHandle(els.handleIn, 'in');
  dragHandle(els.handleOut, 'out');

  // Keyboard
  document.onkeydown = (e) => {
    if (!state || running) return;
    if (currentStep === 'source' || els.previewBlock.style.display === 'none') return;
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
    if (e.key === ' ') { e.preventDefault(); v.paused ? v.play() : v.pause(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); v.pause(); seek((v.currentTime || 0) - frameStep()); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); v.pause(); seek((v.currentTime || 0) + frameStep()); }
    else if (e.key === 'Home') { seek(state.inS); }
    else if (e.key === 'End') { seek(state.outS); }
    else if ((e.key === 'c' || e.key === 'C') && previewMode === 'edit') { e.preventDefault(); (state.pendingCutStart == null ? els.btnCutStart : els.btnCutEnd).click(); }
  };

  renderTrim();
}

// ---------------------------------------------------------------------------
// Live settings / estimate
// ---------------------------------------------------------------------------
function currentSettings() {
  const mode = document.querySelector('input[name="mode"]:checked').value;
  const scale = parseFloat(els.inScale.value);
  const outW = even(state.video.track_width * scale);
  const outH = even(state.video.track_height * scale);
  const fpsSel = parseFloat(els.inFps.value);
  const outFps = fpsSel > 0 ? Math.min(fpsSel, state.fps) : state.fps;
  const codec = els.inCodec.value;
  const keepAudio = els.inAudio.checked && !els.inAudio.disabled;
  const trimDur = keptDuration();   // selection length minus removed sections
  return { mode, scale, outW, outH, outFps, codec, keepAudio, trimDur };
}

function audioBytesPerSecond() {
  if (!state.audio) return 0;
  const br = state.audio.bitrate || 128000;
  return br / 8;
}

function targetVideoBitrate(s) {
  if (s.mode === 'bitrate') return Math.round(parseFloat(els.inBitrate.value) * 1e6);
  const targetBytes = parseFloat(els.inSize.value) * 1024 * 1024 * 0.97;
  const audio = s.keepAudio ? audioBytesPerSecond() * s.trimDur : 0;
  const videoBits = Math.max(0, targetBytes - audio) * 8;
  return Math.max(100_000, Math.round(videoBits / s.trimDur));
}

function updateEstimate() {
  if (!state) return;
  const s = currentSettings();
  const vBitrate = targetVideoBitrate(s);
  els.hintScale.textContent = `Output: ${s.outW}×${s.outH}`;
  els.hintFps.textContent = `Source is ${state.fps.toFixed(1)} fps`;
  els.hintCodec.textContent = s.codec === 'hevc'
    ? 'Best size; needs a recent browser/OS to play & encode.'
    : 'Plays almost everywhere.';

  if (s.mode === 'size') {
    els.hintSize.textContent = `≈ ${(vBitrate / 1e6).toFixed(2)} Mbps video${s.keepAudio ? ' + audio' : ''}, ${fmtTime(s.trimDur)}`;
  } else {
    const est = (vBitrate / 8 * s.trimDur) + (s.keepAudio ? audioBytesPerSecond() * s.trimDur : 0);
    els.hintBitrate.textContent = `≈ ${fmtBytes(est)} output (${fmtTime(s.trimDur)})`;
  }
  els.est.textContent = '';
  if (currentStep === 'export') updateExportSummary();
  queueSave();
  queueValidate();
}

// ---------------------------------------------------------------------------
// Encoder config probing
// ---------------------------------------------------------------------------
async function pickEncoderConfig(codec, width, height, bitrate, framerate) {
  // Try a ladder of profile@level strings from high to low so large frames
  // (e.g. 4K) find a level that supports them. AVC level 4.0 (…28) only covers
  // ~2048px wide; 4K needs 5.1/5.2 (…33/…34). HEVC likewise needs L153/L156.
  const candidates = codec === 'hevc'
    ? ['hvc1.1.6.L186.B0', 'hvc1.1.6.L156.B0', 'hvc1.1.6.L153.B0', 'hvc1.1.6.L150.B0',
       'hvc1.1.6.L123.B0', 'hvc1.1.6.L120.B0', 'hvc1.1.6.L93.B0',
       'hev1.1.6.L153.B0', 'hev1.1.6.L123.B0']
    : ['avc1.640034', 'avc1.640033', 'avc1.640032', 'avc1.64002a', 'avc1.640029',
       'avc1.640028', 'avc1.64001f', 'avc1.4d0028', 'avc1.42001f'];
  for (const accel of ['prefer-hardware', 'no-preference']) {
    for (const c of candidates) {
      const config = {
        codec: c, width, height, bitrate,
        framerate: Math.max(1, Math.round(framerate)),
        hardwareAcceleration: accel,
        bitrateMode: 'variable',
        latencyMode: 'quality',
      };
      try {
        const { supported } = await VideoEncoder.isConfigSupported(config);
        if (supported) return config;
      } catch (_) { /* next */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Early validation — check the chosen settings are actually encodable *before*
// the user hits Compress, and disable it (with a reason) if not.
// ---------------------------------------------------------------------------
let validateToken = 0;
let validateTimer = null;

function setEncodeWarning(msg) {
  const show = !!msg;
  els.encodeWarnSettings.textContent = msg || '';
  els.encodeWarnExport.textContent = msg || '';
  els.encodeWarnSettings.style.display = show ? 'block' : 'none';
  els.encodeWarnExport.style.display = show ? 'block' : 'none';
  if (!running) els.btnCompress.disabled = show;
}

async function validateSettings() {
  if (!state) return;
  if (state.decoderSupported === false) {
    setEncodeWarning(`Your browser can’t decode this video’s codec (${state.video.codec}). Try an H.264 or H.265 file.`);
    return;
  }
  const token = ++validateToken;
  const s = currentSettings();
  const vBitrate = targetVideoBitrate(s);
  const cfg = await pickEncoderConfig(s.codec, s.outW, s.outH, vBitrate, s.outFps);
  if (token !== validateToken) return;                 // superseded by a newer change
  if (cfg) { setEncodeWarning(''); return; }
  // Unsupported — is the other codec OK? Advise accordingly.
  const alt = s.codec === 'hevc' ? 'avc' : 'hevc';
  const altCfg = await pickEncoderConfig(alt, s.outW, s.outH, vBitrate, s.outFps);
  if (token !== validateToken) return;
  const thisName = s.codec === 'hevc' ? 'H.265' : 'H.264';
  setEncodeWarning(altCfg
    ? `Your browser can’t encode ${thisName} at ${s.outW}×${s.outH}. Switch codec to ${alt === 'hevc' ? 'H.265' : 'H.264'}, or pick a smaller resolution.`
    : `Your browser can’t encode ${s.outW}×${s.outH} at these settings. Pick a smaller resolution.`);
}
function queueValidate() {
  if (validateTimer) clearTimeout(validateTimer);
  validateTimer = setTimeout(validateSettings, 250);
}

// ---------------------------------------------------------------------------
// Main transcode
// ---------------------------------------------------------------------------
async function compress() {
  if (running) return;
  const s = currentSettings();
  const { file, video, audio, mp4, mdat } = state;
  els.preview.pause();

  running = true; cancelRequested = false;
  resetResult();
  els.btnCompress.disabled = true;
  els.btnCancel.hidden = false;
  setProgress(0);
  setStatus('Preparing…');

  let decoder, encoder, muxer;
  try {
    const vBitrate = targetVideoBitrate(s);
    const inMicros = Math.round(state.inS * 1e6);
    const outMicros = Math.round(state.outS * 1e6);
    // Cut sections in microseconds; output time compacts by removing them.
    const cutsUS = activeCuts().map((c) => ({ start: Math.round(c.start * 1e6), end: Math.round(c.end * 1e6) }));
    const inCutUS = (t) => cutsUS.some((c) => t >= c.start && t < c.end);
    // Source time -> output time: subtract the trim start and every cut before t.
    const toOutputUS = (t) => {
      let shift = inMicros;
      for (const c of cutsUS) {
        if (t >= c.end) shift += c.end - c.start;
        else if (t > c.start) shift += t - c.start;   // (frames inside a cut are skipped before this runs)
      }
      return t - shift;
    };

    // ---- Verify source is decodable (checked early at load; re-read desc here) ----
    const description = state.description !== undefined ? state.description : await videoDescription(file, mp4, video.id);
    const decCfg = {
      codec: video.codec,
      codedWidth: video.track_width,
      codedHeight: video.track_height,
      description,
    };
    if (state.decoderSupported === false) {
      throw new Error(`Your browser can't decode this video's codec (${video.codec}). Try an H.264 or H.265 file.`);
    }

    // ---- Pick an encoder config ----
    const encCfg = await pickEncoderConfig(s.codec, s.outW, s.outH, vBitrate, s.outFps);
    if (!encCfg) {
      throw new Error(s.codec === 'hevc'
        ? "Your browser can't encode HEVC. Switch the codec to H.264 and try again."
        : "Your browser can't encode H.264 at these settings.");
    }

    // ---- Muxer ----
    const muxerOpts = {
      target: new ArrayBufferTarget(),
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
      video: { codec: s.codec, width: s.outW, height: s.outH },
    };
    if (s.keepAudio && audio) {
      muxerOpts.audio = {
        codec: 'aac',
        numberOfChannels: audio.audio.channel_count,
        sampleRate: audio.audio.sample_rate,
      };
    }
    muxer = new Muxer(muxerOpts);

    // ---- Encoder ----
    let encodeErr = null;
    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { encodeErr = e; },
    });
    encoder.configure(encCfg);

    // ---- Decode → (trim window) → scale → encode ----
    const gop = Math.max(1, Math.round(s.outFps * 2));
    const needScale = s.outW !== video.track_width || s.outH !== video.track_height;
    const canvas = new OffscreenCanvas(s.outW, s.outH);
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    // Live "playing while encoding" view (downscaled for cheap drawing).
    els.previewBlock.style.display = 'none';
    els.encodeView.hidden = false;
    const ecW = Math.min(s.outW, 640);
    const ecH = Math.max(1, Math.round(ecW * s.outH / s.outW));
    els.encodeCanvas.width = ecW;
    els.encodeCanvas.height = ecH;
    const ecx = els.encodeCanvas.getContext('2d', { alpha: false });

    const frameInterval = 1e6 / s.outFps;
    const decimating = s.outFps < state.fps - 0.01;
    const estFrames = Math.max(1, Math.round(s.outFps * s.trimDur));

    let nextEmit = inMicros, emitted = 0, reachedOut = false;

    const onDecoded = (frame) => {
      try {
        if (cancelRequested) return;
        const t = frame.timestamp;
        if (t >= outMicros) { reachedOut = true; return; }          // past selection
        if (t + 1 < inMicros) return;                               // before selection (decoded for refs)
        if (inCutUS(t)) return;                                     // inside a removed section
        if (decimating && t + 1 < nextEmit) return;                 // frame-rate reduction
        nextEmit = t + frameInterval;

        const outTs = toOutputUS(t);                                // compact past trim + cuts
        let out;
        if (needScale) {
          ctx.drawImage(frame, 0, 0, s.outW, s.outH);
          out = new VideoFrame(canvas, { timestamp: outTs, duration: frame.duration || Math.round(frameInterval) });
        } else {
          out = new VideoFrame(frame, { timestamp: outTs, duration: frame.duration || Math.round(frameInterval) });
        }
        encoder.encode(out, { keyFrame: emitted % gop === 0 });
        // Draw the frame we just encoded so the user watches it play out.
        try { ecx.drawImage(needScale ? canvas : out, 0, 0, ecW, ecH); } catch (_) {}
        out.close();
        emitted++;
        if (emitted % 5 === 0) {
          setProgress(0.05 + 0.9 * Math.min(1, emitted / estFrames));
          setStatus(`Encoding… ${emitted} / ~${estFrames} frames`);
        }
      } finally {
        frame.close();
      }
    };

    decoder = new VideoDecoder({ output: onDecoded, error: (e) => { encodeErr = e; } });
    decoder.configure(decCfg);

    // Set up sample extraction on the already-parsed file, then stream mdat.
    const vq = [];                 // queued encoded video samples
    const audioOut = [];           // AAC samples inside the trim window (passthrough)
    const asc = (s.keepAudio && audio) ? await aacDescription(file, mp4, audio.id) : null;

    mp4.onSamples = (id, user, smps) => {
      if (user === 'video') {
        // Copy sample data now: releaseUsedSamples() nulls smp.data, and we
        // consume the queue later in feed(). The queue is drained after every
        // appended chunk, so it holds at most one chunk's worth of samples.
        for (const smp of smps) vq.push({
          data: smp.data.slice(0),
          cts: smp.cts, duration: smp.duration, timescale: smp.timescale, is_sync: smp.is_sync,
        });
      } else if (user === 'audio') {
        for (const smp of smps) {
          const cts = (smp.cts / smp.timescale) * 1e6;
          if (cts + 1 >= inMicros && cts < outMicros && !inCutUS(cts)) {
            audioOut.push({
              data: smp.data.slice(0),                              // copy before release
              ts: Math.round(toOutputUS(cts)),                      // compact past trim + cuts
              dur: Math.round((smp.duration / smp.timescale) * 1e6),
            });
          }
        }
      }
      mp4.releaseUsedSamples(id, smps[smps.length - 1].number);
    };
    mp4.setExtractionOptions(video.id, 'video', { nbSamples: 30 });
    if (s.keepAudio && audio) mp4.setExtractionOptions(audio.id, 'audio', { nbSamples: 200 });
    mp4.start();

    const feed = async () => {
      while (vq.length && !cancelRequested && !reachedOut) {
        const smp = vq.shift();
        decoder.decode(new EncodedVideoChunk({
          type: smp.is_sync ? 'key' : 'delta',
          timestamp: Math.round((smp.cts / smp.timescale) * 1e6),
          duration: Math.round((smp.duration / smp.timescale) * 1e6),
          data: smp.data,
        }));
        while ((encoder.encodeQueueSize > 8 || decoder.decodeQueueSize > 8) && !cancelRequested) {
          await sleep(4);
        }
        if (encodeErr) throw encodeErr;
      }
    };

    // Stream the mdat payload in chunks.
    setStatus('Reading & encoding…');
    const CHUNK = 8 * 1024 * 1024;
    let off = mdat.start + mdat.hdr;
    const endByte = mdat.start + mdat.size;
    while (off < endByte && !cancelRequested && !reachedOut) {
      const e = Math.min(off + CHUNK, endByte);
      const ab = await readRange(file, off, e);
      ab.fileStart = off;
      off = e;
      mp4.appendBuffer(ab);        // fires onSamples synchronously
      await feed();
    }
    mp4.flush();
    await feed();
    if (cancelRequested) throw new Error('cancelled');

    await decoder.flush();
    await encoder.flush();
    if (encodeErr) throw encodeErr;
    try { mp4.stop(); } catch (_) {}

    // ---- Audio passthrough (trim-windowed) ----
    let audioNote = '';
    if (s.keepAudio && audio) {
      if (audioOut.length) {
        let first = true;
        for (const a of audioOut) {
          muxer.addAudioChunkRaw(a.data, 'key', a.ts, a.dur, first && asc ? { decoderConfig: { description: asc } } : undefined);
          first = false;
        }
      } else {
        audioNote = ' (no audio in the selected range)';
      }
    } else if (audio && !els.inAudio.disabled && !s.keepAudio) {
      audioNote = '';
    } else if (audio) {
      audioNote = ' (non-AAC audio dropped)';
    }

    setStatus('Finalizing…');
    muxer.finalize();
    const blob = new Blob([muxer.target.buffer], { type: 'video/mp4' });
    showResult(blob, s, audioNote);
    setProgress(1);
    setStatus('');
  } catch (err) {
    if (cancelRequested || (err && err.message === 'cancelled')) setStatus('Cancelled.');
    else { console.error(err); setStatus(`Error: ${err.message || err}`); }
    setProgress(null);
  } finally {
    try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch (_) {}
    try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch (_) {}
    try { mp4.onSamples = null; } catch (_) {}
    running = false;
    els.btnCompress.disabled = false;
    els.btnCancel.hidden = true;
    els.encodeView.hidden = true;
    els.previewBlock.style.display = '';
    if (state && currentStep === 'export') relocatePreview('export');
  }
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
function showResult(blob, s, audioNote) {
  if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
  lastUrl = URL.createObjectURL(blob);
  els.resultVideo.src = lastUrl;
  els.download.href = lastUrl;
  const base = state.file.name.replace(/\.[^.]+$/, '');
  els.download.download = `${base}_compressed.mp4`;

  const ratio = state.file.size / blob.size;
  els.resultMeta.innerHTML = [
    `<strong>${fmtBytes(blob.size)}</strong> · ${s.outW}×${s.outH} · ${s.outFps.toFixed(0)} fps · ${s.codec === 'hevc' ? 'H.265' : 'H.264'} · ${fmtTime(s.trimDur)}${audioNote}`,
    `${fmtBytes(state.file.size)} → ${fmtBytes(blob.size)} (${ratio >= 1 ? ratio.toFixed(1) + '× smaller' : 'larger — lower the bitrate'})`,
  ].join('<br>');
  els.paneResult.style.display = 'block';
  els.paneResult.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function resetResult() {
  els.paneResult.style.display = 'none';
  if (lastUrl) { URL.revokeObjectURL(lastUrl); lastUrl = null; }
  els.resultVideo.removeAttribute('src');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------
function initUI() {
  els.drop.addEventListener('click', () => els.file.click());
  els.file.addEventListener('change', (e) => {
    const f = e.target.files && e.target.files[0];
    if (f) handleFile(f);
  });
  ['dragenter', 'dragover'].forEach((ev) => els.drop.addEventListener(ev, (e) => {
    e.preventDefault(); els.drop.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => els.drop.addEventListener(ev, (e) => {
    e.preventDefault(); els.drop.classList.remove('over');
  }));
  els.drop.addEventListener('drop', (e) => {
    const f = e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) handleFile(f);
  });

  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    els.fieldSize.hidden = mode !== 'size';
    els.fieldBitrate.hidden = mode !== 'bitrate';
    updateEstimate();
  }));

  [els.inSize, els.inBitrate, els.inScale, els.inFps, els.inCodec, els.inAudio]
    .forEach((el) => { el.addEventListener('input', updateEstimate); el.addEventListener('change', updateEstimate); });

  window.addEventListener('resize', () => { if (state && currentStep === 'trim') renderTrim(); });

  // Step navigation
  document.querySelectorAll('.stepbtn').forEach((b) => b.addEventListener('click', () => {
    if (!state && b.dataset.step !== 'source') return;   // locked until a video loads
    showStep(b.dataset.step);
  }));
  els.nextSettings.addEventListener('click', () => showStep('settings'));
  els.nextExport.addEventListener('click', () => showStep('export'));

  els.btnCompress.addEventListener('click', compress);
  els.btnCancel.addEventListener('click', () => { cancelRequested = true; setStatus('Cancelling…'); });
}

async function handleFile(f) {
  try {
    setStatus('');
    if (state && state.previewURL) { URL.revokeObjectURL(state.previewURL); }
    await loadFile(f);
  } catch (err) {
    console.error(err);
    els.info.textContent = `Could not load this file: ${err.message || err}`;
    els.steps.hidden = true;
    showStep('source');
  }
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
(function boot() {
  const missing = detectSupport();
  if (missing.length) {
    els.unsupported.hidden = false;
    els.unsupportedWhy.textContent = `Missing: ${missing.join(', ')}.`;
    els.paneSource.hidden = true;
    return;
  }
  initUI();
  showStep('source');
  const saved = readSettings();
  if (saved && saved.file && saved.file.name) {
    els.info.textContent = `Last session: “${saved.file.name}”. Load it again to restore your trim, cuts & settings — or load any video to reuse your settings.`;
  }
})();
