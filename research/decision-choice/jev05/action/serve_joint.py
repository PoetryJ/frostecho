#!/usr/bin/env python3
"""Persistent JSONL scorer over the real joint encoder.

One process, one model load. Each line on stdin is a real
`frostecho.joint-encoding-request/1` envelope produced by the TS renderer
(`scripts/r8/export-encoding-request.mjs`). Each line on stdout is the score for
exactly that request; logs go to stderr.

    .venv/bin/python serve_joint.py --certificate <cert.json> --mode jev-experimental

The head is the original joint-C head: non-affine LayerNorm (eps 1e-5) over each
candidate's own hidden vector, then one shared bias-free linear score, then
softmax(logits / T). `tau` decides accept vs abstain.

Admission is decided by a real certificate, never by a flag or by the mere
existence of a file: the certificate must name the encoder, renderer, memory
policy, head hash and the per-sample recomputation it was bound to.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from joint_encoder import JointEncoder, ROOT, file_sha, prepare  # noqa: E402

HEAD = ROOT / ("artifacts/sprint-r7/legacy-reuse/c43-increment-batch4-1/"
               "warm-start-17/best.safetensors")
ENCODER = Path("/data2/model_weights/Qwen3.8-27B")
EPS = 1e-5


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def load_head(path: Path) -> np.ndarray:
    from safetensors.numpy import load_file
    weights = load_file(str(path))["score.weight"].reshape(-1).astype(np.float64)
    if weights.shape[0] != 5120 or not np.isfinite(weights).all():
        raise ValueError("invalid joint-C head")
    return weights


def normalized(features: np.ndarray) -> np.ndarray:
    """Non-affine LayerNorm, exactly the original head input."""
    centered = features - features.mean(axis=-1, keepdims=True)
    variance = np.mean(centered ** 2, axis=-1, keepdims=True)
    return centered / np.sqrt(variance + EPS)


def read_certificate(path: Path | None) -> dict | None:
    """A certificate is valid only when its own content checks out."""
    if path is None or not path.exists():
        return None
    try:
        document = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    if document.get("schema") != "frostecho.jev.certificate/1":
        return None
    required = ["encoderId", "rendererId", "headSha256", "memoryPolicyId",
                "samples", "perSampleRecomputeSha256", "issuedAt"]
    if any(key not in document for key in required):
        return None
    if not isinstance(document["samples"], int) or document["samples"] <= 0:
        return None
    if document["perSampleRecomputeSha256"] in ("", "0" * 64):
        return None
    return document


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--encoder", type=Path, default=ENCODER)
    parser.add_argument("--head", type=Path, default=HEAD)
    parser.add_argument("--physical-gpu", type=int, default=1)
    parser.add_argument("--placement", default="auto",
                        choices=["auto", "cpu", "one-layer-offload"])
    parser.add_argument("--max-length", type=int, default=2048)
    parser.add_argument("--temperature", type=float, default=1.0)
    parser.add_argument("--tau", type=float, default=0.0,
                        help="abstain below this top probability (0 = always accept)")
    parser.add_argument("--memory-policy", default="conditional-experience")
    parser.add_argument("--mode", default="jev-experimental",
                        choices=["jev-experimental", "jev-admitted"])
    parser.add_argument("--certificate", type=Path, default=None)
    args = parser.parse_args()

    head_sha = file_sha(args.head)
    weights = load_head(args.head)
    certificate = read_certificate(args.certificate)
    certified = certificate is not None
    admission_ok = bool(certified and args.mode == "jev-admitted"
                        and certificate.get("headSha256") == head_sha
                        and certificate.get("rendererId") == "joint-c-action/1"
                        and certificate.get("memoryPolicyId") == args.memory_policy)
    identity = {
        "scorerId": "jev-joint-c/1",
        "mode": args.mode,
        "encoderId": str(args.encoder),
        "headSha256": head_sha,
        "rendererId": "joint-c-action/1",
        "memoryPolicyId": args.memory_policy,
        "temperature": args.temperature,
        "tau": args.tau,
        "certificateSha256": file_sha(args.certificate) if certified else None,
        "experimental": not admission_ok,
        "countsAsAdmitted": admission_ok,
    }
    log(json.dumps({"event": "identity", **identity}, ensure_ascii=False))

    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(str(args.encoder), local_files_only=True,
                                              trust_remote_code=False)
    encoder = JointEncoder(args.encoder, ROOT / "artifacts/r8-live-joint", args.physical_gpu,
                           args.placement)
    log(json.dumps({"event": "encoder", **encoder.identity}, ensure_ascii=False))

    forward_calls = 0
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        started = time.monotonic()
        try:
            envelope = json.loads(line)
            prepared = prepare(tokenizer, envelope, args.max_length)
            vectors, trace = encoder.encode(prepared)
            forward_calls += 1
            logits = normalized(vectors) @ weights
            scaled = logits / max(args.temperature, 1e-6)
            shifted = np.exp(scaled - scaled.max())
            probabilities = shifted / shifted.sum()
            best = int(np.argmax(probabilities))
            accept = bool(probabilities[best] >= args.tau)
            identity["encoderForwardCalls"] = forward_calls
            result = {
                "requestId": envelope["request"]["requestId"],
                "candidateSetHash": envelope["request"]["candidateSetHash"],
                "inputSha256": envelope["inputSha256"],
                "scores": [{"candidateId": candidate_id,
                            "logit": float(logits[index]),
                            "probability": float(probabilities[index])}
                           for index, candidate_id in enumerate(prepared["candidateIds"])],
                "selectedId": prepared["candidateIds"][best] if accept else None,
                "disposition": "accept" if accept else "abstain",
                "reason": (f"joint-c argmax p={probabilities[best]:.4f} at T={args.temperature}"
                           if accept else
                           f"abstain: top p={probabilities[best]:.4f} < tau={args.tau}"),
                "identity": identity,
                "encoder": trace,
                "latencyMs": round((time.monotonic() - started) * 1000, 3),
            }
        except Exception as error:  # noqa: BLE001
            result = {"error": f"{type(error).__name__}: {error}",
                      "latencyMs": round((time.monotonic() - started) * 1000, 3)}
        sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
        sys.stdout.flush()
    log(json.dumps({"event": "exit", "encoderForwardCalls": forward_calls}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
