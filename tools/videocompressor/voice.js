// Overdub — the pure helpers behind respeaking a line in your own voice.
//
// No DOM, no model, no WebCodecs: choosing a reference clip to clone from,
// working out which transcript lines changed, deciding where a replacement
// may start and stop, fitting the generated speech into the hole it has to
// fill, and matching its level to the voice around it. The model itself
// (a zero-shot cloning TTS) runs in voice-worker.js; voice-ui.js joins the
// two to the page. Like captions.js and breath.js, everything here runs
// under Node, which is where it is actually tested.
//
// The path an overdub takes:
//
//   transcript line edited ─► changedLines   ─► what to respeak
//   word timings           ─► snapSpan       ─► where it may start/stop
//   word timings           ─► pickReference  ─► 6-15 s to clone from
//                             (the TTS model)
//   generated mono PCM     ─► fitToDuration  ─► WSOLA to the exact hole
//                          ─► matchVoiceLevel─► as loud as the recording
//                          ─► shapeEnds      ─► no click at the seam
//                          ─► toInterleaved  ─► what the encoder takes
//
// Two things make this work at all on a screencast. The span is snapped to
// the *middle of the surrounding pauses* rather than to the words, so the
// seam lands in room tone where a few ms of fade is inaudible; and the
// reference clip comes out of the same recording, so the cloned voice
// arrives with the same microphone and the same room already on it.

import { createTimeStretcher } from './speed.js';
import { analyzeVoiceLevel } from './audio-boost.js';

// How far a dub may be squeezed to fit its slot before it sounds processed.
// Measured on WSOLA at 40 ms windows: past about a third the consonants smear.
//
// Note the floor is 1, not its mirror image: a dub is never *stretched*. If
// the new line is shorter than the old one, slowing it down to fill the gap
// makes it drawl, when the honest thing — and what the recording would have
// sounded like had you said less — is to speak at your normal pace and leave
// the rest of the pause alone.
export const FIT_MIN_RATE = 1.0;    // dub is short: keep its pace, pad the rest
export const FIT_MAX_RATE = 1.38;   // dub is long: squeeze it in, up to this

// ---------------------------------------------------------------------------
// What changed
// ---------------------------------------------------------------------------
// A cue carries `orig` — the text the model transcribed — alongside the
// `text` the user may have retyped. A line is worth respeaking when those
// differ by more than whitespace and case-only punctuation drift, because
// re-synthesising a line that only gained a comma would swap real recorded
// speech for generated speech and gain nothing.

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** Lines whose text no longer matches what was transcribed. */
export function changedLines(cues) {
  const out = [];
  for (const c of cues || []) {
    if (typeof c.orig !== 'string') continue;   // never transcribed: nothing to diff
    if (norm(c.text) !== norm(c.orig)) out.push(c);
  }
  return out;
}

/** True when this line has been edited away from the transcript. */
export function isChanged(cue) {
  return !!cue && typeof cue.orig === 'string' && norm(cue.text) !== norm(cue.orig);
}

// ---------------------------------------------------------------------------
// Where a replacement may start and stop
// ---------------------------------------------------------------------------
// A cue's own start and end sit on the first and last word, which is the
// worst place to cut: the seam lands on a consonant, and any level or
// timbre mismatch is fully exposed. The pauses on either side are the right
// place. Snap each edge to the middle of its neighbouring gap, but never
// further than `maxSnapS` — on a dense line the "gap" may be 20 ms of stop
// closure, and a long reach would swallow a real word.

export function snapSpan(start, end, words, { maxSnapS = 0.25, minGapS = 0.04 } = {}) {
  const ws = (words || []).filter((w) => isFinite(w.start) && isFinite(w.end));
  if (!ws.length) return { start, end, snapped: false };

  // The word that ends last before `start`, and the one that starts first
  // after `end`. Words inside the span are irrelevant — they are the ones
  // being replaced.
  let before = null, after = null;
  for (const w of ws) {
    if (w.end <= start + 1e-3 && (!before || w.end > before.end)) before = w;
    if (w.start >= end - 1e-3 && (!after || w.start < after.start)) after = w;
  }

  const mid = (gapStart, gapEnd, edge) => {
    const gap = gapEnd - gapStart;
    if (!(gap > minGapS)) return edge;                 // no room: leave it alone
    const m = gapStart + gap / 2;
    return Math.abs(m - edge) <= maxSnapS ? m : edge;  // too far to reach
  };

  const s2 = before ? mid(before.end, start, start) : start;
  const e2 = after ? mid(end, after.start, end) : end;
  return { start: Math.min(s2, end - 1e-3), end: Math.max(e2, s2 + 1e-3), snapped: s2 !== start || e2 !== end };
}

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
// Fitting the generated speech into the hole
// ---------------------------------------------------------------------------
// The model says the line at its own pace, which is never exactly the pace
// of the recording it is replacing. WSOLA (speed.js — the same stretcher the
// sped-up sections use) changes the duration while keeping the pitch, so the
// cloned voice stays the cloned voice.
//
// Returns the rate it actually used and whether it ran out of room, because
// "it did not fit" is a UI decision, not something to paper over: a dub
// clamped at the limit is padded or trimmed, and the caller should offer to
// let the section change length instead.

export function fitToDuration(mono, sampleRate, targetSamples, {
  minRate = FIT_MIN_RATE, maxRate = FIT_MAX_RATE, padFadeMs = 25, roomTone = null,
} = {}) {
  const src = mono || new Float32Array(0);
  if (!src.length || !(targetSamples > 0)) {
    return { pcm: new Float32Array(Math.max(0, targetSamples | 0)), rate: 1, clamped: false, wanted: 1, spoken: 0 };
  }
  const wanted = src.length / targetSamples;        // >1: too long, squeeze
  const rate = Math.min(maxRate, Math.max(minRate, wanted));
  const clamped = Math.abs(rate - wanted) > 1e-6;

  let out;
  if (Math.abs(rate - 1) < 1e-3) {
    out = src;
  } else {
    const st = createTimeStretcher({ sampleRate, channels: 1, speed: rate });
    const a = st.process(src), b = st.flush();
    out = new Float32Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
  }

  // Land on the exact sample count either way: WSOLA emits whole windows, so
  // it overshoots or undershoots by up to one. The video expects a span to be
  // its own length to the sample.
  const fit = new Float32Array(targetSamples);
  const spoken = Math.min(out.length, targetSamples);
  fit.set(out.subarray(0, spoken), 0);

  // A line that is genuinely shorter than the hole it replaces leaves a pause
  // at the end, which is right — but the pause has to sound like the room, not
  // like the file ended. Ramp the speech down, then fill the rest with room
  // tone rather than zeros.
  if (spoken < targetSamples) {
    const n = Math.min(spoken, Math.round((padFadeMs / 1000) * sampleRate));
    for (let i = 0; i < n; i++) fit[spoken - 1 - i] *= i / n;
    // The recording's own room tone is the right filler when it's available;
    // reconstructing one from the generation's quiet moments is the fallback
    // for a recording that never stops long enough to sample.
    if (!(roomTone && roomTone.length)) fillWithRoomTone(fit, spoken, sampleRate);
  }
  return { pcm: fit, rate, clamped, wanted, spoken };
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

export function fillWithRoomTone(out, from, sampleRate, { windowMs = 120, maxWindows = 8 } = {}) {
  const need = out.length - from;
  if (need <= 0) return out;
  const win = Math.min(from, Math.round((windowMs / 1000) * sampleRate));
  if (win < 64) return out;                 // nothing to learn the room from

  // Score every candidate window of the spoken part, quietest first. This is a
  // search for "somewhere nobody is talking", not a precise measurement, so it
  // steps coarsely.
  const step = Math.max(1, Math.floor(win / 4));
  const cands = [];
  for (let at = 0; at + win <= from; at += step) cands.push({ at, level: rms(out, at, at + win) });
  if (!cands.length) return out;
  cands.sort((a, b) => a.level - b.level);
  if (!(cands[0].level > 0)) return out;    // the line really is silent; leave it

  // Only use it if it is genuinely a *pause* — well under the line as a whole.
  // A line with no quiet stretch anywhere (one continuous word, or a bad
  // generation) has no room tone to lend, and tiling its quietest window would
  // fill the pause with looping speech, which is far worse than silence.
  const overall = rms(out, 0, from);
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
// The whole finish, in one call
// ---------------------------------------------------------------------------
// Given raw model output and the slot it has to fill, produce the exact
// interleaved samples the export will emit for that span.
//
// `neighbourRms` is measured from the real audio just outside the span; pass
// null to leave the level alone (the model's own level is usually close,
// since it cloned a voice from this very recording).

/**
 * Blend a finished dub into the recording at its own edges.
 *
 * Fading a replacement in from silence and out to silence — which is what this
 * did first — leaves a dip at each boundary: the recording stops dead, then
 * the new line arrives from nothing. An equal-power crossfade with the audio
 * that was there instead means the background never stops, and since the span
 * was already snapped so its edges sit in pauses, what is being crossfaded is
 * room tone into room tone. That is the join you cannot hear.
 *
 * `orig` is the recording for this span, interleaved and same channel count.
 * Its *last* frames are used for the tail even when the span has been
 * re-timed, because those are the ones the next span continues from.
 */
export function crossfadeEdges(dub, orig, { channels = 1, sampleRate = 48000, fadeMs = 30 } = {}) {
  if (!dub || !dub.length || !orig || !orig.length) return dub;
  const frames = Math.floor(dub.length / channels);
  const origFrames = Math.floor(orig.length / channels);
  const n = Math.min(Math.floor(frames / 3), origFrames, Math.round((fadeMs / 1000) * sampleRate));
  if (n <= 1) return dub;
  const out = Float32Array.from(dub);

  for (let i = 0; i < n; i++) {
    // Equal power: the two halves sum to constant energy, so a noise floor
    // crossfaded with itself keeps its level instead of dipping in the middle.
    const t = (i + 1) / (n + 1);
    const fadeIn = Math.sin(t * Math.PI / 2), fadeOut = Math.cos(t * Math.PI / 2);
    for (let c = 0; c < channels; c++) {
      const head = i * channels + c;
      out[head] = out[head] * fadeIn + orig[head] * fadeOut;
      const tailDub = (frames - n + i) * channels + c;
      const tailOrig = (origFrames - n + i) * channels + c;
      out[tailDub] = out[tailDub] * fadeOut + orig[tailOrig] * fadeIn;
    }
  }
  return out;
}

export function finishDub(modelPcm, {
  modelRate, outRate, channels, targetSamples, targetDbfs = null,
  resample = null, fadeMs = 12, minRate = FIT_MIN_RATE, maxRate = FIT_MAX_RATE,
  roomTone = null, toneReference = null,
}) {
  let mono = modelPcm || new Float32Array(0);
  if (modelRate !== outRate) {
    if (!resample) throw new Error('finishDub needs a resample() when the model rate differs');
    mono = resample(mono, modelRate, outRate);
  }
  // Tone before level: correcting the balance moves the energy, so the level
  // has to be measured after it or the two fight each other.
  let gainsDb = null;
  if (toneReference && toneReference.length) {
    const t = matchTone(mono, toneReference, outRate);
    mono = t.pcm;
    gainsDb = t.gainsDb;
  }

  let gainDb = 0;
  if (targetDbfs != null) {
    const m = matchVoiceLevel(mono, outRate, targetDbfs);
    mono = m.pcm;
    gainDb = m.gainDb;
  }

  const fitted = fitToDuration(mono, outRate, targetSamples, {
    minRate, maxRate, roomTone,
  });

  // The room goes under the whole line, not just the pause at the end: it is
  // what makes the background continuous across the splice, and it carries the
  // air above 12 kHz that the model cannot produce at all.
  const withRoom = roomTone && roomTone.length ? layRoomTone(fitted.pcm, roomTone) : fitted.pcm;

  // Only shape the ends when there is no recording to cross into. With one,
  // crossfadeEdges() does a better job at export time and a fade to silence
  // here would only punch a hole for it to fill.
  const shaped = roomTone && roomTone.length ? withRoom : shapeEnds(withRoom, outRate, { fadeMs });
  return {
    pcm: toInterleaved(shaped, channels),
    frames: targetSamples,
    rate: fitted.rate,
    clamped: fitted.clamped,
    wanted: fitted.wanted,
    gainDb,
    gainsDb,
    spoken: fitted.spoken,
  };
}

// ---------------------------------------------------------------------------
// Letting the section change length instead
// ---------------------------------------------------------------------------
// When a rewritten line is much longer or shorter than the one it replaces,
// squeezing it is the wrong answer. The edit model already has a way to say
// "this source span occupies a different amount of output time": its rate.
// A dub that wants `dubS` seconds out of a `srcS`-second span is exactly a
// span at rate `srcS / dubS` — the video slows a little or hurries a little
// through that section, and every downstream consumer (frame spacing, the
// timeline, caption times) already understands it.

export function naturalRate(srcS, dubS, { minRate = 0.5, maxRate = 2 } = {}) {
  if (!(srcS > 0) || !(dubS > 0)) return 1;
  return Math.min(maxRate, Math.max(minRate, srcS / dubS));
}

/**
 * Which mode to suggest for a dub: fit it to the hole, or let the section
 * breathe.
 *
 * The two directions are not symmetric, and treating them as if they were is
 * wrong in a way you only hear once you try it. A line that comes out *short*
 * needs no help from the picture: it can simply be followed by the rest of the
 * pause it was sitting in, which is what the recording would have sounded like
 * if you had said less. Speeding the video up to close that gap — a 1.9x
 * lurch, in the case that prompted this — is a drastic edit to make on behalf
 * of a sentence that merely got briefer.
 *
 * A line that comes out *long* is different: the words genuinely need more
 * seconds than the hole has. Squeeze it while that stays inaudible, and past
 * that, give it the time and let the section slow down.
 */
/**
 * Work out what a respoken span should occupy: whether the picture stays put,
 * how fast it runs if not, and how much pause is left at the end.
 *
 * `deadAirS` is the answer to "how long a pause will you tolerate". Anything
 * beyond it is trimmed by running the section faster, so the setting means
 * exactly what it says — keep at most this much silence — rather than being a
 * threshold that then removes *all* of it.
 *
 *   trimDeadAir off → the pause stays, whatever its length
 *   pause <= deadAirS → nothing to do, the picture is left alone
 *   pause >  deadAirS → the span runs at srcS / (dubS + deadAirS)
 *
 * Returns `{ mode, rate, outS, padS }`. `mode` is 'fit' (rate 1, the picture
 * untouched) or 'natural' (the rate absorbs the difference). `padS` is what
 * will still be pause, which is worth telling the user about when the rate
 * bound stops it reaching zero.
 */
export function planFit(srcS, dubS, {
  trimDeadAir = true, deadAirS = 0.15,
  maxSqueeze = FIT_MAX_RATE, maxSpeed = 2, minSpeed = 0.5,
} = {}) {
  if (!(srcS > 0) || !(dubS > 0)) return { mode: 'fit', rate: 1, outS: srcS || 0, padS: 0 };

  // Longer than the hole: squeeze while that stays inaudible, otherwise give
  // it the seconds and let the section slow down.
  if (dubS > srcS) {
    if (dubS / srcS <= maxSqueeze) return { mode: 'fit', rate: 1, outS: srcS, padS: 0 };
    const rate = Math.max(minSpeed, srcS / dubS);
    return { mode: 'natural', rate, outS: srcS / rate, padS: Math.max(0, srcS / rate - dubS) };
  }

  // Shorter: how much of the leftover pause is allowed to remain?
  const allowed = trimDeadAir ? dubS + Math.max(0, deadAirS) : srcS;
  if (srcS <= allowed + 1e-6) return { mode: 'fit', rate: 1, outS: srcS, padS: srcS - dubS };
  const rate = Math.min(maxSpeed, srcS / allowed);
  const outS = srcS / rate;
  return { mode: 'natural', rate, outS, padS: Math.max(0, outS - dubS) };
}
