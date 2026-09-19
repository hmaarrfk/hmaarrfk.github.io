// Overdub — the pure helpers behind respeaking a whole narration in your own
// voice.
//
// No DOM, no model, no WebCodecs: choosing a reference clip to clone from,
// turning a transcript into an editable script, aligning a rewritten script
// back onto the recording it came from, deciding how the picture has to be
// re-timed so it still matches what is now being said, and finishing the
// generated narration so it sits in the room the recording was made in. The
// model itself (a zero-shot cloning TTS) runs in voice-worker.js; voice-ui.js
// joins the two to the page. Like captions.js and breath.js, everything here
// runs under Node, which is where it is actually tested.
//
// Why the whole script, and not a line at a time
// ----------------------------------------------
// The first version of this respoke one transcript phrase at a time, each into
// the hole its recorded phrase left. It worked, and it sounded wrong: every
// phrase was a separate generation with its own prosody, squeezed by its own
// WSOLA rate into a slot whose length was decided by how fast you happened to
// have said it the first time, with the recording's pauses between. The result
// was a sequence of correct sentences that did not sound like anybody talking.
//
// So the direction is inverted. The narration is generated as one continuous
// script — sentence after sentence, in order, with the pauses coming from the
// punctuation rather than from the old recording — and it becomes the spine of
// the output. The *picture* is then re-timed to it: each stretch of video runs
// a little faster or a little slower, or is cut, so that what is on screen
// still matches what is being said. A screencast tolerates that easily; a
// chopped-up voice track does not.
//
// The path a respoken script takes:
//
//   transcript cues        ─► scriptFromCues  ─► an editable paragraph script
//   the script             ─► splitScript     ─► sentences + their pauses
//   sentences + old words  ─► alignScript     ─► where each sentence was said
//                             (the TTS model, one call, in order)
//   generated mono PCM     ─► finishNarration ─► tone, level, room, one bed
//   sentence timings       ─► planTimeline    ─► the video's new rates & cuts
//   sentences              ─► narrationWords  ─► captions for what is now said
//
// Two things make this work at all on a screencast. The alignment is done on
// *words*, by a patience diff against the transcript, so an edited script
// still lands on the seconds it describes even when whole sentences were
// rewritten; and the reference clip comes out of the same recording, so the
// cloned voice arrives with the same microphone and the same room already on
// it.

import { analyzeVoiceLevel } from './audio-boost.js';

// ---------------------------------------------------------------------------
// What to clone from
// ---------------------------------------------------------------------------
// Zero-shot cloning wants 6-15 s of *clean, continuous* speech. The word
// timings already say where that is, so nobody has to record a sample: walk
// the transcript for the longest runs with no real pause in them, and score
// the best window of each.
//
// Density is what is being scored — the fraction of the window actually
// covered by words. A window full of pauses hands the model room tone to
// imitate, and it will: the model reproduces the recording, not just the
// voice. Ties break towards the middle of the recording, where a speaker has
// usually settled down.

export function pickReference(words, {
  minS = 6, maxS = 15, maxGapS = 0.45, within = null, durationS = null,
} = {}) {
  let ws = (words || []).filter((w) => isFinite(w.start) && isFinite(w.end) && w.end > w.start);
  if (within && within.length) {
    ws = ws.filter((w) => within.some((seg) => w.start >= seg.start - 1e-3 && w.end <= seg.end + 1e-3));
  }
  if (!ws.length) return null;
  ws.sort((a, b) => a.start - b.start);

  // Runs of words with no pause longer than maxGapS between them.
  const runs = [];
  let cur = [ws[0]];
  for (let i = 1; i < ws.length; i++) {
    if (ws[i].start - cur[cur.length - 1].end > maxGapS) { runs.push(cur); cur = [ws[i]]; }
    else cur.push(ws[i]);
  }
  runs.push(cur);

  const total = durationS || ws[ws.length - 1].end;
  let best = null;
  for (const run of runs) {
    if (run[run.length - 1].end - run[0].start < minS) continue;
    // The longest window inside this run that is still <= maxS, greedily
    // extended from each starting word.
    for (let i = 0; i < run.length; i++) {
      let j = i;
      while (j + 1 < run.length && run[j + 1].end - run[i].start <= maxS) j++;
      const start = run[i].start, end = run[j].end;
      const dur = end - start;
      if (dur < minS) continue;
      let spoken = 0;
      for (let k = i; k <= j; k++) spoken += run[k].end - run[k].start;
      const density = spoken / dur;
      // Prefer denser, then longer, then nearer the middle of the recording.
      const centrality = 1 - Math.abs((start + end) / 2 - total / 2) / Math.max(1e-6, total);
      const score = density * 100 + dur + centrality;
      if (!best || score > best.score) {
        const text = run.slice(i, j + 1).map((w) => w.text || '').join('').replace(/\s+/g, ' ').trim();
        best = { start, end, text, density, score };
      }
    }
  }
  if (!best) return null;
  return { start: best.start, end: best.end, text: best.text, density: best.density };
}


// ---------------------------------------------------------------------------
// The room
// ---------------------------------------------------------------------------

/**
 * Find the recording's own room tone — the longest quiet stretch in it.
 *
 * This is the "presence track" a dialogue editor lays under replaced lines.
 * It matters more than it sounds like it should: a room is never silent, and
 * the ear notices the background *stopping* far more readily than it notices
 * a voice being slightly wrong. It also carries the parts of the recording the
 * model cannot produce — the microphone's own hiss, the air, everything above
 * the 12 kHz the 24 kHz model tops out at — so laying it under a generated
 * line is what keeps the splice from sounding like a hole punched in the
 * track.
 *
 * Returns mono samples at the rate it was given, or null if the recording
 * never stops long enough to take a clean sample.
 */
export function findRoomTone(mono, sampleRate, { minS = 0.7, maxS = 3, frameMs = 50 } = {}) {
  if (!mono || !mono.length) return null;
  const hop = Math.max(1, Math.round((frameMs / 1000) * sampleRate));
  const n = Math.floor(mono.length / hop);
  if (n < 4) return null;

  const level = new Float32Array(n);
  for (let i = 0; i < n; i++) level[i] = rms(mono, i * hop, (i + 1) * hop);

  // The noise floor, as the 10th percentile of frame levels — robust to both
  // the talking and the odd click.
  const sorted = Float32Array.from(level).sort();
  const floor = sorted[Math.floor(n * 0.1)];
  if (!(floor > 0)) return null;
  // "Quiet" means within a few dB of that floor: room tone, not a soft word.
  const ceiling = floor * 2.5;

  let bestAt = -1, bestLen = 0, at = -1;
  for (let i = 0; i <= n; i++) {
    const quiet = i < n && level[i] <= ceiling;
    if (quiet && at < 0) at = i;
    else if (!quiet && at >= 0) {
      if (i - at > bestLen) { bestLen = i - at; bestAt = at; }
      at = -1;
    }
  }
  if (bestAt < 0 || bestLen * (hop / sampleRate) < minS) return null;

  // A recording that never actually stops — continuous narration, or music
  // under it — has near-constant frame levels, so the percentile floor lands
  // *inside the speech* and every frame looks "quiet" relative to it. Taking
  // that would lay the speaker's own voice under every respoken line. Room
  // tone has to be quiet in absolute terms too, well under the track as a
  // whole; if nothing here is, this recording simply hasn't got any.
  if (!(floor < rms(mono) * 0.25)) return null;

  // Trim a frame off each end so a word's tail or onset can't creep in.
  const from = (bestAt + 1) * hop;
  const to = Math.min(mono.length, (bestAt + bestLen - 1) * hop);
  const want = Math.round(maxS * sampleRate);
  if (to - from < Math.round(minS * sampleRate)) return null;
  return mono.slice(from, Math.min(to, from + want));
}

/**
 * Lay room tone under a generated line, and use it for the pause at the end.
 *
 * `tone` is the recording's own presence, already at this sample rate. It is
 * mixed in at full level — it *is* the room, and the room was there — which
 * makes the background continuous from before the splice, through it, and out
 * the other side.
 */
export function layRoomTone(mono, tone, { from = 0 } = {}) {
  if (!tone || !tone.length || !mono || !mono.length) return mono;
  const out = Float32Array.from(mono);
  // Walk the tone back and forth rather than looping it, so a sample shorter
  // than the line never repeats audibly.
  const period = tone.length * 2 - 2;
  for (let i = from; i < out.length; i++) {
    const k = period > 0 ? i % period : 0;
    out[i] += k < tone.length ? tone[k] : tone[period - k];
  }
  return out;
}

/**
 * Fill `out[from..]` with room tone taken from the signal itself.
 *
 * Digital silence is not what a pause in a recording sounds like: a real one
 * still has the room and the microphone in it, twenty-odd dB under the voice
 * but very much there. Dropping to −120 dB for a second and a half in the
 * middle of a sentence reads as a dropout, which is exactly the kind of seam
 * this whole module exists to avoid. (Measured on a real export: a 5.3 s line
 * respoken in 3.7 s left 1.56 s of absolute silence, and it was obvious.)
 *
 * The tone is lifted from the generation rather than the recording because the
 * clone already carries the room — it was cloned from this microphone, in this
 * room, and its own pauses sound like the right pauses. The quietest stretch
 * of the line is therefore the right filler, and it needs nothing passed in.
 *
 * It is tiled alternately forwards and backwards so the joins are continuous
 * and the ear can't hear a loop. The window is short (120 ms) because it has
 * to fit *inside* a pause to be room tone at all — the gaps between phrases in
 * a generated line run about 200-400 ms, and a longer window would keep
 * catching the words on either side and disqualify itself.
 */
// `to` bounds the stretch being filled (the default runs to the end of the
// buffer), and `learnFrom`/`learnTo` say where the spoken part is — which is
// not always before `from`: the silence borrowed at the head of a span is
// filled from the line that follows it.
export function fillWithRoomTone(out, from, sampleRate, {
  windowMs = 120, maxWindows = 8, to = out.length, learnFrom = 0, learnTo = from,
} = {}) {
  const need = to - from;
  if (need <= 0) return out;
  const win = Math.min(Math.max(0, learnTo - learnFrom), Math.round((windowMs / 1000) * sampleRate));
  if (win < 64) return out;                 // nothing to learn the room from

  // Score every candidate window of the spoken part, quietest first. This is a
  // search for "somewhere nobody is talking", not a precise measurement, so it
  // steps coarsely.
  const step = Math.max(1, Math.floor(win / 4));
  const cands = [];
  for (let at = learnFrom; at + win <= learnTo; at += step) cands.push({ at, level: rms(out, at, at + win) });
  if (!cands.length) return out;
  cands.sort((a, b) => a.level - b.level);
  if (!(cands[0].level > 0)) return out;    // the line really is silent; leave it

  // Only use it if it is genuinely a *pause* — well under the line as a whole.
  // A line with no quiet stretch anywhere (one continuous word, or a bad
  // generation) has no room tone to lend, and tiling its quietest window would
  // fill the pause with looping speech, which is far worse than silence.
  const overall = rms(out, learnFrom, learnTo);
  if (!(cands[0].level < overall * 0.25)) return out;

  // Take several *non-overlapping* quiet windows, not just the best one.
  // Tiling a single window is what makes a long pause sound wrong: at 120 ms a
  // second and a half of pad is the same fragment a dozen times over, and the
  // ear hears the period immediately — as a breath or a hum that wasn't in the
  // recording. Several different fragments, shuffled, read as room.
  const picked = [];
  for (const c of cands) {
    if (c.level > cands[0].level * 4) break;            // no longer a pause
    if (picked.some((p) => Math.abs(p - c.at) < win)) continue;
    picked.push(c.at);
    if (picked.length >= maxWindows) break;
  }

  const tones = picked.map((at) => out.slice(at, at + win));
  // Deterministic order, so the same dub always fills the same way.
  let seed = (need * 2654435761) >>> 0;
  const rnd = () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return (seed >>> 8) / 0x1000000;
  };
  // A line may only contain one usable pause, and then shuffling has nothing
  // to shuffle. Room tone is noise, so a reversed copy of it is still the same
  // room but no longer the same waveform — that, plus a little level jitter,
  // is what stops even a single fragment from reading as a loop.
  const nextTone = () => {
    const src = tones[Math.floor(rnd() * tones.length) % tones.length];
    const reverse = rnd() < 0.5;
    const gain = 1 + (rnd() - 0.5) * 0.3;
    const t = new Float32Array(win);
    for (let k = 0; k < win; k++) t[k] = src[reverse ? win - 1 - k : k] * gain;
    return t;
  };

  // Equal-power crossfades between fragments, so the joins are inaudible
  // without the mirroring trick (which introduced its own periodicity).
  const fade = Math.min(Math.floor(win / 4), Math.round(0.02 * sampleRate));
  const body = win - fade;
  let cur = nextTone();
  let i = 0;
  while (i < need) {
    const next = nextTone();
    for (let k = 0; k < body && i < need; k++, i++) out[from + i] = cur[k];
    for (let k = 0; k < fade && i < need; k++, i++) {
      const t = (k + 1) / (fade + 1);
      const a = Math.cos(t * Math.PI / 2), b = Math.sin(t * Math.PI / 2);
      out[from + i] = cur[body + k] * a + next[k] * b;
    }
    cur = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Sounding like it belongs
// ---------------------------------------------------------------------------

/** RMS over a range, ignoring anything outside the buffer. */
export function rms(a, from = 0, to = a.length) {
  const lo = Math.max(0, from | 0), hi = Math.min(a.length, to | 0);
  if (hi <= lo) return 0;
  let sum = 0;
  for (let i = lo; i < hi; i++) sum += a[i] * a[i];
  return Math.sqrt(sum / (hi - lo));
}

/**
 * Scale `mono` so its speech sits at `targetRms`. Capped, because an empty
 * or near-silent generation would otherwise be multiplied into noise, and a
 * dub that arrives far too loud is more likely a bad generation than a
 * quiet neighbour.
 */
export function matchLevel(mono, targetRms, { maxGainDb = 12, minGainDb = -12 } = {}) {
  const cur = rms(mono);
  if (!(cur > 1e-6) || !(targetRms > 1e-6)) return { pcm: mono, gainDb: 0 };
  const hi = Math.pow(10, maxGainDb / 20), lo = Math.pow(10, minGainDb / 20);
  const g = Math.min(hi, Math.max(lo, targetRms / cur));
  const out = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i++) out[i] = mono[i] * g;
  return { pcm: out, gainDb: 20 * Math.log10(g) };
}

/**
 * Put a generated line at the same voice level as the recording it is going
 * into, measured the way the rest of the tool measures loudness.
 *
 * Plain RMS over the whole buffer is the wrong yardstick here and matching on
 * it is audibly wrong: a line with a pause in it measures quiet, so it gets
 * pushed up, and a dense line measures loud, so it gets pushed down — the
 * amount of silence in a sentence should not decide how loud the voice is.
 * `analyzeVoiceLevel` (audio-boost.js) answers the right question instead —
 * the level of the 300-3400 Hz band while somebody is actually talking — and
 * it is the same number the auto-boost already reports for the whole track,
 * so the two are directly comparable.
 *
 * The cap is generous but real: a generation that needs more than 18 dB of
 * correction is not a level problem, it is a bad generation, and amplifying
 * it would only make the noise in it louder too.
 */
export function matchVoiceLevel(mono, sampleRate, targetDbfs, {
  maxGainDb = 18, minGainDb = -18,
} = {}) {
  // Note `Number.isFinite`, not the global: isFinite(null) is true, because
  // null coerces to 0 — which would read "no target" as "0 dBFS" and drive
  // the line to full scale.
  if (!mono || !mono.length || !Number.isFinite(targetDbfs)) return { pcm: mono, gainDb: 0, measuredDbfs: null };
  const { voiceDbfs, activeFraction } = analyzeVoiceLevel(mono, sampleRate);
  // Nothing recognisable as speech: leave it alone rather than scale noise.
  if (!Number.isFinite(voiceDbfs) || voiceDbfs <= -80 || !(activeFraction > 0.02)) {
    return { pcm: mono, gainDb: 0, measuredDbfs: voiceDbfs };
  }
  const gainDb = Math.min(maxGainDb, Math.max(minGainDb, targetDbfs - voiceDbfs));
  if (Math.abs(gainDb) < 0.1) return { pcm: mono, gainDb: 0, measuredDbfs: voiceDbfs };
  const g = Math.pow(10, gainDb / 20);
  const out = new Float32Array(mono.length);
  for (let i = 0; i < mono.length; i++) out[i] = mono[i] * g;
  return { pcm: out, gainDb, measuredDbfs: voiceDbfs };
}

// ---------------------------------------------------------------------------
// Tonal matching
// ---------------------------------------------------------------------------
// Level is not the only thing that has to agree across a splice. The line the
// model produces has its own spectral balance, and a 24 kHz model has nothing
// at all above 12 kHz, so next to a 44.1 kHz recording it reads as duller and
// closer — the "telephone" impression. The recording of the line being
// replaced is the perfect reference for fixing that: same speaker, same
// microphone, same room, same words.
//
// Three bands are enough, and more would be worse: this is meant to nudge the
// balance, not to impose one signal's spectrum on another. The corrections are
// clamped hard, because a large one means the two signals aren't comparable
// (one of them is mostly silence, say) and acting on it would do damage.

// One-pole low-pass, run twice for a gentler slope. Cheap, phase-benign, and
// the same shape audio-boost.js already uses for its voice band.
function lowpass(x, sampleRate, hz) {
  const dt = 1 / sampleRate;
  const rc = 1 / (2 * Math.PI * hz);
  const a = dt / (rc + dt);
  const out = new Float32Array(x.length);
  let y = 0;
  for (let i = 0; i < x.length; i++) { y += a * (x[i] - y); out[i] = y; }
  let z = 0;
  for (let i = 0; i < out.length; i++) { z += a * (out[i] - z); out[i] = z; }
  return out;
}

/** Split into low / mid / high around two corners. The three sum back to x. */
function split3(x, sampleRate, loHz = 700, hiHz = 3500) {
  const low = lowpass(x, sampleRate, loHz);
  const lowMid = lowpass(x, sampleRate, hiHz);
  const mid = new Float32Array(x.length);
  const high = new Float32Array(x.length);
  for (let i = 0; i < x.length; i++) {
    mid[i] = lowMid[i] - low[i];
    high[i] = x[i] - lowMid[i];
  }
  return { low, mid, high };
}

/**
 * Nudge `mono`'s tonal balance toward `reference`, using only the parts of
 * each where somebody is talking (a pause would otherwise drag the match
 * toward the noise floor). Returns the corrected audio and the gains used.
 */
export function matchTone(mono, reference, sampleRate, { maxDb = 6, minLevel = 1e-4 } = {}) {
  if (!mono || !mono.length || !reference || !reference.length) return { pcm: mono, gainsDb: null };
  const a = split3(mono, sampleRate);
  const b = split3(reference, sampleRate);

  // Measure over the loud half of each signal — an approximation of "while
  // talking" that needs no voice detection and cannot be fooled by silence.
  const loudRms = (x) => {
    const hop = Math.max(1, Math.round(0.02 * sampleRate));
    const n = Math.floor(x.length / hop);
    if (!n) return 0;
    const levels = [];
    for (let i = 0; i < n; i++) levels.push(rms(x, i * hop, (i + 1) * hop));
    levels.sort((p, q) => q - p);
    const take = Math.max(1, Math.floor(levels.length / 2));
    let sum = 0;
    for (let i = 0; i < take; i++) sum += levels[i] * levels[i];
    return Math.sqrt(sum / take);
  };

  const gains = [];
  const bands = ['low', 'mid', 'high'];
  for (const k of bands) {
    const src = loudRms(a[k]), ref = loudRms(b[k]);
    if (!(src > minLevel) || !(ref > minLevel)) { gains.push(1); continue; }
    const db = Math.max(-maxDb, Math.min(maxDb, 20 * Math.log10(ref / src)));
    gains.push(Math.pow(10, db / 20));
  }
  // Nothing worth doing.
  if (gains.every((g) => Math.abs(20 * Math.log10(g)) < 0.5)) return { pcm: mono, gainsDb: null };

  const out = new Float32Array(mono.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = a.low[i] * gains[0] + a.mid[i] * gains[1] + a.high[i] * gains[2];
  }
  return { pcm: out, gainsDb: gains.map((g) => 20 * Math.log10(g)) };
}

/**
 * Fade the first and last few ms so the splice cannot click. The span edges
 * have already been snapped into the surrounding pauses, so this is fading
 * room tone into room tone — short is enough, and short keeps it from eating
 * the first consonant.
 */
export function shapeEnds(mono, sampleRate, { fadeMs = 12 } = {}) {
  const n = Math.min(Math.floor(mono.length / 2), Math.round((fadeMs / 1000) * sampleRate));
  if (n <= 0) return mono;
  const out = new Float32Array(mono);
  for (let i = 0; i < n; i++) {
    const k = i / n;
    out[i] *= k;
    out[out.length - 1 - i] *= k;
  }
  return out;
}

/** Mono -> the interleaved layout the encoder takes. */
export function toInterleaved(mono, channels) {
  if (channels <= 1) return mono;
  const out = new Float32Array(mono.length * channels);
  for (let i = 0; i < mono.length; i++) {
    for (let c = 0; c < channels; c++) out[i * channels + c] = mono[i];
  }
  return out;
}

/** Interleaved -> mono, for measuring the neighbours of a seam. */
export function toMono(interleaved, channels) {
  if (channels <= 1) return interleaved;
  const frames = Math.floor(interleaved.length / channels);
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let c = 0; c < channels; c++) sum += interleaved[i * channels + c];
    out[i] = sum / channels;
  }
  return out;
}


// ---------------------------------------------------------------------------
// The script
// ---------------------------------------------------------------------------
// The transcript is a list of phrases with timestamps; a script is prose. The
// two have to convert cleanly both ways, because the transcript is what the
// tool knows and prose is what a person can actually rewrite.
//
// Going out, the only structure worth inventing is the paragraph: a silence
// long enough to be a beat in the delivery is where one ends. Coming back,
// the sentence is the unit — it is what the model speaks in one breath, what
// carries one prosodic arc, and what the alignment anchors on.

/** The transcript as an editable script: phrases joined, paragraphs at pauses. */
export function scriptFromCues(cues, { paragraphGapS = 1.5 } = {}) {
  const paras = [];
  let cur = [];
  let prevEnd = null;
  for (const c of cues || []) {
    const t = String(c.text || '').trim();
    if (!t) continue;
    if (prevEnd != null && c.start - prevEnd > paragraphGapS && cur.length) {
      paras.push(cur.join(' '));
      cur = [];
    }
    cur.push(t);
    prevEnd = prevEnd == null ? c.end : Math.max(prevEnd, c.end);
  }
  if (cur.length) paras.push(cur.join(' '));
  return paras.join('\n\n');
}

// Full stops that are not the end of a sentence. Without these, "Fig. 3 shows"
// and "e.g. the buffer" each become two parts, the model says them as two
// sentences, and a pause appears in the middle of a phrase.
const ABBREV = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'st', 'vs', 'etc', 'eg', 'ie', 'fig', 'figs',
  'no', 'approx', 'al', 'inc', 'ltd', 'jr', 'sr', 'vol', 'ch', 'sec', 'min',
  'max', 'cf', 'ca', 'pp', 'ref', 'refs', 'eq', 'eqs',
]);

/** One paragraph into sentences, leaving abbreviations and decimals alone. */
export function splitSentences(para) {
  const out = [];
  let start = 0;
  for (let i = 0; i < para.length; i++) {
    if (!'.!?…'.includes(para[i])) continue;
    // Swallow a run of terminators and any closing quote or bracket after it.
    let j = i;
    while (j + 1 < para.length && '.!?…"\')]”’'.includes(para[j + 1])) j++;
    const after = para.slice(j + 1);
    if (after && !/^\s/.test(after)) { i = j; continue; }      // 3.5, e.g., U.S.A
    const next = after.replace(/^\s+/, '');
    if (!next) break;                                          // the last sentence
    const word = /([\p{L}]+)[.!?…]*$/u.exec(para.slice(start, i + 1));
    const raw = word ? word[1] : '';
    // A lone *capital* before a full stop is an initial — "Dr. J. Smith" —
    // where a lone lower-case letter is far more likely the tail of a unit or
    // a model number: "the 20x." really is the end of a sentence.
    const initial = raw.length === 1 && raw === raw.toUpperCase() && raw !== raw.toLowerCase();
    if (para[i] === '.' && (ABBREV.has(raw.toLowerCase()) || initial)) { i = j; continue; }
    // A sentence really does start with a capital, a digit or a quote.
    if (!/^["'(\[“‘]?[\p{Lu}\p{N}]/u.test(next)) { i = j; continue; }
    out.push(para.slice(start, j + 1).trim());
    start = j + 1;
    i = j;
  }
  const tail = para.slice(start).trim();
  if (tail) out.push(tail);
  return out.length ? out : [para.trim()].filter(Boolean);
}

/**
 * The script, ready to speak: sentences in order, each with the pause that
 * follows it.
 *
 * This is where "the pauses follow the punctuation" actually happens. The
 * model says one sentence at a time and stops; left alone, the sentences would
 * run together with no breath between them, which is the other way to sound
 * unnatural. So the gap is chosen from what the sentence ends with — a full
 * stop is a beat, a paragraph break is a longer one, a comma or a colon barely
 * a hesitation — rather than from however long you happened to pause when you
 * recorded it.
 */
export function splitScript(text, {
  sentencePauseS = 0.36, paragraphPauseS = 0.78, clausePauseS = 0.2,
} = {}) {
  const paras = String(text || '')
    .split(/\n\s*\n+/)
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const parts = [];
  paras.forEach((para, pi) => {
    const sentences = splitSentences(para);
    sentences.forEach((s, si) => {
      const lastHere = si === sentences.length - 1;
      const lastOfAll = lastHere && pi === paras.length - 1;
      const pauseAfterS = lastOfAll ? 0
        : lastHere ? paragraphPauseS
        : /[,;:]["')\]”’]*$/.test(s) ? clausePauseS
        : sentencePauseS;
      parts.push({ text: s, pauseAfterS, paragraph: pi });
    });
  });
  return parts;
}

// ---------------------------------------------------------------------------
// Where the rewritten script was said
// ---------------------------------------------------------------------------
// The transcript's words carry timestamps; the script's words do not. Matching
// them is what lets a rewritten sentence keep its place on the screen
// recording, and it has to survive real editing: a fixed spelling here, a
// clause dropped there, an introduction replaced wholesale.
//
// A patience diff does this well and cheaply. Words that appear exactly once
// in both texts are unambiguous anchors; the longest increasing run of them
// pins the two sequences together, and each stretch between two anchors is
// matched the same way recursively. Unlike a full LCS it needs no O(n*m)
// table — a half-hour transcript is several thousand words — and unlike a
// nearest-timestamp guess it cannot be fooled by a sentence moving.

/** A word reduced to what it is worth comparing: letters and digits. */
export const normWord = (s) => String(s || '')
  .toLowerCase()
  .replace(/[‘’]/g, "'")
  .replace(/[^\p{L}\p{N}']/gu, '')
  .replace(/^'+|'+$/g, '');

/** Every word of a script, tagged with the part it belongs to. */
export function scriptWords(parts) {
  const out = [];
  (parts || []).forEach((p, i) => {
    for (const w of String(p.text || '').split(/\s+/)) {
      const n = normWord(w);
      if (n) out.push({ text: w, norm: n, part: i });
    }
  });
  return out;
}

/**
 * Patience diff: pairs of indices `[i, j]` where `a[i]` and `b[j]` are the
 * same word and the pairing is consistent with the order of both.
 */
export function matchWords(a, b, { maxDepth = 200 } = {}) {
  const out = [];
  walk(0, a.length, 0, b.length, 0);
  return out;

  function walk(lo1, hi1, lo2, hi2, depth) {
    while (lo1 < hi1 && lo2 < hi2 && a[lo1] === b[lo2]) out.push([lo1++, lo2++]);
    const tail = [];
    while (lo1 < hi1 && lo2 < hi2 && a[hi1 - 1] === b[hi2 - 1]) tail.push([--hi1, --hi2]);
    if (lo1 < hi1 && lo2 < hi2 && depth < maxDepth) {
      const anchors = unique(lo1, hi1, lo2, hi2);
      let p1 = lo1, p2 = lo2;
      for (const [i, j] of anchors) {
        walk(p1, i, p2, j, depth + 1);
        out.push([i, j]);
        p1 = i + 1; p2 = j + 1;
      }
      if (anchors.length) walk(p1, hi1, p2, hi2, depth + 1);
    }
    for (let k = tail.length - 1; k >= 0; k--) out.push(tail[k]);
  }

  // Words appearing exactly once on each side, paired, then thinned to the
  // longest run that moves forward in both — the patience sort.
  function unique(lo1, hi1, lo2, hi2) {
    const ca = new Map(), cb = new Map();
    for (let i = lo1; i < hi1; i++) {
      const e = ca.get(a[i]);
      if (e) e.n++; else ca.set(a[i], { n: 1, at: i });
    }
    for (let j = lo2; j < hi2; j++) {
      const e = cb.get(b[j]);
      if (e) e.n++; else cb.set(b[j], { n: 1, at: j });
    }
    const pairs = [];
    for (const [k, va] of ca) {
      if (va.n !== 1) continue;
      const vb = cb.get(k);
      if (vb && vb.n === 1) pairs.push([va.at, vb.at]);
    }
    if (pairs.length < 2) return pairs;
    pairs.sort((p, q) => p[0] - q[0]);

    // Longest increasing subsequence on the second coordinate.
    const piles = [], back = new Array(pairs.length).fill(-1), top = [];
    for (let i = 0; i < pairs.length; i++) {
      const v = pairs[i][1];
      let lo = 0, hi = piles.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (pairs[piles[mid]][1] < v) lo = mid + 1; else hi = mid; }
      if (lo > 0) back[i] = piles[lo - 1];
      piles[lo] = i;
      top[lo] = i;
    }
    const seq = [];
    for (let i = piles.length ? piles[piles.length - 1] : -1; i >= 0; i = back[i]) seq.push(pairs[i]);
    seq.reverse();
    return seq;
  }
}

/**
 * Give every sentence of the script the seconds of recording it describes.
 *
 * `words` are the transcript's words, in whatever timeline the caller is
 * planning in (this module never sees the difference between source time and
 * the trimmed timeline; voice-ui.js passes the latter). Every part comes back
 * with `srcStart` / `srcEnd`, and `anchored` saying whether that came from a
 * real word match or from sharing out the room between two that did.
 *
 * A wholly rewritten passage — the intro nobody keeps on the first take — has
 * no matches at all, so it is placed between its neighbours in proportion to
 * how much of it there is to say. That is a guess, but it is a guess bounded
 * on both sides by something that was measured.
 */
export function alignScript(parts, words, { startS = 0, endS = null } = {}) {
  const ws = (words || []).filter((w) => Number.isFinite(w.start) && Number.isFinite(w.end) && normWord(w.text));
  const total = endS != null ? endS : (ws.length ? ws[ws.length - 1].end : startS);
  const out = (parts || []).map((p) => ({ ...p, srcStart: null, srcEnd: null, anchored: false, matched: 0 }));
  if (!out.length) return out;

  const sw = scriptWords(out);
  if (ws.length && sw.length) {
    const pairs = matchWords(ws.map((w) => normWord(w.text)), sw.map((w) => w.norm));
    for (const [i, j] of pairs) {
      const o = out[sw[j].part];
      if (!o.anchored) { o.srcStart = ws[i].start; o.srcEnd = ws[i].end; o.anchored = true; }
      else { o.srcStart = Math.min(o.srcStart, ws[i].start); o.srcEnd = Math.max(o.srcEnd, ws[i].end); }
      o.matched++;
    }
  }

  // Anchors have to march forward. One badly paired repeated word would
  // otherwise fold the timeline back on itself, and a negative-length section
  // is not something the rest of the tool can be asked to render.
  let floor = startS;
  for (const o of out) {
    if (!o.anchored) continue;
    o.srcStart = Math.max(o.srcStart, floor);
    o.srcEnd = Math.max(o.srcEnd, o.srcStart);
    floor = o.srcEnd;
  }
  let ceil = total;
  for (let i = out.length - 1; i >= 0; i--) {
    const o = out[i];
    if (!o.anchored) continue;
    o.srcEnd = Math.min(o.srcEnd, ceil);
    o.srcStart = Math.min(o.srcStart, o.srcEnd);
    ceil = o.srcStart;
  }

  // Runs with nothing matched share out the gap between the anchors around
  // them, by how much there is to say.
  const weight = (p) => Math.max(1, String(p.text || '').length);
  let i = 0;
  while (i < out.length) {
    if (out[i].anchored) { i++; continue; }
    let j = i;
    while (j < out.length && !out[j].anchored) j++;
    const from = i > 0 ? out[i - 1].srcEnd : startS;
    const to = j < out.length ? out[j].srcStart : total;
    const span = Math.max(0, to - from);
    let sum = 0;
    for (let k = i; k < j; k++) sum += weight(out[k]);
    let at = from;
    for (let k = i; k < j; k++) {
      const d = sum > 0 ? (span * weight(out[k])) / sum : 0;
      out[k].srcStart = at;
      out[k].srcEnd = at + d;
      at += d;
    }
    i = j;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Re-timing the picture to the narration
// ---------------------------------------------------------------------------
// After the script has been spoken there are two timelines that have to be
// made to agree: the recording, where each sentence *was* said, and the new
// narration, where each sentence *is* said. Every pair of (recording time,
// narration time) is an anchor, and the stretch between two anchors is a
// section of video that has to occupy exactly its share of the narration —
// which is to say, it has a rate, which is a thing `state.edits` already
// understands.
//
// Taken literally that gives one rate per sentence, and some of them absurd:
// a sentence you now say in three seconds where you once took eight wants the
// picture at 2.7x. The fix is that a screencast does not need sentence-level
// sync. Dropping an anchor merges two sections into one with a gentler rate,
// and the only thing lost is that the picture inside the merged section drifts
// a little against the words. So anchors are dropped, worst offender first,
// until every remaining section is inside the band the user allowed.
//
// What that cannot fix is a section where the recording is simply much longer
// than the words that now describe it — the paragraph you deleted. There the
// picture is run at the fastest rate allowed and the remainder is *cut*, which
// is the honest answer: the script no longer covers that footage.
//
// The opposite case — many more words than picture — has no such lever, since
// there is no more footage to show. That section runs slower than asked and
// `planTimeline` says so, rather than quietly desynchronising.

export function planTimeline(parts, {
  keptS, narrationS, minRate = 0.7, maxRate = 1.5, minCutS = 0.35,
  smoothRatio = 1.15,
} = {}) {
  const raw = [{ src: 0, out: 0 }];
  for (const p of parts || []) {
    raw.push({ src: p.srcStart, out: p.outStart });
    raw.push({ src: p.srcEnd, out: p.outEnd });
  }
  // Only anchors that move both clocks forward are anchors at all.
  const anchors = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const last = anchors[anchors.length - 1];
    if (raw[i].src > last.src + 1e-3 && raw[i].out > last.out + 1e-3
        && raw[i].src < keptS - 1e-3 && raw[i].out < narrationS - 1e-3) {
      anchors.push(raw[i]);
    }
  }
  anchors.push({ src: keptS, out: narrationS });

  const rateOf = (i) => {
    const dout = anchors[i + 1].out - anchors[i].out;
    return dout > 1e-6 ? (anchors[i + 1].src - anchors[i].src) / dout : 1;
  };

  // How badly a section breaks the band, weighted by how long it is on screen:
  // a two-second lurch matters more than a tenth-of-a-second one.
  const cost = (i, j) => {
    const ds = anchors[j].src - anchors[i].src;
    const dout = anchors[j].out - anchors[i].out;
    if (!(dout > 1e-6)) return 0;
    const r = Math.max(1e-6, ds / dout);
    return dout * (Math.max(0, Math.log(r / maxRate)) + Math.max(0, Math.log(minRate / r)));
  };

  let merged = 0;
  for (;;) {
    let broken = false;
    for (let i = 0; i < anchors.length - 1 && !broken; i++) if (cost(i, i + 1) > 1e-9) broken = true;
    if (!broken || anchors.length <= 2) break;
    // Removing an anchor only changes the two sections it separates, so the
    // gain is local and the whole sweep is linear.
    let bestK = -1, bestDelta = -1e-9;
    for (let k = 1; k < anchors.length - 1; k++) {
      const d = cost(k - 1, k + 1) - cost(k - 1, k) - cost(k, k + 1);
      if (d < bestDelta) { bestDelta = d; bestK = k; }
    }
    if (bestK < 0) break;
    anchors.splice(bestK, 1);
    merged++;
  }

  // Then a cosmetic pass: neighbouring sections whose rates are already close
  // are joined. Nothing is wrong with them, but every rate change is a change
  // of playback speed, and a screencast with a moving cursor shows one every
  // second as jerkiness. Merging two sections at 1.11x and 1.15x costs a few
  // tenths of a second of drift inside the pair and removes a visible step.
  for (;;) {
    let bestK = -1, bestRatio = smoothRatio;
    for (let k = 1; k < anchors.length - 1; k++) {
      if (cost(k - 1, k) > 1e-9 || cost(k, k + 1) > 1e-9) continue;   // needs the anchor
      if (cost(k - 1, k + 1) > 1e-9) continue;                        // merging would break the band
      const a = rateOf(k - 1), b = rateOf(k);
      const ratio = Math.max(a / b, b / a);
      if (ratio < bestRatio) { bestRatio = ratio; bestK = k; }
    }
    if (bestK < 0) break;
    anchors.splice(bestK, 1);
    merged++;
  }

  const spans = [], cuts = [];
  let cutS = 0, fastest = 1, slowest = 1, tooSlow = 0;
  for (let i = 0; i < anchors.length - 1; i++) {
    const o0 = anchors[i].out, o1 = anchors[i + 1].out;
    const outDur = o1 - o0;
    let s0 = anchors[i].src, s1 = anchors[i + 1].src;
    if (!(outDur > 1e-6)) continue;
    let srcDur = s1 - s0;
    let rate = srcDur / outDur;
    if (rate > maxRate) {
      const drop = srcDur - maxRate * outDur;
      // Cut from the end of the section: the picture stays with the start of
      // what is being said and jumps forward just before the next sentence.
      // Below a third of a second a cut is more visible than the speed-up it
      // saves, so the section just runs a shade faster instead.
      if (drop >= minCutS) {
        cuts.push({ start: s1 - drop, end: s1 });
        cutS += drop;
        s1 -= drop;
        srcDur = s1 - s0;
        rate = maxRate;
      }
    }
    if (rate < minRate - 1e-6) tooSlow++;
    fastest = Math.max(fastest, rate);
    slowest = Math.min(slowest, rate);
    spans.push({ srcStart: s0, srcEnd: s1, outStart: o0, outEnd: o1, rate });
  }
  return { spans, cuts, stats: { sections: spans.length, merged, cutS, fastest, slowest, tooSlow } };
}

// ---------------------------------------------------------------------------
// Captions for what is now being said
// ---------------------------------------------------------------------------
// The burned-in captions have to follow the *new* narration, and they can:
// every sentence's audio span is known exactly, because the model was asked
// for the sentences one at a time. Inside a sentence the words are spread by
// how long they take to say — letters plus a beat, which is crude but is only
// ever interpolating across a couple of seconds between two exact edges.
//
// These go through the same `wordsToCues` the transcript does, so a long
// sentence breaks into two lines in the same places and by the same rules.

export function narrationWords(parts) {
  const out = [];
  for (const p of parts || []) {
    const words = String(p.text || '').split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const from = p.outStart || 0;
    const dur = Math.max(0, (p.outEnd || 0) - from);
    const w = words.map((t) => normWord(t).length + 1);
    let sum = 0;
    for (const x of w) sum += x;
    let at = from;
    words.forEach((t, i) => {
      const d = sum > 0 ? (dur * w[i]) / sum : 0;
      // A leading space is how captions.js knows a word starts, which is what
      // stops a cue ever breaking inside one.
      out.push({ text: ' ' + t, start: at, end: at + d });
      at += d;
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Finishing the narration
// ---------------------------------------------------------------------------
// One pass over the whole thing, not one per sentence — and that is the point.
// Tone matching, level matching and the room tone are all measurements, and a
// measurement made separately on each sentence gives each sentence a slightly
// different answer. You hear that as the voice shifting under you from line to
// line, which is exactly the fault the per-line version had. Measured once
// over the whole narration, the delivery is as consistent as one take.

export function finishNarration(mono, {
  modelRate, outRate, resample = null, targetDbfs = null,
  toneReference = null, roomTone = null, pauses = [], fadeMs = 30,
}) {
  let out = mono || new Float32Array(0);
  if (!out.length) return { pcm: out, gainDb: 0, gainsDb: null };
  if (modelRate !== outRate) {
    if (!resample) throw new Error('finishNarration needs a resample() when the model rate differs');
    out = resample(out, modelRate, outRate);
  }

  // Tone before level: correcting the balance moves the energy, so the level
  // has to be measured after it or the two fight each other.
  let gainsDb = null;
  if (toneReference && toneReference.length) {
    const t = matchTone(out, toneReference, outRate);
    out = t.pcm;
    gainsDb = t.gainsDb;
  }
  let gainDb = 0;
  if (targetDbfs != null) {
    const m = matchVoiceLevel(out, outRate, targetDbfs);
    out = m.pcm;
    gainDb = m.gainDb;
  }
  out = shapeEnds(out, outRate, { fadeMs });

  if (roomTone && roomTone.length) {
    out = layRoomTone(out, roomTone);
  } else if (pauses && pauses.length) {
    // No sample of the room to lay under it, so the pauses between sentences
    // are digital silence — which reads as a dropout, not a pause. Rebuild one
    // from the narration either side of each gap. Learning from a few seconds
    // around it rather than the whole track keeps this linear in the length of
    // the narration instead of quadratic.
    out = Float32Array.from(out);
    const near = Math.round(3 * outRate);
    for (const p of pauses) {
      const from = Math.round(p.from * outRate);
      const to = Math.min(out.length, Math.round(p.to * outRate));
      if (to - from < Math.round(0.05 * outRate)) continue;
      let learnFrom = Math.max(0, from - near), learnTo = from;
      if (learnTo - learnFrom < Math.round(0.3 * outRate)) {
        learnFrom = to;
        learnTo = Math.min(out.length, to + near);
      }
      fillWithRoomTone(out, from, outRate, { to, learnFrom, learnTo });
    }
  }
  return { pcm: out, gainDb, gainsDb };
}
