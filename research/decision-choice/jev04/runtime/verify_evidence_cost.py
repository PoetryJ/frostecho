#!/usr/bin/env python3
"""Re-resolve cost for the real JEV-03R1 evidence payloads, read-only.

Proves the corrected resolver consumes the canonical `measuredCost` on the
actual 1552 job payloads, without rewriting the old ledger, results or
cost table. Exit code is non-zero when totals disagree with the derived table.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
BEHAVIOR = ROOT / "research/decision-choice/jev03/behavior"
sys.path.insert(0, str(BEHAVIOR))
sys.path.insert(0, str(BEHAVIOR.parent))
sys.path.insert(0, str(HERE))

import j3config as R3  # noqa: E402
from store import JobStore  # noqa: E402
from cost import resolve_cost  # noqa: E402


def main() -> int:
    plan = R3.read_json(BEHAVIOR / "plan.json")
    store = JobStore(BEHAVIOR / "evidence", plan["campaign"], plan["protocolSha"])
    totals = {"jobs": 0, "measured": 0, "unknown": 0, "invalid": 0,
              "tokensIn": 0, "tokensOut": 0, "decodeCalls": 0, "prefillCalls": 0}
    invalid_reasons: dict[str, int] = {}
    for job_id, entry in store._index.items():
        if "finish" not in entry:
            continue
        payload = store.read_result(job_id)
        cost = resolve_cost(payload)
        totals["jobs"] += 1
        totals[cost["source"]] += 1
        if cost["source"] == "measured":
            for key in ("tokensIn", "tokensOut", "decodeCalls", "prefillCalls"):
                totals[key] += cost[key]
        elif cost["source"] == "invalid":
            invalid_reasons[cost["reason"]] = invalid_reasons.get(cost["reason"], 0) + 1

    derived = R3.read_json(BEHAVIOR / "results/cost.json")
    expected = derived["totals"]
    batch = R3.read_json(BEHAVIOR / "results/batch.json")
    report = {
        "schema": "frostecho.jev04.cost-verification/1",
        "evidence": str((BEHAVIOR / "evidence").relative_to(ROOT)),
        "resolved": totals,
        "derivedTable": {"tokensIn": expected["tokensIn"], "tokensOut": expected["tokensOut"],
                         "decodeCalls": expected["decodeCalls"], "prefillCalls": expected["prefillCalls"]},
        "oldLedgerUnknownCostFinish": batch["summary"]["unknownCostFinish"],
        "invalidReasons": invalid_reasons,
        "match": all(totals[key] == expected[key]
                     for key in ("tokensIn", "tokensOut", "decodeCalls", "prefillCalls")),
    }
    out = HERE / "cost-verification.json"
    out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["match"] and totals["measured"] == totals["jobs"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
