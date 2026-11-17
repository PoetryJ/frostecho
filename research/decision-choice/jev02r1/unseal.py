#!/usr/bin/env python3
"""One-shot unseal and scoring.

Runs as its own process, after the prediction hashes are fixed. It refuses to run
twice, verifies every recorded hash, recomputes decisions from the raw scores and
the frozen policy (never from the prediction file's own arithmetic), and reports
the diagnostic grid curves that were pre-registered before unsealing.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import r1config as R
from evalr1 import (accuracy_table, group_bootstrap, nll_brier, per_class_family, rows_for_order,
                    selective_table, ece)
from policy import decide, load_policy
from r1config import CLASSES, ORDERS, PAIR, RESULTS, SINGLE, THRESHOLDS, read_json, read_jsonl

J_PATTERN = re.compile(r'^\s*\{\s*"selectedId"\s*:\s*"([A-D])"\s*\}\s*(<\|im_end\|>)?\s*$')


def _verify_record(record: dict, out: Path) -> None:
    for name, digest in record["predictions"].items():
        path = out / name
        if not path.exists():
            raise SystemExit(f"missing sealed prediction {path}")
        if R.sha256_file(path) != digest:
            raise SystemExit(f"sealed prediction bytes changed: {name}")
    for method, info in record["policies"].items():
        if R.sha256_file(R.POLICIES / f"{method}.json") != info["sha256"]:
            raise SystemExit(f"policy changed after sealing: {method}")
    if R.sha256_file(R.CACHE / "features-test.npz") != record["features"]["npzSha256"]:
        raise SystemExit("test feature cache changed after sealing")


def _gold() -> dict:
    payload = read_json(R.DATA / "test.gold.json")
    gold = payload["gold"]
    if R.sha256_json(gold) != payload["sha256"]:
        raise SystemExit("gold file does not match its own sha256")
    if len(gold) != R.SPLITS["test"]:
        raise SystemExit(f"gold has {len(gold)} cases, expected {R.SPLITS['test']}")
    return gold


def _items_from_scores(scores: list[dict], policy: dict, gold: dict) -> list[dict]:
    by_case: dict[str, dict[int, list[float]]] = {}
    for row in scores:
        by_case.setdefault(row["caseId"], {})[int(row["order"])] = row["logits"]
    items = []
    for case_id, logits in by_case.items():
        entry = gold[case_id]
        per_order = rows_for_order(policy, logits)
        for key, value in per_order.items():
            probs = value["probs"]
            items.append({"caseId": case_id, "order": key, "family": entry["family"],
                          "label": entry["labelId"], "candidateId": value["candidateId"],
                          "probs": probs, "agree": value.get("agree", True),
                          "score": value.get("score", max(probs.values()))})
    items.sort(key=lambda row: (row["order"], row["caseId"]))
    return items


def _json_arm(out: Path, gold: dict) -> dict:
    rows = read_jsonl(out / "test-json-generations.jsonl")
    predictions = []
    for row in rows:
        match = J_PATTERN.match(row["rawText"])
        order = int(row["order"])
        candidate = ORDERS[order][R.LETTERS.index(match.group(1))] if match else None
        predictions.append({"caseId": row["caseId"], "order": order,
                            "candidateId": candidate, "parsedOk": bool(match),
                            "family": gold[row["caseId"]]["family"],
                            "label": gold[row["caseId"]]["labelId"]})
    table = accuracy_table(predictions, gold)
    table["parseRate"] = round(sum(1 for row in predictions if row["parsedOk"]) / len(predictions), 6)
    table["n"] = len(predictions)
    return table


def _policy_block(method: str, policy: dict, items: list[dict], gold: dict) -> dict:
    tau = policy["tau"]
    if not policy["valid"] or tau is None:
        return {"policyValid": False, "coverage": 0.0, "accepted": 0,
                "risk": None, "decision": "unavailable",
                "note": "no frozen threshold satisfied every gate on cal-policy; "
                        "the test split does not get to choose one"}
    table = selective_table(items, float(tau), method)
    table["perClassFamily"] = per_class_family(items, float(tau), gold)
    table["bootstrap"] = group_bootstrap(items, float(tau))
    accepted = [item for item in items if item["candidateId"] is not None and item["score"] >= float(tau)]
    table["acceptedBases"] = len({item["caseId"] for item in accepted})
    table["acceptDecisions"] = len(accepted)
    table["totalDecisions"] = len(items)
    table["accuracyAmongAccepted"] = round(
        sum(1 for item in accepted if item["candidateId"] == item["label"]) / len(accepted), 6
    ) if accepted else None
    return {"policyValid": True, "tau": tau, "decision": "selective", **table}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(RESULTS))
    parser.add_argument("--record", default=str(RESULTS / "unseal-record.json"))
    parser.add_argument("--attempt", type=int, default=1)
    parser.add_argument("--reason", default="")
    args = parser.parse_args(argv)
    out = Path(args.out)
    attempt = out / f"unseal-attempt-{args.attempt}.json"
    if args.attempt > 1 and not args.reason:
        raise SystemExit("a repeated scoring pass must state --reason")
    if attempt.exists():
        raise SystemExit(f"unseal attempt {args.attempt} already exists; a repeated unseal is refused")

    record = read_json(Path(args.record))
    _verify_record(record, out)
    attempt.write_text(json.dumps({"schema": "frostecho.jev02r1.unseal-attempt/1",
                                   "attempt": args.attempt, "reason": args.reason,
                                   "at": R.now_iso(), "status": "started"}) + "\n", encoding="utf-8")
    gold = _gold()
    scores = read_jsonl(out / "test-scores.jsonl")

    policies = {method: load_policy(R.POLICIES / f"{method}.json", check_files=False)
                for method in (SINGLE, PAIR)}
    calibration = read_json(RESULTS / "calibration.json")

    result = {"schema": "frostecho.jev02r1.results/1", "at": R.now_iso(),
              "test": {"cases": len(gold), "families": len({v["family"] for v in gold.values()}),
                       "unsealCount": args.attempt},
              "scoringPass": {"attempt": args.attempt, "reason": args.reason,
                              "sealedPredictionsUnchanged": True},
              "calibration": calibration, "policies": {}, "arms": {}}

    for method, policy in policies.items():
        items = _items_from_scores(scores, policy, gold)
        sealed = read_jsonl(out / f"test-predictions-{method}.jsonl")
        # Compare the *decision* the sealed file claims with the decision the
        # frozen policy yields from the raw scores, not a per-order argmax.
        recomputed = {case_id: decide(policy, _logits_for(scores, case_id))
                      for case_id in {row["caseId"] for row in sealed}}
        mismatch = [row["caseId"] for row in sealed
                    if row["candidateId"] != recomputed[row["caseId"]]["candidateId"]
                    or row["decision"] != recomputed[row["caseId"]]["decision"]]
        result["policies"][method] = _policy_block(method, policy, items, gold)
        result["policies"][method]["sealedPredictionMismatches"] = len(mismatch)
        result["policies"][method]["ungated"] = accuracy_table(
            [{"caseId": item["caseId"], "order": item["order"], "candidateId":
              max(item["probs"], key=item["probs"].get), "family": item["family"],
              "label": item["label"]} for item in items], gold)
        if method == PAIR:
            agreed = [item for item in items if item.get("agree") is not False]
            result["policies"][method]["consensus"] = {
                "pairs": len(items),
                "agreed": len(agreed),
                "agreementRate": round(len(agreed) / len(items), 6),
                "accuracyAmongAgreed": round(
                    sum(1 for item in agreed if item["candidateId"] == item["label"]) / len(agreed), 6
                ) if agreed else None,
                "disagreementRate": round(1 - len(agreed) / len(items), 6),
            }
        result["policies"][method]["calibrationQuality"] = {
            "atT1": _quality(scores, policy, gold, 1.0),
            "atAdoptedT": _quality(scores, policy, gold, float(policy["temperature"])),
        }

    # Pre-registered diagnostic arms: same frozen grid, no adoption this round.
    for label, temperature in (("T1", 1.0), ("TFit", float(calibration["temperatureFit"]["T"]))):
        for method, policy in policies.items():
            arm_policy = {**policy, "temperature": temperature,
                          "allowedOrders": list(R.SUPPORTED_ORDERS) if method == SINGLE else [],
                          "allowedPairs": [list(pair) for pair in R.SUPPORTED_PAIRS] if method == PAIR else []}
            items = _items_from_scores(scores, arm_policy, gold)
            curve = []
            for tau in THRESHOLDS:
                table = selective_table(items, tau, method)
                curve.append({"tau": tau, "meanCoverage": table["meanCoverage"],
                              "pooledRisk": table["pooled"]["risk"],
                              "accepted": table["pooled"]["accepted"],
                              "perSupported": {key: {"risk": value["risk"],
                                                     "coverage": value["coverage"],
                                                     "accepted": value["accepted"]}
                                               for key, value in table["perSupported"].items()}})
            result["arms"][f"{method}@{label}"] = {
                "temperature": temperature, "diagnosticOnly": True,
                "note": "pre-registered grid applied for comparison; not an approved operating point",
                "curve": curve,
                "chosenTau": policy["tau"] if label == ("TFit" if calibration["adoptedTfit"] else "T1") else None,
                "ungated": accuracy_table(
                    [{"caseId": item["caseId"], "order": item["order"], "candidateId":
                      max(item["probs"], key=item["probs"].get), "family": item["family"],
                      "label": item["label"]} for item in items], gold)["combined"],
            }

    result["jsonBaseline"] = _json_arm(out, gold)
    result["cost"] = {"ledger": read_json(R.EVIDENCE / "extract-summary.json")["ledger"],
                      "latency": read_json(RESULTS / "latency.json")["summary"]
                      if (RESULTS / "latency.json").exists() else None}
    R.write_json(out / "final.json", result)
    attempt.write_text(json.dumps({"schema": "frostecho.jev02r1.unseal-attempt/1",
                                   "attempt": args.attempt, "reason": args.reason,
                                   "at": R.now_iso(), "status": "completed",
                                   "predictionHashes": record["predictions"]}) + "\n",
                        encoding="utf-8")
    print(json.dumps({method: {key: result["policies"][method].get(key) for key in
                               ("policyValid", "coverage", "risk", "acceptedBases")}
                      for method in policies}, ensure_ascii=False, indent=1))
    return 0


def _quality(scores: list[dict], policy: dict, gold: dict, temperature: float) -> dict:
    """NLL/Brier/ECE over all base x supported presentations at one temperature."""
    rows = []
    for case_id in sorted({row["caseId"] for row in scores}):
        per_order = rows_for_order({**policy, "temperature": temperature},
                                   _logits_for(scores, case_id))
        for value in per_order.values():
            rows.append({"probs": value["probs"], "label": gold[case_id]["labelId"]})
    return {**nll_brier(rows), "ece": ece(rows)["ece"]}


def _logits_for(scores: list[dict], case_id: str) -> dict[int, list[float]]:
    return {int(row["order"]): row["logits"] for row in scores if row["caseId"] == case_id}


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
