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
import { createCaptions } from './captions-ui.js';

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
  if (previewGainNode) previewGainNode.gain.value = dbToLinear(db);
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
  if (state && name !== 'source') { renderTrim(); renderPlayhead(); captions.renderOverlay(); }
  if (state && name === 'settings') captions.renderList();
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
const captions = createCaptions({
  els,
  getState: () => state,
  timeline: { keptSegments, toOutputTime, fromOutputTime, seek },
  audio: {
    decodeAudioTrack, mixToMono, concatFloat32,
    // Captions transcribe the boosted signal, so they need what Volume is set to.
    gain: () => ({ mode: currentVolumeMode(), db: currentAudioGainDb() }),
  },
  fmt: { fmtTime, fmtBytes },
  setProgress,
  onChanged: () => { if (currentStep === 'export') updateExportSummary(); },
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
      ...captions.settings(),
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
  if (g.gain != null) els.inGain.value = g.gain;
  captions.applySettings(g);
  const modeRadio = document.querySelector(`input[name="mode"][value="${g.mode}"]`);
  if (modeRadio) { modeRadio.checked = true; els.fieldSize.hidden = g.mode !== 'size'; els.fieldBitrate.hidden = g.mode !== 'bitrate'; }
  if (g.volume) {
    const volRadio = document.querySelector(`input[name="volume"][value="${g.volume}"]`);
    if (volRadio && !volRadio.disabled) volRadio.checked = true;
  }
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
    inS: 0, outS: durationS, cuts: [], pendingCutStart: null,
    audioAnalysis: null, audioEncoderSupported: false,
    isAac: false, captions: captions.restore(file),
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
function fromOutputTime(o, segs = keptSegments()) {
  let acc = 0;
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

function renderPlayButton() {
  // The preview block (transport included) is relocated between steps, so
  // look inside the block itself rather than wherever it happens to be hosted.
  const btn = els.previewBlock.querySelector('.transport [data-act="play"]');
  if (!btn) return;
  const playing = !els.preview.paused && !els.preview.ended;
  btn.classList.toggle('playing', playing);
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
      for (const c of activeCuts()) {
        if (v.currentTime >= c.start && v.currentTime < c.end - 1e-3) { seek(c.end); break; }
      }
    }
    renderPlayhead();
    captions.renderOverlay();
  };
  v.onseeked = () => {
    renderPlayhead();
    captions.renderOverlay();
    if (pendingSeek != null) { const t = pendingSeek; pendingSeek = null; v.currentTime = t; }
  };
  v.onloadedmetadata = () => { renderTrim(); renderPlayhead(); captions.renderOverlay(); };
  // Drive the play/pause icon off the video itself, so it stays honest however
  // playback started or stopped — the button, the Space bar, or the clip
  // reaching its end.
  v.onplay = () => { renderPlayButton(); captions.overlayLoop(); };
  v.onpause = renderPlayButton;
  v.onended = renderPlayButton;
  renderPlayButton();

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
    if (e.key === ' ') {
      e.preventDefault();
      if (v.paused) { ensureAudioGraph(); if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume(); updatePreviewGain(); v.play(); }
      else v.pause();
    }
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
  const volumeMode = currentVolumeMode();
  const audioGainDb = currentAudioGainDb();
  return { mode, scale, outW, outH, outFps, codec, keepAudio, trimDur, volumeMode, audioGainDb };
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
  updatePreviewGain();
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
  if (!ok) return { voiceDbfs: 0, activeFraction: 0, autoGainDb: 0 };
  const mono = concatFloat32(chunks);
  if (!mono.length) return { voiceDbfs: -90, activeFraction: 0, autoGainDb: 0 };
  return analyzeVoiceLevel(mono, st.audio.audio.sample_rate);
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

    // ---- Audio: boost needs a decode → gain → re-encode round trip;
    // everything else about the audio track (unchanged, or dropped) doesn't. ----
    const needAudioBoost = s.keepAudio && !!audio && s.audioGainDb > 0.05 && state.audioEncoderSupported;
    const asc = (s.keepAudio && audio) ? await aacDescription(file, mp4, audio.id).catch(() => null) : null;
    let audioEmitted = 0;
    // "Auto" runs a lookahead leveler (audio-boost.js) that rides the gain up
    // during quiet voice and automatically ducks on anything loud (a jingle,
    // a shout) — it introduces a few ms of internal audio delay, so its
    // output length doesn't line up 1:1 with each input frame;
    // audioOutFrames/audioOutStartUS track a running output timeline instead
    // of using each frame's own timestamp. "Manual" is a flat, user-chosen
    // gain with no ducking — output matches input 1:1. Declared out here (not
    // inside the `if` below) so the post-loop flush can still reach them.
    let leveler = null, audioOutFrames = 0, audioOutStartUS = null;
    const emitAudio = (data, numberOfFrames, ch, sampleRate, timestamp) => {
      if (numberOfFrames <= 0) return;
      const out = new AudioData({ format: 'f32', sampleRate, numberOfFrames, numberOfChannels: ch, timestamp, data });
      audioEncoder.encode(out);
      out.close();
    };

    if (needAudioBoost) {
      audioEncoder = new AudioEncoder({
        output: (chunk, meta) => { muxer.addAudioChunk(chunk, meta); audioEmitted++; },
        error: (e) => { encodeErr = encodeErr || e; },
      });
      audioEncoder.configure({
        codec: AAC_CODEC, sampleRate: audio.audio.sample_rate,
        numberOfChannels: audio.audio.channel_count, bitrate: audio.bitrate || 160_000,
      });

      leveler = s.volumeMode === 'auto' ? createLeveler(audio.audio.sample_rate, { maxGainDb: s.audioGainDb }) : null;
      const gainLinear = leveler ? null : dbToLinear(s.audioGainDb);

      const onAudioDecoded = (frame) => {
        try {
          if (cancelRequested) return;
          const t = frame.timestamp;
          if (t + 1 < inMicros || t >= outMicros || inCutUS(t)) return;   // outside the kept range
          const n = frame.numberOfFrames, ch = frame.numberOfChannels;
          const interleaved = new Float32Array(n * ch);
          const plane = new Float32Array(n);
          for (let c = 0; c < ch; c++) {
            frame.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
            if (!leveler) applyGainInPlace(plane, gainLinear);
            for (let i = 0; i < n; i++) interleaved[i * ch + c] = plane[i];
          }

          if (leveler) {
            if (audioOutStartUS === null) audioOutStartUS = toOutputUS(t);
            const mono = new Float32Array(n);
            for (let i = 0; i < n; i++) {
              let sum = 0;
              for (let c = 0; c < ch; c++) sum += interleaved[i * ch + c];
              mono[i] = sum / ch;
            }
            const leveled = leveler.process(interleaved, ch, mono);
            const framesOut = leveled.length / ch;
            emitAudio(leveled, framesOut, ch, frame.sampleRate, audioOutStartUS + Math.round((audioOutFrames / frame.sampleRate) * 1e6));
            audioOutFrames += framesOut;
          } else {
            emitAudio(interleaved, n, ch, frame.sampleRate, toOutputUS(t));
          }
        } finally {
          frame.close();
        }
      };
      audioDecoder = new AudioDecoder({ output: onAudioDecoded, error: (e) => { encodeErr = encodeErr || e; } });
      audioDecoder.configure({
        codec: audio.codec, sampleRate: audio.audio.sample_rate,
        numberOfChannels: audio.audio.channel_count, description: asc,
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
        if (needCanvas) {
          ctx.drawImage(frame, 0, 0, s.outW, s.outH);
          const cue = capCues.length ? cueAt(capCues, outTs / 1e6) : null;
          if (cue) drawCaption(ctx, cue.text, 0, 0, s.outW, s.outH, capStyle);
          out = new VideoFrame(canvas, { timestamp: outTs, duration: frame.duration || Math.round(frameInterval) });
        } else {
          out = new VideoFrame(frame, { timestamp: outTs, duration: frame.duration || Math.round(frameInterval) });
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
        if (needAudioBoost) {
          // Decode every sample (like video does) — the boost/limiter and
          // range filtering happen once it comes back out of the decoder.
          for (const smp of smps) aq.push({
            data: smp.data.slice(0),
            cts: smp.cts, duration: smp.duration, timescale: smp.timescale, is_sync: smp.is_sync,
          });
        } else {
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
        if (!cancelRequested && needAudioBoost && aq.length) {
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
          (needAudioBoost && (audioEncoder.encodeQueueSize > 8 || audioDecoder.decodeQueueSize > 8))
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
    if (needAudioBoost) {
      await audioDecoder.flush();
      if (leveler) {
        // Drain the few ms of audio still sitting in the leveler's lookahead
        // buffer — otherwise the very tail of the track goes missing.
        const tail = leveler.flush();
        const ch = audio.audio.channel_count;
        const framesOut = tail.length / ch;
        if (framesOut > 0 && audioOutStartUS !== null) {
          emitAudio(tail, framesOut, ch, audio.audio.sample_rate, audioOutStartUS + Math.round((audioOutFrames / audio.audio.sample_rate) * 1e6));
          audioOutFrames += framesOut;
        }
      }
      await audioEncoder.flush();
    }
    if (encodeErr) throw encodeErr;
    try { mp4.stop(); } catch (_) {}

    // ---- Audio: passthrough (trim-windowed), or boosted (already streamed
    // through the encoder above) ----
    let audioNote = '';
    if (s.keepAudio && audio) {
      if (needAudioBoost) {
        audioNote = audioEmitted > 0
          ? (leveler ? ` · boosted up to +${s.audioGainDb.toFixed(1)} dB (auto)` : ` · boosted +${s.audioGainDb.toFixed(1)} dB`)
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
