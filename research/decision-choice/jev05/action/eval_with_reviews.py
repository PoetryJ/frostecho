#!/usr/bin/env python3
"""Score heads against the independent blind reviews, not against rule labels.

Only cases where both reviewers produced the same acceptable set are used.
Disagreements stay quarantined and are reported separately.
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
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
    parser.add_argument("--joined", required=True)
    parser.add_argument("--heads", nargs="+", required=True)
    parser.add_argument("--out", required=True)
    args = parser.parse_args()

    corpus = {json.loads(line)["caseId"]: json.loads(line)
              for line in Path(args.corpus).read_text().splitlines() if line.strip()}
    joined = json.loads(Path(args.joined).read_text())
    directory = Path(args.features_dir)
    records = {json.loads(line)["caseId"]: json.loads(line)
               for line in (directory / "records.jsonl").read_text().splitlines()
               if line.strip()}
    with np.load(directory / "features.npz", allow_pickle=False) as data:
        vectors = data["cand"]
        offsets = data["rowOffsets"]
        case_ids = data["caseIds"].tolist()

    agreed = [row for row in joined["rows"] if row["identical"]]
    quarantined = [row for row in joined["rows"] if not row["identical"]]
    per_head = []
    for head_path in args.heads:
        weights = load_file(head_path)["score.weight"].reshape(-1).astype(np.float64)
        correct = 0
        losses = []
        by_scenario = defaultdict(lambda: [0, 0, []])
        for row in agreed:
            real = row["realCaseId"]
            source = corpus[real]
            ids = [candidate["id"] for candidate in source["request"]["candidates"]]
            try:
                acceptable = [ids.index(value) for value in row["intersection"]]
            except ValueError:
                continue
            if not acceptable:
                continue
            start = offsets[case_ids.index(real)]
            logits = normalised(vectors[start:start + len(ids)]) @ weights
            hit = int(int(np.argmax(logits)) in acceptable)
            loss = set_nll(logits, acceptable)
            correct += hit
            losses.append(loss)
            bucket = by_scenario[row["scenario"]]
            bucket[0] += hit
            bucket[1] += 1
            bucket[2].append(loss)
        per_head.append({
            "head": Path(head_path).name,
            "path": head_path,
            "cases": len(losses),
            "top1InReviewedAcceptable": correct / len(losses) if losses else None,
            "setNll": float(np.mean(losses)) if losses else None,
            "byScenario": {name: {"cases": value[1],
                                  "top1": value[0] / value[1] if value[1] else None,
                                  "nll": float(np.mean(value[2])) if value[2] else None}
                           for name, value in sorted(by_scenario.items())},
        })

    document = {
        "schema": "frostecho.r9.review-eval/1",
        "labelSource": "two independent blind model reviews (agreed sets only)",
        "agreedCases": len(agreed),
        "quarantinedCases": len(quarantined),
        "quarantined": [{"scenario": row["scenario"], "caseId": row["publicId"],
                         "a": row["reviewA"], "b": row["reviewB"],
                         "jaccard": row["jaccard"]} for row in quarantined],
        "heads": per_head,
        "note": "denominator is the reviewers' agreed set, not the rule label",
    }
    Path(args.out).write_text(json.dumps(document, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({row["head"]: {"cases": row["cases"],
                                    "top1": row["top1InReviewedAcceptable"],
                                    "nll": row["setNll"]} for row in per_head}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
