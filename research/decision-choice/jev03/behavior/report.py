#!/usr/bin/env python3
"""Pair-aware metrics. A pair is one statistical unit, not two samples."""
from __future__ import annotations

import argparse
import collections
import json
import re
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import j3config as R3  # noqa: E402

PATTERN = re.compile(r'"selectedId"\s*:\s*"([A-D])"')


def pct(value) -> str:
    return "n/a" if value is None else f"{100 * value:.2f}%"


def summarise(rows: list[dict]) -> dict:
    correct = [row["prediction"] == row["labelId"] for row in rows]
    per_order = {}
    for order in (0, 1, 2, 3):
        subset = [ok for row, ok in zip(rows, correct) if row["order"] == order]
        per_order[str(order)] = {"n": len(subset), "correct": int(sum(subset)),
                                 "accuracy": round(sum(subset) / len(subset), 4) if subset else None}
    per_class = {}
    confusion = {}
    for cls in R3.CLASSES:
        pairs = [(row, ok) for row, ok in zip(rows, correct) if row["labelId"] == cls]
        hit = sum(1 for _, ok in pairs if ok)
        per_class[cls] = {"n": len(pairs), "correct": hit,
                          "recall": round(hit / len(pairs), 4) if pairs else None}
        confusion[cls] = dict(collections.Counter(row["prediction"] for row, _ in pairs))
    by_case: dict[str, list[bool]] = collections.defaultdict(list)
    for row, ok in zip(rows, correct):
        by_case[row["caseId"]].append(ok)
    predictions: dict[str, set] = collections.defaultdict(set)
    for row in rows:
        predictions[row["caseId"]].add(row["prediction"])
    consistent = {case for case, values in predictions.items() if len(values) == 1}
    consistent_wrong = {case for case in consistent
                        if not any(by_case[case])}
    return {"n": len(rows), "correct": int(sum(correct)),
            "accuracy": round(sum(correct) / len(rows), 4),
            "worstOrder": min(value["accuracy"] for value in per_order.values()
                              if value["accuracy"] is not None),
            "perOrder": per_order, "perClass": per_class, "confusion": confusion,
            "allFourConsistent": len(consistent),
            "consistentAndWrong": len(consistent_wrong),
            "macroF1": round(float(np.mean([
                (lambda p, r: 2 * p * r / (p + r) if p + r else 0.0)(
                    sum(1 for row, ok in zip(rows, correct) if row["prediction"] == cls and ok)
                    / max(1, sum(1 for row in rows if row["prediction"] == cls)),
                    per_class[cls]["recall"] or 0.0) for cls in R3.CLASSES])), 4)}


def pair_metrics(rows: list[dict], pairs: dict) -> dict:
    by_case = collections.defaultdict(list)
    for row in rows:
        by_case[row["caseId"]].append(row["prediction"] == row["labelId"])
    both = {"flip": [], "invariant": []}
    flip_correct = []
    invariant_same = []
    per_cap = collections.defaultdict(lambda: {"pairs": 0, "bothCorrect": 0})
    for pair_id, pair in pairs.items():
        members = pair["members"]
        a, b = members
        both_ok = all(all(by_case[a["caseId"]]) and all(by_case[b["caseId"]]))
        both[pair["relation"]].append(both_ok)
        per_cap[pair["capability"]]["pairs"] += 1
        per_cap[pair["capability"]]["bothCorrect"] += int(both_ok)
        pred_a = {row["prediction"] for row in rows if row["caseId"] == a["caseId"]}
        pred_b = {row["prediction"] for row in rows if row["caseId"] == b["caseId"]}
        if pair["relation"] == "flip":
            flip_correct.append(pred_a == {a["labelId"]} and pred_b == {b["labelId"]})
        else:
            invariant_same.append(pred_a == pred_b)
    return {"flipPairs": len(both["flip"]),
            "flipBothCorrect": sum(both["flip"]),
            "flipBothCorrectRate": round(sum(both["flip"]) / len(both["flip"]), 4),
            "flipCorrectFlipRate": round(sum(flip_correct) / len(flip_correct), 4),
            "invariantPairs": len(both["invariant"]),
            "invariantBothCorrect": sum(both["invariant"]),
            "invariantBothCorrectRate": round(sum(both["invariant"]) / len(both["invariant"]), 4),
            "invariantSamePrediction": sum(invariant_same),
            "invariantSameRate": round(sum(invariant_same) / len(invariant_same), 4),
            "perCapability": {cap: {**value,
                                    "rate": round(value["bothCorrect"] / value["pairs"], 4)}
                              for cap, value in per_cap.items()}}


def json_rows(gold: dict) -> tuple[list[dict], dict]:
    path = HERE / "results" / "generations.jsonl"
    rows, parse = [], {"total": 0, "parsed": 0, "invalid": 0}
    if not path.exists():
        return rows, parse
    for row in R3.read_jsonl(path):
        parse["total"] += 1
        match = PATTERN.search(row.get("rawText") or "")
        parse["parsed"] += bool(match)
        if not match:
            parse["invalid"] += 1
            continue
        order = int(row["order"])
        rows.append({"caseId": row["caseId"], "order": order,
                     "labelId": gold[row["caseId"]],
                     "prediction": R3.ORDERS[order][R3.LETTERS.index(match.group(1))]})
    return rows, parse


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(HERE / "results" / "REPORT.md"))
    args = parser.parse_args(argv)
    gold = R3.read_json(HERE / "gold.json")["gold"]
    pairs_doc = R3.read_json(HERE / "pairs.json")
    pairs = pairs_doc["pairs"]
    scores = R3.read_jsonl(HERE / "results" / "scores.jsonl")
    targets = {"worstOrder": 0.85, "classRecall": 0.85, "flipBothCorrect": 0.80,
               "invariantBothCorrect": 0.90}

    metrics = {"schema": "frostecho.jev03r1.metrics/1", "at": R3.now_iso(), "arms": {}}
    for arm in R3.ARMS:
        rows = [row for row in scores if row["arm"] == arm]
        block = summarise(rows)
        block["pairs"] = pair_metrics(rows, pairs)
        block["targets"] = {"worstOrder": block["worstOrder"] >= targets["worstOrder"],
                            "classRecall": all((value["recall"] or 0) >= targets["classRecall"]
                                               for value in block["perClass"].values()),
                            "flipBothCorrect": block["pairs"]["flipBothCorrectRate"]
                            >= targets["flipBothCorrect"],
                            "invariantBothCorrect": block["pairs"]["invariantBothCorrectRate"]
                            >= targets["invariantBothCorrect"]}
        metrics["arms"][arm] = block
    jrows, parse = json_rows(gold)
    if jrows:
        block = summarise(jrows)
        block["pairs"] = pair_metrics(jrows, pairs)
        block["parse"] = parse
        metrics["arms"]["JSON"] = block
    metrics["complete"] = (len(scores) == 768 * 3 and len(jrows) == 768)
    metrics["counts"] = {"scoreRows": len(scores), "jsonRows": len(jrows),
                         "expectedScoreRows": 768 * 3, "expectedJsonRows": 768}
    R3.write_json(HERE / "results" / "metrics.json", metrics)

    lines = ["# JEV-03R1 行为对照（96 对 / 192 例 / 768 呈现）", ""]
    lines.append(f"- 计分完整：{metrics['complete']}（头 {len(scores)}/{768 * 3} 行，JSON {len(jrows)}/768 行）")
    lines.append("- 每对两例是同一统计单位；两例都对才算该对通过。")
    lines.append("")
    lines.append("| 臂 | 准确率 | 最差序 | macro-F1 | flip两例全对 | invariant两例全对 | 四序一致且全错 |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- |")
    for arm in list(R3.ARMS) + (["JSON"] if "JSON" in metrics["arms"] else []):
        block = metrics["arms"][arm]
        lines.append(f"| {arm} | {pct(block['accuracy'])} | {pct(block['worstOrder'])} | "
                     f"{block['macroF1']:.4f} | {pct(block['pairs']['flipBothCorrectRate'])} "
                     f"({block['pairs']['flipBothCorrect']}/{block['pairs']['flipPairs']}) | "
                     f"{pct(block['pairs']['invariantBothCorrectRate'])} "
                     f"({block['pairs']['invariantBothCorrect']}/{block['pairs']['invariantPairs']}) | "
                     f"{block['consistentAndWrong']} |")
    lines.append("")
    lines.append("## 逐序与逐类")
    lines.append("")
    lines.append("| 臂 | o0 | o1 | o2 | o3 | PF | NF | NO | NC |")
    lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
    for arm in list(R3.ARMS) + (["JSON"] if "JSON" in metrics["arms"] else []):
        block = metrics["arms"][arm]
        lines.append("| " + arm + " | " + " | ".join(
            [pct(block["perOrder"][str(index)]["accuracy"]) for index in range(4)]
            + [pct(block["perClass"][cls]["recall"]) for cls in R3.CLASSES]) + " |")
    lines.append("")
    lines.append("## 逐能力两例全对率")
    lines.append("")
    lines.append("| 臂 | " + " | ".join(sorted(metrics["arms"][R3.ARMS[0]]["pairs"]["perCapability"])) + " |")
    lines.append("| --- | " + " | ".join("---" for _ in sorted(
        metrics["arms"][R3.ARMS[0]]["pairs"]["perCapability"])) + " |")
    for arm in list(R3.ARMS) + (["JSON"] if "JSON" in metrics["arms"] else []):
        caps = metrics["arms"][arm]["pairs"]["perCapability"]
        lines.append("| " + arm + " | " + " | ".join(
            f"{pct(caps[cap]['rate'])} ({caps[cap]['bothCorrect']}/{caps[cap]['pairs']})"
            for cap in sorted(caps)) + " |")
    lines.append("")
    lines.append("## 预登记工程目标")
    lines.append("")
    for arm in R3.ARMS:
        flags = metrics["arms"][arm]["targets"]
        lines.append(f"- {arm}: 最差序≥85% {flags['worstOrder']}；每类召回≥85% {flags['classRecall']}；"
                     f"flip两例全对≥80% {flags['flipBothCorrect']}；"
                     f"invariant两例全对≥90% {flags['invariantBothCorrect']}")
    Path(args.out).write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({arm: {"acc": metrics["arms"][arm]["accuracy"],
                            "worst": metrics["arms"][arm]["worstOrder"],
                            "flip": metrics["arms"][arm]["pairs"]["flipBothCorrectRate"]}
                      for arm in metrics["arms"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
