#!/usr/bin/env python3
"""One 27B instance: feature extraction for the three R1 splits, plus the JSON
baseline generations for test. Runs with the gold seal active."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import r1config as R
from guards import GoldSeal
from r1config import (CACHE, EVIDENCE, HEAD_PATH, MODEL_PATH, ORDERS, RESULTS, inputs_file,
                      read_jsonl, write_json, write_jsonl)


def save_split(split: str, rows: list[dict], meta: dict) -> dict:
    CACHE.mkdir(parents=True, exist_ok=True)
    npz = CACHE / f"features-{split}.npz"
    np.savez_compressed(
        npz,
        cand=np.stack([row["cand"] for row in rows]).astype(np.float32),
        hq=np.stack([row["hq"] for row in rows]).astype(np.float32),
        letterLogp=np.stack([row["letterLogp"] for row in rows]).astype(np.float32),
        candidateMass=np.array([row["candidateMass"] for row in rows], dtype=np.float32),
        labelIndex=np.array([row["labelIndex"] for row in rows], dtype=np.int64),
        caseIds=np.array([row["caseId"] for row in rows], dtype=object),
        orderIdx=np.array([row["orderIdx"] for row in rows], dtype=np.int64),
        idsSha256=np.array([row["idsSha256"] for row in rows], dtype=object),
        renderedSha256=np.array([row["renderedSha256"] for row in rows], dtype=object),
        tokensIn=np.array([row["tokensIn"] for row in rows], dtype=np.int64),
        positions=np.stack([row["positions"] for row in rows]).astype(np.int64),
        final=np.array([row["final"] for row in rows], dtype=np.int64),
    )
    payload = {**meta, "count": len(rows), "npzSha256": R.sha256_file(npz),
               "caseOrder": [row["caseId"] for row in rows],
               "orderIdx": [row["orderIdx"] for row in rows]}
    write_json(CACHE / f"features-{split}.meta.json", payload)
    return payload


def as_case(row: dict) -> dict:
    """Adapt an R1 data row to the frozen renderer's input shape."""
    if "visibleInput" in row:
        return row
    case = {"caseId": row["caseId"],
            "visibleInput": {"context": row["context"], "playerText": row["playerText"]}}
    if "labelId" in row:
        case["labelId"] = row["labelId"]
    return case


def feature_rows(model, ledger, split: str, cases: list[dict], ledger_tag: str = "a2") -> list[dict]:
    rows = []
    for raw in cases:
        case = as_case(raw)
        for order in range(4):
            job_id = f"feature-{split}-{case['caseId']}-{order}-{ledger_tag}"
            if job_id in ledger.reserved:
                raise RuntimeError(f"resumed run with an existing job {job_id}: use a fresh ledger")
            job = ledger.reserve(job_id, "forward", "shared",
                                 {"split": split, "caseId": case["caseId"], "order": order})
            ledger.begin(job)
            started = time.time()
            try:
                feature = model.features(case, order)
            except Exception as error:
                ledger.fail(job, str(error), prefill=1, seconds=time.time() - started)
                raise
            ledger.finish(job, prefill=1, decode=0, tokens_in=feature["tokensIn"], tokens_out=0,
                          seconds=time.time() - started)
            rows.append({
                "caseId": case["caseId"], "orderIdx": order,
                "cand": feature["cand"].numpy(), "hq": feature["hq"].numpy(),
                "letterLogp": feature["letterLogp"], "candidateMass": feature["candidateMass"],
                "labelIndex": (ORDERS[order].index(case["labelId"]) if "labelId" in case else -1),
                "idsSha256": feature["idsSha256"], "renderedSha256": feature["renderedSha256"],
                "tokensIn": feature["tokensIn"], "positions": feature["positions"],
                "final": feature["final"],
            })
        print(json.dumps({"feature": split, "case": case["caseId"]}), flush=True)
    return rows


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--splits", nargs="+", default=["cal-temperature", "cal-policy", "test"])
    parser.add_argument("--generate", default="test")
    parser.add_argument("--skip-features", action="store_true")
    parser.add_argument("--tag", default="a2", help="attempt tag; failed attempts stay charged under their own ids")
    args = parser.parse_args(argv)

    from backends.local_qwen import LocalQwen
    from r1ledger import Ledger, BudgetExceeded

    ledger = Ledger(EVIDENCE / "jobs.jsonl")
    seal = GoldSeal([R.DATA / "test.gold.json", R.DATA / "test.labels.jsonl"])
    started = time.time()
    with seal:
        model = LocalQwen()
        identity = {**model.identity, "at": R.now_iso()}
        write_json(EVIDENCE / "model-identity.json", identity)
        model_sha = R.sha256_json(model.identity["model"])
        print(json.dumps({"loaded": model.params, "loadSeconds": round(model.load_seconds, 3)}), flush=True)

        probe_case = as_case(read_jsonl(R.split_file("cal-temperature"))[0])
        for index in range(4):
            job = ledger.reserve(f"compat-fwd-{args.tag}-{index}", "forward", "compat")
            ledger.begin(job); tick = time.time()
            feature = model.features(probe_case, index)
            ledger.finish(job, prefill=1, decode=0, tokens_in=feature["tokensIn"], tokens_out=0,
                          seconds=time.time() - tick)
        for index in range(2):
            job = ledger.reserve(f"warmup-gen-{args.tag}-{index}", "generate", "warmup")
            ledger.begin(job); tick = time.time()
            out = model.generate_timed(probe_case, index)
            ledger.finish(job, prefill=1, decode=out["decodeCalls"], tokens_in=out["tokensIn"],
                          tokens_out=out["newTokens"], seconds=time.time() - tick)

        if not args.skip_features:
            for split in args.splits:
                cases = read_jsonl(R.split_file(split) if split != "test" else R.inputs_file("test"))
                rows = feature_rows(model, ledger, split, cases, args.tag)
                meta = save_split(split, rows, {
                    "schema": "frostecho.jev02r1.features/1", "split": split,
                    "modelSha256": model_sha, "cases": len(cases),
                    "datasetSha256": R.sha256_file(R.split_file(split) if split != "test"
                                                   else R.inputs_file("test")),
                })
                print(json.dumps({"features": split, "rows": meta["count"]}), flush=True)

        if args.generate:
            cases = read_jsonl(R.inputs_file(args.generate))
            rows = []
            for case in cases:
                for order in range(4):
                    job_id = f"generate-{args.generate}-{case['caseId']}-{order}-{args.tag}"
                    job = ledger.reserve(job_id, "generate", "json",
                                         {"caseId": case["caseId"], "order": order})
                    ledger.begin(job); tick = time.time()
                    try:
                        out = model.generate_timed(case, order)
                    except Exception as error:
                        ledger.fail(job, str(error), prefill=1, seconds=time.time() - tick)
                        raise
                    ledger.finish(job, prefill=1, decode=out["decodeCalls"], tokens_in=out["tokensIn"],
                                  tokens_out=out["newTokens"], seconds=time.time() - tick)
                    rows.append({"caseId": case["caseId"], "order": order,
                                 "rawText": out["rawText"], "newTokens": out["newTokens"],
                                 "idsSha256": out["idsSha256"], "renderedSha256": out["renderedSha256"],
                                 "e2eMs": out["e2eMs"]})
            write_jsonl(RESULTS / f"{args.generate}-json-generations.jsonl", rows)
            write_json(RESULTS / f"{args.generate}-json-meta.json",
                       {"sha256": R.sha256_file(RESULTS / f"{args.generate}-json-generations.jsonl"),
                        "count": len(rows)})
            print(json.dumps({"generations": args.generate, "rows": len(rows)}), flush=True)

    write_json(EVIDENCE / "extract-seal.json", {**seal.report(), "at": R.now_iso(),
                                                "wallSeconds": round(time.time() - started, 2)})
    write_json(EVIDENCE / "extract-summary.json", {"ledger": ledger.summary(), "at": R.now_iso(),
                                                   "memory": model.memory()})
    print(json.dumps({"ledger": {key: ledger.summary()[key] for key in
                                 ("reserved", "generationJobs", "forwardJobs", "failed")}}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
