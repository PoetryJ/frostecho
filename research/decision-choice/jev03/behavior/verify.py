#!/usr/bin/env python3
"""Independent recompute (read-only). Plain Python, no project scorer.

Recomputes accuracy, worst order, per-class recall and the pair metrics from the
raw scores and the sealed gold/pairs, then compares them with metrics.json and
checks the artefact hashes and the job ledger. Writes nothing.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import j3config as R3  # noqa: E402
from store import JobStore  # noqa: E402

CLASSES = ["PLAYER_FIRST", "NPC_FIRST", "NO_PRIORITY_REQUEST", "NEEDS_CLARIFICATION"]


def main() -> int:
    failures: list[str] = []
    gold_doc = R3.read_json(HERE / "gold.json")
    gold = gold_doc["gold"]
    if R3.sha256_json(gold) != gold_doc["sha256"]:
        failures.append("gold self-hash mismatch")
    pairs_doc = R3.read_json(HERE / "pairs.json")
    pairs = pairs_doc["pairs"]
    if R3.sha256_json(pairs) != pairs_doc["sha256"]:
        failures.append("pairs self-hash mismatch")

    scores_meta = R3.read_json(HERE / "results" / "scores-meta.json")
    if R3.sha256_file(HERE / "results" / "scores.jsonl") != scores_meta["sha256"]:
        failures.append("scores changed after they were written")
    gen_meta = R3.read_json(HERE / "results" / "generations-meta.json")
    if R3.sha256_file(HERE / "results" / "generations.jsonl") != gen_meta["sha256"]:
        failures.append("generations changed after they were written")

    plan = R3.read_json(HERE / "plan.json")
    store = JobStore(HERE / "evidence", plan["campaign"], plan["protocolSha"])
    summary = store.summary()
    if summary["reserved"] != 1552 or summary["finished"] != 1552:
        failures.append(f"job ledger incomplete: {summary['reserved']}/{summary['finished']}")
    if not summary["complete"]:
        failures.append("job store reports incomplete")
    buckets = store.recover()
    if buckets["unresolved"] or buckets["corrupt"]:
        failures.append(f"recovery found {len(buckets['unresolved'])} unresolved / "
                        f"{len(buckets['corrupt'])} corrupt jobs")

    scores = R3.read_jsonl(HERE / "results" / "scores.jsonl")
    if len(scores) != 768 * 3:
        failures.append(f"{len(scores)} score rows, expected {768 * 3}")
    rows: dict[str, list[dict]] = {}
    for row in scores:
        case = row["caseId"]
        if case not in gold:
            failures.append(f"score for unknown case {case}")
            continue
        best = max(range(4), key=lambda index: row["logits"][index])
        if CLASSES[best] != row["prediction"]:
            failures.append(f"{case}/{row['order']}/{row['arm']}: argmax disagrees")
        rows.setdefault(row["arm"], []).append({"caseId": case, "order": row["order"],
                                                "label": gold[case],
                                                "prediction": row["prediction"]})
    recomputed = {}
    metrics = R3.read_json(HERE / "results" / "metrics.json")["arms"]
    for arm, items in rows.items():
        correct = [item["prediction"] == item["label"] for item in items]
        per_order = {str(order): round(sum(1 for item, ok in zip(items, correct)
                                           if item["order"] == order and ok)
                                       / sum(1 for item in items if item["order"] == order), 4)
                     for order in range(4)}
        per_class = {}
        for cls in CLASSES:
            subset = [ok for item, ok in zip(items, correct) if item["label"] == cls]
            per_class[cls] = round(sum(subset) / len(subset), 4)
        by_case: dict[str, list[bool]] = {}
        for item, ok in zip(items, correct):
            by_case.setdefault(item["caseId"], []).append(ok)
        flip = invariant = flip_ok = inv_ok = 0
        for pair in pairs.values():
            a, b = pair["members"][0]["caseId"], pair["members"][1]["caseId"]
            both = bool(all(by_case[a]) and all(by_case[b]))
            if pair["relation"] == "flip":
                flip += 1
                flip_ok += both
            else:
                invariant += 1
                inv_ok += both
        value = {"accuracy": round(sum(correct) / len(correct), 4),
                 "worstOrder": min(per_order.values()), "perOrder": per_order,
                 "perClass": per_class,
                 "flipBothCorrectRate": round(flip_ok / flip, 4),
                 "invariantBothCorrectRate": round(inv_ok / invariant, 4)}
        recomputed[arm] = value
        reported = metrics[arm]
        if abs(value["accuracy"] - reported["accuracy"]) > 1e-6:
            failures.append(f"{arm}: accuracy {value['accuracy']} != {reported['accuracy']}")
        if abs(value["worstOrder"] - reported["worstOrder"]) > 1e-6:
            failures.append(f"{arm}: worst order differs")
        if abs(value["flipBothCorrectRate"] - reported["pairs"]["flipBothCorrectRate"]) > 1e-6:
            failures.append(f"{arm}: flip pair rate differs")
        if abs(value["invariantBothCorrectRate"]
               - reported["pairs"]["invariantBothCorrectRate"]) > 1e-6:
            failures.append(f"{arm}: invariant pair rate differs")
        for cls, recall in value["perClass"].items():
            if abs(recall - reported["perClass"][cls]["recall"]) > 1e-6:
                failures.append(f"{arm}: {cls} recall differs")

    payload = {"schema": "frostecho.jev03r1.verify/1", "failures": failures,
               "recomputed": recomputed, "jobs": {key: summary[key] for key in
                                                  ("reserved", "finished", "results",
                                                   "generationJobs", "complete")},
               "passes": not failures}
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
