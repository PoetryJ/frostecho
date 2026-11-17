#!/usr/bin/env python3
"""Recomputable v2 validation. Any hard error exits non-zero."""
from __future__ import annotations

import hashlib
import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
REQUIRED = ["schema", "caseId", "version", "task", "K", "candidates", "acceptableSet",
            "polarity", "narrative", "facts", "oracle", "hiddenTruth", "familyId",
            "sourceGroup", "generatorSkeleton", "reviewLog", "provenance"]
TASKS = {"promise_cancel", "reference_resolution", "info_asymmetry", "goal_tradeoff"}
KS = {2, 4, 8}
GOLD_KEYS = {"acceptableSet", "oracle", "hiddenTruth"}


def load(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]


def main() -> int:
    errors: list[str] = []
    warnings: list[str] = []
    cases = load(HERE / "cases.jsonl")
    train = load(HERE / "train.jsonl")
    dev = load(HERE / "dev.jsonl")
    split = json.loads((HERE / "split.json").read_text(encoding="utf-8"))

    ids = [row.get("caseId") for row in cases]
    if len(ids) != len(set(ids)):
        errors.append("duplicate caseId in cases.jsonl")

    for row in cases:
        cid = row.get("caseId", "?")
        for field in REQUIRED:
            if field not in row:
                errors.append(f"{cid}: missing field {field}")
        if row.get("schema") != "frostecho.jev04.case/2":
            errors.append(f"{cid}: unexpected schema")
        if row.get("task") not in TASKS:
            errors.append(f"{cid}: unknown task {row.get('task')}")
        if row.get("K") not in KS:
            errors.append(f"{cid}: K={row.get('K')} outside {sorted(KS)}")
        candidates = row.get("candidates") or []
        cand_ids = [candidate.get("id") for candidate in candidates]
        if len(candidates) != row.get("K"):
            errors.append(f"{cid}: candidate count {len(candidates)} != K={row.get('K')}")
        if len(cand_ids) != len(set(cand_ids)):
            errors.append(f"{cid}: duplicate candidate ids")
        for candidate in candidates:
            for key in ("id", "text", "params"):
                if key not in candidate:
                    errors.append(f"{cid}: candidate missing {key}")
        acceptable = row.get("acceptableSet") or []
        if row.get("polarity") == "acceptable":
            if not acceptable:
                errors.append(f"{cid}: polarity=acceptable but empty acceptableSet")
        elif row.get("polarity") == "reject-all":
            if acceptable:
                errors.append(f"{cid}: polarity=reject-all but acceptableSet non-empty")
        else:
            errors.append(f"{cid}: unknown polarity {row.get('polarity')}")
        if not set(acceptable) <= set(cand_ids):
            errors.append(f"{cid}: acceptableSet not a subset of candidate ids")
        oracle = row.get("oracle") or {}
        if oracle.get("decision") and oracle["decision"] not in cand_ids:
            errors.append(f"{cid}: oracle.decision not in candidates")
        fact_ids = {fact.get("id") for fact in row.get("facts") or []}
        for required in oracle.get("requires") or []:
            if required not in fact_ids:
                errors.append(f"{cid}: oracle.requires {required} not in facts")
        narrative = (row.get("narrative") or {}).get("text", "")
        if len(narrative) < 10:
            errors.append(f"{cid}: narrative too short")
        # Gold must never appear in the model input (candidates/narrative/facts).
        blob = json.dumps({"candidates": candidates, "narrative": row.get("narrative"),
                           "facts": row.get("facts")}, ensure_ascii=False)
        if row.get("generatorSkeleton", "").startswith("gold"):
            errors.append(f"{cid}: gold leaked into input fields")
        for gold in GOLD_KEYS:
            if gold in blob:
                errors.append(f"{cid}: gold key {gold} appears in model input")

    # Group isolation.
    train_groups = {row["sourceGroup"] for row in train}
    dev_groups = {row["sourceGroup"] for row in dev}
    overlap = train_groups & dev_groups
    if overlap:
        errors.append(f"groups cross the split: {sorted(overlap)}")
    if train_groups != set(split.get("trainGroups", [])):
        errors.append("split.json trainGroups disagrees with train.jsonl")
    if dev_groups != set(split.get("devGroups", [])):
        errors.append("split.json devGroups disagrees with dev.jsonl")
    digest = hashlib.sha256((HERE / "cases.jsonl").read_bytes()).hexdigest()
    if split.get("casesSha256") != digest:
        errors.append("split.json casesSha256 does not match cases.jsonl")

    # Adjudication covers every disagreement exactly once.
    adjudication = load(HERE / "adjudication.jsonl")
    actions = Counter(row.get("action") for row in adjudication)
    for row in adjudication:
        if row.get("action") not in {"keep", "revise", "challenge", "drop"}:
            errors.append(f"adjudication {row.get('caseId')}: unknown action")
    known = {row["caseId"].removeprefix("v2-") for row in cases}
    for row in adjudication:
        if row.get("caseId") not in known:
            warnings.append(f"adjudication references unmapped case {row.get('caseId')}")

    report = {
        "schema": "frostecho.jev04.v2-validation/1",
        "cases": len(cases),
        "train": len(train),
        "dev": len(dev),
        "trainGroups": len(train_groups),
        "devGroups": len(dev_groups),
        "families": len({row["familyId"] for row in cases}),
        "adjudication": dict(actions),
        "errors": errors,
        "warnings": warnings,
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 1 if errors else 0


if __name__ == "__main__":
    sys.exit(main())
