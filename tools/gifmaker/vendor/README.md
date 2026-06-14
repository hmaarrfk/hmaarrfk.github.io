# Vendored dependency: gifski-wasm

This directory is a **checked-in copy** of [gifski-wasm](https://github.com/jamsinclair/gifski-wasm)
— the WebAssembly build of [gifski](https://github.com/ImageOptim/gifski). It is
vendored directly into the repo: **not** a git submodule, and **not** installed
via npm at build or runtime. That keeps the GIF Maker a plain static page that
works offline with no build step and survives CDN outages.

## Pinned version

**gifski-wasm@2.2.0** — single-thread build.

## Files (and why)

| File | Role |
|------|------|
| `dist/encode.js` | High-level `encode()` wrapper (ES module), imported by `../gifmaker.js`. |
| `pkg/gifski_wasm.js` | wasm-bindgen JS glue; loads the `.wasm` via `new URL('gifski_wasm_bg.wasm', import.meta.url)`. |
| `pkg/gifski_wasm_bg.wasm` | gifski compiled to WebAssembly (~293 KB). |
| `LICENSE` | AGPL-3.0 license text (see below). |

The **`dist/` → `pkg/` relative layout must be preserved** so the wasm path
resolves locally.

Only the **single-thread** build is vendored. Upstream also ships a multi-thread
build (`dist/encode-multi-thread.js`, `pkg-parallel/`) that needs
`SharedArrayBuffer`, which requires COOP/COEP response headers — and GitHub Pages
cannot set those — so it is intentionally **excluded**.

## License (AGPL-3.0)

gifski and gifski-wasm are licensed under the GNU Affero General Public License
v3.0. Because this page distributes the gifski WebAssembly binary to visitors over
a network, the AGPL requires the corresponding source remain available. The
bundled `LICENSE` here, plus the upstream repository links in the tool's About
panel, satisfy that.

## Updating

Run the helper from **this** directory:

```sh
./update-vendor.sh            # re-vendor the pinned version (2.2.0)
./update-vendor.sh 2.3.0      # bump to a different version
```

It uses `npm pack` to download the exact published tarball, copies the four files
above (single-thread only — the multi-thread build is left out), and cleans up.
Afterwards:

1. Update the **Pinned version** above and the matching note in `../REQUIREMENTS.md`.
2. Re-test the tool (load a video → Create GIF). Quick smoke test: run
   `await window.__gifskiTest()` in the page console — it should return a valid
   `GIF89a`.
3. Commit the changed `vendor/` files.

Requires `npm` and `tar`. Network is only needed when the script is run — never at
build or runtime of the site itself.
