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
import { dbToLinear, applyGainInPlace, createLeveler, analyzeVoiceLevel } from './audio-boost.js';

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
  const { els, getState, timeline, audio: audioApi, fmt, setProgress, onChanged, voice } = ctx;

  let asrEnv = { device: 'wasm', f16: false };
  let worker = null;
  let job = null;          // the generation in flight, if any
  let jobSeq = 0;
  let saveTimer = null;
  let raf = 0;
  let cachedModels = {};   // preset key -> weights already in Cache Storage

  // ---- model presets -------------------------------------------------------
  async function detectDevice() {
    try {
      const adapter = navigator.gpu && await navigator.gpu.requestAdapter();
      if (adapter) asrEnv = { device: 'webgpu', f16: adapter.features.has('shader-f16') };
    } catch (_) { /* no WebGPU: the CPU (WASM) it is */ }
    refreshCached();       // the device picks the dtype, and so the files to look for
  }

  function preset(key) {
    const m = ASR_MODELS[key] || ASR_MODELS.base;
    const cfg = asrEnv.device === 'webgpu' ? ((!asrEnv.f16 && m.webgpuNoF16) || m.webgpu) : m.wasm;
    return { key: ASR_MODELS[key] ? key : 'base', model: m.id, label: m.label, device: asrEnv.device, dtype: cfg.dtype, mb: cfg.mb };
  }

  // ---- the model cache -----------------------------------------------------
  // transformers.js keeps downloaded weights in Cache Storage under
  // `transformers-cache`, keyed by the Hub URL it fetched them from. That cache
  // belongs to *this* origin, so the live site and a local test server each
  // keep their own copy — same model, downloaded twice.
  //
  // Two things make the download feel less repetitive: ask the browser to make
  // the storage durable (otherwise Chrome may evict a 1.6 GB cache when disk
  // runs low), and tell the user which models are already on disk, so picking
  // one isn't a gamble on a long download.
  const HUB = 'https://huggingface.co/';
  const DTYPE_SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', q4: '_q4', q4f16: '_q4f16', int8: '_int8', uint8: '_uint8', bnb4: '_bnb4' };
  let persistedStorage = null;    // null = not asked yet

  // The weight files a preset downloads. Everything else it fetches (configs,
  // the tokenizer) is a few KB, so these alone decide "is it already here".
  function weightURLs(p) {
    const d = typeof p.dtype === 'string' ? { encoder_model: p.dtype, decoder_model_merged: p.dtype } : p.dtype;
    return Object.entries(d).map(([f, t]) =>
      `${HUB}${p.model}/resolve/main/onnx/${f}${DTYPE_SUFFIX[t] ?? ''}.onnx`);
  }

  async function isModelCached(p) {
    try {
      if (!self.caches || !(await caches.has('transformers-cache'))) return false;
      const cache = await caches.open('transformers-cache');
      const hits = await Promise.all(weightURLs(p).map((u) => cache.match(u)));
      return hits.every(Boolean);
    } catch (_) { return false; }   // private window, storage blocked: just quote the size
  }

  // Durable storage keeps the weights from being evicted under disk pressure.
  // Chrome decides silently (bookmark the page / visit it a few times and it
  // says yes); Safari and Firefox may prompt or refuse. Either way it's a
  // hint, not a guarantee, so nothing here depends on the answer.
  async function requestPersistence() {
    try {
      if (!navigator.storage || !navigator.storage.persist) return false;
      persistedStorage = (await navigator.storage.persisted()) || (await navigator.storage.persist());
    } catch (_) { persistedStorage = false; }
    return persistedStorage;
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
      o.textContent = `${p.label} (${cachedModels[key] ? 'downloaded' : fmtMB(p.mb)})`;
      sel.appendChild(o);
    }
    sel.value = chosen && ASR_MODELS[chosen] ? chosen : (asrEnv.device === 'webgpu' ? 'turbo' : 'base');
    if (getState()) updateUI();
  }

  // Which presets are already on disk, for the labels above. Re-run after a
  // download so the list stops quoting a size the user no longer has to pay.
  async function refreshCached() {
    const seen = await Promise.all(Object.keys(ASR_MODELS).map((k) => isModelCached(preset(k))));
    let changed = false;
    Object.keys(ASR_MODELS).forEach((k, i) => {
      if (cachedModels[k] !== seen[i]) { cachedModels[k] = seen[i]; changed = true; }
    });
    if (changed) populateModels();
  }

  // ---- small helpers -------------------------------------------------------
  const style = () => ({ size: els.inCapSize.value, position: els.inCapPos.value, look: els.inCapLook.value });
  const burnOn = () => {
    const state = getState();
    return !!(state && state.captions && state.captions.cues.length && els.inCapBurn.checked);
  };
  const setStatus = (msg) => { els.capStatus.textContent = msg || ''; };

  function updateUI() {
    const state = getState();
    if (!state) return;
    const p = preset(els.inCapModel.value);
    const cached = cachedModels[p.key];
    const download = cached ? 'Already downloaded — starts straight away' : `${fmtMB(p.mb)} download the first time (cached after)`;
    els.hintCapModel.textContent = p.device === 'webgpu'
      ? `${download} · runs on your GPU via WebGPU.`
      : `${download} · no WebGPU in this browser, so it runs on the CPU — much slower (Whisper base recommended).`;
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
      if (!covered) note = 'Parts of your selection weren’t transcribed — generate again to cover them.';
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

  // Whisper hears what the viewer will hear: if the export is boosting the
  // audio, transcribe the boosted signal. Quiet recordings are exactly the
  // case where speech detection gives up otherwise — a screen recording at
  // -60 dBFS sits below the detector's floor until the boost lifts it.
  //
  // Manual is the flat dB the slider asks for, through the same soft limiter
  // as the export. Auto re-measures the voice-band level of *this* audio (the
  // kept range, already at 16 kHz mono) rather than waiting on the whole-track
  // analysis, then rides the same lookahead leveler, so a quiet voice comes up
  // without a loud passage being driven any harder.
  function boostForSpeech(pcm) {
    const { mode, db } = audioApi.gain();
    if (mode === 'manual' && db > 0.05) {
      applyGainInPlace(pcm, dbToLinear(db));
      return { audio: pcm, gainDb: db, mode };
    }
    if (mode === 'auto') {
      const { autoGainDb } = analyzeVoiceLevel(pcm, ASR_SAMPLE_RATE);
      if (autoGainDb > 0.05) {
        const leveler = createLeveler(ASR_SAMPLE_RATE, { maxGainDb: autoGainDb });
        const out = new Float32Array(pcm.length);
        let o = 0;
        const CHUNK = 1 << 16;
        for (let i = 0; i < pcm.length; i += CHUNK) {
          const piece = pcm.subarray(i, Math.min(pcm.length, i + CHUNK));
          const y = leveler.process(piece, 1, piece);          // mono: one channel, its own mixdown
          out.set(y.subarray(0, Math.min(y.length, out.length - o)), o);
          o += Math.min(y.length, out.length - o);
        }
        const tail = leveler.flush();                          // the lookahead buffer's last few ms
        if (tail.length && o < out.length) {
          out.set(tail.subarray(0, out.length - o), o);
          o += Math.min(tail.length, out.length - o);
        }
        return { audio: out.subarray(0, o), gainDb: autoGainDb, mode };
      }
      return { audio: pcm, gainDb: 0, mode };
    }
    return { audio: pcm, gainDb: 0, mode };
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
      // `orig` is what the model said; `text` is what the user may have
      // retyped. Overdub respeaks a line exactly when the two differ.
      cues: wordsToCues(onOutput).map((c) => ({ start: toSource(c.start), end: toSource(c.end), text: c.text, orig: c.text })),
      // The word timings are kept, not just the cues they get merged into. A
      // cue spans a whole phrase *including its pauses* — consecutive cues are
      // usually butted right up against each other — so it says almost nothing
      // about where speech actually stops. Word spans do, and that's what the
      // breath detector needs to know where the gaps are.
      // The text rides along too: overdub picks its cloning reference out of
      // these, and showing which words it is about to imitate is the
      // difference between a trustworthy button and a magic one.
      words: onOutput.map((w) => ({ start: toSource(w.start), end: toSource(w.end), text: w.text })),
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
      id: ++jobSeq, st, preset: p, segs: timeline.fullSegments(),
      chunks: [], chunkWords: [], words: [], map: null, files: {}, language: null, stop: false,
    };
    const prev = st.captions;
    els.inCapBurn.checked = true;
    updateUI();
    setProgress(0, els.capProgress);
    let outcome = 'error', errMsg = '';
    try {
      setStatus('Reading the audio…');
      const decoded = await decodeSpeechAudio(st, j.segs, (f) => setProgress(f, els.capProgress));
      if (j.stop) { outcome = 'cancelled'; return; }

      // Transcribe what the export will sound like, boost included.
      const boosted = boostForSpeech(decoded);
      const pcm = boosted.audio;
      if (boosted.gainDb > 0.05) {
        j.boostNote = ` · heard it ${boosted.mode === 'auto' ? 'auto-boosted up to ' : 'boosted '}+${boosted.gainDb.toFixed(1)} dB`;
        setStatus(`Boosted the audio by ${boosted.mode === 'auto' ? 'up to ' : ''}+${boosted.gainDb.toFixed(1)} dB for transcription…`);
      }

      // Find the speech and splice the silences out: Whisper charges a padded
      // 30 s per call either way, so a clip full of pauses would otherwise cost
      // far more than the talking in it — and silence is where it hallucinates.
      const speech = detectSpeech(pcm);
      if (!speech.length) {
        throw new Error(boosted.gainDb > 0.05
          ? 'no speech found in the kept audio.'
          : 'no speech found — if the recording is quiet, turn on a volume boost above and try again.');
      }
      const compact = compactSpeech(pcm, speech);
      j.map = compact.map;
      j.chunks = planChunks(compact.audio);
      if (!j.chunks.length) throw new Error('no speech found in the kept audio.');
      const spoken = compact.audio.length / ASR_SAMPLE_RATE;
      const skipped = pcm.length / ASR_SAMPLE_RATE - spoken;
      setStatus(`Transcribing ${fmt.fmtTime(spoken)} of speech${skipped > 1 ? ` (${fmt.fmtTime(skipped)} of silence skipped)` : ''}…`);
      setProgress(0, els.capProgress);

      const finished = new Promise((resolve, reject) => { j.resolve = resolve; j.reject = reject; });
      // Ask for durable storage before the weights land, so a 1.6 GB cache
      // isn't the first thing evicted when the disk fills up.
      if (persistedStorage === null) await requestPersistence();
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
      refreshCached();   // anything downloaded just now is cached from here on
      if (getState() === st) {
        if (!j.words.length) st.captions = outcome === 'done' ? null : prev;
        const n = st.captions ? st.captions.cues.length : 0;
        setStatus(
          outcome === 'done' ? (n
            ? `${n} captions · ${langName(j.language)} · ${p.label.split(' — ')[0]}${j.boostNote || ''}. Fix any line below; they’re burned in when you compress.`
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
  // The transcript is the edit surface. Every line can be cut or sped up, and
  // the silences *between* lines get rows of their own — reading down the
  // column is how you decide what the screencast keeps, which is much easier
  // than guessing from a waveform.
  const GAP_MIN = 1.5;            // shorter than this is a breath, not a section

  function actionButton(label, title, onClick, tone) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.title = title;
    b.style.cssText =
      'padding:2px 7px;font-size:.72rem;font-weight:600;border-radius:5px;cursor:pointer;' +
      'border:1px solid var(--border);background:var(--panel-2);color:var(--text);white-space:nowrap;' +
      (tone === 'danger' ? 'border-color:#e74c3c;color:#e74c3c;' : '') +
      (tone === 'active' ? 'border-color:#3478f6;background:#3478f6;color:#fff;' : '');
    b.onclick = onClick;
    return b;
  }

  // The buttons every row carries: cut it, speed it up with the voice kept,
  // speed it up silently, or put it back.
  function rowActions(start, end) {
    const wrap = document.createElement('span');
    wrap.style.cssText = 'display:flex;gap:4px;flex:0 0 auto';
    const edit = ctx.edits.at(start + 0.01);
    const covers = edit && edit.start <= start + 0.05 && edit.end >= end - 0.05;
    if (covers) {
      const tag = document.createElement('span');
      tag.textContent = ctx.edits.label(edit);
      tag.style.cssText = 'font-size:.72rem;font-weight:700;color:var(--muted);align-self:center;min-width:4.2em;text-align:right';
      wrap.append(tag, actionButton('restore', 'Play this at normal speed again',
        () => ctx.edits.apply(edit.start, edit.end, 1), 'active'));
      return wrap;
    }
    const r = ctx.edits.rate(), rl = ctx.edits.rateLabel();
    wrap.append(
      actionButton('cut', 'Remove this from the video', () => ctx.edits.apply(start, end, 0), 'danger'),
      actionButton(`${rl} voice`, `Play ${rl} faster, narration time-stretched (pitch kept)`,
        () => ctx.edits.apply(start, end, r, 'keep')),
      actionButton(`${rl} silent`, `Play ${rl} faster with no sound — a time-lapse`,
        () => ctx.edits.apply(start, end, r, 'mute')),
    );
    return wrap;
  }

  function renderList() {
    const state = getState();
    const list = els.capList;
    list.innerHTML = '';
    const caps = state && state.captions;
    if (!caps || !caps.cues.length || job) { list.hidden = true; return; }
    const frag = document.createDocumentFragment();

    // One-tap tidy-up: every long silence becomes a time-lapse.
    const gaps = [];
    let prevEnd = 0;
    for (const c of caps.cues) {
      if (c.start - prevEnd > GAP_MIN) gaps.push({ start: prevEnd, end: c.start });
      prevEnd = Math.max(prevEnd, c.end);
    }
    if (state.durationS - prevEnd > GAP_MIN) gaps.push({ start: prevEnd, end: state.durationS });

    if (gaps.length) {
      const bar = document.createElement('div');
      bar.style.cssText = 'display:flex;gap:6px;align-items:center;padding:4px 0 8px;border-bottom:1px solid var(--border);margin-bottom:6px;flex-wrap:wrap';
      const label = document.createElement('span');
      const total = gaps.reduce((n, g) => n + (g.end - g.start), 0);
      label.className = 'small muted';
      label.textContent = `${gaps.length} silence${gaps.length > 1 ? 's' : ''} over ${GAP_MIN}s · ${fmt.fmtTime(total)} total`;
      label.style.marginRight = 'auto';
      const r = ctx.edits.rate(), rl = ctx.edits.rateLabel();
      bar.append(label,
        actionButton(`all ${rl} silent`, 'Speed every one of those silences up, with no sound',
          () => { for (const g of gaps) ctx.edits.apply(g.start, g.end, r, 'mute'); }),
        actionButton('cut all', 'Remove every one of those silences',
          () => { for (const g of gaps) ctx.edits.apply(g.start, g.end, 0); }, 'danger'));
      frag.appendChild(bar);
    }

    const gapRow = (start, end) => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:8px;align-items:center;padding:3px 0;opacity:.75';
      const time = document.createElement('span');
      time.textContent = fmt.fmtTime(timeline.toOutputTime(start));
      time.style.cssText = 'font-variant-numeric:tabular-nums;min-width:5.2em;font-size:.85rem;color:var(--muted)';
      const what = document.createElement('span');
      what.textContent = `— ${(end - start).toFixed(1)} s of silence —`;
      what.className = 'small muted';
      what.style.cssText = 'flex:1;min-width:0;font-style:italic';
      // Gaps get one too: a silence is often the thing you want to check.
      const gapPlay = document.createElement('button');
      gapPlay.type = 'button';
      gapPlay.textContent = '▶';
      gapPlay.title = 'Play this silence';
      gapPlay.style.cssText = 'flex:0 0 auto;font:inherit;font-size:.78rem;padding:2px 8px;border-radius:6px;'
        + 'border:1px solid var(--border);background:var(--panel-2);color:inherit;cursor:pointer';
      gapPlay.onclick = () => ctx.playLine(start, end, { dubs: true });
      row.append(time, what, gapPlay, rowActions(start, end));
      return row;
    };

    let last = 0;
    for (const c of caps.cues) {
      if (c.start - last > GAP_MIN) frag.appendChild(gapRow(last, c.start));
      last = Math.max(last, c.end);

      const os = timeline.toOutputTime(c.start), oe = timeline.toOutputTime(c.end);
      const edit = ctx.edits.at(c.start + 0.01);
      const cut = !!edit && !(edit.rate > 0);
      const row = document.createElement('div');
      row.style.cssText = `display:flex;gap:8px;align-items:center;padding:3px 0;${cut || oe - os <= 0.02 ? 'opacity:.45' : ''}`;
      const time = document.createElement('button');
      time.type = 'button';
      time.textContent = cut ? 'cut' : fmt.fmtTime(os);
      time.title = 'Jump to this line';
      time.style.cssText = 'background:none;border:0;color:inherit;cursor:pointer;font:inherit;font-variant-numeric:tabular-nums;min-width:5.2em;text-align:left;padding:0';
      time.onclick = () => { els.preview.pause(); timeline.seek(c.start + 0.01); };
      const input = document.createElement('input');
      input.type = 'text';
      input.value = c.text;
      input.style.cssText = 'flex:1;min-width:0';
      input.oninput = () => { c.text = input.value; renderOverlay(); queueSave(); refreshDub(); };
      // Respeaking is offered on every line, not only edited ones. Changing
      // the words is one reason to respeak; disliking how you said them is
      // just as good a one, and the transcript can be perfectly correct while
      // the delivery is not.
      const smallBtn = (bg) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.style.cssText = 'flex:0 0 auto;font:inherit;font-size:.78rem;padding:2px 8px;border-radius:6px;'
          + `border:1px solid var(--border);background:${bg};color:inherit;cursor:pointer`;
        return b;
      };
      const undoBtn = smallBtn('var(--panel-2)');   // put the transcript text back
      const dubBtn = smallBtn('var(--panel-2)');    // respeak / undo respeak

      // Hear just this line, as it will be in the export — sped up if it's in
      // a fast section, respoken if it's been respoken. A second button
      // appears once there's a dub, so the two can be compared back to back.
      const playBtn = smallBtn('var(--panel-2)');
      playBtn.textContent = '▶';
      playBtn.title = 'Play this line';
      playBtn.onclick = () => ctx.playLine(c.start, c.end, { dubs: true });
      const playOrigBtn = smallBtn('var(--panel-2)');
      playOrigBtn.textContent = '▶ orig';
      playOrigBtn.title = 'Play the original recording of this line';
      playOrigBtn.onclick = () => ctx.playLine(c.start, c.end, { dubs: false });

      const refreshDub = () => {
        playOrigBtn.hidden = !c.dub;      // nothing to compare against otherwise
        if (!voice) { dubBtn.hidden = true; undoBtn.hidden = true; return; }
        const edited = voice.isChanged(c);

        // Restoring the transcript means going back to the recording, so it
        // drops the respoken audio with it — otherwise you'd be left with a
        // generated line claiming to be what the model heard.
        undoBtn.hidden = !edited;
        undoBtn.textContent = 'restore text';
        undoBtn.title = 'Put the transcribed wording back' + (c.dub ? ' (and drop the respoken audio)' : '');
        undoBtn.onclick = () => {
          c.text = c.orig;
          input.value = c.orig;
          if (c.dub) voice.revert(c);
          renderOverlay();
          queueSave();
          renderList();
        };

        dubBtn.hidden = false;
        const state = voice.jobState(c);
        if (state) {
          // Clicking a second line while the first is generating queues it.
          // Saying so on the row is the whole point — the version that
          // silently refused looked like a hung page.
          dubBtn.disabled = true;
          dubBtn.textContent = state === 'running' ? 'respeaking…' : 'queued';
          dubBtn.title = state === 'running'
            ? 'Generating this line now'
            : 'Waiting for the lines ahead of it';
          dubBtn.onclick = null;
        } else if (c.dub) {
          dubBtn.disabled = false;
          dubBtn.textContent = 'undo respeak';
          dubBtn.title = 'Put the original recording back for this line';
          dubBtn.onclick = () => { voice.revert(c); renderList(); };
        } else {
          dubBtn.disabled = false;
          dubBtn.textContent = 'respeak';
          dubBtn.title = edited
            ? 'Say this line as you typed it, in your voice'
            : 'Say this line again in your voice — for when the words are right but the delivery wasn’t';
          dubBtn.onclick = () => {
            // Not awaited: the queue owns the ordering, and the list repaints
            // from voice-ui's onChanged as each line starts and finishes.
            voice.respeak(c).catch((e) => {
              if (e && e.message !== 'cancelled') voice.setStatus(e.message);
            });
          };
        }
      };
      refreshDub();
      row.append(time, input, playBtn, playOrigBtn, undoBtn, dubBtn, rowActions(c.start, c.end));
      frag.appendChild(row);
    }
    if (state.durationS - last > GAP_MIN) frag.appendChild(gapRow(last, state.durationS));

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
      // A silent time-lapse has nothing to say: flashing its transcript past at
      // 8× would be unreadable noise over footage nobody can hear.
      const edit = ctx.edits.at(c.start + 0.01);
      if (edit && edit.rate !== 1 && edit.audio !== 'keep') continue;
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
      const cues = (d.cues || []).filter((c) => c && isFinite(c.start) && isFinite(c.end) && typeof c.text === 'string')
        .map((c) => ({ ...c, orig: typeof c.orig === 'string' ? c.orig : c.text }));
      const words = (d.words || []).filter((w) => w && isFinite(w.start) && isFinite(w.end));
      return cues.length ? { cues, words, language: d.language || null, model: d.model || null, segs: Array.isArray(d.segs) ? d.segs : null } : null;
    } catch (_) { return null; }
  }

  // Settings the page persists alongside its own (model, language, look).
  function settings() {
    return {
      capModel: els.inCapModel.value, capLang: els.inCapLang.value,
      capSize: els.inCapSize.value, capPos: els.inCapPos.value, capLook: els.inCapLook.value,
      capBurn: els.inCapBurn.checked,
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
    setSelect(els.inCapLook, g.capLook);
    if (g.capBurn != null) els.inCapBurn.checked = !!g.capBurn;
  }

  // Buttons the page doesn't otherwise touch.
  function wire() {
    els.inCapModel.addEventListener('change', () => { els.inCapModel.dataset.chosen = els.inCapModel.value; });
    refreshCached();
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
