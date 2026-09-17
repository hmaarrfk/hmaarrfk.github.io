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
// AAC audio is copied through untouched (remuxed, never re-encoded) — unless
// a volume boost is on, in which case just the audio is decoded, gained
// (audio-boost.js), and re-encoded to AAC; the video path is unaffected.
//
// Optional auto-captions (captions-ui.js + captions.js + captions-worker.js)
// transcribe the
// kept audio with an open-weights Whisper model — on the GPU via WebGPU when
// available — and draw the captions onto the frames before they're encoded.
// Everything runs locally; no file ever leaves the machine.
//
// MP4Box is loaded as a global (window.MP4Box) by a <script> tag in index.html.
import { Muxer, ArrayBufferTarget } from './vendor/mp4-muxer/mp4-muxer.js';
import { dbToLinear, analyzeVoiceLevel, applyGainInPlace, createLeveler } from './audio-boost.js';
import { cueAt, drawCaption } from './captions.js';
import { createTimeStretcher } from './speed.js';
import { detectBreaths, duckRegions } from './breath.js';
import { findRoomTone, crossfadeEdges } from './voice.js';
import { createCaptions } from './captions-ui.js';
import { createVoice } from './voice-ui.js';

const MP4Box = window.MP4Box;
const AAC_CODEC = 'mp4a.40.2';   // AAC-LC — what we re-encode audio to when a boost is on

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
  btnSpeedVoice: $('btn-speed-voice'), btnSpeedSilent: $('btn-speed-silent'), inSpeedRate: $('in-speed-rate'),
  inBreathMode: $('in-breath-mode'), inBreathDb: $('in-breath-db'),
  fieldBreathDb: $('field-breath-db'), hintBreath: $('hint-breath'),
  cutInfo: $('cut-info'),
  // settings
  fieldSize: $('field-size'), fieldBitrate: $('field-bitrate'),
  inSize: $('in-size'), inBitrate: $('in-bitrate'),
  inScale: $('in-scale'), inFps: $('in-fps'), inCodec: $('in-codec'), inAudio: $('in-audio'),
  hintSize: $('hint-size'), hintBitrate: $('hint-bitrate'), hintScale: $('hint-scale'),
  hintFps: $('hint-fps'), hintCodec: $('hint-codec'), hintAudio: $('hint-audio'),
  fieldGain: $('field-gain'), inGain: $('in-gain'), hintGain: $('hint-gain'), hintVolume: $('hint-volume'),
  audioLiveNote: $('audio-live-note'),
  // captions
  capOverlay: $('cap-overlay'),
  inCapModel: $('in-cap-model'), inCapLang: $('in-cap-lang'), inCapSize: $('in-cap-size'),
  inCapPos: $('in-cap-pos'), inCapLook: $('in-cap-look'),
  inCapBurn: $('in-cap-burn'), hintCapModel: $('hint-cap-model'),
  btnCapGen: $('btn-cap-gen'), btnCapCancel: $('btn-cap-cancel'), btnCapClear: $('btn-cap-clear'),
  capProgress: $('cap-progress'), capStatus: $('cap-status'), capNote: $('cap-note'), capList: $('cap-list'),
  // overdub
  inVoiceLang: $('in-voice-lang'), hintVoiceLang: $('hint-voice-lang'),
  inVoiceTrack: $('in-voice-track'),
  inVoiceTrim: $('in-voice-trim'), inVoiceDeadAir: $('in-voice-deadair'),
  btnVoiceRef: $('btn-voice-ref'), voiceRef: $('voice-ref'),
  btnVoiceAll: $('btn-voice-all'), btnVoiceAllCancel: $('btn-voice-all-cancel'),
  voiceProgress: $('voice-progress'), voiceStatus: $('voice-status'),
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
// Live audio-boost preview — a Web Audio graph patched onto the shared
// <video> element so scrubbing/playing the preview is heard with the same
// gain that a compress would bake in. Not started until the first play (a
// user gesture is required to create/resume an AudioContext).
// ---------------------------------------------------------------------------
let audioCtx = null, previewGainNode = null, previewLimiterNode = null, previewSrcNode = null;

function ensureAudioGraph() {
  if (audioCtx || !els.preview) return;
  try {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    previewSrcNode = audioCtx.createMediaElementSource(els.preview);
    previewGainNode = audioCtx.createGain();
    previewLimiterNode = audioCtx.createDynamicsCompressor();
    // A fast, hard-kneed compressor standing in for the export's lookahead
    // leveler — auto mode's gain is a *ceiling*, not a flat boost (the real
    // encode ducks it automatically on loud passages), so this needs real
    // headroom to compress into rather than just catching the odd peak.
    previewLimiterNode.threshold.value = -24;
    previewLimiterNode.knee.value = 6;
    previewLimiterNode.ratio.value = 20;
    previewLimiterNode.attack.value = 0.003;
    previewLimiterNode.release.value = 0.25;
    previewSrcNode.connect(previewGainNode).connect(previewLimiterNode).connect(audioCtx.destination);
  } catch (e) { console.warn('Live audio preview unavailable:', e); }
}

// The volume mode + gain currently selected in the UI, resolved to a dB
// value (0 when off, the slider value in manual mode, the analyzed value in
// auto mode — 0 until that analysis finishes).
function currentVolumeMode() {
  const el = document.querySelector('input[name="volume"]:checked');
  return el ? el.value : 'none';
}
function currentAudioGainDb() {
  if (!state) return 0;
  const mode = currentVolumeMode();
  if (mode === 'manual') return parseFloat(els.inGain.value) || 0;
  if (mode === 'auto') return state.audioAnalysis ? state.audioAnalysis.autoGainDb : 0;
  return 0;
}
function updatePreviewGain() {
  const db = currentAudioGainDb();
  if (els.audioLiveNote) {
    const auto = currentVolumeMode() === 'auto';
    els.audioLiveNote.textContent = db > 0.05 ? `🔊 live preview: ${auto ? 'up to ' : ''}+${db.toFixed(1)} dB` : '';
  }
  if (previewGainNode) {
    const s = state ? spanAt(els.preview.currentTime || 0) : null;
    const silent = !!s && s.rate !== 1 && s.audio !== 'keep';
    const duck = state && inBreath(els.preview.currentTime || 0) ? breathGainDb() : 0;
    previewGainNode.gain.value = silent ? 0 : dbToLinear(db + duck);
  }
}

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
      `Final preview — trimmed${editNote()} · ${fmtTime(keptDuration())}`;
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
  if (state && name !== 'source') { renderTrim(); renderPlayhead(); captions.renderOverlay(); }
  if (state && name === 'trim') captions.renderList();
  if (state && name === 'export') updateExportSummary();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function updateExportSummary() {
  if (!state) return;
  const s = currentSettings();
  const target = s.mode === 'size'
    ? `target ${els.inSize.value} MB`
    : `${parseFloat(els.inBitrate.value)} Mbps`;
  const volumeNote = s.keepAudio && s.audioGainDb > 0.05
    ? ` · ${s.volumeMode === 'auto' ? 'up to ' : ''}+${s.audioGainDb.toFixed(1)} dB (${s.volumeMode})`
    : '';
  els.exportSummary.textContent =
    `${s.outW}×${s.outH} · ${s.outFps.toFixed(0)} fps · ${s.codec === 'hevc' ? 'H.265' : 'H.264'} · ` +
    `${target} · ${fmtTime(s.trimDur)} kept${s.keepAudio ? ' · audio kept' : (state.audio ? ' · audio dropped' : '')}${volumeNote}${captions.burnOn() ? ' · captions burned in' : ''}`;
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
// Auto-captions live in their own module (captions-ui.js); it gets the DOM,
// the current state, and the few timeline/audio helpers it needs from here.
// ---------------------------------------------------------------------------
// Overdub lives in its own module too (voice-ui.js). It is created first
// because the transcript list offers a "respeak" button on every line, so
// captions needs to be able to reach it.
const voice = createVoice({
  els,
  getState: () => state,
  timeline: { keptSegments, fullSegments, toOutputTime, fromOutputTime, seek },
  edits: {
    // A respoken span is an ordinary edit carrying the id of its audio.
    applyDub: (start, end, rate, dub) => applyEdit(start, end, rate, 'keep', { dub }),
    clearDub: (start, end) => applyEdit(start, end, 1, 'keep'),
  },
  audio: { decodeAudioTrack, mixToMono, concatFloat32 },
  fmt: { fmtTime, fmtBytes },
  setProgress,
  onChanged: () => {
    renderTrim();
    captions.renderList();
    if (currentStep === 'export') updateExportSummary();
  },
});

const captions = createCaptions({
  els,
  voice,
  getState: () => state,
  timeline: { keptSegments, fullSegments, toOutputTime, fromOutputTime, seek },
  // The transcript is an editing surface: each line can be cut or sped up.
  edits: {
    apply: (start, end, rate, audio) => applyEdit(start, end, rate, audio),
    at: (t) => activeEdits().find((e) => t >= e.start - 1e-3 && t < e.end - 1e-3) || null,
    rate: () => currentSpeedRate(),
    rateLabel: () => fmtRate(currentSpeedRate()),
    label: (e) => editLabel(e),
  },
  audio: {
    decodeAudioTrack, mixToMono, concatFloat32,
    // Captions transcribe the boosted signal, so they need what Volume is set to.
    gain: () => ({ mode: currentVolumeMode(), db: currentAudioGainDb() }),
  },
  fmt: { fmtTime, fmtBytes },
  playLine,
  setProgress,
  onChanged: () => {
    if (currentStep === 'export') updateExportSummary();
    // A fresh transcript pins the edges of speech, which is better information
    // than the level threshold breath detection started with.
    if (els.inBreathMode.value !== 'off') refreshBreaths();
  },
});

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
      volume: currentVolumeMode(), gain: els.inGain.value,
      breathMode: els.inBreathMode.value, breathDb: els.inBreathDb.value,
      ...captions.settings(),
      ...voice.settings(),
    },
    file: { name: state.file.name, size: state.file.size, lastModified: state.file.lastModified },
    trim: { inS: state.inS, outS: state.outS, edits: state.edits },
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
  if (g.gain != null) els.inGain.value = g.gain;
  if (g.breathMode != null) els.inBreathMode.value = g.breathMode;
  if (g.breathDb != null) els.inBreathDb.value = g.breathDb;
  captions.applySettings(g);
  voice.applySettings(g);
  const modeRadio = document.querySelector(`input[name="mode"][value="${g.mode}"]`);
  if (modeRadio) { modeRadio.checked = true; els.fieldSize.hidden = g.mode !== 'size'; els.fieldBitrate.hidden = g.mode !== 'bitrate'; }
  // The volume boost is deliberately *not* restored: it starts off for every
  // recording. It re-encodes the audio and lifts whatever sits in the gaps —
  // breaths included — so it should be a choice made while listening to this
  // file, not a setting that follows you from the last one. The slider value is
  // remembered for when it is switched on.
  const noneRadio = document.querySelector('input[name="volume"][value="none"]');
  if (noneRadio) noneRadio.checked = true;
}

function setStatus(msg) { els.status.textContent = msg || ''; }
function setProgress(frac, bar = els.progress) {
  if (frac == null) { bar.style.display = 'none'; return; }
  bar.style.display = 'block';
  bar.firstElementChild.style.width = `${clamp(frac, 0, 1) * 100}%`;
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

// The esds payload (after its version/flags) of an mp4a sample entry. MP4Box
// finds it directly in MP4 files, but QuickTime sound descriptions — version
// 1/2 entries, which macOS/iOS screen recordings write — carry extra fields
// MP4Box doesn't skip, and nest the esds inside a `wave` box. MP4Box then sees
// no esds at all, so look for it in the entry's raw bytes instead.
async function esdsPayload(file, entry) {
  if (entry.esds) return boxPayload(file, entry.esds);
  const bytes = new Uint8Array(await readRange(file, entry.start, entry.start + entry.size));
  const dv = new DataView(bytes.buffer);
  for (let i = 4; i + 12 <= bytes.length; i++) {
    if (bytes[i] !== 0x65 || bytes[i + 1] !== 0x73 || bytes[i + 2] !== 0x64 || bytes[i + 3] !== 0x73) continue;   // 'esds'
    const size = dv.getUint32(i - 4);
    if (size >= 12 && i - 4 + size <= bytes.length) return bytes.slice(i + 8, i - 4 + size);
  }
  return null;
}

// The MPEG-4 descriptors of an esds: the object type and the
// AudioSpecificConfig (what AudioDecoder wants as `description`).
async function aacConfig(file, mp4, trackId) {
  const trak = mp4.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    if (entry.type !== 'mp4a') continue;
    const v = await esdsPayload(file, entry);
    if (!v) continue;
    const o = { p: 0 };
    const readLen = () => { let b, n = 0; do { b = v[o.p++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80); return n; };
    if (v[o.p++] !== 0x03) return null; readLen(); o.p += 3;   // ES_Descriptor
    if (v[o.p++] !== 0x04) return null; readLen();             // DecoderConfigDescriptor
    const objectType = v[o.p]; o.p += 13;
    if (v[o.p++] !== 0x05) return null;                        // DecoderSpecificInfo
    const len = readLen();                                     // advance o.p BEFORE slicing
    return { objectType, asc: v.slice(o.p, o.p + len) };
  }
  return null;
}

async function aacDescription(file, mp4, trackId) {
  const cfg = await aacConfig(file, mp4, trackId);
  return cfg ? cfg.asc : null;
}

// WebCodecs needs the full codec string (`mp4a.40.2`), which MP4Box builds
// from the esds — for a QuickTime sound description it reports just `mp4a`.
// Rebuild it from the AudioSpecificConfig's audio object type.
async function fixAacCodec(file, mp4, audio) {
  if (!audio || audio.codec !== 'mp4a') return;
  const cfg = await aacConfig(file, mp4, audio.id).catch(() => null);
  if (!cfg || !cfg.asc.length) return;
  const a = cfg.asc;
  let aot = a[0] >> 3;
  if (aot === 31 && a.length > 1) aot = 32 + (((a[0] & 0x07) << 3) | (a[1] >> 5));
  audio.codec = `mp4a.${cfg.objectType.toString(16)}.${aot}`;
}

// Parse a file's metadata into a fresh MP4Box instance. Cheap (moov only), so
// background audio passes open their own rather than sharing — and fighting
// over the sample callbacks of — the one compress() uses.
async function openDemuxer(file, atoms) {
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
  return { mp4, info };
}

// ---------------------------------------------------------------------------
// Load & parse a source file (metadata only — no mdat payload).
// ---------------------------------------------------------------------------
async function loadFile(file) {
  captions.abort();
  resetResult();
  els.panePreview.hidden = true;
  els.paneSettings.hidden = true;
  els.info.textContent = 'Analyzing…';

  const atoms = await walkAtoms(file);
  const mdat = atoms.find((a) => a.type === 'mdat');
  if (!mdat) throw new Error('No media data (mdat) box found — is this a valid MP4/MOV?');

  const { mp4, info } = await openDemuxer(file, atoms);

  const video = info.videoTracks && info.videoTracks[0];
  if (!video) throw new Error('No video track found in this file.');
  const audio = info.audioTracks && info.audioTracks[0];
  await fixAacCodec(file, mp4, audio);

  const durationS = info.duration / info.timescale;
  const fps = video.nb_samples / (video.duration / video.timescale);

  if (lastUrl) { /* keep result url logic separate */ }
  const previewURL = URL.createObjectURL(file);

  state = {
    file, mp4, atoms, mdat, video, audio, durationS, fps, previewURL,
    inS: 0, outS: durationS, edits: [], pendingMarkStart: null,
    audioAnalysis: null, audioEncoderSupported: false, breaths: [],
    isAac: false, captions: captions.restore(file),
    // Respoken lines: the samples aren't persisted (they're regenerated from
    // the same text and seed), so this starts empty even when intent survives.
    dubs: new Map(), dubsRestored: voice.reset(file),
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
  state.isAac = !!isAac;
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

  // Volume boost needs to decode + re-encode the audio (passthrough only
  // remuxes it), so check the browser can actually encode AAC before
  // offering it.
  if (isAac && typeof AudioEncoder !== 'undefined') {
    const aacEncCfg = { codec: AAC_CODEC, sampleRate: audio.audio.sample_rate, numberOfChannels: audio.audio.channel_count, bitrate: audio.bitrate || 160_000 };
    state.audioEncoderSupported = (await AudioEncoder.isConfigSupported(aacEncCfg).catch(() => ({ supported: false }))).supported;
  }
  document.querySelectorAll('input[name="volume"][value="manual"], input[name="volume"][value="auto"]')
    .forEach((r) => { r.disabled = !state.audioEncoderSupported; });
  if (!state.audioEncoderSupported) {
    const noneRadio = document.querySelector('input[name="volume"][value="none"]');
    if (noneRadio) noneRadio.checked = true;
  }
  // Kick off (background, non-blocking) analysis for Auto mode's hint. Cheap
  // relative to the encode itself — it's a decode-only pass over the audio.
  if (isAac && state.audioEncoderSupported) {
    const loadedFor = state;
    analyzeAudio(loadedFor).then((result) => {
      if (state !== loadedFor) return;   // a different file was loaded meanwhile
      state.audioAnalysis = result;
      state.breaths = result.breaths || [];
      state.breathKey = 'false|0';
      syncBreathEdits();
      updateAudioUI();
    }).catch((e) => console.error('Audio analysis failed:', e));
  }

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
      // `cuts` is what older versions saved: plain removed ranges, i.e. rate 0.
      const savedEdits = Array.isArray(saved.trim.edits) ? saved.trim.edits
        : Array.isArray(saved.trim.cuts) ? saved.trim.cuts.map((c) => ({ ...c, rate: 0 }))
        : [];
      state.edits = savedEdits
        .filter((e) => e && isFinite(e.start) && isFinite(e.end) && isFinite(e.rate))
        .map((e) => ({ start: e.start, end: e.end, rate: e.rate, audio: e.audio === 'keep' ? 'keep' : 'mute' }));
      restoredNote = '  ·  restored your last trim, edits & settings';
    } else if (saved.general) {
      restoredNote = '  ·  applied your last settings';
    }
  }
  if (restoredNote) els.info.textContent += restoredNote;

  // Preview + trim
  setupPreview();

  els.steps.hidden = false;      // reveal step nav now that a video is loaded
  updateAudioUI();
  captions.setStatus(state.captions ? `Restored ${state.captions.cues.length} captions from last time.` : '');
  captions.updateUI();
  updateEstimate();
  showStep('trim');              // advance past the upload step
}

// ---------------------------------------------------------------------------
// Preview & trim
// ---------------------------------------------------------------------------
function trackWidth() { return els.tlTrack.clientWidth || 1; }
function timeToX(t) { return (t / state.durationS) * trackWidth(); }
function xToTime(x) { return clamp((x / trackWidth()) * state.durationS, 0, state.durationS); }

// ---------------------------------------------------------------------------
// The edit model
//
// One list describes everything done to the source timeline: `state.edits` is a
// sorted, non-overlapping set of { start, end, rate, audio } spans.
//
//   rate 0   — removed. The clip stitches back together across it.
//   rate > 1 — played faster. `audio` decides whether the section keeps its
//              narration (time-stretched, pitch preserved) or runs silent.
//
// Anything not covered plays at rate 1 with its own audio. A cut is just the
// limit case of speeding a section up, which is what lets one set of transcript
// buttons drive both.
// ---------------------------------------------------------------------------

// Edits clipped to the current [inS, outS] window, sorted.
function activeEdits() {
  const out = [];
  for (const e of state.edits) {
    const a = clamp(e.start, state.inS, state.outS);
    const b = clamp(e.end, state.inS, state.outS);
    // `dub` names a generated replacement for this span's narration; it has to
    // survive down to the encoder, which is the only place it is ever read.
    if (b - a > 1e-3) out.push({ start: a, end: b, rate: e.rate, audio: e.audio || 'mute', dub: e.dub || null });
  }
  return out.sort((x, y) => x.start - y.start);
}

// The kept timeline as spans, in order, each carrying where it lands in the
// output. Removed sections never appear here: they're gone.
function editSpans() {
  const spans = [];
  let cur = state.inS, o = 0;
  const push = (start, end, rate, audio, dub) => {
    if (!(rate > 0) || end - start <= 1e-3) return;
    const dur = (end - start) / rate;
    spans.push({ start, end, rate, audio, dub: dub || null, outStart: o, outEnd: o + dur });
    o += dur;
  };
  for (const e of activeEdits()) {
    if (e.start > cur) push(cur, e.start, 1, 'keep');
    push(Math.max(cur, e.start), e.end, e.rate, e.audio, e.dub);
    cur = Math.max(cur, e.end);
  }
  if (cur < state.outS) push(cur, state.outS, 1, 'keep');
  return spans;
}

// The span a source time falls in — null in a removed section or outside the
// selection. Playback rate, muting and the export all hang off this.
function spanAt(t, spans = editSpans()) {
  for (const s of spans) if (t >= s.start && t < s.end) return s;
  return null;
}

// Total output seconds: every span's duration divided by its rate.
function keptDuration() {
  const spans = editSpans();
  return Math.max(0.05, spans.length ? spans[spans.length - 1].outEnd : 0);
}

// The kept *source* ranges, speed ignored and touching spans merged — i.e. what
// survives to the output, which is what captions transcribe.
function keptSegments() {
  const segs = [];
  for (const s of editSpans()) {
    const last = segs[segs.length - 1];
    if (last && s.start - last.end < 1e-3) last.end = s.end;
    else segs.push({ start: s.start, end: s.end });
  }
  return segs;
}

// The whole file as one segment: what the transcript is generated over, so the
// trim can be decided *after* reading it.
function fullSegments() {
  return [{ start: 0, end: state.durationS }];
}

// Source time -> output time and back, honouring each span's rate. These power
// the compressed timeline in Settings/Export and every caption timestamp.
function toOutputTime(t) {
  const spans = editSpans();
  let o = 0;
  for (const s of spans) {
    if (t >= s.end) o = s.outEnd;
    else if (t > s.start) return s.outStart + (t - s.start) / s.rate;
    else return s.outStart;
  }
  return o;
}
// `spans` may be plain { start, end } ranges (a caption job's segments), which
// are read as rate 1.
function fromOutputTime(o, spans = editSpans()) {
  let acc = 0;
  for (const s of spans) {
    const rate = s.rate || 1;
    const d = (s.end - s.start) / rate;
    if (o <= acc + d) return s.start + (o - acc) * rate;
    acc += d;
  }
  return spans.length ? spans[spans.length - 1].end : state.inS;
}

// Whether a source time lands inside a removed section.
function inCut(t) {
  for (const e of activeEdits()) if (!(e.rate > 0) && t >= e.start && t < e.end) return true;
  return false;
}

// Lay an edit over a source range, replacing whatever was there. `rate === 1`
// clears the range back to normal speed, which is how "restore" works.
function applyEdit(start, end, rate, audio = 'mute', extra = null) {
  if (!state || end - start <= 1e-3) return;
  const kept = [];
  for (const e of state.edits) {
    if (e.end <= start + 1e-3 || e.start >= end - 1e-3) { kept.push(e); continue; }
    if (e.start < start) kept.push({ ...e, end: start });
    if (e.end > end) kept.push({ ...e, start: end });
  }
  // Rate 1 with nothing attached is "leave it alone", so it isn't stored — but
  // an overdub at natural length is exactly that rate and must be.
  if (rate !== 1 || (extra && extra.dub)) kept.push({ start, end, rate, audio, ...(extra || {}) });
  state.edits = kept.sort((a, b) => a.start - b.start);
  mergeEdits();
  renderTrim();
  captions.renderList();
  captions.renderOverlay();
  queueSave();
}

// Merge touching edits that say the same thing, so the set stays clean.
function mergeEdits() {
  state.edits.sort((a, b) => a.start - b.start);
  const merged = [];
  for (const e of state.edits) {
    const last = merged[merged.length - 1];
    // Two overdubs are never the same thing even when they abut: each carries
    // its own generated audio, so merging them would throw one away.
    if (last && e.start <= last.end + 1e-3 && last.rate === e.rate && last.audio === e.audio
        && last.src === e.src && !last.dub && !e.dub) {
      last.end = Math.max(last.end, e.end);
    } else {
      merged.push({ ...e });
    }
  }
  state.edits = merged.filter((e) => e.end - e.start > 1e-3);
}

// The breaths to act on: detected at load, minus anything the user has
// already dealt with by hand (a cut or a sped-up section covers its own audio).
function activeBreaths() {
  if (!state || !state.breaths || els.inBreathMode.value === 'off') return [];
  return state.breaths;
}
const breathGainDb = () => parseFloat(els.inBreathDb.value) || -15;

// The speed the two "speed up" buttons apply.
function currentSpeedRate() {
  const r = parseFloat(els.inSpeedRate && els.inSpeedRate.value);
  return isFinite(r) && r > 1 ? r : 1.5;
}

// Rates come from the menu in tenths, so print them without float dust.
const fmtRate = (r) => `${Math.round(r * 100) / 100}×`;

// "…, 2 cuts removed, 1 sped up" for the final-preview caption.
function editNote() {
  const edits = activeEdits();
  const cuts = edits.filter((e) => !(e.rate > 0)).length;
  const fast = edits.length - cuts;
  let note = '';
  if (cuts) note += `, ${cuts} cut${cuts > 1 ? 's' : ''} removed`;
  if (fast) note += `, ${fast} section${fast > 1 ? 's' : ''} sped up`;
  return note;
}

// ---------------------------------------------------------------------------
// Respoken lines, in the preview
// ---------------------------------------------------------------------------
// The <video> is playing the original file, so a respoken line isn't in it.
// While the playhead is inside a dubbed span, the element is muted and the
// generated samples are played instead — the *same* samples the encoder will
// get, so what you hear here is what you'll get out.
//
// It is routed through the same gain and limiter nodes as the recording,
// because the export puts a dub through its gain stage too — so a boost lifts
// the respoken line along with everything else, and the preview keeps telling
// the truth about what you'll get.
let dubSource = null, dubPlayingId = null;
// Auditioning one line: play to here, then stop. `dubOverride` forces the
// recording for the A/B button, without disturbing the page-wide choice.
let playUntil = null, dubOverride = null;

// Play one transcript line and stop at the end of it. Everything else about
// playback still applies — a sped-up section still plays fast, a cut is still
// skipped — so this is the line as it will be in the export, not a preview of
// the source.
function playLine(start, end, { dubs = true } = {}) {
  const v = els.preview;
  if (!v || !state) return;
  dubOverride = dubs ? null : 'original';
  playUntil = end;
  stopDubPlayback();
  ensureAudioGraph();
  if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
  seek(Math.max(0, start) + 0.001);
  updatePreviewGain();
  v.play();
}

function stopDubPlayback() {
  if (dubSource) {
    try { dubSource.onended = null; dubSource.stop(); } catch (_) {}
    try { dubSource.disconnect(); } catch (_) {}
  }
  dubSource = null;
  dubPlayingId = null;
}

// Returns whether a dub is sounding right now (so the original must stay down).
function syncDubPlayback(span, t, playing) {
  const track = dubOverride || voice.previewTrack();
  const want = (playing && span && span.dub && track === 'respoken') ? span.dub : null;
  if (!want) { if (dubPlayingId) stopDubPlayback(); return false; }
  if (dubPlayingId === want) return true;

  stopDubPlayback();
  ensureAudioGraph();
  if (!audioCtx) return false;
  // The span occupies (end - start) / rate seconds of output, which is exactly
  // how long the finished dub is — in 'natural' mode the rate is what absorbs
  // the difference, so this holds either way.
  const outSeconds = (span.end - span.start) / span.rate;
  const frames = Math.round(outSeconds * audioCtx.sampleRate);
  const buf = voice.previewBuffer(want, { sampleRate: audioCtx.sampleRate, frames }, audioCtx);
  if (!buf) return false;
  // Source time advances `rate` times per second of playback, so the elapsed
  // wall-clock time into the span — which is where the buffer should be — is
  // the source offset divided by the rate.
  const offset = clamp((t - span.start) / span.rate, 0, Math.max(0, buf.duration - 0.01));
  const src = audioCtx.createBufferSource();
  src.buffer = buf;
  src.connect(previewGainNode || audioCtx.destination);
  src.onended = () => { if (dubSource === src) { dubSource = null; dubPlayingId = null; } };
  try { src.start(0, offset); } catch (_) { return false; }
  dubSource = src;
  dubPlayingId = want;
  return true;
}

// Follow the span under the playhead: faster sections play faster, and a silent
// one is muted. Pitch is preserved, matching what the export's time-stretch
// does, so the preview sounds like the file you'll get.
function applySpanPlayback() {
  const v = els.preview;
  if (!state || !v) return;
  if (playUntil != null && !v.paused && (v.currentTime || 0) >= playUntil) {
    playUntil = null;
    v.pause();
    return;
  }
  const s = spanAt(v.currentTime || 0);
  const rate = s ? s.rate : 1;
  if (Math.abs(v.playbackRate - rate) > 1e-3) v.playbackRate = rate;
  if (v.preservesPitch === false) v.preservesPitch = true;
  const dubbing = syncDubPlayback(s, v.currentTime || 0, !v.paused);
  const lapseSilent = !!s && s.rate !== 1 && s.audio !== 'keep';
  // What silences the *original* under a respoken line is the element's own
  // mute, not the gain node: the dub is routed through that node and has to
  // keep coming out of it.
  const mute = lapseSilent || dubbing;
  if (v.muted !== mute) v.muted = mute;
  if (previewGainNode) {
    // Breath ducking describes the original audio, which isn't playing here.
    const duck = (!dubbing && inBreath(v.currentTime || 0)) ? breathGainDb() : 0;
    previewGainNode.gain.value = lapseSilent ? 0 : dbToLinear(currentAudioGainDb() + duck);
  }
}

// Whether a source time lands in a breath that's being turned down. Binary
// search: a long recording can hold hundreds of these and this runs every frame.
function inBreath(t) {
  const list = activeBreaths();
  if (!list.length) return false;
  let lo = 0, hi = list.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t < list[mid].start) hi = mid - 1;
    else if (t >= list[mid].end) lo = mid + 1;
    else return true;
  }
  return false;
}

// The preview follows the edit under the playhead, and `timeupdate` only fires
// about four times a second — too coarse for a breath. Track it per frame while
// something is actually playing.
let previewRaf = 0;
function previewLoop() {
  applySpanPlayback();
  previewRaf = requestAnimationFrame(previewLoop);
}
function startPreviewLoop() {
  if (!previewRaf) previewRaf = requestAnimationFrame(previewLoop);
}
function stopPreviewLoop() {
  if (previewRaf) { cancelAnimationFrame(previewRaf); previewRaf = 0; }
  playUntil = null;
  dubOverride = null;
  stopDubPlayback();
  applySpanPlayback();
}

// How an edit reads in the UI, everywhere.
function editLabel(e) {
  if (!(e.rate > 0)) return 'cut';
  if (e.dub) return e.rate === 1 ? 'respoken' : `respoken ${fmtRate(e.rate)}`;
  return `${fmtRate(e.rate)}${e.audio === 'keep' ? '' : ' silent'}`;
}

function renderEdits() {
  els.cutsLayer.innerHTML = '';
  activeEdits().forEach((e) => {
    const cut = !(e.rate > 0);
    const el = document.createElement('div');
    const left = timeToX(e.start), width = Math.max(2, timeToX(e.end) - timeToX(e.start));
    el.style.cssText =
      `position:absolute;top:0;bottom:0;left:${left}px;width:${width}px;cursor:pointer;` +
      `display:flex;align-items:center;justify-content:center;overflow:hidden;` +
      `font-size:.7rem;font-weight:700;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.6);` +
      (cut
        ? 'background:rgba(231,76,60,.55);border-left:1px solid #e74c3c;border-right:1px solid #e74c3c'
        : 'background:rgba(52,120,246,.45);border-left:1px solid #3478f6;border-right:1px solid #3478f6');
    if (width > 26) el.textContent = editLabel(e);
    el.title = `${cut ? 'Removed section' : `Sped up ${editLabel(e)}`} — click to restore`;
    el.onclick = (ev) => { ev.stopPropagation(); applyEdit(e.start, e.end, 1); };
    els.cutsLayer.appendChild(el);
  });
}

function renderPending() {
  const p = state.pendingMarkStart;
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
  renderEdits();
  renderPending();

  const kept = keptDuration();
  const edits = activeEdits();
  const cuts = edits.filter((e) => !(e.rate > 0)).length;
  const fast = edits.length - cuts;
  els.trimInfo.textContent = `Keep ${fmtTime(state.inS)} → ${fmtTime(state.outS)}  (${fmtTime(kept)} out)`;
  const parts = [];
  if (cuts) parts.push(`${cuts} cut${cuts > 1 ? 's' : ''}`);
  if (fast) parts.push(`${fast} sped up`);
  els.cutInfo.textContent = state.pendingMarkStart != null
    ? 'Start marked — scrub to the end, then pick an action'
    : parts.length ? parts.join(' · ') : 'No cuts or speed-ups';
  const marked = state.pendingMarkStart != null;
  for (const b of [els.btnCutEnd, els.btnSpeedVoice, els.btnSpeedSilent]) {
    if (b) b.style.outline = marked ? '2px solid var(--good)' : 'none';
  }
  updateEstimate();
}

function renderPlayhead() {
  paintPlayhead(els.preview.currentTime || 0);
  if (state.pendingMarkStart != null) renderPending();
}

function renderPlayButton() {
  // The preview block (transport included) is relocated between steps, so
  // look inside the block itself rather than wherever it happens to be hosted.
  const btn = els.previewBlock.querySelector('.transport [data-act="play"]');
  if (!btn) return;
  const playing = !els.preview.paused && !els.preview.ended;
  btn.classList.toggle('playing', playing);
  // Swap the icons with inline styles rather than a stylesheet rule: this page
  // and the shared tools.css are cached separately, so a visitor can easily
  // hold a stale stylesheet against fresh markup — and would then see both
  // icons at once. An inline style beats whatever the cached CSS says.
  const play = btn.querySelector('.i-play'), pause = btn.querySelector('.i-pause');
  if (play) play.style.display = playing ? 'none' : 'block';
  if (pause) pause.style.display = playing ? 'block' : 'none';
  btn.title = playing ? 'Pause (Space)' : 'Play (Space)';
  btn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

function frameStep() { return 1 / Math.max(1, state.fps); }
function seek(t) { els.preview.currentTime = clamp(t, 0, Math.max(0, state.durationS - 1e-3)); }

function setupPreview() {
  const v = els.preview;
  v.src = state.previewURL;
  v.load();
  seek(0);

  // Transport buttons
  els.previewBlock.querySelectorAll('.transport [data-act]').forEach((btn) => {
    btn.onclick = () => {
      switch (btn.dataset.act) {
        case 'play':
          if (v.paused) { ensureAudioGraph(); if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); updatePreviewGain(); v.play(); }
          else v.pause();
          break;
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
      for (const e of activeEdits()) {
        if (!(e.rate > 0) && v.currentTime >= e.start && v.currentTime < e.end - 1e-3) { seek(e.end); break; }
      }
    }
    applySpanPlayback();
    renderPlayhead();
    captions.renderOverlay();
  };
  v.onseeking = () => { stopDubPlayback(); };
  v.onseeked = () => {
    renderPlayhead();
    captions.renderOverlay();
    if (pendingSeek != null) { const t = pendingSeek; pendingSeek = null; v.currentTime = t; }
  };
  v.onloadedmetadata = () => { renderTrim(); renderPlayhead(); captions.renderOverlay(); };
  // Drive the play/pause icon off the video itself, so it stays honest however
  // playback started or stopped — the button, the Space bar, or the clip
  // reaching its end.
  v.onplay = () => { renderPlayButton(); captions.overlayLoop(); startPreviewLoop(); };
  v.onpause = () => { renderPlayButton(); stopPreviewLoop(); };   // stopPreviewLoop drops the dub
  v.onended = () => { renderPlayButton(); stopPreviewLoop(); };
  renderPlayButton();

  els.btnSetIn.onclick = () => { state.inS = clamp(v.currentTime || 0, 0, state.outS - frameStep()); renderTrim(); };
  els.btnSetOut.onclick = () => { state.outS = clamp(v.currentTime || 0, state.inS + frameStep(), state.durationS); renderTrim(); };
  els.btnResetTrim.onclick = () => { state.inS = 0; state.outS = state.durationS; renderTrim(); };

  // Cuts and speed-ups: mark a start, scrub to the end, then pick an action.
  els.btnCutStart.onclick = () => { state.pendingMarkStart = v.currentTime || 0; renderTrim(); };
  const markedRange = () => {
    if (state.pendingMarkStart == null) { setStatus('Mark a start first.'); return null; }
    const t = v.currentTime || 0;
    const a = Math.min(state.pendingMarkStart, t), b = Math.max(state.pendingMarkStart, t);
    state.pendingMarkStart = null;
    setStatus('');
    if (b - a <= 1e-3) { renderTrim(); return null; }
    return { a, b };
  };
  els.btnCutEnd.onclick = () => { const r = markedRange(); if (r) applyEdit(r.a, r.b, 0); };
  els.btnSpeedVoice.onclick = () => { const r = markedRange(); if (r) applyEdit(r.a, r.b, currentSpeedRate(), 'keep'); };
  els.btnSpeedSilent.onclick = () => { const r = markedRange(); if (r) applyEdit(r.a, r.b, currentSpeedRate(), 'mute'); };
  els.btnClearCuts.onclick = () => { state.edits = []; state.pendingMarkStart = null; applyEdit(0, 0, 1); renderTrim(); };

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
    if (e.key === ' ') {
      e.preventDefault();
      if (v.paused) { ensureAudioGraph(); if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); updatePreviewGain(); v.play(); }
      else v.pause();
    }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); v.pause(); seek((v.currentTime || 0) - frameStep()); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); v.pause(); seek((v.currentTime || 0) + frameStep()); }
    else if (e.key === 'Home') { seek(state.inS); }
    else if (e.key === 'End') { seek(state.outS); }
    else if ((e.key === 'c' || e.key === 'C') && previewMode === 'edit') { e.preventDefault(); (state.pendingMarkStart == null ? els.btnCutStart : els.btnCutEnd).click(); }
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
  const volumeMode = currentVolumeMode();
  const audioGainDb = currentAudioGainDb();
  const breathMode = els.inBreathMode ? els.inBreathMode.value : 'off';
  const breathDb = parseFloat(els.inBreathDb && els.inBreathDb.value) || -15;
  return { mode, scale, outW, outH, outFps, codec, keepAudio, trimDur, volumeMode, audioGainDb, breathMode, breathDb };
}

// Keep the Volume controls, hint text, and live preview gain in sync with
// the selected mode and (for Auto) the background analysis.
function updateAudioUI() {
  if (!state) return;
  const mode = currentVolumeMode();
  els.fieldGain.hidden = mode !== 'manual';
  if (mode === 'manual') els.hintGain.textContent = `+${parseFloat(els.inGain.value).toFixed(1)} dB, through a soft limiter.`;

  if (!state.audioEncoderSupported) {
    els.hintVolume.textContent = state.audio
      ? "This browser can't encode AAC, so volume boost isn't available here — audio will pass through unchanged."
      : '';
  } else if (mode === 'auto') {
    els.hintVolume.textContent = state.audioAnalysis
      ? `Voice-band level ≈ ${state.audioAnalysis.voiceDbfs.toFixed(0)} dBFS → boosts quiet parts up to +${state.audioAnalysis.autoGainDb.toFixed(1)} dB, automatically backing off on loud parts (a jingle, a shout) so they aren’t driven any louder.`
      : 'Analyzing audio…';
  } else if (mode === 'manual') {
    els.hintVolume.textContent = 'Applied to the whole track, then limited so it can’t clip.';
  } else {
    els.hintVolume.textContent = '';
  }
  updateBreathUI();
  updatePreviewGain();
}

// Speech, as the transcript knows it: exact edges, so a breath taken the
// instant a sentence ends is still inside the gap rather than inside a guess.
function transcriptSpeech() {
  const caps = state && state.captions;
  if (!caps) return null;
  // Words, not cues: a cue covers a whole phrase including the pauses inside
  // it, and consecutive cues usually touch, so cues would mark almost the
  // entire recording as speech and leave no gaps to work with.
  const source = (caps.words && caps.words.length) ? caps.words : null;
  if (!source) return null;
  const regions = [];
  for (const c of source) {
    const last = regions[regions.length - 1];
    if (last && c.start - last.end < 0.05) last.end = Math.max(last.end, c.end);
    else regions.push({ start: c.start, end: c.end });
  }
  return regions;
}

// Re-run detection over the whole track. The decoded audio isn't kept around —
// on a long recording it's hundreds of MB — so this streams it again, which is
// why it only runs when the answer would actually change.
let breathRun = 0;
async function refreshBreaths() {
  if (!state || !state.isAac) return;
  const st = state;
  const run = ++breathRun;
  const everything = els.inBreathMode.value === 'gaps';
  // The transcript is used only to make the *aggressive* mode safe. As a mask
  // for ordinary breath detection it does more harm than good: Whisper's word
  // spans are padded and run together, so they cover 84% of a recording and
  // swallow the breaths that sit against a word — on a real 10:44 screencast,
  // masking by them dropped 91 breaths to 34. Level-based detection finds them;
  // the word timings only earn their keep when the rule is "everything that
  // isn't a word", where being wrong would mean ducking speech.
  const speechRegions = everything ? transcriptSpeech() : null;
  const key = `${everything}|${speechRegions ? speechRegions.length : 0}`;
  if (st.breathKey === key) return;
  els.hintBreath.textContent = 'Listening for breaths…';
  try {
    const chunks = [];
    const ok = await decodeAudioTrack(st, (frame) => chunks.push(mixToMono(frame)));
    if (!ok || run !== breathRun || state !== st) return;
    const mono = concatFloat32(chunks);
    const { breaths } = detectBreaths(mono, st.audio.audio.sample_rate, { speechRegions, everything });
    if (run !== breathRun || state !== st) return;
    st.breaths = breaths;
    st.breathKey = key;
    syncBreathEdits();
    updateBreathUI();
    updateEstimate();
  } catch (e) {
    console.error('Breath detection failed:', e);
    updateBreathUI();
  }
}

function updateBreathUI() {
  if (!els.inBreathMode) return;
  const mode = els.inBreathMode.value;
  els.fieldBreathDb.hidden = mode === 'off';
  const found = (state && state.breaths) || [];
  if (!state || !state.isAac) {
    els.hintBreath.textContent = '';
  } else if (!state.audioAnalysis) {
    els.hintBreath.textContent = 'Listening for breaths…';
  } else if (!found.length) {
    els.hintBreath.textContent = 'No breaths found in this recording.';
  } else {
    const total = found.reduce((n, b) => n + (b.end - b.start), 0);
    const what = mode === 'off' ? 'found'
      : mode === 'shorten' ? `turned down ${breathGainDb()} dB, long ones shortened`
      : `turned down ${breathGainDb()} dB`;
    const noun = mode === 'gaps'
      ? `quiet stretch${found.length > 1 ? 'es' : ''}`
      : `breath${found.length > 1 ? 's' : ''}`;
    els.hintBreath.textContent = `${found.length} ${noun} · ${fmtTime(total)} of the recording · ${what}.`;
    if (mode === 'gaps' && !transcriptSpeech()) {
      els.hintBreath.textContent += ' Generate a transcript in step 2 first — without it, the gaps between phrases aren’t known and quiet words would be turned down too.';
    }
  }
  if (!state || !state.audioEncoderSupported) {
    const note = state && state.audio && state.isAac
      ? " This browser can't re-encode AAC, so breaths can't be changed here."
      : '';
    if (note) els.hintBreath.textContent = note.trim();
  }
}

// "Turn down and shorten" tightens a long breath by running it fast and silent.
// That is exactly what a speed-up edit already does, so it's expressed as one:
// it shows on the timeline, it can be clicked away, and it needs no separate
// path through the export. Tagged `breath` so regenerating them can't disturb
// anything the user placed by hand.
function syncBreathEdits() {
  if (!state) return;
  const before = JSON.stringify(state.edits);
  state.edits = state.edits.filter((e) => e.src !== 'breath');
  if (els.inBreathMode.value === 'shorten') {
    const TARGET = 0.18;    // what a shortened breath is squeezed to, in seconds
    const MIN = 0.35;       // leave short breaths alone; there's nothing to gain
    for (const b of state.breaths || []) {
      const dur = b.end - b.start;
      if (dur < MIN) continue;
      // Don't fight an edit the user already made over this stretch.
      if (state.edits.some((e) => b.start < e.end - 1e-3 && b.end > e.start + 1e-3)) continue;
      state.edits.push({
        start: b.start, end: b.end, rate: Math.min(8, dur / TARGET), audio: 'mute', src: 'breath',
      });
    }
  }
  mergeEdits();
  if (JSON.stringify(state.edits) !== before) {
    renderTrim();
    captions.renderList();
    captions.renderOverlay();
    queueSave();
  }
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
  updateAudioUI();
  captions.updateUI();
  if (currentStep === 'export') updateExportSummary();
  queueSave();
  queueValidate();
}

// ---------------------------------------------------------------------------
// Auto-boost analysis — a decode-only pass over the whole audio track that
// measures voice-band loudness (see audio-boost.js). Runs once per loaded
// file, in the background; its result just feeds the "Auto" hint and gain.
// ---------------------------------------------------------------------------
async function analyzeAudio(st) {
  const chunks = [];   // mono-mixed Float32Array pieces, concatenated at the end
  const ok = await decodeAudioTrack(st, (frame) => chunks.push(mixToMono(frame)));
  if (!ok) return { voiceDbfs: 0, activeFraction: 0, autoGainDb: 0, breaths: [], roomTone: null };
  const mono = concatFloat32(chunks);
  if (!mono.length) return { voiceDbfs: -90, activeFraction: 0, autoGainDb: 0, breaths: [], roomTone: null };
  const rate = st.audio.audio.sample_rate;
  // The track is already decoded and in hand, so finding the breaths costs one
  // more pass over it rather than another trip through the decoder.
  const { breaths } = detectBreaths(mono, rate);
  // The whole track is in hand exactly once, which is the only cheap moment to
  // take a room-tone sample. Overdub lays it under respoken lines so the
  // background never stops at a splice — see voice.js findRoomTone().
  const roomTone = findRoomTone(mono, rate);
  return { ...analyzeVoiceLevel(mono, rate), breaths, roomTone };
}

function mixToMono(frame) {
  const n = frame.numberOfFrames, ch = frame.numberOfChannels;
  const mono = new Float32Array(n);
  const plane = new Float32Array(n);
  for (let c = 0; c < ch; c++) {
    frame.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
    for (let i = 0; i < n; i++) mono[i] += plane[i] / ch;
  }
  return mono;
}

function concatFloat32(parts) {
  let total = 0;
  for (const p of parts) total += p.length;
  const out = new Float32Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

// Decode-only pass over the (AAC) audio track, handing every AudioData to
// onFrame (closed afterwards). Streams mdat like compress() does, on its own
// demuxer; stops early once samples pass `untilS` seconds. Returns false if
// the browser can't decode this audio.
async function decodeAudioTrack(st, onFrame, { untilS = Infinity, onProgress = null } = {}) {
  const { file, atoms, mdat, audio } = st;
  const { mp4 } = await openDemuxer(file, atoms);
  const description = await aacDescription(file, mp4, audio.id).catch(() => null);
  const decCfg = { codec: audio.codec, sampleRate: audio.audio.sample_rate, numberOfChannels: audio.audio.channel_count, description };
  if (!(await AudioDecoder.isConfigSupported(decCfg).catch(() => ({ supported: false }))).supported) return false;

  let decodeErr = null;
  const decoder = new AudioDecoder({
    output: (frame) => {
      try { if (!decodeErr) onFrame(frame); } catch (e) { decodeErr = e; } finally { frame.close(); }
    },
    error: (e) => { decodeErr = e; },
  });
  decoder.configure(decCfg);

  const aq = [];
  let pastEnd = false;
  mp4.onSamples = (id, user, smps) => {
    for (const smp of smps) {
      if (smp.cts / smp.timescale > untilS) { pastEnd = true; break; }
      aq.push({ data: smp.data.slice(0), cts: smp.cts, duration: smp.duration, timescale: smp.timescale, is_sync: smp.is_sync });
    }
    mp4.releaseUsedSamples(id, smps[smps.length - 1].number);
  };
  mp4.setExtractionOptions(audio.id, 'audio', { nbSamples: 200 });
  mp4.start();

  const feed = async () => {
    while (aq.length) {
      const smp = aq.shift();
      decoder.decode(new EncodedAudioChunk({
        type: smp.is_sync ? 'key' : 'delta',
        timestamp: Math.round((smp.cts / smp.timescale) * 1e6),
        duration: Math.round((smp.duration / smp.timescale) * 1e6),
        data: smp.data,
      }));
      while (decoder.decodeQueueSize > 8) await sleep(4);
      if (decodeErr) throw decodeErr;
    }
  };

  const CHUNK = 8 * 1024 * 1024;
  const startByte = mdat.start + mdat.hdr;
  const endByte = mdat.start + mdat.size;
  let off = startByte;
  try {
    while (off < endByte && !pastEnd) {
      const e = Math.min(off + CHUNK, endByte);
      const ab = await readRange(file, off, e);
      ab.fileStart = off;
      off = e;
      mp4.appendBuffer(ab);
      await feed();
      if (onProgress) onProgress((off - startByte) / Math.max(1, endByte - startByte));
    }
    mp4.flush();
    await feed();
    await decoder.flush();
  } finally {
    try { if (decoder.state !== 'closed') decoder.close(); } catch (_) {}
    try { mp4.onSamples = null; mp4.stop(); } catch (_) {}
  }
  if (decodeErr) throw decodeErr;
  return true;
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

  let decoder, encoder, muxer, audioDecoder, audioEncoder;
  try {
    const vBitrate = targetVideoBitrate(s);
    const inMicros = Math.round(state.inS * 1e6);
    const outMicros = Math.round(state.outS * 1e6);
    // The kept sections, in microseconds, each knowing where it lands in the
    // output. Removed sections simply aren't here; sped-up ones carry the rate
    // their frames and samples get divided by.
    const spansUS = editSpans().map((sp) => ({
      ...sp,
      startUS: Math.round(sp.start * 1e6),
      endUS: Math.round(sp.end * 1e6),
      outStartUS: Math.round(sp.outStart * 1e6),
    }));
    const spanAtUS = (t) => { for (const sp of spansUS) if (t >= sp.startUS && t < sp.endUS) return sp; return null; };
    // Source time -> output time, within the section it belongs to.
    const toOutputUS = (t, sp) => sp.outStartUS + (t - sp.startUS) / sp.rate;

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

    // ---- Audio ----
    // Any speed change forces a re-encode: a copied AAC stream can't be
    // time-stretched or silenced. A volume boost forces one too. With neither,
    // the original samples are copied through untouched — much the fastest path.
    const hasSpeed = spansUS.some((sp) => sp.rate !== 1);
    const wantsBoost = s.audioGainDb > 0.05;
    // Turning breaths down is a change to the samples, so it needs the same
    // decode → process → re-encode round trip that a boost or a speed-up does.
    const wantsBreathWork = s.breathMode !== 'off' && !!(state.breaths && state.breaths.length);
    // A respoken line replaces samples outright, so it needs the re-encode too.
    const hasDubs = spansUS.some((sp) => !!sp.dub);
    const canReencode = state.audioEncoderSupported;
    const needAudioWork = s.keepAudio && !!audio && (hasSpeed || wantsBoost || wantsBreathWork || hasDubs) && canReencode;
    // A speed-up or an overdub we can't re-encode would silently desync the
    // audio (or quietly drop the new words), so drop it.
    const dropAudio = s.keepAudio && !!audio && (hasSpeed || hasDubs) && !canReencode;

    // ---- Muxer ----
    const muxerOpts = {
      target: new ArrayBufferTarget(),
      fastStart: 'in-memory',
      firstTimestampBehavior: 'offset',
      video: { codec: s.codec, width: s.outW, height: s.outH },
    };
    if (s.keepAudio && audio && !dropAudio) {
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

    // ---- Audio ----
    const asc = (s.keepAudio && audio) ? await aacDescription(file, mp4, audio.id).catch(() => null) : null;
    let audioEmitted = 0;

    const SR = audio ? audio.audio.sample_rate : 48000;
    const CH = audio ? audio.audio.channel_count : 2;

    // "Auto" runs a lookahead leveler (audio-boost.js) that rides the gain up
    // during quiet voice and ducks anything loud — it holds a few ms internally,
    // so its output doesn't line up 1:1 with each input frame. Every section is
    // trimmed or padded to its exact frame count on the way out, which keeps
    // that (and the time-stretcher's whole-window output) locked to the video.
    let leveler = null;
    let audioFramesOut = 0;           // frames already handed to the encoder
    let pendingParts = [], pendingFrames = 0;
    const EMIT_BLOCK = 1024;

    const emitAudio = (data, numberOfFrames, timestamp) => {
      if (numberOfFrames <= 0) return;
      const out = new AudioData({ format: 'f32', sampleRate: SR, numberOfFrames, numberOfChannels: CH, timestamp, data });
      audioEncoder.encode(out);
      out.close();
    };

    // Hand the encoder whole blocks on one continuous output timeline. Audio
    // and video both start at output time 0, so they stay in step.
    const flushPending = (all) => {
      while (pendingFrames >= (all ? 1 : EMIT_BLOCK) && pendingFrames > 0) {
        const take = all ? pendingFrames : Math.min(pendingFrames, EMIT_BLOCK);
        const block = new Float32Array(take * CH);
        let filled = 0;
        while (filled < take) {
          const head = pendingParts[0];
          const headFrames = head.length / CH;
          const use = Math.min(headFrames, take - filled);
          block.set(head.subarray(0, use * CH), filled * CH);
          if (use === headFrames) pendingParts.shift();
          else pendingParts[0] = head.subarray(use * CH);
          filled += use;
        }
        pendingFrames -= take;
        emitAudio(block, take, Math.round((audioFramesOut / SR) * 1e6));
        audioFramesOut += take;
      }
    };
    const pushSamples = (interleaved) => {
      if (!interleaved || !interleaved.length) return;
      pendingParts.push(interleaved);
      pendingFrames += interleaved.length / CH;
      flushPending(false);
    };

    // One section at a time: a normal one passes through the gain stage, a
    // sped-up one that keeps its narration goes through WSOLA, and a silent one
    // emits exactly its own length of silence.
    let curSpan = null, curProc = null, curEmitted = 0, curTarget = 0;
    let curDub = null, curDubOrig = null;   // a respoken span, and the recording under it
    const spanTargetFrames = (sp) => Math.round(((sp.end - sp.start) / sp.rate) * SR);

    const spanOut = (interleaved) => {
      if (!interleaved || !interleaved.length || !curSpan) return;
      let frames = interleaved.length / CH;
      if (curEmitted + frames > curTarget) {
        frames = Math.max(0, curTarget - curEmitted);
        interleaved = interleaved.subarray(0, frames * CH);
      }
      if (frames <= 0) return;
      pushSamples(interleaved);
      curEmitted += frames;
    };

    const openSpan = (sp) => {
      curSpan = sp;
      curEmitted = 0;
      curTarget = spanTargetFrames(sp);
      // An overdub replaces this span's narration outright: the generated
      // samples were already fitted to exactly this many frames when the line
      // was respoken, so they go straight out and the decoded source for these
      // seconds is dropped on the floor.
      //
      // It does go through the gain stage, though, exactly like the recording
      // around it. Skipping it — on the theory that the level was already
      // matched at generation time — was wrong: with a boost on, every other
      // second of the file gets lifted and the respoken line doesn't, so it
      // lands conspicuously quiet. Matching at generation time puts it on the
      // right scale; the gain stage then moves it with everything else. (The
      // breath ducking is still skipped: those regions describe the original
      // audio, which is no longer here.)
      // The recording for these seconds is decoded anyway, so it is kept
      // rather than discarded: its edges are what the dub crossfades into, and
      // the line it replaces is the ideal tonal reference — same speaker, same
      // microphone, same words. Both are used in closeSpan(), once the whole
      // span has arrived.
      curDub = sp.dub || null;
      curDubOrig = curDub ? [] : null;
      curProc = null;
      if (curDub) return;
      curProc = (sp.rate !== 1 && sp.audio === 'keep')
        ? createTimeStretcher({ sampleRate: SR, channels: CH, speed: sp.rate })
        : null;
    };

    const closeSpan = () => {
      if (!curSpan) return;
      // A respoken span is assembled here, where the whole of the recording it
      // replaces is finally in hand: the generated line is tone-matched to it,
      // laid over the room, and crossfaded into it at both edges so the
      // background runs straight through the join.
      if (curDub) {
        const orig = concatFloat32(curDubOrig || []);
        const dub = voice.pcmFor(curDub, {
          sampleRate: SR, channels: CH, frames: curTarget, toneReference: orig,
        });
        if (dub) {
          spanOut(gainStage(crossfadeEdges(dub, orig, { channels: CH, sampleRate: SR }), curTarget));
        } else if (orig.length) {
          spanOut(gainStage(orig, curTarget));   // generation missing: keep the recording
        }
        curDub = null;
        curDubOrig = null;
      }
      if (curProc) spanOut(curProc.flush());
      // Silence fills a muted section, and any shortfall elsewhere, so the
      // section lands at exactly the length the video expects.
      if (curEmitted < curTarget) spanOut(new Float32Array((curTarget - curEmitted) * CH));
      curSpan = null;
      curProc = null;
    };

    // Breaths are turned down *before* the leveller rather than after: the
    // leveller holds its gain over anything this far below the voice, so a
    // ducked breath stays ducked instead of being boosted back up — and the
    // regions line up with the source timeline here, before the leveller's
    // lookahead shifts everything by a few ms.
    const breathRegions = wantsBreathWork ? state.breaths : [];
    const duckBreaths = (slice, frames, startSec) => {
      if (!breathRegions.length) return slice;
      const copy = new Float32Array(slice);   // never write into the decoder's buffer
      return duckRegions(copy, CH, SR, startSec, breathRegions, s.breathDb);
    };

    // Boost first, so a sped-up section is boosted like everything else, then
    // speed. Returns interleaved samples ready for the section's processor.
    const gainStage = (slice, frames) => {
      if (!wantsBoost) return slice;
      if (leveler) {
        const mono = new Float32Array(frames);
        for (let i = 0; i < frames; i++) {
          let sum = 0;
          for (let c = 0; c < CH; c++) sum += slice[i * CH + c];
          mono[i] = sum / CH;
        }
        return leveler.process(slice, CH, mono);
      }
      const g = new Float32Array(slice);
      applyGainInPlace(g, dbToLinear(s.audioGainDb));
      return g;
    };

    const feedSpan = (slice, frames, startSec) => {
      if (!curSpan) return;
      // Respoken: the recording is not emitted, but it is kept — closeSpan()
      // crossfades into it and matches the generation's tone to it.
      if (curDub) { curDubOrig.push(slice.slice ? slice.slice() : Float32Array.from(slice)); return; }
      if (curSpan.rate !== 1 && curSpan.audio !== 'keep') return;   // silent: nothing to carry over
      const processed = gainStage(duckBreaths(slice, frames, startSec), frames);
      if (curProc) spanOut(curProc.process(processed));
      else spanOut(processed);
    };

    if (needAudioWork) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => { muxer.addAudioChunk(chunk, meta); audioEmitted++; },
        error: (e) => { encodeErr = encodeErr || e; },
      });
      audioEncoder.configure({
        codec: AAC_CODEC, sampleRate: SR, numberOfChannels: CH, bitrate: audio.bitrate || 160_000,
      });
      leveler = (wantsBoost && s.volumeMode === 'auto') ? createLeveler(SR, { maxGainDb: s.audioGainDb }) : null;

      const onAudioDecoded = (frame) => {
        try {
          if (cancelRequested) return;
          const n = frame.numberOfFrames, ch = frame.numberOfChannels;
          const rate = frame.sampleRate;
          const interleaved = new Float32Array(n * ch);
          const plane = new Float32Array(n);
          for (let c = 0; c < ch; c++) {
            frame.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            for (let i = 0; i < n; i++) interleaved[i * ch + c] = plane[i];
          }

          // A decoded frame can straddle section boundaries, so walk it in
          // pieces: each piece belongs to exactly one section.
          let i = 0;
          while (i < n) {
            const tUS = frame.timestamp + (i / rate) * 1e6;
            const sp = spanAtUS(tUS);
            if (!sp) {
              // Trimmed away or inside a removed section: jump to the next
              // section that starts after this point, if there is one.
              const next = spansUS.find((x) => x.startUS > tUS);
              if (!next) break;
              i += Math.max(1, Math.ceil(((next.startUS - tUS) / 1e6) * rate));
              continue;
            }
            if (sp !== curSpan) { closeSpan(); openSpan(sp); }
            const room = Math.max(1, Math.ceil(((sp.endUS - tUS) / 1e6) * rate));
            const end = Math.min(n, i + room);
            feedSpan(interleaved.subarray(i * ch, end * ch), end - i, tUS / 1e6);
            i = end;
          }
        } finally {
          frame.close();
        }
      };
      audioDecoder = new AudioDecoder({ output: onAudioDecoded, error: (e) => { encodeErr = encodeErr || e; } });
      audioDecoder.configure({
        codec: audio.codec, sampleRate: SR, numberOfChannels: CH, description: asc,
      });
    }

    // ---- Decode → (trim window) → scale → encode ----
    const gop = Math.max(1, Math.round(s.outFps * 2));
    const needScale = s.outW !== video.track_width || s.outH !== video.track_height;
    // Burned-in captions are drawn onto the canvas, so they route every frame
    // through it even at the original size.
    const capCues = captions.exportCues();
    const capStyle = captions.style();
    const needCanvas = needScale || capCues.length > 0;
    const canvas = new OffscreenCanvas(s.outW, s.outH);
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    // Live "playing while encoding" view (downscaled for cheap drawing).
    els.previewBlock.style.display = 'none';
    els.encodeView.hidden = false;
    // Intrinsic canvas dims carry the true aspect ratio; CSS (max-width/height +
    // auto width/height) scales it down to fit while preserving that ratio.
    const ecW = Math.min(s.outW, 960);
    const ecH = Math.max(1, Math.round(ecW * s.outH / s.outW));
    els.encodeCanvas.width = ecW;
    els.encodeCanvas.height = ecH;
    const ecx = els.encodeCanvas.getContext('2d', { alpha: false });

    const frameInterval = 1e6 / s.outFps;
    const estFrames = Math.max(1, Math.round(s.outFps * s.trimDur));

    // Frames are spaced out in *output* time, so a 4× section naturally keeps
    // only every fourth frame instead of arriving at four times the frame rate.
    let nextEmit = 0, emitted = 0, reachedOut = false;

    const onDecoded = (frame) => {
      try {
        if (cancelRequested) return;
        const t = frame.timestamp;
        if (t >= outMicros) { reachedOut = true; return; }          // past selection
        if (t + 1 < inMicros) return;                               // before selection (decoded for refs)
        const sp = spanAtUS(t);
        if (!sp) return;                                            // inside a removed section
        const outTs = Math.round(toOutputUS(t, sp));                // compact past trim, cuts and speed
        if (outTs + 1 < nextEmit) return;                           // frame-rate reduction
        nextEmit = outTs + frameInterval;
        const frameDur = Math.max(1, Math.round((frame.duration || frameInterval) / sp.rate));
        let out;
        if (needCanvas) {
          ctx.drawImage(frame, 0, 0, s.outW, s.outH);
          const cue = capCues.length ? cueAt(capCues, outTs / 1e6) : null;
          if (cue) drawCaption(ctx, cue.text, 0, 0, s.outW, s.outH, capStyle);
          out = new VideoFrame(canvas, { timestamp: outTs, duration: frameDur });
        } else {
          out = new VideoFrame(frame, { timestamp: outTs, duration: frameDur });
        }
        encoder.encode(out, { keyFrame: emitted % gop === 0 });
        // Draw the frame we just encoded so the user watches it play out.
        try { ecx.drawImage(needCanvas ? canvas : out, 0, 0, ecW, ecH); } catch (_) {}
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
    const aq = [];                 // queued encoded audio samples (only used when re-encoding)
    const audioOut = [];           // AAC samples inside the trim window (passthrough)

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
        if (needAudioWork) {
          // Decode every sample (like video does) — the boost/limiter and
          // range filtering happen once it comes back out of the decoder.
          for (const smp of smps) aq.push({
            data: smp.data.slice(0),
            cts: smp.cts, duration: smp.duration, timescale: smp.timescale, is_sync: smp.is_sync,
          });
        } else {
          for (const smp of smps) {
            const cts = (smp.cts / smp.timescale) * 1e6;
            const sp = spanAtUS(cts);                                 // null = trimmed or cut away
            if (!dropAudio && sp) {
              audioOut.push({
                data: smp.data.slice(0),                              // copy before release
                ts: Math.round(toOutputUS(cts, sp)),                  // compact past trim + cuts
                dur: Math.round((smp.duration / smp.timescale) * 1e6),
              });
            }
          }
        }
      }
      mp4.releaseUsedSamples(id, smps[smps.length - 1].number);
    };
    mp4.setExtractionOptions(video.id, 'video', { nbSamples: 30 });
    if (s.keepAudio && audio) mp4.setExtractionOptions(audio.id, 'audio', { nbSamples: 200 });
    mp4.start();

    const feed = async () => {
      while ((vq.length && !reachedOut) || aq.length) {
        if (!cancelRequested && vq.length && !reachedOut) {
          const smp = vq.shift();
          decoder.decode(new EncodedVideoChunk({
            type: smp.is_sync ? 'key' : 'delta',
            timestamp: Math.round((smp.cts / smp.timescale) * 1e6),
            duration: Math.round((smp.duration / smp.timescale) * 1e6),
            data: smp.data,
          }));
        }
        if (!cancelRequested && needAudioWork && aq.length) {
          const smp = aq.shift();
          audioDecoder.decode(new EncodedAudioChunk({
            type: smp.is_sync ? 'key' : 'delta',
            timestamp: Math.round((smp.cts / smp.timescale) * 1e6),
            duration: Math.round((smp.duration / smp.timescale) * 1e6),
            data: smp.data,
          }));
        }
        if (cancelRequested) break;
        while ((
          encoder.encodeQueueSize > 8 || decoder.decodeQueueSize > 8 ||
          (needAudioWork && (audioEncoder.encodeQueueSize > 8 || audioDecoder.decodeQueueSize > 8))
        ) && !cancelRequested) {
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
    if (needAudioWork) {
      await audioDecoder.flush();
      // Drain the few ms still sitting in the leveler's lookahead buffer,
      // through the section it belongs to, then close that section so it lands
      // at exactly its own length.
      if (leveler && curSpan) {
        const tail = leveler.flush();
        if (tail.length) {
          if (curProc) spanOut(curProc.process(tail));
          else spanOut(tail);
        }
      }
      closeSpan();
      flushPending(true);
      await audioEncoder.flush();
    }
    if (encodeErr) throw encodeErr;
    try { mp4.stop(); } catch (_) {}

    // ---- Audio: passthrough (trim-windowed), or boosted (already streamed
    // through the encoder above) ----
    let audioNote = '';
    if (s.keepAudio && audio) {
      const speedNote = hasSpeed ? ' · sped-up sections re-timed' : '';
      const breathNote = wantsBreathWork && !dropAudio ? ` · ${state.breaths.length} breaths turned down` : '';
      if (dropAudio) {
        audioNote = " (audio dropped — this browser can't re-encode AAC, which a speed change needs)";
      } else if (needAudioWork) {
        audioNote = audioEmitted > 0
          ? (wantsBoost
              ? `${leveler ? ` · boosted up to +${s.audioGainDb.toFixed(1)} dB (auto)` : ` · boosted +${s.audioGainDb.toFixed(1)} dB`}${speedNote}${breathNote}`
              : `${speedNote}${breathNote}`)
          : ' (no audio in the selected range)';
      } else if (audioOut.length) {
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
    showResult(blob, s, audioNote + (capCues.length ? ' · captions burned in' : ''));
    setProgress(1);
    setStatus('');
  } catch (err) {
    if (cancelRequested || (err && err.message === 'cancelled')) setStatus('Cancelled.');
    else { console.error(err); setStatus(`Error: ${err.message || err}`); }
    setProgress(null);
  } finally {
    try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch (_) {}
    try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch (_) {}
    try { if (audioDecoder && audioDecoder.state !== 'closed') audioDecoder.close(); } catch (_) {}
    try { if (audioEncoder && audioEncoder.state !== 'closed') audioEncoder.close(); } catch (_) {}
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

  [els.inSize, els.inBitrate, els.inScale, els.inFps, els.inCodec, els.inAudio, els.inGain,
    els.inCapModel, els.inCapLang, els.inCapSize, els.inCapPos, els.inCapLook, els.inCapBurn]
    .forEach((el) => { el.addEventListener('input', updateEstimate); el.addEventListener('change', updateEstimate); });
  // Changing how breaths are handled can add or drop timeline edits, so it does
  // more than the generic "something changed" refresh.
  [els.inBreathMode, els.inBreathDb].forEach((el) => el.addEventListener('change', () => {
    syncBreathEdits();
    updateBreathUI();
    updatePreviewGain();
    updateEstimate();
    refreshBreaths();
  }));
  document.querySelectorAll('input[name="volume"]').forEach((r) => r.addEventListener('change', updateEstimate));

  // The timeline is laid out in pixels, so it has to be repainted whenever its
  // width changes — on every step, not just Trim, and not only on a window
  // resize: a scrollbar appearing, the cue list growing, or the preview moving
  // between steps all change it while the window stays put. A ResizeObserver
  // catches the lot; the size guard stops the pixel widths we write inside the
  // track from feeding back into another notification.
  const repaintTimeline = () => {
    if (state && currentStep !== 'source') { renderTrim(); renderPlayhead(); }
    captions.renderOverlay();
  };
  window.addEventListener('resize', repaintTimeline);
  if (typeof ResizeObserver !== 'undefined') {
    let lastSize = '';
    const ro = new ResizeObserver(() => {
      const size = `${els.tlTrack.clientWidth}x${els.previewBlock.clientWidth}x${els.previewBlock.clientHeight}`;
      if (size === lastSize) return;
      lastSize = size;
      requestAnimationFrame(repaintTimeline);
    });
    ro.observe(els.tlTrack);
    ro.observe(els.previewBlock);   // the caption overlay follows the video's box
  }

  captions.wire();
  voice.wire();

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
  // Wire everything up straight away — a video dropped in the first moments
  // must not be missed — then refresh the caption models (their default and
  // download sizes depend on the GPU) once the WebGPU probe answers.
  captions.populateModels();
  initUI();
  captions.detectDevice().then(captions.populateModels);
  showStep('source');
  const saved = readSettings();
  if (saved && saved.file && saved.file.name) {
    els.info.textContent = `Last session: “${saved.file.name}”. Load it again to restore your trim, cuts & settings — or load any video to reuse your settings.`;
  }
})();
