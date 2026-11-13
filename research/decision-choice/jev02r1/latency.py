#!/usr/bin/env python3
"""Online-cost measurement at the real model-call boundary.

S1 charges one forward per measurement. S2 charges each of its two forwards
separately (the pair total is the sum, not a discounted single call).
"""
from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import r1config as R
from guards import GoldSeal
from policy import decide, load_policy
from r1config import PAIR, RESULTS, SINGLE, inputs_file, read_jsonl, write_json


def run_latency(model, ledger, s1_policy: dict, s2_policy: dict, cases: list[dict], out: Path) -> dict:
    import torch
    from heads.train import load_head
    heads = {}
    for method, policy in ((SINGLE, s1_policy), (PAIR, s2_policy)):
        head, _ = load_head(Path(policy["head"]["path"]), device="cuda:0")
        heads[method] = head
    mechanism_only = not (s1_policy["valid"] or s2_policy["valid"])

    rows = []
    # S1: one forward per measurement, alternating across two orders so no single
    # presentation owns the timing.
    for index, case in enumerate(cases):
        order = int(s1_policy["allowedOrders"][index % len(s1_policy["allowedOrders"])])
        job = ledger.reserve(f"latency-s1-{case['caseId']}-{order}", "forward", "latency-s1")
        ledger.begin(job); tick = time.time()
        try:
            feature = model.features(case, order)
        except Exception as error:
            ledger.fail(job, str(error), prefill=1, seconds=time.time() - tick)
            raise
        elapsed = time.time() - tick
        with torch.no_grad():
            logits = [float(value) for value in
                      heads[SINGLE](feature["cand"].float().unsqueeze(0).cuda())[0].cpu()]
        ledger.finish(job, prefill=1, decode=0, tokens_in=feature["tokensIn"], tokens_out=0,
                      seconds=elapsed)
        rows.append({"method": SINGLE, "caseId": case["caseId"], "order": order,
                     "forwards": 1, "tokensIn": feature["tokensIn"],
                     "e2eMs": round(elapsed * 1000, 3),
                     "mechanismCostOnly": mechanism_only})

    # S2: two real forwards per pair, each charged as its own job.
    for index, case in enumerate(cases[: max(1, len(cases) // 2)]):
        pair = s2_policy["allowedPairs"][index % len(s2_policy["allowedPairs"])]
        logits = {}
        pair_started = time.time()
        for order in (int(pair[0]), int(pair[1])):
            job = ledger.reserve(f"latency-s2-{case['caseId']}-{order}", "forward", "latency-s2")
            ledger.begin(job); tick = time.time()
            try:
                feature = model.features(case, order)
            except Exception as error:
                ledger.fail(job, str(error), prefill=1, seconds=time.time() - tick)
                raise
            elapsed = time.time() - tick
            with torch.no_grad():
                logits[order] = [float(value) for value in
                                 heads[PAIR](feature["cand"].float().unsqueeze(0).cuda())[0].cpu()]
            ledger.finish(job, prefill=1, decode=0, tokens_in=feature["tokensIn"], tokens_out=0,
                          seconds=elapsed)
            rows.append({"method": PAIR, "caseId": case["caseId"], "order": order,
                         "pair": list(pair), "forwards": 1, "tokensIn": feature["tokensIn"],
                         "e2eMs": round(elapsed * 1000, 3),
                         "mechanismCostOnly": mechanism_only})
        if s2_policy["valid"]:
            decide(s2_policy, logits)
        rows.append({"method": PAIR, "caseId": case["caseId"], "pair": list(pair),
                     "forwards": 2, "pairTotalMs": round((time.time() - pair_started) * 1000, 3),
                     "decisionPath": True})

    summary = {}
    for method in (SINGLE, PAIR):
        values = [row["e2eMs"] for row in rows if row["method"] == method and "e2eMs" in row]
        summary[method] = {
            "forwards": len(values),
            "medianForwardMs": round(statistics.median(values), 3) if values else None,
            "minForwardMs": round(min(values), 3) if values else None,
            "maxForwardMs": round(max(values), 3) if values else None,
        }
    s2_single = summary[SINGLE]["medianForwardMs"]
    summary[SINGLE]["decisionMedianMs"] = s2_single
    summary[SINGLE]["decisionModelCalls"] = 1
    if summary[PAIR]["medianForwardMs"] is not None:
        summary[PAIR]["decisionMedianMs"] = round(2 * summary[PAIR]["medianForwardMs"], 3)
    summary[PAIR]["decisionModelCalls"] = 2
    summary["failurePolicy"] = "a failed or abandoned job stays charged; no retry in this round"
    write_json(out, {"schema": "frostecho.jev02r1.latency/1", "at": R.now_iso(),
                     "rows": rows, "summary": summary, "cases": len(cases),
                     "mechanismCostOnly": mechanism_only,
                     "note": ("no valid policy exists this round, so these are mechanism costs "
                              "(1 vs 2 forward calls), not an accepted decision path"
                              if mechanism_only else
                              "single live timing pass, not a p95 claim")})
    return summary


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", type=int, default=32)
    parser.add_argument("--out", default=str(RESULTS / "latency.json"))
    args = parser.parse_args(argv)
    from backends.local_qwen import LocalQwen
    from r1ledger import Ledger
    seal = GoldSeal([R.DATA / "test.gold.json", R.DATA / "test.labels.jsonl"])
    with seal:
        s1_policy = load_policy(R.POLICIES / f"{SINGLE}.json")
        s2_policy = load_policy(R.POLICIES / f"{PAIR}.json")
        model = LocalQwen()
        ledger = Ledger(R.EVIDENCE / "jobs.jsonl")
        cases = read_jsonl(inputs_file("test"))[: args.cases]
        summary = run_latency(model, ledger, s1_policy, s2_policy, cases, Path(args.out))
        write_json(R.EVIDENCE / "latency-seal.json", {**seal.report(), "at": R.now_iso()})
        print(json.dumps(summary, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
