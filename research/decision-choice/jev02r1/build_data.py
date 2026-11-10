#!/usr/bin/env python3
"""Assemble the authored parts into the three splits and the sealed test files.

Author labels stay in data/test.author-labels.jsonl (sealed with gold). The
prediction path only ever sees data/test.inputs.jsonl, which carries an opaque
case id and the visible input.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import r1config as R
from r1config import CLASSES, SPLITS, read_jsonl, sha256_json, write_json, write_jsonl

ALLOWED = {"caseId", "family", "labelId", "context", "playerText", "reason", "provenance"}
PARTS = {
    "cal-temperature": 4,
    "cal-policy": 4,
    "test": 8,
}


def load_part(split: str, index: int) -> list[dict]:
    path = R.DATA / f"{split}.part{index}.jsonl"
    rows = read_jsonl(path)
    cleaned = []
    for row in rows:
        extra = set(row) - ALLOWED
        if extra:
            raise SystemExit(f"{path.name}: unexpected keys {sorted(extra)} in {row['caseId']}")
        if row["labelId"] not in CLASSES:
            raise SystemExit(f"{path.name}: bad label {row['labelId']} in {row['caseId']}")
        cleaned.append({key: row[key] for key in
                        ("caseId", "family", "labelId", "context", "playerText", "reason", "provenance")})
    return cleaned


def assemble(split: str) -> list[dict]:
    parts = [R.DATA / f"{split}.part{index}.jsonl" for index in range(1, PARTS[split] + 1)]
    if all(path.exists() for path in parts):
        rows = []
        for index in range(1, PARTS[split] + 1):
            rows.extend(load_part(split, index))
    else:
        # Rebuild derived files from the already assembled split (authoring fixes
        # are applied in place, then this regenerates inputs/gold/families).
        source = R.split_file(split) if split != "test" else R.DATA / "test.author-labels.jsonl"
        rows = read_jsonl(source)
        for row in rows:
            extra = set(row) - ALLOWED
            if extra:
                raise SystemExit(f"{source.name}: unexpected keys {sorted(extra)} in {row['caseId']}")
    rows.sort(key=lambda row: row["caseId"])
    ids = [row["caseId"] for row in rows]
    if len(set(ids)) != len(ids):
        raise SystemExit(f"{split}: duplicate case ids")
    if len(rows) != SPLITS[split]:
        raise SystemExit(f"{split}: {len(rows)} cases, expected {SPLITS[split]}")
    return rows


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keep-parts", action="store_true")
    args = parser.parse_args(argv)

    splits = {}
    for split in SPLITS:
        rows = assemble(split)
        splits[split] = rows
        if split != "test":
            write_jsonl(R.split_file(split), rows)

    test = splits["test"]
    write_jsonl(R.DATA / "test.author-labels.jsonl", test)
    write_jsonl(R.DATA / "test.inputs.jsonl",
                [{"caseId": row["caseId"], "visibleInput": {
                    "context": row["context"], "playerText": row["playerText"]}} for row in test])
    write_jsonl(R.DATA / "test.meta.jsonl",
                [{"caseId": row["caseId"], "family": row["family"]} for row in test])

    gold = {row["caseId"]: {"labelId": row["labelId"], "family": row["family"]} for row in test}
    write_json(R.DATA / "test.gold.json", {
        "schema": "frostecho.jev02r1.gold/1",
        "at": R.now_iso(),
        "sha256": sha256_json(gold),
        "gold": gold,
        "adjudication": "pending independent blind review",
        "disagreements": None,
        "challenged": [],
    })

    families = {}
    for split, rows in splits.items():
        ordered = sorted({row["family"] for row in rows})
        families[split] = ordered
    write_json(R.DATA / "families.json", {"schema": "frostecho.jev02r1.families/1",
                                          "at": R.now_iso(), "splits": families,
                                          "counts": {split: len(value) for split, value in families.items()}})

    if not args.keep_parts:
        for split, count in PARTS.items():
            for index in range(1, count + 1):
                (R.DATA / f"{split}.part{index}.jsonl").unlink(missing_ok=True)

    print(R.canonical({split: {"cases": len(rows), "families": len(families[split])}
                       for split, rows in splits.items()}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
