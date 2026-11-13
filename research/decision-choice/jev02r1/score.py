"""Head read-out from cached hidden states (CPU only, no model load).

Calibration splits only: test scores are produced inside the single unseal
process, never by this module.
"""
from __future__ import annotations

from pathlib import Path

import numpy as np

from r1config import HEAD_PATH, ORDERS, read_jsonl, sha256_file, split_file, write_jsonl


def load_features(path: Path) -> dict:
    data = np.load(path, allow_pickle=True)
    return {key: data[key] for key in data.files}


def head_logits(features: dict, head_path: Path | None = None) -> list[list[float]]:
    """Frozen linear head: z = LN(cand) @ w. Runs on CPU in milliseconds."""
    import torch
    from heads.train import load_head
    from r1config import find_head
    head, _ = load_head(Path(head_path) if head_path else find_head(), device="cpu")
    cand = torch.from_numpy(features["cand"].astype(np.float32))
    with torch.no_grad():
        logits = head(cand).numpy()
    if not np.isfinite(logits).all():
        raise ValueError("non-finite head logits")
    return logits.tolist()


def scores_for(split: str, features_path: Path, head_path: Path | None = None) -> list[dict]:
    if split == "test":
        raise PermissionError("test scores are only produced by unseal.py")
    features = load_features(features_path)
    logits = head_logits(features, head_path)
    cases = {row["caseId"]: row for row in read_jsonl(split_file(split))}
    rows = []
    for index in range(len(logits)):
        case_id = str(features["caseIds"][index])
        order = int(features["orderIdx"][index])
        case = cases[case_id]
        label = case["labelId"]
        rows.append({"caseId": case_id, "order": order, "logits": logits[index],
                     "labelId": label, "family": case["family"],
                     "labelIndex": ORDERS[order].index(label),
                     "idsSha256": str(features["idsSha256"][index]),
                     "renderedSha256": str(features["renderedSha256"][index]),
                     "tokensIn": int(features["tokensIn"][index])})
    rows.sort(key=lambda row: (row["caseId"], row["order"]))
    return rows


def logits_by_case(rows: list[dict]) -> dict[str, dict[int, list[float]]]:
    out: dict[str, dict[int, list[float]]] = {}
    for row in rows:
        out.setdefault(row["caseId"], {})[int(row["order"])] = row["logits"]
    return out


def write_scores(path: Path, rows: list[dict]) -> str:
    write_jsonl(Path(path), rows)
    return sha256_file(Path(path))
