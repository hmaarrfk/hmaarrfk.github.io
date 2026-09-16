import { createTimeStretcher } from './speed.js';

const SR = 48000;

function zeroCrossRate(x, channels = 1) {
  let n = 0;
  for (let i = channels; i < x.length; i += channels) {
    if ((x[i] >= 0) !== (x[i - channels] >= 0)) n++;
  }
  return n / (x.length / channels) * SR / 2;   // ≈ frequency for a sine
}

function rms(x) {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

function run(speed, channels, seconds, freq, chunkFrames = 1024) {
  const total = Math.round(seconds * SR);
  const input = new Float32Array(total * channels);
  for (let i = 0; i < total; i++) {
    const v = Math.sin((2 * Math.PI * freq * i) / SR);
    for (let c = 0; c < channels; c++) input[i * channels + c] = v;
  }
  const st = createTimeStretcher({ sampleRate: SR, channels, speed });
  const parts = [];
  for (let i = 0; i < total; i += chunkFrames) {
    const n = Math.min(chunkFrames, total - i);
    parts.push(st.process(input.subarray(i * channels, (i + n) * channels)));
  }
  parts.push(st.flush());
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Float32Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return { input, out, outFrames: len / channels, total };
}

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

for (const speed of [1.5, 2, 4, 8]) {
  for (const channels of [1, 2]) {
    const { out, outFrames, total } = run(speed, channels, 2, 220);
    const expected = total / speed;
    // WSOLA emits whole windows, so the result overshoots by at most a window
    // plus the flushed tail — a fixed cost, not drift. The export trims each
    // section to its exact frame count, so what matters is that the overshoot
    // stays bounded and the output is never short.
    const over = outFrames - expected;
    const windowFrames = Math.round(0.04 * SR);
    check(`${speed}x ${channels}ch length`, over >= -windowFrames && over <= 2 * windowFrames,
      `${outFrames} frames vs ${Math.round(expected)} expected (${over >= 0 ? '+' : ''}${(over / SR * 1000).toFixed(0)} ms)`);

    // pitch must survive: a 220 Hz sine stays 220 Hz
    const mid = out.subarray(Math.floor(outFrames * 0.3) * channels, Math.floor(outFrames * 0.7) * channels);
    const f = zeroCrossRate(mid, channels);
    check(`${speed}x ${channels}ch pitch`, Math.abs(f - 220) < 25, `${f.toFixed(0)} Hz (want 220)`);

    // level must survive: overlap-add shouldn't dip or boost
    const level = rms(mid);
    check(`${speed}x ${channels}ch level`, Math.abs(level - 0.707) < 0.12, `rms ${level.toFixed(3)} (want ~0.707)`);
  }
}

// chunk size must not change the result materially
const a = run(2, 1, 1, 300, 256).outFrames;
const b = run(2, 1, 1, 300, 8192).outFrames;
check('chunk size independence', Math.abs(a - b) <= 2 * 960, `${a} vs ${b} frames`);

// silence in, silence out (no NaNs from the normalised search)
const { out: sil } = run(4, 2, 0.5, 0);
check('silence stays finite', sil.every((v) => Number.isFinite(v)), '');

console.log(failures ? `\n${failures} failure(s)` : '\nall good');
process.exit(failures ? 1 : 0);
