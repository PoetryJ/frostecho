#!/usr/bin/env python3
"""Recompute JEV-03R1 with two separate pair metrics.

Old report collapsed both into one stress number ("8/8 correct"). This script
reports:
  1. per-order pair both-correct: for each presentation order independently,
     a pair counts only when both members are correct in that order;
  2. four-order stress: a pair counts only when all 8 presentations are correct.

Also reports a read-only sensitivity with the 5 derived gold corrections
(gold-corrections.json). Original rows are never rewritten.
"""
from __future__ import annotations

import collections
import hashlib
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
JEV03 = ROOT / "research/decision-choice/jev03"
BEHAVIOR = JEV03 / "behavior"
CASES = BEHAVIOR / "cases.jsonl"
PAIRS = BEHAVIOR / "pairs.json"
SCORES = BEHAVIOR / "results/scores.jsonl"
GENERATIONS = BEHAVIOR / "results/generations.jsonl"
CORRECTIONS = HERE / "corrections/gold-corrections.json"
OUT = HERE / "recomputed.json"

sys.path.insert(0, str(JEV03))
sys.path.insert(0, str(BEHAVIOR))
import j3config as R3  # noqa: E402

PATTERN = re.compile(r'"selectedId"\s*:\s*"([A-D])"')


def read_jsonl(path: Path) -> list[dict]:
    rows = []
    with path.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                rows.append(json.loads(line))
    return rows


def rate(num: int, den: int) -> float | None:
    return round(num / den, 4) if den else None


def main() -> int:
    cases = {row["caseId"]: row for row in read_jsonl(CASES)}
    pairs_doc = json.loads(PAIRS.read_text(encoding="utf-8"))
    pairs = pairs_doc["pairs"] if "pairs" in pairs_doc else pairs_doc
    rows = read_jsonl(SCORES)
    corrections = json.loads(CORRECTIONS.read_text(encoding="utf-8"))["corrections"]
    corrected_gold = {c["caseId"]: c["correctedGold"] for c in corrections}

    json_invalid = 0
    json_rows = []
    if GENERATIONS.exists():
        for row in read_jsonl(GENERATIONS):
            order = int(row["order"])
            match = PATTERN.search(row.get("rawText") or "")
            if not match:
                json_invalid += 1
                continue
            json_rows.append({"arm": "JSON", "caseId": row["caseId"], "order": order,
                              "prediction": R3.ORDERS[order][R3.LETTERS.index(match.group(1))]})

    by_arm = collections.defaultdict(list)
    for row in rows:
        by_arm[row["arm"]].append(row)
    if json_rows:
        by_arm["JSON"].extend(json_rows)

    arms = {}
    for arm in sorted(by_arm):
        arm_rows = by_arm[arm]
        # correctness keyed (caseId, order)
        correct = {}
        correct_fixed = {}
        for row in arm_rows:
            gold = cases[row["caseId"]]["labelId"]
            correct[(row["caseId"], row["order"])] = row["prediction"] == gold
            gold_fixed = corrected_gold.get(row["caseId"], gold)
            correct_fixed[(row["caseId"], row["order"])] = row["prediction"] == gold_fixed

        per_order = {}
        for order in range(4):
            per_order[order] = {
                "n": sum(1 for r in arm_rows if r["order"] == order),
                "correct": sum(1 for r in arm_rows if r["order"] == order and correct[(r["caseId"], order)]),
            }
            per_order[order]["accuracy"] = rate(per_order[order]["correct"], per_order[order]["n"])

        pair_stats = {"perOrderBothCorrect": {o: 0 for o in range(4)},
                       "fourOrderStress": 0, "flip": {"perOrderBothCorrect": {o: 0 for o in range(4)},
                                                      "fourOrderStress": 0}}
        for pair_id, pair in pairs.items():
            members = [m["caseId"] for m in pair["members"]]
            if pair["relation"] == "flip":
                for order in range(4):
                    if all(correct[(c, order)] for c in members):
                        pair_stats["flip"]["perOrderBothCorrect"][order] += 1
                        pair_stats["perOrderBothCorrect"][order] += 1
                if all(correct[(c, o)] for c in members for o in range(4)):
                    pair_stats["flip"]["fourOrderStress"] += 1
                    pair_stats["fourOrderStress"] += 1

        flip_pairs = sum(1 for p in pairs.values() if p["relation"] == "flip")
        inv_pairs = sum(1 for p in pairs.values() if p["relation"] != "flip")
        total = len(arm_rows)
        base_correct = sum(1 for k, ok in correct.items() if ok)
        fixed_correct = sum(1 for k, ok in correct_fixed.items() if ok)

        arms[arm] = {
            "n": total,
            "accuracy": rate(base_correct, total),
            "perOrder": per_order,
            "pairMetric": {
                "pairs": flip_pairs,
                "perOrderBothCorrect": pair_stats["flip"]["perOrderBothCorrect"],
                "perOrderBothCorrectRate": {o: rate(v, flip_pairs)
                                            for o, v in pair_stats["flip"]["perOrderBothCorrect"].items()},
                "fourOrderStress": pair_stats["flip"]["fourOrderStress"],
                "fourOrderStressRate": rate(pair_stats["flip"]["fourOrderStress"], flip_pairs),
                "invariantPairs": inv_pairs,
            },
            "sensitivityWith5Corrections": {
                "corrections": len(corrections),
                "correctRows": fixed_correct,
                "accuracy": rate(fixed_correct, total),
                "deltaRows": fixed_correct - base_correct,
            },
        }

    payload = {
        "schema": "frostecho.jev04.closeout-recompute/1",
        "source": {
            "cases": str(CASES.relative_to(ROOT)),
            "pairs": str(PAIRS.relative_to(ROOT)),
            "scores": str(SCORES.relative_to(ROOT)),
            "scoresSha256": hashlib.sha256(SCORES.read_bytes()).hexdigest(),
            "generations": str(GENERATIONS.relative_to(ROOT)),
            "generationsSha256": hashlib.sha256(GENERATIONS.read_bytes()).hexdigest(),
            "jsonInvalidGenerations": json_invalid,
        },
        "definitions": {
            "perOrderBothCorrect": "pair counts only if both members correct within one fixed presentation order",
            "fourOrderStress": "pair counts only if both members correct in all four presentation orders (8 rows)",
            "sensitivity": "only derived; original gold/predictions untouched",
        },
        "arms": arms,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for arm, value in arms.items():
        print(arm, "acc", value["accuracy"],
              "perOrder", value["pairMetric"]["perOrderBothCorrect"],
              "stress", value["pairMetric"]["fourOrderStress"], "/", value["pairMetric"]["pairs"],
              "fixed", value["sensitivityWith5Corrections"]["correctRows"], "/", value["n"])
    print(f"wrote {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
