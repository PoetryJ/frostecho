#!/usr/bin/env python3
"""Calibration and threshold selection on the two calibration splits only.

Order of operations (contract 22-26), all before the test file is unsealed:
1. fit one positive T on cal-temperature with base x order equal weight;
2. compare T=1 vs Tfit on cal-policy by NLL and Brier; adopt Tfit only if it is
   not worse on both;
3. sweep the frozen grid on cal-policy for S1 (four orders) and S2 (two pairs);
4. accept a tau only if EVERY supported order/pair clears risk, base-count and
   per-class-count gates; otherwise the policy is `valid=false` with no tau.
"""
from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import r1config as R
from evalr1 import (accepted_per_class, gate, nll_brier, rows_for_order, selective_table)
from policy import build_policy, save_policy, stable_probs
from r1config import CLASSES, ORDERS, PAIR, SINGLE, THRESHOLDS


def _ce(logits: list[float], target: int, temperature: float) -> float:
    scaled = [value / temperature for value in logits]
    peak = max(scaled)
    logsum = peak + math.log(sum(math.exp(value - peak) for value in scaled))
    return logsum - scaled[target]


def mean_ce(scores: list[dict], temperature: float) -> float:
    return sum(_ce(row["logits"], row["labelIndex"], temperature) for row in scores) / len(scores)


def fit_temperature(scores: list[dict]) -> dict:
    """Golden-section search on log T; every (base, order) row counts once."""
    low, high = math.log(0.02), math.log(50.0)
    ratio = (math.sqrt(5) - 1) / 2
    for _ in range(120):
        left = high - ratio * (high - low)
        right = low + ratio * (high - low)
        if mean_ce(scores, math.exp(left)) <= mean_ce(scores, math.exp(right)):
            high = right
        else:
            low = left
    temperature = math.exp((low + high) / 2)
    return {"T": temperature, "nll": mean_ce(scores, temperature),
            "nllAt1": mean_ce(scores, 1.0), "rows": len(scores)}


def items_for(method: str, scores: list[dict], temperature: float) -> list[dict]:
    by_case: dict[str, dict[int, list[float]]] = {}
    meta: dict[str, dict] = {}
    for row in scores:
        by_case.setdefault(row["caseId"], {})[int(row["order"])] = row["logits"]
        meta[row["caseId"]] = {"label": row["labelId"], "family": row["family"]}
    rows = []
    for case_id, logits in by_case.items():
        per_order = rows_for_order({"method": method, "temperature": temperature,
                                    "allowedOrders": list(R.SUPPORTED_ORDERS),
                                    "allowedPairs": [list(pair) for pair in R.SUPPORTED_PAIRS]},
                                   logits)
        for key, value in per_order.items():
            probs = value["probs"]
            rows.append({"caseId": case_id, "order": key, "family": meta[case_id]["family"],
                         "label": meta[case_id]["label"],
                         "candidateId": value["candidateId"], "probs": probs,
                         "agree": value.get("agree", True),
                         "score": value.get("score", max(probs.values()))})
    rows.sort(key=lambda row: (row["order"], row["caseId"]))
    return rows


def sweep(method: str, items: list[dict]) -> list[dict]:
    tables = []
    for tau in THRESHOLDS:
        table = selective_table(items, tau, method)
        per_class = accepted_per_class(items, tau)
        verdict = gate(table, R.MAX_RISK, R.MIN_ACCEPTED_BASES, R.MIN_ACCEPTED_PER_CLASS, per_class)
        table["gate"] = verdict
        table["acceptedPerClass"] = per_class
        tables.append(table)
    return tables


def select(tables: list[dict]) -> dict | None:
    feasible = [table for table in tables if table["gate"]["passes"]]
    if not feasible:
        return None
    feasible.sort(key=lambda table: (-table["meanCoverage"], -table["tau"]))
    return feasible[0]


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--temp-scores", default=str(R.RESULTS / "cal-scores-temperature.jsonl"))
    parser.add_argument("--policy-scores", default=str(R.RESULTS / "cal-scores-policy.jsonl"))
    args = parser.parse_args(argv)

    from r1config import read_jsonl, sha256_file, split_file, write_json, write_jsonl
    temp_scores = read_jsonl(Path(args.temp_scores))
    policy_scores = read_jsonl(Path(args.policy_scores))
    if {row["caseId"] for row in temp_scores} & {row["caseId"] for row in policy_scores}:
        raise SystemExit("cal-temperature and cal-policy share a case; family isolation is broken")

    fit = fit_temperature(temp_scores)

    # T decision uses cal-policy NLL/Brier, never the test split.
    def flat(scores: list[dict], temperature: float) -> list[dict]:
        return [{"probs": stable_probs(int(row["order"]), row["logits"], temperature),
                 "label": row["labelId"]} for row in scores]

    nll_one = nll_brier(flat(policy_scores, 1.0))
    nll_fit = nll_brier(flat(policy_scores, fit["T"]))
    adopt_fit = nll_fit["nll"] <= nll_one["nll"] and nll_fit["brier"] <= nll_one["brier"]
    temperature = fit["T"] if adopt_fit else 1.0
    write_json(R.RESULTS / "calibration.json", {
        "schema": "frostecho.jev02r1.calibration/1",
        "at": R.now_iso(),
        "temperatureFit": {key: round(value, 8) if isinstance(value, float) else value
                           for key, value in fit.items()},
        "calPolicyT1": nll_one, "calPolicyTFit": {key: round(v, 8) if isinstance(v, float) else v
                                                  for key, v in nll_fit.items()},
        "adoptedTfit": adopt_fit,
        "temperature": temperature,
        "rule": "Tfit adopted only if NLL and Brier on cal-policy are both not worse than T=1",
        "calTemperatureSha256": sha256_file(split_file("cal-temperature")),
        "calPolicySha256": sha256_file(split_file("cal-policy")),
        "cases": {"temperature": len({r["caseId"] for r in temp_scores}),
                  "policy": len({r["caseId"] for r in policy_scores})},
        "grid": list(THRESHOLDS),
    })

    arms = {"T1": 1.0, "TFit": fit["T"]}
    bundles = {}
    for label, temp in arms.items():
        for method in (SINGLE, PAIR):
            items = items_for(method, policy_scores, temp)
            tables = sweep(method, items)
            bundles[f"{method}@{label}"] = tables
    write_json(R.RESULTS / "candidate-tables.json", {
        "schema": "frostecho.jev02r1.candidate-tables/1",
        "at": R.now_iso(),
        "note": "cal-policy only; four orders are presentations of the same base case",
        "arms": {key: {"temperature": arms[key.split("@")[1]],
                       "tables": value} for key, value in bundles.items()},
    })

    selection = {}
    for method in (SINGLE, PAIR):
        arm = "TFit" if adopt_fit else "T1"
        tables = bundles[f"{method}@{arm}"]
        chosen = select(tables)
        if chosen is None:
            policy = build_policy(
                valid=False, method=method, temperature=temperature, tau=None,
                calibration={"calTemperatureSha256": sha256_file(split_file("cal-temperature")),
                             "calPolicySha256": sha256_file(split_file("cal-policy")),
                             "temperatureFit": fit["T"], "adoptedTfit": adopt_fit},
                selection={"supported": "all_orders" if method == SINGLE else "both_pairs",
                           "gate": {"maxRisk": R.MAX_RISK, "minAcceptedBases": R.MIN_ACCEPTED_BASES,
                                    "minAcceptedPerClass": R.MIN_ACCEPTED_PER_CLASS},
                           "failingTaus": [{"tau": table["tau"], "failures": table["gate"]["failures"],
                                            "meanCoverage": table["meanCoverage"],
                                            "pooledRisk": table["pooled"]["risk"]} for table in tables]},
                notes="no frozen threshold satisfied every gate on cal-policy; policy unavailable")
        else:
            policy = build_policy(
                valid=True, method=method, temperature=temperature, tau=chosen["tau"],
                calibration={"calTemperatureSha256": sha256_file(split_file("cal-temperature")),
                             "calPolicySha256": sha256_file(split_file("cal-policy")),
                             "temperatureFit": fit["T"], "adoptedTfit": adopt_fit},
                selection={"supported": "all_orders" if method == SINGLE else "both_pairs",
                           "gate": {"maxRisk": R.MAX_RISK, "minAcceptedBases": R.MIN_ACCEPTED_BASES,
                                    "minAcceptedPerClass": R.MIN_ACCEPTED_PER_CLASS},
                           "chosenTau": chosen["tau"], "meanCoverage": chosen["meanCoverage"],
                           "perSupported": chosen["perSupported"]},
                selection_facts={"arm": arm, "allTaus": [
                    {"tau": table["tau"], "meanCoverage": table["meanCoverage"],
                     "pooled": table["pooled"], "gatePasses": table["gate"]["passes"],
                     "failures": table["gate"]["failures"]} for table in tables]},
                notes="threshold chosen on cal-policy only; four orders/pairs are presentations")
        path = R.POLICIES / f"{method}.json"
        digest = save_policy(path, policy)
        selection[method] = {"path": str(path), "policySha256": digest, "valid": policy["valid"],
                             "tau": policy["tau"], "temperature": policy["temperature"]}
        print(f"{method}: valid={policy['valid']} tau={policy['tau']} T={policy['temperature']:.6f}")

    write_json(R.RESULTS / "selection.json", selection)
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
