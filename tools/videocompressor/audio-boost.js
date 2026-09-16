// Audio boost — pure math, no DOM/WebCodecs. Used by compressor.js (live
// preview + encode) and testable standalone (e.g. under Node) since it only
// touches plain Float32Arrays.
//
// The "auto" mode measures loudness in the human-voice band rather than the
// full signal, so a quiet voice track isn't judged by a single loud
// non-voice transient (a click, a door, a peak of hiss): analyzeVoiceLevel()
// reports that measurement as a single number, for the UI hint. The actual
// runtime processing (createLeveler()) is a small lookahead AGC driven by
// that same voice-band detector — it rides the gain up during quiet voice
// and pulls it back down, automatically, the moment anything gets loud (a
// jingle, a shout), so a flat gain sized for whispered speech can't blast a
// loud passage through the roof. Gain only ever goes up, never down.

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
  const target = opts.targetDbfs ?? -12;
  const maxGain = opts.maxGainDb ?? 36;
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
// return the gain that would rescue it, plus the measurement itself. Used
// for the one-shot whole-track analysis that drives the "Auto" UI hint and
// caps how far createLeveler() is allowed to boost (below).
export function analyzeVoiceLevel(monoSamples, sampleRate, opts = {}) {
  const band = voiceBandpass(monoSamples, sampleRate, opts.loHz, opts.hiHz);
  const { dbfs, activeFraction } = activeRmsDbfs(band, sampleRate, opts);
  const autoGainDb = computeAutoGainDb(dbfs, opts);
  return { voiceDbfs: dbfs, activeFraction, autoGainDb };
}

// Streaming counterpart to voiceBandpass() — same one-pole cascade, but
// carries its filter state across calls instead of resetting it each time,
// so it can be fed a track in chunks as it's decoded. Returns a function you
// call once per chunk, in order.
export function createVoiceBandpassStream(sampleRate, loHz = 300, hiHz = 3400) {
  const rcHi = 1 / (2 * Math.PI * loHz);
  const alphaHi = rcHi / (rcHi + 1 / sampleRate);
  const rcLo = 1 / (2 * Math.PI * hiHz);
  const alphaLo = (1 / sampleRate) / (rcLo + 1 / sampleRate);
  let prevIn = 0, prevOutHi = 0, prevOutLo = 0;

  return function processChunk(mono) {
    const out = new Float32Array(mono.length);
    for (let i = 0; i < mono.length; i++) {
      const x = mono[i];
      const yHi = alphaHi * (prevOutHi + x - prevIn);
      prevOutHi = yHi;
      prevIn = x;
      prevOutLo += alphaLo * (yHi - prevOutLo);
      out[i] = prevOutLo;
    }
    return out;
  };
}

// A voice-aware *leveler* (a lookahead automatic gain control), for the
// "auto" mode's actual runtime processing — as opposed to the single static
// number analyzeVoiceLevel() reports for the UI hint. A single flat gain
// sized to rescue whispered speech will just as happily blast a loud
// passage (a music jingle, a shout) straight through a limiter into audible
// distortion — even a *soft* one, if it's asked to absorb 10+ dB of sudden
// overshoot instantly, saturates hard enough to flatten the waveform.
//
// This instead delays the audio by a few milliseconds (`lookaheadSec`) past
// its own gain detector: the detector reacts to the *live*, undelayed
// signal, so by the time a given sample reaches the front of that short
// delay line and is actually output, the gain has already had a head start
// to ease down smoothly to meet it — the transient's shape is preserved
// (just quieter), instead of being clamped at the last instant. Two
// envelope followers drive the detector: the voice-band envelope decides
// how much boost quiet speech *wants*; the broadband envelope caps that
// want so the output can't exceed `ceiling`, regardless of how loud the
// untouched source already was. The applied gain is clamped to >= 1x, so
// (like the static gain) this only ever turns audio up, never down — on an
// already-loud passage it simply stops boosting rather than attenuating.
//
// Stateful and introduces `lookaheadSec` of audio delay: create one
// instance per track, feed it every chunk in order via process(), and call
// flush() once at the end to drain the last bit of buffered audio.
export function createLeveler(sampleRate, opts = {}) {
  const targetLinear = dbToLinear(opts.targetDbfs ?? -12);
  const maxGainLinear = dbToLinear(opts.maxGainDb ?? 36);
  const ceiling = opts.ceiling ?? 0.89;   // ~-1 dBFS
  const timeConst = (sec) => Math.exp(-1 / (Math.max(1e-4, sec) * sampleRate));
  // Attack can be fast (it no longer has to protect anything by itself —
  // the lookahead delay does that) so it settles well within the lookahead
  // window; release stays slow so boost doesn't pump between words.
  const attackCoef = timeConst(opts.attackSec ?? 0.005);
  const releaseCoef = timeConst(opts.releaseSec ?? 0.6);
  const envAttackCoef = timeConst(opts.envAttackSec ?? 0.002);
  const envReleaseCoef = timeConst(opts.envReleaseSec ?? 0.2);
  const lookaheadFrames = Math.max(1, Math.round((opts.lookaheadSec ?? 0.015) * sampleRate));
  // Sit this far under the loudest recent voice and nobody is talking, so there
  // is nothing worth turning up: hold the gain where it is rather than riding
  // it toward the ceiling. Without this the gaps are exactly where the AGC has
  // the most room to push, so it amplifies breaths, room tone and keyboard
  // noise — and the quieter the recording, the louder they get. Gain may still
  // come *down* here, so the limiter keeps working.
  //
  // The reference is measured here, from the same envelope the gain is computed
  // from, rather than taken from the caller: a level measured any other way
  // (say, a bandpassed percentile over the whole track) is on a different
  // scale, and comparing across the two silently does nothing.
  const holdRange = dbToLinear(-(opts.holdRangeDb ?? 18));
  const voicePeakAttack = timeConst(opts.voicePeakAttackSec ?? 0.05);
  const voicePeakRelease = timeConst(opts.voicePeakReleaseSec ?? 30);
  let voicePeak = 0;

  const bandpass = createVoiceBandpassStream(sampleRate, opts.loHz, opts.hiHz);
  let voiceEnv = 0, peakEnv = 0, gain = 1;

  let channels = 0;
  let ring = null;          // circular buffer of raw (undelayed) interleaved samples
  let ringPos = 0;          // next write slot, in frames
  let framesBuffered = 0;   // valid frames currently sitting in the ring (<= lookaheadFrames)

  const stepEnv = (env, abs, attack, release) => {
    const a = abs > env ? attack : release;
    return a * env + (1 - a) * abs;
  };

  return {
    // Consumes one chunk of raw, interleaved `numberOfChannels`-wide PCM
    // (`mono` is a same-length mono mixdown of it) and returns a *new*
    // Float32Array of gained+limited output — shorter than the input while
    // the lookahead buffer is still filling (right at track start), the
    // same length from then on. Never mutates its inputs.
    process(interleaved, numberOfChannels, mono) {
      if (!ring) { channels = numberOfChannels; ring = new Float32Array(lookaheadFrames * channels); }
      const band = bandpass(mono);
      const n = mono.length;
      const output = new Float32Array(n * channels);   // upper bound; sliced to the real length below
      let outFrames = 0;

      for (let i = 0; i < n; i++) {
        voiceEnv = stepEnv(voiceEnv, Math.abs(band[i]), envAttackCoef, envReleaseCoef);

        let bAbs = 0;
        const srcBase = i * channels;
        for (let c = 0; c < channels; c++) { const a = Math.abs(interleaved[srcBase + c]); if (a > bAbs) bAbs = a; }
        peakEnv = stepEnv(peakEnv, bAbs, envAttackCoef, envReleaseCoef);

        // Remembers the level of speech across a gap (slow release), so the
        // hold still knows what "talking" sounded like a second ago.
        voicePeak = stepEnv(voicePeak, voiceEnv, voicePeakAttack, voicePeakRelease);

        const desired = Math.min(maxGainLinear, targetLinear / Math.max(1e-6, voiceEnv));
        const headroom = ceiling / Math.max(1e-6, peakEnv);
        let wanted = Math.max(1, Math.min(desired, headroom));
        if (voiceEnv < voicePeak * holdRange) {
          // Nobody is talking. Don't push any further, and come back to the
          // gain the recent speech actually needed: by the time the envelope
          // has fallen this far the gain has already been climbing for a few
          // hundred ms, so holding alone would leave the gap louder than the
          // voice around it. Matching the speech gain keeps a breath exactly
          // as far below the voice as it was when it was recorded.
          const speechGain = Math.min(maxGainLinear, targetLinear / Math.max(1e-6, voicePeak));
          wanted = Math.min(wanted, gain, speechGain);
        }
        gain = (wanted < gain ? attackCoef : releaseCoef) * gain + (1 - (wanted < gain ? attackCoef : releaseCoef)) * wanted;

        // The ring slot we're about to overwrite holds the oldest buffered
        // (raw) sample — once full, every push pops one: gain it with the
        // *current* (lookahead-informed) gain and emit it.
        const ringBase = ringPos * channels;
        if (framesBuffered === lookaheadFrames) {
          const outBase = outFrames * channels;
          for (let c = 0; c < channels; c++) output[outBase + c] = softLimit(ring[ringBase + c] * gain, ceiling);
          outFrames++;
        } else {
          framesBuffered++;
        }
        for (let c = 0; c < channels; c++) ring[ringBase + c] = interleaved[srcBase + c];
        ringPos = (ringPos + 1) % lookaheadFrames;
      }

      return output.subarray(0, outFrames * channels);
    },

    // Drains the lookaheadFrames of audio still sitting in the delay line
    // at end-of-track (gained with the final settled gain). Call once,
    // after the last process() call.
    flush() {
      if (!ring || framesBuffered === 0) return new Float32Array(0);
      const out = new Float32Array(framesBuffered * channels);
      let p = (ringPos - framesBuffered + lookaheadFrames) % lookaheadFrames;
      for (let k = 0; k < framesBuffered; k++) {
        const ringBase = p * channels, outBase = k * channels;
        for (let c = 0; c < channels; c++) out[outBase + c] = softLimit(ring[ringBase + c] * gain, ceiling);
        p = (p + 1) % lookaheadFrames;
      }
      framesBuffered = 0;
      return out;
    },

    currentGainDb() { return linearToDb(gain); },
  };
}
