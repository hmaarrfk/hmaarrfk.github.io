// node voice-tokenizer.test.mjs — the SentencePiece reader and segmenter,
// against a tiny model built here rather than the real 4000-piece one, so the
// test needs no downloaded weights.
//
// The real model is checked separately and by hand (see REQUIREMENTS.md):
// tokenise a corpus with Python's `sentencepiece` and compare ids one for one.
// This file is for the things that are easy to get quietly wrong — protobuf
// field skipping, which segmentation Viterbi picks, and byte fallback.
import assert from 'node:assert/strict';
import { parseSentencePieceModel, createTokenizer } from './voice-tokenizer.js';

let passed = 0;
const test = (name, fn) => {
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { console.error(`FAIL  ${name}\n      ${e.message}`); process.exitCode = 1; }
};

// ---------------------------------------------------------------------------
// A minimal protobuf writer, so the test can build models to read back.
// ---------------------------------------------------------------------------
const varint = (n) => {
  const out = [];
  do { let b = n & 0x7f; n = Math.floor(n / 128); if (n) b |= 0x80; out.push(b); } while (n);
  return out;
};
const f32 = (v) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setFloat32(0, v, true);
  return [...b];
};
const str = (s) => [...new TextEncoder().encode(s)];
// SentencePiece { piece = 1 (string), score = 2 (float), type = 3 (enum) }
const piece = (text, score, type) => {
  const body = [
    0x0a, ...varint(str(text).length), ...str(text),
    0x15, ...f32(score),
    ...(type != null ? [0x18, ...varint(type)] : []),
  ];
  return [0x0a, ...varint(body.length), ...body];   // ModelProto.pieces = 1
};
const model = (pieces, trailer = []) => new Uint8Array([...pieces.flat(), ...trailer]);

// A vocabulary that can spell "▁ab" three ways, with a clear winner, plus the
// byte pieces every real model carries.
const SPACE = '▁';
const basic = () => {
  const ps = [
    piece('<unk>', 0, 2), piece('<s>', 0, 3), piece('</s>', 0, 3), piece('<pad>', 0, 3),
  ];
  for (let b = 0; b < 256; b++) ps.push(piece(`<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`, 0, 6));
  // ids 260+
  ps.push(piece(`${SPACE}ab`, -1.0, 1));    // 260: one piece, best
  ps.push(piece(`${SPACE}a`, -2.0, 1));     // 261
  ps.push(piece('b', -2.5, 1));             // 262  (a+b = -4.5, worse)
  ps.push(piece(SPACE, -5.0, 1));           // 263
  ps.push(piece('a', -3.0, 1));             // 264
  ps.push(piece(`${SPACE}c`, -1.5, 1));     // 265
  return parseSentencePieceModel(model(ps));
};

// ---------------------------------------------------------------------------
console.log('\nreading the protobuf');

test('pieces, scores and types come back', () => {
  const m = basic();
  assert.equal(m.pieces.length, 4 + 256 + 6);
  assert.equal(m.pieces[0].piece, '<unk>');
  assert.equal(m.pieces[0].type, 2);
  assert.equal(m.pieces[4].piece, '<0x00>');
  assert.equal(m.pieces[260].piece, `${SPACE}ab`);
  assert.ok(Math.abs(m.pieces[260].score + 1.0) < 1e-6);
});

test('a piece with no explicit type defaults to NORMAL', () => {
  const m = parseSentencePieceModel(model([piece('x', -1, null)]));
  assert.equal(m.pieces[0].type, 1);
});

test('trailing messages are skipped by length, not re-read', () => {
  // This is the bug that cost an afternoon: `p += varint()` evaluates p before
  // varint() moves it, so the length prefix's own bytes get read twice and the
  // parser desyncs into the middle of a field. A trailer long enough to need a
  // two-byte length is what exposes it.
  const trailerBody = new Array(300).fill(0x41);
  const trailer = [0x12, ...varint(trailerBody.length), ...trailerBody];   // field 2, wire 2
  const m = parseSentencePieceModel(model([piece('x', -1, 1), piece('y', -2, 1)], trailer));
  assert.equal(m.pieces.length, 2, 'both pieces survived the trailer');
  assert.equal(m.pieces[1].piece, 'y');
});

test('an empty model is refused rather than returning nothing', () => {
  assert.throws(() => parseSentencePieceModel(new Uint8Array(0)), /no pieces/);
});

// ---------------------------------------------------------------------------
console.log('\nsegmenting');

test('a space is added in front and written as U+2581', () => {
  const tok = createTokenizer(basic());
  assert.deepEqual(tok.encode('ab'), [260], 'should be the single "▁ab" piece');
});

test('the highest-scoring split wins, not the longest or the greediest', () => {
  const tok = createTokenizer(basic());
  // "▁ab" = -1.0 beats "▁a"+"b" = -4.5 beats "▁"+"a"+"b" = -10.5
  assert.deepEqual(tok.encode('ab'), [260]);
});

test('a split is taken when no single piece covers the text', () => {
  const tok = createTokenizer(basic());
  // "▁ac": no "▁ac" piece, so "▁a" + ... and 'c' alone is not a piece -> bytes
  const ids = tok.encode('ac');
  assert.equal(ids[0], 261, 'starts with "▁a"');
  assert.ok(ids.length > 1);
});

test('control and unknown pieces are never emitted from text', () => {
  const tok = createTokenizer(basic());
  for (const text of ['ab', 'abc', 'a b c', '<unk>', '<s>']) {
    for (const id of tok.encode(text)) {
      const t = tok.pieces[id].type;
      assert.ok(t !== 2 && t !== 3, `piece ${id} (${tok.pieces[id].piece}) should not appear`);
    }
  }
});

test('anything unspellable falls back to its UTF-8 bytes', () => {
  const tok = createTokenizer(basic());
  const ids = tok.encode('é');            // 'é' = C3 A9, no piece for it
  // byte pieces start at id 4, so <0xC3> is 4 + 0xC3 and <0xA9> is 4 + 0xA9
  assert.ok(ids.includes(4 + 0xc3), 'first UTF-8 byte');
  assert.ok(ids.includes(4 + 0xa9), 'second UTF-8 byte');
});

test('a four-byte character falls back to all four bytes', () => {
  const tok = createTokenizer(basic());
  const ids = tok.encode('\u{1F600}');         // an emoji: F0 9F 98 80
  for (const b of [0xf0, 0x9f, 0x98, 0x80]) {
    assert.ok(ids.includes(4 + b), `byte 0x${b.toString(16)} missing`);
  }
});

test('empty text produces no tokens beyond the prefix', () => {
  const tok = createTokenizer(basic());
  assert.deepEqual(tok.encode(''), [263], 'just the space piece');
});

// ---------------------------------------------------------------------------
console.log('\ndecoding');

test('decode undoes the space marker and the dummy prefix', () => {
  const tok = createTokenizer(basic());
  assert.equal(tok.decode([260]), 'ab');
});

test('decode reassembles byte pieces into characters', () => {
  const tok = createTokenizer(basic());
  assert.equal(tok.decode([4 + 0xc3, 4 + 0xa9]), 'é');
});

test('encode then decode round-trips', () => {
  const tok = createTokenizer(basic());
  for (const text of ['ab', 'a', 'ab ab', 'é']) {
    assert.equal(tok.decode(tok.encode(text)), text, `round trip of ${JSON.stringify(text)}`);
  }
});

console.log(`\n${passed} passed${process.exitCode ? ' (with failures)' : ''}\n`);
