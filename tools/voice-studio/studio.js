// Voice Studio: record the material your voice profile is trained on, and
// hear the profile you already have.
//
// Takes are raw PCM from an AudioWorklet (no codec, no browser "enhancement":
// echo cancellation, noise suppression and auto gain are all switched off —
// each one is a processing artifact the model would learn as part of your
// voice). They are written as 24-bit WAV straight into a folder you pick,
// alongside takes.jsonl, which `server/build_voice.py ingest` reads.
import { MODES, makeQueue } from './prompts.js';

const $ = (id) => document.getElementById(id);
const VOICE_URL = 'http://127.0.0.1:7865';
const GOAL_MIN = 60;

const S = {
  ctx: null, stream: null, node: null, rate: 48000,
  rec: false, chunks: [], recStart: 0,
  meterPeak: 0, meterRms: 0,
  roomDb: null,
  dir: null, takes: [], pending: [],
  queue: makeQueue(), idx: 0,
};

// ---- persistence of the folder handle (IndexedDB can hold it) -------------
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('voice-studio', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('kv');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}
async function kv(key, value) {
  try {
    const db = await idb();
    return await new Promise((res, rej) => {
      const tx = db.transaction('kv', value === undefined ? 'readonly' : 'readwrite');
      const st = tx.objectStore('kv');
      const r = value === undefined ? st.get(key) : st.put(value, key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  } catch (_) { return undefined; }
}

// ---- audio math -------------------------------------------------------------
const db = (x) => 20 * Math.log10(Math.max(1e-9, x));

function frameDbs(x, rate, ms = 20) {
  const n = Math.round(rate * ms / 1000), out = [];
  for (let i = 0; i + n <= x.length; i += n) {
    let s = 0;
    for (let j = i; j < i + n; j++) s += x[j] * x[j];
    out.push(db(Math.sqrt(s / n)));
  }
  return out;
}
const pct = (a, p) => { const b = a.slice().sort((x, y) => x - y); return b[Math.min(b.length - 1, Math.floor(p * b.length))]; };

function measure(x, rate) {
  let peak = 0;
  for (const v of x) peak = Math.max(peak, Math.abs(v));
  const f = frameDbs(x, rate);
  const speech = f.length ? pct(f, 0.9) : -120;
  const floor = S.roomDb != null ? S.roomDb : (f.length ? pct(f, 0.1) : -120);
  return { dur: x.length / rate, peakDb: db(peak), speechDb: speech, snr: speech - floor };
}

function verdict(m) {
  const w = [];
  if (m.dur < 2) w.push('very short');
  if (m.peakDb > -0.5) w.push('clipped — turn the gain down');
  if (m.speechDb < -38) w.push('quiet — move closer or turn the gain up');
  if (m.snr < 30) w.push(`noisy (${m.snr.toFixed(0)} dB over the room)`);
  return w;
}

function wav24(x, rate) {
  const n = x.length, buf = new ArrayBuffer(44 + n * 3), v = new DataView(buf);
  const str = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); v.setUint32(4, 36 + n * 3, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 3, true); v.setUint16(32, 3, true); v.setUint16(34, 24, true);
  str(36, 'data'); v.setUint32(40, n * 3, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, x[i]));
    const q = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
    v.setUint8(o, q & 255); v.setUint8(o + 1, (q >> 8) & 255); v.setUint8(o + 2, (q >> 16) & 255);
    o += 3;
  }
  return new Blob([buf], { type: 'audio/wav' });
}

function concat(chunks) {
  let n = 0; for (const c of chunks) n += c.length;
  const out = new Float32Array(n); let o = 0;
  for (const c of chunks) { out.set(c, o); o += c.length; }
  return out;
}

// ---- microphone -------------------------------------------------------------
async function openMic() {
  if (S.ctx) return;
  S.stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1, sampleRate: 48000 },
  });
  S.ctx = new AudioContext({ sampleRate: 48000 });
  S.rate = S.ctx.sampleRate;
  // Import maps do not reach worklets, so carry this module's ?v= across by hand.
  const wl = new URL('./recorder-worklet.js', import.meta.url);
  wl.search = new URL(import.meta.url).search;
  await S.ctx.audioWorklet.addModule(wl);
  const src = S.ctx.createMediaStreamSource(S.stream);
  S.node = new AudioWorkletNode(S.ctx, 'voice-tap');
  S.node.port.onmessage = (e) => {
    const x = e.data;
    let pk = 0, ss = 0;
    for (const v of x) { pk = Math.max(pk, Math.abs(v)); ss += v * v; }
    S.meterPeak = Math.max(pk, S.meterPeak * 0.95);
    S.meterRms = Math.sqrt(ss / x.length);
    if (S.rec) S.chunks.push(x);
  };
  src.connect(S.node);
  const track = S.stream.getAudioTracks()[0];
  const st = track.getSettings ? track.getSettings() : {};
  $('mic-info').textContent = `${track.label || 'Microphone'} · ${S.rate / 1000} kHz`
    + (st.echoCancellation || st.noiseSuppression || st.autoGainControl ? ' · ⚠ the browser kept some processing on' : ' · raw (no browser processing)');
  $('btn-mic').textContent = 'Microphone on';
  $('btn-mic').disabled = true;
  $('btn-room').disabled = false;
  $('btn-rec').disabled = false;
  requestAnimationFrame(drawMeter);
}

function drawMeter() {
  const pk = db(S.meterPeak), rms = db(S.meterRms);
  const w = Math.max(0, Math.min(100, (rms + 70) / 70 * 100));
  const bar = $('meter-bar');
  bar.style.width = `${w}%`;
  bar.style.background = pk > -1 ? 'var(--danger)' : pk > -8 ? 'var(--warn, #d69e2e)' : 'var(--accent)';
  $('meter-text').textContent = `peak ${pk.toFixed(0)} dBFS · level ${rms.toFixed(0)} dBFS`;
  requestAnimationFrame(drawMeter);
}

async function recordRoom() {
  await openMic();
  const btn = $('btn-room');
  btn.disabled = true;
  S.chunks = []; S.rec = true;
  for (let s = 5; s > 0; s--) { btn.textContent = `Stay quiet… ${s}`; await new Promise((r) => setTimeout(r, 1000)); }
  S.rec = false;
  const x = concat(S.chunks);
  S.roomDb = pct(frameDbs(x, S.rate), 0.5);
  const v = S.roomDb <= -65 ? 'excellent' : S.roomDb <= -58 ? 'good' : S.roomDb <= -50 ? 'usable — a quieter room will help' : 'too noisy — find a quieter spot or turn off fans';
  $('room-info').textContent = `Room floor ${S.roomDb.toFixed(0)} dBFS — ${v}.`;
  btn.textContent = 'Measure again';
  btn.disabled = false;
  await saveTake(x, { id: 'room-tone', mode: 'room', title: 'room tone' }, true);
}

// ---- prompts ----------------------------------------------------------------
function showPrompt() {
  const p = S.queue[S.idx % S.queue.length];
  const m = MODES[p.mode];
  $('p-mode').textContent = m.label;
  $('p-how').textContent = m.how;
  $('p-title').textContent = p.title;
  const ul = $('p-points');
  ul.innerHTML = '';
  (p.points || []).forEach((t) => { const li = document.createElement('li'); li.textContent = t; ul.appendChild(li); });
  ul.hidden = !(p.points && p.points.length);
  $('p-count').textContent = `Prompt ${S.idx + 1}`;
}

async function toggleRec() {
  await openMic();
  const btn = $('btn-rec');
  if (!S.rec) {
    if (S.ctx.state === 'suspended') await S.ctx.resume();
    S.chunks = []; S.rec = true; S.recStart = performance.now();
    btn.textContent = 'Stop (space)';
    btn.classList.add('on');
    tick();
    return;
  }
  S.rec = false;
  btn.textContent = 'Record (space)';
  btn.classList.remove('on');
  const x = concat(S.chunks);
  const prompt = S.queue[S.idx % S.queue.length];
  await saveTake(x, prompt);
  S.idx++;
  showPrompt();
}

function tick() {
  if (!S.rec) { $('rec-time').textContent = ''; return; }
  const s = (performance.now() - S.recStart) / 1000;
  $('rec-time').textContent = `● ${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  setTimeout(tick, 250);
}

// ---- takes ------------------------------------------------------------------
async function saveTake(x, prompt, quiet = false) {
  // Trim the key clicks at either end: 150 ms in, 250 ms out.
  const a = Math.min(x.length, Math.round(0.15 * S.rate)), b = Math.max(a, x.length - Math.round(0.25 * S.rate));
  x = x.subarray(a, b);
  const m = measure(x, S.rate);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = `take-${stamp}-${prompt.id}.wav`;
  const rec = {
    file, id: prompt.id, mode: prompt.mode, prompt: prompt.title, at: new Date().toISOString(),
    dur: +m.dur.toFixed(2), peakDb: +m.peakDb.toFixed(1), speechDb: +m.speechDb.toFixed(1), snrDb: +m.snr.toFixed(1),
    roomDb: S.roomDb != null ? +S.roomDb.toFixed(1) : null,
  };
  const blob = wav24(x, S.rate);
  if (S.dir) {
    try {
      const fh = await S.dir.getFileHandle(file, { create: true });
      const w = await fh.createWritable(); await w.write(blob); await w.close();
      S.takes.push(rec);
      await writeIndex();
    } catch (e) {
      S.pending.push({ rec, blob });
      $('folder-info').textContent = `Could not write to the folder (${e.message}); takes are kept in this tab.`;
    }
  } else {
    S.pending.push({ rec, blob });
  }
  if (!quiet) renderTake(rec, blob, verdict(m));
  renderTotals();
}

async function writeIndex() {
  const fh = await S.dir.getFileHandle('takes.jsonl', { create: true });
  const w = await fh.createWritable();
  await w.write(S.takes.map((t) => JSON.stringify(t)).join('\n') + '\n');
  await w.close();
}

function renderTake(rec, blob, warn) {
  const li = document.createElement('li');
  li.className = 'take';
  const url = URL.createObjectURL(blob);
  li.innerHTML = `<div class="take-head"><span class="take-name"></span><span class="take-meta"></span></div>
    <audio controls preload="none"></audio><div class="take-warn"></div>
    <button class="btn small" type="button">Discard</button>`;
  li.querySelector('.take-name').textContent = `${MODES[rec.mode] ? MODES[rec.mode].label : rec.mode}: ${rec.prompt}`;
  li.querySelector('.take-meta').textContent = `${rec.dur.toFixed(1)} s · voice ${rec.speechDb} dBFS · ${rec.snrDb} dB over room`;
  li.querySelector('audio').src = url;
  li.querySelector('.take-warn').textContent = warn.length ? `⚠ ${warn.join('; ')}` : '✓ looks good';
  li.querySelector('.take-warn').className = `take-warn ${warn.length ? 'bad' : 'good'}`;
  li.querySelector('button').onclick = async () => {
    S.takes = S.takes.filter((t) => t.file !== rec.file);
    S.pending = S.pending.filter((p) => p.rec.file !== rec.file);
    if (S.dir) {
      try { await S.dir.removeEntry(rec.file); } catch (_) {}
      try { await writeIndex(); } catch (_) {}
    }
    li.remove();
    renderTotals();
  };
  $('takes').prepend(li);
}

function renderTotals() {
  const all = [...S.takes, ...S.pending.map((p) => p.rec)].filter((t) => t.mode !== 'room');
  const min = all.reduce((s, t) => s + t.dur, 0) / 60;
  $('total').textContent = `${min.toFixed(1)} of ${GOAL_MIN} minutes recorded (${all.length} takes)`;
  $('total-bar').style.width = `${Math.min(100, (min / GOAL_MIN) * 100)}%`;
  $('btn-download').hidden = !S.pending.length;
}

// ---- folder -----------------------------------------------------------------
async function useFolder(handle, ask) {
  const perm = await handle.queryPermission({ mode: 'readwrite' });
  if (perm !== 'granted') {
    if (!ask || (await handle.requestPermission({ mode: 'readwrite' })) !== 'granted') return false;
  }
  S.dir = handle;
  S.takes = [];
  try {
    const f = await (await handle.getFileHandle('takes.jsonl')).getFile();
    S.takes = (await f.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
  } catch (_) {}
  // Anything recorded before the folder was chosen goes in now.
  for (const { rec, blob } of S.pending.splice(0)) {
    const fh = await handle.getFileHandle(rec.file, { create: true });
    const w = await fh.createWritable(); await w.write(blob); await w.close();
    S.takes.push(rec);
  }
  if (S.takes.length) await writeIndex();
  $('folder-info').textContent = `Saving to “${handle.name}”. Then: python build_voice.py ingest <that folder>/*.wav`;
  renderTotals();
  return true;
}

async function chooseFolder() {
  if (!window.showDirectoryPicker) {
    $('folder-info').textContent = 'This browser cannot write to a folder; use “Download takes” instead (Chrome and Edge can).';
    return;
  }
  const h = await window.showDirectoryPicker({ id: 'voice-studio', mode: 'readwrite', startIn: 'documents' });
  await kv('dir', h);
  await useFolder(h, true);
}

function downloadPending() {
  for (const { rec, blob } of S.pending) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = rec.file; a.click();
  }
  const idx = new Blob([S.pending.map((p) => JSON.stringify(p.rec)).join('\n') + '\n'], { type: 'application/json' });
  const a = document.createElement('a'); a.href = URL.createObjectURL(idx); a.download = 'takes.jsonl'; a.click();
}

// ---- hear the profile you have ----------------------------------------------
async function probe() {
  try {
    const r = await fetch(`${VOICE_URL}/health`, { targetAddressSpace: 'loopback', cache: 'no-store' });
    const j = await r.json();
    const p = j.profile || {};
    $('srv-info').textContent = `Voice server running: “${p.name}” (${p.engine}, ${Math.round(p.sampleRate / 1000)} kHz). ${p.provenance && p.provenance.training_data ? `Trained on ${p.provenance.training_data}.` : ''}`;
    $('btn-speak').disabled = false;
  } catch (_) {
    $('srv-info').textContent = 'No voice server on this machine. Start it with: python server/voice_server.py';
    $('btn-speak').disabled = true;
  }
}

async function speak() {
  const text = $('say-text').value.trim();
  if (!text) return;
  const btn = $('btn-speak');
  btn.disabled = true;
  $('say-status').textContent = 'Speaking…';
  try {
    const parts = text.split(/(?<=[.?!])\s+(?=[A-Z0-9"“(])/).map((t, i, a) => ({ text: t, pauseAfterS: i < a.length - 1 ? 0.36 : 0, kind: i < a.length - 1 ? 'sentence' : 'end' }));
    const r = await fetch(`${VOICE_URL}/speak`, {
      targetAddressSpace: 'loopback', method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts, seed: (Math.random() * 1e9) | 0 }),
    });
    const lines = (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const au = lines.find((m) => m.type === 'audio');
    const err = lines.find((m) => m.type === 'error');
    if (!au) throw new Error(err ? err.message : 'no audio came back');
    const bin = atob(au.pcm), bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const pcm = new Float32Array(bytes.buffer);
    $('say-audio').src = URL.createObjectURL(wav24(pcm, au.sampleRate));
    $('say-audio').play();
    $('say-status').textContent = `${(pcm.length / au.sampleRate).toFixed(1)} s`;
  } catch (e) {
    $('say-status').textContent = `Failed: ${e.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ---- wiring -----------------------------------------------------------------
$('btn-mic').onclick = () => openMic().catch((e) => { $('mic-info').textContent = `Microphone unavailable: ${e.message}`; });
$('btn-room').onclick = recordRoom;
$('btn-rec').onclick = toggleRec;
$('btn-skip').onclick = () => { if (!S.rec) { S.idx++; showPrompt(); } };
$('btn-folder').onclick = () => chooseFolder().catch((e) => { $('folder-info').textContent = e.message; });
$('btn-download').onclick = downloadPending;
$('btn-speak').onclick = speak;
$('btn-probe').onclick = probe;
document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || /INPUT|TEXTAREA|SELECT|BUTTON/.test(document.activeElement.tagName)) return;
  e.preventDefault();
  if (!$('btn-rec').disabled) toggleRec();
});
window.addEventListener('beforeunload', (e) => { if (S.pending.length) { e.preventDefault(); e.returnValue = ''; } });

showPrompt();
renderTotals();
probe();
kv('dir').then((h) => { if (h) useFolder(h, false).then((ok) => { if (!ok) $('folder-info').textContent = `Last folder: “${h.name}” — press Choose folder to reconnect.`; }); });
