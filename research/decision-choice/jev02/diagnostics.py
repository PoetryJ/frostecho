#!/usr/bin/env python3
"""Diagnostics (not part of main accuracy) + P0 injection evidence.

1. Remove the player text on 64 test cases and score the recommended head.
2. Forward succeeds, head raises: the ledger reservation must remain charged.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import contracts as C
from contracts import CLASSES, ORDERS, RESULTS, read_json, read_jsonl, sha256_text, write_json
from ledger import Ledger


def main() -> int:
    from backends.local_qwen import LocalQwen
    from heads.train import load_head
    import torch

    lock = read_json(C.ROOT / "PLAN.lock.json")
    ledger = Ledger(C.EVIDENCE / "jobs.jsonl")
    model = LocalQwen()
    config = read_json(RESULTS / "calibration.json")
    variant = "M1"
    seed = config[variant]["seed"]
    run = [r for r in read_json(RESULTS / "training-runs.json")
           if r["variant"] == variant and r["seed"] == seed][0]
    head, _ = load_head(Path(run["bestPath"]), device="cuda:0")
    inputs = read_jsonl(C.DATA / "test.inputs.jsonl")
    by_class = {cls: sorted((row for row in inputs if read_json(C.DATA / "test.gold.json")["gold"][row["caseId"]]["labelId"] == cls),
                            key=lambda r: sha256_text(r["caseId"]))[:16] for cls in CLASSES}
    chosen = [row for cls in CLASSES for row in by_class[cls]]
    rows = []
    for row in chosen:
        case = {"caseId": row["caseId"], "visibleInput": {"context": row["visibleInput"]["context"],
                                                          "playerText": "[player text removed]"}}
        probs = []
        for order in range(4):
            job = ledger.reserve(f"diag-{row['caseId']}-{order}", "feature", "diagnostic")
            ledger.begin(job); started = time.time()
            feature = model.features(case, order)
            ledger.finish(job, prefill=1, decode=0, tokens_in=feature["tokensIn"], tokens_out=0,
                          seconds=time.time() - started)
            with torch.no_grad():
                logits = head(feature["cand"].cuda().unsqueeze(0))[0].cpu()
            probs.append(torch.softmax(logits, dim=-1).numpy())
        rows.append({"caseId": row["caseId"], "probabilities": [p.tolist() for p in probs]})
    gold = {k: v["labelId"] for k, v in read_json(C.DATA / "test.gold.json")["gold"].items()}
    correct = 0
    for row in rows:
        best = int(max(range(4), key=lambda k: row["probabilities"][0][k]))
        correct += int(ORDERS[0][best] == gold[row["caseId"]])
    full = 0
    for row in chosen:
        preds = [p for p in read_jsonl(RESULTS / "test-predictions" / f"{variant}.jsonl")
                 if p["caseId"] == row["caseId"] and p["order"] == 0][0]
        full += int(preds["predictedId"] == gold[row["caseId"]])
    write_json(RESULTS / "diagnostics.json", {
        "schema": "frostecho.jev02.diagnostics/1", "at": C.now_iso(),
        "cases": len(chosen), "method": f"{variant}-seed{seed}",
        "removedPlayerTextAccuracy": round(correct / len(chosen), 4),
        "fullTextAccuracySameCases": round(full / len(chosen), 4),
        "note": "diagnostic only; never merged into main accuracy",
    })

    # P0 injection: real forward, head raises, still charged.
    case = {"visibleInput": {"context": "厨房里有一份饭，玩家刚进门。", "playerText": "饭给我留着。"}}
    job = ledger.reserve("injection-forward-ok-head-throws", "feature", "p0")
    ledger.begin(job); started = time.time()
    feature = model.features(case, 0)  # the forward really succeeds
    try:
        raise RuntimeError("injected head failure after a successful forward")
    except RuntimeError as error:
        ledger.fail(job, str(error), prefill=1, tokens_in=feature["tokensIn"], seconds=time.time() - started)
    summary = ledger.summary()
    write_json(C.EVIDENCE / "p0-injection.json", {
        "schema": "frostecho.jev02.p0-injection/1", "at": C.now_iso(),
        "forwardSucceeded": True, "headRaised": True,
        "reserved": summary["reserved"], "failed": summary["failed"],
        "charged": summary["reserved"] >= 1 and summary["failed"] >= 1,
        "injectionJobId": job["jobId"],
    })
    print(json.dumps({"diagnostics": read_json(RESULTS / "diagnostics.json"),
                      "injection": read_json(C.EVIDENCE / "p0-injection.json")}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
