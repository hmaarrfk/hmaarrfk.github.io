// Overdub worker — runs the voice model (Kyutai Pocket TTS, as ONNX) off the
// main thread, so respeaking a line doesn't freeze the page.
//
// A port of the reference Python driver (`pocket_tts_onnx.py` in
// KevinAHM/pocket-tts-onnx) onto onnxruntime-web. The weights download from
// the Hugging Face Hub the first time and are then kept in Cache Storage, the
// same deal auto-captions already makes. The reference audio — your voice —
// never leaves this worker.
//
// Five graphs, in the order they run:
//
//   mimi_encoder      reference audio (24 kHz) -> acoustic embeddings
//   flow_lm_main      embeddings -> a primed KV cache: *this is the voice*
//   text_conditioner  token ids -> text embeddings
//   flow_lm_main      one step per frame -> conditioning + an end-of-speech logit
//   flow_lm_flow      integrates a latent out of noise (flow matching)
//   mimi_decoder      latents -> 24 kHz audio
//
// The awkward part, and the reason this is a faithful port rather than a
// paraphrase: the transformer's KV cache is not hidden inside the graph. It
// is 18 tensors in and 18 tensors out, described by a manifest in bundle.json,
// and they have to be threaded through every single step by hand. Cloning a
// voice is literally "run the first graph once and keep the cache it leaves".
//
// Messages in:
//   { type: 'load', bundle }                       fetch + open the models
//   { type: 'clone', id, audio: Float32Array }     reference at 24 kHz mono
//   { type: 'speak', id, text, temperature, seed } generate, using the clone
//   { type: 'cancel' }
// Messages out:
//   { type: 'load', file, loaded, total, status }  download progress
//   { type: 'status', text }
//   { type: 'ready' }                              models open
//   { type: 'cloned', id }                         voice captured
//   { type: 'audio', id, pcm: Float32Array, sampleRate }
//   { type: 'progress', id, frames, estimate }
//   { type: 'error', id, message } | { type: 'cancelled', id }
import * as ort from './vendor/onnxruntime/ort.wasm.min.js';

// The WASM binary is far too big to vendor, so it comes from jsDelivr, pinned
// to the exact build the vendored JS came from. Threads need cross-origin
// isolation, which a plain GitHub Pages site can't have, so this is
// single-threaded on purpose rather than by accident.
const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';
ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
ort.env.wasm.numThreads = 1;
ort.env.logLevel = 'error';

const HUB = 'https://huggingface.co/';
const CACHE = 'transformers-cache';   // shared with captions, same bargain
const SAMPLE_RATE = 24000;

let models = null;        // { sessions, meta, tokenizer, bosBeforeVoice }
let modelKey = null;
let voiceState = null;    // the cloned voice: a primed KV cache
let activeId = 0;
let queue = Promise.resolve();

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'cancel') { activeId = 0; return; }
  activeId = msg.id || activeId;
  queue = queue.then(async () => {
    const post = (m) => self.postMessage({ ...m, id: msg.id });
    try {
      if (msg.type === 'load') { await load(msg.bundle, post); post({ type: 'ready' }); }
      else if (msg.type === 'clone') { await clone(msg, post); }
      else if (msg.type === 'speak') { await speak(msg, post); }
    } catch (err) {
      post({ type: 'error', message: (err && err.message) || String(err) });
    }
  });
};

// ---------------------------------------------------------------------------
// Fetching, with the same cache auto-captions uses
// ---------------------------------------------------------------------------
// Cache Storage is keyed by URL and belongs to this origin, so the live site
// and every local test port keep their own copy — same caveat as the Whisper
// weights, and the same reason to test on one fixed port.

async function fetchCached(url, post, label) {
  let cache = null;
  try { cache = await caches.open(CACHE); } catch (_) { /* private window */ }
  if (cache) {
    const hit = await cache.match(url);
    if (hit) return new Uint8Array(await hit.arrayBuffer());
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Couldn't download ${label} (${res.status})`);
  const total = Number(res.headers.get('content-length')) || 0;

  // Read it through so there is a progress bar for a 76 MB file, then put the
  // assembled body in the cache.
  const reader = res.body && res.body.getReader ? res.body.getReader() : null;
  let bytes;
  if (reader) {
    const parts = [];
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      loaded += value.length;
      post({ type: 'load', status: 'progress', file: label, loaded, total });
    }
    bytes = new Uint8Array(loaded);
    let at = 0;
    for (const p of parts) { bytes.set(p, at); at += p.length; }
  } else {
    bytes = new Uint8Array(await res.arrayBuffer());
  }
  post({ type: 'load', status: 'done', file: label, loaded: bytes.length, total: bytes.length });
  if (cache) {
    try { await cache.put(url, new Response(bytes, { headers: { 'content-length': String(bytes.length) } })); } catch (_) {}
  }
  return bytes;
}

async function load(bundle, post) {
  const key = JSON.stringify(bundle);
  if (models && modelKey === key) return;
  models = null; modelKey = null; voiceState = null;

  const base = `${HUB}${bundle.repo}/resolve/${bundle.revision || 'main'}/onnx/${bundle.language}/`;
  post({ type: 'status', text: 'Reading the voice model…' });

  const metaBytes = await fetchCached(`${base}bundle.json`, post, 'bundle.json');
  const meta = JSON.parse(new TextDecoder().decode(metaBytes));

  const tokBytes = await fetchCached(`${base}${meta.tokenizer_file}`, post, 'tokenizer');
  // voice-ui.js starts this worker with ?v=<commit> on its URL; a static import
  // would resolve without that query and could pick up a cached tokenizer from
  // an older release, so pass the version on explicitly.
  const { parseSentencePieceModel, createTokenizer } =
    await import('./voice-tokenizer.js' + self.location.search);
  const tokenizer = createTokenizer(parseSentencePieceModel(tokBytes));

  // The model's own start-of-voice embedding, a .npy. Only the header needs
  // parsing: shape and dtype, then raw little-endian float32.
  let bosBeforeVoice = null;
  if (meta.bos_before_voice_file) {
    bosBeforeVoice = parseNpy(await fetchCached(`${base}${meta.bos_before_voice_file}`, post, 'voice prefix'));
  }

  const suffix = bundle.precision === 'int8' ? '_int8' : '';
  const files = {
    // The encoder and the text conditioner are small; the reference driver
    // keeps them at full precision and so does this.
    mimiEncoder: 'mimi_encoder' + suffix,
    textConditioner: 'text_conditioner' + suffix,
    flowMain: 'flow_lm_main' + suffix,
    flowFlow: 'flow_lm_flow' + suffix,
    mimiDecoder: 'mimi_decoder' + suffix,
  };
  const opts = { executionProviders: ['wasm'], graphOptimizationLevel: 'all' };
  const sessions = {};
  for (const [name, stem] of Object.entries(files)) {
    post({ type: 'status', text: `Loading ${stem}…` });
    const bytes = await fetchCached(`${base}${stem}.onnx`, post, stem);
    sessions[name] = await ort.InferenceSession.create(bytes, opts);
  }

  models = { sessions, meta, tokenizer, bosBeforeVoice, bundle };
  modelKey = key;
}

// A .npy reader for exactly the file this needs: little-endian float32, C order.
function parseNpy(bytes) {
  if (bytes[0] !== 0x93) throw new Error('not a .npy file');
  const major = bytes[6];
  const headerLen = major >= 2
    ? new DataView(bytes.buffer, bytes.byteOffset + 8, 4).getUint32(0, true)
    : new DataView(bytes.buffer, bytes.byteOffset + 8, 2).getUint16(0, true);
  const start = (major >= 2 ? 12 : 10) + headerLen;
  const header = new TextDecoder().decode(bytes.subarray(major >= 2 ? 12 : 10, start));
  const descr = /'descr':\s*'([^']+)'/.exec(header);
  if (!descr || !/^[<|]f4$/.test(descr[1])) throw new Error(`unsupported .npy dtype ${descr && descr[1]}`);
  const shapeM = /'shape':\s*\(([^)]*)\)/.exec(header);
  const shape = shapeM[1].split(',').map((s) => s.trim()).filter(Boolean).map(Number);
  const data = new Float32Array(bytes.buffer.slice(bytes.byteOffset + start, bytes.byteOffset + bytes.length));
  return { data, shape };
}

// ---------------------------------------------------------------------------
// State: the KV cache, threaded by hand
// ---------------------------------------------------------------------------
// Each manifest entry names an input, an output, a shape, a dtype and what to
// fill it with before the first step. `nan` is not a placeholder for "unset"
// here — the graph uses NaN to mean "this cache slot has nothing in it yet",
// so filling with zeros would quietly corrupt the attention.

const DTYPES = { float32: Float32Array, int64: BigInt64Array, bool: Uint8Array };

function filled(shape, dtype, fill) {
  const n = shape.reduce((a, b) => a * b, 1);
  const Arr = DTYPES[dtype];
  if (!Arr) throw new Error(`unsupported state dtype ${dtype}`);
  const a = new Arr(n);
  if (fill === 'nan' && Arr === Float32Array) a.fill(NaN);
  else if (fill === 'ones') a.fill(Arr === BigInt64Array ? 1n : 1);
  return a;
}

function initState(manifest) {
  const state = {};
  for (const e of manifest) {
    state[e.input_name] = new ort.Tensor(e.dtype, filled(e.shape, e.dtype, e.fill), e.shape);
  }
  return state;
}

// Outputs come back in the graph's declared order: the manifest's `index` is
// relative to `offset`, which is however many real outputs precede the state.
function stateFromOutputs(session, results, manifest, offset) {
  const names = session.outputNames;
  const state = {};
  for (const e of manifest) state[e.input_name] = results[names[offset + e.index]];
  return state;
}

// ---------------------------------------------------------------------------
// Cloning: one forward pass, and keep the cache
// ---------------------------------------------------------------------------

async function clone({ audio }, post) {
  if (!models) throw new Error('The voice model is not loaded yet.');
  const { sessions, meta, bosBeforeVoice } = models;
  post({ type: 'status', text: 'Listening to the reference…' });

  const enc = await sessions.mimiEncoder.run({
    audio: new ort.Tensor('float32', audio, [1, 1, audio.length]),
  });
  let emb = enc[sessions.mimiEncoder.outputNames[0]];     // (1, frames, dim)

  // Optionally prefix the model's own start-of-voice embedding.
  let data = emb.data, frames = emb.dims[1], dim = emb.dims[2];
  if (meta.insert_bos_before_voice && bosBeforeVoice) {
    const extra = bosBeforeVoice.data.length / dim;
    const merged = new Float32Array(bosBeforeVoice.data.length + data.length);
    merged.set(bosBeforeVoice.data, 0);
    merged.set(data, bosBeforeVoice.data.length);
    data = merged;
    frames += extra;
  }

  post({ type: 'status', text: 'Learning the voice…' });
  const state = initState(meta.flow_lm_state_manifest);
  const out = await sessions.flowMain.run({
    sequence: new ort.Tensor('float32', new Float32Array(0), [1, 0, meta.latent_dim]),
    text_embeddings: new ort.Tensor('float32', data, [1, frames, dim]),
    ...state,
  });
  // Two real outputs (conditioning, eos logit) come before the state.
  voiceState = stateFromOutputs(sessions.flowMain, out, meta.flow_lm_state_manifest, 2);
  post({ type: 'cloned' });
}

// ---------------------------------------------------------------------------
// Speaking
// ---------------------------------------------------------------------------

// The reference driver's text preparation, which the model was trained to
// expect: one line, a capital at the front, a full stop at the end.
function prepareText(text, meta) {
  let t = String(text).trim().replace(/[\n\r]/g, ' ').replace(/ {2}/g, ' ');
  if (!t) throw new Error('Nothing to say.');
  if (meta.remove_semicolons) t = t.replace(/;/g, ',');
  const words = t.split(/\s+/).length;
  const framesAfterEos = words <= 4 ? 3 : 1;
  if (t[0] !== t[0].toUpperCase()) t = t[0].toUpperCase() + t.slice(1);
  if (/[a-z0-9]$/i.test(t)) t += '.';
  if (meta.pad_with_spaces_for_short_inputs && words < 5) t = ' '.repeat(8) + t;
  return { text: t, framesAfterEos };
}

// Long lines are split at sentence ends, then at clause ends, so no single run
// exceeds the model's chunk budget. Each chunk restarts from the voice state,
// which is also what keeps a long line from drifting.
function splitIntoChunks(text, meta, tokenizer) {
  const { text: prepared } = prepareText(text, meta);
  const max = meta.max_token_per_chunk || 50;
  const ids = tokenizer.encode(prepared);
  if (ids.length <= max) return [prepared.trim()];

  const boundaries = (marks) => {
    const set = new Set(tokenizer.encode(marks).slice(1));
    const idx = [0];
    let prev = false;
    ids.forEach((t, i) => {
      if (set.has(t)) prev = true;
      else { if (prev) idx.push(i); prev = false; }
    });
    idx.push(ids.length);
    return idx;
  };
  const cut = (idx) => {
    const segs = [];
    for (let i = 0; i < idx.length - 1; i++) {
      segs.push({ n: idx[i + 1] - idx[i], text: tokenizer.decode(ids.slice(idx[i], idx[i + 1])) });
    }
    return segs;
  };

  let segs = [];
  for (const s of cut(boundaries('.!...?'))) {
    if (s.n <= max) { segs.push(s); continue; }
    const sub = cut(boundaries(',;:'));
    segs = segs.concat(sub.length > 1 ? sub : [s]);
  }

  const chunks = [];
  let cur = '', curN = 0;
  for (const s of segs) {
    if (!cur) { cur = s.text; curN = s.n; continue; }
    if (curN + s.n > max) { chunks.push(cur.trim()); cur = s.text; curN = s.n; }
    else { cur += ' ' + s.text; curN += s.n; }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.length ? chunks : [prepared.trim()];
}

// A seeded generator, so the same line respoken twice sounds the same. Without
// it every regeneration is a different take, and comparing two edits of a line
// becomes impossible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Box-Muller, so the noise the flow integrates from is actually Gaussian.
function gaussian(rand, n, std) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const u = Math.max(1e-9, rand()), v = rand();
    const r = Math.sqrt(-2 * Math.log(u));
    out[i] = r * Math.cos(2 * Math.PI * v) * std;
    if (i + 1 < n) out[i + 1] = r * Math.sin(2 * Math.PI * v) * std;
  }
  return out;
}

async function speak({ id, text, temperature = 0.7, lsdSteps = 1, seed = 1234, debugLatents = false }, post) {
  if (!models) throw new Error('The voice model is not loaded yet.');
  if (!voiceState) throw new Error('No voice has been cloned yet.');
  const { sessions, meta, tokenizer } = models;
  const stopped = () => activeId !== id;

  const latents = [];
  const chunks = splitIntoChunks(text, meta, tokenizer);
  const rand = mulberry32(seed);

  for (const chunk of chunks) {
    if (stopped()) { post({ type: 'cancelled' }); return; }
    const { text: prepared, framesAfterEos: guess } = prepareText(chunk, meta);
    const framesAfterEos = meta.model_recommended_frames_after_eos ?? (guess + 2);
    const ids = tokenizer.encode(prepared);
    const chunkLatents = await runChunk({
      ids, framesAfterEos, temperature, lsdSteps, rand, post, id, stopped,
      soFar: latents.length,
    });
    if (stopped()) { post({ type: 'cancelled' }); return; }
    latents.push(...chunkLatents);
  }

  if (!latents.length) { post({ type: 'audio', pcm: new Float32Array(0), sampleRate: SAMPLE_RATE }); return; }

  // The parity check (see REQUIREMENTS.md) compares these against the Python
  // reference: the first frame proves the wiring, since nothing has fed back
  // into it yet.
  if (debugLatents) {
    const D = models.meta.latent_dim;
    const flat = new Float32Array(latents.length * D);
    latents.forEach((l, i) => flat.set(l, i * D));
    post({ type: 'latents', data: flat, dim: D, frames: latents.length });
  }

  post({ type: 'status', text: 'Rendering the audio…' });
  const pcm = await decodeLatents(latents);
  post({ type: 'audio', pcm, sampleRate: SAMPLE_RATE }, [pcm.buffer]);
}

async function runChunk({ ids, framesAfterEos, temperature, lsdSteps, rand, post, id, stopped, soFar }) {
  const { sessions, meta } = models;
  const D = meta.latent_dim;
  const manifest = meta.flow_lm_state_manifest;

  // Start from the cloned voice every chunk.
  let state = { ...voiceState };

  const textOut = await sessions.textConditioner.run({
    token_ids: new ort.Tensor('int64', BigInt64Array.from(ids, BigInt), [1, ids.length]),
  });
  const te = textOut[sessions.textConditioner.outputNames[0]];
  const textEmb = te.dims.length === 2
    ? new ort.Tensor('float32', te.data, [1, te.dims[0], te.dims[1]])
    : te;

  // Feed the text in, then step frame by frame with nothing more to read.
  const emptySeq = () => new ort.Tensor('float32', new Float32Array(0), [1, 0, D]);
  const emptyText = () => new ort.Tensor('float32', new Float32Array(0), [1, 0, meta.conditioning_dim]);

  let out = await sessions.flowMain.run({ sequence: emptySeq(), text_embeddings: textEmb, ...state });
  state = stateFromOutputs(sessions.flowMain, out, manifest, 2);

  // Roughly how long the line should take, as a ceiling on runaway generation.
  const maxFrames = Math.ceil((ids.length / 3.0 + 2.0) * meta.frame_rate);
  const dt = 1 / lsdSteps;
  const latents = [];
  let curr = new ort.Tensor('float32', new Float32Array(D).fill(NaN), [1, 1, D]);
  let eosStep = null;

  for (let step = 0; step < maxFrames; step++) {
    if (stopped()) return latents;
    out = await sessions.flowMain.run({ sequence: curr, text_embeddings: emptyText(), ...state });
    const names = sessions.flowMain.outputNames;
    const conditioning = out[names[0]];
    const eosLogit = out[names[1]];
    state = stateFromOutputs(sessions.flowMain, out, manifest, 2);

    if (eosLogit.data[0] > -4.0 && eosStep === null) eosStep = step;
    if (eosStep !== null && step >= eosStep + framesAfterEos) break;

    // Flow matching: start from noise and integrate the learned velocity field
    // to t = 1. One step is the default and is what the reference uses.
    let x = temperature > 0
      ? gaussian(rand, D, Math.sqrt(temperature))
      : new Float32Array(D);
    for (let j = 0; j < lsdSteps; j++) {
      const s = j / lsdSteps;
      const flowOut = await sessions.flowFlow.run({
        c: conditioning,
        s: new ort.Tensor('float32', Float32Array.from([s]), [1, 1]),
        t: new ort.Tensor('float32', Float32Array.from([s + dt]), [1, 1]),
        x: new ort.Tensor('float32', x, [1, D]),
      });
      const v = flowOut[sessions.flowFlow.outputNames[0]].data;
      const next = new Float32Array(D);
      for (let k = 0; k < D; k++) next[k] = x[k] + v[k] * dt;
      x = next;
    }

    latents.push(x);
    curr = new ort.Tensor('float32', x, [1, 1, D]);
    if ((step & 7) === 0) {
      post({ type: 'progress', frames: soFar + latents.length, estimate: maxFrames + soFar });
    }
  }
  return latents;
}

// The decoder is streamed in small groups of frames so a long line doesn't
// build one enormous tensor, and so its own state carries across the joins.
async function decodeLatents(latents, chunkSize = 15) {
  const { sessions, meta } = models;
  const D = meta.latent_dim;
  let state = initState(meta.mimi_state_manifest);
  const parts = [];

  for (let i = 0; i < latents.length; i += chunkSize) {
    const group = latents.slice(i, i + chunkSize);
    const flat = new Float32Array(group.length * D);
    group.forEach((l, k) => flat.set(l, k * D));
    const out = await sessions.mimiDecoder.run({
      latent: new ort.Tensor('float32', flat, [1, group.length, D]),
      ...state,
    });
    parts.push(out[sessions.mimiDecoder.outputNames[0]].data);
    state = stateFromOutputs(sessions.mimiDecoder, out, meta.mimi_state_manifest, 1);
  }

  let total = 0;
  for (const p of parts) total += p.length;
  const pcm = new Float32Array(total);
  let at = 0;
  for (const p of parts) { pcm.set(p, at); at += p.length; }
  return pcm;
}
