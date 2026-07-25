// Video Compressor — hardware-accelerated, in the browser.
//
// Pipeline:  MP4Box.js (demux)  ->  VideoDecoder (HW)  ->  scale on a canvas
//            ->  VideoEncoder (HW)  ->  mp4-muxer (mux)  ->  Blob.
//
// AAC audio is copied through untouched: the original encoded audio samples are
// handed straight to the muxer (addAudioChunkRaw), so audio is never
// re-encoded. Everything runs locally; no file ever leaves the machine.
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
  paneSource: $('pane-source'), paneSettings: $('pane-settings'), paneResult: $('pane-result'),
  drop: $('drop-video'), file: $('file-video'), info: $('video-info'),
  fieldSize: $('field-size'), fieldBitrate: $('field-bitrate'),
  inSize: $('in-size'), inBitrate: $('in-bitrate'),
  inScale: $('in-scale'), inFps: $('in-fps'), inCodec: $('in-codec'), inAudio: $('in-audio'),
  hintSize: $('hint-size'), hintBitrate: $('hint-bitrate'), hintScale: $('hint-scale'),
  hintFps: $('hint-fps'), hintCodec: $('hint-codec'), hintAudio: $('hint-audio'),
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
let state = null;   // { file, buffer, mp4, video, audio, durationS, fps }
let running = false;
let cancelRequested = false;
let lastUrl = null; // object URL for the produced blob (revoked on re-run)

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const fmtBytes = (n) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};
const fmtDuration = (s) => {
  const m = Math.floor(s / 60), sec = (s % 60);
  return `${m}:${sec.toFixed(1).padStart(4, '0')}`;
};
const even = (n) => Math.max(2, Math.round(n / 2) * 2);
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function setStatus(msg) { els.status.textContent = msg || ''; }
function setProgress(frac) {
  if (frac == null) { els.progress.style.display = 'none'; return; }
  els.progress.style.display = 'block';
  els.progress.firstElementChild.style.width = `${clamp(frac, 0, 1) * 100}%`;
}

// Read a box's raw payload (after its header) straight out of the file buffer.
// MP4Box exposes each parsed box's byte range via .start / .size / .hdr_size.
function boxPayload(fileBytes, box) {
  return fileBytes.slice(box.start + box.hdr_size, box.start + box.size);
}

// Extract the codec configuration record (avcC / hvcC) for a VideoDecoder's
// `description`. Without it, avc1/hvc1 samples (length-prefixed NAL units)
// cannot be decoded.
function videoDescription(mp4, fileBytes, trackId) {
  const trak = mp4.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    const box = entry.avcC || entry.hvcC || entry.vpcC || entry.av1C;
    if (box) return boxPayload(fileBytes, box);
  }
  return null;
}

// Walk the esds descriptor tree to the DecoderSpecificInfo (AudioSpecificConfig)
// AAC needs. MP4Box's hdr_size already consumes the FullBox version+flags, so
// the payload begins at the ES_Descriptor (tag 0x03).
function aacDescription(mp4, fileBytes, trackId) {
  const trak = mp4.getTrackById(trackId);
  for (const entry of trak.mdia.minf.stbl.stsd.entries) {
    if (!entry.esds) continue;
    const v = boxPayload(fileBytes, entry.esds);
    const o = { p: 0 };
    const readLen = () => { let b, n = 0; do { b = v[o.p++]; n = (n << 7) | (b & 0x7f); } while (b & 0x80); return n; };
    if (v[o.p++] !== 0x03) return null; readLen(); o.p += 3;   // ES_Descriptor: ES_ID(2)+flags(1)
    if (v[o.p++] !== 0x04) return null; readLen(); o.p += 13;  // DecoderConfigDescriptor body
    if (v[o.p++] !== 0x05) return null;                        // DecoderSpecificInfo
    const len = readLen();
    return v.slice(o.p, o.p + len);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Load & parse a source file
// ---------------------------------------------------------------------------
async function loadFile(file) {
  resetResult();
  els.paneSettings.hidden = true;
  els.info.textContent = 'Reading file…';

  const buffer = await file.arrayBuffer();
  const fileBytes = new Uint8Array(buffer);

  const mp4 = MP4Box.createFile();
  const info = await new Promise((resolve, reject) => {
    mp4.onError = (e) => reject(new Error(typeof e === 'string' ? e : 'Could not parse this file.'));
    mp4.onReady = resolve;
    const ab = buffer.slice(0);          // MP4Box mutates .fileStart on the buffer it gets
    ab.fileStart = 0;
    mp4.appendBuffer(ab);
    mp4.flush();
  });

  const video = info.videoTracks && info.videoTracks[0];
  if (!video) throw new Error('No video track found in this file.');
  const audio = info.audioTracks && info.audioTracks[0];

  const durationS = info.duration / info.timescale;
  const fps = video.nb_samples / (video.duration / video.timescale);

  state = { file, buffer, fileBytes, mp4, video, audio, durationS, fps };

  // Info line
  const parts = [
    `${video.track_width}×${video.track_height}`,
    `${fps.toFixed(1)} fps`,
    fmtDuration(durationS),
    fmtBytes(file.size),
    (video.codec || '').split('.')[0].toUpperCase(),
  ];
  if (audio) parts.push(`audio: ${audio.codec}`); else parts.push('no audio');
  els.info.textContent = parts.join('  ·  ');

  // Audio checkbox availability
  const isAac = audio && /mp4a/.test(audio.codec);
  els.inAudio.disabled = !isAac;
  els.inAudio.checked = !!isAac;
  els.hintAudio.textContent = !audio ? 'This file has no audio track.'
    : isAac ? `${audio.audio.channel_count}ch · ${audio.audio.sample_rate} Hz — copied unchanged.`
    : `Audio is ${audio.codec} (not AAC) and will be dropped.`;

  els.paneSettings.hidden = false;
  updateEstimate();
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
  const codec = els.inCodec.value;                 // 'avc' | 'hevc'
  const keepAudio = els.inAudio.checked && !els.inAudio.disabled;
  return { mode, scale, outW, outH, outFps, codec, keepAudio };
}

// Total bytes of the AAC audio track (unchanged on passthrough).
function audioBytes() {
  if (!state.audio) return 0;
  // nb_samples * average sample size isn't exposed directly; estimate from bitrate
  // when available, else 0 (updated precisely during extraction).
  const br = state.audio.bitrate || 0;
  return br ? Math.round(br / 8 * state.durationS) : Math.round(128000 / 8 * state.durationS);
}

function targetVideoBitrate(s) {
  if (s.mode === 'bitrate') return Math.round(parseFloat(els.inBitrate.value) * 1e6);
  const targetBytes = parseFloat(els.inSize.value) * 1024 * 1024 * 0.97;   // 3% muxing/headroom
  const audio = s.keepAudio ? audioBytes() : 0;
  const videoBits = Math.max(0, targetBytes - audio) * 8;
  return Math.max(100_000, Math.round(videoBits / state.durationS));
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
    els.hintSize.textContent = `≈ ${(vBitrate / 1e6).toFixed(2)} Mbps video${s.keepAudio ? ' + audio' : ''}`;
  } else {
    const est = (vBitrate / 8 * state.durationS) + (s.keepAudio ? audioBytes() : 0);
    els.hintBitrate.textContent = `≈ ${fmtBytes(est)} output`;
  }
  els.est.textContent = '';
}

// ---------------------------------------------------------------------------
// Encoder config probing — pick the first supported codec string.
// ---------------------------------------------------------------------------
async function pickEncoderConfig(codec, width, height, bitrate, framerate) {
  const candidates = codec === 'hevc'
    ? ['hvc1.1.6.L123.B0', 'hev1.1.6.L123.B0', 'hvc1.1.6.L93.B0']
    : ['avc1.640028', 'avc1.4d0028', 'avc1.42001f'];
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
      } catch (_) { /* try next */ }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Main transcode
// ---------------------------------------------------------------------------
async function compress() {
  if (running) return;
  const s = currentSettings();
  const { video, audio, fileBytes, mp4, durationS } = state;

  running = true; cancelRequested = false;
  resetResult();
  els.btnCompress.disabled = true;
  els.btnCancel.hidden = false;
  setProgress(0);
  setStatus('Preparing…');

  let decoder, encoder, muxer;
  try {
    const vBitrate = targetVideoBitrate(s);

    // ---- Verify the source is decodable ----
    const description = videoDescription(mp4, fileBytes, video.id);
    const decCfg = {
      codec: video.codec,
      codedWidth: video.track_width,
      codedHeight: video.track_height,
      description,
    };
    const decSupport = await VideoDecoder.isConfigSupported(decCfg).catch(() => ({ supported: false }));
    if (!decSupport.supported) {
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
    encoder = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (e) => { throw e; },
    });
    encoder.configure(encCfg);

    // ---- Decode → scale → encode ----
    const totalFrames = Math.max(1, Math.round(Math.min(video.nb_samples, s.outFps * durationS)));
    const gop = Math.max(1, Math.round(s.outFps * 2));    // keyframe every ~2s
    const needScale = s.outW !== video.track_width || s.outH !== video.track_height;
    const canvas = new OffscreenCanvas(s.outW, s.outH);
    const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

    const frameInterval = 1e6 / s.outFps;   // microseconds between kept frames
    let nextEmit = 0, emitted = 0;

    const onDecoded = (frame) => {
      if (cancelRequested) { frame.close(); return; }
      // Frame-rate reduction by presentation time (VideoDecoder emits in order).
      if (s.outFps < state.fps - 0.01 && frame.timestamp + 1 < nextEmit) {
        frame.close();
        return;
      }
      nextEmit = frame.timestamp + frameInterval;

      let out = frame;
      if (needScale) {
        ctx.drawImage(frame, 0, 0, s.outW, s.outH);
        out = new VideoFrame(canvas, {
          timestamp: frame.timestamp,
          duration: frame.duration || Math.round(frameInterval),
        });
        frame.close();
      }
      encoder.encode(out, { keyFrame: emitted % gop === 0 });
      out.close();
      emitted++;
      if (emitted % 5 === 0) {
        setProgress(0.05 + 0.9 * Math.min(1, emitted / totalFrames));
        setStatus(`Encoding… ${emitted} / ~${totalFrames} frames`);
      }
    };

    decoder = new VideoDecoder({ output: onDecoded, error: (e) => { throw e; } });
    decoder.configure(decCfg);

    // Demux both tracks up front, then feed the decoder with backpressure.
    setStatus('Reading frames…');
    const wantAudio = s.keepAudio && audio ? audio.id : null;
    const demuxed = await demux(state.buffer, video.id, wantAudio);
    const samples = demuxed.video;
    if (cancelRequested) throw new Error('cancelled');

    for (let i = 0; i < samples.length; i++) {
      const smp = samples[i];
      decoder.decode(new EncodedVideoChunk({
        type: smp.is_sync ? 'key' : 'delta',
        timestamp: Math.round((smp.cts / smp.timescale) * 1e6),
        duration: Math.round((smp.duration / smp.timescale) * 1e6),
        data: smp.data,
      }));
      // Throttle so decoded frames don't pile up in memory.
      while ((encoder.encodeQueueSize > 8 || decoder.decodeQueueSize > 8) && !cancelRequested) {
        await new Promise((r) => setTimeout(r, 4));
      }
      if (cancelRequested) throw new Error('cancelled');
    }

    await decoder.flush();
    await encoder.flush();
    if (cancelRequested) throw new Error('cancelled');

    // ---- Audio passthrough ----
    let audioNote = '';
    if (s.keepAudio && audio) {
      setStatus('Copying audio…');
      try {
        const asc = aacDescription(mp4, fileBytes, audio.id);
        const aSamples = demuxed.audio;
        let first = true;
        for (const smp of aSamples) {
          const meta = first && asc ? { decoderConfig: { description: asc } } : undefined;
          muxer.addAudioChunkRaw(
            smp.data, 'key',
            Math.round((smp.cts / smp.timescale) * 1e6),
            Math.round((smp.duration / smp.timescale) * 1e6),
            meta,
          );
          first = false;
        }
      } catch (err) {
        audioNote = ' (audio could not be copied and was dropped)';
        console.warn('Audio passthrough failed:', err);
      }
    } else if (audio && !s.keepAudio) {
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
    if (cancelRequested || (err && err.message === 'cancelled')) {
      setStatus('Cancelled.');
    } else {
      console.error(err);
      setStatus(`Error: ${err.message || err}`);
    }
    setProgress(null);
  } finally {
    try { if (decoder && decoder.state !== 'closed') decoder.close(); } catch (_) {}
    try { if (encoder && encoder.state !== 'closed') encoder.close(); } catch (_) {}
    running = false;
    els.btnCompress.disabled = false;
    els.btnCancel.hidden = true;
  }
}

// Demux both tracks in a single pass. Extraction options must be set in
// onReady (before samples flow) so onSamples fires during the same flush().
// A fresh MP4Box instance is used so this works regardless of what the
// info-parsing instance already consumed.
function demux(buffer, videoId, audioId) {
  return new Promise((resolve, reject) => {
    const mp4 = MP4Box.createFile();
    const res = { video: [], audio: [] };
    mp4.onError = (e) => reject(new Error(typeof e === 'string' ? e : 'demux failed'));
    mp4.onReady = () => {
      mp4.setExtractionOptions(videoId, 'video', { nbSamples: Number.POSITIVE_INFINITY });
      if (audioId != null) mp4.setExtractionOptions(audioId, 'audio', { nbSamples: Number.POSITIVE_INFINITY });
      mp4.start();
    };
    mp4.onSamples = (_id, user, smps) => {
      const arr = user === 'video' ? res.video : res.audio;
      for (const s of smps) arr.push(s);
    };
    const ab = buffer.slice(0);
    ab.fileStart = 0;
    mp4.appendBuffer(ab);
    mp4.flush();                       // fully-appended buffer → samples delivered synchronously
    setTimeout(() => resolve(res), 0); // yield once in case delivery is deferred
  });
}

// ---------------------------------------------------------------------------
// Result
// ---------------------------------------------------------------------------
function showResult(blob, s, audioNote) {
  resetResult();
  lastUrl = URL.createObjectURL(blob);
  els.resultVideo.src = lastUrl;
  els.download.href = lastUrl;
  const base = state.file.name.replace(/\.[^.]+$/, '');
  els.download.download = `${base}_compressed.mp4`;

  const ratio = state.file.size / blob.size;
  els.resultMeta.innerHTML = [
    `<strong>${fmtBytes(blob.size)}</strong> · ${s.outW}×${s.outH} · ${s.outFps.toFixed(0)} fps · ${s.codec === 'hevc' ? 'H.265' : 'H.264'}${audioNote}`,
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
  // Drag & drop + file picker
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

  // Mode toggle
  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
    const mode = document.querySelector('input[name="mode"]:checked').value;
    els.fieldSize.hidden = mode !== 'size';
    els.fieldBitrate.hidden = mode !== 'bitrate';
    updateEstimate();
  }));

  // Any setting change updates the estimate
  [els.inSize, els.inBitrate, els.inScale, els.inFps, els.inCodec, els.inAudio]
    .forEach((el) => { el.addEventListener('input', updateEstimate); el.addEventListener('change', updateEstimate); });

  els.btnCompress.addEventListener('click', compress);
  els.btnCancel.addEventListener('click', () => { cancelRequested = true; setStatus('Cancelling…'); });
}

async function handleFile(f) {
  try {
    setStatus('');
    await loadFile(f);
  } catch (err) {
    console.error(err);
    els.info.textContent = `Could not load this file: ${err.message || err}`;
    els.paneSettings.hidden = true;
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
})();
