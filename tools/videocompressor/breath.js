// Breath detection — pure math, no DOM/WebCodecs, so it runs under Node too
// (see breath.test.mjs).
//
// A breath is not noise, which is why noise removers don't touch it: it's a
// real, wanted-looking signal sitting in the gaps between phrases. What sets it
// apart from speech is its *character* rather than its level:
//
//   * it lives where nobody is talking, at a level above the room's floor but
//     well below the voice;
//   * it's broadband and unvoiced, so its energy tilts high and it crosses zero
//     far more often than a voiced vowel does;
//   * it lasts a tenth of a second to a second or so — longer than a click,
//     shorter than a passage of speech. The floor is deliberately low: on a
//     real 10-minute screencast a seventh of the breaths were 0.10–0.14 s, and
//     measured identically to the longer ones (the same high-frequency tilt,
//     zero-crossing rate and crest factor), so a higher floor drops real
//     breaths rather than junk. A click is excluded by its shape, not by
//     length — it peaks instantly and has a far higher crest factor.
//
// It also has to stand clear of the speech around it. A word's trailing
// sibilance ("...results") is unvoiced, noise-like and quiet — a breath by
// every other measure — so anything within `guardSec` of a speech frame is left
// alone. Ducking those tails is what makes a de-breather sound like a lisp, and
// a real breath is taken a beat after the phrase anyway.
//
// Testing all three keeps quiet *speech* from being mistaken for a breath,
// which is the failure mode of a plain noise gate: gate on level alone and you
// chew the beginnings and ends of words.
//
// What comes back is a list of { start, end } in seconds. Deciding what to do
// with them — duck, shorten — is the caller's business.

const FRAME_SEC = 0.02;

// Rough split of a frame's energy above/below ~2 kHz, via a one-pole high-pass.
// Breath is hiss-like and tilts high; a vowel does not.
function highpassInPlace(out, samples, sampleRate, hz) {
  const rc = 1 / (2 * Math.PI * hz);
  const alpha = rc / (rc + 1 / sampleRate);
  let prevIn = 0, prevOut = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = alpha * (prevOut + x - prevIn);
    out[i] = y;
    prevOut = y;
    prevIn = x;
  }
}

function percentile(sorted, p) {
  if (!sorted.length) return -90;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

const toDb = (x) => 20 * Math.log10(Math.max(1e-9, x));

/**
 * @param {Float32Array} mono      the whole track, mono
 * @param {number} sampleRate
 * @param {object} [opts]
 *   speechBelowDb  how far under the speech level a breath must sit (default 14)
 *   floorAboveDb   how far over the room floor it must sit (default 8)
 *   minSec/maxSec  plausible breath length (default 0.1 / 2.0)
 *   hfRatioMin     minimum share of energy above ~2 kHz (default 0.25)
 *   zcrMin         minimum zero-crossing rate, per second (default 1500)
 * @returns {{ breaths: {start:number,end:number}[], speechDb:number, floorDb:number }}
 */
export function detectBreaths(mono, sampleRate, opts = {}) {
  const {
    speechBelowDb = 14,
    floorAboveDb = 8,
    minSec = 0.1,
    maxSec = 2.0,
    hfRatioMin = 0.25,
    zcrMin = 1500,
    joinSec = 0.06,
    guardSec = 0.1,
  } = opts;

  const frameLen = Math.max(32, Math.round(FRAME_SEC * sampleRate));
  const count = Math.floor(mono.length / frameLen);
  if (count < 3) return { breaths: [], speechDb: -90, floorDb: -90 };

  const hf = new Float32Array(mono.length);
  highpassInPlace(hf, mono, sampleRate, 2000);

  const db = new Float32Array(count);
  const hfRatio = new Float32Array(count);
  const zcr = new Float32Array(count);

  for (let f = 0; f < count; f++) {
    const base = f * frameLen;
    let sum = 0, sumHf = 0, crossings = 0;
    let prev = mono[base];
    for (let i = 0; i < frameLen; i++) {
      const x = mono[base + i], h = hf[base + i];
      sum += x * x;
      sumHf += h * h;
      if ((x >= 0) !== (prev >= 0)) crossings++;
      prev = x;
    }
    db[f] = toDb(Math.sqrt(sum / frameLen));
    hfRatio[f] = sum > 1e-12 ? sumHf / sum : 0;
    zcr[f] = crossings / FRAME_SEC;
  }

  const sorted = Array.from(db).sort((a, b) => a - b);
  const speechDb = percentile(sorted, 90);
  const floorDb = percentile(sorted, 10);

  // Anything near the voice's own level is speech, and gets a small guard band
  // either side so a word's quiet onset is never handed to the ducker.
  const speechCut = speechDb - speechBelowDb;
  const guard = Math.max(1, Math.round(guardSec / FRAME_SEC));
  const isSpeech = new Uint8Array(count);
  for (let f = 0; f < count; f++) if (db[f] > speechCut) isSpeech[f] = 1;
  const speechGuarded = new Uint8Array(count);
  for (let f = 0; f < count; f++) {
    if (!isSpeech[f]) continue;
    for (let g = Math.max(0, f - guard); g <= Math.min(count - 1, f + guard); g++) speechGuarded[g] = 1;
  }

  const candidate = new Uint8Array(count);
  for (let f = 0; f < count; f++) {
    if (speechGuarded[f]) continue;
    if (db[f] <= floorDb + floorAboveDb) continue;     // that's just the room
    if (hfRatio[f] < hfRatioMin && zcr[f] < zcrMin) continue;   // too tonal to be a breath
    candidate[f] = 1;
  }

  // Group into runs, join ones separated by a hair, then apply the length test.
  const runs = [];
  let f = 0;
  while (f < count) {
    if (!candidate[f]) { f++; continue; }
    let end = f;
    while (end + 1 < count && candidate[end + 1]) end++;
    runs.push({ from: f, to: end + 1 });   // [from, to) in frames
    f = end + 1;
  }
  const joinFrames = Math.max(1, Math.round(joinSec / FRAME_SEC));
  const merged = [];
  for (const r of runs) {
    const last = merged[merged.length - 1];
    if (last && r.from - last.to <= joinFrames) last.to = r.to;
    else merged.push({ ...r });
  }

  // A breath *starts from the room*: you finish the phrase, the level falls to
  // the floor, then you inhale. A word's dying tail instead arrives already
  // loud and keeps falling — at the very same level a breath sits at, which is
  // why nothing measured within the region itself can tell them apart. Looking
  // at what came immediately before can: require the level to have actually
  // reached the floor first.
  const backLook = 2;
  const cameFromFloor = (from) => {
    if (from < backLook) return true;
    for (let g = Math.max(0, from - backLook); g < from; g++) {
      if (db[g] <= floorDb + floorAboveDb) return true;
    }
    return false;
  };

  const breaths = [];
  for (const r of merged) {
    const start = (r.from * frameLen) / sampleRate;
    const end = (r.to * frameLen) / sampleRate;
    const dur = end - start;
    if (dur < minSec || dur > maxSec) continue;
    if (!cameFromFloor(r.from)) continue;      // a tail, not a breath
    breaths.push({ start, end });
  }
  return { breaths, speechDb, floorDb };
}

/**
 * Apply the ducking to interleaved audio, in place, with short ramps so a
 * breath fades down instead of switching off (a hard edge is audible as a
 * click, and pumps any room tone).
 *
 * `regions` are in seconds on the same timeline as `startSec`.
 */
export function duckRegions(interleaved, channels, sampleRate, startSec, regions, gainDb, rampSec = 0.015) {
  if (!regions.length || gainDb >= -0.01) return interleaved;
  const g = Math.pow(10, gainDb / 20);
  const frames = interleaved.length / channels;
  const ramp = Math.max(1, Math.round(rampSec * sampleRate));
  const endSec = startSec + frames / sampleRate;

  for (const r of regions) {
    if (r.end <= startSec || r.start >= endSec) continue;
    const a = Math.round((r.start - startSec) * sampleRate);
    const b = Math.round((r.end - startSec) * sampleRate);
    for (let i = Math.max(0, a); i < Math.min(frames, b); i++) {
      // 1 at the edges, `g` in the middle.
      const into = i - a, left = b - i;
      const t = Math.min(into, left) / ramp;
      const k = t >= 1 ? g : 1 + (g - 1) * Math.max(0, t);
      const base = i * channels;
      for (let c = 0; c < channels; c++) interleaved[base + c] *= k;
    }
  }
  return interleaved;
}
