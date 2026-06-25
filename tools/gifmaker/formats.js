// formats.js — Animated WebP + APNG encoders and metadata patchers for the GIF
// Maker. The GIF path stays in gifmaker.js (gifski). The two extra output
// formats are assembled here so the byte-level container code lives in one place:
//
//   • Animated WebP — each frame is encoded to a standalone lossy WebP via the
//     vendored @jsquash/webp (libwebp compiled to WebAssembly), then the frames
//     are muxed into one animated WebP container (RIFF: VP8X + ANIM + ANMF…).
//     We mux ourselves so we control the exact byte layout (and the quality is a
//     real per-frame knob, unlike the muxer-only libraries).
//   • APNG — UPNG.js (vendored, exposed as a global) encodes the RGBA frames
//     straight to an animated PNG; quality is its lossy colour count (cnum).
//
// Both formats support instant speed/loop edits via in-place metadata patchers
// (patchWebp / patchApng), mirroring patchGif in gifmaker.js: the base animation
// is encoded once at 1× speed / infinite loop, then timing & looping are rewritten
// in the bytes — no re-encode.

import encodeWebpFrame from './vendor-webp/encode.js';

// ---- little-endian / big-endian byte writers -------------------------------
function w24le(a, o, v) { a[o] = v & 0xff; a[o + 1] = (v >> 8) & 0xff; a[o + 2] = (v >> 16) & 0xff; }
function w32le(a, o, v) { a[o] = v & 0xff; a[o + 1] = (v >> 8) & 0xff; a[o + 2] = (v >> 16) & 0xff; a[o + 3] = (v >>> 24) & 0xff; }
function rd32le(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] * 0x1000000)) >>> 0; }

// A RIFF chunk: FourCC(4) + size(4, LE) + payload + one pad byte if size is odd.
function riffChunk(fourcc, payload) {
  const size = payload.length;
  const out = new Uint8Array(8 + size + (size & 1));
  out[0] = fourcc.charCodeAt(0); out[1] = fourcc.charCodeAt(1);
  out[2] = fourcc.charCodeAt(2); out[3] = fourcc.charCodeAt(3);
  w32le(out, 4, size);
  out.set(payload, 8);
  return out;
}

// ===========================================================================
// Animated WebP
// ===========================================================================

// Pull the image sub-chunks (optional ALPH, then VP8/VP8L) out of a single-frame
// WebP file so they can be wrapped in an ANMF frame. A standalone lossy+alpha
// WebP is the extended form (VP8X + ALPH + VP8 ); a plain lossy one is just VP8 .
// We drop the outer VP8X (the animation gets one VP8X for the whole canvas).
function webpFrameChunks(file) {
  let p = 12; // skip 'RIFF'(4) + size(4) + 'WEBP'(4)
  const parts = [];
  let hasAlpha = false;
  while (p + 8 <= file.length) {
    const cc = String.fromCharCode(file[p], file[p + 1], file[p + 2], file[p + 3]);
    const size = rd32le(file, p + 4);
    const total = 8 + size + (size & 1);
    if (cc === 'ALPH') { hasAlpha = true; parts.push(file.subarray(p, p + total)); }
    else if (cc === 'VP8 ') { parts.push(file.subarray(p, p + total)); }
    else if (cc === 'VP8L') { hasAlpha = true; parts.push(file.subarray(p, p + total)); } // VP8L may carry alpha
    // VP8X / ICCP / EXIF / XMP on a single frame: ignored (we rebuild VP8X).
    p += total;
  }
  const len = parts.reduce((a, b) => a + b.length, 0);
  const data = new Uint8Array(len);
  let o = 0; for (const part of parts) { data.set(part, o); o += part.length; }
  return { data, hasAlpha };
}

// Map our loop convention (-1 infinite, 0 play-once, n finite) to WebP/APNG's
// "play count" (0 = infinite, n = play n times).
function playCount(loop) { return loop < 0 ? 0 : (loop === 0 ? 1 : loop); }

// Encode an array of ImageData frames to one animated WebP (Uint8Array).
// quality: 0–100 (libwebp lossy). loop: -1 infinite / 0 once / n.
export async function encodeWebpAnim({ frames, width, height, frameDurations, quality, loop = -1 }) {
  const opts = { quality: Math.max(0, Math.min(100, Math.round(quality))), lossless: 0 };
  const frameData = [];
  let anyAlpha = false;
  for (const f of frames) {
    const fileBuf = await encodeWebpFrame({ data: f.data, width: f.width, height: f.height }, opts);
    const { data, hasAlpha } = webpFrameChunks(new Uint8Array(fileBuf));
    anyAlpha = anyAlpha || hasAlpha;
    frameData.push(data);
  }

  // One ANMF per frame: position 0,0; full canvas size; duration; flags = 0x03
  // (do-not-blend → overwrite, dispose-to-background) so each full frame replaces
  // the previous one cleanly and transparency reads correctly.
  const anmf = frameData.map((fd, i) => {
    const payload = new Uint8Array(16 + fd.length);
    w24le(payload, 0, 0);                 // frame X (2-px units)
    w24le(payload, 3, 0);                 // frame Y
    w24le(payload, 6, width - 1);         // frame width − 1
    w24le(payload, 9, height - 1);        // frame height − 1
    w24le(payload, 12, Math.max(0, Math.round(frameDurations[i]))); // duration (ms)
    payload[15] = 0x03;                   // blending=do-not-blend, disposal=background
    payload.set(fd, 16);
    return riffChunk('ANMF', payload);
  });

  // VP8X: Alpha (0x10) when any frame had alpha, Animation (0x02) always.
  const vp8x = new Uint8Array(10);
  vp8x[0] = (anyAlpha ? 0x10 : 0x00) | 0x02;
  w24le(vp8x, 4, width - 1);
  w24le(vp8x, 7, height - 1);

  // ANIM: background colour BGRA = transparent (0), then 16-bit loop count.
  const anim = new Uint8Array(6);
  const lc = playCount(loop);
  anim[4] = lc & 0xff; anim[5] = (lc >> 8) & 0xff;

  const body = [riffChunk('VP8X', vp8x), riffChunk('ANIM', anim), ...anmf];
  const bodyLen = body.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(12 + bodyLen);
  out[0] = 0x52; out[1] = 0x49; out[2] = 0x46; out[3] = 0x46; // 'RIFF'
  w32le(out, 4, 4 + bodyLen);                                 // chunk size = 'WEBP' + body
  out[8] = 0x57; out[9] = 0x45; out[10] = 0x42; out[11] = 0x50; // 'WEBP'
  let o = 12; for (const c of body) { out.set(c, o); o += c.length; }
  return out;
}

// Rewrite an animated WebP's per-frame duration (ms) and loop count in place — no
// re-encode. RIFF has no per-chunk checksum, so this is a plain top-level walk
// (the ANMF chunk's nested frame data is skipped via its size). loop: see above.
export function patchWebp(src, delayMs, loop) {
  const b = new Uint8Array(src);
  const d = Math.max(0, Math.round(delayMs));
  const lc = playCount(loop);
  let p = 12;
  while (p + 8 <= b.length) {
    const cc = String.fromCharCode(b[p], b[p + 1], b[p + 2], b[p + 3]);
    const size = rd32le(b, p + 4);
    const payload = p + 8;
    if (cc === 'ANIM') { b[payload + 4] = lc & 0xff; b[payload + 5] = (lc >> 8) & 0xff; }
    else if (cc === 'ANMF') { b[payload + 12] = d & 0xff; b[payload + 13] = (d >> 8) & 0xff; b[payload + 14] = (d >> 16) & 0xff; }
    p = payload + size + (size & 1);
  }
  return b;
}

// ===========================================================================
// APNG (via UPNG.js + pako, loaded as globals before this module)
// ===========================================================================

let CRC_TABLE = null;
function crc32(buf, off, len) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xFFFFFFFF;
  for (let i = 0; i < len; i++) c = CRC_TABLE[(c ^ buf[off + i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

// Encode ImageData frames to an APNG (Uint8Array). cnum: 0 = lossless, else the
// number of palette colours (smaller = more compression). loop applied via patch.
export function encodeApngAnim({ frames, width, height, frameDurations, cnum = 0, loop = -1 }) {
  if (!window.UPNG) throw new Error('UPNG.js not loaded');
  // ImageData.data is a Uint8ClampedArray; pass a tight copy of each frame's buffer.
  const bufs = frames.map((f) => f.data.buffer.slice(f.data.byteOffset, f.data.byteOffset + f.data.byteLength));
  const dels = frameDurations.map((x) => Math.max(0, Math.round(x)));
  const png = window.UPNG.encode(bufs, width, height, cnum || 0, dels);
  // UPNG defaults to num_plays = 0 (infinite); set the requested loop count.
  return patchApng(new Uint8Array(png), null, loop);
}

// Rewrite an APNG's per-frame delay (ms) and loop count in place, recomputing the
// CRC of each touched chunk. delayMs may be null to patch only the loop count.
// APNG delay is delay_num/delay_den seconds; we fix delay_den = 1000 (ms).
export function patchApng(src, delayMs, loop) {
  const b = new Uint8Array(src);
  const setDelay = delayMs != null;
  const d = setDelay ? Math.min(65535, Math.max(0, Math.round(delayMs))) : 0;
  const plays = playCount(loop);
  let p = 8; // skip the 8-byte PNG signature
  while (p + 8 <= b.length) {
    const len = (b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    const dataStart = p + 8;
    let changed = false;
    if (type === 'acTL') {                       // animation control: num_frames(4), num_plays(4)
      b[dataStart + 4] = (plays >>> 24) & 0xff; b[dataStart + 5] = (plays >> 16) & 0xff;
      b[dataStart + 6] = (plays >> 8) & 0xff; b[dataStart + 7] = plays & 0xff;
      changed = true;
    } else if (type === 'fcTL' && setDelay) {    // frame control: delay_num@20 (2), delay_den@22 (2)
      b[dataStart + 20] = (d >> 8) & 0xff; b[dataStart + 21] = d & 0xff;
      b[dataStart + 22] = (1000 >> 8) & 0xff; b[dataStart + 23] = 1000 & 0xff;
      changed = true;
    }
    if (changed) {
      const crc = crc32(b, p + 4, 4 + len);      // CRC covers chunk type + data
      const crcOff = dataStart + len;
      b[crcOff] = (crc >>> 24) & 0xff; b[crcOff + 1] = (crc >> 16) & 0xff;
      b[crcOff + 2] = (crc >> 8) & 0xff; b[crcOff + 3] = crc & 0xff;
    }
    if (type === 'IEND') break;
    p = dataStart + len + 4;                      // advance past data + CRC
  }
  return b;
}
