#!/usr/bin/env bash
#
# Re-vendor the Video Compressor's two dependencies into this directory:
#
#   mp4box     — MP4/MOV demuxer (extracts encoded samples + codec config)
#   mp4-muxer  — writes the WebCodecs output back into an MP4 container
#
# Neither is an npm runtime dep / submodule: this copies the published files in
# so the tool stays a static, offline page (no CDN, no build step). Network is
# used only while this script runs.
#
# Usage:
#   ./update-vendor.sh                 # re-vendor the pinned default versions
#   ./update-vendor.sh 0.5.2 5.1.5     # mp4box + mp4-muxer versions
#
# Requires: npm, tar.

set -euo pipefail

MP4BOX_VERSION="${1:-0.5.2}"      # keep in sync with README.md
MUXER_VERSION="${2:-5.1.5}"       # keep in sync with README.md
VENDOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Vendoring mp4box@${MP4BOX_VERSION} + mp4-muxer@${MUXER_VERSION} → ${VENDOR_DIR}"

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

echo "Done. Vendored files:"
( cd "$VENDOR_DIR" && ls -l mp4box/mp4box.all.min.js mp4box/LICENSE mp4-muxer/mp4-muxer.js mp4-muxer/LICENSE )

cat <<NOTE

Next steps:
  1. Update the pinned versions in README.md to ${MP4BOX_VERSION} / ${MUXER_VERSION}.
  2. Re-test the tool (load a video → Compress).
  3. Commit the changed vendor/ files.
NOTE
