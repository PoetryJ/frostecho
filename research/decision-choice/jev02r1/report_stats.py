#!/usr/bin/env python3
"""Descriptive statistics for the report: per order/class/family accuracy, family
bootstrap intervals, and the S1/S2 mechanism comparison on the unsealed test.

Nothing here feeds back into a policy: the policies were frozen before unsealing.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import numpy as np

import r1config as R
from evalr1 import rows_for_order
from policy import load_policy
from r1config import CLASSES, ORDERS, PAIR, RESULTS, SINGLE, read_json, read_jsonl

J_PATTERN = re.compile(r'^\s*\{\s*"selectedId"\s*:\s*"([A-D])"\s*\}\s*(<\|im_end\|>)?\s*$')


def bootstrap(rows: list[dict], iterations: int = 2000, seed: int = 20261110) -> dict:
    """Resample source families, never presentations."""
    families = sorted({row["family"] for row in rows})
    grouped = {family: [row for row in rows if row["family"] == family] for family in families}
    rng = np.random.default_rng(seed)
    values = []
    for _ in range(iterations):
        picked = rng.choice(len(families), size=len(families), replace=True)
        sample = [row for index in picked for row in grouped[families[index]]]
        values.append(sum(1 for row in sample if row["correct"]) / len(sample))
    array = np.array(values)
    return {"families": len(families), "iterations": iterations,
            "lo": round(float(np.percentile(array, 2.5)), 6),
            "hi": round(float(np.percentile(array, 97.5)), 6),
            "median": round(float(np.median(array)), 6)}


def describe(rows: list[dict]) -> dict:
    def rate(subset):
        return round(sum(1 for row in subset if row["correct"]) / len(subset), 6) if subset else None

    per_order = {str(order): {"correct": sum(1 for row in rows if row["order"] == order and row["correct"]),
                              "n": sum(1 for row in rows if row["order"] == order)}
                 for order in sorted({row["order"] for row in rows})}
    for value in per_order.values():
        value["accuracy"] = round(value["correct"] / value["n"], 6) if value["n"] else None
    per_class = {}
    for cls in CLASSES:
        subset = [row for row in rows if row["label"] == cls]
        per_class[cls] = {"correct": sum(1 for row in subset if row["correct"]), "n": len(subset),
                          "recall": rate(subset)}
    per_family = {}
    for family in sorted({row["family"] for row in rows}):
        subset = [row for row in rows if row["family"] == family]
        per_family[family] = {"correct": sum(1 for row in subset if row["correct"]), "n": len(subset),
                              "accuracy": rate(subset)}
    return {"correct": sum(1 for row in rows if row["correct"]), "n": len(rows),
            "accuracy": rate(rows), "perOrder": per_order, "perClass": per_class,
            "perFamily": per_family, "bootstrap": bootstrap(rows)}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(RESULTS / "report-stats.json"))
    args = parser.parse_args(argv)
    gold = read_json(R.DATA / "test.gold.json")["gold"]
    scores = read_jsonl(RESULTS / "test-scores.jsonl")
    by_case: dict[str, dict[int, list[float]]] = {}
    for row in scores:
        by_case.setdefault(row["caseId"], {})[int(row["order"])] = row["logits"]

    policy = load_policy(R.POLICIES / f"{SINGLE}.json", check_files=False)
    pair_policy = load_policy(R.POLICIES / f"{PAIR}.json", check_files=False)

    m1_rows = []
    for case_id, logits in by_case.items():
        for order, value in rows_for_order(policy, logits).items():
            candidate = max(value["probs"], key=value["probs"].get)
            m1_rows.append({"caseId": case_id, "order": order, "family": gold[case_id]["family"],
                            "label": gold[case_id]["labelId"], "candidateId": candidate,
                            "correct": candidate == gold[case_id]["labelId"]})

    json_rows = []
    for row in read_jsonl(RESULTS / "test-json-generations.jsonl"):
        match = J_PATTERN.match(row["rawText"])
        order = int(row["order"])
        candidate = ORDERS[order][R.LETTERS.index(match.group(1))] if match else None
        label = gold[row["caseId"]]["labelId"]
        json_rows.append({"caseId": row["caseId"], "order": order,
                          "family": gold[row["caseId"]]["family"], "label": label,
                          "candidateId": candidate, "correct": candidate == label,
                          "parsed": bool(match)})

    pair_rows = []
    for case_id, logits in by_case.items():
        for order, value in rows_for_order(pair_policy, logits).items():
            pair_rows.append({"caseId": case_id, "order": order,
                              "family": gold[case_id]["family"], "label": gold[case_id]["labelId"],
                              "candidateId": value["candidateId"],
                              "agree": value.get("agree", True),
                              "score": value.get("score", 0.0),
                              "correct": value["candidateId"] == gold[case_id]["labelId"]})

    agreed = [row for row in pair_rows if row["agree"]]
    payload = {
        "schema": "frostecho.jev02r1.report-stats/1",
        "at": R.now_iso(),
        "test": {"cases": len(gold), "families": len({v["family"] for v in gold.values()})},
        "m1FourOrders": describe(m1_rows),
        "m1Order0": describe([row for row in m1_rows if row["order"] == 0]),
        "jsonFourOrders": describe(json_rows),
        "jsonOrder0": describe([row for row in json_rows if row["order"] == 0]),
        "s2Consensus": {
            "pairs": len(pair_rows), "agreed": len(agreed),
            "agreementRate": round(len(agreed) / len(pair_rows), 6),
            "accuracyAmongAgreed": round(sum(1 for row in agreed if row["correct"]) / len(agreed), 6)
            if agreed else None,
            "describeAgreed": describe(agreed),
            "note": "consensus view: disagreement abstains, so coverage is capped by agreement",
        },
        "unsealedPolicies": {SINGLE: policy["valid"], PAIR: pair_policy["valid"]},
    }
    R.write_json(Path(args.out), payload)
    print(json.dumps({"m1": payload["m1FourOrders"]["accuracy"],
                      "json": payload["jsonFourOrders"]["accuracy"],
                      "agreement": payload["s2Consensus"]["agreementRate"],
                      "agreedAcc": payload["s2Consensus"]["accuracyAmongAgreed"]}, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
