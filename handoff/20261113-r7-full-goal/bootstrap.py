"""Verify the supplied original source/assets and unpack read-only references.
Usage: python handoff/20261113-r7-full-goal/bootstrap.py [--verify-only]
Only the Python standard library is required. No server, model or game is started.
"""
import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import zipfile

HERE = Path(__file__).resolve().parent
EXPECTED = {
    "legacy-reference.zip": "5a53d2801f746d38b03986601b8d96dc8760fc72ff602c0ebe42d131a86b7662",
    "legacy-assets.zip": "cce134362606fc1dbccf071a62d40b91320f997554d1f99df247c82096cc057b",
}


def sha(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    for name, expected in EXPECTED.items():
        path = HERE / "legacy" / name
        actual = sha(path)
        if actual != expected:
            raise SystemExit(f"SHA mismatch: {name}: {actual}")
    manifest = HERE / "SHA256SUMS.txt"
    count = 0
    if manifest.exists():
        for line in manifest.read_text(encoding="utf-8").splitlines():
            expected, rel = line.split("  ", 1)
            path = (HERE / rel).resolve()
            if not path.is_relative_to(HERE):
                raise SystemExit(f"Unsafe manifest path: {rel}")
            if sha(path) != expected:
                raise SystemExit(f"Package SHA mismatch: {rel}")
            count += 1
    records = []
    # Preflight every member and existing byte before making any changes.
    for name in EXPECTED:
        dest = (HERE / "reference-extracted" /
                ("source" if name == "legacy-reference.zip" else "assets")).resolve()
        with zipfile.ZipFile(HERE / "legacy" / name) as archive:
            for info in archive.infolist():
                rel = PurePosixPath(info.filename)
                if rel.is_absolute() or ".." in rel.parts or "\\" in info.filename:
                    raise SystemExit(f"Unsafe archive path: {info.filename}")
                if info.is_dir():
                    continue
                target = (dest / Path(*rel.parts)).resolve()
                if not target.is_relative_to(dest):
                    raise SystemExit(f"Archive path escapes destination: {info.filename}")
                data = archive.read(info)
                digest = hashlib.sha256(data).hexdigest()
                if target.exists() and sha(target) != digest:
                    raise SystemExit(f"Existing reference differs; refusing overwrite: {target}")
                records.append((target, data, digest, name))
    inventory = json.loads((HERE / "legacy" / "legacy-package-inventory.json").read_text(encoding="utf-8-sig"))
    members = {str(target.relative_to(HERE / "reference-extracted")).replace("\\", "/"): (len(data), digest)
               for target, data, digest, _ in records}
    checked_originals = {}
    for group, prefix in (("source", "source/extracted/"), ("assets", "assets/")):
        entries = inventory[group]["entries"]
        for entry in entries:
            observed = members.get(prefix + entry["path"])
            if observed != (entry["bytes"], entry["sha256"]):
                raise SystemExit(f"Original inventory mismatch: {group}/{entry['path']}")
        checked_originals[group] = len(entries)
    if not args.verify_only:
        for target, data, _, _ in records:
            target.parent.mkdir(parents=True, exist_ok=True)
            if not target.exists():
                target.write_bytes(data)
    print(json.dumps({
        "ok": True, "package_files_checked": count,
        "archive_files_checked": len(records), "originals_checked": checked_originals,
        "extracted": not args.verify_only,
        "output": str(HERE / "reference-extracted"),
        "game_executed": False, "model_executed": False,
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
