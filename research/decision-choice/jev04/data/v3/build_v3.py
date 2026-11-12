#!/usr/bin/env python3
"""R3 (D): adjudication, eligible manifest and small qualified splits.

Combines the two new blind review sessions with the sealed labels:
  - eligible requires BOTH sessions to express at least one sealed-acceptable
    action on the rendered v3 item;
  - every exclusion carries a precise machine-checkable reason;
  - disagreements are adjudicated and recorded (D proposes, H rules);
  - splits are group-disjoint and drawn only from eligible cases.

The manifest binds (caseId, contentHash, reviewVersion); validate_v3.py
recomputes all three from the artifacts.
"""
from __future__ import annotations

import hashlib
import json
import random
from pathlib import Path

HERE = Path(__file__).resolve().parent
REVIEW_VERSION = "v3-review/1"
SPLIT_SEED = "20261112-r3-split"


def canonical(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in
            path.read_text(encoding="utf-8").splitlines() if line.strip()]


def main() -> int:
    cases = {row["caseId"]: row for row in load_jsonl(HERE / "cases.v3.jsonl")}
    sealed = {row["caseId"]: row for row in load_jsonl(HERE / "labels.v3.sealed.jsonl")}
    s1 = {row["caseId"]: row for row in load_jsonl(HERE / "review-s1-20261112.jsonl")}
    s2 = {row["caseId"]: row for row in load_jsonl(HERE / "review-s2-20261112.jsonl")}

    entries: list[dict] = []
    adjudications: list[dict] = []
    for case_id in sorted(cases):
        case = cases[case_id]
        label = sealed[case_id]
        review1, review2 = s1[case_id], s2[case_id]
        sealed_set = set(label["acceptableOpaque"])
        hit1 = sorted(set(review1["proposedOpaque"]) & sealed_set)
        hit2 = sorted(set(review2["proposedOpaque"]) & sealed_set)

        if not label["answerable"]:
            eligible, reason = False, "no-acceptable-in-sample"
            ruling = "sampling missed every acceptable action; no resample (would couple gold)"
        elif hit1 and hit2:
            eligible, reason = True, "double-reviewed-agree"
            ruling = "both sessions express a sealed-acceptable action"
        elif not hit1:
            eligible, reason = False, "s1-disjoint-from-sealed"
            ruling = ("rule-table session diverges from sealed labels; isolated as "
                      "challenge-v3 before training")
            adjudications.append({
                "caseId": case_id, "sealed": label["acceptableOpaque"],
                "s1": review1["proposedOpaque"], "s2": review2["proposedOpaque"],
                "action": "challenge", "ruling": ruling, "rulingBy": "H (sprint-r3)",
            })
        elif review2["note"].startswith("insufficient-info"):
            eligible, reason = False, "s2-insufficient-info"
            ruling = "narrative under-determines the label; excluded from training"
        else:
            eligible, reason = False, "s2-disjoint-from-sealed"
            ruling = ("narrative-only session confident but disjoint; isolated as "
                      "challenge-v3 before training")
            adjudications.append({
                "caseId": case_id, "sealed": label["acceptableOpaque"],
                "s1": review1["proposedOpaque"], "s2": review2["proposedOpaque"],
                "action": "challenge", "ruling": ruling, "rulingBy": "H (sprint-r3)",
            })
        entries.append({
            "caseId": case_id,
            "contentHash": label["contentHash"],
            "reviewVersion": REVIEW_VERSION,
            "eligible": eligible,
            "reason": reason,
            "s1": {"proposedOpaque": review1["proposedOpaque"],
                   "hit": hit1, "note": review1["note"]},
            "s2": {"proposedOpaque": review2["proposedOpaque"],
                   "hit": hit2, "note": review2["note"]},
            "sealedOpaque": label["acceptableOpaque"],
            "sourceGroup": case.get("sourceGroup"),
            "task": case["task"],
            "ruling": ruling,
        })

    eligible_ids = [e["caseId"] for e in entries if e["eligible"]]

    # Group-disjoint split over eligible cases only.
    groups: dict[str, list[str]] = {}
    for entry in entries:
        if entry["eligible"]:
            groups.setdefault(entry["sourceGroup"] or entry["caseId"], []).append(entry["caseId"])
    rng = random.Random(int(hashlib.sha256(SPLIT_SEED.encode()).hexdigest()[:16], 16))
    group_names = sorted(groups)
    rng.shuffle(group_names)
    dev_target = max(1, round(len(group_names) * 0.25))
    dev_groups, train_groups = set(group_names[:dev_target]), set(group_names[dev_target:])
    train_ids = sorted(cid for g in train_groups for cid in groups[g])
    dev_ids = sorted(cid for g in dev_groups for cid in groups[g])

    def write_split(ids: list[str], path: Path) -> None:
        rows = []
        for case_id in ids:
            case = cases[case_id]
            rows.append({
                "schema": "frostecho.jev04.split-case/3",
                "caseId": case_id,
                "task": case["task"],
                "K": case["K"],
                "candidates": case["candidates"],
                "narrative": case["narrative"],
                "acceptableOpaque": sealed[case_id]["acceptableOpaque"],
                "contentHash": sealed[case_id]["contentHash"],
                "reviewVersion": REVIEW_VERSION,
            })
        path.write_text("".join(json.dumps(r, ensure_ascii=False) + "\n" for r in rows),
                        encoding="utf-8")

    write_split(train_ids, HERE / "train.jsonl")
    write_split(dev_ids, HERE / "dev.jsonl")

    manifest = {
        "schema": "frostecho.jev04.eligible-manifest/1",
        "reviewVersion": REVIEW_VERSION,
        "generatedCases": len(entries),
        "eligible": len(eligible_ids),
        "excluded": {
            reason: sum(1 for e in entries if not e["eligible"] and e["reason"] == reason)
            for reason in sorted({e["reason"] for e in entries if not e["eligible"]})
        },
        "challengeV2Isolated": 25,
        "revisedInV2": ["v2-gQ07-A", "v2-gQ07-B"],
        "splits": {
            "train": {"cases": len(train_ids), "groups": sorted(train_groups)},
            "dev": {"cases": len(dev_ids), "groups": sorted(dev_groups)},
        },
        "artifacts": {
            name: {"sha256": sha256_file(HERE / name)}
            for name in ["cases.v3.jsonl", "labels.v3.sealed.jsonl",
                         "review-s1-20261112.jsonl", "review-s2-20261112.jsonl",
                         "train.jsonl", "dev.jsonl"]
        },
        "entries": entries,
    }
    (HERE / "eligible-manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (HERE / "adjudication-v3.jsonl").write_text(
        "".join(json.dumps(a, ensure_ascii=False) + "\n" for a in adjudications),
        encoding="utf-8")

    print(json.dumps({"eligible": len(eligible_ids),
                      "excluded": manifest["excluded"],
                      "train": len(train_ids), "dev": len(dev_ids),
                      "challengesV3": len(adjudications)}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
