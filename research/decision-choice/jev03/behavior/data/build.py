#!/usr/bin/env python3
"""Expand the 96 pairs into 192 cases and enforce the pair gates.

Gates: 96 pairs = 16 per capability; flip members share the player text verbatim
and must disagree in gold; invariant members agree in gold; every class appears
in both layers with at least 24 cases; no full (context, playerText) row is shared
with the frozen train/dev/test corpora; no row is copied into another pair; and
the player text is not reused as a template outside its own pair.
"""
from __future__ import annotations

import hashlib
import json
import random
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
BEHAVIOR = HERE.parent
ROOT = BEHAVIOR.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import j3config as R  # noqa: E402
from dsl import CAPABILITIES  # noqa: E402

import pairs_flip_a  # noqa: E402
import pairs_flip_b  # noqa: E402
import pairs_inv  # noqa: E402

PAIRS = pairs_flip_a.PAIRS + pairs_flip_b.PAIRS + pairs_inv.PAIRS
EXPECTED_PAIRS_PER_CAP = 16
MIN_PER_CLASS = 24


def old_corpus() -> tuple[set[tuple[str, str]], dict[str, str]]:
    rows, texts = set(), {}
    for split in R.SPLITS:
        for row in R.read_jsonl(R.split_file(split)):
            rows.add((row["context"], row["playerText"]))
            texts[row["playerText"]] = row["caseId"]
    return rows, texts


def main() -> int:
    failures: list[str] = []
    per_cap: dict[str, int] = {}
    per_class: dict[str, int] = {}
    layer_class: dict[str, set] = {"flip": set(), "invariant": set()}
    old_rows, old_texts = old_corpus()

    for pair in PAIRS:
        per_cap[pair["capability"]] = per_cap.get(pair["capability"], 0) + 1
        first, second = pair["members"]
        if first["context"] == second["context"]:
            failures.append(f"{pair['pairId']}: members share a context")
        if pair["relation"] == "flip":
            if first["playerText"] != second["playerText"]:
                failures.append(f"{pair['pairId']}: flip members differ in player text")
            if first["labelId"] == second["labelId"]:
                failures.append(f"{pair['pairId']}: flip members share the gold label")
        else:
            if first["labelId"] != second["labelId"]:
                failures.append(f"{pair['pairId']}: invariant members disagree in gold")
        for member in pair["members"]:
            per_class[member["labelId"]] = per_class.get(member["labelId"], 0) + 1
            layer_class[pair["relation"]].add(member["labelId"])
            if (member["context"], member["playerText"]) in old_rows:
                failures.append(f"{pair['pairId']}: row copied from the frozen corpus")
            if member["playerText"] in old_texts:
                failures.append(f"{pair['pairId']}: player text reused from {old_texts[member['playerText']]}")

    for capability, count in per_cap.items():
        if count != EXPECTED_PAIRS_PER_CAP:
            failures.append(f"{capability}: {count} pairs, expected {EXPECTED_PAIRS_PER_CAP}")
    if len(PAIRS) != 96:
        failures.append(f"{len(PAIRS)} pairs, expected 96")
    for layer, classes in layer_class.items():
        if classes != set(R.CLASSES):
            failures.append(f"{layer} layer covers {sorted(classes)}")
    for cls in R.CLASSES:
        if per_class.get(cls, 0) < MIN_PER_CLASS:
            failures.append(f"{cls}: {per_class.get(cls, 0)} cases < {MIN_PER_CLASS}")

    # text may repeat only inside its own pair; a pair copied wholesale is refused
    text_owner: dict[str, str] = {}
    row_owner: dict[tuple[str, str], str] = {}
    for pair in PAIRS:
        for member in pair["members"]:
            key = (member["context"], member["playerText"])
            if key in row_owner:
                failures.append(f"{pair['pairId']}: whole row duplicated from {row_owner[key]}")
            row_owner[key] = pair["pairId"]
            owner = text_owner.setdefault(member["playerText"], pair["pairId"])
            if owner != pair["pairId"]:
                failures.append(f"{pair['pairId']}: player text also used by {owner}")

    if failures:
        print(json.dumps({"failures": failures}, ensure_ascii=False, indent=1))
        return 1

    cases = []
    for pair in PAIRS:
        for index, member in enumerate(pair["members"]):
            cases.append({"pairId": pair["pairId"], "capability": pair["capability"],
                          "relation": pair["relation"], "member": "AB"[index],
                          "context": member["context"], "playerText": member["playerText"],
                          "labelId": member["labelId"], "changed": pair["changed"],
                          "rationale": pair["rationale"]})
    order = list(range(len(cases)))
    random.Random(20261110).shuffle(order)
    ids = {}
    for position, index in enumerate(order, 1):
        case_id = f"b-{position:04d}"
        ids[index] = case_id
        cases[index]["caseId"] = case_id

    rows = []
    for index in order:
        case = cases[index]
        rows.append({key: case[key] for key in ("caseId", "pairId", "member", "relation",
                                                "capability", "context", "playerText", "labelId",
                                                "changed", "rationale")})
    BEHAVIOR.mkdir(parents=True, exist_ok=True)
    digest_cases = R.write_jsonl(BEHAVIOR / "cases.jsonl", rows)
    inputs = [{"caseId": row["caseId"],
               "visibleInput": {"context": row["context"], "playerText": row["playerText"]}}
              for row in rows]
    digest_inputs = R.write_jsonl(BEHAVIOR / "inputs.jsonl", inputs)
    gold = {row["caseId"]: row["labelId"] for row in rows}
    pairs = {}
    for row in rows:
        pairs.setdefault(row["pairId"], {"pairId": row["pairId"], "capability": row["capability"],
                                         "relation": row["relation"],
                                         "changed": row["changed"],
                                         "members": []})["members"].append(
            {"caseId": row["caseId"], "labelId": row["labelId"]})
    stats = {"schema": "frostecho.jev03r1.behavior-data/1", "at": R.now_iso(),
             "cases": len(rows), "pairs": len(PAIRS),
             "perCapability": per_cap, "perClass": per_class,
             "flipPairsWithIdenticalText": sum(1 for pair in PAIRS
                                               if pair["relation"] == "flip"),
             "classPerLayer": {layer: sorted(classes) for layer, classes in layer_class.items()},
             "caseFileSha256": digest_cases, "inputFileSha256": digest_inputs,
             "goldSha256": R.sha256_json(gold), "pairsSha256": R.sha256_json(pairs),
             "inputsHaveNoSemantics": True}
    R.write_json(BEHAVIOR / "gold.json", {"schema": "frostecho.jev03r1.behavior-gold/1",
                                          "at": R.now_iso(), "sha256": R.sha256_json(gold),
                                          "gold": gold})
    R.write_json(BEHAVIOR / "pairs.json", {"schema": "frostecho.jev03r1.pairs/1",
                                           "at": R.now_iso(), "sha256": R.sha256_json(pairs),
                                           "pairs": pairs})
    R.write_json(BEHAVIOR / "stats.json", stats)
    print(json.dumps({"cases": len(rows), "pairs": len(PAIRS), "perClass": per_class,
                      "perCapability": per_cap}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
