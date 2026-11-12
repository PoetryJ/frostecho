#!/usr/bin/env python3
"""R5 (G6): v4 data gate — complete content binding and honest counts.

This is the ONLY qualification check the real training entry may call. It never
trusts `gate-v4.json` (an editable report): every run recomputes the hashes and
the eligibility of the current bytes.

Hard rejections (non-zero, caseId + reason):
  - duplicate case / review / adjudication / split ids;
  - a case contentHash that does not cover task/narrative/facts/candidate
    order, id, text, kind and params;
  - a review whose hash/version does not bind the current case;
  - a label outside the candidate/acceptable set;
  - a split row that is not an exact projection of an adjudicated case;
  - candidate semantics changed after review (hash mismatch);
  - repeated JSONL lines used to inflate 512/128;
  - sourceGroup or template family crossing train/dev;
  - an eligible case without two independent supported reviews.

Synthetic mechanism fixtures may pass STRUCTURE for self-tests, but they are
never counted and `researchTrainReady` stays false. Admission is reported, not
assumed.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

REVIEW_VERSION = "v4-review/1"
CASE_SCHEMA = "frostecho.jev04.case/4"
REQUIRED_TRAIN = 512
REQUIRED_DEV = 128
REVIEW_STATUSES = {"supported", "ambiguous", "inconsistent"}
ADJ_STATUSES = {"supported", "ambiguous", "inconsistent", "rejected"}


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in
            path.read_text(encoding="utf-8").splitlines() if line.strip()]


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def visible_input(case: dict) -> dict:
    """Everything the model can see, INCLUDING candidate text/kind/params."""
    return {
        "task": case.get("task"),
        "question": case.get("question"),
        "observation": case.get("observation"),
        "narrative": case.get("narrative"),
        "facts": case.get("facts") or [],
        "candidates": [
            {"id": candidate.get("id"), "text": candidate.get("text"),
             "kind": candidate.get("kind"), "params": candidate.get("params")}
            for candidate in case.get("candidates", [])
        ],
    }


def content_hash(case: dict) -> str:
    return sha256_text(canonical(visible_input(case)))


def _duplicates(rows: list[dict], key: str) -> list[str]:
    seen: set[str] = set()
    duplicate: set[str] = set()
    for row in rows:
        value = row.get(key)
        if not isinstance(value, str) or not value:
            continue
        if value in seen:
            duplicate.add(value)
        seen.add(value)
    return sorted(duplicate)


def _acceptable_ids(row: dict) -> list[str] | None:
    value = row.get("acceptableCandidateIds", row.get("acceptable"))
    if value is None:
        return None
    if not isinstance(value, list):
        return []
    return [str(entry) for entry in value]


def _status(row: dict) -> str | None:
    value = row.get("status")
    return value if isinstance(value, str) else None


def check(dir_path: Path) -> tuple[list[str], dict]:
    failures: list[str] = []
    case_rows = load_jsonl(dir_path / "cases.v4.jsonl")
    s1_rows = load_jsonl(dir_path / "review-s1.v4.jsonl")
    s2_rows = load_jsonl(dir_path / "review-s2.v4.jsonl")
    adjudication_rows = load_jsonl(dir_path / "adjudication.v4.jsonl")
    train = load_jsonl(dir_path / "train.v4.jsonl")
    dev = load_jsonl(dir_path / "dev.v4.jsonl")

    for label, rows, key in (("case", case_rows, "caseId"),
                             ("review-s1", s1_rows, "caseId"),
                             ("review-s2", s2_rows, "caseId"),
                             ("adjudication", adjudication_rows, "caseId"),
                             ("train", train, "caseId"),
                             ("dev", dev, "caseId")):
        duplicates = _duplicates(rows, key)
        if duplicates:
            failures.append(f"{label}: duplicate_ids {duplicates[:5]}")

    cases = {row["caseId"]: row for row in case_rows
             if isinstance(row.get("caseId"), str)}
    s1 = {row["caseId"]: row for row in s1_rows if isinstance(row.get("caseId"), str)}
    s2 = {row["caseId"]: row for row in s2_rows if isinstance(row.get("caseId"), str)}
    boards = {row["caseId"]: row for row in adjudication_rows
              if isinstance(row.get("caseId"), str)}

    reviewers = {str(row.get("reviewer")) for row in s1_rows + s2_rows
                 if row.get("reviewer")}
    independent = bool(s1_rows and s2_rows and len(reviewers) >= 2
                       and all(row.get("independent") is True for row in s1_rows + s2_rows))

    for case_id, case in cases.items():
        actual = content_hash(case)
        declared = case.get("contentHash")
        if declared is not None and actual != declared:
            failures.append(f"{case_id}: content_hash_mismatch (case declares "
                            f"{str(declared)[:12]}, computed {actual[:12]})")
        candidates = case.get("candidates") or []
        candidate_ids = [candidate.get("id") for candidate in candidates]
        if len(candidate_ids) != len(set(candidate_ids)):
            failures.append(f"{case_id}: duplicate_candidate_ids")
        if isinstance(case.get("K"), int) and case["K"] != len(candidates):
            failures.append(f"{case_id}: K_mismatch ({case['K']} != {len(candidates)})")
        for index, candidate in enumerate(candidates):
            if not isinstance(candidate.get("id"), str) or not candidate["id"]:
                failures.append(f"{case_id}: candidate_{index}_missing_id")
            if not isinstance(candidate.get("text"), str) or not candidate["text"]:
                # Synthetic self-test fixtures may omit text; formal cases may not.
                if not case.get("synthetic"):
                    failures.append(f"{case_id}: candidate_{index}_missing_text")
            if not isinstance(candidate.get("kind", case.get("task")), str):
                failures.append(f"{case_id}: candidate_{index}_missing_kind")
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
            status = _status(row)
            if status is not None and status not in REVIEW_STATUSES:
                failures.append(f"{case_id}: {reviewer}_bad_status {status!r}")
            acceptable = _acceptable_ids(row)
            if acceptable is not None:
                for candidate_id in acceptable:
                    if candidate_id not in candidate_ids and candidate_id != "unanswerable":
                        failures.append(f"{case_id}: {reviewer}_acceptable_outside_candidates "
                                        f"{candidate_id!r}")
                if len(acceptable) != len(set(acceptable)):
                    failures.append(f"{case_id}: {reviewer}_duplicate_acceptable")
            label = row.get("label")
            if label is not None and label not in candidate_ids and label != "unanswerable":
                failures.append(f"{case_id}: {reviewer}_label_outside_candidates {label!r}")
        board = boards.get(case_id)
        if board:
            if board.get("reviewVersion") not in (None, REVIEW_VERSION):
                failures.append(f"{case_id}: adjudication_bad_review_version")
            if board.get("contentHash") != actual:
                failures.append(f"{case_id}: adjudication_hash_not_bound")
            status = board.get("status")
            if status is not None and status not in ADJ_STATUSES:
                failures.append(f"{case_id}: adjudication_bad_status {status!r}")
            acceptable = _acceptable_ids(board)
            if acceptable is not None:
                for candidate_id in acceptable:
                    if candidate_id not in candidate_ids and candidate_id != "unanswerable":
                        failures.append(f"{case_id}: adjudication_acceptable_outside_candidates "
                                        f"{candidate_id!r}")
            label = board.get("label")
            if label is not None and label not in candidate_ids and label != "unanswerable":
                failures.append(f"{case_id}: adjudication_label_outside_candidates {label!r}")

    # Exact projection + split isolation. Duplicate split rows are already
    # rejected above; here we bind every row and compute unique counts.
    qualified_train: set[str] = set()
    qualified_dev: set[str] = set()
    for split_name, rows, qualified in (("train", train, qualified_train),
                                        ("dev", dev, qualified_dev)):
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
            if row.get("text") is not None and row.get("text") != canonical(visible_input(case)):
                failures.append(f"{split_name}:{case_id}: train_text_differs_from_case")
            candidates = [candidate.get("id") for candidate in case.get("candidates", [])]
            acceptable = _acceptable_ids(row)
            if acceptable is not None:
                for candidate_id in acceptable:
                    if candidate_id not in candidates and candidate_id != "unanswerable":
                        failures.append(f"{split_name}:{case_id}: acceptable_not_in_case "
                                        f"{candidate_id!r}")
            label = row.get("label")
            if label is not None:
                if label not in candidates and label != "unanswerable":
                    failures.append(f"{split_name}:{case_id}: illegal_label {label!r}")
                if label != "unanswerable" and acceptable is not None \
                        and label not in acceptable:
                    failures.append(f"{split_name}:{case_id}: label_not_in_acceptable")
            board = boards.get(case_id)
            if not board:
                failures.append(f"{split_name}:{case_id}: unadjudicated_case_in_split")
                continue
            if board.get("status") is None:
                # Synthetic mechanism fixture: structurally valid, never counted.
                continue
            if board.get("status") != "supported" or board.get("eligible") is not True:
                failures.append(f"{split_name}:{case_id}: case_not_eligible")
                continue
            if board.get("contentHash") != actual:
                failures.append(f"{split_name}:{case_id}: adjudication_binding_changed")
                continue
            if case.get("synthetic") is True:
                # Mechanism fixtures are structurally testable but never counted.
                continue
            if not independent:
                continue
            row_a, row_b = s1.get(case_id), s2.get(case_id)
            if not row_a or not row_b:
                failures.append(f"{split_name}:{case_id}: missing_independent_review")
                continue
            if _status(row_a) != "supported" or _status(row_b) != "supported":
                failures.append(f"{split_name}:{case_id}: reviewer_not_supported")
                continue
            set_a = _acceptable_ids(row_a)
            set_b = _acceptable_ids(row_b)
            if set_a is None or set_b is None or set(set_a) != set(set_b):
                failures.append(f"{split_name}:{case_id}: acceptable_sets_disagree")
                continue
            board_acceptable = _acceptable_ids(board)
            if board_acceptable is not None and set(board_acceptable) != set(set_a):
                failures.append(f"{split_name}:{case_id}: adjudication_acceptable_disagrees")
                continue
            qualified.add(case_id)

    train_ids = {row.get("caseId") for row in train}
    dev_ids = {row.get("caseId") for row in dev}
    overlap = sorted(train_ids & dev_ids)
    if overlap:
        failures.append(f"split: overlap {overlap[:5]}")
    train_groups = {row.get("sourceGroup") for row in train if row.get("sourceGroup")}
    dev_groups = {row.get("sourceGroup") for row in dev if row.get("sourceGroup")}
    if train_groups & dev_groups:
        failures.append(f"split: group_overlap {sorted(train_groups & dev_groups)[:5]}")
    train_families = {row.get("templateFamily") for row in train if row.get("templateFamily")}
    dev_families = {row.get("templateFamily") for row in dev if row.get("templateFamily")}
    if train_families & dev_families:
        failures.append(f"split: family_overlap {sorted(train_families & dev_families)[:5]}")

    mixed_synthetic = False
    for rows in (train, dev):
        flags = {cases.get(row.get("caseId"), {}).get("synthetic") is True for row in rows}
        if len(flags) > 1:
            mixed_synthetic = True
    if mixed_synthetic:
        failures.append("split: synthetic_mixed_with_formal")

    qualified_train = {case_id for case_id in qualified_train
                       if cases.get(case_id, {}).get("synthetic") is not True}
    qualified_dev = {case_id for case_id in qualified_dev
                     if cases.get(case_id, {}).get("synthetic") is not True}
    ready = (not failures and independent and len(qualified_train) >= REQUIRED_TRAIN
             and len(qualified_dev) >= REQUIRED_DEV)

    summary = {
        "cases": len(cases),
        "s1": len(s1),
        "s2": len(s2),
        "adjudicated": len(boards),
        "trainRows": len(train),
        "devRows": len(dev),
        "uniqueTrainRows": len({row.get("caseId") for row in train}),
        "uniqueDevRows": len({row.get("caseId") for row in dev}),
        "reviewVersion": REVIEW_VERSION,
        "independentReviewers": independent,
        "qualifiedTrain": len(qualified_train),
        "qualifiedDev": len(qualified_dev),
        "requiredTrain": REQUIRED_TRAIN,
        "requiredDev": REQUIRED_DEV,
        "trainSourceGroups": len(train_groups), "devSourceGroups": len(dev_groups),
        "researchTrainReady": ready,
        "failures": failures[:40],
    }
    return failures, summary


def main() -> int:
    index = sys.argv.index("--dir") if "--dir" in sys.argv else -1
    dir_path = Path(sys.argv[index + 1]) if index != -1 else Path(__file__).resolve().parent
    failures, summary = check(dir_path)
    payload = {"ok": not failures, "dir": str(dir_path), "summary": summary}
    if failures:
        payload["failures"] = failures
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
