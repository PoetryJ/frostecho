#!/usr/bin/env python3
"""Same-case comparison on the presentations where both the heads and the JSON
arm have an output.

The JSON arm lost 51 cases to the budget-guard abort (see results/REPORT.md); the
head arms cover all 246 scored cases. Comparing 92.9% (246 cases) with 76.1%
(205 cases) would mix two different case sets, so this script restricts every arm
to the cases that have all four JSON presentations.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import j3config as R  # noqa: E402

PATTERN = re.compile(r'"selectedId"\s*:\s*"([A-D])"')


def main() -> int:
    gold = R.read_json(R.gold_file())["gold"]
    challenge = {row["caseId"] for row in R.read_jsonl(R.DATA / "challenge.jsonl")}
    generations = R.read_jsonl(R.RESULTS / "test-json-generations.jsonl")
    have = {}
    parsed = {}
    for row in generations:
        key = (row["caseId"], int(row["order"]))
        have.setdefault(row["caseId"], set()).add(int(row["order"]))
        match = PATTERN.search(row["rawText"] or "")
        parsed[key] = R.ORDERS[int(row["order"])][R.LETTERS.index(match.group(1))] if match else None
    common = {case for case, orders in have.items()
              if orders == {0, 1, 2, 3} and case not in challenge}
    scores = R.read_jsonl(R.RESULTS / "test-scores.jsonl")
    result = {"schema": "frostecho.jev03.matched/1", "at": R.now_iso(),
              "cases": len(common), "presentations": 4 * len(common),
              "note": "every arm restricted to cases with all four JSON presentations", "arms": {}}
    for arm in R.ARMS:
        rows = [row for row in scores if row["arm"] == arm and row["caseId"] in common]
        result["arms"][arm] = {"n": len(rows),
                               "accuracy": round(sum(1 for row in rows
                                                     if row["prediction"] == gold[row["caseId"]]["labelId"])
                                                 / len(rows), 6)}
    rows = []
    for (case, order), prediction in parsed.items():
        if case in common:
            rows.append({"caseId": case, "order": order, "prediction": prediction,
                         "gold": gold[case]["labelId"]})
    result["arms"]["JSON"] = {"n": len(rows),
                              "accuracy": round(sum(1 for row in rows
                                                    if row["prediction"] == row["gold"]) / len(rows), 6),
                              "unparsed": sum(1 for row in rows if row["prediction"] is None)}
    R.write_json(R.RESULTS / "matched.json", result)
    print(R.canonical({arm: round(value["accuracy"], 4) for arm, value in result["arms"].items()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
