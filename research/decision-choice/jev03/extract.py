#!/usr/bin/env python3
"""One frozen forward per (case, order) -> EncodedDecision cache.

A single real forward yields both read-out positions: cand[4,5120] for the
candidate arms and hq[5120] for the query arm. Everything downstream (six
trainings, dev selection, sealed test prediction) reuses this cache, so no head
ever triggers a second backbone pass.

Run as the only process on the GPUs:
  python3 extract.py --splits train dev          # 8 warmup + 2048 forwards
  python3 extract.py --splits test --json        # 8 warmup gens + 1024 forwards + 1024 generations
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "heads"))

import j3config as R  # noqa: E402
from guards import GoldSeal  # noqa: E402  frozen R1 behaviour seal
from r1ledger import BudgetExceeded, Ledger  # noqa: E402


def as_case(row: dict) -> dict:
    if "visibleInput" in row:
        return row
    return {"caseId": row["caseId"],
            "visibleInput": {"context": row["context"], "playerText": row["playerText"]}}


def save_split(split: str, cases: list[dict], cand: np.ndarray, hq: np.ndarray,
               token_hash: list[str], timings: list[dict]) -> dict:
    meta = {
        "schema": R.ENCODED_SCHEMA, "split": split, "rows": len(cases),
        "caseIds": [case["caseId"] for case in cases],
        "orderIds": [int(case["order"]) for case in cases],
        "tokenHash": token_hash,
        "candShape": list(cand.shape), "hqShape": list(hq.shape),
        "featureIdentityHash": R.feature_identity_hash(),
        "featureIdentity": R.feature_identity(),
        "timings": timings,
        "at": R.now_iso(),
    }
    path = R.features_file(split)
    path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(path, cand=cand.astype(np.float32), hq=hq.astype(np.float32))
    R.write_json(path.with_suffix(".meta.json"), meta)
    return {"split": split, "rows": len(cases),
            "cacheSha256": R.sha256_file(path),
            "metaSha256": R.sha256_file(path.with_suffix(".meta.json"))}


def extract(model, ledger: Ledger, split: str, cases: list[dict], tag: str) -> dict:
    cand_rows, hq_rows, hashes, timings = [], [], [], []
    for index, raw in enumerate(cases):
        case = as_case(raw)
        order = int(raw["order"]) if "order" in raw else index % 4
        job_id = f"feature-{split}-{case['caseId']}-{order}-{tag}"
        job = ledger.reserve(job_id, "forward", f"feature-{split}")
        ledger.begin(job)
        started = time.time()
        try:
            feature = model.features(case, order)
        except Exception as error:  # a failed forward stays charged
            ledger.fail(job, str(error), prefill=1, seconds=time.time() - started)
            raise
        elapsed = time.time() - started
        ledger.finish(job, prefill=1, decode=0, tokens_in=feature["tokensIn"], tokens_out=0,
                      seconds=elapsed)
        cand_rows.append(np.asarray(feature["cand"], dtype=np.float32))
        hq_rows.append(np.asarray(feature["hq"], dtype=np.float32))
        hashes.append(feature["idsSha256"])
        timings.append({"caseId": case["caseId"], "order": order,
                        "tokensIn": feature["tokensIn"], "prefillMs": feature["prefillMs"],
                        "e2eMs": round(elapsed * 1000, 3)})
        if (index + 1) % 128 == 0:
            print(f'{{"forward": "{split}", "done": {index + 1}, "of": {len(cases)}}}', flush=True)
    if len(hashes) != len(cases):
        raise SystemExit(f"{split}: {len(hashes)} features for {len(cases)} cases")
    return save_split(split, cases, np.stack(cand_rows), np.stack(hq_rows), hashes, timings)


def generate(model, ledger: Ledger, split: str, cases: list[dict], tag: str) -> dict:
    """Append each generation to disk immediately so an interruption cannot lose it.

    Rows whose job id is already finished are skipped by id (never re-charged); if a
    finished id has no persisted text, the row is recorded as lost instead of being
    silently regenerated, because a re-run would exceed the generation cap.
    """
    path = R.RESULTS / f"{split}-json-generations.jsonl"
    done = {}
    if path.exists():
        for row in R.read_jsonl(path):
            done[(row["caseId"], int(row["order"]))] = row
    finished = {event["jobId"] for event in ledger.events if event.get("event") == "finish"}
    handles = open(path, "a", encoding="utf-8")
    rows = []
    lost = []
    for index, raw in enumerate(cases):
        case = as_case(raw)
        order = int(raw["order"]) if "order" in raw else index % 4
        key = (case["caseId"], order)
        if key in done:
            rows.append(done[key])
            continue
        job_id = f"generate-{split}-{case['caseId']}-{order}-{tag}"
        if job_id in finished:
            lost.append({"caseId": case["caseId"], "order": order, "jobId": job_id,
                         "why": "job finished before the run aborted; its text was never persisted"})
            continue
        job = ledger.reserve(job_id, "generate", f"json-{split}")
        ledger.begin(job)
        started = time.time()
        try:
            out = model.generate_timed(case, order)
        except Exception as error:
            ledger.fail(job, str(error), prefill=1, seconds=time.time() - started)
            raise
        ledger.finish(job, prefill=out["prefillCalls"], decode=out["decodeCalls"],
                      tokens_in=out["tokensIn"], tokens_out=out["newTokens"],
                      seconds=time.time() - started)
        row = {"caseId": case["caseId"], "order": order, "rawText": out["rawText"],
               "newTokens": out["newTokens"], "tokensIn": out["tokensIn"],
               "tokenizeMs": out["tokenizeMs"], "prefillMs": out["prefillMs"],
               "readoutMs": out["readoutMs"], "decodeMs": out["decodeMs"],
               "e2eMs": out["e2eMs"], "renderedSha256": out["renderedSha256"]}
        rows.append(row)
        handles.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
        handles.flush()
        if (index + 1) % 128 == 0:
            print(f'{{"generate": "{split}", "done": {index + 1}, "of": {len(cases)}}}', flush=True)
    handles.close()
    digest = R.sha256_file(path)
    R.write_json(R.RESULTS / f"{split}-json-meta.json",
                 {"schema": "frostecho.jev03.json/1", "at": R.now_iso(), "rows": len(rows),
                  "sha256": digest, "lost": lost,
                  "lostNote": ("jobs that finished before the budget-guard abort; re-running them "
                               "would exceed the 1100 generation cap, so they are reported missing "
                               "instead of being regenerated"),
                  "protocol": "jev02r1 frozen generation protocol (json arm)"})
    return {"split": split, "rows": len(rows), "lost": len(lost), "sha256": digest}


TIMING_CASES = 4   # 4 cases x 4 presentations = the 16 pre-fixed timing presentations


def timing(model, ledger: Ledger, cases: list[dict], tag: str, repeats: int = 2) -> dict:
    """16 pre-fixed test presentations x 2 repeats x {1 shared feature, 1 JSON}."""
    fixed = cases[:TIMING_CASES * 4]
    rows = []
    for repeat in range(repeats):
        for index, raw in enumerate(fixed):
            case = as_case(raw)
            order = int(raw["order"])
            job = ledger.reserve(f"timing-fwd-{tag}-{repeat}-{index}", "forward", "timing")
            ledger.begin(job)
            started = time.time()
            try:
                forward = model.forward_timed(case, order)
            except Exception as error:
                ledger.fail(job, str(error), prefill=1, seconds=time.time() - started)
                raise
            ledger.finish(job, prefill=forward["prefillCalls"], decode=0,
                          tokens_in=forward["tokensIn"], tokens_out=0,
                          seconds=time.time() - started)
            rows.append({"kind": "shared_feature", "repeat": repeat, "caseId": case["caseId"],
                         "order": order, **{key: forward[key] for key in
                                            ("tokensIn", "tokenizeMs", "prefillMs", "readoutMs",
                                             "decodeMs", "e2eMs")}})
            job = ledger.reserve(f"timing-gen-{tag}-{repeat}-{index}", "generate", "timing")
            ledger.begin(job)
            started = time.time()
            try:
                generated = model.generate_timed(case, order)
            except Exception as error:
                ledger.fail(job, str(error), prefill=1, seconds=time.time() - started)
                raise
            ledger.finish(job, prefill=generated["prefillCalls"], decode=generated["decodeCalls"],
                          tokens_in=generated["tokensIn"], tokens_out=generated["newTokens"],
                          seconds=time.time() - started)
            rows.append({"kind": "json", "repeat": repeat, "caseId": case["caseId"],
                         "order": order, **{key: generated[key] for key in
                                            ("tokensIn", "newTokens", "tokenizeMs", "prefillMs",
                                             "readoutMs", "decodeMs", "e2eMs")}})
    summary = {}
    for kind in ("shared_feature", "json"):
        subset = sorted((row["e2eMs"] for row in rows if row["kind"] == kind))
        summary[kind] = {"n": len(subset), "medianMs": round(subset[len(subset) // 2], 3),
                         "minMs": round(subset[0], 3), "maxMs": round(subset[-1], 3),
                         "stages": {stage: round(sum(row[stage] for row in rows
                                                     if row["kind"] == kind) / len(subset), 3)
                                    for stage in ("tokenizeMs", "prefillMs", "readoutMs",
                                                  "decodeMs")}}
    summary["note"] = ("one live timing pass on 16 fixed test presentations, 2 repeats each; "
                       "small n, no p95 claim; load time is reported separately")
    R.write_json(R.RESULTS / "timing.json", {"schema": "frostecho.jev03.timing/1",
                                             "at": R.now_iso(), "rows": rows,
                                             "summary": summary})
    return summary


def warmup(model, ledger: Ledger, cases: list[dict], tag: str, generations: int) -> dict:
    order = 0
    for index in range(8):
        case = as_case(cases[index % len(cases)])
        job = ledger.reserve(f"warmup-fwd-{tag}-{index}", "forward", "warmup")
        ledger.begin(job)
        started = time.time()
        try:
            model.features(case, order)
        except Exception as error:
            ledger.fail(job, str(error), prefill=1, seconds=time.time() - started)
            raise
        ledger.finish(job, prefill=1, decode=0, tokens_in=0, tokens_out=0,
                      seconds=time.time() - started)
    for index in range(generations):
        case = as_case(cases[(index + 8) % len(cases)])
        job = ledger.reserve(f"warmup-gen-{tag}-{index}", "generate", "warmup")
        ledger.begin(job)
        started = time.time()
        try:
            model.generate_timed(case, order)
        except Exception as error:
            ledger.fail(job, str(error), prefill=1, seconds=time.time() - started)
            raise
        ledger.finish(job, prefill=1, decode=8, tokens_in=0, tokens_out=8,
                      seconds=time.time() - started)
    return {"warmup": 8 + generations}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--splits", nargs="+", default=["train", "dev"])
    parser.add_argument("--json", action="store_true", help="also generate the JSON arm outputs")
    parser.add_argument("--tag", default="a1")
    parser.add_argument("--timing-split", default="test")
    parser.add_argument("--skip-warmup", action="store_true")
    parser.add_argument("--reuse-features", action="store_true",
                        help="reuse an existing cache whose identity matches (no new forwards)")
    parser.add_argument("--only-timing", action="store_true",
                        help="skip features and JSON; run just the fixed timing pass")
    parser.add_argument("--timing", action="store_true",
                        help="also run the 16x2 fixed timing presentations")
    args = parser.parse_args(argv)

    R.CACHE.mkdir(parents=True, exist_ok=True)
    R.RESULTS.mkdir(parents=True, exist_ok=True)
    R.EVIDENCE.mkdir(parents=True, exist_ok=True)
    ledger = Ledger(R.EVIDENCE / "jobs.jsonl", caps=R.CAPS)
    workloads = {}
    for split in args.splits:
        cases = []
        for row in R.read_jsonl(R.inputs_file(split)):
            for order in range(4):
                cases.append({**row, "order": order})
        workloads[split] = cases

    # The prediction path must not be able to read the sealed test gold.
    seal = GoldSeal([R.gold_file(), R.DATA / "test.jsonl"]) if "test" in args.splits else None
    context = seal if seal is not None else _NullSeal()
    started = time.time()
    with context:
        from backends.local_qwen import LocalQwen

        model = LocalQwen()
        R.write_json(R.EVIDENCE / "model-identity.json",
                     {"schema": "frostecho.jev03.model/1", "at": R.now_iso(),
                      "identity": model.identity, "featureIdentityHash": R.feature_identity_hash()})
        first = workloads[args.splits[0]] if args.splits else []
        if not args.skip_warmup and args.splits:
            warmup(model, ledger, first, args.tag, 8 if args.json else 0)
        outputs = {}
        if args.only_timing:
            args.splits = []
        for split in args.splits:
            cache = R.features_file(split)
            meta_path = cache.with_suffix(".meta.json")
            reusable = (args.reuse_features and cache.exists() and meta_path.exists()
                        and R.read_json(meta_path)["featureIdentityHash"]
                        == R.feature_identity_hash()
                        and R.read_json(meta_path)["rows"] == len(workloads[split]))
            if reusable:
                outputs[split] = {"split": split, "rows": len(workloads[split]),
                                  "cacheSha256": R.sha256_file(cache), "reused": True}
            else:
                outputs[split] = extract(model, ledger, split, workloads[split], args.tag)
        if args.json:
            outputs["json"] = generate(model, ledger, args.splits[-1], workloads[args.splits[-1]],
                                       args.tag)
        if args.timing:
            target = args.timing_split or (args.splits[-1] if args.splits else "test")
            cases = workloads.get(target)
            if cases is None:
                cases = [{**row, "order": order}
                         for row in R.read_jsonl(R.inputs_file(target)) for order in range(4)]
            outputs["timing"] = timing(model, ledger, cases, args.tag)
        memory = model.memory()
        load_seconds = model.load_seconds
    report = {"schema": "frostecho.jev03.extract/1", "at": R.now_iso(), "outputs": outputs,
              "loadSeconds": round(load_seconds, 3), "wallSeconds": round(time.time() - started, 2),
              "gpuPeakGiB": {key: value["peakGiB"] for key, value in memory.items()},
              "seal": {"sealed": sorted(getattr(seal, "sealed", [])) if seal else [],
                       "blockedAttempts": len(seal.attempts) if seal else 0,
                       "blockedPaths": seal.attempts if seal else []},
              "ledger": ledger.summary()["reserved"]}
    name = ("extract-" + "-".join(args.splits) + ("-json" if args.json else "")
            + ("-timing" if args.timing else "") + f"-{args.tag}.json")
    R.write_json(R.EVIDENCE / name, report)
    print(R.canonical({"outputs": outputs, "wallSeconds": report["wallSeconds"],
                       "blocked": report["seal"]["blockedAttempts"],
                       "reserved": report["ledger"]}))
    return 0


class _NullSeal:
    paths: list = []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
