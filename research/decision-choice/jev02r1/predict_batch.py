#!/usr/bin/env python3
"""Sealed test prediction pass.

Produces, before any gold read: raw per-order logits, the two policy decisions,
an ungated classifier view, and a hash record. Runs under GoldSeal, so a gold
read would raise instead of silently succeeding.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import r1config as R
from guards import GoldSeal
from policy import decide, load_policy, stable_probs
from r1config import CACHE, ORDERS, PAIR, RESULTS, SINGLE, read_jsonl, write_json, write_jsonl
from score import head_logits, load_features


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cache", default=str(CACHE / "features-test.npz"))
    parser.add_argument("--out", default=str(RESULTS))
    args = parser.parse_args(argv)
    out = Path(args.out)

    seal = GoldSeal([R.DATA / "test.gold.json", R.DATA / "test.labels.jsonl"])
    with seal:
        # Positive control: the prediction phase really does try to open the gold
        # and is refused, so "never read" is a behaviour, not a boolean claim.
        control = "not_attempted"
        try:
            open(R.DATA / "test.gold.json", encoding="utf-8")
        except Exception as error:
            control = f"blocked:{type(error).__name__}"
        policies = {method: load_policy(R.POLICIES / f"{method}.json") for method in (SINGLE, PAIR)}
        features = load_features(Path(args.cache))
        logits = head_logits(features)
        rows = []
        for index, scores in enumerate(logits):
            rows.append({"caseId": str(features["caseIds"][index]),
                         "order": int(features["orderIdx"][index]),
                         "logits": scores,
                         "idsSha256": str(features["idsSha256"][index]),
                         "renderedSha256": str(features["renderedSha256"][index]),
                         "tokensIn": int(features["tokensIn"][index])})
        rows.sort(key=lambda row: (row["caseId"], row["order"]))
        write_jsonl(out / "test-scores.jsonl", rows)

        by_case: dict[str, dict[int, list[float]]] = {}
        for row in rows:
            by_case.setdefault(row["caseId"], {})[int(row["order"])] = row["logits"]

        for method, policy in policies.items():
            predictions = []
            for case_id in sorted(by_case):
                result = decide(policy, by_case[case_id])
                record = {"caseId": case_id, "method": method, "policyValid": policy["valid"],
                          "decision": result["decision"], "candidateId": result["candidateId"],
                          "reason": result["reason"], "score": result["score"],
                          "gating": result["gating"], "temperature": policy["temperature"],
                          "tau": policy["tau"]}
                # Ungated view of the same frozen classifier (descriptive only).
                ungated = {}
                for order in range(4):
                    probs = stable_probs(order, by_case[case_id][order], policy["temperature"])
                    ungated[str(order)] = {"candidateId": max(probs, key=probs.get),
                                           "probabilities": probs}
                record["ungated"] = ungated
                predictions.append(record)
            write_jsonl(out / f"test-predictions-{method}.jsonl", predictions)
        seal_report = seal.report()

    record = {
        "schema": "frostecho.jev02r1.unseal-record/1",
        "at": R.now_iso(),
        "goldRead": False,
        "goldSealControl": control,
        "seal": seal_report,
        "policies": {method: {"sha256": R.sha256_file(R.POLICIES / f"{method}.json")}
                     for method in (SINGLE, PAIR)},
        "features": {"npzSha256": R.sha256_file(Path(args.cache)),
                     "metaSha256": R.sha256_file(CACHE / "features-test.meta.json")},
        "predictions": {name: R.sha256_file(out / name) for name in
                        ("test-scores.jsonl", f"test-predictions-{SINGLE}.jsonl",
                         f"test-predictions-{PAIR}.jsonl")},
    }
    write_json(out / "unseal-record.json", record)
    print(R.canonical({key: record["predictions"][key][:16] for key in record["predictions"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
