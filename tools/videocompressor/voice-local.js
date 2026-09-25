// The "My voice" engine: the same conversation voice-ui.js has with
// voice-worker.js, held instead with a voice server on this machine
// (tools/voice-studio/server/voice_server.py).
//
// Why a server at all, on a page that otherwise runs entirely in the browser:
// the in-browser model is 100M parameters cloned from ~10 s of the video, and
// it sounds like it. The server runs a 2B model with a LoRA trained on an hour
// of your own narration, on the machine's GPU. Nothing leaves the machine —
// the page talks to 127.0.0.1, and the server only answers this site.
//
// It looks like a Worker on purpose (postMessage in, 'message' events out,
// the same message types), so `ask()` in voice-ui.js drives either engine
// without knowing which one it has.
//
//   in:  { type: 'load' } | { type: 'clone' } | { type: 'speak', parts, seed }
//        | { type: 'cancel' }
//   out: { type: 'status', text } | { type: 'ready' } | { type: 'cloned' }
//        | { type: 'progress', frames, estimate }
//        | { type: 'audio', pcm, sampleRate, parts } | { type: 'error', message }
//        | { type: 'cancelled' }

export const LOCAL_VOICE_URL = 'http://127.0.0.1:7865';

export const START_HINT =
  'Start it with: conda activate voxcpm && python tools/voice-studio/server/voice_server.py';

function b64ToFloat32(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

// Chrome asks before a public page may reach a loopback address ("Local
// Network Access"); the hint lets it ask up front instead of failing. Other
// browsers ignore the option.
const LOOPBACK = { targetAddressSpace: 'loopback' };

/** One /health round trip: the profile, or null when nothing is listening. */
export async function probeLocalVoice(base = LOCAL_VOICE_URL, timeoutMs = 2500) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(`${base}/health`, { ...LOOPBACK, signal: ctl.signal, cache: 'no-store' });
    if (!r.ok) return null;
    const j = await r.json();
    return j && j.ok ? j : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

/** The profiles the server can speak as: [{ name, engine, schema, active }]. */
export async function listLocalProfiles(base = LOCAL_VOICE_URL) {
  const r = await fetch(`${base}/profiles`, { ...LOOPBACK, cache: 'no-store' });
  const j = await r.json();
  if (!j.ok) throw new Error(j.message || 'The voice server could not list its profiles.');
  return j.profiles || [];
}

/**
 * Hand a `.voice.zip` to the server, which checks it (schema, checksums, file
 * list) before installing it. Resolves to the installed profile's name.
 */
export async function importLocalProfile(file, { replace = false } = {}, base = LOCAL_VOICE_URL) {
  const r = await fetch(`${base}/profiles/import${replace ? '?replace=1' : ''}`, {
    ...LOOPBACK, method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: file,
  });
  let j = {};
  try { j = await r.json(); } catch (_) {}
  if (!r.ok || !j.ok) {
    const err = new Error(j.message || `The voice server answered ${r.status}.`);
    err.exists = /already exists/.test(err.message);
    throw err;
  }
  return j.name;
}

export class LocalVoice extends EventTarget {
  constructor(base = LOCAL_VOICE_URL, profile = null) {
    super();
    this.base = base;
    this.profile = profile;     // which profile speaks; null = whichever is active
    this.job = null;            // { id, ctl } of the speak in flight
  }

  post(data) { this.dispatchEvent(new MessageEvent('message', { data })); }

  terminate() { if (this.job) this.job.ctl.abort(); }

  postMessage(msg) {
    const { type, id } = msg;
    if (type === 'cancel') {
      if (this.job) {
        const { id: jid, ctl } = this.job;
        this.job = null;
        ctl.abort();
        this.post({ type: 'cancelled', id: jid });
      }
      return;
    }
    const run = type === 'load' ? this.load(id)
      : type === 'clone' ? Promise.resolve(this.post({ type: 'cloned', id }))
      : type === 'speak' ? this.speak(msg)
      : Promise.reject(new Error(`unknown message ${type}`));
    run.catch((e) => {
      if (e && e.name === 'AbortError') return;
      this.post({ type: 'error', id, message: e && e.message ? e.message : String(e) });
    });
  }

  async load(id) {
    this.post({ type: 'status', id, text: 'Looking for your voice server…' });
    const h = await probeLocalVoice(this.base);
    if (!h) {
      throw new Error(`No voice server is answering on ${this.base}. ${START_HINT}`);
    }
    if (!h.profile && !this.profile) {
      throw new Error('The voice server has no voice profile yet. Load a .voice.zip under Voice.');
    }
    const name = this.profile || (h.profile && h.profile.name);
    this.post({ type: 'status', id, text: `Speaking as “${name}”.` });
    this.post({ type: 'ready', id });
  }

  async speak({ id, parts, seed }) {
    const ctl = new AbortController();
    this.job = { id, ctl };
    const res = await fetch(`${this.base}/speak`, {
      ...LOOPBACK,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ parts, seed, ...(this.profile ? { profile: this.profile } : {}) }),
      signal: ctl.signal,
    });
    if (!res.ok || !res.body) {
      let msg = `The voice server answered ${res.status}.`;
      try { msg = (await res.json()).message || msg; } catch (_) {}
      throw new Error(msg);
    }
    // NDJSON: progress lines while it works, then the audio.
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (value) buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (this.job && this.job.id !== id) return;          // cancelled meanwhile
        if (m.type === 'progress') {
          this.post({ type: 'progress', id, frames: m.done, estimate: m.total });
          this.post({ type: 'status', id, text: `Speaking sentence ${Math.min(m.done + 1, m.total)} of ${m.total}…` });
        } else if (m.type === 'status') {
          this.post({ type: 'status', id, text: m.text });
        } else if (m.type === 'error') {
          throw new Error(m.message || 'The voice server failed.');
        } else if (m.type === 'audio') {
          const pcm = b64ToFloat32(m.pcm);
          this.job = null;
          this.post({
            type: 'audio', id, pcm, sampleRate: m.sampleRate,
            parts: m.parts.map((p) => ({ start: p.start, end: p.end })),
          });
          return;
        }
      }
      if (done) break;
    }
    throw new Error('The voice server hung up before sending the audio.');
  }
}
