#!/usr/bin/env python
"""Make your voice, in one command.

    python make_voice.py ~/Recordings/me --name mark

Point it at a directory of recordings of you talking — screencasts, voice
memos, Voice Studio takes; audio or video, any format ffmpeg reads, in any
sub-folder — and it writes `mark.voice.zip` in the current directory. Load
that file in the Video Compressor under *Voice → My voice profile → Load a
.voice.zip…* (with `voice_server.py` running) and respeak.

What happens, and roughly how long it takes on an M-series Mac for an hour of
speech (details: build_voice.py and ../REQUIREMENTS.md):

    1. find every audio/video file under the directory          seconds
    2. check each one is *you* (a voiceprint of the dominant    ~1 min
       voice); other people and already-respoken audio are
       skipped, and listed at the end
    3. transcribe with Whisper and cut 3-15 s clips              ~5 min
    4. fine-tune VoxCPM2 (a LoRA) on the clips                   ~15-20 min
    5. listen to the last few checkpoints, keep the best         ~2 min
    6. write <name>.voice.zip (and install it for voice_server)

Run it again after adding recordings: transcripts are cached, so only the new
files are transcribed. First time on a machine: ./setup.sh.
"""
from __future__ import annotations

import argparse
import hashlib
import os
import re
import shutil
import sys
from pathlib import Path

import build_voice

MEDIA = build_voice.MEDIA


def find_media(root: Path) -> list[Path]:
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".")]
        for f in filenames:
            p = Path(dirpath) / f
            if not f.startswith(".") and p.suffix.lower() in MEDIA:
                out.append(p)
    return sorted(out)


def link_sources(files: list[Path], root: Path, sources: Path) -> int:
    """Mirror the recordings into the workspace as links (never copies)."""
    sources.mkdir(parents=True, exist_ok=True)
    wanted = {}
    for f in files:
        rel = f.relative_to(root)
        # A readable, unique, stable name: the relative path, plus a short hash
        # so a/take1.wav and b/take1.wav cannot collide.
        stem = re.sub(r"[^A-Za-z0-9._-]", "_", str(rel.with_suffix("")))[-60:]
        tag = hashlib.sha1(str(rel).encode()).hexdigest()[:6]
        wanted[f"{stem}_{tag}{f.suffix.lower()}"] = f
    for existing in sources.iterdir():
        if existing.name not in wanted:
            existing.unlink()          # a recording removed from the directory
    for name, f in wanted.items():
        link = sources / name
        if not link.exists():
            link.symlink_to(f.resolve())
    return len(wanted)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0],
                                 formatter_class=argparse.RawDescriptionHelpFormatter,
                                 epilog=__doc__.split("\n\n", 1)[1])
    ap.add_argument("directory", help="folder with recordings of you talking (searched recursively)")
    ap.add_argument("--name", default=None, help="the voice's name (default: the directory's name)")
    ap.add_argument("--out", default=None, help="where to write the .voice.zip (default: ./<name>.voice.zip)")
    ap.add_argument("--home", default=str(build_voice.HOME),
                    help="where the working files live (default: ~/voice-clone)")
    ap.add_argument("--resume", action="store_true", help="reuse a finished training run for this name")
    a = ap.parse_args()

    root = Path(a.directory).expanduser().resolve()
    if not root.is_dir():
        sys.exit(f"not a directory: {root}")
    name = a.name or re.sub(r"[^A-Za-z0-9._-]", "-", root.name).strip("-.") or "my-voice"
    if not build_voice.voice_profile.NAME_RE.match(name):
        sys.exit("--name: letters, digits, '.', '_' or '-' (up to 64)")
    home = Path(a.home).expanduser()
    ws = home / "voices" / name
    files = find_media(root)
    if not files:
        sys.exit(f"no audio or video files under {root} ({', '.join(sorted(MEDIA))})")
    n = link_sources(files, root, ws / "sources")
    print(f"{n} recordings under {root}\nworking in {ws}", flush=True)

    try:
        res = build_voice.build(ws, name, home / "profiles", resume=a.resume)
    except (build_voice.BuildError, build_voice.voice_profile.ProfileError) as e:
        sys.exit(f"\nerror: {e}")
    out = Path(a.out).expanduser() if a.out else Path.cwd() / f"{name}.voice.zip"
    shutil.copy(res["zip"], out)

    q = res["quality"]
    print(f"\n✓ {out}")
    print(f"  {res['clips']} clips, {res['minutes']} min of your speech; "
          f"checked on held-out lines: similarity {q['similarity']}, word errors {q['wer']:.0%}")
    if res["skipped"]:
        print("  skipped:")
        for s in res["skipped"]:
            print(f"    {s['source']}: {s['reason']}")
    print(f"  took {res['seconds'] // 60} min {res['seconds'] % 60} s")
    print("\nNext: python voice_server.py, then in the Video Compressor choose "
          "Voice → My voice profile → Load a .voice.zip…")


if __name__ == "__main__":
    main()
