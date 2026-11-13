#!/usr/bin/env python3
"""Group-isolated train/dev split for the first qualified batch.

24 source groups -> train (48 cases), 8 groups -> dev (16 cases), 6/2 per
category. The same group never appears in both splits. This is a *smaller
qualified batch* under the original contract, not a renamed expansion.
"""
from __future__ import annotations

import collections
import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent


def main() -> int:
    rows = [json.loads(line) for line in (HERE / "anchors.jsonl").read_text(encoding="utf-8").splitlines() if line]
    by_group = collections.defaultdict(list)
    for row in rows:
        by_group[row["sourceGroup"]].append(row)
    categories = sorted({row["category"] for row in rows})
    train_groups, dev_groups = [], []
    for category in categories:
        groups = sorted({row["sourceGroup"] for row in rows if row["category"] == category})
        train_groups.extend(groups[:6])
        dev_groups.extend(groups[6:])
    train = [row for group in train_groups for row in by_group[group]]
    dev = [row for group in dev_groups for row in by_group[group]]
    overlap = set(train_groups) & set(dev_groups)
    if overlap:
        raise SystemExit(f"group leakage: {overlap}")
    doc = {
        "schema": "frostecho.jev04.split/1",
        "source": "anchors.jsonl",
        "anchorsSha256": hashlib.sha256((HERE / "anchors.jsonl").read_bytes()).hexdigest(),
        "trainGroups": sorted(train_groups),
        "devGroups": sorted(dev_groups),
        "trainCases": len(train),
        "devCases": len(dev),
        "perCategory": {category: {
            "trainGroups": sum(1 for g in train_groups if g in {r["sourceGroup"] for r in rows if r["category"] == category}),
            "devGroups": sum(1 for g in dev_groups if g in {r["sourceGroup"] for r in rows if r["category"] == category}),
        } for category in categories},
        "masks": {"commonMask": "all candidates scored; K fixed at 2-4 per case",
                  "caseIdMask": "same caseId set for all three arms",
                  "version": "anchors/1"},
    }
    (HERE / "split.json").write_text(json.dumps(doc, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    for name, subset in (("train", train), ("dev", dev)):
        (HERE / f"{name}.jsonl").write_text(
            "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in subset),
            encoding="utf-8")
    print(json.dumps({"trainCases": len(train), "devCases": len(dev),
                      "trainGroups": len(train_groups), "devGroups": len(dev_groups),
                      "overlap": sorted(overlap)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
