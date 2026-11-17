#!/usr/bin/env python3
"""Read-only re-verification.

Recomputes the decisions and the acceptance numbers from the raw score records,
the frozen policies and the adjudicated gold, then compares them to what was
reported. It never writes; the caller can check the results directory is
byte-identical afterwards.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import r1config as R
from evalr1 import rows_for_order, selective_table
from policy import decide, load_policy
from r1config import PAIR, RESULTS, SINGLE, read_json, read_jsonl


def sealed_records(out: Path, method: str) -> list[dict]:
    return read_jsonl(out / f"test-predictions-{method}.jsonl")


def _logits(scores: list[dict], case_id: str) -> dict[int, list[float]]:
    return {int(row["order"]): row["logits"] for row in scores if row["caseId"] == case_id}


def recompute(out: Path) -> dict:
    scores = read_jsonl(out / "test-scores.jsonl")
    gold = read_json(R.DATA / "test.gold.json")["gold"]
    by_case: dict[str, dict[int, list[float]]] = {}
    for row in scores:
        by_case.setdefault(row["caseId"], {})[int(row["order"])] = row["logits"]
    checks = {}
    for method in (SINGLE, PAIR):
        policy = load_policy(R.POLICIES / f"{method}.json", check_files=False)
        items = []
        for case_id, logits in by_case.items():
            for key, value in rows_for_order(policy, logits).items():
                probs = value["probs"]
                items.append({"caseId": case_id, "order": key, "family": gold[case_id]["family"],
                              "label": gold[case_id]["labelId"], "candidateId": value["candidateId"],
                              "probs": probs, "agree": value.get("agree", True),
                              "score": value.get("score", max(probs.values()))})
        sealed = {row["caseId"]: row for row in read_jsonl(out / f"test-predictions-{method}.jsonl")}
        decisions = {case_id: decide(policy, _logits(scores, case_id)) for case_id in sealed}
        candidate_mismatch = sum(
            1 for case_id, row in sealed.items()
            if row["candidateId"] != decisions[case_id]["candidateId"]
            or row["decision"] != decisions[case_id]["decision"])
        block = {"policyValid": policy["valid"], "candidateMismatch": candidate_mismatch,
                 "tau": policy["tau"], "temperature": policy["temperature"],
                 "decisionCounts": {name: sum(1 for row in sealed_records(out, method)
                                              if row["decision"] == name)
                                    for name in ("accept", "abstain", "unavailable")}}
        if policy["valid"]:
            table = selective_table(items, float(policy["tau"]), method)
            block["meanCoverage"] = table["meanCoverage"]
            block["pooledRisk"] = table["pooled"]["risk"]
            block["perSupported"] = {key: {"risk": value["risk"], "coverage": value["coverage"],
                                           "accepted": value["accepted"]}
                                     for key, value in table["perSupported"].items()}
        checks[method] = block
    return checks


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(RESULTS))
    args = parser.parse_args(argv)
    out = Path(args.out)
    reported = read_json(out / "final.json")
    recomputed = recompute(out)

    failures = []
    for method, block in recomputed.items():
        if block["candidateMismatch"]:
            failures.append(f"{method}: {block['candidateMismatch']} sealed predictions differ")
        truth = reported["policies"][method]
        if truth.get("policyValid") != block["policyValid"]:
            failures.append(f"{method}: validity differs")
        if block["policyValid"]:
            for key in ("meanCoverage", "pooledRisk"):
                if abs(float(truth[key]) - float(block[key])) > 1e-9:
                    failures.append(f"{method}: {key} {truth[key]} != {block[key]}")
            for order, value in block["perSupported"].items():
                reported_order = truth["perSupported"][order]
                if abs(float(reported_order["risk"]) - float(value["risk"])) > 1e-9:
                    failures.append(f"{method}/{order}: risk differs")
    record = read_json(out / "unseal-record.json")
    for name, digest in record["predictions"].items():
        if R.sha256_file(out / name) != digest:
            failures.append(f"prediction bytes changed: {name}")
    for method, info in record["policies"].items():
        if R.sha256_file(R.POLICIES / f"{method}.json") != info["sha256"]:
            failures.append(f"policy bytes changed: {method}")

    payload = {"schema": "frostecho.jev02r1.verify/1", "at": R.now_iso(),
               "checks": recomputed, "failures": failures, "passes": not failures}
    print(R.canonical({"passes": payload["passes"], "failures": failures[:10],
                       "methods": {method: {"valid": block["policyValid"],
                                            "coverage": block.get("meanCoverage"),
                                            "risk": block.get("pooledRisk")}
                                   for method, block in recomputed.items()}}))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
