"""Tests for voice_profile.py — no model, no GPU: `python test_voice_profile.py`."""
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path

import voice_profile as vp

SCHEMA0 = {
    "name": "tester",
    "engine": "voxcpm2-lora",
    "base_model": "openbmb/VoxCPM2",
    "lora": "lora",
    "reference": {"wav": "reference.wav", "text": "Hello there, this is a test."},
    "generation": {"mode": "fixed", "cfg_value": 2.0, "inference_timesteps": 10},
    "pauses": {"sentence": {"median": 0.3, "sigma": 0.4, "min": 0.1, "max": 0.9}},
}


def make_folder(root: Path, profile=SCHEMA0, base="/Users/someone/.cache/VoxCPM2") -> Path:
    d = root / "tester"
    (d / "lora").mkdir(parents=True)
    (d / "profile.json").write_text(json.dumps(profile))
    (d / "reference.wav").write_bytes(b"RIFF" + b"\0" * 100)
    (d / "lora" / "lora_weights.safetensors").write_bytes(b"\1" * 1000)
    (d / "lora" / "lora_config.json").write_text(json.dumps({"base_model": base, "lora_config": {"r": 32}}))
    return d


class Schema(unittest.TestCase):
    def test_schema0_migrates(self):
        p = vp.validate(vp.migrate(dict(SCHEMA0)))
        self.assertEqual(p["schema"], vp.SCHEMA)
        self.assertNotIn("lora", p)
        self.assertEqual(set(p["files"]), {vp.REFERENCE, vp.LORA_CONFIG, vp.LORA_WEIGHTS})

    def test_newer_schema_refused(self):
        with self.assertRaisesRegex(vp.ProfileError, "only knows up to"):
            vp.migrate({**SCHEMA0, "schema": vp.SCHEMA + 1})

    def test_local_base_model_refused(self):
        with self.assertRaisesRegex(vp.ProfileError, "Hugging Face id"):
            vp.validate(vp.migrate({**SCHEMA0, "base_model": "/Users/x/model"}))

    def test_bad_pauses_refused(self):
        bad = {**SCHEMA0, "pauses": {"sentence": {"median": 2, "min": 3, "max": 1}}}
        with self.assertRaisesRegex(vp.ProfileError, "min <= median"):
            vp.validate(vp.migrate(bad))

    def test_unknown_engine_refused(self):
        with self.assertRaisesRegex(vp.ProfileError, "engine"):
            vp.validate(vp.migrate({**SCHEMA0, "engine": "magic"}))


class RoundTrip(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def test_export_import(self):
        src = make_folder(self.root / "a")
        z = vp.export(src, self.root / "t.voice.zip")
        with zipfile.ZipFile(z) as zf:
            self.assertEqual(sorted(zf.namelist()), sorted(vp.REQUIRED))
            cfg = json.loads(zf.read(vp.LORA_CONFIG))
            self.assertEqual(cfg["base_model"], "openbmb/VoxCPM2")   # made portable
            p = json.loads(zf.read(vp.PROFILE))
            self.assertEqual(p["schema"], vp.SCHEMA)
            self.assertTrue(all(p["files"].values()))                  # checksummed
        dst = vp.import_zip(z, self.root / "profiles")
        self.assertEqual(dst.name, "tester")
        vp.load(dst)
        # The source folder was not modified by exporting it.
        self.assertIn("/Users/someone", (src / vp.LORA_CONFIG).read_text())

    def test_import_rename_and_replace(self):
        z = vp.export(make_folder(self.root / "a"), self.root / "t.voice.zip")
        vp.import_zip(z, self.root / "profiles", name="other")
        self.assertEqual(vp.load(self.root / "profiles" / "other")["name"], "other")
        with self.assertRaisesRegex(vp.ProfileError, "already exists"):
            vp.import_zip(z, self.root / "profiles", name="other")
        vp.import_zip(z, self.root / "profiles", name="other", replace=True)

    def test_tampered_weights_rejected(self):
        z = vp.export(make_folder(self.root / "a"), self.root / "t.voice.zip")
        buf = io.BytesIO()
        with zipfile.ZipFile(z) as zin, zipfile.ZipFile(buf, "w") as zout:
            for n in zin.namelist():
                data = zin.read(n)
                zout.writestr(n, b"\2" * 1000 if n == vp.LORA_WEIGHTS else data)
        with self.assertRaisesRegex(vp.ProfileError, "checksum"):
            vp.import_zip(buf.getvalue(), self.root / "profiles")
        self.assertFalse((self.root / "profiles" / "tester").exists())

    def test_unexported_folder_zip_rejected(self):
        src = make_folder(self.root / "a", base="openbmb/VoxCPM2")
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as zf:
            for rel in vp.REQUIRED:
                zf.write(src / rel, rel)
        with self.assertRaisesRegex(vp.ProfileError, "no checksums"):
            vp.import_zip(buf.getvalue(), self.root / "profiles")

    def test_path_traversal_ignored(self):
        z = vp.export(make_folder(self.root / "a"), self.root / "t.voice.zip")
        buf = io.BytesIO()
        with zipfile.ZipFile(z) as zin, zipfile.ZipFile(buf, "w") as zout:
            for n in zin.namelist():
                zout.writestr(n, zin.read(n))
            zout.writestr("../../evil.txt", b"x")
        dst = vp.import_zip(buf.getvalue(), self.root / "profiles")
        self.assertFalse((self.root / "evil.txt").exists())
        self.assertFalse((dst / "evil.txt").exists())

    def test_single_top_folder_accepted(self):
        z = vp.export(make_folder(self.root / "a"), self.root / "t.voice.zip")
        buf = io.BytesIO()
        with zipfile.ZipFile(z) as zin, zipfile.ZipFile(buf, "w") as zout:
            for n in zin.namelist():
                zout.writestr("tester/" + n, zin.read(n))
        vp.import_zip(buf.getvalue(), self.root / "profiles")

    def test_missing_file_rejected(self):
        z = vp.export(make_folder(self.root / "a"), self.root / "t.voice.zip")
        buf = io.BytesIO()
        with zipfile.ZipFile(z) as zin, zipfile.ZipFile(buf, "w") as zout:
            for n in zin.namelist():
                if n != vp.REFERENCE:
                    zout.writestr(n, zin.read(n))
        with self.assertRaisesRegex(vp.ProfileError, "no reference.wav"):
            vp.import_zip(buf.getvalue(), self.root / "profiles")

    def test_not_a_zip(self):
        with self.assertRaisesRegex(vp.ProfileError, "not a zip"):
            vp.import_zip(b"hello", self.root / "profiles")


if __name__ == "__main__":
    unittest.main()
