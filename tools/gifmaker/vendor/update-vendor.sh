#!/usr/bin/env bash
#
# Re-vendor gifski-wasm into this directory (the GIF Maker's only dependency).
# See README.md for the full rationale. Not a submodule / not an npm runtime dep —
# this copies the published files in so the tool stays a static, offline page.
#
# Usage:
#   ./update-vendor.sh            # re-vendor the pinned default version
#   ./update-vendor.sh 2.3.0      # bump to a specific version
#
# Requires: npm, tar. Network is used only while this runs.

set -euo pipefail

VERSION="${1:-2.2.0}"   # keep in sync with README.md + ../REQUIREMENTS.md
VENDOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Vendoring gifski-wasm@${VERSION} → ${VENDOR_DIR}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# Download the exact published tarball from the npm registry (read-only fetch),
# then unpack it (npm tarballs extract into ./package/).
( cd "$tmp" && npm pack "gifski-wasm@${VERSION}" >/dev/null )
tar -xzf "$tmp"/gifski-wasm-*.tgz -C "$tmp"
pkg="$tmp/package"

# Single-thread build only. The pkg-parallel/ + *-multi-thread.* files need
# SharedArrayBuffer (COOP/COEP), which GitHub Pages can't serve, so skip them.
# The dist/ → pkg/ layout is preserved so encode.js's
# `new URL('gifski_wasm_bg.wasm', import.meta.url)` resolves locally.
mkdir -p "$VENDOR_DIR/dist" "$VENDOR_DIR/pkg"
cp "$pkg/dist/encode.js"          "$VENDOR_DIR/dist/encode.js"
cp "$pkg/pkg/gifski_wasm.js"      "$VENDOR_DIR/pkg/gifski_wasm.js"
cp "$pkg/pkg/gifski_wasm_bg.wasm" "$VENDOR_DIR/pkg/gifski_wasm_bg.wasm"
cp "$pkg/LICENSE"                 "$VENDOR_DIR/LICENSE"

echo "Done. Vendored files:"
( cd "$VENDOR_DIR" && ls -l dist/encode.js pkg/gifski_wasm.js pkg/gifski_wasm_bg.wasm LICENSE )

cat <<NOTE

Next steps:
  1. Update the pinned version in README.md and ../REQUIREMENTS.md to ${VERSION}.
  2. Re-test the tool (load a video → Create GIF; or run window.__gifskiTest()).
  3. Commit the changed vendor/ files.
NOTE
