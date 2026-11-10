#!/usr/bin/env python3
"""One-time unseal and metric computation for the three arms plus the JSON arm.

Scored unit is a case x presentation. The four presentations of a case are not
four independent player samples, so the report gives per-order denominators, a
worst-order figure and a family/group bootstrap instead of pretending n=1024.
Challenge cases (relayed present opinions with two defensible readings) are
excluded from the main denominator and also reported inside it.
"""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import j3config as R  # noqa: E402

J_PATTERN = re.compile(r'"selectedId"\s*:\s*"([A-D])"')


def parse_json(raw: str):
    match = J_PATTERN.search(raw or "")
    return match.group(1) if match else None


def bootstrap(rows: list[dict], key: str, iterations: int = 2000, seed: int = 20261110) -> dict:
    groups = sorted({row["groupId"] for row in rows})
    grouped = {group: [row for row in rows if row["groupId"] == group] for group in groups}
    rng = np.random.default_rng(seed)
    values = []
    for _ in range(iterations):
        picked = rng.choice(len(groups), size=len(groups), replace=True)
        sample = [row for index in picked for row in grouped[groups[index]]]
        values.append(sum(1 for row in sample if row[key]) / len(sample))
    array = np.array(values)
    return {"groups": len(groups), "lo": round(float(np.percentile(array, 2.5)), 6),
            "hi": round(float(np.percentile(array, 97.5)), 6)}


def summarise(rows: list[dict], label_fn) -> dict:
    """rows carry caseId, order, groupId, gold, prediction."""
    correct = [label_fn(row) for row in rows]
    per_order = {}
    for order in (0, 1, 2, 3):
        subset = [row for row, ok in zip(rows, correct) if row["order"] == order]
        oks = [ok for row, ok in zip(rows, correct) if row["order"] == order]
        per_order[str(order)] = {"n": len(subset),
                                 "correct": int(sum(oks)),
                                 "accuracy": round(sum(oks) / len(subset), 6) if subset else None}
    per_class = {}
    for cls in R.CLASSES:
        pairs = [(row, ok) for row, ok in zip(rows, correct) if row["gold"] == cls]
        hit = sum(1 for _, ok in pairs if ok)
        predicted = collections.Counter(row["prediction"] for row, _ in pairs)
        per_class[cls] = {"n": len(pairs), "correct": hit,
                          "recall": round(hit / len(pairs), 6) if pairs else None,
                          "predictedAs": dict(predicted)}
    f1 = {}
    for cls in R.CLASSES:
        true_positive = sum(1 for row, ok in zip(rows, correct) if row["gold"] == cls and ok)
        predicted_positive = sum(1 for row in rows if row["prediction"] == cls)
        actual = sum(1 for row in rows if row["gold"] == cls)
        precision = true_positive / predicted_positive if predicted_positive else 0.0
        recall = true_positive / actual if actual else 0.0
        f1[cls] = round(2 * precision * recall / (precision + recall), 6) if precision + recall else 0.0
    by_case: dict[str, list[bool]] = {}
    for row, ok in zip(rows, correct):
        by_case.setdefault(row["caseId"], []).append(ok)
    consistent = [all(all_ok for all_ok in flags) or all(not flag for flag in flags)
                  for flags in by_case.values()]
    all_same_prediction = {}
    for row in rows:
        all_same_prediction.setdefault(row["caseId"], set()).add(row["prediction"])
    consistency = sum(1 for values in all_same_prediction.values() if len(values) == 1)
    return {"n": len(rows), "cases": len(by_case), "correct": int(sum(correct)),
            "accuracy": round(sum(correct) / len(rows), 6),
            "worstOrder": min((value["accuracy"] for value in per_order.values()
                               if value["accuracy"] is not None), default=None),
            "perOrder": per_order, "perClass": per_class,
            "macroF1": round(sum(f1.values()) / len(f1), 6), "perClassF1": f1,
            "consistency": {"cases": len(all_same_prediction),
                            "allFourSamePrediction": consistency,
                            "rate": round(consistency / len(all_same_prediction), 6)},
            "bootstrap": bootstrap([{**row, "correct": ok} for row, ok in zip(rows, correct)],
                                   "correct")}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--attempt", type=int, default=1)
    parser.add_argument("--reason", default="")
    args = parser.parse_args(argv)
    marker = R.RESULTS / f"unseal-attempt-{args.attempt}.json"
    if marker.exists():
        raise SystemExit(f"unseal attempt {args.attempt} already exists")
    if args.attempt > 1 and not args.reason:
        raise SystemExit("a repeated scoring pass must state --reason")

    record = R.read_json(R.RESULTS / "unseal-record.json")
    scores_path = Path(record["scores"]["path"])
    if R.sha256_file(scores_path) != record["scores"]["sha256"]:
        raise SystemExit("test scores changed after they were sealed")
    marker.write_text(json.dumps({"schema": "frostecho.jev03.unseal-attempt/1",
                                  "attempt": args.attempt, "reason": args.reason,
                                  "at": R.now_iso(), "status": "started"}, ensure_ascii=False) + "\n",
                      encoding="utf-8")

    gold = R.read_json(R.gold_file())["gold"]
    challenge = {row["caseId"] for row in R.read_jsonl(R.DATA / "challenge.jsonl")}
    scores = R.read_jsonl(scores_path)
    rows = []
    for row in scores:
        case_id = row["caseId"]
        rows.append({"caseId": case_id, "order": row["order"], "arm": row["arm"],
                     "groupId": gold[case_id]["groupId"], "gold": gold[case_id]["labelId"],
                     "prediction": row["prediction"],
                     "challenged": case_id in challenge})

    result = {"schema": "frostecho.jev03.results/1", "at": R.now_iso(),
              "test": {"cases": len(gold), "scored": len(gold) - len(challenge),
                       "challenge": len(challenge), "presentations": len(scores)},
              "selection": R.read_json(R.RESULTS / "selection-seal.json")["selected"],
              "arms": {}, "sensitivity": {}, "paired": {}}
    scored = [row for row in rows if not row["challenged"]]
    everything = rows
    for arm in R.ARMS:
        arm_rows = [row for row in scored if row["arm"] == arm]
        result["arms"][arm] = summarise(arm_rows, lambda row: row["prediction"] == row["gold"])
        result["sensitivity"][arm] = summarise([row for row in everything if row["arm"] == arm],
                                               lambda row: row["prediction"] == row["gold"])

    # same-case JSON baseline
    json_rows = []
    raw = R.read_jsonl(R.RESULTS / "test-json-generations.jsonl")
    parsed = 0
    for row in raw:
        letter = parse_json(row["rawText"])
        order = int(row["order"])
        prediction = R.ORDERS[order][R.LETTERS.index(letter)] if letter else "UNPARSED"
        parsed += bool(letter)
        case_id = row["caseId"]
        if case_id in challenge:
            continue
        json_rows.append({"caseId": case_id, "order": order, "arm": "JSON",
                          "groupId": gold[case_id]["groupId"], "gold": gold[case_id]["labelId"],
                          "prediction": prediction})
    result["json"] = summarise(json_rows, lambda row: row["prediction"] == row["gold"])
    result["json"]["parseRate"] = round(parsed / len(raw), 6)
    result["json"]["generations"] = len(raw)

    # paired case-level comparison against M0
    by_case = collections.defaultdict(dict)
    for row in scored:
        by_case[row["caseId"]].setdefault(row["arm"], []).append(row["prediction"] == row["gold"])
    for arm in ("C", "Q"):
        only_m0 = sum(1 for case, values in by_case.items()
                      if all(not flag for flag in values[arm]) and all(values["M0"]))
        only_arm = sum(1 for case, values in by_case.items()
                       if all(values[arm]) and all(not flag for flag in values["M0"]))
        result["paired"][f"{arm}_vs_M0"] = {"casesAllWrongArmOnlyM0AllRight": only_m0,
                                            "casesAllRightArmOnlyM0AllWrong": only_arm,
                                            "cases": len(by_case)}
    marker.write_text(json.dumps({"schema": "frostecho.jev03.unseal-attempt/1",
                                  "attempt": args.attempt, "reason": args.reason,
                                  "at": R.now_iso(), "status": "completed"}, ensure_ascii=False) + "\n",
                      encoding="utf-8")
    R.write_json(R.RESULTS / "final.json", result)
    print(R.canonical({arm: {"acc": result["arms"][arm]["accuracy"],
                             "worst": result["arms"][arm]["worstOrder"],
                             "nc": result["arms"][arm]["perClass"]["NEEDS_CLARIFICATION"]["recall"]}
                       for arm in R.ARMS} | {"json": result["json"]["accuracy"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
