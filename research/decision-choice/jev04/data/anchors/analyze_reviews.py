#!/usr/bin/env python3
"""Compare the two blind review sessions with the frozen oracle.

Coverage defects (duplicate ids, missing ids) are reported as data problems, not
silently deduplicated into a clean-looking number.
"""
from __future__ import annotations

import collections
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def read(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def sets(rows: list[dict]) -> dict[str, set[str]]:
    return {row["caseId"]: set(row["labels"]) for row in rows}


def main() -> int:
    anchors = {row["caseId"]: row for row in read(HERE / "anchors.jsonl")}
    sessions = {"s1": read(HERE / "review-session-1.jsonl"),
                "s2": read(HERE / "review-session-2.jsonl")}
    report: dict = {"schema": "frostecho.jev04.anchor-review/1", "anchors": len(anchors), "sessions": {}}
    disagreements = []

    for name, rows in sessions.items():
        counts = collections.Counter(row["caseId"] for row in rows)
        duplicates = sorted(case_id for case_id, count in counts.items() if count > 1)
        missing = sorted(set(anchors) - set(counts))
        by_id = {}
        for row in rows:
            by_id.setdefault(row["caseId"], row)
        exact = subset = overlap_total = 0
        comparable = 0
        per_category = collections.defaultdict(lambda: {"n": 0, "exact": 0, "subset": 0})
        for case_id, anchor in anchors.items():
            predicted = by_id.get(case_id)
            if not predicted:
                continue
            comparable += 1
            oracle = set(anchor["acceptableSet"])
            guess = set(predicted["labels"])
            category = anchor["category"]
            per_category[category]["n"] += 1
            if guess == oracle:
                exact += 1
                per_category[category]["exact"] += 1
            if guess <= oracle:
                subset += 1
                per_category[category]["subset"] += 1
            overlap_total += len(guess & oracle) / len(guess | oracle) if guess | oracle else 0
            if guess != oracle:
                disagreements.append({"session": name, "caseId": case_id,
                  "category": category, "oracle": sorted(oracle), "reviewed": sorted(guess),
                  "control": anchor["control"],
                  "reviewRule": predicted.get("rule"), "confidence": predicted.get("confidence")})
        report["sessions"][name] = {
            "rows": len(rows), "uniqueIds": len(counts), "duplicates": duplicates,
            "missing": missing, "comparable": comparable,
            "exactSetMatch": exact, "exactRate": round(exact / comparable, 4) if comparable else None,
            "safeSubset": subset, "safeSubsetRate": round(subset / comparable, 4) if comparable else None,
            "meanJaccard": round(overlap_total / comparable, 4) if comparable else None,
            "perCategory": {key: {**value,
              "exactRate": round(value["exact"] / value["n"], 4) if value["n"] else None,
              "subsetRate": round(value["subset"] / value["n"], 4) if value["n"] else None}
              for key, value in per_category.items()},
        }

    common = set(sets(sessions["s1"])) & set(sets(sessions["s2"]))
    both = sets(sessions["s1"]), sets(sessions["s2"])
    agree = sum(1 for case_id in common if both[0][case_id] == both[1][case_id])
    report["interSession"] = {"commonIds": len(common), "exactAgreement": agree,
      "exactAgreementRate": round(agree / len(common), 4) if common else None}
    report["disagreementCount"] = len(disagreements)
    report["policy"] = "challenge/acceptable-set reviewed by H; no label is changed to fit a model"
    (HERE / "review-agreement.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (HERE / "review-disagreements.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in disagreements),
        encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
