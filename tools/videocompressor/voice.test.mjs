// node voice.test.mjs — the pure overdub logic, without a model or a browser.
//
// Everything here is synthetic and checkable by hand: word timings with known
// pauses, scripts whose sentences are obvious, tones of known length and
// level. What is being tested is that a rewritten script lands on the seconds
// it describes, that the picture is re-timed to it inside the limits it was
// given, and that the narration comes back at the level of the voice around
// it with the room still under it.
import assert from 'node:assert/strict';
import {
  pickReference, rms, matchLevel, shapeEnds, toInterleaved, toMono,
  fillWithRoomTone, matchVoiceLevel, findRoomTone, layRoomTone, matchTone,
  scriptFromCues, splitSentences, splitScript, normWord, scriptWords,
  matchWords, alignScript, planTimeline, narrationWords, finishNarration,
} from './voice.js';
import { analyzeVoiceLevel } from './audio-boost.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const SR = 48000;
// A steady tone is enough for level and length work.
const tone = (seconds, { freq = 200, amp = 0.2, sampleRate = SR } = {}) => {
  const n = Math.round(seconds * sampleRate);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return a;
};

// ---------------------------------------------------------------------------
console.log('\nwhat to clone from');

test('the densest 6-15 s run wins', () => {
  const words = [];
  // A sparse patch: words with 1 s holes between them, 0-20 s.
  for (let t = 0; t < 20; t += 1.5) words.push({ start: t, end: t + 0.4, text: ' sparse' });
  // A dense run, 24-34 s, barely any gaps.
  for (let t = 24; t < 34; t += 0.5) words.push({ start: t, end: t + 0.45, text: ' dense' });
  const ref = pickReference(words);
  assert.ok(ref, 'a reference was found');
  assert.ok(ref.start >= 24 && ref.end <= 34.5, `picked ${ref.start}-${ref.end}, wanted the dense run`);
  assert.ok(ref.end - ref.start >= 6, 'at least six seconds');
  assert.ok(ref.density > 0.8, `density ${ref.density}`);
  assert.ok(ref.text.includes('dense'), 'carries its own transcript');
});

test('the window never exceeds the maximum', () => {
  const words = [];
  for (let t = 0; t < 60; t += 0.5) words.push({ start: t, end: t + 0.45, text: ' word' });
  const ref = pickReference(words, { maxS: 12 });
  assert.ok(ref.end - ref.start <= 12 + 1e-6, `${ref.end - ref.start} s`);
});

test('too little speech to clone from returns nothing', () => {
  const ref = pickReference([{ start: 0, end: 0.4 }, { start: 3, end: 3.4 }]);
  assert.equal(ref, null);
});

test('a reference is only taken from kept audio', () => {
  const words = [];
  for (let t = 0; t < 10; t += 0.5) words.push({ start: t, end: t + 0.45, text: ' cut' });
  for (let t = 20; t < 30; t += 0.5) words.push({ start: t, end: t + 0.45, text: ' kept' });
  const ref = pickReference(words, { within: [{ start: 18, end: 40 }] });
  assert.ok(ref.start >= 18, `picked ${ref.start}, which is in a removed section`);
});



// ---------------------------------------------------------------------------
console.log('\nthe pause sounds like the room');

// Speech over a quiet noise floor, with a gap in the middle — a plausible
// stand-in for a generated line that has room tone in its own pauses.
const withFloor = (seconds, { floor = 0.002, amp = 0.25 } = {}) => {
  const n = Math.round(seconds * SR);
  const a = new Float32Array(n);
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff - 0.5; };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const talking = t < 0.35 || t > 0.6;
    a[i] = rnd() * 2 * floor + (talking ? amp * Math.sin(2 * Math.PI * 200 * t) : 0);
  }
  return a;
};

test('the pad is room tone, not digital silence', () => {
  const dub = withFloor(1.0);
  const out = new Float32Array(Math.round(1.6 * SR));
  out.set(dub, 0);
  fillWithRoomTone(out, dub.length, SR);
  const pad = rms(out, dub.length + 100, out.length - 100);
  assert.ok(pad > 0, 'the pad is not absolutely silent');
  // It should sit at the recording's floor, not at the voice's level.
  assert.ok(pad < rms(dub) / 10, `pad ${pad} should be far under the speech`);
  assert.ok(pad > 1e-5, `pad ${pad} should still be audible room, not a dropout`);
});

test('a long pad does not repeat one fragment over and over', () => {
  // Tiling a single window makes a long pause hum: the fragment's period is
  // audible as a breath that was never recorded. Check that the pad does not
  // correlate strongly with itself at the tile spacing.
  const dub = withFloor(3.0);              // several pauses to draw from
  const out = new Float32Array(Math.round(6.0 * SR));
  out.set(dub, 0);
  fillWithRoomTone(out, dub.length, SR, { windowMs: 120 });
  const pad = out.subarray(dub.length);
  const win = Math.round(0.12 * SR);
  const at = (lag) => {
    let dot = 0, ea = 0, eb = 0;
    const n = Math.min(pad.length - lag, win * 8);
    for (let i = 0; i < n; i++) { dot += pad[i] * pad[i + lag]; ea += pad[i] * pad[i]; eb += pad[i + lag] * pad[i + lag]; }
    return dot / Math.sqrt((ea * eb) + 1e-12);
  };
  assert.ok(Math.abs(at(win)) < 0.7, `pad repeats itself at the tile length (corr ${at(win).toFixed(2)})`);
});

test('the tiled pad has no discontinuities to click on', () => {
  const dub = withFloor(1.0);
  const out = new Float32Array(Math.round(3.0 * SR));   // a long pad: many tiles
  out.set(dub, 0);
  fillWithRoomTone(out, dub.length, SR, { windowMs: 100 });
  // The biggest sample-to-sample jump in the pad must not exceed what the
  // room tone itself does — a seam would show up as a spike.
  let padJump = 0, toneJump = 0;
  for (let i = dub.length + 1; i < out.length; i++) padJump = Math.max(padJump, Math.abs(out[i] - out[i - 1]));
  const q0 = Math.round(0.4 * SR), q1 = Math.round(0.55 * SR);
  for (let i = q0 + 1; i < q1; i++) toneJump = Math.max(toneJump, Math.abs(dub[i] - dub[i - 1]));
  assert.ok(padJump <= toneJump * 1.5 + 1e-9, `pad jump ${padJump} vs tone jump ${toneJump}`);
});

test('a genuinely silent generation is left silent rather than given noise', () => {
  const out = new Float32Array(SR);
  fillWithRoomTone(out, Math.round(0.5 * SR), SR);
  assert.equal(rms(out), 0);
});

test('a line with no pause in it is padded with silence, not looping speech', () => {
  // Nothing quiet to learn the room from: filling the gap with the quietest
  // slice would tile the voice itself, which is worse than a clean silence.
  const dub = tone(0.5, { amp: 0.3 });
  const out = new Float32Array(SR);
  out.set(dub, 0);
  fillWithRoomTone(out, dub.length, SR);
  assert.equal(rms(out, dub.length, out.length), 0, 'left silent');
});

test('too little audio to learn the room from is left alone', () => {
  const out = new Float32Array(1000);
  out.fill(0.1, 0, 10);
  const before = Array.from(out.subarray(500, 510));
  fillWithRoomTone(out, 10, SR);
  assert.deepEqual(Array.from(out.subarray(500, 510)), before);
});

// ---------------------------------------------------------------------------
console.log('\nsounding like it belongs');

test('level matching brings a quiet dub up to the neighbours', () => {
  // 0.06 -> 0.2 is ~10.5 dB, inside the cap, so it should land exactly.
  const dub = tone(1.0, { amp: 0.06 });
  const target = rms(tone(1.0, { amp: 0.2 }));
  const m = matchLevel(dub, target);
  assert.ok(Math.abs(rms(m.pcm) - target) / target < 0.02, 'lands on the neighbour level');
  assert.ok(m.gainDb > 10 && m.gainDb < 11, `reports the gain it used (${m.gainDb.toFixed(2)} dB)`);
});

test('level matching is capped so a bad generation cannot explode', () => {
  const dub = tone(1.0, { amp: 1e-5 });
  const m = matchLevel(dub, rms(tone(1.0, { amp: 0.3 })));
  assert.ok(m.gainDb <= 12 + 1e-6, `gain ${m.gainDb} dB exceeded the cap`);
});

test('silence is left alone rather than amplified into noise', () => {
  const m = matchLevel(new Float32Array(1000), 0.2);
  assert.equal(rms(m.pcm), 0);
  assert.equal(m.gainDb, 0);
});

test('the ends are faded so the splice cannot click', () => {
  const dub = tone(0.5, { amp: 0.3 });
  const out = shapeEnds(dub, SR, { fadeMs: 12 });
  assert.equal(out[0], 0, 'starts from silence');
  assert.ok(Math.abs(out[out.length - 1]) < 1e-6, 'ends at silence');
  const mid = Math.floor(out.length / 2);
  assert.ok(Math.abs(out[mid] - dub[mid]) < 1e-6, 'the middle is untouched');
});

test('a fade never eats more than half the clip', () => {
  const tiny = tone(0.004, { amp: 0.3 });            // 4 ms, shorter than the fade
  const out = shapeEnds(tiny, SR, { fadeMs: 12 });
  assert.equal(out.length, tiny.length);
  assert.ok(rms(out) > 0, 'not faded into nothing');
});


// ---------------------------------------------------------------------------
console.log('\nmatching the recording\'s level');

// Speech-like: a voice-band tone that stops and starts, over a quiet floor.
const speechish = (seconds, { amp = 0.2, duty = true } = {}) => {
  const n = Math.round(seconds * SR);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const talking = !duty || (t % 1.0) < 0.6;       // 60% talking, 40% pause
    a[i] = talking ? amp * (Math.sin(2 * Math.PI * 500 * t) + 0.5 * Math.sin(2 * Math.PI * 1200 * t)) : 0;
  }
  return a;
};

test('a quiet generation is brought up to the recording\'s voice level', () => {
  // 0.05 -> 0.2 is ~12 dB, inside the 18 dB cap, so it should land exactly.
  const quiet = speechish(3, { amp: 0.05 });
  const loud = speechish(3, { amp: 0.2 });
  const target = analyze(loud);
  const m = matchVoiceLevel(quiet, SR, target);
  assert.ok(m.gainDb > 5, `expected a real lift, got ${m.gainDb.toFixed(1)} dB`);
  assert.ok(Math.abs(analyze(m.pcm) - target) < 1.5, 'lands on the target level');
});

test('a loud generation is brought down', () => {
  const loud = speechish(3, { amp: 0.4 });
  const target = analyze(speechish(3, { amp: 0.05 }));
  const m = matchVoiceLevel(loud, SR, target);
  assert.ok(m.gainDb < -5, `expected a cut, got ${m.gainDb.toFixed(1)} dB`);
  assert.ok(Math.abs(analyze(m.pcm) - target) < 1.5, 'lands on the target level');
});

test('how much silence a line contains does not change its level', () => {
  // The bug this guards: plain RMS over the whole buffer calls a line with
  // pauses "quiet" and shoves it up. The voice-band active measure must not.
  const dense = speechish(3, { duty: false, amp: 0.2 });
  const gappy = speechish(3, { duty: true, amp: 0.2 });
  const target = -25;
  const a = matchVoiceLevel(dense, SR, target).gainDb;
  const b = matchVoiceLevel(gappy, SR, target).gainDb;
  assert.ok(Math.abs(a - b) < 2, `same voice, gains differed by ${Math.abs(a - b).toFixed(1)} dB`);
});

test('the correction is capped so a bad generation is not amplified into noise', () => {
  const m = matchVoiceLevel(speechish(3, { amp: 0.0005 }), SR, -6);
  assert.ok(m.gainDb <= 18 + 1e-6, `gain ${m.gainDb}`);
});

test('a missing target is not read as 0 dBFS', () => {
  // isFinite(null) is true, so the obvious guard silently drives the line to
  // full scale. Number.isFinite is the one that means what it says.
  for (const bad of [null, undefined, NaN]) {
    assert.equal(matchVoiceLevel(speechish(1, { amp: 0.05 }), SR, bad).gainDb, 0, `target ${bad}`);
  }
});

test('silence is left alone rather than scaled', () => {
  const m = matchVoiceLevel(new Float32Array(SR), SR, -20);
  assert.equal(m.gainDb, 0);
});

test('no target means no change', () => {
  const x = speechish(1);
  assert.equal(matchVoiceLevel(x, SR, null).gainDb, 0);
});

// ---------------------------------------------------------------------------
console.log('\nchannel layout');

test('mono fans out to stereo and back unchanged', () => {
  const mono = tone(0.05, { amp: 0.3 });
  const inter = toInterleaved(mono, 2);
  assert.equal(inter.length, mono.length * 2);
  const back = toMono(inter, 2);
  for (let i = 0; i < mono.length; i++) assert.ok(Math.abs(back[i] - mono[i]) < 1e-6);
});

test('one channel is passed straight through', () => {
  const mono = tone(0.05);
  assert.equal(toInterleaved(mono, 1), mono);
});


// ---------------------------------------------------------------------------
console.log('\nblending into the recording');

// A recording: speech over a room floor that never stops, with a real gap.
const recording = (seconds = 3, { floor = 0.004, amp = 0.2, gap = [1.0, 2.0] } = {}) => {
  const n = Math.round(seconds * SR);
  const a = new Float32Array(n);
  let seed = 3;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 - 0.5; };
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const talking = t < gap[0] || t > gap[1];
    a[i] = rnd() * 2 * floor + (talking ? amp * Math.sin(2 * Math.PI * 200 * t) : 0);
  }
  return a;
};

test('room tone is found in the recording\'s longest quiet stretch', () => {
  const tone = findRoomTone(recording(), SR);
  assert.ok(tone, 'a sample was found');
  assert.ok(tone.length / SR > 0.7, `${(tone.length / SR).toFixed(2)}s is too short to be useful`);
  // It must be the room, not the voice.
  assert.ok(rms(tone) < 0.02, `level ${rms(tone)} — that is speech, not room tone`);
});

test('a recording that never stops talking yields no room tone', () => {
  // The failure this guards against is silent and bad: with no real pause the
  // percentile floor lands inside the speech, every frame looks quiet, and the
  // speaker's own voice gets laid under every respoken line.
  const solid = recording(3, { gap: [9, 9] });     // no gap at all
  assert.equal(findRoomTone(solid, SR), null);
});

test('silence is not mistaken for room tone worth using', () => {
  assert.equal(findRoomTone(new Float32Array(SR * 3), SR), null);
});

test('room tone laid under a line gives it the floor the model has none of', () => {
  const tone = findRoomTone(recording(), SR);
  const bare = new Float32Array(SR);               // a generation, with digital silence in it
  bare.set(tone.subarray(0, 0));
  const withRoom = layRoomTone(bare, tone);
  assert.ok(rms(withRoom) > 0, 'the background is no longer absolutely silent');
  assert.ok(Math.abs(rms(withRoom) - rms(tone)) / rms(tone) < 0.35, 'and it sits at the room\'s own level');
});

test('room tone shorter than the line does not loop audibly', () => {
  const tone = findRoomTone(recording(), SR);
  const long = layRoomTone(new Float32Array(tone.length * 5), tone);
  // Walking back and forth means no exact repeat at the sample length.
  let same = 0;
  for (let i = 0; i < tone.length; i++) if (long[i] === long[i + tone.length]) same++;
  assert.ok(same < tone.length * 0.6, 'the tone repeats itself exactly');
});


test('tone matching moves a dull line toward the recording', () => {
  const bright = recording(2, { gap: [9, 9] });
  // The same thing with its top end rolled off, as a 24 kHz model's output is.
  const dull = new Float32Array(bright.length);
  let y = 0;
  for (let i = 0; i < bright.length; i++) { y += 0.05 * (bright[i] - y); dull[i] = y; }
  const m = matchTone(dull, bright, SR);
  assert.ok(m.gainsDb, 'a correction was made');
  assert.ok(m.gainsDb[2] > 0.5, `expected the top band lifted, got ${m.gainsDb}`);
});

test('tone matching is bounded, and declines to act on nothing', () => {
  const ref = recording(2, { gap: [9, 9] });
  const m = matchTone(new Float32Array(SR), ref, SR);
  assert.equal(m.gainsDb, null, 'silence is left alone');
  const big = matchTone(ref.map((v) => v * 0.0001), ref, SR);
  if (big.gainsDb) for (const g of big.gainsDb) assert.ok(Math.abs(g) <= 6 + 1e-6, `gain ${g} exceeded the limit`);
});


// A voice-band level, the way the rest of the tool measures loudness.
function analyze(x) {
  return analyzeVoiceLevel(x, SR).voiceDbfs;
}

// ---------------------------------------------------------------------------
console.log('\nthe transcript becomes a script');

test('phrases join into prose, and a long pause starts a paragraph', () => {
  const text = scriptFromCues([
    { start: 0, end: 2, text: 'Here is the sample.' },
    { start: 2.1, end: 4, text: 'It is a thin section.' },
    { start: 9, end: 11, text: 'Now the microscope.' },
  ]);
  assert.equal(text, 'Here is the sample. It is a thin section.\n\nNow the microscope.');
});

test('a sentence is split at the full stop, not at the abbreviation', () => {
  assert.deepEqual(splitSentences('Fig. 3 shows the stage. It moves 0.5 mm. Done.'),
    ['Fig. 3 shows the stage.', 'It moves 0.5 mm.', 'Done.']);
});

test('initials and e.g. are not sentence ends either', () => {
  assert.deepEqual(splitSentences('We use e.g. the 20x. Dr. J. Smith agreed.'),
    ['We use e.g. the 20x.', 'Dr. J. Smith agreed.']);
});

test('a question or an exclamation ends a sentence, quotes and all', () => {
  assert.deepEqual(splitSentences('"Is it flat?" she asked. Yes!'),
    ['"Is it flat?" she asked.', 'Yes!']);
});

test('the pause follows the punctuation, and a paragraph break is longer', () => {
  const parts = splitScript('One thing. Another thing.\n\nA new idea.',
    { sentencePauseS: 0.3, paragraphPauseS: 0.9, clausePauseS: 0.1 });
  assert.deepEqual(parts.map((p) => p.text), ['One thing.', 'Another thing.', 'A new idea.']);
  assert.deepEqual(parts.map((p) => p.pauseAfterS), [0.3, 0.9, 0]);
  assert.deepEqual(parts.map((p) => p.paragraph), [0, 0, 1]);
});

test('the last sentence has nothing after it to pause for', () => {
  const parts = splitScript('Only this.');
  assert.equal(parts.length, 1);
  assert.equal(parts[0].pauseAfterS, 0);
});

// ---------------------------------------------------------------------------
console.log('\naligning a rewritten script');

// A transcript at one word a second, so a word's index is its timestamp.
const transcriptOf = (sentence, from = 0) =>
  sentence.split(' ').map((t, i) => ({ text: ' ' + t, start: from + i, end: from + i + 0.8 }));

test('identical texts match word for word', () => {
  const a = ['the', 'stage', 'moves', 'slowly'];
  assert.deepEqual(matchWords(a, a), [[0, 0], [1, 1], [2, 2], [3, 3]]);
});

test('an inserted word does not shift the words after it', () => {
  const pairs = matchWords(['the', 'stage', 'moves'], ['the', 'heavy', 'stage', 'moves']);
  assert.deepEqual(pairs, [[0, 0], [1, 2], [2, 3]]);
});

test('a wholly rewritten middle still pins the ends', () => {
  const pairs = matchWords(
    ['calibrate', 'the', 'ancient', 'knob', 'carefully', 'afterwards'],
    ['calibrate', 'the', 'digital', 'dial', 'afterwards']);
  assert.deepEqual(pairs[0], [0, 0]);
  assert.deepEqual(pairs[pairs.length - 1], [5, 4]);
});

test('a sentence keeps the seconds its own words were said in', () => {
  const words = [...transcriptOf('we mount the sample', 0), ...transcriptOf('then we focus', 10)];
  const parts = alignScript(splitScript('We mount the sample. Then we focus.'), words,
    { startS: 0, endS: 20 });
  assert.ok(parts[0].anchored && parts[1].anchored);
  assert.ok(Math.abs(parts[0].srcStart - 0) < 0.01, `first started at ${parts[0].srcStart}`);
  assert.ok(Math.abs(parts[1].srcStart - 10) < 0.01, `second started at ${parts[1].srcStart}`);
});

test('a rewritten sentence is placed between the two that were not', () => {
  const words = [...transcriptOf('we mount the sample', 0),
                 ...transcriptOf('um so anyway right', 10),
                 ...transcriptOf('then we focus', 20)];
  const parts = alignScript(
    splitScript('We mount the sample. Everything is aligned first. Then we focus.'),
    words, { startS: 0, endS: 30 });
  assert.equal(parts[1].anchored, false, 'nothing of it survived the rewrite');
  assert.ok(parts[1].srcStart >= parts[0].srcEnd - 1e-6, 'starts after the one before');
  assert.ok(parts[1].srcEnd <= parts[2].srcStart + 1e-6, 'ends before the one after');
});

test('anchors never run backwards, whatever the diff paired', () => {
  const words = [...transcriptOf('the the the the', 0), ...transcriptOf('the the the the', 10)];
  const parts = alignScript(splitScript('The the the the. The the the the.'), words,
    { startS: 0, endS: 20 });
  let at = -1;
  for (const p of parts) {
    assert.ok(p.srcStart >= at - 1e-6, `${p.srcStart} came before ${at}`);
    assert.ok(p.srcEnd >= p.srcStart - 1e-6, 'a section of negative length');
    at = p.srcEnd;
  }
});

// ---------------------------------------------------------------------------
console.log('\nre-timing the picture');

// Sentences laid out by hand: where each was said, and where it is said now.
const laid = (rows) => rows.map(([srcStart, srcEnd, outStart, outEnd]) =>
  ({ text: 'x', srcStart, srcEnd, outStart, outEnd }));

test('the sections tile the narration exactly', () => {
  const { spans } = planTimeline(laid([[0, 5, 0, 4], [6, 10, 4.3, 9]]),
    { keptS: 12, narrationS: 10 });
  assert.ok(Math.abs(spans[0].outStart) < 1e-9, 'starts at the top of the narration');
  for (let i = 1; i < spans.length; i++) {
    assert.ok(Math.abs(spans[i].outStart - spans[i - 1].outEnd) < 1e-6, 'a hole between sections');
  }
  assert.ok(Math.abs(spans[spans.length - 1].outEnd - 10) < 1e-6, 'ends where the narration does');
});

test('a section that has to hurry does so within the limit', () => {
  const { spans, stats } = planTimeline(laid([[0, 10, 0, 8]]),
    { keptS: 10, narrationS: 8, minRate: 0.7, maxRate: 1.5 });
  assert.equal(spans.length, 1);
  assert.ok(spans[0].rate <= 1.5 + 1e-6, `ran at ${spans[0].rate}`);
  assert.equal(stats.cutS, 0, 'nothing needed cutting');
});

test('footage the script no longer covers is cut, not sped up past the limit', () => {
  // Twenty seconds of recording, four seconds of narration: 5x is far past
  // any sane speed-up, so the surplus has to go.
  const { spans, cuts, stats } = planTimeline(laid([[0, 20, 0, 4]]),
    { keptS: 20, narrationS: 4, minRate: 0.7, maxRate: 1.5 });
  assert.ok(cuts.length === 1, 'exactly one section removed');
  assert.ok(stats.cutS > 13, `only cut ${stats.cutS.toFixed(1)} s`);
  for (const sp of spans) assert.ok(sp.rate <= 1.5 + 1e-6, `ran at ${sp.rate}`);
  // The cut plus what is kept still accounts for the whole recording.
  const kept = spans.reduce((n, sp) => n + (sp.srcEnd - sp.srcStart), 0);
  assert.ok(Math.abs(kept + stats.cutS - 20) < 1e-6, 'source seconds went missing');
});

test('anchors are dropped rather than lurching the picture per sentence', () => {
  // Two sentences: one you now say much faster, one much slower. Taken one at
  // a time that is 2x then 0.5x; merged, it is 1x.
  const { spans, stats } = planTimeline(laid([[0, 8, 0, 4], [8, 12, 4, 12]]),
    { keptS: 12, narrationS: 12, minRate: 0.8, maxRate: 1.25 });
  assert.ok(stats.merged >= 1, 'nothing was merged');
  assert.equal(spans.length, 1);
  assert.ok(Math.abs(spans[0].rate - 1) < 1e-6, `ran at ${spans[0].rate}`);
});

test('zero stretch still produces a timeline, and says it could not comply', () => {
  const { spans, stats } = planTimeline(laid([[0, 4, 0, 8]]),
    { keptS: 4, narrationS: 8, minRate: 1, maxRate: 1 });
  assert.equal(spans.length, 1);
  assert.ok(stats.tooSlow >= 1, 'should have owned up to running slow');
  assert.ok(Math.abs(spans[0].rate - 0.5) < 1e-6, 'the picture still covers the narration');
});

test('neighbouring sections at nearly the same rate are joined', () => {
  // Four sentences that all want about 1.2x: one rate, not four.
  const rows = [];
  for (let i = 0; i < 4; i++) rows.push([i * 3, i * 3 + 3, i * 2.5, i * 2.5 + 2.5]);
  const { spans } = planTimeline(laid(rows), { keptS: 12, narrationS: 10, minRate: 0.7, maxRate: 1.5 });
  assert.equal(spans.length, 1, `left ${spans.length} speed changes where one would do`);
});

test('smoothing never drags a section outside the band', () => {
  const { spans } = planTimeline(laid([[0, 2, 0, 2], [2, 8, 2, 4]]),
    { keptS: 8, narrationS: 4, minRate: 0.7, maxRate: 1.5, smoothRatio: 99 });
  for (const sp of spans) assert.ok(sp.rate <= 1.5 + 1e-6, `ran at ${sp.rate}`);
});

test('a plan with no sentences at all is still a plan', () => {
  const { spans } = planTimeline([], { keptS: 6, narrationS: 6 });
  assert.equal(spans.length, 1);
  assert.ok(Math.abs(spans[0].rate - 1) < 1e-6);
});

// ---------------------------------------------------------------------------
console.log('\ncaptions for what is now said');

test('words fill their own sentence and nothing else', () => {
  const words = narrationWords([
    { text: 'One two.', outStart: 0, outEnd: 1 },
    { text: 'Three.', outStart: 2, outEnd: 2.5 },
  ]);
  assert.equal(words.length, 3);
  assert.ok(Math.abs(words[0].start - 0) < 1e-9);
  assert.ok(Math.abs(words[1].end - 1) < 1e-6, `first sentence ended at ${words[1].end}`);
  assert.ok(Math.abs(words[2].start - 2) < 1e-9, 'the pause is not filled with words');
});

test('every word carries the leading space a cue break needs', () => {
  for (const w of narrationWords([{ text: 'a bb ccc', outStart: 0, outEnd: 3 }])) {
    assert.ok(w.text.startsWith(' '), `"${w.text}" would let a cue break mid-word`);
  }
});

// ---------------------------------------------------------------------------
console.log('\nfinishing the narration');

test('the narration is resampled, levelled and faded in one pass', () => {
  const model = speechish(2, { amp: 0.05 });   // at SR here; pretend it is 24 kHz
  const out = finishNarration(model, {
    modelRate: SR, outRate: SR, targetDbfs: analyze(speechish(2, { amp: 0.2 })),
  });
  assert.equal(out.pcm.length, model.length);
  assert.ok(out.gainDb > 6, `only moved ${out.gainDb.toFixed(1)} dB`);
  assert.ok(Math.abs(out.pcm[0]) < 1e-6, 'the first sample is faded in');
});

test('finishing refuses to guess when it has no resampler', () => {
  assert.throws(() => finishNarration(tone(0.1), { modelRate: 24000, outRate: SR }),
    /resample/);
});

test('one measurement for the whole narration, not one per sentence', () => {
  // A narration that is quiet at the front and loud at the back keeps that
  // shape: the gain is a single number, so the two halves stay in proportion.
  const quiet = speechish(2, { amp: 0.05 }), loud = speechish(2, { amp: 0.2 });
  const both = new Float32Array(quiet.length + loud.length);
  both.set(quiet, 0); both.set(loud, quiet.length);
  const out = finishNarration(both, { modelRate: SR, outRate: SR, targetDbfs: -20 });
  const a = rms(out.pcm, 0.2 * SR, 1.8 * SR);
  const b = rms(out.pcm, quiet.length + 0.2 * SR, quiet.length + 1.8 * SR);
  assert.ok(Math.abs(b / a - 4) < 0.3, `the halves drifted apart: ${(b / a).toFixed(2)}`);
});

test('the pauses between sentences get the room, not digital silence', () => {
  const speech = speechish(4, { amp: 0.2, duty: false });
  const withGap = Float32Array.from(speech);
  const from = Math.round(1.5 * SR), to = Math.round(2.5 * SR);
  withGap.fill(0, from, to);
  const out = finishNarration(withGap, {
    modelRate: SR, outRate: SR,
    roomTone: tone(0.5, { freq: 60, amp: 0.004 }),
    pauses: [{ from: 1.5, to: 2.5 }],
  });
  assert.ok(rms(out.pcm, from + 2400, to - 2400) > 1e-4, 'the pause is dead silence');
});

test('replacing the audio keeps the recording out of the narration entirely', () => {
  // A generation with its own faint floor — the clone's quiet, which came from
  // the microphone it was cloned from and is all the room there is to have.
  const gen = speechish(4, { amp: 0.2 });
  for (let i = 0; i < gen.length; i++) gen[i] += 0.0006 * Math.sin((2 * Math.PI * 3000 * i) / SR);
  const from = Math.round(1.5 * SR), to = Math.round(2.5 * SR);
  const withGap = Float32Array.from(gen);
  withGap.fill(0, from, to);                       // the pause between two sentences
  const pauses = [{ from: 1.5, to: 2.5 }];
  const room = tone(0.5, { freq: 60, amp: 0.02 }); // the recording's hum

  const kept = finishNarration(withGap, { modelRate: SR, outRate: SR, roomTone: room, pauses });
  const replaced = finishNarration(withGap, { modelRate: SR, outRate: SR, roomTone: null, pauses });

  const a = rms(kept.pcm, from + 2400, to - 2400);
  const b = rms(replaced.pcm, from + 2400, to - 2400);
  assert.ok(b > 1e-6, 'the pause is a dropout — it should be rebuilt from the generation');
  assert.ok(b < a / 5, `the recording is still under it: ${b.toFixed(5)} vs ${a.toFixed(5)}`);
  // And nothing was added under the speech either.
  const speechA = rms(kept.pcm, 0.1 * SR, 0.5 * SR);
  const speechB = rms(replaced.pcm, 0.1 * SR, 0.5 * SR);
  assert.ok(speechB <= speechA, 'replacing the audio should never add energy');
});

test('replacing the audio lays a bed of the narration\'s own quiet under it', () => {
  // A generation shaped like the model's: speech with a faint floor under it,
  // and pauses that are that floor and nothing else. Without a bed those
  // pauses sit ~40 dB under the speech and the ear calls it a dropout.
  const gen = speechish(6, { amp: 0.2 });
  let seed = 12345;
  for (let i = 0; i < gen.length; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    gen[i] += 0.0002 * ((seed >>> 8) / 0x1000000 - 0.5);
  }
  const bare = finishNarration(gen, { modelRate: SR, outRate: SR, targetDbfs: -20 });
  const bedded = finishNarration(gen, { modelRate: SR, outRate: SR, targetDbfs: -20, bedDb: -40 });

  // speechish talks for the first 0.6 s of every second, so [0.7, 0.9] is pause.
  const pauseBare = rms(bare.pcm, 0.7 * SR, 0.9 * SR);
  const pauseBed = rms(bedded.pcm, 0.7 * SR, 0.9 * SR);
  const speech = rms(bedded.pcm, 0.1 * SR, 0.5 * SR);
  assert.ok(pauseBed > pauseBare * 4,
    `no bed was laid: ${pauseBed.toExponential(2)} vs ${pauseBare.toExponential(2)}`);
  const under = 20 * Math.log10(pauseBed / speech);
  assert.ok(under < -28 && under > -52, `the bed sits ${under.toFixed(1)} dB under the voice`);
  // And it never stops: every 50 ms window of the pause has something in it.
  for (let at = 0.7 * SR; at + 0.05 * SR < 0.9 * SR; at += 0.05 * SR) {
    assert.ok(rms(bedded.pcm, at, at + 0.05 * SR) > pauseBed / 4, 'the bed drops out mid-pause');
  }
  // The speech itself is untouched by it.
  assert.ok(Math.abs(20 * Math.log10(speech / rms(bare.pcm, 0.1 * SR, 0.5 * SR))) < 0.2,
    'the bed changed the level of the speech');
});

test('the bed reaches the inserted silence, not just the model\'s pauses', () => {
  // What respeakScript actually builds: a true-zero lead-in and tail around a
  // generation that has its own faint floor. The lead-in is the stretch most in
  // need of a bed, and also the one a window scored on level alone will pick
  // *from* — half silence, half floor — which lays almost nothing anywhere.
  const SR2 = SR;
  const n = Math.round(9 * SR2);
  const gen = new Float32Array(n);
  let seed = 99;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const t = i / SR2;
    if (t < 1.2 || t > 7.5) continue;                        // inserted silence
    const talking = ((t - 1.2) % 2.2) < 1.6;                 // 0.6 s pauses
    gen[i] = 0.00015 * ((seed >>> 8) / 0x1000000 - 0.5)
      + (talking ? 0.2 * Math.sin((2 * Math.PI * 500 * i) / SR2) : 0);
  }
  const out = finishNarration(gen, {
    modelRate: SR2, outRate: SR2, targetDbfs: -20, bedDb: -40,
    pauses: [{ from: 0, to: 1.2 }, { from: 7.5, to: 9 }],
  });
  assert.ok(out.bed && out.bed.length, 'no bed was built at all');

  // Nothing anywhere is digital silence any more — that is the property that
  // stops a pause reading as the track cutting out.
  const step = Math.round(0.005 * SR2);
  let worstRun = 0, run = 0;
  for (let i = 0; i + step <= out.pcm.length; i += step) {
    if (rms(out.pcm, i, i + step) < 1e-5) { run += 1; worstRun = Math.max(worstRun, run); } else run = 0;
  }
  assert.equal(worstRun, 0, `${worstRun * 5} ms of the narration is still dead`);

  // And the bed sits where it was asked to, in the inserted silence as much as
  // in the model's own pauses.
  const speech = rms(out.pcm, 1.4 * SR2, 2.6 * SR2);
  for (const [label, from, to] of [['lead-in', 0.2, 1.0], ['tail', 8.0, 8.8]]) {
    const under = 20 * Math.log10(rms(out.pcm, from * SR2, to * SR2) / speech);
    assert.ok(under < -28 && under > -52, `the ${label} sits ${under.toFixed(1)} dB under the voice`);
  }
});

console.log(`\n${passed} passed`);
