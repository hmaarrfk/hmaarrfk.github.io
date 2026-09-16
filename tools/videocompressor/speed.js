// Time compression for sped-up sections, pitch preserved.
//
// Playing a section faster by resampling would raise its pitch — a 2× narration
// turns into a chipmunk. WSOLA (waveform-similarity overlap-add) instead throws
// away whole *pitch periods*: it copies short overlapping windows out of the
// input, slides each one to wherever it best matches what was already written,
// and overlap-adds them. The periods that survive keep their original
// wavelength, so the voice keeps its pitch and simply says the same thing in
// less time.
//
// Everything works on interleaved Float32 audio — what the encoder takes — and
// streams: feed it whatever the decoder hands over, take out whatever is ready,
// and `flush()` at the end of the section.

const WINDOW_MS = 40;   // ~2 pitch periods of a low (80 Hz) voice
const SEARCH_MS = 12;   // how far a window may slide looking for a better match

export function createTimeStretcher({ sampleRate, channels, speed }) {
  const N = Math.max(64, Math.round((WINDOW_MS / 1000) * sampleRate)) & ~1;
  const half = N >> 1;                              // 50% overlap
  const search = Math.max(1, Math.round((SEARCH_MS / 1000) * sampleRate));
  const hop = Math.max(1, Math.round(half * speed));   // how far to advance in the input

  // Two Hann halves overlapped at 50% sum to 1, so overlap-add neither boosts
  // nor dips the level.
  const win = new Float32Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (N - 1)));

  let buf = new Float32Array(0);     // interleaved input not yet consumed
  let bufStart = 0;                  // absolute frame index of buf[0]
  // Where the next window *should* start, advanced by exactly `hop` every time.
  // The similarity search may read from a few ms either side of it, but never
  // moves this — otherwise each window's offset would feed into the next and
  // the section would drift away from the speed that was asked for.
  let ideal = 0;
  let tail = null;                   // windowed second half of the previous window
  let tailMono = null;               // ...and its mono mixdown, for the search

  const frames = (a) => a.length / channels;
  const available = () => bufStart + frames(buf);

  const monoAt = (frame) => {
    let sum = 0;
    const o = frame * channels;
    for (let c = 0; c < channels; c++) sum += buf[o + c];
    return sum / channels;
  };

  // Slide the window ±search and keep the position whose opening best matches
  // the tail it has to overlap-add with. Normalised, so a loud stretch doesn't
  // win on volume alone.
  function bestOffset(want) {
    const lo = Math.max(bufStart, want - search);
    const hi = Math.min(available() - N, want + search);
    if (!tailMono || hi <= lo) return Math.max(bufStart, Math.min(available() - N, want));
    let bestAt = want, best = -Infinity;
    for (let cand = lo; cand <= hi; cand++) {
      let dot = 0, energy = 1e-9;
      for (let i = 0; i < half; i += 2) {     // every other frame: same shape, half the work
        const x = monoAt(cand - bufStart + i);
        dot += tailMono[i] * x;
        energy += x * x;
      }
      const score = dot / Math.sqrt(energy);
      if (score > best) { best = score; bestAt = cand; }
    }
    return bestAt;
  }

  // One window: emit its first half overlap-added onto the carried tail, and
  // carry its second half forward.
  function emitWindow(at, out) {
    const base = (at - bufStart) * channels;
    const piece = new Float32Array(half * channels);
    for (let i = 0; i < half; i++) {
      for (let c = 0; c < channels; c++) {
        const x = buf[base + i * channels + c] * win[i];
        piece[i * channels + c] = x + (tail ? tail[i * channels + c] : 0);
      }
    }
    const next = new Float32Array(half * channels);
    const nextMono = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      let sum = 0;
      for (let c = 0; c < channels; c++) {
        const x = buf[base + (i + half) * channels + c] * win[i + half];
        next[i * channels + c] = x;
        sum += x;
      }
      nextMono[i] = sum / channels;
    }
    out.push(piece);
    tail = next;
    tailMono = nextMono;
    ideal += hop;
    // Drop input no window can reach any more.
    const keepFrom = Math.max(bufStart, Math.min(ideal, available()) - search - 1);
    const drop = keepFrom - bufStart;
    if (drop > 0) { buf = buf.slice(drop * channels); bufStart += drop; }
  }

  return {
    /** Feed interleaved input; returns whatever output is ready (may be empty). */
    process(interleaved) {
      if (interleaved && interleaved.length) {
        const merged = new Float32Array(buf.length + interleaved.length);
        merged.set(buf, 0);
        merged.set(interleaved, buf.length);
        buf = merged;
      }
      const out = [];
      // Keep a search window's worth of slack so the match can look ahead.
      while (available() - ideal >= N + search) emitWindow(bestOffset(Math.round(ideal)), out);
      return concat(out);
    },

    /** Everything still buffered, once no more input is coming. */
    flush() {
      const out = [];
      while (available() - ideal >= N) emitWindow(Math.min(Math.round(ideal), available() - N), out);
      if (tail) { out.push(tail); tail = null; tailMono = null; }
      buf = new Float32Array(0);
      return concat(out);
    },
  };

  function concat(parts) {
    let total = 0;
    for (const p of parts) total += p.length;
    const out = new Float32Array(total);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
}
