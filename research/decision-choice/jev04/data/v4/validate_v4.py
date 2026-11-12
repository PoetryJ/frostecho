#!/usr/bin/env python3
"""R4 (G6): v4 data gate — content binding and rejection, never trust caches.

This gate is deliberately NARROWER than a training admission: it verifies that
every case / review / label / split is bound to the exact bytes it claims, and
that tampering is rejected non-zero with the offending caseId and reason.
Semantic admission (512/128, two independent reviewers) is reported as
`blocked` in gate-v4.json — this environment has no second independent
reviewer, so no v4 review data is fabricated.

Inputs (defaults under this directory):
  cases.v4.jsonl        cases with caseId + contentHash + candidates
  review-s1.v4.jsonl    reviewer 1: caseId, contentHash, reviewVersion, label
  review-s2.v4.jsonl    reviewer 2 (independent)
  adjudication.v4.jsonl board: caseId, contentHash, label
  train.v4.jsonl / dev.v4.jsonl   projections of eligible cases

Exit codes: 0 all checks pass; 1 any hard failure (list is printed).
Run: python3 validate_v4.py [--dir DIR]
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

REVIEW_VERSION = "v4-review/1"
REQUIRED_TRAIN = 512
REQUIRED_DEV = 128


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in
            path.read_text(encoding="utf-8").splitlines() if line.strip()]


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def content_hash(case: dict) -> str:
    """Visible input only: question + observation + ordered candidate ids."""
    return sha256_text(canonical({
        "question": case.get("question"),
        "observation": case.get("observation"),
        "candidates": [candidate.get("id") for candidate in case.get("candidates", [])],
    }))


def check(dir_path: Path) -> tuple[list[str], dict]:
    failures: list[str] = []
    cases = {row["caseId"]: row for row in load_jsonl(dir_path / "cases.v4.jsonl")}
    s1 = {row["caseId"]: row for row in load_jsonl(dir_path / "review-s1.v4.jsonl")}
    s2 = {row["caseId"]: row for row in load_jsonl(dir_path / "review-s2.v4.jsonl")}
    adjudications = {row["caseId"]: row for row in
                     load_jsonl(dir_path / "adjudication.v4.jsonl")}
    train = load_jsonl(dir_path / "train.v4.jsonl")
    dev = load_jsonl(dir_path / "dev.v4.jsonl")
    summary = {"cases": len(cases), "s1": len(s1), "s2": len(s2),
               "adjudicated": len(adjudications), "train": len(train), "dev": len(dev)}

    for case_id, case in cases.items():
        actual = content_hash(case)
        declared = case.get("contentHash")
        if declared is not None and actual != declared:
            failures.append(f"{case_id}: content_hash_mismatch (case declares "
                            f"{str(declared)[:12]}, computed {actual[:12]})")
        candidate_ids = {candidate.get("id") for candidate in case.get("candidates", [])}
        for index, candidate in enumerate(case.get("candidates", [])):
            if not isinstance(candidate.get("id"), str) or not candidate["id"]:
                failures.append(f"{case_id}: candidate_{index}_missing_id")
        for reviewer, rows in (("s1", s1), ("s2", s2)):
            row = rows.get(case_id)
            if not row:
                failures.append(f"{case_id}: missing_review_{reviewer}")
                continue
            if row.get("reviewVersion") != REVIEW_VERSION:
                failures.append(f"{case_id}: {reviewer}_bad_review_version "
                                f"{row.get('reviewVersion')!r} != {REVIEW_VERSION!r}")
            if row.get("contentHash") != actual:
                failures.append(f"{case_id}: {reviewer}_hash_not_bound "
                                f"({str(row.get('contentHash'))[:12]} vs {actual[:12]})")
            label = row.get("label")
            if label is not None and label not in candidate_ids and label != "unanswerable":
                failures.append(f"{case_id}: {reviewer}_label_outside_candidates {label!r}")
        board = adjudications.get(case_id)
        if board:
            if board.get("contentHash") != actual:
                failures.append(f"{case_id}: adjudication_hash_not_bound")
            label = board.get("label")
            if label is not None and label not in candidate_ids and label != "unanswerable":
                failures.append(f"{case_id}: adjudication_label_outside_candidates {label!r}")

    for split_name, rows in (("train", train), ("dev", dev)):
        for row in rows:
            case_id = row.get("caseId")
            case = cases.get(case_id)
            if case is None:
                failures.append(f"{split_name}:{case_id}: case_not_in_cases")
                continue
            actual = content_hash(case)
            if row.get("contentHash") != actual:
                failures.append(f"{split_name}:{case_id}: split_hash_not_bound "
                                f"({str(row.get('contentHash'))[:12]} vs {actual[:12]})")
            if row.get("text") is not None and sha256_text(row["text"]) != actual:
                failures.append(f"{split_name}:{case_id}: train_text_differs_from_case")
    train_ids = {row.get("caseId") for row in train}
    dev_ids = {row.get("caseId") for row in dev}
    overlap = sorted(train_ids & dev_ids)
    if overlap:
        failures.append(f"split: overlap {overlap[:5]}")
    train_groups = {row.get("sourceGroup") for row in train if row.get("sourceGroup")}
    dev_groups = {row.get("sourceGroup") for row in dev if row.get("sourceGroup")}
    if train_groups & dev_groups:
        failures.append(f"split: group_overlap {sorted(train_groups & dev_groups)[:5]}")

    summary.update({
        "reviewVersion": REVIEW_VERSION,
        "trainCases": len(train), "devCases": len(dev),
        "requiredTrain": REQUIRED_TRAIN, "requiredDev": REQUIRED_DEV,
        "trainSourceGroups": len(train_groups), "devSourceGroups": len(dev_groups),
        "researchTrainReady": len(train) >= REQUIRED_TRAIN and len(dev) >= REQUIRED_DEV,
        "failures": failures[:40],
    })
    return failures, summary


def main() -> int:
    index = sys.argv.index("--dir") if "--dir" in sys.argv else -1
    dir_path = Path(sys.argv[index + 1]) if index != -1 else Path(__file__).resolve().parent
    failures, summary = check(dir_path)
    if failures:
        print(json.dumps({"ok": False, "dir": str(dir_path), "failures": failures,
                          "summary": summary}, ensure_ascii=False, indent=2))
        return 1
    print(json.dumps({"ok": True, "dir": str(dir_path), "summary": summary},
                     ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
