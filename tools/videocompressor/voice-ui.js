// Overdub, the interactive half: the voice model's download, the reference
// clip taken out of your own recording, and the respoken narration itself.
//
// voice.js holds the pure logic (splitting a script, aligning it back onto the
// recording, re-timing the picture to it); voice-worker.js runs the model;
// this module joins them to the page, the way captions-ui.js does for Whisper.
// compressor.js hands it everything it needs through `ctx` and asks it for one
// thing back: `pcmFor(id, …)`, the samples the encoder should emit for a
// respoken span.
//
// The whole script, in one take
// -----------------------------
// There is exactly one narration. It is generated in order, sentence after
// sentence, and everything measured about it — its tonal balance, its level,
// the room laid under it — is measured once, over all of it. The export then
// asks for slices of that one buffer, so a "span" here is a window onto
// continuous audio rather than an independent little generation. That is why
// the seams cannot be heard: there are no seams.
//
// What is kept where, and why:
//
//   state.script    { text, seed, parts, pcm, … }        (in memory)
//   state.dubs      id -> { scriptId, atS }              (in memory)
//   state.edits     the re-timed picture, each span carrying a dub id
//   localStorage    the script text and the settings, nothing else
//
// The audio is deliberately not persisted. A few minutes of narration is tens
// of MB of float samples and localStorage is a ~5 MB budget shared with the
// captions. The edits and the captions *are* persisted by compressor.js, so a
// reload comes back to the right timeline with the right words on screen and
// one button to re-make the audio from the same script and the same seed.
import {
  pickReference, splitScript, scriptFromCues, alignScript, planTimeline,
  narrationWords, finishNarration, layRoomTone, toInterleaved,
} from './voice.js';
import { createResampler, wordsToCues } from './captions.js';
import { analyzeVoiceLevel } from './audio-boost.js';
import {
  LocalVoice, probeLocalVoice, listLocalProfiles, importLocalProfile, exportLocalProfile, START_HINT,
} from './voice-local.js';

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
const LS_SCRIPT_KEY = 'videocompressor:script:v1';
// How far under the voice the presence track sits when the recording is being
// replaced. 40 dB is the room of a quiet office rather than the room of the
// office you actually recorded in: continuous, so no pause reads as the track
// cutting out, and far enough down that nobody would call it background noise.
// The one number of taste in the whole replacement path.
const BED_DB = -40;

// ctx: { els, getState, timeline, edits, captions, audio, fmt, setProgress, onChanged }
export function createVoice(ctx) {
  const { els, getState, timeline, audio: audioApi, fmt, setProgress, onChanged } = ctx;

  let worker = null;
  let loaded = false;          // models open in the worker
  let clonedFor = null;        // the reference span the worker currently holds
  let reference = null;        // { start, end, text, density }
  let refAudio = null;         // { model: 24 kHz mono, native, rate }
  let refRank = 0;             // which candidate is in use, for "try another"
  let referenceDbfs = null;    // the reference clip's voice level, as a fallback target
  let seq = 0;
  let running = false;         // a generation is in flight
  let scriptEdited = false;    // the script has been written, not just filled in
  const finishedCache = new Map();   // sampleRate -> the whole narration, mono
  const bedCache = new Map();        // sampleRate -> the presence laid under it, if any
  const toneCache = new Map();       // sampleRate -> room tone
  const refToneCache = new Map();    // sampleRate -> the reference clip
  const previewBufs = new Map();

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

  // Which voice speaks: the in-browser clone of this recording, or the voice
  // profile served from this machine (voice-local.js). Switching engines
  // drops the old one; the next respeak loads the new one.
  function engine() { return els.inVoiceEngine && els.inVoiceEngine.value === 'local' ? 'local' : 'browser'; }

  function dropWorker() {
    if (worker) { try { worker.terminate(); } catch (_) {} }
    worker = null; loaded = false; clonedFor = null;
  }

  async function refreshEngineHint() {
    const hint = els.hintVoiceEngine;
    const local = engine() === 'local';
    if (els.inVoiceLang) els.inVoiceLang.disabled = local;
    if (els.voiceProfileRow) els.voiceProfileRow.hidden = !local;
    if (!hint) return;
    if (!local) {
      hint.textContent = 'Cloned from ~10 s of this recording, in the browser. Nothing to set up.';
      return;
    }
    hint.textContent = 'Looking for your voice server…';
    const h = await probeLocalVoice();
    if (engine() !== 'local') return;
    if (!h) {
      hint.textContent = `No voice server found on this machine. ${START_HINT}`;
      fillProfiles([]);
      return;
    }
    let list = [];
    try { list = await listLocalProfiles(); } catch (_) {}
    fillProfiles(list, h.profile && h.profile.name);
    hint.textContent = list.length
      ? `Your voice server is running; ${h.profile ? `“${h.profile.name}” was the last voice used on this machine. ` : ''}Pauses come from your own measured ones, so the pause setting below is only a fallback.`
      : 'Your voice server is running but has no voice yet: load the .voice.zip you made in Voice Studio.';
  }

  // The profiles the server has, as a select; the choice rides along with
  // every speak request, so two people's voices can live on one machine.
  let wantProfile = null;      // from saved settings, applied once the list arrives
  function fillProfiles(list, active) {
    const sel = els.inVoiceProfile;
    if (!sel) return;
    const keep = sel.value || wantProfile || active;
    sel.innerHTML = '';
    for (const p of list) {
      const o = document.createElement('option');
      o.value = p.name;
      o.textContent = p.error ? `${p.name} (unusable: ${p.error})` : p.name;
      o.disabled = !!p.error;
      sel.appendChild(o);
    }
    if (!list.length) {
      const o = document.createElement('option');
      o.value = ''; o.textContent = 'No voice profiles yet';
      sel.appendChild(o);
    }
    if (keep && list.some((p) => p.name === keep && !p.error)) sel.value = keep;
    if (worker instanceof LocalVoice) worker.profile = sel.value || null;
  }

  // Save the chosen voice as a .voice.zip — a copy to keep, or to take to
  // another machine, for anyone who no longer has the file they made.
  async function downloadProfile() {
    const name = els.inVoiceProfile && els.inVoiceProfile.value;
    const hint = els.hintVoiceEngine;
    if (!name) { if (hint) hint.textContent = 'No voice profile to download yet.'; return; }
    try {
      if (hint) hint.textContent = `Packing “${name}”…`;
      const blob = await exportLocalProfile(name);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${name}.voice.zip`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      if (hint) hint.textContent = `Saved ${name}.voice.zip (${(blob.size / 1e6).toFixed(0)} MB). Keep it like a password: it is the whole voice.`;
    } catch (e) {
      if (hint) hint.textContent = `Could not download “${name}”: ${e.message}`;
    }
  }

  async function importProfileFile(file) {
    if (!file) return;
    const hint = els.hintVoiceEngine;
    try {
      if (hint) hint.textContent = `Checking and installing ${file.name}…`;
      let name;
      try {
        name = await importLocalProfile(file);
      } catch (e) {
        if (!e.exists || !confirm(`${e.message}. Replace it with ${file.name}?`)) throw e;
        name = await importLocalProfile(file, { replace: true });
      }
      wantProfile = name;
      if (els.inVoiceProfile) els.inVoiceProfile.value = '';
      await refreshEngineHint();
      if (els.inVoiceProfile) els.inVoiceProfile.value = name;
      if (worker instanceof LocalVoice) worker.profile = name;
      if (hint) hint.textContent = `Installed “${name}”. Respeak to hear it.`;
      if (onChanged) onChanged();
    } catch (e) {
      if (hint) hint.textContent = `Could not load ${file.name}: ${e.message}`;
    } finally {
      if (els.inVoiceProfileFile) els.inVoiceProfileFile.value = '';
    }
  }

  function ensureWorker() {
    if (worker) return worker;
    if (engine() === 'local') {
      worker = new LocalVoice(undefined, (els.inVoiceProfile && els.inVoiceProfile.value) || null);
      return worker;
    }
    // Import maps do not reach `new Worker`, so carry this module's own
    // ?v=<commit> across by hand: without it a release could pair a freshly
    // fetched voice-ui.js with a cached voice-worker.js.
    const workerUrl = new URL('./voice-worker.js', import.meta.url);
    workerUrl.search = new URL(import.meta.url).search;
    worker = new Worker(workerUrl, { type: 'module' });
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

  function status(text) { if (els.voiceStatus) els.voiceStatus.textContent = text || ''; }

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

  /**
   * Decode the reference span out of the source file.
   *
   * Two copies come back. The model wants 24 kHz, which is all it can hear.
   * Tonal matching wants the recording at its own rate: the point of it is to
   * put back what the model is missing, and resampling the reference down to
   * 24 kHz first would throw away exactly the top octave being matched.
   */
  async function readReference(ref) {
    const state = getState();
    const chunks = [];      // native rate
    let srcRate = 0;
    status('Reading the reference clip…');
    await audioApi.decodeAudioTrack(state, (frame) => {
      const t = frame.timestamp / 1e6;
      const dur = frame.numberOfFrames / frame.sampleRate;
      if (t + dur < ref.start || t > ref.end) return;
      srcRate = frame.sampleRate;
      const mono = audioApi.mixToMono(frame);
      // Trim the frame to the part inside the span, so the clip starts and
      // ends where it was asked to.
      const from = Math.max(0, Math.round((ref.start - t) * frame.sampleRate));
      const to = Math.min(mono.length, Math.round((ref.end - t) * frame.sampleRate));
      if (to > from) chunks.push(mono.slice(from, to));
    }, { untilS: ref.end + 0.5 });
    const native = audioApi.concatFloat32(chunks);
    return { native, rate: srcRate || MODEL_SR, model: resampleMono(native, srcRate || MODEL_SR, MODEL_SR) };
  }

  async function ensureCloned() {
    await ensureLoaded();
    if (!reference) {
      const list = candidates();
      if (!list.length) {
        throw new Error('No transcript yet — generate one above first, so the tool can find clean speech to clone from.');
      }
      reference = list[Math.min(refRank, list.length - 1)];
    }
    const key = `${reference.start.toFixed(3)}-${reference.end.toFixed(3)}`;
    if (clonedFor === key) return;
    refToneCache.clear();
    refAudio = await readReference(reference);
    if (refAudio.model.length < REF_MIN_S * MODEL_SR * 0.8) {
      throw new Error('The reference clip came back too short to clone from.');
    }
    // How loud this speaker actually is, measured before the audio is handed
    // over — the narration has to come back at this level, not the model's.
    try {
      const a = analyzeVoiceLevel(refAudio.model, MODEL_SR);
      if (Number.isFinite(a.voiceDbfs) && a.voiceDbfs > -80) referenceDbfs = a.voiceDbfs;
    } catch (_) { referenceDbfs = null; }
    const audio = refAudio.model.slice();
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

  // ---- the script ---------------------------------------------------------
  // The transcript is the first draft. It is dropped into a textarea as prose
  // — paragraphs where the recording paused — and whatever comes back out is
  // what gets spoken. Nothing here tries to be clever about *which* lines
  // changed: the whole thing is respoken either way, and the alignment is what
  // works out where the new words belong.

  function scriptText() { return els.scriptText ? els.scriptText.value : ''; }

  /**
   * Drop the transcript into the script box, as prose.
   *
   * It follows the transcript until somebody types in it, which is what makes
   * fixing a scientific word in the line list worth doing: the correction is
   * in the script too, and gets spoken. After the first keystroke here the
   * script is the user's, and only the button overwrites it.
   */
  function fillScriptFromTranscript({ force = false } = {}) {
    const state = getState();
    const cues = state && state.captions && state.captions.cues;
    if (!els.scriptText || !cues || !cues.length) return;
    if (!force && scriptEdited) return;
    const next = scriptFromCues(cues);
    if (next === els.scriptText.value) return;
    els.scriptText.value = next;
    scriptEdited = false;
    renderScriptInfo();
    saveScript();
  }

  function renderScriptInfo() {
    if (!els.scriptInfo) return;
    const parts = splitScript(scriptText(), pauseOpts());
    const words = scriptText().trim().split(/\s+/).filter(Boolean).length;
    els.scriptInfo.textContent = words
      ? `${words} word${words > 1 ? 's' : ''} · ${parts.length} sentence${parts.length > 1 ? 's' : ''}`
      : '';
  }

  // How long the pauses between sentences are. One number, because "how long
  // is a beat" is a matter of taste; a paragraph break gets a bit more than
  // twice it, and a clause break rather less.
  function pauseOpts() {
    const raw = els.inVoicePause ? parseFloat(els.inVoicePause.value) : 0.36;
    const s = Number.isFinite(raw) ? Math.max(0, Math.min(2, raw)) : 0.36;
    return { sentencePauseS: s, paragraphPauseS: s * 2.2, clausePauseS: s * 0.56 };
  }

  // What a pause *is*, for an engine that has its own idea of how long each
  // kind should be (the local voice draws them from the speaker's own).
  function pauseKind(s) {
    const o = pauseOpts();
    if (!(s > 0)) return 'end';
    if (s >= o.paragraphPauseS - 1e-6) return 'paragraph';
    if (s <= o.clausePauseS + 1e-6) return 'clause';
    return 'sentence';
  }

  // How far the picture may drift from real time, in either direction, to keep
  // up with what is now being said.
  function rateBand() {
    const pct = els.inVoiceStretch ? parseFloat(els.inVoiceStretch.value) : 50;
    const span = Number.isFinite(pct) ? Math.max(0, Math.min(200, pct)) / 100 : 0.5;
    return { maxRate: 1 + span, minRate: 1 / (1 + span) };
  }

  // The level the narration has to land at. The whole-track voice-band
  // measurement is the best answer when it exists — it is the same number the
  // auto-boost works from. The reference clip is the fallback, since it is the
  // same speaker on the same microphone.
  function targetDbfs() {
    const state = getState();
    const a = state && state.audioAnalysis;
    if (a && Number.isFinite(a.voiceDbfs) && a.voiceDbfs > -80) return a.voiceDbfs;
    return referenceDbfs;
  }

  /**
   * Whether the respoken narration *replaces* the recording's audio outright.
   *
   * Two things follow from it, and they are the two places the recording
   * otherwise survives a full respeak.
   *
   * The first is the room tone. `layRoomTone` mixes the recording's own quiet
   * under the whole narration, which is the right answer when a respoken line
   * has to sit *inside* a recording — the background never stops, so the ear
   * never finds the seam. When the entire narration is respoken there is no
   * recording left to blend into and nothing to hide, and all the room tone
   * does then is put the room's noise back: the fan, the street, the hum that
   * made the take sound amateur in the first place. So this turns it off and
   * lets `fillWithRoomTone` rebuild the pauses out of the *generated* audio,
   * which is quiet, consistent, and not the room.
   *
   * The second is the seconds the narration does not cover. Those play the
   * recording at rate 1 (see `editSpans`), which is how a stray millisecond at
   * a section boundary, or footage the trim was widened onto after respeaking,
   * brings the old voice back in flashes. In this mode the export and the
   * preview run them silent instead — see `replacesAudio()`'s callers in
   * compressor.js.
   */
  function replacesAudio() {
    return els.inVoiceBed ? els.inVoiceBed.value !== 'room' : true;
  }

  function dubs() {
    const state = getState();
    if (!state.dubs) state.dubs = new Map();
    return state.dubs;
  }

  // ---- respeaking the script ----------------------------------------------

  /**
   * Speak the whole script, re-time the picture to it, and re-caption it.
   *
   * The order matters and is not obvious. The alignment (where each sentence
   * *was* said) is worked out before a word is spoken, because it needs only
   * the transcript. The generation then says how long each sentence *is*.
   * Only with both in hand can the picture be re-timed — and only once the
   * picture has been re-timed does "output time" mean anything, which is what
   * the captions are then expressed in.
   */
  async function respeakScript() {
    const state = getState();
    if (!state) return null;
    const text = scriptText().trim();
    if (!text) throw new Error('Write a script first — “Use the transcript” fills it in from what you said.');

    const words = (state.captions && state.captions.words) || [];
    if (!words.length) throw new Error('Generate a transcript first: the alignment needs to know when you said what.');

    running = true;
    if (onChanged) onChanged();
    try {
      await ensureCloned();

      // Start from the timeline as the user left it, not as the last respeak
      // left it. A previous plan's cuts are part of the kept timeline, so
      // measuring against them would align this script to a video that only
      // exists because of the last one.
      revertScript({ quiet: true });

      // The plan is made on the *kept* timeline — the trim minus the sections
      // already cut — because that is what the viewer sees and what the
      // narration has to match.
      const kept = timeline.keptSegments();
      const keptS = timeline.keptTotal();
      if (!(keptS > 0.5)) throw new Error('Nothing is left to respeak — the selection is empty.');
      const keptWords = words
        .filter((w) => kept.some((seg) => w.start >= seg.start - 1e-3 && w.end <= seg.end + 1e-3))
        .map((w) => ({ text: w.text, start: timeline.sourceToKept(w.start), end: timeline.sourceToKept(w.end) }));

      const parts = alignScript(splitScript(text, pauseOpts()), keptWords, { startS: 0, endS: keptS });

      status(`Respeaking ${parts.length} sentence${parts.length > 1 ? 's' : ''}…`);
      const seed = (Math.random() * 1e9) | 0;
      const res = await ask({
        type: 'speak', temperature: 0.7, seed,
        parts: parts.map((p) => ({ text: p.text, pauseAfterS: p.pauseAfterS, kind: pauseKind(p.pauseAfterS) })),
      }, 'audio', (m) => {
        if (m.type === 'status') status(m.text);
        else if (m.type === 'progress' && m.estimate) setProgress(m.frames / m.estimate, els.voiceProgress);
      });
      setProgress(null, els.voiceProgress);
      if (!res.pcm || !res.pcm.length) throw new Error('The model produced no audio.');
      if (!res.parts || res.parts.length !== parts.length) {
        throw new Error(`The model spoke ${res.parts ? res.parts.length : 0} of ${parts.length} sentences.`);
      }

      // The silence the recording had before the first word and after the
      // last is kept as it was: the picture there plays at normal speed with
      // nothing said over it, which is what a lead-in is.
      const spoken = res.parts || [];
      const leadS = spoken.length ? Math.max(0, parts[0].srcStart) : 0;
      const tailS = spoken.length ? Math.max(0, keptS - parts[parts.length - 1].srcEnd) : 0;
      const narrationS = leadS + res.pcm.length / res.sampleRate + tailS;
      parts.forEach((p, i) => {
        const s = spoken[i];
        p.outStart = leadS + (s ? s.start : 0);
        p.outEnd = leadS + (s ? s.end : 0);
      });

      const pcm = new Float32Array(Math.round(narrationS * res.sampleRate));
      pcm.set(res.pcm, Math.round(leadS * res.sampleRate));

      // Everywhere the narration is silent by construction — the lead-in, the
      // gaps between sentences, the tail. voice.js needs these to know where
      // to put the room back if the recording never gave it a clean sample.
      const pauses = [];
      let at = 0;
      for (const p of parts) {
        if (p.outStart > at + 1e-3) pauses.push({ from: at, to: p.outStart });
        at = Math.max(at, p.outEnd);
      }
      if (narrationS > at + 1e-3) pauses.push({ from: at, to: narrationS });

      const { maxRate, minRate } = rateBand();
      const plan = planTimeline(parts, { keptS, narrationS, minRate, maxRate });

      const id = `s${Date.now().toString(36)}`;
      state.script = {
        id, text, seed, parts, pcm, sampleRate: res.sampleRate,
        keptS, narrationS, leadS, tailS, pauses, targetDbfs: targetDbfs(),
        stats: plan.stats,
      };
      finishedCache.clear();
      bedCache.clear();
      previewBufs.clear();

      applyPlan(plan);
      retitleCaptions(parts);
      saveScript();
      status(planNote(plan.stats, keptS, narrationS));
      renderPlan();
      if (onChanged) onChanged();
      return state.script;
    } finally {
      running = false;
      setProgress(null, els.voiceProgress);
      if (onChanged) onChanged();
    }
  }

  /**
   * Turn the plan into edits, one respoken span at a time.
   *
   * A planned section is a stretch of the kept timeline, which may straddle a
   * section the user cut out earlier — so it lands as one or more source
   * spans. Each gets its own slice of the narration, taken by *output*
   * position rather than by its own length, so the slices stay exactly
   * contiguous however the frame counts round.
   */
  function applyPlan(plan) {
    const state = getState();
    dubs().clear();
    const edits = [];
    for (const c of plan.cuts) {
      for (const r of timeline.keptRangeToSource(c.start, c.end)) {
        edits.push({ start: r.start, end: r.end, rate: 0, audio: 'mute', src: 'respeak' });
      }
    }
    for (const sp of plan.spans) {
      let out = sp.outStart;
      for (const r of timeline.keptRangeToSource(sp.srcStart, sp.srcEnd)) {
        const id = `d${dubs().size.toString(36)}`;
        dubs().set(id, { id, scriptId: state.script ? state.script.id : null, atS: out });
        edits.push({ start: r.start, end: r.end, rate: sp.rate, audio: 'keep', dub: id, src: 'respeak' });
        out += (r.end - r.start) / sp.rate;
      }
    }
    ctx.edits.replaceRespeak(edits);
  }

  /** Captions for what is now being said, in source time. */
  function retitleCaptions(parts) {
    const state = getState();
    const caps = state.captions;
    if (!caps) return;
    // Only the cues are replaced — the word timings still describe the
    // recording, which is what the reference clip and the breath detector
    // read them for — so only the cues need keeping for the way back.
    if (!caps.beforeRespeak) caps.beforeRespeak = { cues: caps.cues };
    const cues = wordsToCues(narrationWords(parts)).map((c) => ({
      // The plan was built so that output time *is* narration time, so the
      // inverse map is all it takes to put a cue back on the source timeline —
      // which is the only timeline cues are ever stored in.
      start: timeline.fromOutputTime(c.start),
      end: timeline.fromOutputTime(c.end),
      text: c.text,
    }));
    caps.cues = cues;
    ctx.captionsChanged();
  }

  function planNote(st, keptS, narrationS) {
    const bits = [`Respoke the script in ${fmt.fmtTime(narrationS)}, where the recording took ${fmt.fmtTime(keptS)}`];
    bits.push(`${st.sections} section${st.sections > 1 ? 's' : ''} of picture re-timed`
      + ` (${st.slowest.toFixed(2)}×–${st.fastest.toFixed(2)}×)`);
    if (st.cutS > 0.05) bits.push(`${st.cutS.toFixed(1)} s cut where the script no longer covers the footage`);
    if (st.tooSlow) {
      bits.push(`${st.tooSlow} section${st.tooSlow > 1 ? 's run' : ' runs'} slower than you allowed`
        + ' — there is more to say there than there is footage to show');
    }
    return bits.join('. ') + '.';
  }

  function renderPlan() {
    if (!els.voicePlan) return;
    const state = getState();
    const sc = state && state.script;
    if (!sc) { els.voicePlan.textContent = ''; return; }
    els.voicePlan.textContent =
      `Narration: ${fmt.fmtTime(sc.narrationS)} · ${sc.parts.length} sentences · `
      + `${sc.parts.filter((p) => p.anchored).length} aligned to the recording by their own words.`;
  }

  /**
   * Re-time the picture to narration that has already been spoken.
   *
   * `Video may stretch` only decides how the picture moves, which means it can
   * be turned and heard rather than being a promise about the next
   * generation — the audio is untouched and only the spans' rates and the
   * plan's cuts change. `Pause between sentences` is not like this: it is
   * baked into the samples, so it needs a new take.
   */
  function replan() {
    const state = getState();
    const sc = state && state.script;
    if (!sc || running) return;
    // Measure against the user's timeline, not the one the last plan left.
    ctx.edits.replaceRespeak([]);
    const { maxRate, minRate } = rateBand();
    const plan = planTimeline(sc.parts, {
      keptS: sc.keptS, narrationS: sc.narrationS, minRate, maxRate,
    });
    sc.stats = plan.stats;
    previewBufs.clear();
    applyPlan(plan);
    retitleCaptions(sc.parts);
    saveScript();
    status(planNote(plan.stats, sc.keptS, sc.narrationS));
    renderPlan();
    if (onChanged) onChanged();
  }

  /** Stop a generation in flight. */
  function cancel() {
    if (!worker) return;
    worker.postMessage({ type: 'cancel' });
    status('Cancelled.');
  }

  /** Drop the respoken narration and put the recording back. */
  function revertScript({ quiet = false } = {}) {
    const state = getState();
    if (!state) return;
    state.script = null;
    dubs().clear();
    finishedCache.clear();
    bedCache.clear();
    previewBufs.clear();
    ctx.edits.replaceRespeak([]);
    const caps = state.captions;
    if (caps && caps.beforeRespeak) {
      caps.cues = caps.beforeRespeak.cues;
      caps.beforeRespeak = null;
      ctx.captionsChanged();
    }
    renderPlan();
    if (!quiet) status('Back to the original recording.');
    if (onChanged) onChanged();
  }

  // ---- what the encoder asks for -----------------------------------------
  // The narration is finished once, as one buffer at the output's rate, and
  // every span is a window onto it. Finishing per span would give each span
  // its own tone and level correction, which is exactly the drift this design
  // exists to avoid.

  const resampleMono = (a, from, to) => {
    if (!a || !a.length || from === to) return a;
    const r = createResampler(from, to);
    return r.push(a).slice();
  };

  // The recording's room tone, at whatever rate is being asked for.
  function roomToneAt(sampleRate) {
    const state = getState();
    const src = state && state.audioAnalysis && state.audioAnalysis.roomTone;
    if (!src || !src.length) return null;
    const key = String(sampleRate);
    if (!toneCache.has(key)) {
      toneCache.set(key, resampleMono(src, state.audio.audio.sample_rate, sampleRate));
    }
    return toneCache.get(key);
  }

  // The reference clip, at the output's rate: the tonal yardstick. Same
  // speaker, same microphone, same room — and, unlike the model, it has
  // something above 12 kHz, which is the whole reason to match to it.
  function refToneAt(sampleRate) {
    if (!refAudio || !refAudio.native || !refAudio.native.length) return null;
    const key = String(sampleRate);
    if (!refToneCache.has(key)) {
      refToneCache.set(key, resampleMono(refAudio.native, refAudio.rate, sampleRate));
    }
    return refToneCache.get(key);
  }

  /** The whole narration, finished, mono, at `sampleRate`. */
  function finishedAt(sampleRate) {
    const state = getState();
    const sc = state && state.script;
    if (!sc || !sc.pcm || !sc.pcm.length) return null;
    const key = String(sampleRate);
    if (finishedCache.has(key)) return finishedCache.get(key);
    const out = finishNarration(sc.pcm, {
      modelRate: sc.sampleRate, outRate: sampleRate,
      resample: resampleMono,
      targetDbfs: sc.targetDbfs ?? targetDbfs(),
      // The tonal yardstick is a measurement, not a sample — three band gains
      // taken off the reference clip — so it stays on either way: it is what
      // gives the clone the speaker's own microphone above 12 kHz.
      toneReference: refToneAt(sampleRate),
      roomTone: replacesAudio() ? null : roomToneAt(sampleRate),
      bedDb: replacesAudio() ? BED_DB : null,
      pauses: sc.pauses,
    });
    finishedCache.set(key, out.pcm);
    bedCache.set(key, out.bed || null);
    return out.pcm;
  }

  /**
   * The presence laid under the narration, as `frames` of it.
   *
   * What the export emits for a span the narration does not cover, when the
   * recording is being replaced. Silence there would be a hole in a bed that
   * is otherwise continuous, which is the artefact the bed exists to remove —
   * and unlike a slice of narration it is right at any output position, so it
   * cannot go out of sync with a timeline edited after the respeak.
   */
  function bedFor({ sampleRate, channels, frames }) {
    const n = Math.max(0, frames | 0);
    if (!n) return null;
    if (!bedCache.has(String(sampleRate))) finishedAt(sampleRate);
    const bed = bedCache.get(String(sampleRate));
    if (!bed || !bed.length) return null;
    return toInterleaved(layRoomTone(new Float32Array(n), bed), channels);
  }

  /** The samples the encoder (or the preview) should emit for a respoken span. */
  function pcmFor(id, { sampleRate, channels, frames }) {
    const rec = dubs().get(id);
    if (!rec) return null;
    const mono = finishedAt(sampleRate);
    if (!mono) return null;
    const from = Math.round(rec.atS * sampleRate);
    const out = new Float32Array(Math.max(0, frames | 0));
    const n = Math.max(0, Math.min(out.length, mono.length - from));
    if (n > 0) out.set(mono.subarray(from, from + n), 0);
    return toInterleaved(out, channels);
  }

  // ---- hearing it before exporting ---------------------------------------
  // The preview is a <video> playing the original file, so the narration is
  // not in it. `previewBuffer` renders the same samples the encoder will get —
  // through the same finishNarration, at the same length — as an AudioBuffer,
  // and compressor.js plays it over the muted original while the playhead is
  // inside that span.

  function previewBuffer(id, { sampleRate, frames }, audioCtx) {
    const key = `${id}|${sampleRate}|${frames}`;
    if (previewBufs.has(key)) return previewBufs.get(key);
    const pcm = pcmFor(id, { sampleRate, channels: 1, frames });
    if (!pcm) return null;
    const buf = audioCtx.createBuffer(1, pcm.length, sampleRate);
    buf.copyToChannel(pcm, 0);
    previewBufs.set(key, buf);
    return buf;
  }

  /** 'respoken' (hear the new narration) or 'original' (hear the recording). */
  function previewTrack() {
    return els.inVoiceTrack ? els.inVoiceTrack.value : 'respoken';
  }

  function isRespoken() { const s = getState(); return !!(s && s.script); }
  function isRunning() { return running; }

  // ---- persistence --------------------------------------------------------
  // The script and the seed, not the samples: a few minutes of narration is
  // tens of MB, and it can be made again exactly from these two.
  function saveScript() {
    const state = getState();
    if (!state || !state.file) return;
    try {
      const text = scriptText();
      const f = state.file;
      localStorage.setItem(LS_SCRIPT_KEY, JSON.stringify({
        v: 1, file: { name: f.name, size: f.size, lastModified: f.lastModified },
        lang: els.inVoiceLang.value, reference,
        text, seed: state.script ? state.script.seed : null,
      }));
    } catch (_) {}
  }

  function restore(file) {
    try {
      const d = JSON.parse(localStorage.getItem(LS_SCRIPT_KEY) || 'null');
      if (!d || !d.file || d.file.name !== file.name || d.file.size !== file.size
          || d.file.lastModified !== file.lastModified) return null;
      if (els.scriptText && d.text) { els.scriptText.value = d.text; scriptEdited = true; }
      renderScriptInfo();
      return d;
    } catch (_) { return null; }
  }

  // ---- settings -----------------------------------------------------------
  function settings() {
    return {
      voiceLang: els.inVoiceLang.value,
      voiceEngine: engine(),
      voiceProfile: (els.inVoiceProfile && els.inVoiceProfile.value) || wantProfile || '',
      voiceTrack: els.inVoiceTrack ? els.inVoiceTrack.value : 'respoken',
      voiceBed: els.inVoiceBed ? els.inVoiceBed.value : 'replace',
      voicePause: els.inVoicePause ? els.inVoicePause.value : '0.36',
      voiceStretch: els.inVoiceStretch ? els.inVoiceStretch.value : '50',
    };
  }
  function applySettings(g) {
    if (!g) return;
    if (g.voiceLang && VOICE_LANGS[g.voiceLang]) els.inVoiceLang.value = g.voiceLang;
    if (g.voiceProfile) wantProfile = g.voiceProfile;
    if (els.inVoiceEngine && (g.voiceEngine === 'local' || g.voiceEngine === 'browser')
        && els.inVoiceEngine.value !== g.voiceEngine) {
      els.inVoiceEngine.value = g.voiceEngine;
      dropWorker();
      refreshEngineHint();
    }
    if (els.inVoiceTrack && g.voiceTrack) els.inVoiceTrack.value = g.voiceTrack;
    if (els.inVoiceBed && g.voiceBed) els.inVoiceBed.value = g.voiceBed;
    if (els.inVoicePause && g.voicePause != null) els.inVoicePause.value = g.voicePause;
    if (els.inVoiceStretch && g.voiceStretch != null) els.inVoiceStretch.value = g.voiceStretch;
  }

  function updateUI() {
    const state = getState();
    const has = isRespoken();
    if (els.btnVoiceAll) {
      els.btnVoiceAll.disabled = running;
      els.btnVoiceAll.textContent = has ? 'Respeak it again' : 'Respeak the whole script';
    }
    if (els.btnVoiceAllCancel) els.btnVoiceAllCancel.hidden = !running;
    if (els.btnVoiceUndo) els.btnVoiceUndo.hidden = !has;
    if (els.btnScriptFill) {
      els.btnScriptFill.disabled = !(state && state.captions && state.captions.cues && state.captions.cues.length);
    }
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
    if (els.inVoiceEngine) {
      els.inVoiceEngine.addEventListener('change', () => {
        dropWorker();
        refreshEngineHint();
        if (onChanged) onChanged();
      });
      refreshEngineHint();
    }
    if (els.inVoiceProfile) {
      els.inVoiceProfile.addEventListener('change', () => {
        wantProfile = els.inVoiceProfile.value;
        if (worker instanceof LocalVoice) worker.profile = wantProfile || null;
        if (onChanged) onChanged();
      });
    }
    if (els.btnVoiceProfileDownload) els.btnVoiceProfileDownload.addEventListener('click', downloadProfile);
    if (els.inVoiceProfileFile) {
      els.inVoiceProfileFile.addEventListener('change', () => importProfileFile(els.inVoiceProfileFile.files[0]));
    }
    if (els.scriptText) {
      els.scriptText.addEventListener('input', () => {
        scriptEdited = true;
        renderScriptInfo();
        saveScript();
      });
    }
    if (els.btnScriptFill) {
      els.btnScriptFill.addEventListener('click', () => fillScriptFromTranscript({ force: true }));
    }
    if (els.btnVoiceAll) {
      els.btnVoiceAll.addEventListener('click', async () => {
        try { await respeakScript(); }
        catch (e) { if (e && e.message !== 'cancelled') status(e.message); }
      });
    }
    if (els.btnVoiceAllCancel) els.btnVoiceAllCancel.addEventListener('click', cancel);
    if (els.btnVoiceUndo) els.btnVoiceUndo.addEventListener('click', revertScript);
    if (els.btnVoiceRef) {
      els.btnVoiceRef.addEventListener('click', () => {
        const list = candidates();
        if (!list.length) { status('Generate a transcript first.'); return; }
        refRank = (refRank + 1) % list.length;
        reference = list[refRank];
        clonedFor = null;
        renderReference();
        status('Reference changed — it will be used the next time you respeak.');
      });
    }
    if (els.inVoicePause) els.inVoicePause.addEventListener('change', renderScriptInfo);
    // Replacing the audio or keeping the room only changes how the narration
    // is *finished*, so a take already spoken is reused — drop what was
    // finished under the old answer and it is audible on the next play.
    if (els.inVoiceBed) {
      els.inVoiceBed.addEventListener('change', () => {
        finishedCache.clear();
        bedCache.clear();
        previewBufs.clear();
        // Nothing spoken yet — and possibly no file open — so there is no
        // timeline to redraw and nobody to tell. It applies when there is.
        if (!isRespoken()) return;
        status(replacesAudio()
          ? 'The recording is replaced outright: no room tone under the narration, and silence where it does not reach.'
          : 'The recording’s room tone is laid back under the narration.');
        if (onChanged) onChanged();
      });
    }
    // Turning this re-times a narration already spoken, without regenerating
    // a thing — so it is a dial you can hear rather than a setting you have
    // to take on trust until next time.
    if (els.inVoiceStretch) els.inVoiceStretch.addEventListener('change', replan);
    refreshCachedLabel();
  }

  /** Called when a new file is loaded. */
  function reset(file) {
    reference = null; clonedFor = null; refRank = 0; referenceDbfs = null; refAudio = null;
    finishedCache.clear(); bedCache.clear(); previewBufs.clear(); toneCache.clear(); refToneCache.clear();
    if (els.scriptText) els.scriptText.value = '';
    scriptEdited = false;
    if (els.voicePlan) els.voicePlan.textContent = '';
    status('');
    return file ? restore(file) : null;
  }

  return {
    wire, settings, applySettings, reset, restore, updateUI,
    respeakScript, cancel, revertScript, replan,
    fillScriptFromTranscript, renderScriptInfo, renderPlan,
    pcmFor, bedFor, previewBuffer, previewTrack, replacesAudio, isRespoken, isRunning,
    reference: () => reference,
    setStatus: status,
    ready: () => loaded,
  };
}
