"""A: train/dev/cal construction. Families (patterns) never cross splits."""
from __future__ import annotations

import sys
from collections import Counter, defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import contracts as C
from contracts import CLASSES, sha256_json, write_json, write_jsonl
from data.patterns import CAL_PATTERNS, CONTEXTS_A, DEV_PATTERNS, OBJECTS, TRAIN_PATTERNS

QUOTA = {"train": 256, "dev": 32, "cal": 128}  # per class
SHORT = {"PLAYER_FIRST": "PF", "NPC_FIRST": "NF", "NO_PRIORITY_REQUEST": "NP", "NEEDS_CLARIFICATION": "NC"}


def build(split: str, pools: dict[str, tuple[str, ...]], quota: int) -> list[dict]:
    cases: list[dict] = []
    short = SHORT
    for cls in CLASSES:
        pool = pools[cls]
        combos: dict[int, list[tuple[str, str, str]]] = {}
        for pattern_index, pattern in enumerate(pool):
            entries = []
            for context_index, context_template in enumerate(CONTEXTS_A):
                for obj in OBJECTS:
                    context = context_template.format(obj=obj)
                    text = pattern.format(obj=obj)
                    entries.append((context, text, obj))
            combos[pattern_index] = entries
        target = quota // len(pool)
        taken = {index: 0 for index in combos}
        chosen: list[tuple[int, str, str, str]] = []
        for pattern_index in combos:
            for entry in combos[pattern_index][:target]:
                chosen.append((pattern_index, *entry))
                taken[pattern_index] += 1
        # Re-distribute the remainder to patterns that still have combinations.
        cursor = {index: target for index in combos}
        while len(chosen) < quota:
            progressed = False
            for pattern_index in combos:
                if len(chosen) >= quota:
                    break
                if cursor[pattern_index] < len(combos[pattern_index]):
                    chosen.append((pattern_index, *combos[pattern_index][cursor[pattern_index]]))
                    cursor[pattern_index] += 1
                    taken[pattern_index] += 1
                    progressed = True
            if not progressed:
                raise RuntimeError(f"{split}/{cls}: only {len(chosen)} combinations, quota {quota}")
        for ordinal, (pattern_index, context, text, obj) in enumerate(chosen):
            family = f"{short[cls]}-{split}-{pattern_index:02d}"
            cases.append({
                "caseId": f"jev02-{split}-{short[cls]}-{len([c for c in cases if c['labelId'] == cls]):04d}",
                "split": split,
                "groupId": family,
                "labelId": cls,
                "provenance": {"source": "synthetic_dialogue", "author": "coding-agent",
                               "family": family, "patternIndex": pattern_index,
                               "object": obj},
                "visibleInput": {"context": context, "playerText": text},
            })
    return cases


def stats(cases: list[dict]) -> dict:
    texts = Counter(case["visibleInput"]["playerText"] for case in cases)
    dialogues = Counter(C.sha256_json(case["visibleInput"]) for case in cases)
    fams = Counter(case["groupId"] for case in cases)
    return {
        "cases": len(cases),
        "uniquePlayerTexts": len(texts),
        "duplicateTextRate": round(1 - len(texts) / len(cases), 4),
        "uniqueDialogues": len(dialogues),
        "duplicateDialogueRate": round(1 - len(dialogues) / len(cases), 4),
        "families": len(fams),
        "familySizes": sorted(fams.values()),
        "sources": Counter(case["provenance"]["source"] for case in cases),
    }


def main() -> None:
    train = build("train", TRAIN_PATTERNS, QUOTA["train"])
    dev = build("dev", DEV_PATTERNS, QUOTA["dev"])
    cal = build("cal", CAL_PATTERNS, QUOTA["cal"])
    # cal is split into equal temperature/policy halves, stratified by class.
    by_class = {cls: [row for row in cal if row["labelId"] == cls] for cls in CLASSES}
    for cls, rows in by_class.items():
        for index, row in enumerate(rows):
            row["calRole"] = "temperature" if index % 2 == 0 else "policy"
    for split, rows in (("train", train), ("dev", dev), ("cal", cal)):
        write_jsonl(C.DATA / f"{split}.jsonl", rows)
    combined = train + dev + cal
    stats_all = {split: stats(rows) for split, rows in (("train", train), ("dev", dev), ("cal", cal))}
    out = {
        "schema": "frostecho.jev02.dataset/1",
        "at": C.now_iso(),
        "splits": {split: len(rows) for split, rows in (("train", train), ("dev", dev), ("cal", cal))},
        "perClass": {split: dict(Counter(row["labelId"] for row in rows)) for split, rows in (("train", train), ("dev", dev), ("cal", cal))},
        "stats": stats_all,
        "combined": stats(combined),
        "hashes": {split: sha256_json(rows) for split, rows in (("train", train), ("dev", dev), ("cal", cal))},
        "sources": {"synthetic_dialogue": len(combined), "human": 0, "real_player": 0},
        "limitations": [
            "all semantic cases are coding-agent synthetic_dialogue; no human labels",
            "16 contexts share objects; dedupe rates are reported, not hidden",
            "family = one authored pattern, split before variants",
        ],
    }
    write_json(C.DATA / "train-stats.json", out)
    print(sha256_json({"splits": out["splits"], "hashes": out["hashes"]})[:16],
          out["splits"], {k: v["families"] for k, v in stats_all.items()},
          {k: v["duplicateTextRate"] for k, v in stats_all.items()})


if __name__ == "__main__":
    main()
