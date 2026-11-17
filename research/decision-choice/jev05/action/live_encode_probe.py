#!/usr/bin/env python3
"""One real 27B forward pass on a real R8 ChoiceRequest, on this machine.

The point is to measure, not to promise: GPU shards plus CPU RAM, with the
reserves MODEL.txt asks for. If it cannot load or run, the measurement says so.

    python live_encode_probe.py --cases <dynamic-cases.jsonl> --out <json>
"""
from __future__ import annotations

import argparse
import json
import os
import resource
import time
from pathlib import Path

import numpy as np

ENCODER = Path("/data2/model_weights/Qwen3.8-27B")
GPU_RESERVE_MIB = 1536
CPU_RESERVE_GIB = 12


def meminfo() -> dict:
    out = {}
    for line in Path("/proc/meminfo").read_text().splitlines():
        key, value = line.split(":", 1)
        out[key] = int(value.split()[0]) // 1024
    return out


def gpu_free() -> list[dict]:
    import subprocess
    result = subprocess.run(
        ["nvidia-smi", "--query-gpu=index,memory.total,memory.used",
         "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=20)
    rows = []
    for line in result.stdout.strip().splitlines():
        index, total, used = [int(part.strip()) for part in line.split(",")]
        rows.append({"index": index, "totalMiB": total, "usedMiB": used,
                     "freeMiB": total - used})
    return rows


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--cases", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--index", type=int, default=0)
    parser.add_argument("--max-length", type=int, default=512)
    args = parser.parse_args()

    report: dict = {"schema": "frostecho.r8.live-encode-probe/1",
                    "encoder": str(ENCODER), "startedAt": time.strftime("%Y-%m-%dT%H:%M:%S")}
    before = meminfo()
    gpus = gpu_free()
    report["before"] = {"ramAvailableMiB": before.get("MemAvailable"),
                        "gpus": gpus}
    max_memory = {gpu["index"]: max(0, gpu["freeMiB"] - GPU_RESERVE_MIB) for gpu in gpus}
    max_memory["cpu"] = max(0, (before.get("MemAvailable", 0) - CPU_RESERVE_GIB * 1024))
    report["maxMemoryMiB"] = max_memory
    report["plan"] = "device_map=auto with explicit max_memory; BF16; low_cpu_mem_usage"

    case = None
    with open(args.cases, encoding="utf-8") as stream:
        for line in stream:
            row = json.loads(line)
            if len(row.get("candidates") or []) >= 2:
                case = row
                break
    if case is None:
        report["status"] = "blocked"
        report["reason"] = "no multi-candidate case in the corpus"
        Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2))
        return 3
    report["case"] = {"caseId": case["caseId"], "candidates": len(case["candidates"]),
                      "inputSha256": case.get("inputSha256")}

    started = time.time()
    try:
        import torch
        from transformers import AutoModel, AutoTokenizer
    except Exception as error:  # noqa: BLE001
        report["status"] = "blocked"
        report["reason"] = f"import failed: {error}"
        Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2))
        return 3

    tokenizer = AutoTokenizer.from_pretrained(str(ENCODER), trust_remote_code=True)
    texts = [case["observationText"]] + [candidate["text"] for candidate in case["candidates"]]
    encoded = tokenizer(texts, return_tensors="pt", padding=True,
                        truncation=False, max_length=None)
    lengths = [int(value) for value in encoded["attention_mask"].sum(dim=1)]
    report["tokens"] = {"perText": lengths, "max": max(lengths),
                        "truncated": any(length > args.max_length for length in lengths)}
    if max(lengths) > args.max_length:
        # Never truncate silently: refuse and ask the caller to budget upstream.
        report["status"] = "refused"
        report["reason"] = f"input needs {max(lengths)} tokens > budget {args.max_length}"
        Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2))
        return 4

    load_started = time.time()
    try:
        model = AutoModel.from_pretrained(str(ENCODER), torch_dtype=torch.bfloat16,
                                          device_map="auto", max_memory=max_memory,
                                          low_cpu_mem_usage=True, trust_remote_code=True)
    except Exception as error:  # noqa: BLE001
        report["status"] = "blocked"
        report["reason"] = f"{type(error).__name__}: {error}"
        report["loadSeconds"] = round(time.time() - load_started, 2)
        report["after"] = {"ramAvailableMiB": meminfo().get("MemAvailable"),
                           "gpus": gpu_free()}
        Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2))
        print(json.dumps({"status": "blocked", "reason": report["reason"],
                          "loadSeconds": report["loadSeconds"]}, ensure_ascii=False,
                         indent=2))
        return 3
    model.eval()
    report["loadSeconds"] = round(time.time() - load_started, 2)
    report["deviceMap"] = {str(key): str(value) for key, value in
                           getattr(model, "hf_device_map", {}).items()}

    device = next(model.parameters()).device
    encoded = {key: value.to(device) for key, value in encoded.items()}
    forward_started = time.time()
    with torch.inference_mode():
        hidden = model(**encoded).last_hidden_state
        mask = encoded["attention_mask"]
        last = hidden[torch.arange(hidden.shape[0]), mask.sum(dim=1) - 1]
        vectors = last.float().cpu().numpy()
    report["forwardSeconds"] = round(time.time() - forward_started, 3)
    report["wallSeconds"] = round(time.time() - started, 2)

    after = meminfo()
    report["after"] = {"ramAvailableMiB": after.get("MemAvailable"), "gpus": gpu_free()}
    report["peakRssGiB"] = round(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20, 2)
    report["vectors"] = {"shape": list(vectors.shape), "dtype": str(vectors.dtype),
                         "norms": [round(float(np.linalg.norm(row)), 4) for row in vectors]}
    report["featureSha256"] = __import__("hashlib").sha256(
        vectors.astype(np.float32).tobytes()).hexdigest()
    report["perRequestSeconds"] = report["forwardSeconds"]
    report["status"] = "encoded"
    Path(args.out).write_text(json.dumps(report, ensure_ascii=False, indent=2))
    print(json.dumps({key: report[key] for key in
                      ("status", "loadSeconds", "forwardSeconds", "peakRssGiB",
                       "tokens", "featureSha256")}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
