// SentencePiece, the small part of it this needs.
//
// The voice model's text side is a 4000-piece SentencePiece *unigram* model
// with byte fallback, shipped as `tokenizer.model` — a protobuf. Rather than
// vendor a converted copy of it per language (six languages, ~80 KB each, and
// another file to keep in step with the weights), this reads the protobuf the
// model repo already serves, and segments text with the same Viterbi the
// reference implementation uses.
//
// Two pieces, both pure and both testable under Node:
//
//   parseSentencePieceModel(bytes) -> { pieces: [{ piece, score, type }] }
//   createTokenizer(model)         -> { encode(text), decode(ids) }
//
// Correctness here is not a matter of taste: a tokenisation that differs from
// the reference by one piece produces different speech. voice-tokenizer.test.mjs
// checks this against a corpus tokenised by the real Python sentencepiece.

const UNK = 2, CONTROL = 3, BYTE = 6;     // piece types that aren't ordinary text
const SPACE = '▁';                   // the '▁' SentencePiece writes for a space

// ---------------------------------------------------------------------------
// Just enough protobuf
// ---------------------------------------------------------------------------
// ModelProto { repeated SentencePiece pieces = 1; ... }
// SentencePiece { optional string piece = 1; optional float score = 2;
//                 optional Type type = 3; }
//
// Only field 1 of the outer message is read; everything else (trainer and
// normaliser specs) is skipped by wire type. The normaliser is checked by the
// caller against what this assumes: identity normalisation, a dummy prefix,
// and escaped whitespace.

export function parseSentencePieceModel(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const dec = new TextDecoder('utf-8');
  const pieces = [];

  let p = 0;
  const varint = () => {
    let out = 0, shift = 0;
    for (;;) {
      const b = buf[p++];
      out += (b & 0x7f) * Math.pow(2, shift);
      if (!(b & 0x80)) return out;
      shift += 7;
      if (shift > 63) throw new Error('varint too long');
    }
  };
  // Walk a length-delimited SentencePiece message.
  const readPiece = (end) => {
    let piece = '', score = 0, type = 1;
    while (p < end) {
      const tag = varint(), field = tag >>> 3, wire = tag & 7;
      if (field === 1 && wire === 2) {
        const len = varint();
        piece = dec.decode(buf.subarray(p, p + len));
        p += len;
      } else if (field === 2 && wire === 5) {
        score = view.getFloat32(p, true); p += 4;
      } else if (field === 3 && wire === 0) {
        type = varint();
      } else {
        skip(wire);
      }
    }
    return { piece, score, type };
  };
  const skip = (wire) => {
    if (wire === 0) varint();
    else if (wire === 1) p += 8;
    // Read the length into a local first: `p += varint()` would evaluate p
    // before varint() advanced it, and silently re-read the length bytes.
    else if (wire === 2) { const len = varint(); p += len; }
    else if (wire === 5) p += 4;
    else throw new Error(`unsupported wire type ${wire}`);
  };

  while (p < buf.length) {
    const tag = varint(), field = tag >>> 3, wire = tag & 7;
    if (field === 1 && wire === 2) {
      const len = varint();
      pieces.push(readPiece(p + len));
    } else {
      skip(wire);
    }
  }
  if (!pieces.length) throw new Error('no pieces in tokenizer model');
  return { pieces };
}

// ---------------------------------------------------------------------------
// Unigram segmentation
// ---------------------------------------------------------------------------
// The score of a segmentation is the sum of its pieces' log probabilities, so
// the best one is a shortest-path problem over the string — Viterbi, left to
// right, keeping the best way to reach each character boundary.
//
// Anything the vocabulary cannot spell falls back to bytes: `byte_fallback`
// puts <0x00>..<0xFF> in the vocabulary precisely so that no input is ever
// unrepresentable. A character taken as a fallback is charged `unkPenalty`,
// well below any real piece, so the search only does it when it must.

export function createTokenizer(model) {
  const pieces = model.pieces;
  const vocab = new Map();          // piece text -> id (ordinary pieces only)
  const byteId = new Array(256).fill(-1);
  let minScore = Infinity, maxLen = 1;

  for (let id = 0; id < pieces.length; id++) {
    const { piece, score, type } = pieces[id];
    if (type === BYTE) {
      // '<0x1F>' -> 31
      const m = /^<0x([0-9A-Fa-f]{2})>$/.exec(piece);
      if (m) byteId[parseInt(m[1], 16)] = id;
      continue;
    }
    if (type === CONTROL || type === UNK) continue;   // never matched in text
    if (!vocab.has(piece)) vocab.set(piece, id);
    if (score < minScore) minScore = score;
    if (piece.length > maxLen) maxLen = piece.length;
  }
  const unkPenalty = minScore - 10;
  const encoder = new TextEncoder();

  /** Text -> token ids, matching SentencePiece's Encode(). */
  function encode(text) {
    // add_dummy_prefix, then escape_whitespaces. Normalisation is identity for
    // this model, so there is deliberately nothing else here — adding NFKC
    // would silently change the tokens.
    const s = (' ' + String(text)).split(' ').join(SPACE);
    const chars = Array.from(s);                 // code points, not UTF-16 units
    const n = chars.length;
    if (!n) return [];

    // best[i] = { score, from, id } for the boundary *before* character i.
    const best = new Array(n + 1).fill(null);
    best[0] = { score: 0, from: -1, id: -1, len: 0 };

    for (let i = 0; i < n; i++) {
      if (!best[i]) continue;
      // Try every piece that could start here, longest first is unnecessary —
      // all lengths are considered and the best wins.
      let sub = '';
      for (let k = 0; k < maxLen && i + k < n; k++) {
        sub += chars[i + k];
        const id = vocab.get(sub);
        if (id === undefined) continue;
        const score = best[i].score + pieces[id].score;
        const j = i + k + 1;
        if (!best[j] || score > best[j].score) best[j] = { score, from: i, id, len: k + 1 };
      }
      // Fallback: take this one character, whatever it is.
      const j = i + 1;
      const score = best[i].score + unkPenalty;
      if (!best[j] || score > best[j].score) best[j] = { score, from: i, id: -1, len: 1 };
    }

    // Walk the chain back, then emit forwards.
    const chain = [];
    for (let i = n; i > 0;) {
      const node = best[i];
      chain.push(node);
      i = node.from;
    }
    chain.reverse();

    const ids = [];
    let at = 0;
    for (const node of chain) {
      if (node.id >= 0) {
        ids.push(node.id);
      } else {
        // Unrepresentable: spell the character out in UTF-8 bytes.
        for (const b of encoder.encode(chars[at])) {
          if (byteId[b] >= 0) ids.push(byteId[b]);
        }
      }
      at += node.len;
    }
    return ids;
  }

  /** Token ids -> text, undoing the dummy prefix and the '▁'. */
  function decode(ids) {
    const bytes = [];
    let out = '';
    const flush = () => {
      if (!bytes.length) return;
      out += new TextDecoder('utf-8').decode(new Uint8Array(bytes));
      bytes.length = 0;
    };
    for (const id of ids) {
      const p = pieces[id];
      if (!p) continue;
      if (p.type === BYTE) {
        const m = /^<0x([0-9A-Fa-f]{2})>$/.exec(p.piece);
        if (m) bytes.push(parseInt(m[1], 16));
        continue;
      }
      flush();
      if (p.type === CONTROL || p.type === UNK) continue;
      out += p.piece;
    }
    flush();
    return out.split(SPACE).join(' ').replace(/^ /, '');
  }

  return { encode, decode, size: pieces.length, pieces };
}
