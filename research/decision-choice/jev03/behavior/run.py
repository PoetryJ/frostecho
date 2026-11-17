#!/usr/bin/env python3
"""The single new batch: 8+8 warmup, 768 shared features, 768 JSON generations.

Every operation goes through one JobStore, so the per-job payload is on disk
before `finish` is recorded and a crash can be classified instead of silently
re-run. The campaign plan (1552 operations, 776 of them generations, 2 h window)
is passed explicitly and never inherited.

Nothing here scores anything: the heads are read out on CPU by score.py from the
persisted features, and the sealed test gold is blocked for the whole run.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "heads"))

import j3config as R3  # noqa: E402
from guards import GoldSeal  # noqa: E402
from runtime import (Device, Plan, input_list_sha, measured_cost,  # noqa: E402
                     run_job)
from store import PLAN_CAPS, JobStore, canonical, sha256_text  # noqa: E402

CAMPAIGN = "jev03r1-behavior-a1"
PLAN_PATH = HERE / "plan.json"
FEATURE_DIR = HERE / "results" / "feature-jobs"
GENERATION_DIR = HERE / "results" / "generation-jobs"
SPLIT = "behavior"


def effective_plan() -> tuple[Plan, dict]:
    payload = R3.read_json(PLAN_PATH)
    plan = Plan(payload, PLAN_CAPS)
    return plan, payload


def head_shas() -> dict:
    seal = R3.read_json(R3.RESULTS / "selection-seal.json")
    return {"M0": seal["M0"]["tensorSha256"],
            "C": seal["selected"]["C"]["tensorSha256"],
            "Q": seal["selected"]["Q"]["tensorSha256"]}


def workload(cases: list[dict]) -> list[dict]:
    rows = []
    for case in cases:
        for order in range(4):
            rows.append({"caseId": case["caseId"], "order": order,
                         "context": case["visibleInput"]["context"],
                         "playerText": case["visibleInput"]["playerText"],
                         "protocol": "jev02r1.prompt/1+jev02r1.candidates/1"})
    return rows


def feature_payload(feature: dict, render_sha: str, tokens: int) -> dict:
    cand = np.asarray(feature["cand"], dtype=np.float32)
    hq = np.asarray(feature["hq"], dtype=np.float32)
    return {"kind": "feature", "candShape": list(cand.shape), "hqShape": list(hq.shape),
            "candSha": sha256_text(cand.tobytes().hex()), "hqSha": sha256_text(hq.tobytes().hex()),
            "candPath": None, "hqPath": None, "tokenHash": feature["idsSha256"],
            "renderSha": render_sha, "tokensIn": tokens,
            "measuredCost": measured_cost({"tokensIn": tokens, "tokensOut": 0,
                                           "decodeCalls": 0, "prefillCalls": 1}),
            "timing": {key: feature.get(key) for key in ("tokenizeMs", "prefillMs", "readoutMs")}}


def generation_payload(out: dict) -> dict:
    return {"kind": "generation", "rawText": out["rawText"], "newTokens": out["newTokens"],
            "tokensIn": out["tokensIn"], "renderedSha256": out["renderedSha256"],
            "measuredCost": measured_cost({"tokensIn": out["tokensIn"],
                                           "tokensOut": out["newTokens"],
                                           "decodeCalls": out["decodeCalls"],
                                           "prefillCalls": out["prefillCalls"]}),
            "timing": {key: out.get(key) for key in ("tokenizeMs", "prefillMs", "readoutMs",
                                                     "decodeMs", "e2eMs")}}


def save_feature_blobs(job_id: str, feature: dict) -> tuple[str, str]:
    FEATURE_DIR.mkdir(parents=True, exist_ok=True)
    cand_path = FEATURE_DIR / f"{job_id}.cand.npy"
    hq_path = FEATURE_DIR / f"{job_id}.hq.npy"
    np.save(cand_path, np.asarray(feature["cand"], dtype=np.float32))
    np.save(hq_path, np.asarray(feature["hq"], dtype=np.float32))
    return str(cand_path), str(hq_path)


def load_case_rows() -> list[dict]:
    cases = []
    for row in R3.read_jsonl(HERE / "inputs.jsonl"):
        cases.append({"caseId": row["caseId"], "visibleInput": row["visibleInput"]})
    return cases


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--device", default="cuda:0")
    parser.add_argument("--tag", default=CAMPAIGN)
    args = parser.parse_args(argv)
    device = Device(args.device)
    device.torch_device()
    plan, payload = effective_plan()
    store = JobStore(HERE / "evidence", args.tag, payload["protocolSha"], caps=plan.caps)
    cases = load_case_rows()
    rows = workload(cases)
    if len(rows) != payload["features"]:
        raise SystemExit(f"{len(rows)} presentations, plan says {payload['features']}")

    seal = GoldSeal([HERE / "gold.json", HERE / "pairs.json"])
    started = __import__("time").time()
    with seal:
        control = "not_attempted"
        try:
            open(HERE / "gold.json", encoding="utf-8")
        except Exception as error:
            control = f"blocked:{type(error).__name__}"
        from backends.local_qwen import LocalQwen

        model = LocalQwen()

        def forward(case_row: dict):
            return model.features({"visibleInput": {"context": case_row["context"],
                                                    "playerText": case_row["playerText"]}},
                                  case_row["order"])

        def generate(case_row: dict):
            return model.generate_timed({"visibleInput": {"context": case_row["context"],
                                                          "playerText": case_row["playerText"]}},
                                        case_row["order"])

        # warmup: same store, same cost channel, real counts
        warm = rows[:payload.get("warmupForward", 8)]
        for index, row in enumerate(warm):
            key = store.key(input_list_sha([row]) + f":warm{index}", row["order"], "forward")
            run_job(store, key, lambda row=row: forward(row),
                    lambda out, row=row: feature_payload(out, "-", out["tokensIn"]))
        warm_gen = rows[payload.get("warmupForward", 8):payload.get("warmupForward", 8)
                        + payload.get("warmupGenerate", 8)]
        for index, row in enumerate(warm_gen):
            key = store.key(input_list_sha([row]) + f":warmg{index}", row["order"], "generate")
            run_job(store, key, lambda row=row: generate(row),
                    lambda out: generation_payload(out))

        tokens, renders = [], []
        for index, row in enumerate(rows):
            key = store.key(input_list_sha([row]), row["order"], "forward")
            job_id = store.job_id(key)

            def payload_fn(out, job_id=job_id):
                cand_path, hq_path = save_feature_blobs(job_id, out)
                body = feature_payload(out, "-", out["tokensIn"])
                body["candPath"], body["hqPath"] = cand_path, hq_path
                return body

            result, _ = run_job(store, key, lambda row=row: forward(row), payload_fn)
            tokens.append(result["tokenHash"])
            renders.append(result["renderSha"])
            if (index + 1) % 128 == 0:
                print(json.dumps({"features": index + 1, "of": len(rows)}), flush=True)

        for index, row in enumerate(rows):
            key = store.key(input_list_sha([row]), row["order"], "generate")
            run_job(store, key, lambda row=row: generate(row), generation_payload)
            if (index + 1) % 128 == 0:
                print(json.dumps({"generations": index + 1, "of": len(rows)}), flush=True)

        memory = model.memory()
        load_seconds = model.load_seconds

    summary = store.summary()
    report = {"schema": "frostecho.jev03r1.batch/1", "at": R3.now_iso(), "campaign": args.tag,
              "plan": payload, "caps": plan.caps, "summary": summary,
              "goldSealControl": control, "blockedAttempts": len(seal.attempts),
              "blockedPaths": seal.attempts, "loadSeconds": round(load_seconds, 3),
              "wallSeconds": round(__import__("time").time() - started, 2),
              "gpuPeakGiB": {key: value["peakGiB"] for key, value in memory.items()},
              "headShas": head_shas(), "device": str(device.name)}
    R3.write_json(HERE / "results" / "batch.json", report)
    print(R3.canonical({"summary": {key: summary[key] for key in
                                    ("reserved", "finished", "results", "generationJobs",
                                     "complete", "unknownCostFinish")},
                        "blocked": len(seal.attempts), "wall": report["wallSeconds"]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
