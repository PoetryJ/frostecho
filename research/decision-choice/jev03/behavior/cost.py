#!/usr/bin/env python3
"""Derive the cost table from the per-job results, not from the finish events.

Defect this corrects: `run_job` computed the measured cost from the *result
payload*, whose generation entries call the output count `newTokens` rather than
`tokensOut`, so every finish event in this batch recorded `source: unknown` even
though the model return did carry the counts. The payloads themselves keep the
measured numbers, so the table below is derived from disk and the ledger's
`unknown` flags are reported as-is instead of being rewritten.
"""
from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import j3config as R3  # noqa: E402
from store import JobStore  # noqa: E402


def main() -> int:
    plan = R3.read_json(HERE / "plan.json")
    store = JobStore(HERE / "evidence", plan["campaign"], plan["protocolSha"])
    buckets = {"feature": {"jobs": 0, "tokensIn": 0, "tokensOut": 0, "prefillCalls": 0,
                           "decodeCalls": 0, "e2e": []},
               "generation": {"jobs": 0, "tokensIn": 0, "tokensOut": 0, "prefillCalls": 0,
                              "decodeCalls": 0, "e2e": []}}
    unknown = 0
    for job_id, entry in store._index.items():
        if "finish" not in entry:
            continue
        payload = store.read_result(job_id)
        cost = payload.get("measuredCost") or {}
        kind = "feature" if payload.get("kind") == "feature" else "generation"
        bucket = buckets[kind]
        bucket["jobs"] += 1
        if cost.get("source") != "measured":
            unknown += 1
            continue
        bucket["tokensIn"] += cost["tokensIn"]
        bucket["tokensOut"] += cost["tokensOut"]
        bucket["prefillCalls"] += cost["prefillCalls"]
        bucket["decodeCalls"] += cost["decodeCalls"]
        timing = payload.get("timing") or {}
        if timing.get("e2eMs") is not None:
            bucket["e2e"].append(float(timing["e2eMs"]))
        elif timing.get("prefillMs") is not None:
            bucket["e2e"].append(float(timing["prefillMs"]))
    for bucket in buckets.values():
        values = sorted(bucket.pop("e2e"))
        bucket["medianE2eMs"] = round(values[len(values) // 2], 3) if values else None
        bucket["measuredJobs"] = bucket["jobs"] - (unknown if bucket["jobs"] == unknown else 0)
    batch = R3.read_json(HERE / "results" / "batch.json")
    table = {"schema": "frostecho.jev03r1.cost/1", "at": R3.now_iso(),
             "source": "derived from per-job results (measuredCost), not from finish events",
             "ledgerCostDefect": {"unknownCostFinish": batch["summary"]["unknownCostFinish"],
                                  "why": "cost was computed from the result payload where the "
                                         "generation output count is `newTokens`; the model "
                                         "return did carry the counts, the ledger field did not"},
             "buckets": buckets,
             "totals": {"modelJobs": batch["summary"]["reserved"],
                        "generationJobs": batch["summary"]["generationJobs"],
                        "tokensIn": sum(b["tokensIn"] for b in buckets.values()),
                        "tokensOut": sum(b["tokensOut"] for b in buckets.values()),
                        "prefillCalls": sum(b["prefillCalls"] for b in buckets.values()),
                        "decodeCalls": sum(b["decodeCalls"] for b in buckets.values())},
             "wallSeconds": batch["wallSeconds"], "loadSeconds": batch["loadSeconds"],
             "gpuPeakGiB": batch["gpuPeakGiB"],
             "caps": batch["caps"]}
    R3.write_json(HERE / "results" / "cost.json", table)
    print(R3.canonical({"totals": table["totals"], "wall": table["wallSeconds"],
                        "unknownFinish": batch["summary"]["unknownCostFinish"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
