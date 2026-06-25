# Vendored dependency: UPNG.js + pako (APNG encoder)

A **checked-in copy** of [UPNG.js](https://github.com/photopea/UPNG.js) (Photopea)
and its deflate dependency [pako](https://github.com/nodeca/pako). UPNG encodes the
video frames straight to an **animated PNG**; the GIF Maker then patches its
timing/loop in place (see `../formats.js`). Not an npm/CDN runtime dependency — the
files are copied in so the tool stays a static, offline page.

## Pinned versions

- **upng-js @ 2.1.0** (MIT)
- **pako @ 1.0.11** (MIT) — UPNG's zlib (deflate/inflate)

## Files (and why)

| File | Role |
|------|------|
| `UPNG.js` | `UPNG.encode([rgbaBuffers], w, h, cnum, [delaysMs])` → APNG `ArrayBuffer`. |
| `pako.min.js` | zlib codec UPNG looks up as `window.pako`. |
| `LICENSE.UPNG` | MIT (UPNG.js). |
| `LICENSE.pako` | MIT (pako). |

## Loading (globals, not modules)

UPNG.js and pako are classic scripts that attach to `window`. `index.html` loads
`pako.min.js` **then** `UPNG.js` **before** the `gifmaker.js` module (classic
scripts run before deferred modules), so `window.UPNG` / `window.pako` exist when
`formats.js` calls them. Order matters: pako must load first.

`cnum` is UPNG's lossy colour count (`0` = lossless); the tool maps its three
size tiers to `0 / 256 / 64`.

## Updating

```sh
npm pack upng-js@2.1.0      # → package/UPNG.js, package/LICENSE
npm pack pako@1.0.11        # → package/dist/pako.min.js, package/LICENSE
```
Copy `UPNG.js` + its `LICENSE` (→ `LICENSE.UPNG`) and `dist/pako.min.js` + pako's
`LICENSE` (→ `LICENSE.pako`). Re-test with `window.__apngTest()` in the page
console (expects `{ ok: true }`).
