// Auto-captions worker — runs Whisper (via transformers.js) off the main
// thread so the page stays responsive while it transcribes.
//
// The model weights download from the Hugging Face Hub the first time and
// are then kept in the browser's Cache Storage, so later visits start
// straight away. The audio never leaves this worker.
//
// Messages in:
//   { type: 'transcribe', model, dtype, device, audio: Float32Array (16 kHz mono),
//     chunks: [{ start, end, silent }] (sample indices), language: 'auto' | code }
//   { type: 'cancel' }
// Messages out:
//   { type: 'load', file, loaded, total, status }   model download progress
//   { type: 'status', text }
//   { type: 'language', language }                  detected (auto) or chosen
//   { type: 'chunk', index, total, words: [{ text, start, end }] }   seconds
//   { type: 'done' } | { type: 'cancelled' } | { type: 'error', message }
import { pipeline, env, Tensor } from './vendor/transformers/transformers.min.js';

env.allowLocalModels = false;   // models only ever come from the Hub (and its cache)

const SAMPLE_RATE = 16000;
let asr = null, asrKey = null;
let activeId = 0;               // the job allowed to keep running; 0 = none
let queue = Promise.resolve();  // jobs run one at a time on the one model

self.onmessage = (e) => {
  const msg = e.data;
  if (msg.type === 'cancel') { activeId = 0; return; }
  if (msg.type !== 'transcribe') return;
  activeId = msg.id;            // a newer job supersedes any older one
  queue = queue.then(async () => {
    const post = (m) => self.postMessage({ ...m, id: msg.id });
    try {
      await transcribe(msg, post);
    } catch (err) {
      post({ type: 'error', message: (err && err.message) || String(err) });
    }
  });
};

async function loadModel({ model, dtype, device }, post) {
  const key = JSON.stringify([model, dtype, device]);
  if (asr && asrKey === key) return;
  if (asr) { try { await asr.dispose(); } catch (_) {} asr = null; asrKey = null; }
  post({ type: 'status', text: 'Loading the speech model…' });
  asr = await pipeline('automatic-speech-recognition', model, {
    dtype, device,
    progress_callback: (p) => {
      if (p.status === 'progress' || p.status === 'done' || p.status === 'initiate') {
        post({ type: 'load', status: p.status, file: p.file, loaded: p.loaded || 0, total: p.total || 0 });
      }
    },
  });
  asrKey = key;
}

// transformers.js doesn't auto-detect Whisper's language yet (it silently
// assumes English), so do what Whisper itself does: run one decoder step
// after <|startoftranscript|> and pick the most likely language token.
async function detectLanguage(audio) {
  const { input_features } = await asr.processor(audio);
  const gc = asr.model.generation_config;
  const out = await asr.model({
    input_features,
    decoder_input_ids: new Tensor('int64', BigInt64Array.from([BigInt(gc.decoder_start_token_id)]), [1, 1]),
  });
  const logits = out.logits.type === 'float32' ? out.logits : out.logits.to('float32');
  let best = null, bestV = -Infinity;
  for (const [tok, id] of Object.entries(gc.lang_to_id || {})) {
    if (logits.data[id] > bestV) { bestV = logits.data[id]; best = tok; }
  }
  return best ? best.slice(2, -2) : 'en';   // '<|fr|>' -> 'fr'
}

async function transcribe({ id, model, dtype, device, audio, chunks, language }, post) {
  const stopped = () => activeId !== id;
  if (stopped()) { post({ type: 'cancelled' }); return; }
  await loadModel({ model, dtype, device }, post);
  if (stopped()) { post({ type: 'cancelled' }); return; }

  let lang = language;
  if (!lang || lang === 'auto') {
    const first = chunks.find((c) => !c.silent);
    post({ type: 'status', text: 'Detecting the language…' });
    lang = first ? await detectLanguage(audio.subarray(first.start, first.end)) : 'en';
  }
  post({ type: 'language', language: lang });

  for (let i = 0; i < chunks.length; i++) {
    if (stopped()) { post({ type: 'cancelled' }); return; }
    const c = chunks[i];
    const words = [];
    if (!c.silent) {
      const r = await asr(audio.subarray(c.start, c.end), { return_timestamps: 'word', language: lang, task: 'transcribe' });
      const off = c.start / SAMPLE_RATE;
      const len = (c.end - c.start) / SAMPLE_RATE;
      for (const w of r.chunks || []) {
        const [a, b] = w.timestamp;
        const s = Math.min(a ?? 0, len), en = Math.min(b ?? a ?? 0, len);
        words.push({ text: w.text, start: off + s, end: off + Math.max(s, en) });
      }
    }
    post({ type: 'chunk', index: i, total: chunks.length, words });
  }
  post({ type: 'done' });
}
