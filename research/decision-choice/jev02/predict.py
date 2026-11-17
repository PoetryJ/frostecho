#!/usr/bin/env python3
"""Shadow prediction entry: loads one checkpoint in a NEW process.

Returns candidateId, stable-ID probabilities, abstain/reason, model and head
fingerprints. It never submits an Engine command or creates a request binding.
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import contracts as C
from contracts import CLASSES, ORDERS, read_json, sha256_file, sha256_json


def state_sha(path: Path) -> str:
    import torch
    if Path(path).suffix == ".safetensors":
        from safetensors.torch import load_file
        state = load_file(str(path))
    else:
        state = torch.load(path, map_location="cpu", weights_only=False)["state"]
    parts = []
    for key in sorted(state):
        tensor = state[key].detach().cpu().contiguous()
        parts.append(key + ":" + str(tuple(tensor.shape)) + ":" + tensor.numpy().tobytes().hex())
    return sha256_json(parts)


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--checkpoint", required=True)
    parser.add_argument("--context", required=True)
    parser.add_argument("--player", required=True)
    parser.add_argument("--order", type=int, default=0)
    parser.add_argument("--temperature", type=float, default=1.0)
    parser.add_argument("--threshold", type=float, default=0.0)
    args = parser.parse_args(argv)

    import torch
    from backends.local_qwen import LocalQwen
    from heads.train import load_head

    checkpoint = Path(args.checkpoint)
    head, _ = load_head(checkpoint, device="cuda:0")
    model = LocalQwen()
    case = {"visibleInput": {"context": args.context, "playerText": args.player}}
    from ledger import Ledger
    ledger = Ledger(C.EVIDENCE / "jobs.jsonl")
    job = ledger.reserve(f"predict-demo-{args.order}-{int(__import__('time').time())}", "feature", "predict-demo")
    ledger.begin(job); started = __import__("time").time()
    feature = model.features(case, args.order)
    ledger.finish(job, prefill=1, decode=0, tokens_in=feature["tokensIn"], tokens_out=0,
                  seconds=__import__("time").time() - started)
    cand = feature["cand"].float().unsqueeze(0).cuda()
    with torch.no_grad():
        logits = head(cand)[0].cpu().numpy()
    probs = torch.softmax(torch.tensor(logits) / args.temperature, dim=-1).numpy()
    order = ORDERS[args.order]
    stable = {order[i]: float(probs[i]) for i in range(4)}
    best = max(stable, key=stable.get)
    confidence = stable[best]
    abstain = confidence < args.threshold
    reason = ("below_threshold" if abstain else "confident")
    payload = {
        "schema": "frostecho.jev02.prediction/1",
        "candidateId": None if abstain else best,
        "probabilities": stable,
        "abstain": abstain,
        "reason": reason,
        "threshold": args.threshold,
        "displayOrder": list(order),
        "inputTokens": feature["tokensIn"],
        "model": {"sha256": sha256_json(model.identity["model"]), "params": model.params,
                  "devices": model.devices},
        "head": {"path": str(checkpoint), "sha256": state_sha(checkpoint)},
        "shadowOnly": True,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
