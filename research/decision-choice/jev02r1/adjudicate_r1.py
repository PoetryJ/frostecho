#!/usr/bin/env python3
"""Adjudicate author labels against the independent blind labels.

Rules (fixed before any model call):
- A disagreement is resolved by re-reading the context against contract.json,
  and the resolution plus its rationale is written to data/resolutions.json.
- Nothing is resolved by majority vote between the two label sets, and no
  regex/template labeler is used.
- Rows with two or more defensible readings go to the unscored challenge list
  instead of being forced to a single label.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import r1config as R
from evalr1 import agreement_stats
from r1config import CLASSES, SPLITS, read_json, read_jsonl, sha256_json, write_json, write_jsonl


def load_sources() -> tuple[dict[str, list[dict]], dict[str, dict]]:
    authored = {
        "cal-temperature": read_jsonl(R.split_file("cal-temperature")),
        "cal-policy": read_jsonl(R.split_file("cal-policy")),
        "test": read_jsonl(R.DATA / "test.author-labels.jsonl"),
    }
    blind: dict[str, dict] = {}
    for index in range(1, 5):
        for row in read_jsonl(R.DATA / "blind" / f"labels-{index}.jsonl"):
            if row["labelId"] not in CLASSES:
                raise SystemExit(f"blind label outside the class set: {row}")
            blind[row["caseId"]] = row
    return authored, blind


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--resolutions", default=str(R.DATA / "resolutions.json"))
    args = parser.parse_args(argv)

    authored, blind = load_sources()
    missing = [row["caseId"] for rows in authored.values() for row in rows if row["caseId"] not in blind]
    if missing:
        raise SystemExit(f"blind review is incomplete: {missing[:5]}")

    resolutions = {}
    path = Path(args.resolutions)
    if path.exists():
        resolutions = read_json(path)["resolutions"]

    report = {"schema": "frostecho.jev02r1.adjudication/1", "at": R.now_iso(),
              "reviewer": "four independent agent sessions, contract + unlabelled input only",
              "splits": {}}
    resolved_all = {}
    for split, rows in authored.items():
        author_rows = [{"caseId": row["caseId"], "labelId": row["labelId"],
                        "context": row["context"], "playerText": row["playerText"]} for row in rows]
        stats = agreement_stats(author_rows, list(blind.values()))
        report["splits"][split] = {"n": stats["n"], "agree": stats["agree"],
                                   "disagree": stats["disagree"], "rate": stats["rate"],
                                   "confusion": stats["confusion"]}
        for row in rows:
            entry = {"caseId": row["caseId"], "family": row["family"],
                     "author": row["labelId"], "reviewer": blind[row["caseId"]]["labelId"],
                     "reviewerReason": blind[row["caseId"]]["reason"],
                     "context": row["context"], "playerText": row["playerText"],
                     "authorReason": row["reason"]}
            if row["labelId"] == blind[row["caseId"]]["labelId"]:
                entry["final"] = row["labelId"]
                entry["resolution"] = "agreed"
            else:
                fix = resolutions.get(row["caseId"])
                if not fix:
                    raise SystemExit(f"unresolved disagreement {row['caseId']}: add it to resolutions.json")
                entry["final"] = fix["labelId"]
                entry["resolution"] = "adjudicated"
                entry["rationale"] = fix["rationale"]
                entry["rule"] = fix.get("rule")
            resolved_all[row["caseId"]] = entry

    total = sum(value["n"] for value in report["splits"].values())
    agree = sum(value["agree"] for value in report["splits"].values())
    report["overall"] = {"n": total, "agree": agree, "disagree": total - agree,
                         "rate": round(agree / total, 6)}
    report["disagreements"] = [{key: entry[key] for key in
                               ("caseId", "family", "author", "reviewer", "reviewerReason",
                                "authorReason", "final", "resolution", "rationale", "context",
                                "playerText") if key in entry}
                              for entry in resolved_all.values() if entry["resolution"] != "agreed"]
    write_json(R.DATA / "disagreements.json", report)

    # Apply the adjudicated labels back onto the calibration data and the sealed test gold.
    for split in ("cal-temperature", "cal-policy"):
        rows = authored[split]
        for row in rows:
            row["labelId"] = resolved_all[row["caseId"]]["final"]
            row["adjudication"] = resolved_all[row["caseId"]]["resolution"]
        write_jsonl(R.split_file(split), rows)
    test_rows = authored["test"]
    gold = {}
    for row in test_rows:
        entry = resolved_all[row["caseId"]]
        gold[row["caseId"]] = {"labelId": entry["final"], "family": row["family"]}
    write_json(R.DATA / "test.gold.json", {
        "schema": "frostecho.jev02r1.gold/1",
        "at": R.now_iso(),
        "sha256": sha256_json(gold),
        "gold": gold,
        "adjudication": "author label unless an independent blind label disagreed; every "
                        "disagreement re-read against contract.json and resolved individually",
        "agreement": report["overall"],
        "disagreements": len(report["disagreements"]),
        "challenged": [],
    })
    print(R.canonical({"overall": report["overall"],
                       "perSplit": {key: value["rate"] for key, value in report["splits"].items()},
                       "disagreements": len(report["disagreements"])}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
