#!/usr/bin/env python3
"""Merge per-job feature blobs into the derived split cache and bind it.

The per-job files are the record; the split NPZ is only a derived cache. The
binding records the exact input list, per-row token/render hashes, model and
renderer identity, the three head SHAs and the cache bytes, so a cache built from
different text with the same row count is refused before any reuse.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))

import j3config as R3  # noqa: E402
from run import CAMPAIGN, head_shas, load_case_rows, workload  # noqa: E402
from runtime import CacheBinding, input_list_sha  # noqa: E402
from store import JobStore  # noqa: E402


def main() -> int:
    plan = R3.read_json(HERE / "plan.json")
    store = JobStore(HERE / "evidence", CAMPAIGN, plan["protocolSha"])
    rows = workload(load_case_rows())
    cand, hq, tokens, renders = [], [], [], []
    for row in rows:
        key = store.key(input_list_sha([row]), row["order"], "forward")
        job_id = store.job_id(key)
        payload = store.read_result(job_id)
        cand.append(np.load(payload["candPath"]))
        hq.append(np.load(payload["hqPath"]))
        tokens.append(payload["tokenHash"])
        renders.append(payload["renderSha"])
    cache = HERE / "results" / "behavior-features.npz"
    np.savez_compressed(cache, cand=np.stack(cand), hq=np.stack(hq))
    binding = CacheBinding.build("behavior", rows, tokens, renders, cache, head_shas())
    R3.write_json(HERE / "results" / "cache-binding.json", binding.payload)
    R3.write_jsonls = None
    R3.write_jsonl(HERE / "results" / "presentations.jsonl",
                   [{"caseId": row["caseId"], "order": row["order"],
                     "inputListSha": input_list_sha([row]), "tokenHash": token,
                     "renderSha": render}
                    for row, token, render in zip(rows, tokens, renders)])
    print(R3.canonical({"presentations": len(rows), "cache": R3.sha256_file(cache)[:16],
                        "binding": binding.payload["inputListSha"][:16]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
