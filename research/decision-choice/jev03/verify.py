#!/usr/bin/env python3
"""Read-only independent verification of the sealed JEV-03 results.

Recomputes every reported number from the raw scores, the sealed selection and
the gold file, using plain Python (no project scorer), and checks the hashes that
were recorded before unsealing. Writes nothing.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import j3config as R  # noqa: E402

CLASSES = R.CLASSES


def accuracy(rows: list[dict]) -> float:
    return round(sum(1 for row in rows if row["prediction"] == row["gold"]) / len(rows), 6)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results", default=str(R.RESULTS))
    args = parser.parse_args(argv)
    out = Path(args.results)
    failures: list[str] = []

    record = R.read_json(out / "unseal-record.json")
    scores_path = Path(record["scores"]["path"])
    if R.sha256_file(scores_path) != record["scores"]["sha256"]:
        failures.append("test-scores.jsonl hash differs from the sealed record")
    if R.sha256_file(out / "test-predictions.jsonl") != record["predictions"]["sha256"]:
        failures.append("test-predictions.jsonl hash differs from the sealed record")
    if R.read_json(out / "selection-seal.json")["goldSha256"] != R.sha256_file(R.gold_file()):
        failures.append("gold changed after the selection seal")
    if record.get("goldSealControl") != "blocked:GoldBlocked":
        failures.append("the prediction pass did not positively prove the gold block")

    gold = R.read_json(R.gold_file())["gold"]
    if R.sha256_json(gold) != R.read_json(R.gold_file())["sha256"]:
        failures.append("gold self-hash mismatch")
    challenge = {row["caseId"] for row in R.read_jsonl(R.DATA / "challenge.jsonl")}
    scores = R.read_jsonl(scores_path)
    final = R.read_json(out / "final.json")

    by_arm: dict[str, list[dict]] = {}
    for row in scores:
        case = row["caseId"]
        if case not in gold:
            failures.append(f"score row for unknown case {case}")
            continue
        if case in challenge:
            continue
        by_arm.setdefault(row["arm"], []).append({"caseId": case, "order": row["order"],
                                                 "gold": gold[case]["labelId"],
                                                 "prediction": row["prediction"],
                                                 "logits": row["logits"]})
    checked = {}
    for arm, rows in by_arm.items():
        for row in rows:
            if len(row["logits"]) != 4:
                failures.append(f"{arm} {row['caseId']}: {len(row['logits'])} logits")
            best = max(range(4), key=lambda index: row["logits"][index])
            if CLASSES[best] != row["prediction"]:
                failures.append(f"{arm} {row['caseId']}/{row['order']}: argmax disagrees")
        value = accuracy(rows)
        reported = final["arms"][arm]["accuracy"]
        if abs(value - reported) > 1e-9:
            failures.append(f"{arm}: recomputed {value} != reported {reported}")
        per_order = {str(order): round(sum(1 for row in rows if row["order"] == order
                                           and row["prediction"] == row["gold"])
                                       / max(1, sum(1 for row in rows if row["order"] == order)), 6)
                     for order in (0, 1, 2, 3)}
        checked[arm] = {"accuracy": value, "perOrder": per_order, "n": len(rows)}
        if per_order != {key: value["accuracy"] for key, value in final["arms"][arm]["perOrder"].items()}:
            failures.append(f"{arm}: per-order accuracy differs from final.json")

    json_rows = [row for row in R.read_jsonl(out / "test-json-generations.jsonl")]
    meta = R.read_json(out / "test-json-meta.json")
    if len(json_rows) + len(meta.get("lost", [])) != 1024:
        failures.append(f"json generations {len(json_rows)} + lost {len(meta.get('lost', []))} != 1024")
    if len(json_rows) != meta["rows"]:
        failures.append("json meta row count differs from the file")
    if R.sha256_file(out / "test-json-generations.jsonl") != record["jsonSha256"]:
        failures.append("json generations changed after sealing")

    payload = {"failures": failures, "checked": checked, "passes": not failures}
    print(json.dumps(payload, ensure_ascii=False, sort_keys=True))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
