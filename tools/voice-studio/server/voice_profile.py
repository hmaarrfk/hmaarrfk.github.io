"""The voice profile format: a folder on disk, a zip on the wire.

A profile is everything needed to speak as one person, apart from the base
model (which is public and fetched from the Hub by name):

    profile.json                  this schema: settings, reference transcript,
                                  pause model, provenance, and a file manifest
    reference.wav                 a real clip of the speaker (the prompt)
    lora/lora_config.json         LoRA shape
    lora/lora_weights.safetensors the trained voice

Exported, the same tree is zipped flat into one `<name>.voice.zip`.

Versioning
----------
`profile.json` carries `"schema": N`. The loader reads any schema up to
`SCHEMA`, migrating older ones forward one step at a time (`MIGRATIONS`), and
refuses a newer one with a message saying to update, rather than guessing at
fields it has never seen. When a feature needs a new field:

  1. bump `SCHEMA`,
  2. add `_migrate_<old>_to_<new>` that fills the field in for old profiles,
  3. teach `validate` about it,
  4. add a case to `test_voice_profile.py`.

Profiles without a `schema` key are schema 0: the first ones, written by hand
before this file existed.

Safety
------
A profile *is* someone's voice, and an imported zip is untrusted input. Import
therefore: accepts only the known file names (no paths from the archive are
ever joined onto the destination), caps sizes, verifies each file's SHA-256
against the manifest, and requires `lora_config.json` to name its base model by
Hub id rather than by a path on somebody else's machine.
"""
from __future__ import annotations

import hashlib
import io
import json
import re
import shutil
import tempfile
import zipfile
from pathlib import Path

SCHEMA = 1
ENGINES = {"voxcpm2-lora"}
DEFAULT_BASE = "openbmb/VoxCPM2"

REFERENCE = "reference.wav"
LORA_CONFIG = "lora/lora_config.json"
LORA_WEIGHTS = "lora/lora_weights.safetensors"
PROFILE = "profile.json"
# Everything a profile may contain, with a size cap each. Nothing else is read
# out of an archive.
FILES = {
    PROFILE: 1 << 20,
    REFERENCE: 64 << 20,
    LORA_CONFIG: 1 << 20,
    LORA_WEIGHTS: 1 << 30,
}
REQUIRED = (PROFILE, REFERENCE, LORA_CONFIG, LORA_WEIGHTS)
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")


class ProfileError(ValueError):
    """A profile that cannot be used, with a message fit for a person."""


# ---------------------------------------------------------------------------
# migrations
# ---------------------------------------------------------------------------

def _migrate_0_to_1(p: dict) -> dict:
    """Schema 0 → 1: add the version and name the files explicitly.

    Schema 0 had `"lora": "lora"` (a folder) and `reference.wav` (a file name).
    Schema 1 lists every file in `files`, so the manifest (with checksums) and
    the loader agree on one layout.
    """
    p = dict(p)
    p.pop("lora", None)
    ref = dict(p.get("reference") or {})
    ref.setdefault("wav", REFERENCE)
    p["reference"] = ref
    p.setdefault("base_model", DEFAULT_BASE)
    p["files"] = {k: None for k in REQUIRED if k != PROFILE}
    p["schema"] = 1
    return p


MIGRATIONS = {0: _migrate_0_to_1}


def migrate(p: dict) -> dict:
    v = p.get("schema", 0)
    if not isinstance(v, int) or v < 0:
        raise ProfileError(f"profile.json has an invalid schema {v!r}")
    if v > SCHEMA:
        raise ProfileError(
            f"This profile uses schema {v}, but this voice server only knows up to "
            f"{SCHEMA}. Update tools/voice-studio and try again.")
    while v < SCHEMA:
        p = MIGRATIONS[v](p)
        v = p["schema"]
    return p


# ---------------------------------------------------------------------------
# validation
# ---------------------------------------------------------------------------

def _need(cond, msg):
    if not cond:
        raise ProfileError(msg)


def validate(p: dict) -> dict:
    """Check a (migrated) profile's fields. Returns it for chaining."""
    _need(p.get("schema") == SCHEMA, f"schema must be {SCHEMA} after migration")
    _need(isinstance(p.get("name"), str) and NAME_RE.match(p["name"]),
          "name must be 1-64 letters, digits, '.', '_' or '-'")
    _need(p.get("engine") in ENGINES, f"engine must be one of {sorted(ENGINES)}, not {p.get('engine')!r}")
    _need(isinstance(p.get("base_model"), str) and "/" in p["base_model"]
          and not p["base_model"].startswith(("/", "~", ".")),
          "base_model must be a Hugging Face id like 'openbmb/VoxCPM2', not a local path")
    ref = p.get("reference")
    _need(isinstance(ref, dict) and ref.get("wav") == REFERENCE,
          f"reference.wav must be {REFERENCE!r}")
    _need(isinstance(ref.get("text"), str) and ref["text"].strip(),
          "reference.text must be the transcript of reference.wav")
    gen = p.get("generation", {})
    _need(isinstance(gen, dict), "generation must be an object")
    if "mode" in gen:
        _need(gen["mode"] in ("fixed", "rolling", "anchored"), f"unknown generation.mode {gen['mode']!r}")
    for k in ("cfg_value", "max_wer"):
        if k in gen:
            _need(isinstance(gen[k], (int, float)), f"generation.{k} must be a number")
    for k in ("inference_timesteps", "max_retries", "max_len"):
        if k in gen:
            _need(isinstance(gen[k], int) and gen[k] > 0, f"generation.{k} must be a positive integer")
    for kind, d in (p.get("pauses") or {}).items():
        _need(kind in ("sentence", "clause", "paragraph"), f"unknown pause kind {kind!r}")
        _need(isinstance(d, dict) and all(isinstance(d.get(x), (int, float)) for x in ("median", "min", "max"))
              and 0 <= d["min"] <= d["median"] <= d["max"] <= 5,
              f"pauses.{kind} needs 0 <= min <= median <= max <= 5 seconds")
    files = p.get("files")
    _need(isinstance(files, dict) and set(files) == set(REQUIRED) - {PROFILE},
          f"files must list exactly {sorted(set(REQUIRED) - {PROFILE})}")
    return p


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(1 << 20), b""):
            h.update(b)
    return h.hexdigest()


def _check_lora_config(path: Path):
    try:
        cfg = json.loads(path.read_text())
    except (OSError, ValueError) as e:
        raise ProfileError(f"{LORA_CONFIG} is not valid JSON: {e}") from None
    _need(isinstance(cfg.get("lora_config"), dict), f"{LORA_CONFIG} has no lora_config")
    return cfg


# ---------------------------------------------------------------------------
# load / save a folder
# ---------------------------------------------------------------------------

def load(folder, verify: bool = True) -> dict:
    """Read, migrate and validate the profile in `folder`.

    With `verify`, every file must exist and match its checksum when the
    manifest has one. (A profile written in place by `build_voice.py profile`
    has none until it is exported, which is fine: it has not travelled.)
    """
    folder = Path(folder).expanduser()
    try:
        raw = json.loads((folder / PROFILE).read_text())
    except FileNotFoundError:
        raise ProfileError(f"no {PROFILE} in {folder}") from None
    except ValueError as e:
        raise ProfileError(f"{PROFILE} is not valid JSON: {e}") from None
    p = validate(migrate(raw))
    if verify:
        for rel, digest in p["files"].items():
            f = folder / rel
            _need(f.is_file(), f"missing {rel}")
            if digest:
                _need(_sha256(f) == digest, f"{rel} does not match its checksum (corrupt or edited)")
        _check_lora_config(folder / LORA_CONFIG)
    return p


def save(folder, p: dict, checksums: bool = False):
    """Write `p` (migrated to the current schema) as `folder/profile.json`."""
    folder = Path(folder)
    p = migrate(dict(p))
    if checksums:
        p["files"] = {rel: _sha256(folder / rel) for rel in p["files"]}
    validate(p)
    (folder / PROFILE).write_text(json.dumps(p, indent=2) + "\n")
    return p


def portable_lora_config(path: Path, base: str = DEFAULT_BASE):
    """Name the base model by Hub id; training writes an absolute local path."""
    cfg = _check_lora_config(path)
    if cfg.get("base_model") != base:
        cfg["base_model"] = base
        path.write_text(json.dumps(cfg, indent=2) + "\n")


# ---------------------------------------------------------------------------
# export / import a zip
# ---------------------------------------------------------------------------

def export(folder, out=None) -> Path:
    """Zip a profile folder into `<name>.voice.zip`, with checksums."""
    folder = Path(folder).expanduser()
    p = load(folder, verify=True)
    out = Path(out) if out else folder.parent / f"{p['name']}.voice.zip"
    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp)
        for rel in REQUIRED:
            (stage / rel).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(folder / rel, stage / rel)
        portable_lora_config(stage / LORA_CONFIG, p.get("base_model", DEFAULT_BASE))
        save(stage, p, checksums=True)
        tmp_out = out.with_suffix(out.suffix + ".part")
        # Stored, not deflated: safetensors and WAV barely compress, and
        # stored entries make the checksum pass on import cheap.
        with zipfile.ZipFile(tmp_out, "w", zipfile.ZIP_STORED) as z:
            for rel in REQUIRED:
                z.write(stage / rel, rel)
        tmp_out.replace(out)
    return out


def import_zip(src, profiles_dir, name: str | None = None, replace: bool = False) -> Path:
    """Unpack and verify a `.voice.zip` into `profiles_dir/<name>/`.

    `src` is a path or bytes. Nothing lands in `profiles_dir` unless the whole
    profile checks out; an existing profile is only replaced with `replace`.
    """
    data = src if isinstance(src, (bytes, bytearray)) else Path(src).expanduser().read_bytes()
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ProfileError("not a zip file") from None
    # Some zip tools put the profile inside one top-level folder; accept that,
    # but only as a prefix that is stripped, never as a path that is joined.
    names = [i.filename for i in z.infolist() if not i.is_dir()]
    prefixes = {n[: -len(PROFILE)] for n in names if n.endswith(PROFILE)}
    _need(len(prefixes) == 1, f"the zip must contain exactly one {PROFILE}")
    prefix = prefixes.pop()
    _need(prefix == "" or re.fullmatch(r"[^/\\]+/", prefix), "profile.json is nested too deep")
    profiles_dir = Path(profiles_dir).expanduser()
    profiles_dir.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=profiles_dir) as tmp:
        stage = Path(tmp) / "p"
        for rel, cap in FILES.items():
            try:
                info = z.getinfo(prefix + rel)
            except KeyError:
                continue
            _need(info.file_size <= cap, f"{rel} is too large ({info.file_size} bytes)")
            (stage / rel).parent.mkdir(parents=True, exist_ok=True)
            with z.open(info) as fi, open(stage / rel, "wb") as fo:
                n = 0
                for b in iter(lambda: fi.read(1 << 20), b""):
                    n += len(b)
                    _need(n <= cap, f"{rel} is too large")
                    fo.write(b)
        for rel in REQUIRED:
            _need((stage / rel).is_file(), f"the zip has no {rel}")
        p = load(stage, verify=True)
        _need(all(p["files"].values()), "the zip's profile.json has no checksums (was it exported?)")
        cfg = _check_lora_config(stage / LORA_CONFIG)
        _need(isinstance(cfg.get("base_model"), str) and not cfg["base_model"].startswith(("/", "~", ".")),
              f"{LORA_CONFIG} names its base model by a local path; re-export it")
        name = name or p["name"]
        _need(NAME_RE.match(name), f"invalid profile name {name!r}")
        if name != p["name"]:
            p["name"] = name
            save(stage, p, checksums=True)
        dst = profiles_dir / name
        if dst.exists():
            _need(replace, f"a profile named {name!r} already exists")
            shutil.rmtree(dst)
        stage.rename(dst)
    return dst
