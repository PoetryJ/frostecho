#!/usr/bin/env python3
"""Expand the scene DSL into the scored splits and enforce the data gates.

Gates (all hard, no override): 8 cases per group with exactly 2 per class, 96/16/32
groups, 96/32/64 cases per class, unique player text inside a split, group and
scene never across splits, and no player text shared with the frozen JEV-01/02/R1
corpora. Anything that fails stops the build; new names are never used to paper
over a collision.
"""
from __future__ import annotations

import hashlib
import itertools
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE.parent))

import j3config as R  # noqa: E402
from dsl import MOVE_RULE  # noqa: E402

import scenes_dev  # noqa: E402
import scenes_test_a  # noqa: E402
import scenes_test_b  # noqa: E402
import scenes_train_a  # noqa: E402
import scenes_train_b  # noqa: E402
import scenes_train_c  # noqa: E402

SOURCES = {
    "train": [scenes_train_a.GROUPS, scenes_train_b.GROUPS, scenes_train_c.GROUPS],
    "dev": [scenes_dev.GROUPS],
    "test": [scenes_test_a.GROUPS, scenes_test_b.GROUPS],
}
EXPECTED = {"train": (48, 384), "dev": (16, 128), "test": (32, 256)}
EXPECTED_PER_CLASS = {"train": 96, "dev": 32, "test": 64}
R1_CORPORA = ("jev02r1/data/cal-temperature.jsonl", "jev02r1/data/cal-policy.jsonl",
              "jev02r1/data/test.author-labels.jsonl")
J02_CORPORA = ("jev02/data/cases.jsonl", "jev02/data/manifest.jsonl", "jev02/data/split.jsonl")


def previous_texts() -> dict[str, str]:
    """Player texts from the frozen corpora, for the cross-round duplicate gate."""
    base = HERE.parent.parent
    seen: dict[str, str] = {}
    for relative in R1_CORPORA + J02_CORPORA:
        path = base / relative
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            row = json.loads(line)
            text = row.get("playerText") or (row.get("visibleInput") or {}).get("playerText") or ""
            if text:
                seen[text] = relative
    return seen


def expand(split: str) -> list[dict]:
    rows = []
    for module in SOURCES[split]:
        for group in module:
            gid = group["gid"]
            cases = group["cases"]
            if len(cases) != 8:
                raise SystemExit(f"{gid}: {len(cases)} cases, expected 8")
            counts = {}
            for index, (clause, player, move) in enumerate(cases, 1):
                label, rule, note = MOVE_RULE[move]
                counts[label] = counts.get(label, 0) + 1
                rows.append({
                    "caseId": f"j3-{split}-{gid[1:]}-{index:02d}",
                    "groupId": f"j3-{split}-{gid}",
                    "split": split,
                    "source": "synthetic_dialogue",
                    "author": "integrator prose from worker A move skeleton" if split != "test"
                              else "integrator prose from worker D test design",
                    "scene": group["scene"],
                    "sourceTemplateId": f"scene:{group['scene']}",
                    "context": f"{group['base']}{clause}",
                    "playerText": player,
                    "labelId": label,
                    "rule": rule,
                    "reason": note,
                    "move": move,
                })
            if sorted(counts.values()) != [2, 2, 2, 2]:
                raise SystemExit(f"{gid}: class mix {counts} is not 2 per class")
    return rows


def main() -> int:
    previous = previous_texts()
    everything: dict[str, list[dict]] = {}
    failures: list[str] = []
    groups_by_split: dict[str, dict[str, dict]] = {}
    scenes = {}
    for split in R.SPLITS:
        rows = expand(split)
        everything[split] = rows
        groups = {row["groupId"] for row in rows}
        expected_groups, expected_cases = EXPECTED[split]
        if len(groups) != expected_groups or len(rows) != expected_cases:
            failures.append(f"{split}: {len(groups)} groups / {len(rows)} cases, expected "
                            f"{expected_groups}/{expected_cases}")
        per_class = {cls: sum(1 for row in rows if row["labelId"] == cls) for cls in R.CLASSES}
        if any(count != EXPECTED_PER_CLASS[split] for count in per_class.values()):
            failures.append(f"{split}: per-class {per_class} != {EXPECTED_PER_CLASS[split]}")
        texts = [row["playerText"] for row in rows]
        if len(set(texts)) != len(texts):
            duplicates = [text for text in set(texts) if texts.count(text) > 1]
            failures.append(f"{split}: duplicate player text {duplicates[:3]}")
        contexts = [row["context"] for row in rows]
        if len(set(contexts)) != len(contexts):
            failures.append(f"{split}: duplicate context")
        shared = [text for text in texts if text in previous]
        if shared:
            failures.append(f"{split}: {len(shared)} player texts reuse a frozen corpus line")
        groups_by_split[split] = {row["groupId"]: row for row in rows}
        for group_id in sorted({row["groupId"] for row in rows}):
            scene = next(row["scene"] for row in rows if row["groupId"] == group_id)
            if scene in scenes:
                failures.append(f"scene {scene!r} appears in {scenes[scene]} and {split}")
            scenes[scene] = split

    checked_pairs = 0
    for left, right in itertools.combinations(R.SPLITS, 2):
            checked_pairs += 1
            overlap = set(groups_by_split[left]) & set(groups_by_split[right])
            if overlap:
                failures.append(f"group overlap {left}/{right}: {sorted(overlap)[:2]}")
            text_overlap = ({row["playerText"] for row in everything[left]}
                            & {row["playerText"] for row in everything[right]})
            if text_overlap:
                failures.append(f"{left}/{right} share {len(text_overlap)} player texts")
    if checked_pairs != 3:
        failures.append(f"only {checked_pairs} split pairs were checked, expected 3")

    if failures:
        print(json.dumps({"failures": failures}, ensure_ascii=False, indent=1))
        return 1

    stats = {"schema": "frostecho.jev03.data/1", "at": R.now_iso(),
             "splits": {}, "scenes": len(scenes), "previousTexts": len(previous)}
    for split, rows in everything.items():
        R.write_jsonl(R.split_file(split), rows)
        inputs = [{"caseId": row["caseId"], "groupId": row["groupId"],
                   "visibleInput": {"context": row["context"], "playerText": row["playerText"]}}
                  for row in rows]
        R.write_jsonl(R.inputs_file(split), inputs)
        texts = [row["playerText"] for row in rows]
        stats["splits"][split] = {
            "cases": len(rows), "groups": len({row["groupId"] for row in rows}),
            "perClass": {cls: sum(1 for row in rows if row["labelId"] == cls) for cls in R.CLASSES},
            "uniquePlayerText": len(set(texts)), "uniqueRatio": round(len(set(texts)) / len(texts), 6),
            "moves": {move: sum(1 for row in rows if row["move"] == move)
                      for move in sorted({row["move"] for row in rows})},
        }
    gold = {row["caseId"]: {"labelId": row["labelId"], "groupId": row["groupId"]}
            for row in everything["test"]}
    R.write_json(R.gold_file(), {
        "schema": "frostecho.jev03.gold/1", "at": R.now_iso(), "sha256": R.sha256_json(gold),
        "gold": gold,
        "note": "sealed before training; only unseal.py reads this file",
    })
    group_table = {row["groupId"]: {"split": row["split"], "scene": row["scene"],
                                    "cases": sorted(r["caseId"] for r in rows if r["groupId"] == row["groupId"])}
                   for rows in everything.values() for row in rows}
    R.write_json(R.DATA / "groups.json", {"schema": "frostecho.jev03.groups/1",
                                          "at": R.now_iso(), "groups": group_table})
    stats["hashes"] = {split: R.sha256_file(R.split_file(split)) for split in R.SPLITS}
    stats["goldSha256"] = R.sha256_file(R.gold_file())
    R.write_json(R.DATA / "stats.json", stats)
    print(json.dumps(stats["splits"], ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
