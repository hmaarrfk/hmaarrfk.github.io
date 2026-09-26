# Voice Studio

A personal voice model that sounds like you *talking*: trained on your own
narration, saved as a reusable voice profile, and served from your own Mac to
the [Video Compressor](../videocompressor/)'s "Respeak the whole script".

The Video Compressor's built-in voice (Kyutai Pocket TTS, 100M parameters,
cloned in the browser from ~10 s of the video) is the right default for a
static web page, and it sounds robotic. Measured against a held-out recording
of the speaker it scored **0.40** speaker similarity, where a real recording
scores 0.72. It also paused 0.46 s between phrases where the speaker pauses
0.19 s. The voice here scores **0.73**, and matches the speaker's pitch movement
(2.99 vs 2.97 semitones), pitch range (9.4 vs 9.4) and speaking rate
(2.8 vs 2.7 words/s), all over a 2.7-minute script, steady from start to end.

```
recordings of you ──► build_voice.py ingest ──► 3-15 s clips + transcripts
 (old screencasts,       voiceprint check,          │
  Voice Studio takes)    Whisper, loudness          ▼
                                             build_voice.py train
                                             (VoxCPM2 + LoRA, on the Mac GPU)
                                                    │
                                                    ▼
                                    ~/voice-clone/profiles/<name>/   ← the saved voice
                                                    │
                                                    ▼
                         voice_server.py  (127.0.0.1:7865, allowlisted origins)
                            │                                   │
                            ▼                                   ▼
             Video Compressor "My voice profile"     Voice Studio "Hear your voice"
```

## Make your voice (one command)

```sh
cd tools/voice-studio/server
./setup.sh                                        # once: conda env "voxcpm", VoxCPM, dependencies
conda activate voxcpm
python make_voice.py ~/Recordings/me --name me    # → ./me.voice.zip
```

`make_voice.py` takes **a folder** — anything ffmpeg reads, searched
recursively: screencasts, voice memos, Voice Studio takes. It:

1. finds every audio/video file, and skips the ones with no audio track;
2. builds a voiceprint of the dominant voice and skips other people and
   already-respoken audio (a clone trained on its own output gets *more*
   robotic);
3. transcribes with Whisper and cuts 3–15 s clips;
4. fine-tunes VoxCPM2 (LoRA) on the Mac's GPU;
5. speaks held-out lines with the last few checkpoints and keeps the best;
6. writes `me.voice.zip`, and installs it for `voice_server.py`.

Run it again after adding recordings: transcripts are cached, so only new
files are transcribed. It prints what it skipped and why, and the held-out
check (similarity, word errors).

## Use it (step 2)

```sh
conda activate voxcpm
python tools/voice-studio/server/voice_server.py
```

In the Video Compressor, under **Respeak the narration**: **Voice → My voice
profile**, then **Load a .voice.zip…** (or pick it from the list if
`make_voice.py` already installed it on this Mac). Respeak as usual.

The server remembers the last voice used on this Mac
(`~/voice-clone/profiles/.last-voice`) and starts with it, so the list opens
on your voice in any browser. Lost the zip? **Download this voice** next to
the list saves the selected one as a `.voice.zip` again.

Chrome may ask to let the site reach "devices on your local network": that
is the page talking to 127.0.0.1. Allow it.

## Record better material

The profile gets better with more of *you talking*. Recording read-aloud
sentences mostly teaches a model to read aloud.

1. Open **Voice Studio** (`/tools/voice-studio/`), choose a folder, measure the
   room, and record. About 60% of the prompts are "explain it" topics (talk for
   a minute from bullet points), 30% are "say it your way" lines, and 10% are
   numbers, versions and acronyms said the way you actually say them.
2. Put the takes and any old recordings of you in one folder and run
   `python make_voice.py <folder> --name me` (above). Underneath it is
   `build_voice.py build`, which does the whole pipeline:
   - converts every source and builds a voiceprint of the dominant voice;
   - skips other speakers, and audio that was already respoken, because a
     clone trained on its own output gets more robotic;
   - Whisper-transcribes and cuts 3–15 s clips;
   - trains the LoRA;
   - speaks held-out lines with the last three checkpoints and keeps the one
     most like you with the right words;
   - picks a reference clip that ends in a pause, and measures your pauses;
   - writes `profiles/me/` and `me.voice.zip`.

## The `.voice.zip`

A voice is one file:

```
profile.json                   schema, settings, reference transcript, pause model,
                               provenance, and a SHA-256 for every other file
reference.wav                  a real clip of you (every sentence continues it)
lora/lora_config.json          LoRA shape; base model named by Hub id
lora/lora_weights.safetensors  the trained voice (~72 MB)
```

The base model (VoxCPM2) is public and is never in the zip.

`profile.json` carries `"schema"`. `voice_profile.py` migrates older schemas
forward, and refuses a newer one with a message to update rather than
guessing. Import accepts only those four names, caps sizes, verifies every
checksum, and installs nothing unless the whole profile checks out.

A `.voice.zip` *is* your voice. Anyone with it can make it say anything, so
keep it like a password.

- **Export:** `python build_voice.py export ~/voice-clone/profiles/me`, or
  `GET /profiles/me/export`.
- **Import:** *Load a .voice.zip…* in the Video Compressor,
  `python build_voice.py import me.voice.zip`, or `POST /profiles/import`.

To add a feature that needs a new field, bump `SCHEMA` and add a migration
plus a test. The steps are in the module docstring.

## Files

| File | What it is |
|---|---|
| `index.html`, `studio.js`, `prompts.js`, `recorder-worklet.js` | The recording page |
| `server/voice_server.py` | Serves every profile in `~/voice-clone/profiles/`: `/health`, `/profiles`, `/profiles/import`, `/profiles/<name>/export`, `/speak` |
| `server/voice_script.py` | Script → sentences + pauses (mirror of `voice.js` `splitScript`) |
| `server/make_voice.py` | **The one command**: a folder of recordings → `<name>.voice.zip` |
| `server/setup.sh` | One-time environment setup (conda env, pinned VoxCPM, dependencies) |
| `server/build_voice.py` | The pipeline under it (`build`), plus `export`, `import`, `eval` |
| `server/voice_profile.py` | The profile schema: migrate, validate, export/import `.voice.zip` |
| `server/test_voice_profile.py` | Tests for the above, no model needed: `python test_voice_profile.py` |
| `server/requirements.txt` | Python dependencies beyond VoxCPM |
| `../videocompressor/voice-local.js` | The page's side of the protocol |

Nothing under `~/voice-clone/` is in git: recordings, datasets, checkpoints and
profiles are yours and stay on the machine.
