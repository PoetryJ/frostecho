"""Feature cache IO: one file per split, fingerprinted, labels only where allowed."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from contracts import CACHE, ORDERS, sha256_json, sha256_text, write_json  # noqa: E402


def cache_paths(split: str) -> tuple[Path, Path]:
    return CACHE / f"features-{split}.npz", CACHE / f"features-{split}.meta.json"


def save_split(split: str, rows: list[dict], meta: dict) -> dict:
    npz, meta_path = cache_paths(split)
    np.savez_compressed(
        npz,
        cand=np.stack([row["cand"] for row in rows]).astype(np.float32),
        hq=np.stack([row["hq"] for row in rows]).astype(np.float32),
        letterLogp=np.stack([row["letterLogp"] for row in rows]).astype(np.float32),
        candidateMass=np.array([row["candidateMass"] for row in rows], dtype=np.float32),
        labelIndex=np.array([row["labelIndex"] for row in rows], dtype=np.int64),
        caseIds=np.array([row["caseId"] for row in rows], dtype=object),
        orderIdx=np.array([row["orderIdx"] for row in rows], dtype=np.int64),
        idsSha256=np.array([row["idsSha256"] for row in rows], dtype=object),
        renderedSha256=np.array([row["renderedSha256"] for row in rows], dtype=object),
        tokensIn=np.array([row["tokensIn"] for row in rows], dtype=np.int64),
        positions=np.stack([row["positions"] for row in rows]).astype(np.int64),
        final=np.array([row["final"] for row in rows], dtype=np.int64),
    )
    payload = {**meta, "count": len(rows), "caseOrder": [row["caseId"] for row in rows],
               "orderIdx": [row["orderIdx"] for row in rows],
               "npzSha256": sha256_bytes_file(npz)}
    write_json(meta_path, payload)
    return payload


def sha256_bytes_file(path: Path) -> str:
    import hashlib
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_split(split: str, model_sha: str, cases_hash: str) -> tuple[dict, dict]:
    npz, meta_path = cache_paths(split)
    if not npz.exists() or not meta_path.exists():
        raise FileNotFoundError(f"no feature cache for {split}")
    meta = json.loads(meta_path.read_text(encoding="utf-8"))
    if meta.get("modelSha256") != model_sha:
        raise ValueError(f"{split}: cache model fingerprint differs")
    if meta.get("datasetCasesSha256") != cases_hash:
        raise ValueError(f"{split}: cache dataset fingerprint differs")
    if sha256_bytes_file(npz) != meta.get("npzSha256"):
        raise ValueError(f"{split}: feature npz bytes changed")
    data = np.load(npz, allow_pickle=True)
    return {key: data[key] for key in data.files}, meta


def build_rows(feature_results: list[dict], cases: list[dict]) -> list[dict]:
    """Attach the stable target index; NEVER called for test before unsealing."""
    by_id = {case["caseId"]: case for case in cases}
    rows = []
    for feature in feature_results:
        case = by_id[feature["caseId"]]
        label = case["labelId"]
        order = ORDERS[feature["orderIdx"]]
        rows.append({**feature, "labelIndex": order.index(label)})
    return rows
