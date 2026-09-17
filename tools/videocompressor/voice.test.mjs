// node voice.test.mjs — the pure overdub logic, without a model or a browser.
//
// Everything here is synthetic and checkable by hand: word timings with
// known pauses, tones of known length and level. What is being tested is
// that a generated line lands in exactly the hole it was meant to fill, at
// the level of the voice around it, with its seams in the pauses rather
// than on the words.
import assert from 'node:assert/strict';
import {
  changedLines, isChanged, snapSpan, pickReference, fitToDuration, rms,
  matchLevel, shapeEnds, toInterleaved, toMono, finishDub, naturalRate,
  planFit, fillWithRoomTone, matchVoiceLevel, findRoomTone, layRoomTone,
  crossfadeEdges, matchTone, FIT_MIN_RATE, FIT_MAX_RATE,
} from './voice.js';
import { analyzeVoiceLevel } from './audio-boost.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

const SR = 48000;
// A steady tone is enough for level and length work; WSOLA keeps its pitch,
// which is the property being checked.
const tone = (seconds, { freq = 200, amp = 0.2, sampleRate = SR } = {}) => {
  const n = Math.round(seconds * sampleRate);
  const a = new Float32Array(n);
  for (let i = 0; i < n; i++) a[i] = amp * Math.sin((2 * Math.PI * freq * i) / sampleRate);
  return a;
};

// ---------------------------------------------------------------------------
console.log('\nwhat changed');

test('an untouched line is not a change', () => {
  assert.equal(isChanged({ text: 'hello there', orig: 'hello there' }), false);
});

test('whitespace alone is not a change', () => {
  assert.equal(isChanged({ text: '  hello   there ', orig: 'hello there' }), false);
});

test('a real edit is a change', () => {
  assert.equal(isChanged({ text: 'hello world', orig: 'hello there' }), true);
});

test('a line that was never transcribed is never a change', () => {
  assert.equal(isChanged({ text: 'typed by hand' }), false);
});

test('changedLines returns only the edited ones', () => {
  const cues = [
    { text: 'one', orig: 'one' },
    { text: 'two but different', orig: 'two' },
    { text: 'three', orig: 'three' },
    { text: 'four changed', orig: 'four' },
  ];
  assert.deepEqual(changedLines(cues).map((c) => c.text), ['two but different', 'four changed']);
});

// ---------------------------------------------------------------------------
console.log('\nwhere the seam goes');

test('edges move to the middle of the surrounding pauses', () => {
  // ... word ends 1.0 | pause | line 1.4-2.6 | pause | word starts 3.0 ...
  const words = [
    { start: 0.5, end: 1.0, text: 'before' },
    { start: 1.4, end: 2.0, text: 'the' },
    { start: 2.1, end: 2.6, text: 'line' },
    { start: 3.0, end: 3.5, text: 'after' },
  ];
  const s = snapSpan(1.4, 2.6, words);
  assert.ok(Math.abs(s.start - 1.2) < 1e-6, `start ${s.start}`);
  assert.ok(Math.abs(s.end - 2.8) < 1e-6, `end ${s.end}`);
  assert.equal(s.snapped, true);
});

test('a long pause is reached into, but only as far as allowed', () => {
  const words = [
    { start: 0, end: 1.0, text: 'before' },
    { start: 5.0, end: 6.0, text: 'line' },
    { start: 9.0, end: 10.0, text: 'after' },
  ];
  const s = snapSpan(5.0, 6.0, words, { maxSnapS: 0.25 });
  // The middle of a 4 s gap is 2 s away and pointless; a quarter of a second
  // of it is all that's needed to get the seam off the word.
  assert.ok(Math.abs(s.start - 4.75) < 1e-6, `start ${s.start}`);
  assert.ok(Math.abs(s.end - 6.25) < 1e-6, `end ${s.end}`);
  assert.ok(Math.abs(s.lead - 0.25) < 1e-6, `lead ${s.lead}`);
  assert.ok(Math.abs(s.tail - 0.25) < 1e-6, `tail ${s.tail}`);
});

test('the seam never lands on the word it is replacing', () => {
  // This is the whole point: a word timestamp is an alignment, so the real
  // onset may be a little before it. Start the replacement on the timestamp
  // and the original says the first syllable before the clone says the line.
  const words = [
    { start: 0.0, end: 0.8, text: 'before' },
    { start: 1.6, end: 2.4, text: 'line' },
    { start: 2.7, end: 3.4, text: 'after' },
  ];
  for (const maxSnapS of [0.1, 0.25, 0.5]) {
    const s = snapSpan(1.6, 2.4, words, { maxSnapS });
    assert.ok(s.start < 1.6 - 1e-6, `start ${s.start} must be inside the pause`);
    assert.ok(s.start > 0.8, `start ${s.start} must not reach the word before`);
    assert.ok(s.end > 2.4 + 1e-6, `end ${s.end} must be inside the pause`);
    assert.ok(s.end < 2.7, `end ${s.end} must not reach the word after`);
  }
});

test('two respoken lines either side of one pause meet without overlapping', () => {
  const words = [
    { start: 0.0, end: 1.0, text: 'one' },
    { start: 1.3, end: 2.0, text: 'two' },
  ];
  const first = snapSpan(0.0, 1.0, words);
  const second = snapSpan(1.3, 2.0, words);
  assert.ok(Math.abs(first.end - second.start) < 1e-6,
    `${first.end} vs ${second.start}: no recording may be left between them, and none shared`);
});

test('a stop closure is too small a gap to snap into', () => {
  const words = [
    { start: 0, end: 1.0 },
    { start: 1.02, end: 2.0 },      // 20 ms: not a pause, just a consonant
    { start: 2.02, end: 3.0 },
  ];
  const s = snapSpan(1.02, 2.0, words, { minGapS: 0.04 });
  assert.equal(s.start, 1.02);
  assert.equal(s.end, 2.0);
});

test('a line at the very start or end keeps its own edge', () => {
  const words = [{ start: 0, end: 1.0 }, { start: 1.5, end: 2.0 }];
  const first = snapSpan(0, 1.0, words);
  assert.equal(first.start, 0, 'nothing before it to snap to');
  assert.ok(first.end > 1.0, 'but the end still moves into the pause');
  const last = snapSpan(1.5, 2.0, words);
  assert.equal(last.end, 2.0, 'nothing after it to snap to');
});

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
console.log('\nfitting it to the hole');

test('a dub that is too long is squeezed to exactly the slot', () => {
  const dub = tone(1.3);
  const target = Math.round(1.0 * SR);
  const r = fitToDuration(dub, SR, target);
  assert.equal(r.pcm.length, target, 'exact sample count');
  assert.ok(Math.abs(r.rate - 1.3) < 0.01, `rate ${r.rate}`);
  assert.equal(r.clamped, false);
});

test('a dub that is short keeps its own pace and leaves the pause', () => {
  const dub = tone(0.8);
  const target = Math.round(1.0 * SR);
  const r = fitToDuration(dub, SR, target);
  assert.equal(r.pcm.length, target, 'still exactly the slot');
  assert.equal(r.rate, 1, 'not slowed down to fill the gap');
  assert.ok(Math.abs(r.spoken - dub.length) < 2, 'all of it is spoken');
  // The tail is the pause it was always sitting in — quiet, but not a dropout.
  const tail = rms(r.pcm, Math.round(0.85 * SR), target);
  assert.ok(tail < rms(dub) / 4, 'the tail is far quieter than the speech');
});

test('the pad is faded into, so a short dub cannot click', () => {
  const dub = tone(0.5, { amp: 0.3 });
  const r = fitToDuration(dub, SR, Math.round(1.0 * SR));
  // The very last spoken sample should be on its way to zero, not full level.
  assert.ok(Math.abs(r.pcm[r.spoken - 1]) < 0.02, `ends at ${r.pcm[r.spoken - 1]}`);
  // A single sample of a sine can sit on a zero crossing, so measure a window.
  assert.ok(rms(r.pcm, Math.round(0.2 * SR), Math.round(0.3 * SR)) > 0.1, 'but the middle is untouched');
});

test('squeezing keeps the level (WSOLA overlap-add sums to one)', () => {
  const dub = tone(1.2, { amp: 0.25 });
  const r = fitToDuration(dub, SR, Math.round(1.0 * SR));
  const before = rms(dub), after = rms(r.pcm, SR * 0.1, SR * 0.9);
  const db = 20 * Math.log10(after / before);
  assert.ok(Math.abs(db) < 1.5, `level moved ${db.toFixed(2)} dB`);
});

test('an impossible fit is clamped and says so', () => {
  const dub = tone(3.0);                    // three times too long
  const target = Math.round(1.0 * SR);
  const r = fitToDuration(dub, SR, target);
  assert.equal(r.clamped, true, 'the caller has to know it did not fit');
  assert.ok(Math.abs(r.rate - FIT_MAX_RATE) < 1e-6, `clamped to ${r.rate}`);
  assert.equal(r.pcm.length, target, 'still exactly the slot length');
  assert.ok(Math.abs(r.wanted - 3.0) < 0.01, 'and reports what it would have needed');
});

test('an empty generation still fills its slot with silence', () => {
  const r = fitToDuration(new Float32Array(0), SR, 4800);
  assert.equal(r.pcm.length, 4800);
  assert.equal(rms(r.pcm), 0);
});

test('the borrowed pause at the head stays pause, and the line keeps its cue', () => {
  const dub = tone(0.6, { amp: 0.25 });
  const target = Math.round(1.0 * SR);
  const lead = Math.round(0.2 * SR);
  const r = fitToDuration(dub, SR, target, { leadSamples: lead });
  assert.equal(r.pcm.length, target, 'still exactly the slot');
  assert.equal(r.lead, lead, 'the whole lead was spare');
  assert.ok(rms(r.pcm, 0, lead - 100) < rms(dub) / 8, 'the head is quiet');
  assert.ok(rms(r.pcm, lead + 2000, lead + dub.length - 2000) > rms(dub) / 2,
    'and the speech is sitting after it');
});

test('a line that needs the whole hole does not get a lead', () => {
  const dub = tone(1.4);                    // longer than the slot already
  const target = Math.round(1.0 * SR);
  const r = fitToDuration(dub, SR, target, { leadSamples: Math.round(0.2 * SR) });
  assert.equal(r.lead, 0, 'silence is only spent on room that was going spare');
  assert.equal(r.pcm.length, target);
  assert.ok(rms(r.pcm, 0, 2000) > 0.05, 'the speech starts at the top of the span');
});

test('the lead is faded into as well, so it cannot click either', () => {
  const dub = tone(0.5, { amp: 0.3 });
  const lead = Math.round(0.2 * SR);
  const r = fitToDuration(dub, SR, Math.round(1.0 * SR), { leadSamples: lead });
  assert.ok(Math.abs(r.pcm[lead]) < 0.02, `starts at ${r.pcm[lead]}`);
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

test('a crossfade starts from the recording, not from silence', () => {
  const rec = recording();
  const dub = new Float32Array(SR).fill(0.1);
  const out = crossfadeEdges(dub, rec.subarray(0, SR), { channels: 1, sampleRate: SR, fadeMs: 30 });
  assert.ok(Math.abs(out[0] - rec[0]) < 0.02, 'the first sample is the recording');
  const mid = Math.round(SR * 0.5);
  assert.ok(Math.abs(out[mid] - 0.1) < 1e-6, 'the middle is untouched dub');
});

test('a crossfade ends on the recording so the next span continues it', () => {
  const rec = recording();
  const dub = new Float32Array(SR).fill(0.1);
  const orig = rec.subarray(0, SR);
  const out = crossfadeEdges(dub, orig, { channels: 1, sampleRate: SR, fadeMs: 30 });
  assert.ok(Math.abs(out[out.length - 1] - orig[orig.length - 1]) < 0.02, 'the last sample is the recording');
});

test('an equal-power crossfade of two room tones keeps the level steady', () => {
  // Equal power rather than linear, because the two sides of the join are
  // different noise: uncorrelated signals sum in power, so a linear fade would
  // dip ~3 dB in the middle and the dip in the room tone is exactly the
  // artefact being chased. (Crossfading a signal with *itself* would instead
  // gain 3 dB — that case is correlated, and isn't what happens at a seam.)
  const tone = findRoomTone(recording(), SR);
  const half = Math.floor(tone.length / 2);
  const dub = Float32Array.from(tone.subarray(0, half));
  const orig = Float32Array.from(tone.subarray(half, half * 2));
  const out = crossfadeEdges(dub, orig, { channels: 1, sampleRate: SR, fadeMs: 20 });
  const n = Math.round(0.02 * SR);
  const outside = rms(dub, n * 2, n * 4);
  const inside = rms(out, 0, n);
  assert.ok(Math.abs(20 * Math.log10(inside / outside)) < 2, `level moved ${(20 * Math.log10(inside / outside)).toFixed(2)} dB across the join`);
});

test('a crossfade survives stereo without swapping channels', () => {
  const dub = new Float32Array(400);
  const orig = new Float32Array(400);
  for (let i = 0; i < 200; i++) { dub[i * 2] = 1; dub[i * 2 + 1] = -1; orig[i * 2] = 0.5; orig[i * 2 + 1] = -0.5; }
  const out = crossfadeEdges(dub, orig, { channels: 2, sampleRate: SR, fadeMs: 1 });
  for (let i = 0; i < 200; i++) assert.ok(out[i * 2] > 0 && out[i * 2 + 1] < 0, `channels crossed at frame ${i}`);
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

// ---------------------------------------------------------------------------
console.log('\nthe whole finish');

test('finishDub produces exactly the frames the span expects, in stereo', () => {
  const model = tone(1.15, { freq: 180, amp: 0.05, sampleRate: 24000 });
  const targetSamples = Math.round(1.0 * SR);
  const out = finishDub(model, {
    modelRate: 24000, outRate: SR, channels: 2, targetSamples,
    targetDbfs: -20,
    resample: linearResample,
  });
  assert.equal(out.frames, targetSamples);
  assert.equal(out.pcm.length, targetSamples * 2, 'interleaved stereo');
  assert.ok(out.gainDb > 0, 'the quiet generation was brought up');
  const mono = toMono(out.pcm, 2);
  assert.equal(mono[0], 0, 'still faded at the seam');
});

test('finishDub refuses to guess when it has no resampler', () => {
  assert.throws(() => finishDub(tone(1, { sampleRate: 24000 }), {
    modelRate: 24000, outRate: SR, channels: 1, targetSamples: 4800,
  }), /resample/);
});

test('finishDub at a matching rate needs no resampler at all', () => {
  const out = finishDub(tone(1.0), { modelRate: SR, outRate: SR, channels: 1, targetSamples: SR });
  assert.equal(out.frames, SR);
});

// ---------------------------------------------------------------------------
console.log('\nletting the section breathe instead');

test('a longer line slows the picture rather than squeezing the speech', () => {
  // The order matters and is the whole point: a few percent of picture is
  // invisible, where squeezing speech is audible as soon as it does real work.
  const p = planFit(3.0, 3.3, { maxVideoRate: 1.15, minVideoRate: 1 / 1.15 });
  assert.equal(p.squeeze, 1, 'the speech was not touched');
  assert.ok(p.rate < 1, 'the picture eased off instead');
  assert.ok(Math.abs(p.outS - 3.3) < 1e-9, 'and the whole line fits');
  assert.equal(p.padS, 0);
});

test('the picture only stretches as far as it is allowed', () => {
  const p = planFit(3.0, 6.0, { maxVideoRate: 1.15, minVideoRate: 1 / 1.15 });
  assert.ok(Math.abs(p.rate - 1 / 1.15) < 1e-9, `rate ${p.rate} exceeded the limit`);
  assert.ok(p.squeeze > 1, 'the rest is taken out of the speech');
});

test('a line far too long to fit says how much did not fit', () => {
  const p = planFit(3.0, 12.0, { maxVideoRate: 1.15, minVideoRate: 1 / 1.15 });
  assert.ok(p.squeeze <= FIT_MAX_RATE + 1e-9, 'the squeeze is still bounded');
  assert.ok(p.short > 0, 'and the shortfall is reported rather than hidden');
});

test('zero stretch leaves the picture completely alone', () => {
  const p = planFit(3.0, 3.3, { maxVideoRate: 1, minVideoRate: 1 });
  assert.equal(p.rate, 1, 'the picture never moves');
  assert.ok(p.squeeze > 1, 'so the speech has to absorb all of it');
});

test('the dead-air threshold is a tolerance, not a trigger', () => {
  // "Keep at most this much pause" — so what is left over is the threshold,
  // not zero and not the whole gap. (Given enough stretch allowance to do it.)
  const p = planFit(8.8, 4.6, { deadAirS: 0.15, maxVideoRate: 2 });
  assert.equal(p.mode, 'natural');
  assert.ok(Math.abs(p.outS - (4.6 + 0.15)) < 1e-6, `section runs ${p.outS}s, wanted 4.75s`);
  assert.ok(Math.abs(p.padS - 0.15) < 1e-6, `left ${p.padS}s of pause`);
});

test('a gentle stretch limit trades dead air for a calm picture', () => {
  // The conservation problem, stated as a test: a much shorter line cannot be
  // both gentle on the picture and free of pause. With the limit at 15% the
  // picture stays calm and the leftover shows up as pause, honestly reported.
  const p = planFit(8.8, 4.6, { deadAirS: 0.15, maxVideoRate: 1.15 });
  assert.ok(Math.abs(p.rate - 1.15) < 1e-9, `rate ${p.rate}`);
  assert.ok(p.padS > 2, `expected real leftover pause, got ${p.padS.toFixed(2)}s`);
  assert.ok(Math.abs(p.outS - 8.8 / 1.15) < 1e-9);
});

test('a pause already under the threshold is left alone', () => {
  const p = planFit(3.0, 2.9, { deadAirS: 0.15 });
  assert.equal(p.mode, 'fit');
  assert.equal(p.rate, 1, 'the picture does not move');
  assert.ok(Math.abs(p.padS - 0.1) < 1e-6);
});

test('a zero threshold removes the pause entirely, given the room to do it', () => {
  const p = planFit(8.8, 4.6, { deadAirS: 0, maxVideoRate: 2 });
  assert.ok(Math.abs(p.outS - 4.6) < 1e-6, `section runs ${p.outS}s`);
  assert.ok(p.padS < 1e-6, 'no pause left');
});

test('the stretch limit wins over the dead-air threshold', () => {
  // Two settings pulling opposite ways, and the picture's limit is the one
  // that holds: asking for no pause cannot force a lurch.
  const p = planFit(8.8, 4.6, { deadAirS: 0, maxVideoRate: 1.15 });
  assert.ok(Math.abs(p.rate - 1.15) < 1e-9, `rate ${p.rate} broke the limit`);
  assert.ok(p.padS > 0, 'the pause the limit could not remove is kept, not forced out');
});

test('the pause borrowed for the seam is not counted as dead air', () => {
  // snapSpan reaches into the pause on either side so the seam lands in
  // silence. That silence is part of the span but it was never the line's own
  // dead air, and speeding the picture up to squeeze it out would be the tool
  // reacting to its own edit.
  const bare = planFit(3.0, 2.5, { deadAirS: 0.15, maxVideoRate: 1.5 });
  assert.ok(bare.rate > 1, 'without the allowance this line trims');
  const p = planFit(3.0, 2.5, { deadAirS: 0.15, maxVideoRate: 1.5, borrowedS: 0.4 });
  assert.equal(p.mode, 'fit');
  assert.equal(p.rate, 1, 'the picture is left alone');
});

test('turning trimming off keeps the whole pause', () => {
  const p = planFit(8.8, 4.6, { trimDeadAir: false });
  assert.equal(p.mode, 'fit');
  assert.equal(p.rate, 1);
  assert.ok(Math.abs(p.padS - 4.2) < 1e-6);
});

test('the speed-up is bounded, and the leftover pause is reported', () => {
  // Cutting nearly all of a long line: even at the bound there is pause left,
  // and the caller has to be able to say so.
  const p = planFit(10, 0.5, { deadAirS: 0.1, maxVideoRate: 2 });
  assert.equal(p.rate, 2);
  assert.ok(Math.abs(p.outS - 5) < 1e-6);
  assert.ok(p.padS > 4, `expected real leftover pause, got ${p.padS}`);
});

test('the natural rate makes the span occupy the dub duration exactly', () => {
  const srcS = 4.0, dubS = 5.0;
  const r = naturalRate(srcS, dubS);
  // editSpans() computes output duration as (end - start) / rate.
  assert.ok(Math.abs(srcS / r - dubS) < 1e-9, `span would run ${srcS / r} s, wanted ${dubS}`);
});

test('planFit rates round-trip through the edit model', () => {
  // The span's output length is (end - start) / rate, so a plan is only
  // correct if that comes back as outS.
  for (const [srcS, dubS, deadAirS] of [[8.8, 4.6, 0.15], [3, 2.5, 0.1], [3, 6, 0], [10, 0.5, 0.1]]) {
    const p = planFit(srcS, dubS, { deadAirS, maxVideoRate: 1.5 });
    assert.ok(Math.abs(srcS / p.rate - p.outS) < 1e-9, `${srcS}/${dubS}: ${srcS / p.rate} vs ${p.outS}`);
  }
});

test('the natural rate is bounded so the picture cannot crawl', () => {
  assert.ok(naturalRate(1, 100) >= 0.5);
  assert.ok(naturalRate(100, 1) <= 2);
});

test('an impossible squeeze is still clamped and reported', () => {
  const r = fitToDuration(tone(3.0), SR, Math.round(1.0 * SR));
  assert.equal(r.clamped, true);
  assert.ok(Math.abs(r.rate - FIT_MAX_RATE) < 1e-6);
});

// The tool's own definition of "how loud is the voice", for the tests above.
function analyze(x) {
  return analyzeVoiceLevel(x, SR).voiceDbfs;
}

// A stand-in for the browser's resampler, good enough to test the plumbing.
function linearResample(a, from, to) {
  const ratio = from / to;
  const n = Math.round(a.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, j = Math.floor(x), f = x - j;
    out[i] = (a[j] || 0) + ((a[j + 1] || 0) - (a[j] || 0)) * f;
  }
  return out;
}

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}\n`);
