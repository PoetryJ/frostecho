#!/usr/bin/env python3
"""Old C head vs the newly trained head on the same frozen test split.

Non-affine LayerNorm (eps 1e-5) then the shared bias-free score, exactly the
deployed path. Reports top-1 in acceptable set and set NLL per head.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

import numpy as np
from safetensors.numpy import load_file

EPS = 1e-5


def normalised(values: np.ndarray) -> np.ndarray:
    centered = values - values.mean(axis=-1, keepdims=True)
    variance = (centered ** 2).mean(axis=-1, keepdims=True)
    return centered / np.sqrt(variance + EPS)


def set_nll(logits: np.ndarray, acceptable: list[int]) -> float:
    top = logits.max()
    sub = logits[acceptable]
    sub_top = sub.max()
    return float(top + np.log(np.exp(logits - top).sum())
                 - sub_top - np.log(np.exp(sub - sub_top).sum()))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--corpus", required=True)
    parser.add_argument("--features-dir", required=True)
    parser.add_argument("--heads", nargs="+", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    corpus = {json.loads(line)["caseId"]: json.loads(line)
              for line in Path(args.corpus).read_text().splitlines() if line.strip()}
    directory = Path(args.features_dir)
    records = [json.loads(line) for line in
               (directory / "records.jsonl").read_text().splitlines() if line.strip()]
    with np.load(directory / "features.npz", allow_pickle=False) as data:
        vectors = data["cand"]
        offsets = data["rowOffsets"]
        case_ids = data["caseIds"].tolist()

    rows = []
    for head_path in args.heads:
        weights = load_file(head_path)["score.weight"].reshape(-1).astype(np.float64)
        per_split = {}
        for split in ("train", "dev", "test"):
            correct = 0
            losses = []
            used = 0
            for index, record in enumerate(records):
                if record["split"] != split:
                    continue
                source = corpus[record["caseId"]]
                acceptable_ids = source.get("acceptableIds") or []
                ids = [candidate["id"] for candidate in source["request"]["candidates"]]
                try:
                    acceptable = [ids.index(value) for value in acceptable_ids]
                except ValueError:
                    continue
                if not acceptable:
                    continue
                start = offsets[case_ids.index(record["caseId"])]
                row = vectors[start:start + len(ids)]
                logits = normalised(row) @ weights
                losses.append(set_nll(logits, acceptable))
                correct += int(int(np.argmax(logits)) in acceptable)
                used += 1
            per_split[split] = {
                "cases": used,
                "top1InAcceptable": (correct / used) if used else None,
                "setNll": float(np.mean(losses)) if losses else None,
            }
        rows.append({"head": Path(head_path).name, "path": head_path,
                     "splits": per_split})
    document = {"schema": "frostecho.r9.test-eval/1", "heads": rows,
                "note": "same frozen test split; weak labels from receipts/rules"}
    Path(args.out).write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({row["head"]: row["splits"]["test"] for row in rows}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
