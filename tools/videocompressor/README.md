# Video Compressor

A static, offline, in-browser video compressor. It shrinks a video to a target
file size or a chosen bitrate using the browser's **WebCodecs** API — which
routes to the machine's *hardware* video encoder (Apple VideoToolbox, NVIDIA
NVENC, Intel QSV, VAAPI, …). Nothing is uploaded; every step runs locally.

This is distinct from the [GIF Maker](../gifmaker/): that tool produces animated
GIF/WebP/APNG; this one produces a compressed **MP4** (H.264 or H.265).

## Pipeline

```
MP4Box.js  ──►  VideoDecoder  ──►  <canvas> scale  ──►  VideoEncoder  ──►  mp4-muxer  ──►  MP4 Blob
 (demux)         (hardware)         (resize/fps)         (hardware)          (mux)
```

- **Demux** — [MP4Box.js](https://github.com/gpac/mp4box.js) reads the MP4/MOV,
  yields the encoded video samples plus the codec configuration record
  (`avcC`/`hvcC`) the decoder needs.
- **Preview, trim & cut** — the source plays in a `<video>` element (streamed
  from a Blob URL, so multi-GB files preview instantly). Drag the timeline
  handles to keep only part of the clip, and mark interior **cut** sections to
  drop (mark start → mark end); removed sections are skipped during encode and
  the output timestamps compact to stitch the clip back together (audio too). A
  shorter kept duration encodes to a smaller file.
- **Stepped workflow** — one panel at a time (Source → Trim & cut → Settings →
  Export). The single `<video>` preview is *relocated* into the active step: it's
  editable in Trim, and in Settings/Export it plays the **final** clip (loops the
  selection, skips cuts) so you preview exactly what will be exported.
- **Live encode view** — during export, each frame is drawn to a canvas as it's
  encoded, so you watch the output play out while it's written.
- **Decode → scale → encode** — WebCodecs `VideoDecoder`/`VideoEncoder`.
  Resolution change happens on an `OffscreenCanvas`; frame-rate reduction drops
  frames by presentation timestamp.
- **Mux** — [mp4-muxer](https://github.com/Vanilagy/mp4-muxer) writes the
  encoded chunks back into an MP4 with `fastStart` (moov at the front).
- **Audio** — AAC audio is **copied through unchanged** via
  `addAudioChunkRaw` (remuxed, never re-encoded). Non-AAC audio is dropped, and
  the UI says so.

## Large files (multi-GB)

A single `ArrayBuffer` in Chrome is capped near 2 GB, so the whole file is never
read at once. Instead:

1. **Metadata** is parsed from `moov` alone. A quick top-level atom walk (only
   16-byte box headers are read) locates every box; each is fed to MP4Box in
   full *except* `mdat`, which contributes only its 8-byte header. MP4Box then
   learns the `mdat` size, skips its payload, and reaches `moov` — even when it
   sits at the very end of the file (common for camera/screen recordings). For a
   2.6 GB `.mov` this phase reads only a few hundred KB.
2. **Encoded samples** are streamed out of `mdat` in 8 MB chunks during
   compression, feeding the decoder with backpressure and calling
   `releaseUsedSamples` after each batch, so memory stays bounded.

Trimming makes this cheaper: encoding stops as soon as the selection's end is
reached, so trims near the start of a long video finish quickly.

## Files

| Path | What it is |
|------|------------|
| `index.html` | The page. No Jekyll front matter, so the JS is served verbatim. Loads MP4Box as a global `<script>`, then the module. |
| `compressor.js` | ES module: streaming demux, preview/trim, transcode, mux, and all UI wiring. |
| `vendor/mp4box/` | Vendored MP4Box.js UMD bundle + license. |
| `vendor/mp4-muxer/` | Vendored mp4-muxer ESM bundle (`.mjs` renamed to `.js` so GitHub Pages serves it with a JS MIME type) + license. |
| `vendor/update-vendor.sh` | Re-vendors both deps from npm (see below). |

## Vendoring

Dependencies are **vendored**, not fetched at runtime, so the tool works
offline and never depends on a CDN. Pinned versions:

- `mp4box` **0.5.2**
- `mp4-muxer` **5.1.5**

To update:

```bash
cd tools/videocompressor/vendor
./update-vendor.sh                 # pinned versions
./update-vendor.sh 0.5.2 5.1.5     # or specify mp4box + mp4-muxer versions
```

Then bump the versions above, re-test, and commit the changed `vendor/` files.

## Browser support

WebCodecs is required. As of writing that means a recent **Chrome/Edge** or
**Safari**; Firefox support is still landing. HEVC *encoding* in particular
depends on the OS/GPU — the tool probes `VideoEncoder.isConfigSupported()` and
falls back or reports a clear error if a codec isn't available. If WebCodecs is
missing entirely, the page shows a compatibility notice instead of the tool.

## Notes / limitations

- Input must be an MP4/MOV/M4V the browser can decode (H.264 or H.265). Formats
  like ProRes or VP9-in-WebM aren't handled by this MP4-focused demux path.
- Trim decodes from the start of the file up to the selection's end (it can't
  skip into the middle of a GOP), so a trim near the *end* of a long video still
  streams most of the file. A trim near the start is fast.
- Target-size mode computes a constant video bitrate from the (trimmed)
  duration (single-pass), so the final size is an estimate — very close, not
  exact. Use the result's size readout and nudge the target for a hard cap.
