// Node test for the leveller's non-speech hold (audio-boost.js).
//
// The point at issue: an AGC has the most room to push exactly where nobody is
// talking, so without a hold it turns the gaps up — and the gaps are where the
// breaths, room tone and keyboard noise live.
//
//   node audio-boost.test.mjs

import { createLeveler, analyzeVoiceLevel } from './audio-boost.js';

const SR = 48000;
let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const dbToLin = (db) => Math.pow(10, db / 20);
const toDb = (x) => 20 * Math.log10(Math.max(1e-9, x));

// Speech, a long gap holding a quiet breath-like hiss, then speech again.
function track() {
  const dur = 13;
  const buf = new Float32Array(dur * SR);
  const voice = (from, to, db) => {
    const amp = dbToLin(db);
    for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) {
      const t = i / SR;
      buf[i] += amp * (Math.sin(2 * Math.PI * 130 * t) + 0.4 * Math.sin(2 * Math.PI * 390 * t)) / 1.4;
    }
  };
  const hiss = (from, to, db) => {
    const amp = dbToLin(db);
    for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) buf[i] += amp * (Math.random() * 2 - 1);
  };
  // A breath sits far below the voice — 25 dB here, which is typical; much
  // closer than ~18 dB and it is no longer distinguishable from quiet speech
  // by level, which is exactly why the ducker works from detection instead.
  voice(0, 3, -30);          // quiet speech: the leveller should lift this
  hiss(3.5, 6.5, -55);       // the gap: a breath / room tone
  voice(7, 9, -30);
  voice(10, 12, -42);        // a genuinely quiet phrase: must still be lifted
  return buf;
}

function run(holdRangeDb) {
  const mono = track();
  const lev = createLeveler(SR, holdRangeDb === null
    ? { maxGainDb: 36, holdRangeDb: 1000 }   // effectively no hold: the old behaviour
    : { maxGainDb: 36, holdRangeDb });
  const out = [];
  const CH = 1, CHUNK = 4800;
  for (let i = 0; i < mono.length; i += CHUNK) {
    const piece = mono.subarray(i, Math.min(mono.length, i + CHUNK));
    out.push(lev.process(piece, CH, piece));
  }
  out.push(lev.flush());
  let len = 0;
  for (const p of out) len += p.length;
  const y = new Float32Array(len);
  let o = 0;
  for (const p of out) { y.set(p, o); o += p.length; }
  return y;
}

const rms = (x, from, to) => {
  let s = 0, n = 0;
  for (let i = Math.round(from * SR); i < Math.min(x.length, Math.round(to * SR)); i++) { s += x[i] * x[i]; n++; }
  return Math.sqrt(s / Math.max(1, n));
};

const { voiceDbfs } = analyzeVoiceLevel(track(), SR);
console.log(`measured voice level: ${voiceDbfs.toFixed(1)} dBFS`);

const without = run(null);
const withHold = run(18);

// What matters is the *gain* each part receives: the complaint is that the AGC
// pushes the gaps harder than the speech, so the breaths come up while the
// voice doesn't. The hold's job is to stop that, not to make gaps quieter than
// the boost the user asked for.
const src = track();
const inGap = toDb(rms(src, 5.0, 6.3));
const inSpeech = toDb(rms(src, 1.0, 2.8));
const gapOld = toDb(rms(without, 5.0, 6.3));
const gapNew = toDb(rms(withHold, 5.0, 6.3));
const speechOld = toDb(rms(without, 1.0, 2.8));
const speechNew = toDb(rms(withHold, 1.0, 2.8));
const gainGapOld = gapOld - inGap, gainGapNew = gapNew - inGap;
const gainSpeechOld = speechOld - inSpeech, gainSpeechNew = speechNew - inSpeech;
console.log(`gain on speech: ${gainSpeechOld.toFixed(1)} dB -> ${gainSpeechNew.toFixed(1)} dB`);
console.log(`gain on gap:    ${gainGapOld.toFixed(1)} dB -> ${gainGapNew.toFixed(1)} dB`);

check('without the hold, gaps are pushed harder than speech',
  gainGapOld > gainSpeechOld + 3, `gap +${gainGapOld.toFixed(1)} vs speech +${gainSpeechOld.toFixed(1)}`);
// A tenth or two of drift is expected and wanted: the memory of the speech
// level decays slowly, so a *very* long pause re-normalises rather than staying
// pinned to a voice that stopped a minute ago.
check('with the hold, a gap is never pushed past the speech gain',
  gainGapNew <= gainSpeechNew + 1, `gap +${gainGapNew.toFixed(1)} vs speech +${gainSpeechNew.toFixed(1)}`);
check('so the breath comes out quieter than it would have',
  gapNew < gapOld - 3, `${(gapNew - gapOld).toFixed(1)} dB`);

// The hold must not clamp real speech that simply happens to be quiet.
const quietOld = toDb(rms(without, 10.3, 11.8));
const quietNew = toDb(rms(withHold, 10.3, 11.8));
console.log(`quiet phrase: ${quietOld.toFixed(1)} dB -> ${quietNew.toFixed(1)} dB`);
check('quiet speech still boosted', quietNew > quietOld - 3, `${(quietNew - quietOld).toFixed(1)} dB vs no hold`);
check('quiet speech audibly lifted', quietNew > -30, `${quietNew.toFixed(1)} dB out of -42 dB in`);
check('speech is still boosted', speechNew > -20, `${speechNew.toFixed(1)} dB`);
check('speech barely changes', Math.abs(speechNew - speechOld) < 3, `${(speechNew - speechOld).toFixed(1)} dB`);
check('output stays finite', withHold.every(Number.isFinite), '');
check('no clipping', withHold.every((v) => Math.abs(v) <= 1.0001), '');

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
