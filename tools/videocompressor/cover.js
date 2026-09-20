// Cover art for an MP4 — the "hero" still a player shows before you press play.
//
// MP4 has no field called "thumbnail". What it has is the iTunes-style
// metadata tree, and inside it a `covr` atom holding a whole JPEG or PNG:
//
//   moov
//    └ udta
//       └ meta  (full box: 4 bytes of version+flags, then children)
//          ├ hdlr  ('mdir' / 'appl' — "the metadata below is iTunes-style")
//          └ ilst
//             └ covr
//                └ data  (type 13 = JPEG, 14 = PNG, then the image bytes)
//
// This is what ffmpeg writes for `-disposition:v:N attached_pic`, and what
// Apple's players, VLC and Plex read. It is *metadata*, not a video track, so
// nothing about decoding the movie changes.
//
// Adding it after the fact is not quite a matter of appending bytes. `moov`
// sits in front of `mdat` here (mp4-muxer's `fastStart`), and every chunk of
// media is addressed by its **absolute offset in the file**, listed in each
// track's `stco` (or `co64`) table. Growing `moov` slides `mdat` forward, so
// every one of those offsets has to move with it or the file plays silence
// and garbage. So: patch the offsets first, then splice the new bytes in.
//
// Pure `ArrayBuffer` maths — no DOM — so `cover.test.mjs` runs it under Node.

export const JPEG = 13;   // `data` type codes, from the iTunes metadata spec
export const PNG = 14;

// ---------------------------------------------------------------------------
// Box primitives
// ---------------------------------------------------------------------------
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];

function box(type, ...chunks) {
  let len = 8;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  out.set(u32(len), 0);
  out.set(ascii(type), 4);
  let p = 8;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  return out;
}

function typeAt(dv, off) {
  return String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
}

// Every box directly inside [start, end). Stops rather than throwing on
// something malformed: a half-understood file is left alone, not corrupted.
function* boxesIn(dv, start, end) {
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    const type = typeAt(dv, p + 4);
    let header = 8;
    if (size === 1) {
      if (p + 16 > end) return;
      size = dv.getUint32(p + 8) * 4294967296 + dv.getUint32(p + 12);
      header = 16;
    } else if (size === 0) {
      size = end - p;                       // "to the end of the file"
    }
    if (size < header || p + size > end) return;
    yield { type, start: p, size, header, body: p + header, bodyEnd: p + size };
    p += size;
  }
}

function findBox(dv, start, end, type) {
  for (const b of boxesIn(dv, start, end)) if (b.type === type) return b;
  return null;
}

// Grow a box's size field in place. A 64-bit (`size === 1`) header keeps its
// shape; a 32-bit one would have to change shape to cross 4 GB, which no
// `moov` or `udta` ever does.
function growBox(dv, b, delta) {
  if (b.header === 16) {
    const n = b.size + delta;
    dv.setUint32(b.start + 8, Math.floor(n / 4294967296));
    dv.setUint32(b.start + 12, n >>> 0);
  } else {
    dv.setUint32(b.start, b.size + delta);
  }
}

// ---------------------------------------------------------------------------
// Chunk offsets
// ---------------------------------------------------------------------------
// Add `delta` to every chunk offset at or past `from`. Only the known path
// moov/trak/mdia/minf/stbl is walked — a blind recursive search would happily
// read sample *data* as if it were boxes.
function shiftChunkOffsets(dv, moov, from, delta) {
  let n = 0;
  for (const trak of boxesIn(dv, moov.body, moov.bodyEnd)) {
    if (trak.type !== 'trak') continue;
    const mdia = findBox(dv, trak.body, trak.bodyEnd, 'mdia');
    if (!mdia) continue;
    const minf = findBox(dv, mdia.body, mdia.bodyEnd, 'minf');
    if (!minf) continue;
    const stbl = findBox(dv, minf.body, minf.bodyEnd, 'stbl');
    if (!stbl) continue;
    for (const t of boxesIn(dv, stbl.body, stbl.bodyEnd)) {
      if (t.type !== 'stco' && t.type !== 'co64') continue;
      const count = dv.getUint32(t.body + 4);            // after version+flags
      const table = t.body + 8;
      const wide = t.type === 'co64';
      const stride = wide ? 8 : 4;
      if (table + count * stride > t.bodyEnd) continue;  // malformed; leave it
      for (let i = 0; i < count; i++) {
        const at = table + i * stride;
        const v = wide ? dv.getUint32(at) * 4294967296 + dv.getUint32(at + 4) : dv.getUint32(at);
        if (v < from) continue;
        const nv = v + delta;
        if (wide) { dv.setUint32(at, Math.floor(nv / 4294967296)); dv.setUint32(at + 4, nv >>> 0); }
        else if (nv > 0xffffffff) throw new Error('cover art would push a chunk offset past 4 GB');
        else dv.setUint32(at, nv);
        n++;
      }
    }
  }
  return n;
}

// ---------------------------------------------------------------------------
// Public
// ---------------------------------------------------------------------------

const HDLR_MDIR = new Uint8Array([
  0, 0, 0, 0,                 // version + flags
  0, 0, 0, 0,                 // predefined
  ...ascii('mdir'),           // handler: iTunes-style metadata
  ...ascii('appl'),           // reserved, conventionally 'appl'
  0, 0, 0, 0,
  0, 0, 0, 0,
  0,                          // empty handler name
]);

// Where a `meta` box's children begin. In MP4 it is a *full* box — four bytes
// of version and flags first — but the QuickTime `meta` that a .mov carries
// is not, and both turn up in the wild. Whichever it is, `hdlr` comes first,
// so its position says which one this is.
function metaChildStart(dv, b) {
  if (typeAt(dv, b.body + 4) === 'hdlr') return b.body;        // QuickTime: plain box
  if (typeAt(dv, b.body + 8) === 'hdlr') return b.body + 4;    // MP4: full box
  throw new Error('unfamiliar metadata layout — not touching it');
}

// Return a new ArrayBuffer: `buffer` with `image` attached as cover art.
// Throws if the file isn't shaped the way this can safely patch.
export function addCoverArt(buffer, image, kind = JPEG) {
  const src = new Uint8Array(buffer instanceof Uint8Array ? buffer.slice() : new Uint8Array(buffer).slice());
  const dv = new DataView(src.buffer, src.byteOffset, src.byteLength);

  const moov = findBox(dv, 0, src.length, 'moov');
  if (!moov) throw new Error('no moov box — not an MP4 this can tag');

  // Walk moov/udta/meta/ilst as far as the file already goes. A file this
  // tool just muxed has none of it and gets the whole tree; one that came
  // from elsewhere may already have a `udta` (ffmpeg writes an encoder tag
  // into one), and then only the missing part is inserted, at the end of the
  // deepest box that does exist.
  const chain = ['udta', 'meta', 'ilst', 'covr'];
  const grow = [moov];
  let start = moov.body, insertAt = moov.bodyEnd, depth = 0;
  for (; depth < chain.length; depth++) {
    const b = findBox(dv, start, insertAt, chain[depth]);
    if (!b) break;
    if (b.type === 'covr') throw new Error('this file already carries cover art');
    grow.push(b);
    start = b.type === 'meta' ? metaChildStart(dv, b) : b.body;
    insertAt = b.bodyEnd;
  }

  // …and build what's missing, from the inside out.
  let blob = box('covr', box('data', new Uint8Array([0, 0, 0, kind, 0, 0, 0, 0]), image));
  for (let i = chain.length - 2; i >= depth; i--) {
    blob = chain[i] === 'meta'
      ? box('meta', new Uint8Array([0, 0, 0, 0]), box('hdlr', HDLR_MDIR), blob)
      : box(chain[i], blob);
  }

  const delta = blob.length;
  shiftChunkOffsets(dv, moov, insertAt, delta);
  for (const b of grow) growBox(dv, b, delta);

  const out = new Uint8Array(src.length + delta);
  out.set(src.subarray(0, insertAt), 0);
  out.set(blob, insertAt);
  out.set(src.subarray(insertAt), insertAt + delta);
  return out.buffer;
}

// The cover art in a file, or null. Here so the tests — and anyone debugging
// an export — can read back exactly what was written.
export function findCoverArt(buffer) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const path = ['moov', 'udta', 'meta', 'ilst', 'covr'];
  let start = 0, end = u8.length, b = null;
  for (const type of path) {
    b = findBox(dv, start, end, type);
    if (!b) return null;
    start = type === 'meta' ? metaChildStart(dv, b) : b.body;
    end = b.bodyEnd;
  }
  const data = findBox(dv, start, end, 'data');
  if (!data) return null;
  return { kind: dv.getUint32(data.body) & 0xffffff, bytes: u8.subarray(data.body + 8, data.bodyEnd) };
}

// Exported for the test: the box tree as a flat list of `type@offset+size`,
// so a patched file can be compared against the one it came from.
export function boxTree(buffer, start = 0, end = null, depth = 0) {
  const u8 = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  for (const b of boxesIn(dv, start, end == null ? u8.length : end)) {
    out.push({ type: b.type, start: b.start, size: b.size, depth });
    if (['moov', 'trak', 'mdia', 'minf', 'stbl', 'udta', 'ilst', 'covr'].includes(b.type)) {
      out.push(...boxTree(u8, b.body, b.bodyEnd, depth + 1));
    } else if (b.type === 'meta') {
      out.push(...boxTree(u8, metaChildStart(dv, b), b.bodyEnd, depth + 1));
    }
  }
  return out;
}
