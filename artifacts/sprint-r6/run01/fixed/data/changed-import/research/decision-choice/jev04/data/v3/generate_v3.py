#!/usr/bin/env python3
"""R3 (D): v3 case generation, decoupled from gold labels.

v2 defect this fixes: `candidates_for(acceptable)` ordered the acceptable
actions first and truncated, so the correct answer was always candidate #1
(64/64 first-position leak). This generator NEVER reads acceptableSet:

  - input  : v2 cases with `acceptableSet` stripped (enforced below),
             plus the v2 adjudication ledger to isolate challenge cases;
  - pool   : per-task action vocabulary derived from candidate texts only;
  - sample : K=4 drawn with a pre-registered seeded RNG keyed by
             (master seed, caseId); order shuffled; opaque ids c0..c3 are
             assigned AFTER the shuffle, so position and id carry no label
             information;
  - output : cases.v3.jsonl (reviewed content) and labels sealed into a
             separate file that is NOT a generator input (re-running this
             script after deleting the sealed file reproduces the same
             cases byte-for-byte; validate_v3.py checks exactly that).

Cases whose sample happens to contain no acceptable action stay in the
output with `answerable: false`; eligibility is decided downstream and
recorded in the manifest with that reason. No resampling is performed,
because conditioning the draw on gold would reintroduce the leak.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
V2 = HERE.parent / "v2"
MASTER_SEED = "20261112-r3"
K = 4
REVIEW_VERSION = "v3-review/1"

STRIP_KEYS = ("acceptableSet", "polarity", "oracle", "hiddenTruth")


def canonical(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def content_hash(case: dict) -> str:
    payload = {
        "caseId": case["caseId"],
        "task": case["task"],
        "K": case["K"],
        "candidates": [{"id": c["id"], "text": c["text"], "params": c["params"]}
                       for c in case["candidates"]],
        "narrative": case["narrative"],
        "facts": case["facts"],
    }
    return hashlib.sha256(canonical(payload).encode("utf-8")).hexdigest()


def rng_for(case_id: str) -> random.Random:
    digest = hashlib.sha256(f"{MASTER_SEED}:{case_id}".encode("utf-8")).hexdigest()
    return random.Random(int(digest[:16], 16))


def task_vocab(v2_rows: list[dict]) -> tuple[dict[str, list[str]], dict]:
    """Action vocabulary per task, derived from candidate lists only."""
    vocab: dict[str, set[str]] = {}
    meta: dict[tuple[str, str], dict] = {}
    for row in v2_rows:
        for cand in row["candidates"]:
            vocab.setdefault(row["task"], set()).add(cand["id"])
            meta[(row["task"], cand["id"])] = cand
    return ({task: sorted(actions) for task, actions in vocab.items()}, meta)


def challenge_cases(adjudication: list[dict]) -> set[str]:
    ids = set()
    for row in adjudication:
        if row.get("action") == "challenge":
            ids.add(row["caseId"])
            ids.add(f"v2-{row['caseId']}")
    return ids


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=Path, default=V2 / "cases.jsonl")
    parser.add_argument("--adjudication", type=Path, default=V2 / "adjudication.jsonl")
    parser.add_argument("--out", type=Path, default=HERE / "cases.v3.jsonl")
    parser.add_argument("--sealed", type=Path, default=HERE / "labels.v3.sealed.jsonl")
    parser.add_argument("--no-summary", action="store_true",
                        help="skip writing generate-summary.json (validator reruns)")
    args = parser.parse_args()

    rows = [json.loads(line) for line in
            args.cases.read_text(encoding="utf-8").splitlines() if line.strip()]
    adjudication = [json.loads(line) for line in
                    args.adjudication.read_text(encoding="utf-8").splitlines() if line.strip()]
    challenged = challenge_cases(adjudication)

    # Gold-free view of the input, re-derivable by the validator.
    stripped = []
    for row in rows:
        clean = {key: value for key, value in row.items() if key not in STRIP_KEYS}
        stripped.append(clean)
    vocab, cand_meta = task_vocab(rows)

    out_cases: list[dict] = []
    sealed: list[dict] = []
    excluded_challenge: list[str] = []
    for row, clean in zip(rows, stripped):
        if row["caseId"] in challenged:
            excluded_challenge.append(row["caseId"])
            continue
        rng = rng_for(row["caseId"])
        actions = rng.sample(vocab[row["task"]], K)
        rng.shuffle(actions)
        candidates = [{
            "id": f"c{index}",
            "text": cand_meta[(row["task"], action)]["text"],
            "params": cand_meta[(row["task"], action)]["params"],
        } for index, action in enumerate(actions)]
        case = {
            "schema": "frostecho.jev04.case/3",
            "caseId": row["caseId"],
            "version": 3,
            "task": row["task"],
            "K": K,
            "candidates": candidates,
            "narrative": row["narrative"],
            "facts": row["facts"],
            "generatorSkeleton": row.get("generatorSkeleton"),
            "sourceGroup": row.get("sourceGroup"),
            "provenance": {
                "from": "v2/cases.jsonl@rev2",
                "generator": "generate_v3.py@rev1",
                "masterSeed": MASTER_SEED,
                "reviewVersion": REVIEW_VERSION,
                "challengeIsolated": True,
            },
        }
        out_cases.append(case)
        acceptable = list(row.get("acceptableSet", []))
        in_sample = [f"c{index}" for index, action in enumerate(actions)
                     if action in acceptable]
        sealed.append({
            "caseId": row["caseId"],
            "contentHash": content_hash(case),
            "acceptableActions": acceptable,
            "acceptableOpaque": in_sample,
            "answerable": bool(in_sample),
            "actionOrder": actions,
        })

    args.out.write_text(
        "".join(json.dumps(c, ensure_ascii=False) + "\n" for c in out_cases),
        encoding="utf-8")
    args.sealed.write_text(
        "".join(json.dumps(s, ensure_ascii=False) + "\n" for s in sealed),
        encoding="utf-8")

    answerable = sum(1 for s in sealed if s["answerable"])
    if not args.no_summary:
        summary = {
            "schema": "frostecho.jev04.v3-generate/1",
            "masterSeed": MASTER_SEED,
            "inputCases": len(rows),
            "challengeExcluded": len(excluded_challenge),
            "generated": len(out_cases),
            "answerable": answerable,
            "notAnswerable": len(out_cases) - answerable,
            "vocab": {task: sorted(actions) for task, actions in vocab.items()},
        }
        (HERE / "generate-summary.json").write_text(
            json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps(summary, ensure_ascii=False, indent=2))
    else:
        print(json.dumps({"generated": len(out_cases), "answerable": answerable},
                         ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
