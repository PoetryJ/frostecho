#!/usr/bin/env python3
"""Canonical cost resolution for choice jobs (JEV-04 runtime).

Defect being corrected (JEV-03R1): `run_job` computed cost from the result
payload's top level, while the payload already carried the canonical
`payload["measuredCost"]` object. Generation payloads name the output count
`newTokens` and only nest the canonical counts, so the ledger recorded
`source: unknown` for every job even though the model return had them.

This module is the single place that decides what a job cost. It consumes the
canonical field and validates it; it never invents counts and it distinguishes
`unknown` (no counts present) from `invalid` (present but not trustworthy).
"""
from __future__ import annotations

import math
from typing import Any

COST_KEYS = ("tokensIn", "tokensOut", "decodeCalls", "prefillCalls")


def _non_negative_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _validate(cost: dict) -> tuple[bool, str | None]:
    if not isinstance(cost, dict):
        return False, "measuredCost is not an object"
    source = cost.get("source")
    if source != "measured":
        return False, f"measuredCost.source is {source!r}, not 'measured'"
    for key in COST_KEYS:
        if key not in cost:
            return False, f"measuredCost missing {key}"
        if not _non_negative_int(cost[key]):
            return False, f"measuredCost.{key} is not a non-negative integer: {cost[key]!r}"
    calls = cost.get("modelCalls", 1)
    if not _non_negative_int(calls) or calls < 1:
        return False, f"modelCalls is not a positive integer: {calls!r}"
    return True, None


def resolve_cost(payload: dict, *, jobs: int = 1) -> dict:
    """Resolve one job's cost.

    Order of authority:
      1. `payload["measuredCost"]` when valid (canonical, written by the caller);
      2. top-level model-return counts (tokensIn + tokensOut|newTokens + call counts);
      3. unknown.
    Invalid canonical data is never silently downgraded to `unknown`.
    """
    if not isinstance(payload, dict):
        return {"source": "invalid", "modelCalls": jobs, "reason": "payload is not an object"}

    canonical = payload.get("measuredCost")
    if canonical is not None:
        ok, reason = _validate(canonical)
        if not ok:
            return {"source": "invalid", "modelCalls": jobs, "reason": reason}
        return {"source": "measured", "modelCalls": int(canonical.get("modelCalls", 1)),
                "tokensIn": canonical["tokensIn"], "tokensOut": canonical["tokensOut"],
                "decodeCalls": canonical["decodeCalls"], "prefillCalls": canonical["prefillCalls"],
                "costBasis": "payload.measuredCost"}

    output_key = "tokensOut" if "tokensOut" in payload else "newTokens" if "newTokens" in payload else None
    keys = ("tokensIn", output_key, "decodeCalls", "prefillCalls")
    if output_key and all(key in payload for key in keys):
        values = {"tokensIn": payload["tokensIn"], "tokensOut": payload[output_key],
                  "decodeCalls": payload["decodeCalls"], "prefillCalls": payload["prefillCalls"]}
        bad = [key for key, value in values.items()
               if not _non_negative_int(value) or (isinstance(value, float) and math.isnan(value))]
        if bad:
            return {"source": "invalid", "modelCalls": jobs,
                    "reason": f"top-level cost fields not non-negative integers: {bad}"}
        return {"source": "measured", "modelCalls": jobs, **values, "costBasis": "top-level"}

    return {"source": "unknown", "modelCalls": jobs,
            "reason": "no measuredCost and no complete top-level counts"}
