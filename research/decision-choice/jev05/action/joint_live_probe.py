#!/usr/bin/env python3
"""One real joint forward on a captured pre-action request; never trains/commits.

Use /data/home/user_00/frostecho-r7/.venv/bin/python.
First capture via scripts/r8/export-encoding-request.mjs --out request.json.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import resource
import sys
import time

import numpy as np

from joint_encoder import JointEncoder, ROOT, file_sha, memory_plan, prepare


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--encoder", type=Path, default=Path("/data2/model_weights/Qwen3.8-27B"))
    parser.add_argument("--head", type=Path, default=ROOT / (
        "artifacts/sprint-r7/legacy-reuse/c43-increment-batch4-1/warm-start-17/best.safetensors"))
    parser.add_argument("--physical-gpu", type=int, default=1)
    parser.add_argument("--max-length", type=int, default=2048)
    parser.add_argument("--placement", choices=("auto", "one-layer-offload"), default="auto")
    args = parser.parse_args()
    if args.out.exists():
        raise SystemExit("output exists; choose a new run path")
    args.out.parent.mkdir(parents=True, exist_ok=True)
    os.environ["CUDA_VISIBLE_DEVICES"] = str(args.physical_gpu)
    report = {"schema": "frostecho.r8.joint-live-probe/2", "status": "starting",
              "python": sys.executable, "startedAt": time.time(),
              "requestFileSha256": file_sha(args.request),
              "encoderCodeSha256": file_sha(Path(__file__).with_name("joint_encoder.py")),
              "probeCodeSha256": file_sha(Path(__file__)),
              "encoderForwardCalls": 0, "encoderForwardAttempts": 0, "headForwardCalls": 0,
              "gameCommits": 0, "experimental": True, "countsAsAdmitted": False,
              "note": "Old priority head transferred to new actions for mechanism measurement; no action-policy quality or calibration claim."}
    with args.out.open("x", encoding="utf-8") as stream:
        json.dump(report, stream, ensure_ascii=False, indent=2)

    def checkpoint():
        args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"status": report["status"], "report": str(args.out)}, ensure_ascii=True), flush=True)

    try:
        from transformers import AutoTokenizer
        from safetensors.numpy import load_file
        envelope = json.loads(args.request.read_text(encoding="utf-8"))
        tokenizer = AutoTokenizer.from_pretrained(
            str(args.encoder), local_files_only=True, trust_remote_code=False)
        prepared = prepare(tokenizer, envelope, args.max_length)
        report["input"] = {key: value for key, value in prepared.items() if key != "tokenIds"}
        report["input"]["tokens"] = len(prepared["tokenIds"])
        report["sourceHEAD"] = envelope["sourceHEAD"]
        report["capacity"] = memory_plan(args.physical_gpu)
        report["status"] = "loading"
        checkpoint()
        encoder = JointEncoder(args.encoder, args.out.parent, args.physical_gpu, args.placement)
        report["encoder"] = encoder.identity
        report["status"] = "forward"
        report["encoderForwardAttempts"] = 1
        checkpoint()
        vectors, trace = encoder.encode(prepared)
        report["encoderForwardCalls"] = 1
        report["forward"] = trace
        feature_path = args.out.with_suffix(".features.npz")
        with feature_path.open("xb") as stream:
            np.savez_compressed(stream, cand=vectors,
                                candidateIds=np.array(prepared["candidateIds"]),
                                tokenIds=np.array(prepared["tokenIds"], dtype=np.int64))
        weights = load_file(str(args.head))["score.weight"].reshape(-1).astype(np.float64)
        if weights.shape != (5120,) or not np.isfinite(weights).all():
            raise ValueError("invalid real C head")
        h = vectors.astype(np.float64)
        centered = h - h.mean(-1, keepdims=True)
        normalized = centered / np.sqrt(np.mean(centered ** 2, -1, keepdims=True) + 1e-5)
        logits = normalized @ weights
        if not np.isfinite(logits).all():
            raise ValueError("nonfinite real head logits")
        probs = np.exp(logits - logits.max())
        probs /= probs.sum()
        report.update({
            "status": "encoded", "headForwardCalls": 1,
            "headSha256": file_sha(args.head), "temperature": 1.0, "calibrated": False,
            "featuresFile": str(feature_path), "featuresFileSha256": file_sha(feature_path),
            "scores": [{"candidateId": cid, "logit": float(logit), "probability": float(prob)}
                       for cid, logit, prob in zip(prepared["candidateIds"], logits, probs)],
            "selectedId": prepared["candidateIds"][int(np.argmax(logits))],
        })
        code = 0
    except Exception as error:
        import traceback
        report.update(status="failed", errorType=type(error).__name__, reason=str(error),
                      traceback=traceback.format_exc())
        code = 1
    report["wallSeconds"] = time.time() - report["startedAt"]
    report["peakRssGiB"] = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss / 2**20
    torch = sys.modules.get("torch")
    if torch is not None and torch.cuda.is_initialized():
        report["peakCudaAllocatedMiB"] = torch.cuda.max_memory_allocated(0) / 2**20
    checkpoint()
    return code


if __name__ == "__main__":
    raise SystemExit(main())
