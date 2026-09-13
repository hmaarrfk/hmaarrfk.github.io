// Auto-captions — the pure helpers behind the Video Compressor's burned-in
// captions. No DOM, no WebCodecs, no model: voice-activity detection,
// resampling, windowing, stitching, word -> cue grouping, and drawing a cue
// onto any 2D canvas context. That keeps them usable standalone (e.g. under
// Node, fed PCM from ffmpeg) to check the logic outside the browser, like
// audio-boost.js.
//
// The speech model itself (Whisper, via transformers.js) runs in
// captions-worker.js; compressor.js wires the two together.
//
// The path audio takes:
//
//   decoded audio ─► createResampler ─► 16 kHz mono
//                 ─► detectSpeech    ─► where the talking is
//                 ─► compactSpeech   ─► silences cut out, + a map back
//                 ─► planChunks      ─► <=29 s windows, overlapping
//                        (Whisper)
//                 ─► mergeChunkWords ─► one transcript, seams at sentences
//                 ─► mapCompactTime  ─► word times back on the real timeline
//                 ─► wordsToCues     ─► short, readable caption lines
//
// Cutting the silence out matters because Whisper always processes a padded
// 30 s per call: a clip that is half pauses otherwise costs twice what the
// speech in it is worth, and silence is exactly where the model invents
// phrases like "Thank you."

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
// Voice activity. Short-time energy against a noise floor measured from the
// clip itself, so it copes with hiss, room tone or a noisy camera preamp
// rather than assuming digital silence. Hysteresis (a higher bar to start
// speech than to continue it) stops it chattering on and off mid-word.
// Returns speech regions as sample indices, in order, non-overlapping.
// ---------------------------------------------------------------------------
export function detectSpeech(audio, sampleRate = ASR_SAMPLE_RATE, {
  frameS = 0.02,        // energy frame
  minSpeechS = 0.25,    // ignore blips shorter than this
  minSilenceS = 0.5,    // a pause shorter than this stays inside the speech
  padS = 0.3,           // keep this much either side, so nothing is clipped
  marginDb = 12,        // how far above the noise floor speech must rise
} = {}) {
  const frame = Math.max(1, Math.round(frameS * sampleRate));
  const nFrames = Math.floor(audio.length / frame);
  if (!nFrames) return audio.length ? [{ start: 0, end: audio.length }] : [];

  const db = new Float32Array(nFrames);
  for (let f = 0; f < nFrames; f++) db[f] = rmsDb(audio, f * frame, f * frame + frame);

  // Noise floor: the 20th percentile of frame levels (ignoring true silence,
  // which would drag an otherwise noisy floor down to -Infinity).
  const finite = Array.from(db).filter((v) => isFinite(v)).sort((a, b) => a - b);
  const floor = finite.length ? finite[Math.floor(finite.length * 0.2)] : -90;
  const enter = Math.max(floor + marginDb, -55);
  const exit = Math.max(floor + marginDb * 0.5, -60);

  const regions = [];
  let start = -1;
  for (let f = 0; f < nFrames; f++) {
    if (start < 0) { if (db[f] > enter) start = f; }
    else if (db[f] < exit) { regions.push({ start, end: f }); start = -1; }
  }
  if (start >= 0) regions.push({ start, end: nFrames });

  // Merge across short pauses, drop blips, pad, clamp, and merge again in case
  // padding made neighbours touch.
  const minSilence = Math.round(minSilenceS / frameS);
  const minSpeech = Math.round(minSpeechS / frameS);
  const merged = [];
  for (const r of regions) {
    const last = merged[merged.length - 1];
    if (last && r.start - last.end < minSilence) last.end = r.end;
    else merged.push({ ...r });
  }
  const pad = Math.round(padS * sampleRate);
  const out = [];
  for (const r of merged) {
    if (r.end - r.start < minSpeech) continue;
    const s = Math.max(0, r.start * frame - pad);
    const e = Math.min(audio.length, r.end * frame + pad);
    const last = out[out.length - 1];
    if (last && s <= last.end) last.end = Math.max(last.end, e);
    else out.push({ start: s, end: e });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Splice the speech regions together, dropping the silences between them, and
// return a map for putting word timings back on the real timeline. A short
// silence is left between regions so the model still hears a phrase boundary
// instead of two sentences rammed together.
// ---------------------------------------------------------------------------
export function compactSpeech(audio, regions, sampleRate = ASR_SAMPLE_RATE, { gapS = 0.3 } = {}) {
  const gap = Math.round(gapS * sampleRate);
  let total = 0;
  regions.forEach((r, i) => { total += (r.end - r.start) + (i ? gap : 0); });
  const out = new Float32Array(total);
  const map = [];
  let at = 0;
  regions.forEach((r, i) => {
    if (i) at += gap;                       // left as silence
    out.set(audio.subarray(r.start, r.end), at);
    map.push({ from: at, to: at + (r.end - r.start), src: r.start });
    at += r.end - r.start;
  });
  return { audio: out, map };
}

// Compacted-timeline seconds -> real seconds. Times inside a spliced-out
// silence land on the nearest edge, so nothing maps outside the speech.
export function mapCompactTime(map, t, sampleRate = ASR_SAMPLE_RATE) {
  if (!map || !map.length) return t;
  const seg = segmentAt(map, t * sampleRate);
  return mapWithin(seg, t * sampleRate, sampleRate);
}

// Map a word's [start, end] as one span. Whisper habitually stretches the
// last word of a phrase to the pause after it; on the compacted timeline
// that end can fall inside a spliced-out silence, and mapping it on its own
// would fling the word forward to the next speech region — inventing seconds
// of caption that cover a silence. Both ends are therefore resolved against
// the segment the word *starts* in, and the end is clamped to it.
export function mapCompactSpan(map, start, end, sampleRate = ASR_SAMPLE_RATE) {
  if (!map || !map.length) return { start, end: Math.max(start, end) };
  const seg = segmentAt(map, start * sampleRate);
  const s = mapWithin(seg, start * sampleRate, sampleRate);
  const e = mapWithin(seg, Math.min(end * sampleRate, seg.to), sampleRate);
  return { start: s, end: Math.max(s, e) };
}

function segmentAt(map, x) {
  for (const seg of map) if (x <= seg.to) return seg;
  return map[map.length - 1];
}

function mapWithin(seg, x, sampleRate) {
  const clamped = Math.min(Math.max(x, seg.from), seg.to);
  return (seg.src + (clamped - seg.from)) / sampleRate;
}

// ---------------------------------------------------------------------------
// Windowing. Whisper hears at most 30 s at a time. Speech runs longer than a
// window get an overlap, so no word is heard only at a window edge — where
// the model is weakest and would start a fresh sentence mid-phrase. The
// doubled seconds are thrown away again by mergeChunkWords().
// ---------------------------------------------------------------------------
export function planChunks(audio, sampleRate = ASR_SAMPLE_RATE, { windowS = 29, overlapS = 5 } = {}) {
  const win = Math.round(windowS * sampleRate);
  const hop = Math.max(1, win - Math.round(overlapS * sampleRate));
  const chunks = [];
  if (!audio.length) return chunks;
  for (let start = 0; ; start += hop) {
    const end = Math.min(audio.length, start + win);
    chunks.push({ start, end });
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
    let to = Infinity;
    if (i + 1 < chunks.length && Array.isArray(next)) {
      const overlapStart = chunks[i + 1].start / sampleRate;
      const overlapEnd = chunks[i].end / sampleRate;
      to = overlapStart >= overlapEnd
        ? (overlapEnd + overlapStart) / 2          // windows don't overlap: nothing to choose
        : junctionTime(words, next, overlapStart, overlapEnd, minPauseS);
    }
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
      if (SENTENCE_END.test((w.text || '').trim())) sentenceEnd = Math.max(sentenceEnd ?? -Infinity, w.end);
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

// ---------------------------------------------------------------------------
// Words -> cues. Whisper gives per-word timestamps; captions want short
// readable phrases. A cue closes at a pause, at the end of a sentence, or
// when it has simply grown too long — and an over-long cue is broken at the
// latest punctuation inside it rather than mid-clause.
// ---------------------------------------------------------------------------
//
// Whisper marks where a new word begins with a leading space; a piece
// without one ("'hui" after "aujourd", "-page" after "90", or any word in a
// language written without spaces) attaches to the previous piece as-is.
const SENTENCE_END = /[.?!…]["')\]]?$/;
const CLAUSE_END = /[,;:—–)]["')\]]?$/;

export function wordsToCues(words, {
  maxChars = 84, maxDur = 6, gapS = 0.7, minSentence = 24,
  minDur = 0.8, holdS = 0.4, minSplitFrac = 0.4,
} = {}) {
  const cues = [];
  let buf = [];

  const textOf = (ws) => ws.map((w, i) => (i === 0 ? '' : (/^\s/.test(w.text) ? ' ' : '')) + w.text.trim()).join('');
  const emit = (ws) => {
    if (!ws.length) return;
    const text = textOf(ws).trim();
    if (text) cues.push({ start: ws[0].start, end: ws[ws.length - 1].end, text });
  };
  // Break the pending words at `i`, keeping the rest for the next cue.
  const cutAt = (i) => { emit(buf.slice(0, i)); buf = buf.slice(i); };
  // The latest punctuation far enough in to be worth breaking at; sentence
  // endings win over commas, and length wins over nothing.
  const splitPoint = () => {
    const least = Math.ceil(buf.length * minSplitFrac);
    for (const test of [SENTENCE_END, CLAUSE_END]) {
      for (let i = buf.length - 1; i >= least; i--) if (test.test(buf[i - 1].text.trim())) return i;
    }
    return buf.length;
  };

  for (const w of words) {
    const raw = w.text || '';
    if (!raw.trim()) continue;
    const startsWord = /^\s/.test(raw) || !buf.length;
    if (buf.length && startsWord) {   // only ever break between words, never inside one
      const prev = buf[buf.length - 1];
      const text = textOf(buf);
      if (w.start - prev.end > gapS) cutAt(buf.length);                                   // a pause
      else if (SENTENCE_END.test(text) && text.length >= minSentence) cutAt(buf.length);  // a finished sentence
      else if (text.length + 1 + raw.trim().length > maxChars || w.end - buf[0].start > maxDur) cutAt(splitPoint());
    }
    buf.push(w);
  }
  emit(buf);

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
//
// `look`: 'outline' draws white text with a dark stroke around the letters —
// the picture stays visible behind them — while 'box' lays each line on a
// translucent slab. Outlined text needs the stroke to be genuinely thick
// (round-joined, drawn under the fill) or it turns to mush over busy footage;
// a soft shadow underneath carries it over bright, low-contrast areas.
export function drawCaption(ctx, text, x, y, w, h, { size = 'medium', position = 'bottom', look = 'outline' } = {}) {
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
    if (look === 'box') {
      const tw = ctx.measureText(ln).width;
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      ctx.fillRect(Math.round(cx - tw / 2 - padX), Math.round(cy - lineH / 2), Math.round(tw + 2 * padX), lineH);
      ctx.fillStyle = '#fff';
      ctx.fillText(ln, cx, cy);
    } else {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = Math.round(px * 0.3);
      ctx.lineWidth = Math.max(2, px * 0.17);
      ctx.lineJoin = 'round';
      ctx.miterLimit = 2;
      ctx.strokeStyle = 'rgba(0,0,0,0.92)';
      ctx.strokeText(ln, cx, cy);
      ctx.shadowBlur = 0;                 // the fill sits crisply on the stroke
      ctx.fillStyle = '#fff';
      ctx.fillText(ln, cx, cy);
    }
  });
  ctx.restore();
}

function rmsDb(a, s, e) {
  let sum = 0;
  for (let i = s; i < e; i++) sum += a[i] * a[i];
  const rms = Math.sqrt(sum / Math.max(1, e - s));
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

function clampInt(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
