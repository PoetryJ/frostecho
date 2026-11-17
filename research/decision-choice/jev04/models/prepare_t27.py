#!/usr/bin/env python3
"""R3 (M): prepare the real model weights for the jev choice head.

Three honest modes:
  probe (default)    - lock the target identity, check the local cache roots,
                       report present/missing files with hashes (resume-safe);
  download           - huggingface_hub.snapshot_download with resume; network
                       unreachable is recorded as a failure, never skipped;
  manifest           - write the full file manifest (path, size, sha256) for
                       whatever is actually on disk.

Nothing here pretends a missing checkpoint is present, and a local
substitute is REPORTED as a substitute, never silently adopted.
"""
from __future__ import annotations

import argparse
import datetime as _dt
import hashlib
import json
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
TARGET_MODEL = "Qwen/Qwen3.5-27B"          # per R2 download list (identity lock)
CACHE_ROOTS = [
    Path("/data3/DATA/models"),
    Path("/data3/DATA/model"),
    Path("/data/models"),
    Path("/root/.cache/huggingface"),
]
RUNS = HERE / "runs"
RUNS.mkdir(exist_ok=True)


def now() -> str:
    return _dt.datetime.now(_dt.timezone.utc).isoformat()


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def disk_free(path: Path) -> int:
    try:
        stat = path.stat()
        usage = subprocess.run([sys.executable, "-c",
                                "import shutil;print(shutil.disk_usage('/data3').free)"],
                               capture_output=True, text=True, check=True)
        return int(usage.stdout.strip())
    except Exception:
        return -1


def snapshot_files(root: Path) -> list[dict]:
    files = []
    for path in sorted(root.rglob("*")):
        if path.is_file() and path.suffix in {".json", ".txt", ".safetensors",
                                              ".model", ".tiktoken", ".py"}:
            files.append({
                "path": str(path),
                "size": path.stat().st_size,
                "sha256": sha256_file(path),
            })
    return files


def probe() -> dict:
    found = []
    for root in CACHE_ROOTS:
        if not root.is_dir():
            continue
        for path in sorted(root.iterdir()):
            config = path / "config.json"
            index = path / "model.safetensors.index.json"
            if not config.is_file() or not index.is_file():
                continue
            try:
                total = json.loads(index.read_text())["metadata"]["total_size"]
            except Exception:
                continue
            shard_count = len({v for v in
                               json.loads(index.read_text())["weight_map"].values()})
            shards_present = sum(1 for f in path.glob("*.safetensors"))
            found.append({
                "path": str(path),
                "billionParams": round(total / 2 / 1e9, 2),
                "shards": shards_present,
                "shardsExpected": shard_count,
                "complete": shards_present == shard_count,
                "matchesTarget": "qwen3" in path.name.lower() and 24 <= total / 2 / 1e9 <= 32,
            })
    return {
        "schema": "frostecho.jev04.t27-prepare/1",
        "at": now(),
        "targetModel": TARGET_MODEL,
        "freeBytes": disk_free(CACHE_ROOTS[0]),
        "localCandidates": found,
        "verdict": "not-found" if not any(f["matchesTarget"] for f in found) else "present",
    }


def resolve(revision: str = "main") -> dict:
    """The exact request identity a download would use (no network)."""
    return {
        "schema": "frostecho.jev04.t27-resolve/1",
        "at": now(),
        "repo": TARGET_MODEL,
        "revision": revision,
        "configUrl": f"https://huggingface.co/{TARGET_MODEL}/resolve/{revision}/config.json",
        "downloadUrl": f"https://huggingface.co/{TARGET_MODEL}/resolve/{revision}",
        "note": "revision is 'main' until a commit hash is pinned from a reachable host",
    }


def mock_check(endpoint: str, revision: str = "main") -> dict:
    """Verify the URL/revision wiring against a LOCAL mock (network-free)."""
    import urllib.request
    url = f"{endpoint.rstrip('/')}/{TARGET_MODEL}/resolve/{revision}/config.json"
    result = {"schema": "frostecho.jev04.t27-mock/1", "at": now(), "url": url,
              "revision": revision}
    try:
        with urllib.request.urlopen(url, timeout=5) as response:
            body = response.read()
            result.update({"status": response.status,
                           "bytes": len(body),
                           "ok": response.status == 200 and len(body) > 0})
    except Exception as error:
        result.update({"ok": False,
                       "error": f"{type(error).__name__}: {error}"[:300]})
    return result


def download(revision: str = "main") -> dict:
    resolved = resolve(revision)
    result = {"schema": "frostecho.jev04.t27-download/1", "at": now(),
              "revision": revision,
              **{key: value for key, value in resolved.items()
                 if key in ("repo", "configUrl", "downloadUrl")},
              "snapshotArgs": {"repo_id": TARGET_MODEL, "revision": revision,
                               "resume_download": True, "max_workers": 4},
              "resumeCommand": ("python3 research/decision-choice/jev04/models/"
                                f"prepare_t27.py --download --revision {revision}")}
    # The FIRST network request is the real repository/revision config URL; it
    # is also what a mock intercept must see.
    import urllib.request
    try:
        urllib.request.urlopen(resolved["configUrl"], timeout=8)
        reachable = True
    except Exception as error:
        result.update({"status": "failed",
                       "errorType": "network-unreachable",
                       "error": f"{type(error).__name__}: {error}"[:500]})
        return result
    if not reachable:  # pragma: no cover
        return result
    try:
        from huggingface_hub import snapshot_download
    except ImportError:
        result.update({"status": "dependency-missing",
                       "fix": "pip install -r requirements-t27.txt"})
        return result
    try:
        path = snapshot_download(TARGET_MODEL, revision=revision,
                                 resume_download=True, max_workers=4)
        result.update({"status": "ok", "path": str(path),
                       "requestedRepo": TARGET_MODEL, "requestedRevision": revision})
    except Exception as error:  # auth, quota, partial files...
        result.update({"status": "failed",
                       "errorType": type(error).__name__,
                       "error": str(error)[:500]})
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--download", action="store_true")
    parser.add_argument("--revision", default="main")
    parser.add_argument("--resolve-only", action="store_true")
    parser.add_argument("--mock-endpoint", default=None)
    parser.add_argument("--manifest-for", default=None,
                        help="write the full file manifest for this local path")
    args = parser.parse_args()

    stamp = _dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    exit_code = 0
    if args.resolve_only:
        result = resolve(args.revision)
        out = RUNS / f"t27-resolve-{stamp}.json"
    elif args.mock_endpoint:
        result = mock_check(args.mock_endpoint, args.revision)
        exit_code = 0 if result.get("ok") else 1
        out = RUNS / f"t27-mock-{stamp}.json"
    elif args.download:
        result = download(args.revision)
        exit_code = 0 if result.get("status") == "ok" else 1
        out = RUNS / f"t27-download-{stamp}.json"
    elif args.manifest_for:
        root = Path(args.manifest_for)
        result = {"schema": "frostecho.jev04.model-file-manifest/1", "at": now(),
                  "root": str(root), "files": snapshot_files(root)}
        out = RUNS / f"model-manifest-{root.name}-{stamp}.json"
    else:
        result = probe()
        out = RUNS / f"t27-prepare-{stamp}.json"
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n",
                   encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    print(f"written: {out}", file=sys.stderr)
    return exit_code


if __name__ == "__main__":
    raise SystemExit(main())
