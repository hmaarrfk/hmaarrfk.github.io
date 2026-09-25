"""Tests for make_voice.py's file handling — no model: `python test_make_voice.py`."""
import tempfile
import unittest
from pathlib import Path

import make_voice as mv


class Files(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name) / "rec"
        for rel in ["a/take1.wav", "b/take1.wav", "c/deep/talk.MOV", "notes.txt", "shot.png",
                    ".hidden.wav", ".git/x.wav", "memo.m4a"]:
            p = self.root / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(b"x")
        self.sources = Path(self.tmp.name) / "ws" / "sources"

    def tearDown(self):
        self.tmp.cleanup()

    def test_finds_media_recursively_skipping_hidden(self):
        found = [p.relative_to(self.root).as_posix() for p in mv.find_media(self.root)]
        self.assertEqual(found, ["a/take1.wav", "b/take1.wav", "c/deep/talk.MOV", "memo.m4a"])

    def test_links_are_unique_stable_and_follow_removals(self):
        files = mv.find_media(self.root)
        self.assertEqual(mv.link_sources(files, self.root, self.sources), 4)
        names = sorted(p.name for p in self.sources.iterdir())
        self.assertEqual(len(set(names)), 4)                         # a/ and b/ take1 do not collide
        self.assertTrue(all((self.sources / n).is_symlink() for n in names))
        mv.link_sources(files, self.root, self.sources)
        self.assertEqual(sorted(p.name for p in self.sources.iterdir()), names)   # stable
        (self.root / "memo.m4a").unlink()
        mv.link_sources(mv.find_media(self.root), self.root, self.sources)
        self.assertEqual(len(list(self.sources.iterdir())), 3)       # removed file leaves the build


if __name__ == "__main__":
    unittest.main()
