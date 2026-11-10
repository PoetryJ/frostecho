#!/usr/bin/env python3
"""Single-case decision CLI.

There is exactly one source of T/tau: the policy artifact. Any identity or
parameter conflict is refused before the backbone is loaded or a job is charged.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import r1config as R
from policy import PolicyError, decide_one, load_policy, selected_orders, stable_probs


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="JEV-02R1 selective decision (policy-bound)")
    parser.add_argument("--policy", required=True)
    parser.add_argument("--context", required=True)
    parser.add_argument("--player", required=True)
    parser.add_argument("--order", type=int, default=None,
                        help="single_pass: the one presentation to forward")
    parser.add_argument("--pair", default=None,
                        help="reverse_pair_consensus: the two orders to forward, e.g. 0,1")
    parser.add_argument("--raw-scores", action="store_true",
                        help="research output; not an accepted decision")
    args = parser.parse_args(argv)

    try:
        policy = load_policy(Path(args.policy))
    except PolicyError as error:
        print(json.dumps({"error": "policy_rejected", "detail": str(error)}), file=sys.stderr)
        return 2
    method = policy["method"]
    # Exactly one presentation must be named; a conflict is refused before load.
    if method == R.SINGLE:
        if args.pair is not None:
            print(json.dumps({"error": "conflicting_presentation",
                              "detail": "single_pass takes --order, not --pair"}), file=sys.stderr)
            return 2
        if args.order is None:
            print(json.dumps({"error": "missing_presentation",
                              "detail": "single_pass requires --order"}), file=sys.stderr)
            return 2
        selected = args.order
    else:
        if args.order is not None:
            print(json.dumps({"error": "conflicting_presentation",
                              "detail": "reverse_pair_consensus takes --pair, not --order"}),
                  file=sys.stderr)
            return 2
        if args.pair is None:
            print(json.dumps({"error": "missing_presentation",
                              "detail": "reverse_pair_consensus requires --pair"}), file=sys.stderr)
            return 2
        try:
            selected = [int(value) for value in args.pair.split(",")]
        except ValueError:
            print(json.dumps({"error": "bad_pair", "detail": args.pair}), file=sys.stderr)
            return 2
    try:
        orders = selected_orders(policy, selected)
    except PolicyError as error:
        print(json.dumps({"error": "presentation_rejected", "detail": str(error)}), file=sys.stderr)
        return 2

    if policy["decisionMode"] == "unavailable" and not args.raw_scores:
        print(json.dumps({"schema": "frostecho.jev02r1.decision/1",
                          "decision": "unavailable", "candidateId": None,
                          "reason": "policy_invalid", "policyValid": False,
                          "method": method, "note": "no frozen threshold passed the gates"}, indent=2))
        return 0

    import torch
    from backends.local_qwen import LocalQwen
    from heads.train import load_head
    from r1ledger import Ledger

    head, _ = load_head(Path(policy["head"]["path"]), device="cuda:0")
    model = LocalQwen()
    ledger = Ledger(R.EVIDENCE / "jobs.jsonl")
    case = {"visibleInput": {"context": args.context, "playerText": args.player}}

    logits = {}
    timings = []
    for index in orders:
        job = ledger.reserve(
            f"demo-{method}-{'-'.join(map(str, orders))}-{index}-{int(time.time() * 1000)}",
            "forward", "demo")
        ledger.begin(job)
        tick = time.time()
        try:
            feature = model.features(case, index)
        except Exception as error:
            ledger.fail(job, str(error), prefill=1, seconds=time.time() - tick)
            raise
        ledger.finish(job, prefill=1, decode=0, tokens_in=feature["tokensIn"], tokens_out=0,
                      seconds=time.time() - tick)
        with torch.no_grad():
            logits[index] = [float(value) for value in
                             head(feature["cand"].float().unsqueeze(0).cuda())[0].cpu()]
        timings.append({"order": index, "ms": round((time.time() - tick) * 1000, 3),
                        "tokensIn": feature["tokensIn"]})

    if policy["valid"]:
        result = decide_one(policy, logits, selected)
    else:
        result = {"decision": "unavailable", "candidateId": None, "reason": "policy_invalid",
                  "score": None, "gating": None}
    payload = {
        "schema": "frostecho.jev02r1.decision/1",
        "decision": result["decision"],
        "candidateId": result["candidateId"],
        "reason": result["reason"],
        "score": result["score"],
        "gating": result["gating"],
        "policyValid": policy["valid"],
        "method": method,
        "temperature": policy["temperature"],
        "tau": policy["tau"],
        "displayOrder": {str(index): list(R.ORDERS[index]) for index in orders},
        "presentation": orders,
        "forwardCalls": len(orders),
        "timings": timings,
        "policySha256": R.sha256_file(Path(args.policy)),
        "headTensorSha256": policy["head"]["tensorSha256"],
        "modelSha256": policy["backbone"]["sha256"],
    }
    if args.raw_scores:
        payload["probabilities"] = {str(index): stable_probs(index, logits[index],
                                                             policy["temperature"])
                                    for index in orders}
        payload["researchOnly"] = "raw scores; not an accepted decision"
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
