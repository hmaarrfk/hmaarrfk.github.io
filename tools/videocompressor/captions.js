// Auto-captions — the pure helpers behind the Video Compressor's burned-in
// captions. No DOM, no WebCodecs, no model: resampling, chunk planning,
// word -> cue grouping, and drawing a cue onto any 2D canvas context. That
// keeps them usable standalone (e.g. under Node, fed PCM from ffmpeg) to
// sanity-check the logic outside the browser, like audio-boost.js.
//
// The speech model itself (Whisper, via transformers.js) runs in
// captions-worker.js; compressor.js wires the two together.

export const ASR_SAMPLE_RATE = 16000;   // what Whisper expects: 16 kHz mono

// ---------------------------------------------------------------------------
// Streaming resampler: any rate -> 16 kHz mono. A box low-pass one output
// period wide (so 48 kHz -> 16 kHz averages 3 samples) knocks down most of
// what would alias, then linear interpolation picks the output samples.
// Crude by audio-engineering standards, plenty for speech recognition.
// ---------------------------------------------------------------------------
export function createResampler(inRate, outRate = ASR_SAMPLE_RATE) {
  const step = inRate / outRate;               // input samples per output sample
  const taps = Math.max(1, Math.round(step));
  let carry = new Float32Array(0);             // unconsumed input (plus filter history)
  let base = 0;                                // absolute input index of carry[0]
  let next = 0;                                // absolute (fractional) input index of the next output sample

  const box = (buf, i) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - taps + 1); k <= i; k++) { sum += buf[k]; n++; }
    return n ? sum / n : 0;
  };

  return {
    push(input) {
      const buf = new Float32Array(carry.length + input.length);
      buf.set(carry, 0);
      buf.set(input, carry.length);
      const out = new Float32Array(Math.ceil((buf.length + 1) / step) + 1);
      let n = 0;
      for (;;) {
        const whole = Math.floor(next);
        const i = whole - base;
        if (i + 1 >= buf.length) break;
        const a = box(buf, i), b = box(buf, i + 1);
        out[n++] = a + (b - a) * (next - whole);
        next += step;
      }
      const keepFrom = clampInt(Math.floor(next) - base - taps, 0, buf.length);
      carry = buf.slice(keepFrom);
      base += keepFrom;
      return out.subarray(0, n);
    },
  };
}

// ---------------------------------------------------------------------------
// Chunk planning. Whisper hears at most 30 s at a time, so long audio is cut
// into *overlapping* windows: every window repeats the last `overlapS`
// seconds of the one before it. Nothing is then heard only at a window edge,
// where the model is at its worst and where it would start a fresh sentence
// mid-phrase. The doubled-up seconds are thrown away again by
// mergeChunkWords(). Near-silent windows are flagged so the caller can skip
// them (Whisper famously "hears" phrases like "Thank you." in silence).
// ---------------------------------------------------------------------------
export function planChunks(audio, sampleRate = ASR_SAMPLE_RATE, { windowS = 29, overlapS = 5, silentDb = -50 } = {}) {
  const win = Math.round(windowS * sampleRate);
  const hop = Math.max(1, win - Math.round(overlapS * sampleRate));
  const chunks = [];
  for (let start = 0; ; start += hop) {
    const end = Math.min(audio.length, start + win);
    chunks.push({ start, end, silent: rmsDb(audio, start, end) < silentDb });
    if (end >= audio.length) break;
  }
  return chunks;
}

// Stitch the per-window word lists back into one transcript. Each seam gets a
// single junction time, and every word falls on exactly one side of it (by its
// own midpoint), so nothing is duplicated and nothing is dropped — including a
// word that straddles the seam. The junction prefers, in order: just after the
// last sentence ending inside the overlap, the middle of the longest pause
// there, or failing both, the middle of the overlap.
//
// Windows still being transcribed are simply absent; call this again as each
// one lands (it's cheap, and a seam can only be placed once both sides exist).
export function mergeChunkWords(wordsByChunk, chunks, sampleRate = ASR_SAMPLE_RATE, { minPauseS = 0.25 } = {}) {
  const out = [];
  let from = -Infinity;
  for (let i = 0; i < chunks.length; i++) {
    const words = wordsByChunk[i] || [];
    const next = wordsByChunk[i + 1];
    const to = (i + 1 < chunks.length && Array.isArray(next))
      ? junctionTime(words, next, chunks[i + 1].start / sampleRate, chunks[i].end / sampleRate, minPauseS)
      : Infinity;
    for (const w of words) {
      const mid = (w.start + w.end) / 2;
      if (mid >= from && mid < to) out.push(w);
    }
    from = to;
  }
  return out;
}

function junctionTime(a, b, overlapStart, overlapEnd, minPauseS) {
  const inOverlap = (w) => w.end > overlapStart && w.start < overlapEnd;
  // 1. the end of a sentence — the most natural place to hand over
  let sentenceEnd = null;
  for (const list of [a, b]) {
    for (const w of list || []) {
      if (!inOverlap(w) || w.end >= overlapEnd) continue;
      if (/[.?!…]["')\]]?$/.test((w.text || '').trim())) sentenceEnd = Math.max(sentenceEnd ?? -Infinity, w.end);
    }
  }
  if (sentenceEnd != null) return sentenceEnd + 1e-3;
  // 2. the middle of the longest pause
  let bestGap = 0, bestAt = null;
  for (const list of [a, b]) {
    const ws = (list || []).filter(inOverlap);
    for (let i = 1; i < ws.length; i++) {
      const gap = ws[i].start - ws[i - 1].end;
      const at = (ws[i - 1].end + ws[i].start) / 2;
      if (gap > bestGap && at > overlapStart && at < overlapEnd) { bestGap = gap; bestAt = at; }
    }
  }
  if (bestAt != null && bestGap >= minPauseS) return bestAt;
  // 3. nothing to go on — split the difference
  return (overlapStart + overlapEnd) / 2;
}

function rmsDb(a, s, e) {
  let sum = 0;
  for (let i = s; i < e; i++) sum += a[i] * a[i];
  const rms = Math.sqrt(sum / Math.max(1, e - s));
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

// ---------------------------------------------------------------------------
// Words -> cues. Whisper gives per-word timestamps; captions want short
// readable phrases. A cue closes when it would grow past `maxChars` (about
// two lines), past `maxDur` seconds, at a pause, or at the end of a sentence
// once it's long enough to stand on its own.
// ---------------------------------------------------------------------------
//
// Whisper marks where a new word begins with a leading space; a piece
// without one ("'hui" after "aujourd", "-page" after "90", or any word in a
// language written without spaces) attaches to the previous piece as-is.
export function wordsToCues(words, { maxChars = 84, maxDur = 6, gapS = 0.7, minSentence = 24, minDur = 0.8, holdS = 0.4 } = {}) {
  const cues = [];
  let cur = null;
  const close = () => { if (cur && cur.text) cues.push(cur); cur = null; };
  for (const w of words) {
    const raw = w.text || '';
    const t = raw.trim();
    if (!t) continue;
    const glue = /^\s/.test(raw) ? ' ' : '';
    if (cur && glue) {   // only break a cue between words, never inside one
      const joined = `${cur.text} ${t}`;
      if (joined.length > maxChars || w.end - cur.start > maxDur || w.start - cur.end > gapS ||
          (/[.?!…]["')\]]?$/.test(cur.text) && cur.text.length >= minSentence)) close();
    }
    if (!cur) cur = { start: w.start, end: w.end, text: t };
    else { cur.text += glue + t; cur.end = Math.max(cur.end, w.end); }
  }
  close();
  // Give very short cues time to be read, and bridge small gaps so the
  // captions don't flicker off between phrases — never overlapping the next.
  for (let i = 0; i < cues.length; i++) {
    const nextStart = i + 1 < cues.length ? cues[i + 1].start : Infinity;
    const want = Math.max(cues[i].end + holdS, cues[i].start + minDur);
    cues[i].end = Math.max(cues[i].end, Math.min(want, nextStart));
  }
  return cues;
}

// The cue showing at time t (cues sorted by start), or null.
export function cueAt(cues, t) {
  let lo = 0, hi = cues.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return found >= 0 && t < cues[found].end ? cues[found] : null;
}

// ---------------------------------------------------------------------------
// Drawing. One function paints a cue for both the live preview overlay and
// the frames being encoded, so what you see is exactly what gets burned in.
// Size is relative to the picture's shorter side, so portrait and landscape
// video get the same-looking captions.
// ---------------------------------------------------------------------------
export const CAPTION_SIZES = { small: 0.045, medium: 0.06, large: 0.08 };
const FONT_STACK = 'system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';

export function wrapLines(ctx, text, maxWidth) {
  const lines = [];
  let line = '';
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const test = line ? `${line} ${word}` : word;
    if (line && ctx.measureText(test).width > maxWidth) { lines.push(line); line = word; }
    else line = test;
  }
  if (line) lines.push(line);
  return lines;
}

// Paint `text` as a caption into the picture rectangle (x, y, w, h).
export function drawCaption(ctx, text, x, y, w, h, { size = 'medium', position = 'bottom' } = {}) {
  if (!text) return;
  const px = Math.max(10, Math.round(Math.min(w, h) * (CAPTION_SIZES[size] || CAPTION_SIZES.medium)));
  ctx.save();
  ctx.font = `600 ${px}px ${FONT_STACK}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const lines = wrapLines(ctx, text, w * 0.88);
  const lineH = Math.round(px * 1.3);
  const padX = Math.round(px * 0.4);
  const margin = Math.round(h * 0.06);
  const blockH = lines.length * lineH;
  const top = position === 'top' ? y + margin : y + h - margin - blockH;
  const cx = x + w / 2;
  lines.forEach((ln, i) => {
    const cy = top + i * lineH + lineH / 2;
    const tw = ctx.measureText(ln).width;
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(Math.round(cx - tw / 2 - padX), Math.round(cy - lineH / 2), Math.round(tw + 2 * padX), lineH);
    ctx.fillStyle = '#fff';
    ctx.fillText(ln, cx, cy);
  });
  ctx.restore();
}

function clampInt(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
