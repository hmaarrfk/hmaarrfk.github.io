// Node test for breath.js. Builds a synthetic track whose breath positions are
// known exactly, then checks the detector finds those and nothing else — in
// particular that it leaves *quiet speech* alone, which is the failure that
// makes a plain noise gate chew the start of words.
//
//   node breath.test.mjs

import { detectBreaths, duckRegions } from './breath.js';

const SR = 48000;
let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

const dbToLin = (db) => Math.pow(10, db / 20);

// A voiced sound: a harmonic stack, like a vowel. Crosses zero slowly.
function addVoice(buf, fromSec, toSec, db, f0 = 120) {
  const amp = dbToLin(db);
  for (let i = Math.round(fromSec * SR); i < Math.round(toSec * SR) && i < buf.length; i++) {
    const t = i / SR;
    buf[i] += amp * (Math.sin(2 * Math.PI * f0 * t)
      + 0.5 * Math.sin(2 * Math.PI * 2 * f0 * t)
      + 0.3 * Math.sin(2 * Math.PI * 3 * f0 * t)) / 1.8;
  }
}

// A breath: high-passed noise, i.e. broadband hiss tilted high.
function addBreath(buf, fromSec, toSec, db) {
  const amp = dbToLin(db);
  let prev = 0, prevIn = 0;
  for (let i = Math.round(fromSec * SR); i < Math.round(toSec * SR) && i < buf.length; i++) {
    const x = Math.random() * 2 - 1;
    const y = 0.85 * (prev + x - prevIn);   // one-pole high-pass
    prev = y; prevIn = x;
    // fade in/out so it looks like a breath, not a burst
    const span = Math.round(toSec * SR) - Math.round(fromSec * SR);
    const k = Math.min(1, Math.min(i - Math.round(fromSec * SR), Math.round(toSec * SR) - i) / (span * 0.3));
    buf[i] += amp * y * k;
  }
}

function addRoom(buf, db) {
  const amp = dbToLin(db);
  for (let i = 0; i < buf.length; i++) buf[i] += amp * (Math.random() * 2 - 1);
}

// ---- the track ------------------------------------------------------------
const DUR = 12;
const buf = new Float32Array(DUR * SR);
addRoom(buf, -60);
const speech = [[0.5, 2.0], [3.0, 4.6], [6.0, 7.4], [9.5, 11.0]];
for (const [a, b] of speech) addVoice(buf, a, b, -14);
// a deliberately *quiet* phrase — a gate on level alone would eat this
addVoice(buf, 8.0, 8.8, -30);
const breaths = [[2.2, 2.7], [4.9, 5.4], [7.6, 8.0], [11.2, 11.6]];
for (const [a, b] of breaths) addBreath(buf, a, b, -34);

// A word's dying tail: noise-like and quiet, exactly like a breath, but it
// arrives straight off the back of speech instead of rising out of the room.
// Ducking these is what makes a de-breather sound like a lisp.
function addTail(buf, fromSec, toSec, fromDb, toDb) {
  const n = Math.round(toSec * SR) - Math.round(fromSec * SR);
  let prev = 0, prevIn = 0;
  for (let k = 0; k < n; k++) {
    const i = Math.round(fromSec * SR) + k;
    const db = fromDb + (toDb - fromDb) * (k / n);
    const x = Math.random() * 2 - 1;
    const y = 0.85 * (prev + x - prevIn);
    prev = y; prevIn = x;
    buf[i] += dbToLin(db) * y;
  }
}
addTail(buf, 4.6, 4.9, -26, -58);   // straight after the 3.0–4.6 s phrase

const { breaths: found, speechDb, floorDb } = detectBreaths(buf, SR);
console.log(`speech ${speechDb.toFixed(1)} dB · floor ${floorDb.toFixed(1)} dB · found ${found.length}`);
for (const f of found) console.log(`   ${f.start.toFixed(2)}–${f.end.toFixed(2)}s`);

const overlaps = (a, b, c, d) => Math.min(b, d) - Math.max(a, c) > 0;

// every planted breath is found
for (const [a, b] of breaths) {
  const hit = found.find((f) => overlaps(f.start, f.end, a, b));
  check(`breath at ${a}s found`, !!hit, hit ? `${hit.start.toFixed(2)}–${hit.end.toFixed(2)}` : 'missed');
}
// nothing is reported over speech, loud or quiet
for (const [a, b] of [...speech, [8.0, 8.8]]) {
  const bad = found.find((f) => overlaps(f.start, f.end, a + 0.05, b - 0.05));
  check(`speech at ${a}s untouched`, !bad, bad ? `overlapped by ${bad.start.toFixed(2)}–${bad.end.toFixed(2)}` : '');
}
check('no spurious detections', found.length <= breaths.length + 1, `${found.length} found for ${breaths.length} planted`);
check('a word\'s trailing sibilance is not a breath',
  !found.some((f) => overlaps(f.start, f.end, 4.6, 4.88)),
  found.filter((f) => overlaps(f.start, f.end, 4.6, 4.88)).map((f) => `${f.start.toFixed(2)}-${f.end.toFixed(2)}`).join(',') || 'correctly ignored');

// ---- silence in, nothing out ----------------------------------------------
const quiet = new Float32Array(SR * 3);
addRoom(quiet, -60);
check('room tone alone yields no breaths', detectBreaths(quiet, SR).breaths.length === 0, '');

// ---- ducking ---------------------------------------------------------------
{
  const frames = SR;                       // 1 s, stereo
  const inter = new Float32Array(frames * 2).fill(0.5);
  duckRegions(inter, 2, SR, 0, [{ start: 0.4, end: 0.6 }], -18);
  const mid = inter[Math.round(0.5 * SR) * 2];
  const outside = inter[Math.round(0.1 * SR) * 2];
  check('ducked region attenuated', Math.abs(mid - 0.5 * dbToLin(-18)) < 1e-3, `${(20 * Math.log10(mid / 0.5)).toFixed(1)} dB`);
  check('untouched region unchanged', Math.abs(outside - 0.5) < 1e-6, '');
  // the edges must ramp, not step
  const edge = inter[Math.round(0.401 * SR) * 2];
  check('edges ramp', edge < 0.5 && edge > 0.5 * dbToLin(-18), `${(20 * Math.log10(edge / 0.5)).toFixed(1)} dB just inside`);
  check('stays finite', inter.every(Number.isFinite), '');
}

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
