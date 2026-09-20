// The timeline's two navigation rows — the filmstrip and the zoom window —
// and the frame grabber that feeds them.
//
// The editing row (`#tl-track`, in compressor.js) has to carry the trim
// handles, the cut bands and the speed bands, and those overlays sit on top
// of exactly the pixels you want to press to move the playhead. So navigation
// gets its own rows above it:
//
//   1 · #tl-film  — the whole clip as a strip of stills. Where am I?
//   2 · #tl-zoom  — a window of a few seconds, with a ruler and, when the
//                   frames are far enough apart, a tick per frame. Precise
//                   scrubbing, which is what marking a cut actually needs.
//   3 · #tl-track — the clip region: trim, cuts, speed-ups. Unchanged.
//
// Neither navigation row is ever covered by an edit: cuts and speed-ups show
// on them only as a thin, non-interactive strip along the bottom.
//
// Frames come from a *second*, hidden `<video>` on the same Blob URL, so
// seeking around to build a strip never disturbs the preview you're watching.
// Seeks are serialized through one queue (a video element can only service
// one at a time) and the results cached by timestamp, so repainting on a
// resize or a step change costs nothing.
//
// That queue is a *priority* queue, and the reason is that an MP4 is not
// random access: reaching a given time means decoding forward from the
// keyframe before it. Row 2's stills are a couple of seconds apart, so they
// mostly share one GOP and come back almost as fast as the decoder can hand
// them over; row 1's are scattered over the whole file, so every one of them
// is a fresh seek — on a long 4K recording, by far the most expensive thing
// this module does. Filling the overview first would therefore make you wait
// on frames you are not looking at. So the fine row is fetched first and
// always jumps the queue: when the zoom window moves, its new stills preempt
// whatever is left of the overview, which resumes afterwards.

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// Cached stills are this tall; they're drawn scaled into whatever cell the
// row happens to have. Memory is ~40 KB each at 96p, so a few hundred is fine.
const THUMB_H = 96;
const CACHE_MAX = 360;

// Ruler steps, in seconds. The smallest one that leaves at most ~10 labels.
const TICKS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

export function createFilmstrip(ctx) {
  const { els, getState, domain, scrub, activeEdits, isPlaying } = ctx;

  // ---- the hidden decode source ------------------------------------------
  let vid = null, vidURL = null;
  function ensureVideo() {
    const st = getState();
    if (!st) return null;
    if (!vid) {
      vid = document.createElement('video');
      vid.className = 'decode-src';
      vid.muted = true;
      vid.playsInline = true;
      vid.preload = 'auto';
      document.body.appendChild(vid);
    }
    if (vidURL !== st.previewURL) { vidURL = st.previewURL; vid.src = vidURL; vid.load(); }
    return vid;
  }

  // Draw whatever frame the video is showing, at `h` pixels tall — or null if
  // there isn't one yet.
  //
  // `videoWidth` alone is not enough to ask: it is set at `HAVE_METADATA`,
  // before a single frame has been decoded, and `drawImage` on a video in
  // that state quietly draws *nothing* and leaves the canvas transparent. So
  // the readiness is checked up front, and the result is checked afterwards —
  // a decoded frame is always opaque, so a transparent centre pixel means the
  // draw was a no-op and the caller should not be handed a blank picture.
  function snapshot(v, h) {
    if (!v || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return null;
    const w = Math.max(1, Math.round(h * v.videoWidth / v.videoHeight));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    try { g.drawImage(v, 0, 0, w, h); } catch (_) { return null; }
    try { if (g.getImageData(w >> 1, h >> 1, 1, 1).data[3] === 0) return null; } catch (_) {}
    return c;
  }

  // Seek the hidden video to `t` and return the frame there. `h` is 0 for a
  // full-resolution grab (the cover picker).
  function seekGrab(t, h) {
    const v = ensureVideo();
    if (!v) return Promise.resolve(null);
    return new Promise((resolve) => {
      let done = false;
      const finish = (img) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        v.removeEventListener('seeked', onSeeked);
        v.removeEventListener('error', finish);
        resolve(img);
      };
      // A `seeked` can arrive before a frame is decodable, so wait for one.
      // The outer timeout bounds this however long it takes.
      const shoot = () => requestAnimationFrame(() => {
        if (done) return;
        if (v.readyState < 2) { v.addEventListener('loadeddata', shoot, { once: true }); return; }
        finish(snapshot(v, h || v.videoHeight));
      });
      const onSeeked = () => shoot();
      const timer = setTimeout(() => finish(null), 5000);
      v.addEventListener('seeked', onSeeked);
      v.addEventListener('error', finish, { once: true });
      const go = () => {
        // Assigning the time it is *already* at is a no-op: no seek happens
        // and no `seeked` ever fires, so waiting for one would sit here until
        // the timeout. This is the ordinary case at t = 0 on a cold start.
        if (Math.abs(v.currentTime - t) < 1e-4) shoot();
        else v.currentTime = t;
      };
      if (v.readyState < 1) v.addEventListener('loadedmetadata', go, { once: true });
      else go();
    });
  }

  // ---- the frame cache + one queue ---------------------------------------
  const cache = new Map();                 // key (centiseconds) -> canvas
  const queue = [];
  let pumping = false;

  function remember(key, img) {
    if (!img) return;
    cache.set(key, img);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  }

  function cached(t) { return cache.get(Math.round(t * 100)) || null; }

  // Higher wins. A frame somebody asked for by hand beats the strips; the
  // fine row beats the overview (see the note at the top of the file).
  const PRIO = { film: 1, zoom: 2, hand: 3 };

  function want(t, alive, prio) {
    const key = Math.round(t * 100);
    const hit = cache.get(key);
    if (hit) return Promise.resolve(hit);
    return new Promise((resolve) => { queue.push({ t, key, alive, resolve, prio }); pump(); });
  }

  // The most urgent job, oldest first within a priority. The queue is tens of
  // entries, so a scan is cheaper than keeping it sorted.
  function take() {
    let best = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].prio > queue[best].prio) best = i;
    return queue.splice(best, 1)[0];
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    while (queue.length) {
      const job = take();
      if (job.full) { job.resolve(await seekGrab(job.t, 0)); continue; }
      const hit = cache.get(job.key);
      if (hit) { job.resolve(hit); continue; }
      if (job.alive && !job.alive()) { job.resolve(null); continue; }
      const img = await seekGrab(job.t, THUMB_H);
      remember(job.key, img);
      job.resolve(img);
    }
    pumping = false;
  }

  // A frame at full resolution, for the cover picker. It joins the same queue
  // as the strips, because one video element services one seek at a time.
  function grabFull(t) {
    return new Promise((resolve) => { queue.push({ t, full: true, prio: PRIO.hand, resolve }); pump(); });
  }

  // ---- the zoom window ----------------------------------------------------
  let span = 10;          // seconds of timeline visible in row 2
  let from = 0;           // where that window starts
  let dragging = false;

  function clampWindow() {
    const d = domain();
    span = clamp(span, Math.min(0.4, d.total), d.total);
    from = clamp(from, 0, Math.max(0, d.total - span));
  }

  function centerOn(at) {
    from = at - span / 2;
    clampWindow();
  }

  // Follow the playhead, but only when it has actually left the window (with
  // a margin), so a small scrub doesn't shift the ground under the pointer.
  function follow(srcT) {
    if (dragging) return false;
    const d = domain();
    const p = d.fromSrc(srcT);
    const m = span * 0.12;
    if (p >= from + m && p <= from + span - m) return false;
    const was = from;
    centerOn(p);
    return Math.abs(was - from) > 1e-6;
  }

  function setSpan(next, anchorFrac = 0.5) {
    const d = domain();
    const at = from + span * anchorFrac;
    span = clamp(next, Math.min(0.4, d.total), d.total);
    from = at - span * anchorFrac;
    clampWindow();
  }

  // ---- drawing ------------------------------------------------------------
  function surface(canvas, host) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, host.clientWidth), h = Math.max(1, host.clientHeight);
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    return { g, w, h };
  }

  // The times one row wants a still for: the centre of each cell.
  function cellTimes(w, h, total, start, visible, aspect) {
    const cw = clamp(Math.round(h * aspect), 28, 220);
    const n = Math.max(1, Math.round(w / cw));
    const d = domain();
    const times = [];
    for (let i = 0; i < n; i++) {
      const at = start + ((i + 0.5) / n) * visible;
      times.push(d.toSrc(clamp(at, 0, total)));
    }
    return { n, times };
  }

  function drawCells(g, w, h, times, img) {
    const n = times.length, cw = w / n;
    for (let i = 0; i < n; i++) {
      const x = i * cw;
      g.save();
      g.beginPath();
      g.rect(x, 0, cw, h);
      g.clip();
      const t = img(times[i]);
      if (t) {
        const s = Math.max(cw / t.width, h / t.height);
        g.drawImage(t, x + (cw - t.width * s) / 2, (h - t.height * s) / 2, t.width * s, t.height * s);
      } else {
        g.fillStyle = 'rgba(255,255,255,.05)';
        g.fillRect(x, 0, cw, h);
      }
      g.restore();
      if (i) { g.fillStyle = 'rgba(0,0,0,.45)'; g.fillRect(x - 0.5, 0, 1, h); }
    }
  }

  const label = (s, fine) => {
    const m = Math.floor(s / 60), sec = s % 60;
    return `${m}:${(fine ? sec.toFixed(2) : Math.floor(sec).toString()).padStart(fine ? 5 : 2, '0')}`;
  };

  // The zoom row's ruler: a handful of labelled ticks, plus one faint tick per
  // frame once frames are far enough apart to be worth aiming at.
  function drawRuler(g, w, h) {
    const st = getState();
    const step = TICKS.find((s) => span / s <= 10) || span / 4;
    g.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    g.textBaseline = 'top';
    for (let t = Math.ceil(from / step) * step; t < from + span; t += step) {
      const x = ((t - from) / span) * w;
      g.fillStyle = 'rgba(255,255,255,.55)';
      g.fillRect(Math.round(x), 0, 1, 7);
      g.fillStyle = 'rgba(255,255,255,.85)';
      g.shadowColor = 'rgba(0,0,0,.9)';
      g.shadowBlur = 3;
      g.fillText(label(t, step < 1), Math.round(x) + 3, 1);
      g.shadowBlur = 0;
    }
    const fps = st && st.fps;
    if (fps && (w / (span * fps)) >= 6) {
      g.fillStyle = 'rgba(255,255,255,.28)';
      for (let k = Math.ceil(from * fps); k < (from + span) * fps; k++) {
        g.fillRect(Math.round((k / fps - from) / span * w), h - 5, 1, 5);
      }
    }
  }

  // ---- the marks strip ----------------------------------------------------
  // Cuts, speed-ups and the trimmed-away head/tail, as a thin band along the
  // bottom of a navigation row. `pointer-events: none` — this is a legend,
  // not a control; the controls live on row 3.
  function renderMarks(host, start, visible) {
    const st = getState();
    host.innerHTML = '';
    const d = domain();
    if (!st || !visible) return;
    const put = (a, b, cls) => {
      const lo = Math.max(a, start), hi = Math.min(b, start + visible);
      if (hi <= lo) return;
      const el = document.createElement('div');
      el.className = `tl-mark ${cls}`;
      el.style.left = `${((lo - start) / visible) * 100}%`;
      el.style.width = `${Math.max(0.3, ((hi - lo) / visible) * 100)}%`;
      host.appendChild(el);
    };
    // In output mode the row already shows only what survives, so there is
    // nothing removed to mark.
    if (d.output) return;
    put(0, st.inS, 'outside');
    put(st.outS, st.durationS, 'outside');
    for (const e of activeEdits()) put(e.start, e.end, e.rate > 0 ? 'fast' : 'cut');
    if (st.pendingMarkStart != null) {
      const t = els.preview.currentTime || 0;
      put(Math.min(st.pendingMarkStart, t), Math.max(st.pendingMarkStart, t), 'pending');
    }
  }

  // ---- rows ---------------------------------------------------------------
  let filmSig = '', zoomSig = '', filmGen = 0, zoomGen = 0, zoomTimer = null, filmTimer = null;

  function paintFilm() {
    const d = domain();
    const { g, w, h } = surface(els.filmCanvas, els.tlFilm);
    const st = getState();
    const aspect = st.video.track_width / Math.max(1, st.video.track_height);
    const { times } = cellTimes(w, h, d.total, 0, d.total, aspect);
    drawCells(g, w, h, times, cached);
    return times;
  }

  function paintZoom() {
    const d = domain();
    const { g, w, h } = surface(els.zoomCanvas, els.tlZoom);
    const st = getState();
    const aspect = st.video.track_width / Math.max(1, st.video.track_height);
    const { times } = cellTimes(w, h, d.total, from, span, aspect);
    drawCells(g, w, h, times, cached);
    drawRuler(g, w, h);
    return times;
  }

  // Fetch the stills a row is missing, repainting as each arrives. A newer
  // generation of the same row cancels an older one.
  //
  // Every request goes in *up front*, before the first is awaited. Asking for
  // them one at a time would look equivalent — the seeks are serialized
  // either way — but it would put exactly one job from each row in the queue
  // at a time, and a priority queue can only order what has been queued: the
  // two rows would simply take turns, and the fine row would finish at the
  // same moment as the overview instead of well before it.
  async function fill(times, gen, isCurrent, repaint, prio) {
    const alive = () => isCurrent(gen);
    const jobs = times.filter((t) => !cached(t)).map((t) => want(t, alive, prio));
    for (const job of jobs) {
      const img = await job;
      if (!alive()) return;
      if (img) repaint();
    }
  }

  function render() {
    const st = getState();
    if (!st || !els.tlFilm) return;
    const d = domain();
    clampWindow();

    const base = `${d.total.toFixed(3)}|${d.output ? 'o' : 'e'}|${st.previewURL}`;

    // Row 2 is asked for first, and row 1 is asked for behind it. Both halves
    // of that matter: the priority queue lets the fine stills overtake the
    // overview's once they are both in flight, and the delay below keeps the
    // overview from getting a scattered seek *started* before the fine ones
    // are even queued (a seek in progress can't be preempted).
    const zSig = `${base}|${els.tlZoom.clientWidth}x${els.tlZoom.clientHeight}|${from.toFixed(3)}|${span.toFixed(3)}`;
    if (zSig !== zoomSig) {
      zoomSig = zSig;
      const times = paintZoom();
      const gen = ++zoomGen;
      // Wait for the window to settle before spending seeks on it, and don't
      // chase it while the preview is playing: the window re-pages every few
      // seconds there, so a still would be stale before it arrived. Keep
      // asking, though — the moment it stops, the row fills in.
      const attempt = () => {
        if (gen !== zoomGen) return;
        if (isPlaying()) { zoomTimer = setTimeout(attempt, 400); return; }
        fill(times, gen, (g) => g === zoomGen, paintZoom, PRIO.zoom);
      };
      if (zoomTimer) clearTimeout(zoomTimer);
      zoomTimer = setTimeout(attempt, 120);
    }

    const fSig = `${base}|${els.tlFilm.clientWidth}x${els.tlFilm.clientHeight}`;
    if (fSig !== filmSig) {
      filmSig = fSig;
      const times = paintFilm();
      const gen = ++filmGen;
      if (filmTimer) clearTimeout(filmTimer);
      filmTimer = setTimeout(() => {
        if (gen !== filmGen) return;
        fill(times, gen, (g) => g === filmGen, paintFilm, PRIO.film);
      }, 260);
    }

    renderMarks(els.filmMarks, 0, d.total);
    renderMarks(els.zoomMarks, from, span);
    els.zoomLabel.textContent = span >= 60 ? `${(span / 60).toFixed(1)} min` : `${span.toFixed(span < 10 ? 1 : 0)} s`;
    renderHeads();
  }

  // Cheap per-frame work: the two playheads and the window box. Takes the
  // source time explicitly, because a coalesced scrub paints ahead of where
  // the <video> has actually got to.
  function renderHeads(srcT) {
    const st = getState();
    if (!st || !els.tlFilm) return;
    const d = domain();
    const p = clamp(d.fromSrc(srcT == null ? (els.preview.currentTime || 0) : srcT), 0, d.total);

    els.filmPlayhead.style.left = `${(d.total ? p / d.total : 0) * 100}%`;
    els.filmView.style.left = `${(d.total ? from / d.total : 0) * 100}%`;
    els.filmView.style.width = `${(d.total ? Math.min(span, d.total) / d.total : 1) * 100}%`;

    const inWindow = p >= from - 1e-6 && p <= from + span + 1e-6;
    els.zoomPlayhead.style.display = inWindow ? '' : 'none';
    els.zoomPlayhead.style.left = `${((p - from) / span) * 100}%`;
  }

  // Called from the playhead repaint: re-page the window if the playhead has
  // walked out of it, which needs new stills.
  function trackPlayhead(srcT) {
    if (!getState() || !els.tlFilm) return;
    const t = srcT == null ? (els.preview.currentTime || 0) : srcT;
    if (follow(t)) render();
    else renderHeads(t);
  }

  // ---- interaction --------------------------------------------------------
  function xFrac(el, clientX) {
    const r = el.getBoundingClientRect();
    return { frac: clamp((clientX - r.left) / Math.max(1, r.width), 0, 1), rect: r };
  }

  function wire() {
    // Row 1 — click or drag anywhere to jump there (the zoom window follows);
    // drag the window box itself to pan without moving the playhead.
    els.tlFilm.onpointerdown = (e) => {
      const st = getState();
      if (!st) return;
      const d = domain();
      const onBox = e.target === els.filmView;
      const r = els.tlFilm.getBoundingClientRect();
      const hold = e.clientX - r.left - (from / Math.max(1e-6, d.total)) * r.width;
      els.preview.pause();
      try { els.tlFilm.setPointerCapture(e.pointerId); } catch (_) {}
      const move = (ev) => {
        const x = ev.clientX - r.left;
        if (onBox) {
          from = ((x - hold) / r.width) * d.total;
          clampWindow();
          render();
        } else {
          const at = clamp(x / r.width, 0, 1) * d.total;
          centerOn(at);
          scrub(d.toSrc(at));
          render();
        }
      };
      move(e);
      els.tlFilm.onpointermove = move;
      els.tlFilm.onpointerup = () => {
        els.tlFilm.onpointermove = null;
        els.tlFilm.onpointerup = null;
        try { els.tlFilm.releasePointerCapture(e.pointerId); } catch (_) {}
      };
    };

    // Row 2 — scrub. The window stays put for the whole drag, so the frames
    // under the pointer don't move while you're aiming at one.
    els.tlZoom.onpointerdown = (e) => {
      if (!getState()) return;
      const d = domain();
      const r = els.tlZoom.getBoundingClientRect();
      els.preview.pause();
      dragging = true;
      try { els.tlZoom.setPointerCapture(e.pointerId); } catch (_) {}
      const move = (ev) => {
        const at = from + clamp((ev.clientX - r.left) / Math.max(1, r.width), 0, 1) * span;
        scrub(d.toSrc(clamp(at, 0, d.total)));
        renderHeads();
      };
      move(e);
      els.tlZoom.onpointermove = move;
      els.tlZoom.onpointerup = () => {
        dragging = false;
        els.tlZoom.onpointermove = null;
        els.tlZoom.onpointerup = null;
        try { els.tlZoom.releasePointerCapture(e.pointerId); } catch (_) {}
        render();
      };
    };

    // Wheel over the zoom row zooms about the pointer, so the frame you're
    // looking at stays under it.
    els.tlZoom.addEventListener('wheel', (e) => {
      if (!getState()) return;
      e.preventDefault();
      const { frac } = xFrac(els.tlZoom, e.clientX);
      setSpan(span * (e.deltaY > 0 ? 1.25 : 0.8), frac);
      render();
    }, { passive: false });

    els.btnZoomIn.onclick = () => { setSpan(span / 2); render(); };
    els.btnZoomOut.onclick = () => { setSpan(span * 2); render(); };
    els.btnZoomFit.onclick = () => { setSpan(domain().total); render(); };
  }

  // A new file: nothing cached is about it any more. Queued requests are
  // answered with `null` rather than dropped, so whoever is awaiting one —
  // a strip being filled, or the cover picker — isn't left hanging.
  function reset() {
    cache.clear();
    while (queue.length) queue.shift().resolve(null);
    if (zoomTimer) clearTimeout(zoomTimer);
    if (filmTimer) clearTimeout(filmTimer);
    filmSig = zoomSig = '';
    filmGen++; zoomGen++;
    const st = getState();
    span = st ? Math.min(10, st.durationS) : 10;
    from = 0;
    ensureVideo();
  }

  return { wire, reset, render, renderHeads, trackPlayhead, grabFull, zoomTo: (s) => { setSpan(s); render(); } };
}
