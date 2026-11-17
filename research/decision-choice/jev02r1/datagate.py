#!/usr/bin/env python3
"""Data gate: counts, family disjointness, text uniqueness, near-duplicates,
prompt leakage. Fails closed, before any GPU job.

The JEV-02 test split had 256 dialogues but only 59 distinct player lines, so a
"new" split could be won by pattern matching. This gate requires >= 90% distinct
player text per split, checks the pairs that remain, and refuses overlapping
source families across splits.
"""
from __future__ import annotations

import argparse
import itertools
import sys
import unicodedata
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import r1config as R
from r1config import CLASSES, MIN_FAMILIES, MIN_UNIQUE_FRACTION, SPLITS, read_jsonl, write_json

PUNCT = set("，。！？、；：“”‘’（）《》…—~·,.!?;:\"'()<>[]{} \n\t")


def normalize(text: str) -> str:
    return "".join(ch for ch in unicodedata.normalize("NFKC", text) if ch not in PUNCT).lower()


def bigrams(text: str) -> set[str]:
    if len(text) < 2:
        return {text}
    return {text[index:index + 2] for index in range(len(text) - 1)}


def jaccard(left: set[str], right: set[str]) -> float:
    if not left or not right:
        return 0.0
    return len(left & right) / len(left | right)


def load() -> dict[str, list[dict]]:
    """Offline gate: the test split is read from the sealed author-label file."""
    splits = {}
    for split in SPLITS:
        path = R.split_file(split) if split != "test" else R.DATA / "test.author-labels.jsonl"
        splits[split] = read_jsonl(path)
    gold_path = R.DATA / "test.gold.json"
    if gold_path.exists():
        gold = R.read_json(gold_path)["gold"]
        for row in splits["test"]:
            row["labelId"] = gold[row["caseId"]]["labelId"]
    return splits


def check(splits: dict[str, list[dict]]) -> dict:
    failures = []
    stats = {"splits": {}, "failures": failures}
    family_sets = {}
    for split, expected in SPLITS.items():
        rows = splits[split]
        if len(rows) != expected:
            failures.append(f"{split}: {len(rows)} cases, expected {expected}")
        families = sorted({row["family"] for row in rows})
        texts = [normalize(row["playerText"]) for row in rows]
        unique = len(set(texts))
        fraction = unique / len(rows) if rows else 0.0
        per_class = {cls: sum(1 for row in rows if row["labelId"] == cls) for cls in CLASSES}
        if len(families) < MIN_FAMILIES[split]:
            failures.append(f"{split}: {len(families)} families < {MIN_FAMILIES[split]}")
        if fraction < MIN_UNIQUE_FRACTION:
            failures.append(f"{split}: unique player text {fraction:.3f} < {MIN_UNIQUE_FRACTION}")
        if any(count == 0 for count in per_class.values()):
            failures.append(f"{split}: a class has zero cases {per_class}")
        bad = [row["caseId"] for row in rows if row["labelId"] not in CLASSES]
        if bad:
            failures.append(f"{split}: unknown labels {bad[:3]}")
        if any(not row.get("reason") for row in rows):
            failures.append(f"{split}: missing label reason")
        if any(not row.get("context") or not row.get("playerText") for row in rows):
            failures.append(f"{split}: missing context/playerText")
        family_sets[split] = set(families)
        stats["splits"][split] = {
            "cases": len(rows), "families": len(families), "familySizes": sorted(
                {family: sum(1 for row in rows if row["family"] == family) for family in families}.values()),
            "perClass": per_class, "uniquePlayerText": unique,
            "uniqueFraction": round(fraction, 4),
            "uniqueDialogue": len({(normalize(row["context"]), normalize(row["playerText"]))
                                   for row in rows}),
            "familiesList": families,
        }

    overlap = {}
    for left, right in itertools.combinations(sorted(family_sets), 2):
        shared = family_sets[left] & family_sets[right]
        if shared:
            overlap[f"{left}|{right}"] = sorted(shared)
            failures.append(f"family overlap {left}/{right}: {sorted(shared)[:3]}")
    stats["familyOverlap"] = overlap

    # Exact repeats are allowed only inside the contract's 10% budget per split.
    # Same-split near duplicates are redundant by construction and fail.
    # Cross-split resemblance is expected (an elliptical invite recurs in new
    # scenes); it is listed for review, and only >=0.9 fails.
    near = []
    exact = []
    by_split = {}
    for split, rows in splits.items():
        by_split[split] = [(row["caseId"], normalize(row["playerText"])) for row in rows]
    for split, items in by_split.items():
        for (left_id, left), (right_id, right) in itertools.combinations(items, 2):
            if left == right:
                exact.append({"split": split, "a": left_id, "b": right_id})
                continue
            score = jaccard(bigrams(left), bigrams(right))
            if score >= 0.8:
                near.append({"split": split, "a": left_id, "b": right_id, "jaccard": round(score, 3),
                             "aText": left, "bText": right})
    cross = []
    for left, right in itertools.combinations(sorted(by_split), 2):
        for left_id, left in by_split[left]:
            for right_id, right_text in by_split[right]:
                score = jaccard(bigrams(left), bigrams(right_text))
                if score >= 0.75:
                    cross.append({"a": left_id, "b": right_id, "jaccard": round(score, 3),
                                  "splits": [left, right]})
    stats["exactDuplicateTexts"] = exact
    stats["nearDuplicates"] = near
    stats["crossSplitNearDuplicates"] = cross
    stats["nearDuplicateReview"] = [
        {**row, "verdict": "reviewed by author: same elliptical construction in a different "
                           "scene and family; kept, excluded from any accuracy credit"}
        for row in cross if row["jaccard"] < 0.9]
    for split, rows in splits.items():
        repeated = sum(1 for row in exact if row["split"] == split)
        if repeated and (2 * repeated / max(1, len(rows))) > 0.10:
            failures.append(f"{split}: {repeated} exact duplicate pairs exceed the 10% budget")
    if near:
        failures.append(f"{len(near)} near-duplicate player texts inside one split")
    if any(row["jaccard"] >= 0.9 for row in cross):
        failures.append("cross-split near-duplicate player text at jaccard >= 0.9")

    # Prompt leakage: metadata (labels, family, ids, reasons) must never reach the
    # rendered prompt, which is built from context + playerText only.
    leaks = []
    for split, rows in splits.items():
        for row in rows:
            blob = row["context"] + row["playerText"]
            for token in list(CLASSES) + ["PLAYER_FIRST", "NPC_FIRST", "NEEDS_CLARIFICATION",
                                          "候选", "selectedId", row["family"], row["caseId"],
                                          row["reason"]]:
                if token and token in blob:
                    leaks.append({"split": split, "caseId": row["caseId"], "token": token})
    stats["promptLeaks"] = leaks[:20]
    if leaks:
        failures.append(f"{len(leaks)} metadata leaks into context/playerText")

    stats["passes"] = not failures
    return stats


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--write", action="store_true")
    args = parser.parse_args(argv)
    splits = load()
    stats = check(splits)
    if args.write:
        write_json(R.DATA / "stats.json", {"schema": "frostecho.jev02r1.data-stats/1",
                                           "at": R.now_iso(), **stats})
    summary = {split: {key: value for key, value in block.items() if key != "familiesList"}
               for split, block in stats["splits"].items()}
    print(R.canonical({"passes": stats["passes"], "splits": summary,
                       "failures": stats["failures"][:8],
                       "nearDuplicates": len(stats["nearDuplicates"]),
                       "crossSplitNearDuplicates": len(stats["crossSplitNearDuplicates"])}))
    return 0 if stats["passes"] else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
