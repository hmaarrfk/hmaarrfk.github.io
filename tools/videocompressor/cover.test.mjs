// Node test for cover.js. Builds MP4s whose chunk offsets are known exactly,
// tags them, and checks that the media still sits where the tables say it
// does — which is the whole risk in growing `moov` after the fact.
//
//   node cover.test.mjs

import { addCoverArt, findCoverArt, boxTree, JPEG, PNG } from './cover.js';

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};

// ---- a tiny MP4 builder ---------------------------------------------------
const ascii = (s) => Array.from(s, (c) => c.charCodeAt(0));
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u64 = (n) => [...u32(Math.floor(n / 4294967296)), ...u32(n >>> 0)];

function box(type, ...chunks) {
  const body = chunks.flatMap((c) => Array.from(c));
  return new Uint8Array([...u32(body.length + 8), ...ascii(type), ...body]);
}
const cat = (...parts) => {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let p = 0;
  for (const c of parts) { out.set(c, p); p += c.length; }
  return out;
};

// One track whose chunk offsets are filled in once the layout is known.
function makeTrak(offsets, wide) {
  const table = wide
    ? box('co64', new Uint8Array([0, 0, 0, 0, ...u32(offsets.length), ...offsets.flatMap(u64)]))
    : box('stco', new Uint8Array([0, 0, 0, 0, ...u32(offsets.length), ...offsets.flatMap(u32)]));
  return box('trak',
    box('tkhd', new Uint8Array(84)),
    box('mdia', box('mdhd', new Uint8Array(24)), box('minf', box('stbl', box('stsd', new Uint8Array(8)), table))));
}

// Chunks of media, each a run of one distinctive byte.
const CHUNKS = [
  new Uint8Array(64).fill(0xa1),
  new Uint8Array(96).fill(0xb2),
  new Uint8Array(32).fill(0xc3),
];

// Lay out ftyp / moov / mdat in the given order, with the chunk offsets
// pointing at where each chunk really lands. Because the offsets live inside
// `moov`, whose size depends on them, the layout is computed twice — the
// second pass with the real sizes.
function buildMp4({ moovFirst = true, tracks = 1, wide = false } = {}) {
  const ftyp = box('ftyp', new Uint8Array(ascii('isomisom')));
  const mdatBody = cat(...CHUNKS);
  let offsets = CHUNKS.map(() => 0);
  let moov = null, out = null;
  for (let pass = 0; pass < 2; pass++) {
    const traks = [];
    for (let i = 0; i < tracks; i++) traks.push(makeTrak(offsets, wide));
    moov = box('moov', box('mvhd', new Uint8Array(100)), ...traks);
    const mdat = box('mdat', mdatBody);
    const mdatAt = moovFirst ? ftyp.length + moov.length : ftyp.length;
    let at = mdatAt + 8;
    offsets = CHUNKS.map((c) => { const o = at; at += c.length; return o; });
    out = moovFirst ? cat(ftyp, moov, mdat) : cat(ftyp, mdat, moov);
  }
  return { bytes: out, offsets, moovLen: moov.length };
}

// Read the chunk offsets back out of a file, in track order.
function readOffsets(buf) {
  const u8 = new Uint8Array(buf);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const out = [];
  for (const b of boxTree(u8)) {
    if (b.type !== 'stco' && b.type !== 'co64') continue;
    const count = dv.getUint32(b.start + 12);
    for (let i = 0; i < count; i++) {
      const at = b.start + 16 + i * (b.type === 'co64' ? 8 : 4);
      out.push(b.type === 'co64' ? dv.getUint32(at) * 4294967296 + dv.getUint32(at + 4) : dv.getUint32(at));
    }
  }
  return out;
}

const sameBytes = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

// A stand-in JPEG: the real SOI/EOI markers around some filler, so the bytes
// that come back can be recognised as the ones that went in.
const IMAGE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, ...new Array(500).fill(0x5a), 0xff, 0xd9]);

// ---- 1 · moov before mdat: everything shifts ------------------------------
{
  const { bytes, offsets, moovLen } = buildMp4();
  const tagged = addCoverArt(bytes, IMAGE, JPEG);
  const delta = tagged.byteLength - bytes.length;
  const got = readOffsets(tagged);

  check('file grows by exactly the inserted tree', delta > IMAGE.length && delta < IMAGE.length + 200,
    `${delta} bytes for a ${IMAGE.length}-byte image`);
  check('moov grows by the same amount',
    boxTree(tagged).find((b) => b.type === 'moov').size === moovLen + delta);
  check('every chunk offset moves with mdat', got.every((v, i) => v === offsets[i] + delta),
    `${offsets.join(',')} → ${got.join(',')}`);

  const u8 = new Uint8Array(tagged);
  check('the media is where the tables now say it is',
    CHUNKS.every((c, i) => sameBytes(u8.subarray(got[i], got[i] + c.length), c)));

  const cover = findCoverArt(tagged);
  check('the cover reads back byte for byte', !!cover && sameBytes(cover.bytes, IMAGE));
  check('the data type says JPEG', !!cover && cover.kind === JPEG, cover && `kind ${cover.kind}`);

  // The metadata lands at the end of `moov`, i.e. just before `mdat`.
  const before = boxTree(bytes).map((b) => b.type).join('/');
  const after = boxTree(tagged).map((b) => b.type).join('/');
  check('the box tree is the old one plus the metadata path',
    after === before.replace('/mdat', '/udta/meta/hdlr/ilst/covr/data/mdat'), after);
}

// ---- 2 · mdat before moov: nothing shifts ---------------------------------
{
  const { bytes, offsets } = buildMp4({ moovFirst: false });
  const tagged = addCoverArt(bytes, IMAGE, PNG);
  const got = readOffsets(tagged);
  check('offsets ahead of the insertion point are left alone', got.every((v, i) => v === offsets[i]),
    `${offsets.join(',')} → ${got.join(',')}`);
  const u8 = new Uint8Array(tagged);
  check('…and the media there is still intact',
    CHUNKS.every((c, i) => sameBytes(u8.subarray(got[i], got[i] + c.length), c)));
  check('the data type says PNG', findCoverArt(tagged).kind === PNG);
}

// ---- 3 · several tracks, 64-bit offsets -----------------------------------
{
  const { bytes, offsets } = buildMp4({ tracks: 2, wide: true });
  const tagged = addCoverArt(bytes, IMAGE);
  const delta = tagged.byteLength - bytes.length;
  const got = readOffsets(tagged);
  check('co64 tables are patched too, in every track',
    got.length === offsets.length * 2 && got.every((v, i) => v === offsets[i % offsets.length] + delta),
    `${got.join(',')}`);
}

// ---- 4 · the input is not modified ----------------------------------------
{
  const { bytes } = buildMp4();
  const copy = bytes.slice();
  addCoverArt(bytes, IMAGE);
  check('the source buffer is untouched', sameBytes(bytes, copy));
}

// ---- 5 · refusals ---------------------------------------------------------
{
  const { bytes } = buildMp4();
  const once = addCoverArt(bytes, IMAGE);
  let threw = '';
  try { addCoverArt(once, IMAGE); } catch (e) { threw = e.message; }
  check('tagging twice is refused rather than writing two covers', /already carries cover art/.test(threw), threw);

  threw = '';
  try { addCoverArt(new Uint8Array([...u32(8), ...ascii('ftyp')]), IMAGE); } catch (e) { threw = e.message; }
  check('a file with no moov is refused', /no moov/.test(threw), threw);

  check('a file with no cover reads back null', findCoverArt(bytes) === null);
}

console.log(failures ? `\n${failures} failure(s)` : '\nAll good.');
process.exit(failures ? 1 : 0);
