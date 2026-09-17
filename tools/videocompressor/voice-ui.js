// Overdub, the interactive half: the voice model's download, the reference
// clip taken out of your own recording, and the respoken lines themselves.
//
// voice.js holds the pure logic (what changed, where the seam goes, fitting a
// generation into its slot); voice-worker.js runs the model; this module joins
// them to the page, the way captions-ui.js does for Whisper. compressor.js
// hands it everything it needs through `ctx` and asks it for one thing back:
// `pcmFor(id, …)`, the samples the encoder should emit for a respoken span.
//
// What is kept where, and why:
//
//   state.dubs      id -> { text, start, end, mode, seed, pcm }   (in memory)
//   localStorage    the same minus `pcm`
//
// The audio is deliberately not persisted. A minute of respoken narration is
// several MB of float samples, localStorage is a ~5 MB budget shared with the
// captions, and the whole point of a seeded generation is that it can be made
// again exactly. So a reload restores the *intent* — this line, this span,
// this seed — and regenerates on demand.
import {
  changedLines, isChanged, snapSpan, pickReference, finishDub, naturalRate,
  planFit, toMono, rms, FIT_MIN_RATE, FIT_MAX_RATE,
} from './voice.js';
import { createResampler } from './captions.js';
import { analyzeVoiceLevel } from './audio-boost.js';

// Only the int8 bundle is offered. The fp32 flow model is 302 MB against
// 76 MB and measured no better on a screencast; the encoder and the text
// conditioner are small either way. Languages are what the ONNX bundle
// actually ships.
const VOICE_REPO = 'KevinAHM/pocket-tts-onnx';
const VOICE_LANGS = {
  'english_2026-04': 'English',
  french_24l: 'French',
  german: 'German',
  italian: 'Italian',
  portuguese: 'Portuguese',
  spanish: 'Spanish',
};
const VOICE_MB = 146;              // the five graphs, int8
const MODEL_SR = 24000;            // what the model speaks at
const REF_MIN_S = 6, REF_MAX_S = 15;
const LS_DUB_KEY = 'videocompressor:dubs:v1';

// ctx: { els, getState, timeline, edits, audio, fmt, setProgress, onChanged }
export function createVoice(ctx) {
  const { els, getState, timeline, audio: audioApi, fmt, setProgress, onChanged } = ctx;

  let worker = null;
  let loaded = false;          // models open in the worker
  let clonedFor = null;        // the reference span the worker currently holds
  let reference = null;        // { start, end, text, density }
  let refRank = 0;             // which candidate is in use, for "try another"
  let referenceDbfs = null;    // the reference clip's voice level, as a fallback target
  let seq = 0;
  const finished = new Map();  // cache: dubId|sr|ch|frames -> interleaved

  // ---- the model cache ----------------------------------------------------
  // Same bargain as the captions: Cache Storage, keyed by Hub URL, per origin.
  async function isCached() {
    try {
      if (!self.caches || !(await caches.has('transformers-cache'))) return false;
      const cache = await caches.open('transformers-cache');
      const lang = els.inVoiceLang.value;
      const base = `https://huggingface.co/${VOICE_REPO}/resolve/main/onnx/${lang}/`;
      const hits = await Promise.all(
        ['flow_lm_main_int8', 'mimi_decoder_int8', 'mimi_encoder_int8']
          .map((f) => cache.match(`${base}${f}.onnx`)));
      return hits.every(Boolean);
    } catch (_) { return false; }
  }

  async function refreshCachedLabel() {
    const hint = els.hintVoiceLang;
    if (!hint) return;
    hint.textContent = (await isCached()) ? 'downloaded' : `${VOICE_MB} MB download, once`;
  }

  function ensureWorker() {
    if (worker) return worker;
    worker = new Worker(new URL('./voice-worker.js', import.meta.url), { type: 'module' });
    return worker;
  }

  // One request, one reply. The worker answers in order, so a job is a promise
  // over the next message of the type it is waiting for.
  function ask(msg, wantType, onProgress) {
    const w = ensureWorker();
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const on = (e) => {
        const m = e.data;
        if (m.id !== undefined && m.id !== id) return;
        if (m.type === 'error') { w.removeEventListener('message', on); reject(new Error(m.message)); }
        else if (m.type === 'cancelled') { w.removeEventListener('message', on); reject(new Error('cancelled')); }
        else if (m.type === wantType) { w.removeEventListener('message', on); resolve(m); }
        else if (onProgress) onProgress(m);
      };
      w.addEventListener('message', on);
      w.postMessage({ ...msg, id }, msg.transfer || []);
    });
  }

  function status(text) { if (els.voiceStatus) els.voiceStatus.textContent = text; }

  async function ensureLoaded() {
    if (loaded) return;
    const lang = els.inVoiceLang.value;
    await ask({ type: 'load', bundle: { repo: VOICE_REPO, language: lang, precision: 'int8' } },
      'ready', (m) => {
        if (m.type === 'status') status(m.text);
        else if (m.type === 'load' && m.total) {
          const pct = Math.round((m.loaded / m.total) * 100);
          status(`Downloading the voice model — ${m.file} ${pct}%`);
          setProgress(m.loaded / m.total, els.voiceProgress);
        }
      });
    setProgress(null, els.voiceProgress);
    loaded = true;
    refreshCachedLabel();
  }

  // ---- the reference clip -------------------------------------------------
  // Nobody records a sample: the transcript already says where the cleanest
  // continuous speech in this recording is, and taking it from here means the
  // clone arrives with the same microphone and the same room on it.

  function candidates() {
    const state = getState();
    const words = state && state.captions && state.captions.words;
    if (!words || !words.length) return [];
    const kept = timeline.keptSegments();
    const out = [];
    let pool = words;
    // Pick the best, then exclude it and pick again, so "try another" has
    // somewhere to go.
    for (let i = 0; i < 4; i++) {
      const r = pickReference(pool, {
        minS: REF_MIN_S, maxS: REF_MAX_S, within: kept, durationS: state.durationS,
      });
      if (!r) break;
      out.push(r);
      pool = pool.filter((w) => w.end <= r.start || w.start >= r.end);
    }
    return out;
  }

  /** Decode the reference span out of the source file, at the model's rate. */
  async function readReference(ref) {
    const state = getState();
    const chunks = [];
    let resampler = null, srcRate = 0;
    status('Reading the reference clip…');
    await audioApi.decodeAudioTrack(state, (frame) => {
      const t = frame.timestamp / 1e6;
      const dur = frame.numberOfFrames / frame.sampleRate;
      if (t + dur < ref.start || t > ref.end) return;
      if (!resampler) { srcRate = frame.sampleRate; resampler = createResampler(srcRate, MODEL_SR); }
      const mono = audioApi.mixToMono(frame);
      // Trim the frame to the part inside the span before resampling, so the
      // clip starts and ends where it was asked to.
      const from = Math.max(0, Math.round((ref.start - t) * frame.sampleRate));
      const to = Math.min(mono.length, Math.round((ref.end - t) * frame.sampleRate));
      if (to > from) chunks.push(resampler.push(mono.subarray(from, to)).slice());
    }, { untilS: ref.end + 0.5 });
    let total = 0;
    for (const c of chunks) total += c.length;
    const out = new Float32Array(total);
    let at = 0;
    for (const c of chunks) { out.set(c, at); at += c.length; }
    return out;
  }

  async function ensureCloned() {
    await ensureLoaded();
    if (!reference) {
      const list = candidates();
      if (!list.length) {
        throw new Error('No transcript yet — generate one in step 2 first, so the tool can find clean speech to clone from.');
      }
      reference = list[Math.min(refRank, list.length - 1)];
    }
    const key = `${reference.start.toFixed(3)}-${reference.end.toFixed(3)}`;
    if (clonedFor === key) return;
    const audio = await readReference(reference);
    if (audio.length < REF_MIN_S * MODEL_SR * 0.8) {
      throw new Error('The reference clip came back too short to clone from.');
    }
    // How loud this speaker actually is, measured before the audio is handed
    // over — the generation has to come back at this level, not the model's.
    try {
      const a = analyzeVoiceLevel(audio, MODEL_SR);
      if (Number.isFinite(a.voiceDbfs) && a.voiceDbfs > -80) referenceDbfs = a.voiceDbfs;
    } catch (_) { referenceDbfs = null; }
    await ask({ type: 'clone', audio, transfer: [audio.buffer] }, 'cloned',
      (m) => { if (m.type === 'status') status(m.text); });
    clonedFor = key;
    renderReference();
  }

  function renderReference() {
    const el = els.voiceRef;
    if (!el) return;
    if (!reference) { el.textContent = ''; return; }
    el.textContent =
      `Cloning from ${fmt.fmtTime(reference.start)}–${fmt.fmtTime(reference.end)} `
      + `(${(reference.end - reference.start).toFixed(1)} s, ${Math.round(reference.density * 100)}% speech): `
      + `“${reference.text.slice(0, 80)}${reference.text.length > 80 ? '…' : ''}”`;
  }

  // ---- respeaking a line --------------------------------------------------

  // The level a respoken line has to land at. The whole-track voice-band
  // measurement is the best answer when it exists — it is the same number the
  // auto-boost works from, so a dub and the recording end up on one scale.
  // The reference clip is the fallback, since it is the same speaker on the
  // same microphone and is always available by the time anything is generated.
  function targetDbfs() {
    const state = getState();
    const a = state && state.audioAnalysis;
    if (a && Number.isFinite(a.voiceDbfs) && a.voiceDbfs > -80) return a.voiceDbfs;
    return referenceDbfs;
  }

  // How much pause the user is willing to keep. Explicit, because "how long a
  // silence is too long" is a matter of taste and no default was going to be
  // right for everyone.
  function fitOpts() {
    const trimDeadAir = els.inVoiceTrim ? els.inVoiceTrim.checked : true;
    const raw = els.inVoiceDeadAir ? parseFloat(els.inVoiceDeadAir.value) : 0.15;
    const pct = els.inVoiceStretch ? parseFloat(els.inVoiceStretch.value) : 50;
    const span = Number.isFinite(pct) ? Math.max(0, Math.min(100, pct)) / 100 : 0.5;
    return {
      trimDeadAir,
      deadAirS: Number.isFinite(raw) ? Math.max(0, raw) : 0.15,
      // How far the picture may drift from real time, in either direction.
      maxVideoRate: 1 + span,
      minVideoRate: 1 / (1 + span),
    };
  }

  function dubs() {
    const state = getState();
    if (!state.dubs) state.dubs = new Map();
    return state.dubs;
  }

  /**
   * Respeak one cue. Returns the dub record. `mode` is 'fit' (squeeze the
   * generation into the hole the old line left, picture untouched) or
   * 'natural' (let the section run at its own length, the picture stretching
   * or hurrying to match).
   */
  async function doRespeak(cue, { mode = null, seed = null, quiet = false } = {}) {
    try {
      const state = getState();
      await ensureCloned();

      const words = (state.captions && state.captions.words) || [];
      const span = snapSpan(cue.start, cue.end, words);
      if (!quiet) {
        const n = jobs.length;
        status(n ? `Respeaking… (${n} more queued)` : 'Respeaking…');
      }
      const use = seed == null ? (Math.random() * 1e9) | 0 : seed;
      const res = await ask({ type: 'speak', text: cue.text, temperature: 0.7, seed: use },
        'audio', (m) => {
          if (quiet) return;
          if (m.type === 'status') status(m.text);
          else if (m.type === 'progress' && m.estimate) setProgress(m.frames / m.estimate, els.voiceProgress);
        });
      setProgress(null, els.voiceProgress);

      const dubS = res.pcm.length / res.sampleRate;
      const srcS = span.end - span.start;
      // The pause the span reached into at each end: silence that belongs to
      // the span but is not the line's own dead air. `leadS` is the half of it
      // at the front, which is what keeps the respoken line on its timestamp.
      const leadS = span.lead || 0;
      const borrowedS = leadS + (span.tail || 0);
      const plan = planFit(srcS, dubS, { ...fitOpts(), borrowedS });
      const chosen = mode || plan.mode;

      const id = `d${Date.now().toString(36)}${(Math.random() * 1e6 | 0).toString(36)}`;
      const rec = {
        id, text: cue.text, start: span.start, end: span.end,
        mode: chosen, seed: use, pcm: res.pcm, sampleRate: res.sampleRate,
        dubS, srcS, leadS, borrowedS,
        cueStart: cue.start, targetDbfs: targetDbfs(), rate: 1,
      };
      dubs().set(id, rec);
      finished.clear(); previewBufs.clear();

      // A dub is an ordinary edit carrying an id: 'fit' keeps the section's
      // length (rate 1), 'natural' lets the rate absorb the difference, which
      // everything downstream already understands.
      const rate = chosen === 'natural' ? plan.rate : 1;
      rec.rate = rate;
      ctx.edits.applyDub(span.start, span.end, rate, id);

      cue.dub = id;
      cue.orig = cue.text;      // it now matches what will be spoken

      // What the section will actually occupy, and therefore how much of it is
      // pause. The rate is bounded, so cutting nearly all of a long line can
      // still leave real dead air — say so instead of quietly producing it,
      // because the right answer then is to cut the section, not respeak it.
      const outS = srcS / rate;
      // Net of the pause borrowed for the seams: that much is *supposed* to be
      // silence, so counting it would have the tool advising you to cut a
      // section over padding it added itself.
      const padS = Math.max(0, outS - dubS - borrowedS / rate);
      const pct = Math.abs(rate - 1) * 100;
      const pictureNote = pct >= 0.5
        ? ` Picture ${rate > 1 ? 'runs' : 'eases'} ${pct.toFixed(0)}% ${rate > 1 ? 'faster' : 'slower'} here.`
        : '';
      const squeezeNote = plan.squeeze > 1.01
        ? ` Speech squeezed ${((plan.squeeze - 1) * 100).toFixed(0)}% to finish fitting.` : '';
      // Past the speed bound there can still be real dead air. Say so, rather
      // than producing it quietly — the answer there is Cut, not respeak.
      const tail = padS > fitOpts().deadAirS + 0.25
        ? ` ${padS.toFixed(1)} s of it is still pause — consider cutting this section instead.` : '';
      if (!quiet) {
        status(`Respoken — ${outS.toFixed(1)} s where the original took ${srcS.toFixed(1)} s.`
          + pictureNote + squeezeNote + tail);
      }
      save();
      if (onChanged) onChanged();
      return rec;
    } finally {
      setProgress(null, els.voiceProgress);
    }
  }

  // ---- the queue ----------------------------------------------------------
  // Generating a line takes seconds, and clicking respeak on the next one
  // while the first is running is the obvious thing to do. Rejecting that
  // ("already respeaking a line") looked exactly like a frozen page: the
  // button went dead and nothing happened. So clicks queue instead, one
  // generation at a time — the model is single-threaded anyway, so running
  // two at once would only make both slower.
  const jobs = [];          // cues waiting their turn
  let running = null;       // the cue being respoken right now
  let pumping = false;

  /** 'running', 'queued', or null — what the list shows on each row. */
  function jobState(cue) {
    if (cue && running === cue) return 'running';
    return jobs.some((j) => j.cue === cue) ? 'queued' : null;
  }
  function queued() { return jobs.length + (running ? 1 : 0); }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (jobs.length) {
        const job = jobs.shift();
        running = job.cue;
        if (onChanged) onChanged();
        try { job.resolve(await doRespeak(job.cue, job.opts)); }
        catch (e) { job.reject(e); }
        running = null;
      }
    } finally {
      pumping = false;
      running = null;
      if (onChanged) onChanged();
    }
  }

  /** Respeak a line. Returns when *this* line is done; others may be queued. */
  function respeak(cue, opts = {}) {
    if (jobState(cue)) return Promise.resolve(null);   // already on its way
    return new Promise((resolve, reject) => {
      jobs.push({ cue, opts, resolve, reject });
      if (onChanged) onChanged();
      pump();
    });
  }

  /**
   * Respeak the whole script.
   *
   * Worth having for its own sake — you can rewrite the transcript and have the
   * narration delivered again from end to end — but it also sidesteps the
   * hardest problem in here. Every splice is a join between generated speech
   * and a real recording, and those two never match perfectly. Respeak
   * everything and there are no such joins left: the only seams are generated
   * to generated, over one continuous bed of the room's own tone, and the
   * whole track is consistent because one voice made all of it.
   *
   * Timing survives because each line is still dubbed into *its own* span, at
   * its own timestamp, under the same dead-air rules. The narration is
   * rebuilt; the screen recording is not touched.
   */
  async function respeakAll(cues, { onProgress = null } = {}) {
    const list = (cues || []).filter((c) => c && String(c.text || '').trim() && !c.dub);
    if (!list.length) throw new Error('Nothing left to respeak — every line already has been.');
    await ensureCloned();

    // Everything goes through the one queue, so a line clicked by hand while
    // the batch runs simply takes its place in the same line rather than
    // fighting it.
    const total = list.length;
    let done = 0, failed = 0;
    const each = list.map((cue) => respeak(cue, { quiet: true }).then(
      () => { done++; },
      () => { done++; failed++; },
    ).then(() => {
      status(`Respeaking the script — ${done} of ${total}${failed ? ` (${failed} failed)` : ''}…`);
      setProgress(done / total, els.voiceProgress);
      if (onProgress) onProgress(done, total);
    }));

    await Promise.all(each);
    setProgress(null, els.voiceProgress);
    status(`Respoke ${done - failed} of ${total} lines${failed ? `, ${failed} failed` : ''}.`);
    if (onChanged) onChanged();
  }

  /** Drop everything still waiting. The line in flight finishes. */
  function cancelRespeakAll() {
    const dropped = jobs.splice(0, jobs.length);
    for (const j of dropped) j.reject(new Error('cancelled'));
    status(dropped.length ? `Cancelled ${dropped.length} queued line${dropped.length > 1 ? 's' : ''}.` : '');
    if (onChanged) onChanged();
  }

  /**
   * Re-apply the dead-air settings to lines that were already respoken.
   * Nothing is regenerated — the samples are unchanged and only the span's
   * rate moves — but without this, changing the threshold would appear to do
   * nothing until the next respeak, which is the kind of setting nobody
   * trusts again afterwards.
   */
  function replanAll() {
    const list = [...dubs().values()];
    if (!list.length) return;
    const opts = fitOpts();
    let moved = 0;
    for (const rec of list) {
      const plan = planFit(rec.srcS, rec.dubS, { ...opts, borrowedS: rec.borrowedS || 0 });
      const rate = plan.mode === 'natural' ? plan.rate : 1;
      if (Math.abs(rate - (rec.rate ?? 1)) < 1e-6) continue;
      rec.rate = rate;
      rec.mode = plan.mode;
      ctx.edits.applyDub(rec.start, rec.end, rate, rec.id);
      moved++;
    }
    if (moved) {
      finished.clear(); previewBufs.clear();
      save();
      if (onChanged) onChanged();
      status(`Re-timed ${moved} respoken line${moved > 1 ? 's' : ''}.`);
    }
  }

  /** Drop a respoken line, putting the original audio back. */
  function revert(cue) {
    if (!cue || !cue.dub) return;
    const rec = dubs().get(cue.dub);
    dubs().delete(cue.dub);
    finished.clear(); previewBufs.clear();
    if (rec) ctx.edits.clearDub(rec.start, rec.end);
    cue.dub = null;
    save();
    if (onChanged) onChanged();
  }

  // ---- what the encoder asks for -----------------------------------------
  // Called once per respoken span while exporting. The generation is stored at
  // the model's 24 kHz mono; this is where it becomes exactly `frames` of
  // interleaved audio at the video's rate, level-matched and faded.

  const resampleMono = (a, from, to) => {
    if (from === to) return a;
    const r = createResampler(from, to);
    return r.push(a).slice();
  };

  // The recording's room tone, at whatever rate is being asked for. Cached,
  // because resampling a couple of seconds on every span would be silly.
  const toneCache = new Map();
  function roomToneAt(sampleRate) {
    const state = getState();
    const src = state && state.audioAnalysis && state.audioAnalysis.roomTone;
    if (!src || !src.length) return null;
    const key = String(sampleRate);
    if (toneCache.has(key)) return toneCache.get(key);
    const at = resampleMono(src, state.audio.audio.sample_rate, sampleRate);
    toneCache.set(key, at);
    return at;
  }

  /**
   * The samples the encoder (or the preview) should emit for a respoken span.
   * `toneReference` is the recording of the line being replaced, when the
   * caller has it — the export does, and it is the best possible reference for
   * matching the generation's tonal balance.
   */
  function pcmFor(id, { sampleRate, channels, frames, toneReference = null }) {
    const rec = dubs().get(id);
    if (!rec || !rec.pcm || !rec.pcm.length) return null;
    // The span's head is borrowed pause (snapSpan), and the whole span plays
    // at `rate`, so it occupies `leadS / rate` seconds of the output.
    const leadSamples = Math.round(((rec.leadS || 0) / (rec.rate || 1)) * sampleRate);
    const key = `${id}|${sampleRate}|${channels}|${frames}|${leadSamples}|${toneReference ? toneReference.length : 0}`;
    if (finished.has(key)) return finished.get(key);

    const out = finishDub(rec.pcm, {
      modelRate: rec.sampleRate, outRate: sampleRate, channels, targetSamples: frames,
      targetDbfs: rec.targetDbfs ?? targetDbfs(),
      roomTone: roomToneAt(sampleRate),
      toneReference: toneReference ? toMono(toneReference, channels) : null,
      resample: resampleMono, leadSamples,
    });
    finished.set(key, out.pcm);
    return out.pcm;
  }

  /** Every respoken line, for the export summary. */
  function count() { return dubs().size; }

  // ---- hearing it before exporting ---------------------------------------
  // The preview is a <video> playing the original file, so a respoken line is
  // not in it. `previewBuffer` renders the same samples the encoder will get —
  // through the same finishDub, at the same length — as an AudioBuffer, and
  // compressor.js plays it over the muted original while the playhead is
  // inside that span. What you hear before exporting is what gets exported.
  const previewBufs = new Map();

  function previewBuffer(id, { sampleRate, frames }, ctx) {
    const key = `${id}|${sampleRate}|${frames}`;
    if (previewBufs.has(key)) return previewBufs.get(key);
    const pcm = pcmFor(id, { sampleRate, channels: 1, frames });
    if (!pcm) return null;
    const buf = ctx.createBuffer(1, pcm.length, sampleRate);
    buf.copyToChannel(pcm, 0);
    previewBufs.set(key, buf);
    return buf;
  }

  /** 'respoken' (hear your edits) or 'original' (hear the recording). */
  function previewTrack() {
    return els.inVoiceTrack ? els.inVoiceTrack.value : 'respoken';
  }

  /** Is there anything respoken to listen to? */
  function hasDubs() { return dubs().size > 0; }

  // ---- persistence --------------------------------------------------------
  // Intent only: the samples are regenerated from the same text and seed.
  function save() {
    const state = getState();
    if (!state) return;
    try {
      const list = [...dubs().values()].map(({ pcm, ...rest }) => rest);
      if (!list.length) { localStorage.removeItem(LS_DUB_KEY); return; }
      const f = state.file;
      localStorage.setItem(LS_DUB_KEY, JSON.stringify({
        v: 1, file: { name: f.name, size: f.size, lastModified: f.lastModified },
        lang: els.inVoiceLang.value, reference, dubs: list,
      }));
    } catch (_) {}
  }

  function restore(file) {
    try {
      const d = JSON.parse(localStorage.getItem(LS_DUB_KEY) || 'null');
      if (!d || !d.file || d.file.name !== file.name || d.file.size !== file.size
          || d.file.lastModified !== file.lastModified) return null;
      return d;
    } catch (_) { return null; }
  }

  /** Re-make every restored line's audio, in order. */
  async function regenerateAll(list, onEach) {
    for (const rec of list) {
      if (!rec || !rec.text) continue;
      await ensureCloned();
      const res = await ask({ type: 'speak', text: rec.text, temperature: 0.7, seed: rec.seed },
        'audio', (m) => { if (m.type === 'status') status(m.text); });
      dubs().set(rec.id, { ...rec, pcm: res.pcm, sampleRate: res.sampleRate });
      finished.clear(); previewBufs.clear();
      if (onEach) onEach(rec);
    }
  }

  // ---- settings -----------------------------------------------------------
  function settings() {
    return {
      voiceLang: els.inVoiceLang.value,
      voiceTrack: els.inVoiceTrack ? els.inVoiceTrack.value : 'respoken',
      voiceTrim: els.inVoiceTrim ? els.inVoiceTrim.checked : true,
      voiceDeadAir: els.inVoiceDeadAir ? els.inVoiceDeadAir.value : '0.15',
      voiceStretch: els.inVoiceStretch ? els.inVoiceStretch.value : '50',
    };
  }
  function applySettings(g) {
    if (!g) return;
    if (g.voiceLang && VOICE_LANGS[g.voiceLang]) els.inVoiceLang.value = g.voiceLang;
    if (els.inVoiceTrack && g.voiceTrack) els.inVoiceTrack.value = g.voiceTrack;
    if (els.inVoiceTrim && g.voiceTrim != null) els.inVoiceTrim.checked = !!g.voiceTrim;
    if (els.inVoiceDeadAir && g.voiceDeadAir != null) els.inVoiceDeadAir.value = g.voiceDeadAir;
    if (els.inVoiceStretch && g.voiceStretch != null) els.inVoiceStretch.value = g.voiceStretch;
  }

  function wire() {
    if (els.inVoiceLang) {
      for (const [value, label] of Object.entries(VOICE_LANGS)) {
        const o = document.createElement('option');
        o.value = value; o.textContent = label;
        els.inVoiceLang.appendChild(o);
      }
      els.inVoiceLang.value = 'english_2026-04';
      els.inVoiceLang.addEventListener('change', () => {
        loaded = false; clonedFor = null;       // a different language is a different model
        refreshCachedLabel();
      });
    }
    for (const el of [els.inVoiceTrim, els.inVoiceDeadAir, els.inVoiceStretch]) {
      if (!el) continue;
      // Both re-time every line already respoken, so the setting is something
      // you can turn and hear rather than a promise about the next generation.
      el.addEventListener('change', replanAll);
    }
    if (els.inVoiceTrack) {
      els.inVoiceTrack.addEventListener('change', () => {
        // The running dub (if any) is dropped by the preview loop on the next
        // frame; nudging onChanged keeps the rest of the UI honest.
        if (onChanged) onChanged();
      });
    }
    if (els.btnVoiceAll) {
      els.btnVoiceAll.addEventListener('click', async () => {
        const state = getState();
        const cues = state && state.captions && state.captions.cues;
        els.btnVoiceAll.disabled = true;
        if (els.btnVoiceAllCancel) els.btnVoiceAllCancel.hidden = false;
        try { await respeakAll(cues, { onProgress: () => {} }); }
        catch (e) { status(e.message); }
        finally {
          els.btnVoiceAll.disabled = false;
          if (els.btnVoiceAllCancel) els.btnVoiceAllCancel.hidden = true;
        }
      });
    }
    if (els.btnVoiceAllCancel) {
      els.btnVoiceAllCancel.addEventListener('click', cancelRespeakAll);
    }
    // Keep the Stop button in step with the queue however it was filled —
    // the batch button, or a handful of clicks down the transcript.
    els.__voiceQueueTick = setInterval(() => {
      if (!els.btnVoiceAllCancel) return;
      const busyNow = queued() > 0;
      if (els.btnVoiceAllCancel.hidden === busyNow) els.btnVoiceAllCancel.hidden = !busyNow;
    }, 300);
    if (els.btnVoiceRef) {
      els.btnVoiceRef.addEventListener('click', async () => {
        const list = candidates();
        if (!list.length) { status('Generate a transcript first.'); return; }
        refRank = (refRank + 1) % list.length;
        reference = list[refRank];
        clonedFor = null;
        renderReference();
        status('Reference changed — the next line you respeak will use it.');
      });
    }
    refreshCachedLabel();
  }

  /** Called when a new file is loaded. */
  function reset(file) {
    reference = null; clonedFor = null; refRank = 0; referenceDbfs = null;
    finished.clear(); previewBufs.clear(); toneCache.clear();
    return file ? restore(file) : null;
  }

  return {
    wire, settings, applySettings, reset, restore, regenerateAll,
    respeak, respeakAll, cancelRespeakAll, jobState, queued,
    revert, replanAll, pcmFor, count, save,
    previewBuffer, previewTrack, hasDubs,
    isChanged, changedLines,
    reference: () => reference,
    setStatus: status,
    ready: () => loaded,
  };
}
