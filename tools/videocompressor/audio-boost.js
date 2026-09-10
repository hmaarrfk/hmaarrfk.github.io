// Audio boost — pure math, no DOM/WebCodecs. Used by compressor.js (live
// preview + encode) and testable standalone (e.g. under Node) since it only
// touches plain Float32Arrays.
//
// The "auto" mode measures loudness in the human-voice band rather than the
// full signal, so a quiet voice track isn't judged by a single loud
// non-voice transient (a click, a door, a peak of hiss). It then applies a
// flat makeup gain (never negative — this only rescues weak audio, it never
// turns anything down) through a soft-knee limiter so the rare loud moment
// saturates gently instead of clipping.

export function dbToLinear(db) {
  return Math.pow(10, db / 20);
}

export function linearToDb(x) {
  return 20 * Math.log10(Math.max(1e-9, Math.abs(x)));
}

// Cascaded one-pole high-pass + low-pass approximating a voice-band
// bandpass filter (~300–3400 Hz, the classic telephone band where speech
// intelligibility lives). Good enough to separate "voice energy" from
// rumble/hum and hiss/sibilance — not a precision filter.
export function voiceBandpass(samples, sampleRate, loHz = 300, hiHz = 3400) {
  const out = new Float32Array(samples.length);

  // One-pole high-pass (remove content below loHz).
  const rcHi = 1 / (2 * Math.PI * loHz);
  const alphaHi = rcHi / (rcHi + 1 / sampleRate);
  let prevIn = 0, prevOutHi = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i];
    const y = alphaHi * (prevOutHi + x - prevIn);
    prevOutHi = y;
    prevIn = x;
    out[i] = y;
  }

  // One-pole low-pass (remove content above hiHz).
  const rcLo = 1 / (2 * Math.PI * hiHz);
  const alphaLo = (1 / sampleRate) / (rcLo + 1 / sampleRate);
  let prevOutLo = 0;
  for (let i = 0; i < out.length; i++) {
    prevOutLo += alphaLo * (out[i] - prevOutLo);
    out[i] = prevOutLo;
  }

  return out;
}

// A percentile of the windowed RMS (in dBFS) across the whole track — the
// loudness of its *loud parts* (sustained speech, not the pauses between
// words). A percentile adapts to whatever noise floor this specific
// recording has; an absolute silence gate does not — on a very quiet
// recording (mean well under -50 dBFS) an absolute gate can leave almost
// nothing above it, so a stray non-voice transient becomes "the voice
// level" by default. `activeFraction` reports how much of the track sits
// within 20 dB of that loud level, as a rough measure of how much of the
// recording actually carries voice-level energy.
export function activeRmsDbfs(samples, sampleRate, opts = {}) {
  const windowSec = opts.windowSec ?? 0.05;
  const percentile = opts.percentile ?? 0.9;
  const win = Math.max(1, Math.round(windowSec * sampleRate));

  const dbs = [];
  for (let i = 0; i < samples.length; i += win) {
    const end = Math.min(samples.length, i + win);
    let sum = 0;
    for (let j = i; j < end; j++) sum += samples[j] * samples[j];
    dbs.push(linearToDb(Math.sqrt(sum / Math.max(1, end - i))));
  }
  if (!dbs.length) return { dbfs: -90, activeFraction: 0 };

  dbs.sort((a, b) => a - b);
  const dbfs = dbs[Math.min(dbs.length - 1, Math.floor(percentile * dbs.length))];
  const activeFraction = dbs.filter((d) => d > dbfs - 20).length / dbs.length;
  return { dbfs, activeFraction };
}

// How many dB to add so the measured voice level reaches `targetDbfs`.
// Clamped to [0, maxGainDb] — never turns audio down, never boosts an
// already-loud track, and never runs away on a near-silent/empty track.
export function computeAutoGainDb(voiceDbfs, opts = {}) {
  const target = opts.targetDbfs ?? -20;
  const maxGain = opts.maxGainDb ?? 24;
  const gain = target - voiceDbfs;
  if (!isFinite(gain)) return 0;
  return Math.min(maxGain, Math.max(0, gain));
}

// Soft-knee limiter: transparent below `ceiling`, saturates smoothly toward
// full scale above it. Lets a gain sized for quiet voice coexist with a rare
// loud transient without hard-clipping it.
export function softLimit(x, ceiling = 0.89) {
  const ax = Math.abs(x);
  if (ax <= ceiling) return x;
  const sign = x < 0 ? -1 : 1;
  const range = 1 - ceiling;
  const over = (ax - ceiling) / range;
  return sign * (ceiling + range * Math.tanh(over));
}

// Apply a linear gain to a whole buffer, through the limiter, in place.
export function applyGainInPlace(samples, gainLinear, ceiling = 0.89) {
  if (gainLinear === 1) return samples;
  for (let i = 0; i < samples.length; i++) samples[i] = softLimit(samples[i] * gainLinear, ceiling);
  return samples;
}

// End-to-end: measure the voice-band level of a (mono-mixed) buffer and
// return the gain that would rescue it, plus the measurement itself.
export function analyzeVoiceLevel(monoSamples, sampleRate, opts = {}) {
  const band = voiceBandpass(monoSamples, sampleRate, opts.loHz, opts.hiHz);
  const { dbfs, activeFraction } = activeRmsDbfs(band, sampleRate, opts);
  const autoGainDb = computeAutoGainDb(dbfs, opts);
  return { voiceDbfs: dbfs, activeFraction, autoGainDb };
}
