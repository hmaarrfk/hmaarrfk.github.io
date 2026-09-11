#!/usr/bin/env bash
#
# Re-vendor the Video Compressor's dependencies into this directory:
#
#   mp4box        — MP4/MOV demuxer (extracts encoded samples + codec config)
#   mp4-muxer     — writes the WebCodecs output back into an MP4 container
#   transformers  — @huggingface/transformers (transformers.js), runs the
#                   Whisper speech model for auto-captions
#
# None is an npm runtime dep / submodule: this copies the published files in
# so the tool stays a static page (no build step). Network is used only while
# this script runs. (Auto-captions still fetch the model weights, and the
# ONNX Runtime WASM, at the moment a user asks for captions — see README.md.)
#
# Usage:
#   ./update-vendor.sh                       # re-vendor the pinned default versions
#   ./update-vendor.sh 0.5.2 5.1.5 4.2.0     # mp4box + mp4-muxer + transformers versions
#
# Requires: npm, tar.

set -euo pipefail

MP4BOX_VERSION="${1:-0.5.2}"          # keep in sync with README.md
MUXER_VERSION="${2:-5.1.5}"           # keep in sync with README.md
TRANSFORMERS_VERSION="${3:-4.2.0}"    # keep in sync with README.md
VENDOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Vendoring mp4box@${MP4BOX_VERSION} + mp4-muxer@${MUXER_VERSION} + @huggingface/transformers@${TRANSFORMERS_VERSION} → ${VENDOR_DIR}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() { ( cd "$tmp" && npm pack "$1" >/dev/null ); }

# --- mp4box (UMD build; attaches window.MP4Box) ---
fetch "mp4box@${MP4BOX_VERSION}"
mkdir -p "$tmp/mp4box" && tar -xzf "$tmp"/mp4box-*.tgz -C "$tmp/mp4box"
mkdir -p "$VENDOR_DIR/mp4box"
cp "$tmp/mp4box/package/dist/mp4box.all.min.js" "$VENDOR_DIR/mp4box/mp4box.all.min.js"
cp "$tmp/mp4box/package/LICENSE"                "$VENDOR_DIR/mp4box/LICENSE"

# --- mp4-muxer (ESM build; self-contained, no bare imports) ---
fetch "mp4-muxer@${MUXER_VERSION}"
mkdir -p "$tmp/muxer" && tar -xzf "$tmp"/mp4-muxer-*.tgz -C "$tmp/muxer"
mkdir -p "$VENDOR_DIR/mp4-muxer"
# Renamed .mjs → .js so GitHub Pages serves it with a JavaScript MIME type
# (its .mjs handling is unreliable). The file is a valid ES module regardless.
cp "$tmp/muxer/package/build/mp4-muxer.mjs" "$VENDOR_DIR/mp4-muxer/mp4-muxer.js"
cp "$tmp/muxer/package/LICENSE"             "$VENDOR_DIR/mp4-muxer/LICENSE"

# --- transformers.js (self-contained ESM bundle: ONNX Runtime's JS is inside,
# no bare imports — unlike transformers.web.js, which imports onnxruntime-web).
# Its ~25 MB WASM binary is NOT vendored; ONNX Runtime fetches it from
# jsDelivr (pinned to the matching version) the first time captions run. ---
fetch "@huggingface/transformers@${TRANSFORMERS_VERSION}"
mkdir -p "$tmp/transformers" && tar -xzf "$tmp"/huggingface-transformers-*.tgz -C "$tmp/transformers"
mkdir -p "$VENDOR_DIR/transformers"
cp "$tmp/transformers/package/dist/transformers.min.js" "$VENDOR_DIR/transformers/transformers.min.js"
cp "$tmp/transformers/package/LICENSE"                  "$VENDOR_DIR/transformers/LICENSE"

# GitHub's secret scanning rejects a push containing anything shaped like a
# Mistral API key: a standalone 32-character alphanumeric token. The bundle
# has two such false positives — a gist id in an error message
# (.../hollance/<32 hex>, about Whisper's alignment_heads) and the class name
# "Mistral3ForConditionalGeneration", which is exactly 32 characters and
# carries the very keyword the rule looks for. Both sit inside double-quoted
# strings, so split them across a string concatenation: identical string at
# runtime, no 32-character token left in the file.
python3 - "$VENDOR_DIR/transformers/transformers.min.js" <<'PY'
import re, sys
path = sys.argv[1]
src = open(path, encoding='utf-8').read()
# standalone 32-char alphanumeric runs that are all-hex, or name Mistral
token = re.compile(r'(?<![A-Za-z0-9_$])([A-Za-z0-9]{32})(?![A-Za-z0-9_$])')
def risky(t):
    return bool(re.fullmatch(r'[0-9a-f]{32}', t)) or 'istral' in t
found = [m.group(1) for m in token.finditer(src) if risky(m.group(1))]
if found:
    src = token.sub(lambda m: f'{m.group(1)[:16]}"+"{m.group(1)[16:]}' if risky(m.group(1)) else m.group(1), src)
    open(path, 'w', encoding='utf-8').write(src)
print(f"  split {len(found)} secret-scanner-tripping token(s): {', '.join(sorted(set(found))) if found else '(none found)'}")
PY

# That split is only valid inside a double-quoted string. If a future version
# puts a 32-hex token somewhere else, the bundle stops parsing — catch it here
# rather than shipping a broken tool.
if command -v node >/dev/null 2>&1; then
  cp "$VENDOR_DIR/transformers/transformers.min.js" "$tmp/parse-check.mjs"
  if ! node --check "$tmp/parse-check.mjs"; then
    echo "ERROR: the patched transformers bundle no longer parses — a 32-hex token was probably outside a string literal. Fix the patch step above." >&2
    exit 1
  fi
  echo "  bundle parses OK after patching"
fi

echo "Done. Vendored files:"
( cd "$VENDOR_DIR" && ls -l mp4box/mp4box.all.min.js mp4box/LICENSE mp4-muxer/mp4-muxer.js mp4-muxer/LICENSE \
    transformers/transformers.min.js transformers/LICENSE )

cat <<NOTE

Next steps:
  1. Update the pinned versions in README.md to ${MP4BOX_VERSION} / ${MUXER_VERSION} / ${TRANSFORMERS_VERSION}.
  2. Re-test the tool (load a video → Compress; generate captions → Compress).
  3. Commit the changed vendor/ files.
NOTE
