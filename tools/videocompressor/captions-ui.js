// Auto-captions, the interactive half: model choice, the transcription job,
// the editable cue list, the preview overlay, and persistence.
//
// captions.js holds the pure logic (voice activity, compaction, windowing,
// cues, drawing); captions-worker.js runs Whisper off the main thread; this
// module joins them to the page. compressor.js owns video and hands this
// module everything it needs through `ctx`, so captions can be reasoned
// about — and moved — without wading through the transcode pipeline.
//
// Cues are stored in *source* time, so trimming or cutting after generating
// them simply hides the ones that land in removed sections.
import {
  ASR_SAMPLE_RATE, createResampler, detectSpeech, compactSpeech, mapCompactSpan,
  planChunks, mergeChunkWords, wordsToCues, cueAt, drawCaption,
} from './captions.js';

// The `_timestamped` exports carry the cross-attention outputs word-level
// timestamps need. Sizes (MB) are what the chosen dtypes download.
const ASR_MODELS = {
  turbo: {
    label: 'Whisper large-v3-turbo — most accurate', id: 'onnx-community/whisper-large-v3-turbo_timestamped',
    webgpu: { dtype: { encoder_model: 'fp16', decoder_model_merged: 'q4' }, mb: 1610 },
    webgpuNoF16: { dtype: { encoder_model: 'q4', decoder_model_merged: 'q4' }, mb: 760 },
    wasm: { dtype: 'q8', mb: 1090 },
  },
  small: {
    label: 'Whisper small — balanced', id: 'onnx-community/whisper-small_timestamped',
    webgpu: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, mb: 590 },
    wasm: { dtype: 'q8', mb: 250 },
  },
  base: {
    label: 'Whisper base — fastest', id: 'onnx-community/whisper-base_timestamped',
    webgpu: { dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, mb: 210 },
    wasm: { dtype: 'q8', mb: 80 },
  },
};
const LS_CAP_KEY = 'videocompressor:captions:v1';

const fmtMB = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${mb} MB`);
function langName(code) {
  try { return new Intl.DisplayNames(['en'], { type: 'language' }).of(code) || code; } catch (_) { return code; }
}

// ctx: { els, getState, timeline: { keptSegments, toOutputTime, fromOutputTime, seek },
//        audio: { decodeAudioTrack, mixToMono, concatFloat32 },
//        fmt: { fmtTime, fmtBytes }, setProgress, onChanged }
export function createCaptions(ctx) {
  const { els, getState, timeline, audio: audioApi, fmt, setProgress, onChanged } = ctx;

  let asrEnv = { device: 'wasm', f16: false };
  let worker = null;
  let job = null;          // the generation in flight, if any
  let jobSeq = 0;
  let saveTimer = null;
  let raf = 0;

  // ---- model presets -------------------------------------------------------
  async function detectDevice() {
    try {
      const adapter = navigator.gpu && await navigator.gpu.requestAdapter();
      if (adapter) asrEnv = { device: 'webgpu', f16: adapter.features.has('shader-f16') };
    } catch (_) { /* no WebGPU: the CPU (WASM) it is */ }
  }

  function preset(key) {
    const m = ASR_MODELS[key] || ASR_MODELS.base;
    const cfg = asrEnv.device === 'webgpu' ? ((!asrEnv.f16 && m.webgpuNoF16) || m.webgpu) : m.wasm;
    return { key: ASR_MODELS[key] ? key : 'base', model: m.id, label: m.label, device: asrEnv.device, dtype: cfg.dtype, mb: cfg.mb };
  }

  // Built once at boot and again when the GPU probe answers (the labels carry
  // per-device download sizes). A model the user picked — or one restored from
  // the last session — survives the rebuild; otherwise the default follows the
  // device, since turbo is only practical on a GPU.
  function populateModels() {
    const sel = els.inCapModel;
    const chosen = sel.dataset.chosen;
    sel.innerHTML = '';
    for (const key of Object.keys(ASR_MODELS)) {
      const p = preset(key);
      const o = document.createElement('option');
      o.value = key;
      o.textContent = `${p.label} (${fmtMB(p.mb)})`;
      sel.appendChild(o);
    }
    sel.value = chosen && ASR_MODELS[chosen] ? chosen : (asrEnv.device === 'webgpu' ? 'turbo' : 'base');
    if (getState()) updateUI();
  }

  // ---- small helpers -------------------------------------------------------
  const style = () => ({ size: els.inCapSize.value, position: els.inCapPos.value });
  const burnOn = () => {
    const state = getState();
    return !!(state && state.captions && state.captions.cues.length && els.inCapBurn.checked);
  };
  const setStatus = (msg) => { els.capStatus.textContent = msg || ''; };

  function updateUI() {
    const state = getState();
    if (!state) return;
    const p = preset(els.inCapModel.value);
    els.hintCapModel.textContent = p.device === 'webgpu'
      ? `${fmtMB(p.mb)} download the first time (cached after) · runs on your GPU via WebGPU.`
      : `${fmtMB(p.mb)} download the first time · no WebGPU in this browser, so it runs on the CPU — much slower (Whisper base recommended).`;
    const has = !!(state.captions && state.captions.cues.length);
    const busy = !!job;
    els.btnCapGen.hidden = busy;
    els.btnCapGen.disabled = !state.isAac;
    els.btnCapGen.textContent = has ? 'Regenerate captions' : 'Generate captions';
    els.btnCapCancel.hidden = !busy;
    els.btnCapClear.hidden = !has || busy;
    els.inCapModel.disabled = busy;
    els.inCapLang.disabled = busy;
    els.inCapBurn.disabled = !has;
    if (!state.isAac && !busy) {
      setStatus(state.audio ? `Captions need AAC audio; this file's audio is ${state.audio.codec}.` : 'This video has no audio track to transcribe.');
    }
    // Captions only cover what was kept when they were generated.
    let note = '';
    if (has && !busy && state.captions.segs) {
      const covered = timeline.keptSegments().every((k) => state.captions.segs.some((c) => k.start >= c.start - 0.05 && k.end <= c.end + 0.05));
      if (!covered) note = 'Your trim now includes parts that weren’t transcribed — generate again to caption them.';
    }
    els.capNote.textContent = note;
    els.capNote.hidden = !note;
    renderOverlay();
  }

  // ---- audio ---------------------------------------------------------------
  // Decode the audio and assemble just the kept sections, back to back, at
  // 16 kHz mono — i.e. the audio of the *output* video, which is what gets
  // transcribed. Gaps in the track are filled with silence so time stays true.
  async function decodeSpeechAudio(st, segs, onProgress) {
    const from = segs[0].start, to = segs[segs.length - 1].end;
    const pieces = [];
    let rs = null, t0 = 0, nextUS = 0;
    const push = (x) => { const y = rs.push(x); if (y.length) pieces.push(y); };
    const ok = await audioApi.decodeAudioTrack(st, (frame) => {
      const rate = frame.sampleRate, ts = frame.timestamp;
      const durUS = (frame.numberOfFrames / rate) * 1e6;
      if (ts + durUS < (from - 0.5) * 1e6 || ts > (to + 0.5) * 1e6) return;
      if (!rs) { rs = createResampler(rate); t0 = ts / 1e6; nextUS = ts; }
      const gap = Math.round(((ts - nextUS) / 1e6) * rate);
      if (gap > 0) push(new Float32Array(gap));
      push(audioApi.mixToMono(frame));
      nextUS = Math.max(nextUS, ts) + durUS;
    }, { untilS: to + 1, onProgress });
    if (!ok) throw new Error('This browser can’t decode the video’s audio.');

    const full = audioApi.concatFloat32(pieces);
    const R = ASR_SAMPLE_RATE;
    const lens = segs.map((s) => Math.max(0, Math.round((s.end - s.start) * R)));
    const kept = new Float32Array(lens.reduce((n, l) => n + l, 0));   // silence where there's no audio
    let o = 0;
    segs.forEach((s, i) => {
      const a = Math.round((s.start - t0) * R);
      const lo = Math.max(0, a), hi = Math.min(full.length, a + lens[i]);
      if (hi > lo) kept.set(full.subarray(lo, hi), o + (lo - a));
      o += lens[i];
    });
    return kept;
  }

  // ---- the worker ----------------------------------------------------------
  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./captions-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => { if (job && e.data.id === job.id) onMessage(job, e.data); };
    worker.onerror = (e) => {
      if (job && job.reject) job.reject(new Error(e.message || 'The captions worker failed to start.'));
      worker = null;
    };
    return worker;
  }

  function onMessage(j, m) {
    switch (m.type) {
      case 'status': setStatus(m.text); break;
      case 'load': {
        const prev = j.files[m.file] || { loaded: 0, total: 0 };
        const total = m.total || prev.total;
        j.files[m.file] = { total, loaded: m.status === 'done' ? total : (m.loaded || prev.loaded) };
        let loaded = 0, sum = 0;
        for (const f of Object.values(j.files)) { loaded += f.loaded; sum += f.total; }
        if (sum > 0) {
          setProgress(loaded / sum, els.capProgress);
          setStatus(`Loading the speech model — ${fmt.fmtBytes(loaded)} of ${fmt.fmtBytes(sum)} (downloaded once, then cached)…`);
        }
        break;
      }
      case 'language': j.language = m.language; break;
      case 'chunk':
        // The windows overlap, so the transcript is re-stitched from scratch
        // each time one lands — a seam needs the window on both sides of it.
        j.chunkWords[m.index] = m.words;
        j.words = mergeChunkWords(j.chunkWords, j.chunks);
        applyWords(j);
        setProgress((m.index + 1) / m.total, els.capProgress);
        setStatus(`Transcribing${j.language ? ` (${langName(j.language)})` : ''}… part ${m.index + 1} of ${m.total}`);
        break;
      case 'done': j.resolve('done'); break;
      case 'cancelled': j.resolve('cancelled'); break;
      case 'error': j.reject(new Error(m.message)); break;
    }
  }

  // Words come back on the compacted timeline (silences spliced out). Put them
  // back on the output timeline — as spans, so a word whose end Whisper
  // stretched into a removed pause can't swallow the silence after it — then
  // store the cues in source time.
  function applyWords(j) {
    const state = getState();
    if (state !== j.st) return;
    const onOutput = j.words.map((w) => ({ text: w.text, ...mapCompactSpan(j.map, w.start, w.end) }));
    const toSource = (o) => timeline.fromOutputTime(o, j.segs);
    state.captions = {
      cues: wordsToCues(onOutput).map((c) => ({ start: toSource(c.start), end: toSource(c.end), text: c.text })),
      language: j.language, model: j.preset.key, segs: j.segs,
    };
    renderOverlay();
  }

  // ---- generating ----------------------------------------------------------
  async function generate() {
    const state = getState();
    if (!state || !state.isAac || job) return;
    const st = state;
    const p = preset(els.inCapModel.value);
    const j = job = {
      id: ++jobSeq, st, preset: p, segs: timeline.keptSegments(),
      chunks: [], chunkWords: [], words: [], map: null, files: {}, language: null, stop: false,
    };
    const prev = st.captions;
    els.inCapBurn.checked = true;
    updateUI();
    setProgress(0, els.capProgress);
    let outcome = 'error', errMsg = '';
    try {
      setStatus('Reading the audio…');
      const pcm = await decodeSpeechAudio(st, j.segs, (f) => setProgress(f, els.capProgress));
      if (j.stop) { outcome = 'cancelled'; return; }

      // Find the speech and splice the silences out: Whisper charges a padded
      // 30 s per call either way, so a clip full of pauses would otherwise cost
      // far more than the talking in it — and silence is where it hallucinates.
      const speech = detectSpeech(pcm);
      if (!speech.length) throw new Error('no speech found in the kept audio.');
      const compact = compactSpeech(pcm, speech);
      j.map = compact.map;
      j.chunks = planChunks(compact.audio);
      if (!j.chunks.length) throw new Error('no speech found in the kept audio.');
      const spoken = compact.audio.length / ASR_SAMPLE_RATE;
      const skipped = pcm.length / ASR_SAMPLE_RATE - spoken;
      setStatus(`Transcribing ${fmt.fmtTime(spoken)} of speech${skipped > 1 ? ` (${fmt.fmtTime(skipped)} of silence skipped)` : ''}…`);
      setProgress(0, els.capProgress);

      const finished = new Promise((resolve, reject) => { j.resolve = resolve; j.reject = reject; });
      ensureWorker().postMessage({
        type: 'transcribe', id: j.id, model: p.model, dtype: p.dtype, device: p.device,
        audio: compact.audio, chunks: j.chunks, language: els.inCapLang.value,
      }, [compact.audio.buffer]);
      outcome = await finished;
    } catch (err) {
      console.error(err);
      outcome = 'error';
      errMsg = err.message || String(err);
    } finally {
      if (job === j) job = null;
      setProgress(null, els.capProgress);
      if (getState() === st) {
        if (!j.words.length) st.captions = outcome === 'done' ? null : prev;
        const n = st.captions ? st.captions.cues.length : 0;
        setStatus(
          outcome === 'done' ? (n
            ? `${n} captions · ${langName(j.language)} · ${p.label.split(' — ')[0]}. Fix any line below; they’re burned in when you compress.`
            : 'No speech found in the kept audio.')
          : outcome === 'cancelled' ? (j.words.length ? `Stopped — kept the ${n} captions transcribed so far.` : 'Stopped.')
          : `Captions failed: ${errMsg}${p.key !== 'base' ? ' A smaller model may work better on this device.' : ''}`);
        save();
        renderList();
        updateUI();
        onChanged();
      }
    }
  }

  function stop() {
    if (!job) return;
    job.stop = true;
    if (worker) worker.postMessage({ type: 'cancel' });
    setStatus('Stopping…');
  }

  // A new file replaces the one being captioned: drop the job outright.
  function abort() {
    if (!job) return;
    job.stop = true;
    if (worker) worker.postMessage({ type: 'cancel' });
    if (job.resolve) job.resolve('cancelled');
  }

  function clear() {
    const state = getState();
    if (!state || job) return;
    state.captions = null;
    save();
    renderList();
    setStatus('');
    updateUI();
    onChanged();
  }

  // ---- the cue list --------------------------------------------------------
  // Editable list of cues (output timecodes; cues in removed sections dimmed).
  function renderList() {
    const state = getState();
    const list = els.capList;
    list.innerHTML = '';
    const caps = state && state.captions;
    if (!caps || !caps.cues.length || job) { list.hidden = true; return; }
    const frag = document.createDocumentFragment();
    for (const c of caps.cues) {
      const os = timeline.toOutputTime(c.start), oe = timeline.toOutputTime(c.end);
      const kept = oe - os > 0.05;
      const row = document.createElement('div');
      row.style.cssText = `display:flex;gap:8px;align-items:center;padding:3px 0;${kept ? '' : 'opacity:.4'}`;
      const time = document.createElement('button');
      time.type = 'button';
      time.textContent = kept ? fmt.fmtTime(os) : 'cut';
      time.title = 'Jump to this caption';
      time.style.cssText = 'background:none;border:0;color:inherit;cursor:pointer;font:inherit;font-variant-numeric:tabular-nums;min-width:5.2em;text-align:left;padding:0';
      time.onclick = () => { els.preview.pause(); timeline.seek(c.start + 0.01); };
      const input = document.createElement('input');
      input.type = 'text';
      input.value = c.text;
      input.style.cssText = 'flex:1;min-width:0';
      input.oninput = () => { c.text = input.value; renderOverlay(); queueSave(); };
      row.append(time, input);
      frag.appendChild(row);
    }
    list.appendChild(frag);
    list.hidden = false;
  }

  // ---- the preview overlay -------------------------------------------------
  // Paint the current cue over the preview <video>, into the rectangle the
  // picture actually occupies (object-fit: contain) — same drawCaption() and
  // same proportions as the burned-in frames.
  function renderOverlay() {
    const state = getState();
    const cv = els.capOverlay, v = els.preview;
    if (!cv) return;
    const dpr = window.devicePixelRatio || 1;
    const cw = cv.clientWidth, ch = cv.clientHeight;
    const W = Math.round(cw * dpr), H = Math.round(ch * dpr);
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    const g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!burnOn() || !v.videoWidth || !cw || !ch) return;
    const cue = cueAt(state.captions.cues, v.currentTime || 0);
    if (!cue) return;
    const k = Math.min(cw / v.videoWidth, ch / v.videoHeight);
    const w = v.videoWidth * k, h = v.videoHeight * k;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawCaption(g, cue.text, (cw - w) / 2, (ch - h) / 2, w, h, style());
  }

  function overlayLoop() {
    cancelAnimationFrame(raf);
    const tick = () => { renderOverlay(); if (!els.preview.paused) raf = requestAnimationFrame(tick); };
    tick();
  }

  // Cues for the encode, in output time — [] unless burn-in is on.
  function exportCues() {
    if (!burnOn()) return [];
    const state = getState();
    const out = [];
    for (const c of state.captions.cues) {
      const start = timeline.toOutputTime(c.start), end = timeline.toOutputTime(c.end);
      const text = c.text.trim();
      if (end - start > 0.05 && text) out.push({ start, end, text });
    }
    return out;
  }

  // ---- persistence ---------------------------------------------------------
  // Captions are expensive to make, so they're kept (per file, like the trim)
  // and restored when the same file is loaded again.
  function save() {
    const state = getState();
    if (!state) return;
    try {
      if (state.captions && state.captions.cues.length) {
        const f = state.file;
        localStorage.setItem(LS_CAP_KEY, JSON.stringify({ v: 1, file: { name: f.name, size: f.size, lastModified: f.lastModified }, ...state.captions }));
      } else {
        localStorage.removeItem(LS_CAP_KEY);
      }
    } catch (_) {}
  }
  function queueSave() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }
  function restore(file) {
    try {
      const d = JSON.parse(localStorage.getItem(LS_CAP_KEY) || 'null');
      if (!d || !d.file || d.file.name !== file.name || d.file.size !== file.size || d.file.lastModified !== file.lastModified) return null;
      const cues = (d.cues || []).filter((c) => c && isFinite(c.start) && isFinite(c.end) && typeof c.text === 'string');
      return cues.length ? { cues, language: d.language || null, model: d.model || null, segs: Array.isArray(d.segs) ? d.segs : null } : null;
    } catch (_) { return null; }
  }

  // Settings the page persists alongside its own (model, language, look).
  function settings() {
    return {
      capModel: els.inCapModel.value, capLang: els.inCapLang.value,
      capSize: els.inCapSize.value, capPos: els.inCapPos.value, capBurn: els.inCapBurn.checked,
    };
  }
  function applySettings(g) {
    if (!g) return;
    const setSelect = (sel, v) => { if (v != null && [...sel.options].some((o) => o.value === v)) sel.value = v; };
    setSelect(els.inCapModel, g.capModel);
    if (g.capModel && ASR_MODELS[g.capModel]) els.inCapModel.dataset.chosen = g.capModel;
    setSelect(els.inCapLang, g.capLang);
    setSelect(els.inCapSize, g.capSize);
    setSelect(els.inCapPos, g.capPos);
    if (g.capBurn != null) els.inCapBurn.checked = !!g.capBurn;
  }

  // Buttons the page doesn't otherwise touch.
  function wire() {
    els.inCapModel.addEventListener('change', () => { els.inCapModel.dataset.chosen = els.inCapModel.value; });
    els.btnCapGen.addEventListener('click', generate);
    els.btnCapCancel.addEventListener('click', stop);
    els.btnCapClear.addEventListener('click', clear);
  }

  return {
    detectDevice, populateModels, wire,
    updateUI, setStatus, renderList, renderOverlay, overlayLoop,
    generate, stop, abort, clear,
    burnOn, style, exportCues,
    save, queueSave, restore, settings, applySettings,
  };
}
