// What to say into the microphone.
//
// The mix is the research, not taste: a clone copies the *style* of what it is
// trained on, so reading sentences aloud teaches it to read sentences aloud —
// the flat, even delivery that already sounds robotic. The first profile was
// trained only on real screencasts and matched a held-out recording on pitch
// movement and pauses. So most of the time here goes to talking (explain a
// thing to someone, from bullet points), some to saying a written line *your
// way*, and a little to the words a model trips on — numbers, versions,
// acronyms, code — said the way you actually say them.

export const MODES = {
  explain: {
    label: 'Explain it',
    share: 0.6,
    how: 'Talk it through as if you were recording a screencast for a colleague. '
      + 'Glance at the points, then look away and just explain. 30–90 seconds. '
      + 'Ums, restarts and "so, basically" are welcome — that is how you talk.',
  },
  yourway: {
    label: 'Say it your way',
    share: 0.3,
    how: 'Read the line silently once. Then say it the way you would on a video — '
      + 'rephrase freely, add a "so" or a "right?". Do not read it out word for word.',
  },
  tricky: {
    label: 'Tricky words',
    share: 0.1,
    how: 'Say it naturally, the way you would pronounce these on a call — '
      + '"point nine nine eight" or "zero point nine nine eight", whichever you actually say.',
  },
};

export const EXPLAIN = [
  { t: 'Why background subtraction makes an image look dimmer', p: ['what the haze is', 'what subtracting it does to the histogram', 'why you then re-stretch the display range'] },
  { t: 'Auto-contrast: clipping the darkest and brightest pixels', p: ['what a percentile clip is', '0.1% vs 1%', 'why picking a region with biology matters'] },
  { t: 'Why a line profile that lags the view feels bad', p: ['what the profile shows', 'what "out of sync" looks like', 'the uneven-table analogy'] },
  { t: 'How a camera array covers a whole well plate', p: ['many sensors at once', 'stitching', 'what the user sees'] },
  { t: 'Circles are hard in computer graphics', p: ['everything is triangles', 'what "inside the well" means', 'why being exact matters to you'] },
  { t: 'Dashed lines that crawl as you zoom', p: ['what the dashes do today', 'screen space vs world space', 'your proposal'] },
  { t: 'What conda-forge is, to someone who has never heard of it', p: ['packages built by volunteers', 'feedstocks and bots', 'why binary compatibility is the hard part'] },
  { t: 'How you review a pull request', p: ['what you look at first', 'tests', 'when you say "let\'s merge it"'] },
  { t: 'Why a tool should run entirely in the browser', p: ['nothing uploaded', 'WebAssembly and WebCodecs', 'the trade-offs'] },
  { t: 'Compressing a screen recording without it looking bad', p: ['bitrate vs quality', 'frame rate for screencasts', 'hardware encoders'] },
  { t: 'Organoids, briefly', p: ['what they are', 'why people image them over days', 'what goes wrong in analysis'] },
  { t: 'Segmenting nuclei', p: ['what a mask is', 'thresholding vs a trained model', 'how you check the result'] },
  { t: 'Labeling masks for training data', p: ['what the labeler does', 'what makes it slow', 'shortcuts that help'] },
  { t: 'A plate map', p: ['what it records', 'why it has to be right before imaging', 'common mistakes'] },
  { t: 'Exporting data out of the software', p: ['formats people ask for', 'what metadata must travel with it', 'CSV vs HDF5 vs Zarr'] },
  { t: 'Intensity profiling', p: ['drawing the line', 'what the plot means', 'what to be careful about'] },
  { t: 'A bug you chased for too long', p: ['the symptom', 'the wrong theories', 'the actual cause'] },
  { t: 'Why frame-exact audio sync matters in a video editor', p: ['what drifts', 'how you notice', 'how you fix it'] },
  { t: 'What a GPU is good at, and what it is not', p: ['parallel work', 'transfers', 'when the CPU wins'] },
  { t: 'Explaining focus and depth of field to a new user', p: ['what is sharp', 'aperture', 'why it matters for a plate'] },
  { t: 'How you would onboard a new engineer', p: ['first week', 'the codebase tour', 'the first small change'] },
  { t: 'Why tests that pass locally fail on CI', p: ['environment differences', 'timing', 'how you debug it'] },
  { t: 'A feature you are proud of', p: ['what it does', 'why it was hard', 'what users said'] },
  { t: 'How you choose default settings', p: ['what most people need', 'escape hatches', 'not surprising anyone'] },
  { t: 'Explaining a histogram to someone new', p: ['what the axes are', 'what a clipped histogram looks like', 'display range vs data'] },
  { t: 'Why screen space vs world space matters', p: ['a simple example', 'zooming', 'which one users expect'] },
  { t: 'Reproducible Python environments', p: ['pinning', 'lock files', 'why "it works on my machine" happens'] },
  { t: 'Walking through a demo you would give at a conference booth', p: ['the hook', 'the live part', 'the question people always ask'] },
  { t: 'What makes a GUI feel responsive', p: ['latency', 'never blocking', 'feedback while something runs'] },
  { t: 'Why you record narration and then re-speak it', p: ['the first take is messy', 'what a clean script buys you', 'keeping it sounding like you'] },
];

export const YOURWAY = [
  'So the first thing you will notice is that the image is a little bit dim.',
  'If we zoom in here, you can see that the edges line up exactly with the well.',
  'This setting is on by default, and honestly most people never need to touch it.',
  'Let me show you what happens if we pick a region without any biology in it.',
  'Now, this is the older version of the software, and watch the profile at the bottom.',
  'It might shift a little, but it is drastically reduced compared to what it was.',
  'What I really want to highlight is how quickly this updates as you move around.',
  'We can remember this as a setting we like, and apply it to the rest of the plate.',
  'The left side is what is on the main branch today, and the right side is my proposal.',
  'I am not sure this is worth fixing right now, so let me know what you think.',
  'Here I have got a small demo with two views side by side.',
  'This is where things get a little bit tricky, so bear with me for a second.',
  'You can drag this handle to set where the video starts, and this one for where it ends.',
  'Once that is done, press export, and the file downloads straight to your machine.',
  'Nothing here is uploaded anywhere; it all runs on your own computer.',
  'The reason this matters is that the data is huge, tens of gigabytes per plate.',
  'So what we did instead was compute the statistics once and cache them.',
  'That is really all there is to it, but it makes a big difference day to day.',
  'Let me reset this so we are all starting from the same place.',
  'You can see the dashes are not crawling anymore as I zoom in and out.',
  'If you have questions about any of this, just reach out and I am happy to help.',
  'This one is a bit of a pet peeve of mine, so forgive me if I go on about it.',
  'We will come back to this later, but for now, just keep it in mind.',
  'And that is it; thanks for watching, and I will see you in the next one.',
  'Honestly, I was surprised at how well this worked on the first try.',
];

export const TRICKY = [
  'Very few pixels are saturated when we select 0.998.',
  'If you want to clip 0.01% of your pixels, that is still not bad.',
  'This was fixed in version 2.3.1, and backported to 2.2.7.',
  'The camera runs at 30 fps at 4K, or 120 fps at 1080p.',
  'Each well is 6.4 mm across, and the pixel size is 1.1 µm.',
  'Install it with conda install -c conda-forge napari.',
  'Set the dtype to uint16, and the shape to 512 by 512 by 3.',
  'We store the images as OME-Zarr, with the metadata in JSON.',
  'The GPU has 24 GB of VRAM, which is plenty for this.',
  'It took 350 ms per frame before, and about 12 ms now.',
  'Open the PR, wait for CI to go green, then merge it.',
  'We use FFmpeg for the encode, H.264 for compatibility and H.265 for size.',
  'The 96-well plate has 8 rows, A through H, and 12 columns.',
  'Call load_image with the path, then pass the result to segment_nuclei.',
  'The API returns a 404 if the plate ID does not exist.',
  'That is 1,500 images, or about 40 GB, per time point.',
  'NumPy, SciPy, scikit-image and PyTorch are all on conda-forge.',
  'Read it with tifffile, not PIL, because it is a 16-bit TIFF.',
  'The NA is 0.3 at 4x, and 0.75 at 20x.',
  'Run it on macOS 26, Ubuntu 24.04, or Windows 11.',
];

/** A shuffled queue that honours each mode's share. */
export function makeQueue(seed = Date.now()) {
  let s = seed >>> 0;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  const shuffle = (a) => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const pools = {
    explain: shuffle(EXPLAIN.map((x, i) => ({ mode: 'explain', id: `explain-${i}`, title: x.t, points: x.p }))),
    yourway: shuffle(YOURWAY.map((t, i) => ({ mode: 'yourway', id: `yourway-${i}`, title: t }))),
    tricky: shuffle(TRICKY.map((t, i) => ({ mode: 'tricky', id: `tricky-${i}`, title: t }))),
  };
  // Explain takes run ~60 s and the others ~6 s, so by *time* the mix is
  // roughly one explain per four short lines, not the share by count.
  const pattern = ['explain', 'yourway', 'yourway', 'tricky', 'explain', 'yourway', 'yourway', 'yourway'];
  const out = [];
  let k = 0;
  while (Object.values(pools).some((p) => p.length)) {
    const m = pattern[k++ % pattern.length];
    if (pools[m].length) out.push(pools[m].shift());
  }
  return out;
}
