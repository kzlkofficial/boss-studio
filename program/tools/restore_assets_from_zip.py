#!/usr/bin/env python3
"""Import authentic 4.9 sprites/previews from the original release ZIP."""
import argparse
import hashlib
import json
import subprocess
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
MANIFEST = Path(__file__).with_name("original_assets_sha256.json")


def sha256(data):
    return hashlib.sha256(data).hexdigest()


def main():
    parser = argparse.ArgumentParser(
        description="Restore Boss Studio 4.9 PNG sprites without changing them."
    )
    parser.add_argument("archive", type=Path, help="Original BossStudio_4_9_*.zip")
    args = parser.parse_args()
    expected = json.loads(MANIFEST.read_text(encoding="utf-8"))
    if not args.archive.is_file():
        parser.error("Original release ZIP was not found.")

    with zipfile.ZipFile(args.archive) as z:
        names = z.namelist()
        staged = {}
        for rel, meta in expected.items():
            dest = ROOT / rel
            if dest.exists():
                current = dest.read_bytes()
                if len(current) != meta["size"] or sha256(current) != meta["sha256"]:
                    raise SystemExit(f"Conflict: existing file differs: {rel}")
                print(f"OK, unchanged: {rel}")
                continue

            candidates = [
                name for name in names
                if name.replace("\\", "/").endswith("/" + rel)
                and not name.endswith("/")
            ]
            if len(candidates) != 1:
                raise SystemExit(
                    f"Expected exactly one archive entry for {rel}; got {len(candidates)}"
                )
            info = z.getinfo(candidates[0])
            if info.file_size != meta["size"]:
                raise SystemExit(f"Unexpected image size: {rel}")
            data = z.read(info)
            if sha256(data) != meta["sha256"]:
                raise SystemExit(f"Checksum mismatch: {rel}")
            staged[rel] = data

    for rel, data in staged.items():
        dest = ROOT / rel
        dest.parent.mkdir(parents=True, exist_ok=True)
        temporary = dest.with_name(dest.name + ".partial")
        temporary.write_bytes(data)
        temporary.replace(dest)
        print(f"RESTORED: {rel}")

    build = ROOT / "program/tools/build_assets_embedded.py"
    subprocess.run([sys.executable, str(build)], check=True)
    print(f"Done: {len(staged)} original images restored; bundled assets regenerated.")
    print("Next: review the changes, then commit and push them to GitHub.")


if __name__ == "__main__":
    main()
