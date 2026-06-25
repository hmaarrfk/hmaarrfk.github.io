# Vendored dependency: @jsquash/webp (libwebp WASM)

A **checked-in copy** of [@jsquash/webp](https://github.com/jamsinclair/jSquash)
— Google's [libwebp](https://chromium.googlesource.com/webm/libwebp/) encoder
compiled to WebAssembly. Used to encode each video frame to a lossy WebP; the GIF
Maker then muxes the frames into one **animated WebP** (see `../formats.js`). Like
the gifski vendor dir, this is **not** an npm/CDN runtime dependency — the files
are copied in so the tool stays a static, offline page.

## Pinned versions

- **@jsquash/webp @ 1.5.0** (Apache-2.0)
- **wasm-feature-detect @ 1.8.0** (Apache-2.0) — for the SIMD check

## Files (and why)

| File | Role |
|------|------|
| `encode.js`, `meta.js`, `utils.js`, `index.js` | @jsquash high-level `encode(imageData, {quality})` wrapper (ES modules). |
| `codec/enc/webp_enc.js` + `webp_enc.wasm` | libwebp encoder (baseline build). |
| `codec/enc/webp_enc_simd.js` + `webp_enc_simd.wasm` | SIMD build (used when supported; faster). |
| `wasm-feature-detect.js` | The `simd()` detector `encode.js` imports. |
| `LICENSE` | Apache-2.0 (libwebp / @jsquash). |
| `LICENSE.wasm-feature-detect` | Apache-2.0. |

The `codec/enc/` layout must be preserved: the emscripten glue resolves its
`.wasm` relative to its own URL (`import.meta.url`).

## Import map (no bundler)

`encode.js` imports `wasm-feature-detect` by bare specifier. This static page has
no bundler, so `index.html` declares an **import map** resolving that specifier to
the vendored `wasm-feature-detect.js`. Keep that map in sync if the path changes.

## Updating

```sh
npm pack @jsquash/webp@1.5.0
npm pack wasm-feature-detect@1.8.0
```
Then copy `encode.js meta.js utils.js index.js`, `codec/enc/webp_enc*.{js,wasm}`,
and `LICENSE` from the @jsquash tarball, and `dist/esm/index.js` →
`wasm-feature-detect.js` (+ its `LICENSE`) from the feature-detect tarball.
Re-test with `await window.__webpTest()` in the page console (expects
`{ ok: true, magic: 'RIFFWEBP' }`).
