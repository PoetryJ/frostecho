#!/usr/bin/env python3
"""Probe the joint-encoder feature identity under a pinned amount of free VRAM.

    python probe-identity.py --encoder /data2/model_weights/Qwen3.8-27B --hog-mib 2048

The identity (`frostecho.joint-c-feature-identity/1`) contains `deviceMap` and
`actualParameterBytesByDevice`, so it depends on how much VRAM was free when the
encoder was placed. This probe measures that dependence instead of assuming it:
it parks `--hog-mib` on the card first, then lets `memory_plan` + accelerate
place the model exactly as `encode_joint_corpus.py` / `serve_joint.py` do.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent / "jev05" / "action"))


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--encoder", type=Path, default=Path("/data2/model_weights/Qwen3.8-27B"))
    parser.add_argument("--physical-gpu", type=int, default=1)
    parser.add_argument("--placement", default="auto", choices=("auto", "one-layer-offload"))
    parser.add_argument("--hog-mib", type=int, default=0)
    parser.add_argument("--out", type=Path)
    args = parser.parse_args()
    os.environ["CUDA_VISIBLE_DEVICES"] = str(args.physical_gpu)

    import torch
    hog = None
    if args.hog_mib > 0:
        torch.cuda.init()
        hog = torch.empty(args.hog_mib * 1024 * 1024 // 4, dtype=torch.float32,
                          device="cuda:0")
        hog.fill_(1.0)
        torch.cuda.synchronize(0)
    work = args.out or Path("/tmp/r10c-identity-probe")
    work.mkdir(parents=True, exist_ok=True)

    from joint_encoder import JointEncoder  # imported after CUDA_VISIBLE_DEVICES

    import contextlib  # loader progress must not pollute the JSON on stdout
    with contextlib.redirect_stdout(sys.stderr):
        encoder = JointEncoder(args.encoder, work, physical_gpu=args.physical_gpu,
                               placement=args.placement,
                               physical_gpus=[args.physical_gpu])
    identity = encoder.feature_identity(pad_multiple=8)
    digest = hashlib.sha256(json.dumps(identity, ensure_ascii=False, sort_keys=True,
                                       separators=(",", ":")).encode()).hexdigest()
    result = {
        "schema": "frostecho.r10c.identity-probe/1",
        "hogMiB": args.hog_mib,
        "placement": args.placement,
        "physicalGpu": args.physical_gpu,
        "freeGpuMiBWhenPlaced": encoder.identity["memoryPlan"]["freeGpuMiBByPhysical"],
        "maxMemoryBytes": encoder.identity["memoryPlan"]["maxMemoryBytes"],
        "deviceMapCounts": {str(key): sum(1 for value in encoder.identity["deviceMap"].values()
                                          if value == key)
                            for key in set(encoder.identity["deviceMap"].values())},
        "bytesByDevice": encoder.identity["actualParameterBytesByDevice"],
        "featureIdentityHash": digest,
        "loadSeconds": encoder.identity["loadSeconds"],
        "encoderSourceSha256": encoder.identity["encoderSourceSha256"],
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if args.out:
        (Path(args.out) / f"probe-hog{args.hog_mib}-{args.placement}.json").write_text(
            json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    del hog
    return 0


if __name__ == "__main__":
    sys.exit(main())
