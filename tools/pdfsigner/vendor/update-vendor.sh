#!/usr/bin/env bash
#
# Re-vendor the PDF Signer's two dependencies into this directory:
#
#   pdfjs-dist  — renders each PDF page to a <canvas> so you can see what you
#                 are signing (Mozilla's PDF.js)
#   pdf-lib     — writes the stamps back into the PDF and re-serialises it
#
# Neither is an npm runtime dep / submodule: this copies the published files in
# so the tool stays a static, offline page (no CDN, no build step). Network is
# used only while this script runs.
#
# Usage:
#   ./update-vendor.sh                    # re-vendor the pinned default versions
#   ./update-vendor.sh 6.2.108 1.17.1     # pdfjs-dist + pdf-lib versions
#
# Requires: npm, tar.

set -euo pipefail

PDFJS_VERSION="${1:-6.2.108}"     # keep in sync with REQUIREMENTS.md
PDFLIB_VERSION="${2:-1.17.1}"     # keep in sync with REQUIREMENTS.md
VENDOR_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "Vendoring pdfjs-dist@${PDFJS_VERSION} + pdf-lib@${PDFLIB_VERSION} → ${VENDOR_DIR}"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

fetch() { ( cd "$tmp" && npm pack "$1" >/dev/null ); }

# --- PDF.js (ESM build + its module worker) ---
fetch "pdfjs-dist@${PDFJS_VERSION}"
mkdir -p "$tmp/pdfjs" && tar -xzf "$tmp"/pdfjs-dist-*.tgz -C "$tmp/pdfjs"
src="$tmp/pdfjs/package"

rm -rf "$VENDOR_DIR/pdfjs"
mkdir -p "$VENDOR_DIR/pdfjs"

# Renamed .mjs → .js so GitHub Pages serves them with a JavaScript MIME type
# (its .mjs handling is unreliable). Both are valid ES modules regardless.
cp "$src/build/pdf.min.mjs"        "$VENDOR_DIR/pdfjs/pdf.min.js"
cp "$src/build/pdf.worker.min.mjs" "$VENDOR_DIR/pdfjs/pdf.worker.min.js"
cp "$src/LICENSE"                  "$VENDOR_DIR/pdfjs/LICENSE"

# Side-car data PDF.js fetches lazily at render time. Without these, pages that
# rely on them render with missing glyphs or blank images:
#   standard_fonts/ — the 14 standard fonts, for PDFs that don't embed them
#   cmaps/          — predefined CJK character maps
#   iccs/           — the fallback CMYK ICC profile
#   wasm/           — JBIG2 / JPEG 2000 image decoders + the qcms colour engine,
#                     which scanned documents lean on heavily
cp -R "$src/standard_fonts" "$VENDOR_DIR/pdfjs/standard_fonts"
cp -R "$src/cmaps"          "$VENDOR_DIR/pdfjs/cmaps"
cp -R "$src/iccs"           "$VENDOR_DIR/pdfjs/iccs"

mkdir -p "$VENDOR_DIR/pdfjs/wasm"
# Only the wasm binaries and their licences — the *_nowasm_fallback.js shims
# (~600 KB) are for engines without WebAssembly, and quickjs-eval is only used
# for scripted AcroForms, which this tool disables.
for f in jbig2.wasm openjpeg.wasm qcms_bg.wasm LICENSE_JBIG2 LICENSE_OPENJPEG \
         LICENSE_QCMS LICENSE_PDFJS_JBIG2 LICENSE_PDFJS_OPENJPEG LICENSE_PDFJS_QCMS; do
  cp "$src/wasm/$f" "$VENDOR_DIR/pdfjs/wasm/$f"
done

# --- pdf-lib (ESM build; self-contained, no bare imports) ---
fetch "pdf-lib@${PDFLIB_VERSION}"
mkdir -p "$tmp/pdflib" && tar -xzf "$tmp"/pdf-lib-*.tgz -C "$tmp/pdflib"
mkdir -p "$VENDOR_DIR/pdf-lib"
cp "$tmp/pdflib/package/dist/pdf-lib.esm.min.js" "$VENDOR_DIR/pdf-lib/pdf-lib.esm.min.js"
cp "$tmp/pdflib/package/LICENSE.md"              "$VENDOR_DIR/pdf-lib/LICENSE.md"

echo "Done. Vendored:"
( cd "$VENDOR_DIR" && du -sh pdfjs pdf-lib )

cat <<NOTE

Next steps:
  1. Update the pinned versions in REQUIREMENTS.md to ${PDFJS_VERSION} / ${PDFLIB_VERSION}.
  2. Re-test the tool (open a PDF → place a signature → Save).
  3. Commit the changed vendor/ files.
NOTE
