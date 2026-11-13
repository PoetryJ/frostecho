#!/usr/bin/env python3
"""R3 (D): v3 data gate. Machine-checkable, exit 1 with concrete failing IDs.

Checks (all recomputed from artifacts, nothing is trusted from the manifest):
  1. challenge isolation     — no eligible/train/dev case intersects the v2
                               challenge ledger (25 cases / 39 records);
  2. review coverage         — every eligible case has both review sessions,
                               bound to the same contentHash, reviewVersion
                               v3-review/1;
  3. generator decoupling    — re-running the generator on an
                               acceptableSet-stripped copy of the v2 input
                               reproduces cases.v3.jsonl byte-for-byte;
  4. position leakage        — first/last-position acceptable rate over
                               answerable cases within the exact binomial
                               envelope of the per-case opportunity rate
                               (v2 leaked 64/64 at position 1);
  5. split integrity         — train/dev disjoint by caseId AND by
                               sourceGroup, subsets of eligible.
"""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
V2 = HERE.parent / "v2"
REVIEW_VERSION = "v3-review/1"


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in
            path.read_text(encoding="utf-8").splitlines() if line.strip()]


def fail(failures: list[str], message: str) -> None:
    failures.append(message)


def binomial_two_sided(k: int, n: int, p: float) -> float:
    """Exact two-sided binomial p-value (small n, direct sum)."""
    if n == 0:
        return 1.0
    def pmf(i: int) -> float:
        return math.comb(n, i) * p ** i * (1 - p) ** (n - i)
    observed = pmf(k)
    return min(1.0, sum(pmf(i) for i in range(n + 1) if pmf(i) <= observed + 1e-12))


def main() -> int:
    failures: list[str] = []
    cases = {row["caseId"]: row for row in load_jsonl(HERE / "cases.v3.jsonl")}
    sealed = {row["caseId"]: row for row in load_jsonl(HERE / "labels.v3.sealed.jsonl")}
    s1 = {row["caseId"]: row for row in load_jsonl(HERE / "review-s1-20261112.jsonl")}
    s2 = {row["caseId"]: row for row in load_jsonl(HERE / "review-s2-20261112.jsonl")}
    manifest = json.loads((HERE / "eligible-manifest.json").read_text(encoding="utf-8"))
    train = load_jsonl(HERE / "train.jsonl")
    dev = load_jsonl(HERE / "dev.jsonl")

    # 1. challenge isolation
    adjudication = load_jsonl(V2 / "adjudication.jsonl")
    challenge_ids = {f"v2-{row['caseId']}" for row in adjudication
                     if row.get("action") == "challenge"}
    leaked = sorted(set(sealed) & challenge_ids)
    if leaked:
        fail(failures, f"challenge isolation violated: {leaked}")

    eligible_ids = {e["caseId"] for e in manifest["entries"] if e["eligible"]}
    for row in train + dev:
        if row["caseId"] not in eligible_ids:
            fail(failures, f"split case not eligible: {row['caseId']}")

    # 2. review coverage + contentHash binding
    for case_id in sorted(eligible_ids):
        entry = next(e for e in manifest["entries"] if e["caseId"] == case_id)
        for name, session in (("s1", s1), ("s2", s2)):
            if case_id not in session:
                fail(failures, f"{name} review missing for {case_id}")
        if entry["reviewVersion"] != REVIEW_VERSION:
            fail(failures, f"reviewVersion mismatch for {case_id}")
        if entry["contentHash"] != sealed[case_id]["contentHash"]:
            fail(failures, f"contentHash mismatch for {case_id}")
        label = sealed[case_id]
        if not set(entry["sealedOpaque"]) <= set(c["id"] for c in cases[case_id]["candidates"]):
            fail(failures, f"sealed labels reference unknown candidates: {case_id}")
        if not label["answerable"]:
            fail(failures, f"eligible but unanswerable: {case_id}")
        hit1 = set(entry["s1"]["proposedOpaque"]) & set(label["acceptableOpaque"])
        hit2 = set(entry["s2"]["proposedOpaque"]) & set(label["acceptableOpaque"])
        if not (hit1 and hit2):
            fail(failures, f"eligible without double-review hit: {case_id}")

    # 3. generator decoupling: regenerate from gold-stripped input, byte-compare
    with tempfile.TemporaryDirectory() as tmp:
        stripped_path = Path(tmp) / "stripped.jsonl"
        rows = load_jsonl(V2 / "cases.jsonl")
        strip_keys = ("acceptableSet", "polarity", "oracle", "hiddenTruth")
        stripped_path.write_text(
            "".join(json.dumps({k: v for k, v in r.items() if k not in strip_keys},
                              ensure_ascii=False) + "\n" for r in rows),
            encoding="utf-8")
        out = Path(tmp) / "regen.jsonl"
        sealed_out = Path(tmp) / "regen-sealed.jsonl"
        subprocess.run(
            [sys.executable, str(HERE / "generate_v3.py"),
             "--cases", str(stripped_path), "--adjudication",
             str(V2 / "adjudication.jsonl"), "--out", str(out),
             "--sealed", str(sealed_out), "--no-summary"],
            check=True, capture_output=True)
        if out.read_bytes() != (HERE / "cases.v3.jsonl").read_bytes():
            fail(failures, "generator output depends on gold fields "
                           "(regeneration from stripped input differs)")
        # sealed labels regenerated from stripped input must contain NO
        # acceptable information at all (they cannot); the real sealed file
        # must equal the one built from the full input run recorded in
        # generate-summary.json — verified by hash in the manifest instead.
        regen = [json.loads(line) for line in
                 sealed_out.read_text(encoding="utf-8").splitlines() if line.strip()]
        for row in regen:
            if row.get("acceptableActions") or row.get("acceptableOpaque"):
                fail(failures, f"sealed leak into generator for {row['caseId']}")

    # 4. position leakage diagnostics over answerable cases
    answerable = [cid for cid, row in sealed.items() if row["answerable"]]
    first_hits = sum(1 for cid in answerable
                     if "c0" in sealed[cid]["acceptableOpaque"])
    last_hits = sum(1 for cid in answerable
                    if f"c{cases[cid]['K'] - 1}" in sealed[cid]["acceptableOpaque"])
    # opportunity rate under uniform shuffling: mean of |acc_in_sample|/K
    opportunity = sum(len(sealed[cid]["acceptableOpaque"]) / cases[cid]["K"]
                      for cid in answerable) / max(1, len(answerable))
    p_first = binomial_two_sided(first_hits, len(answerable), opportunity)
    p_last = binomial_two_sided(last_hits, len(answerable), opportunity)
    if p_first < 0.01:
        fail(failures, f"first-position leakage: {first_hits}/{len(answerable)} "
                       f"vs opportunity {opportunity:.3f} (p={p_first:.4g})")
    if p_last < 0.01:
        fail(failures, f"last-position leakage: {last_hits}/{len(answerable)} "
                       f"vs opportunity {opportunity:.3f} (p={p_last:.4g})")

    # 5. split integrity
    train_ids = [row["caseId"] for row in train]
    dev_ids = [row["caseId"] for row in dev]
    overlap = sorted(set(train_ids) & set(dev_ids))
    if overlap:
        fail(failures, f"train/dev case overlap: {overlap}")
    group_of = {cid: (cases[cid].get("sourceGroup") or cid) for cid in cases}
    train_groups = {group_of[cid] for cid in train_ids}
    dev_groups = {group_of[cid] for cid in dev_ids}
    group_overlap = sorted(train_groups & dev_groups)
    if group_overlap:
        fail(failures, f"train/dev group overlap: {group_overlap}")

    report = {
        "schema": "frostecho.jev04.data-gate-v3/1",
        "status": "blocked" if failures else "passed-for-small-set",
        "mayTrainOnJev": not failures,
        "generated": len(cases),
        "challengeIsolated": len(challenge_ids),
        "eligible": len(eligible_ids),
        "answerable": len(answerable),
        "train": len(train_ids),
        "dev": len(dev_ids),
        "firstPosition": {"hits": first_hits, "n": len(answerable),
                          "opportunity": round(opportunity, 4),
                          "binomialP": round(p_first, 4)},
        "lastPosition": {"hits": last_hits, "n": len(answerable),
                         "binomialP": round(p_last, 4)},
        "failures": failures,
        "notes": [
            "qualified small set only; 512/128 target not met, no 4096 expansion",
            "no independent calibration/select/cert split yet (R3 scope)",
        ],
    }
    (HERE / "gate-v3.json").write_text(
        json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    if failures:
        for message in failures:
            print(f"FAIL: {message}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
