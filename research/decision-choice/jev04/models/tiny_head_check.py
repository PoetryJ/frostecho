#!/usr/bin/env python3
"""R4 (G7): CPU tiny-fixture proof for the jev choice head.

MECHANISM ONLY (logged as `fixture`, never as real-model evidence):
  1. candidate encoding -> shared head forward
  2. synthetic optimisation with a MULTI-ACCEPTABLE loss
  3. save head + manifest (arm/seed/config/budget/device/weight id)
  4. a NEW process loads the head and reproduces identical logits + stats

Exit non-zero when save/load fails or the reload diverges.
Run: python3 tiny_head_check.py [--out DIR]
     python3 tiny_head_check.py --reload HEAD.pt
"""
from __future__ import annotations

import argparse
import hashlib
import os
import json
import sys
import tempfile
import time
from pathlib import Path

import torch

SEED = 17
FEATURES = 16
HIDDEN = 8


def candidate_features(case_index: int, candidate_index: int) -> list[float]:
    digest = hashlib.sha256(f"{case_index}:{candidate_index}".encode()).digest()
    return [(byte / 255.0) * 2 - 1 for byte in digest[:FEATURES]]


def synthetic_case(index: int) -> dict:
    candidates = [candidate_features(index, slot) for slot in range(4)]
    acceptable = [0, 1] if index % 3 else [1, 2]
    return {"caseId": f"tiny-{index:03d}", "candidates": candidates,
            "acceptable": acceptable}


def build_head() -> torch.nn.Module:
    torch.manual_seed(SEED)
    return torch.nn.Sequential(torch.nn.Linear(FEATURES, HIDDEN), torch.nn.Tanh(),
                               torch.nn.Linear(HIDDEN, 1))


def acceptable_loss(logits: torch.Tensor, acceptable: list[int]) -> torch.Tensor:
    """Negative log of the softmax mass on the acceptable set (>= 0)."""
    all_mass = torch.logsumexp(logits, dim=0)
    accept_mass = torch.logsumexp(logits[torch.tensor(acceptable)], dim=0)
    return all_mass - accept_mass


def train_steps(head: torch.nn.Module, steps: int) -> dict:
    optimizer = torch.optim.SGD(head.parameters(), lr=0.05)
    cases = [synthetic_case(index) for index in range(24)]
    device = os.environ.get("R4_TINY_DEVICE", "cpu")
    head.to(device)
    losses: list[float] = []
    started = time.time()
    for _ in range(steps):
        total = torch.zeros((), device=device)
        for case in cases:
            features = torch.tensor(case["candidates"], dtype=torch.float32, device=device)
            logits = head(features).squeeze(-1)
            total = total + acceptable_loss(logits, case["acceptable"])
        total = total / len(cases)
        optimizer.zero_grad()
        total.backward()
        optimizer.step()
        losses.append(float(total.detach().cpu()))
    head.to("cpu")
    return {"device": device, "durationSeconds": round(time.time() - started, 3),
            "initialLoss": round(losses[0], 6), "finalLoss": round(losses[-1], 6),
            "steps": steps}


def evaluate(head: torch.nn.Module) -> dict:
    hits = 0
    losses = []
    per_case = {}
    head.eval()
    with torch.no_grad():
        for case in [synthetic_case(index) for index in range(24)]:
            features = torch.tensor(case["candidates"], dtype=torch.float32)
            logits = head(features).squeeze(-1)
            losses.append(float(acceptable_loss(logits, case["acceptable"])))
            best = int(torch.argmax(logits).item())
            if best in case["acceptable"]:
                hits += 1
            per_case[case["caseId"]] = [round(float(value), 6)
                                        for value in logits.tolist()]
    return {"top1InAcceptable": hits / 24,
            "acceptableLoss": round(sum(losses) / len(losses), 6),
            "perCaseLogits": per_case}


def weight_digest(head: torch.nn.Module) -> str:
    digest = hashlib.sha256()
    for name, tensor in head.state_dict().items():
        digest.update(name.encode())
        digest.update(tensor.detach().cpu().numpy().tobytes())
    return digest.hexdigest()


def load_check(path: Path) -> dict:
    head = build_head()
    head.load_state_dict(torch.load(path, map_location="cpu", weights_only=True))
    head.eval()
    result = evaluate(head)
    result["weightDigest"] = weight_digest(head)
    return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=None)
    parser.add_argument("--reload", default=None)
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compare", default=None,
                        help="JSON of the first process, for equality checks")
    args = parser.parse_args()

    if args.reload:
        loaded = load_check(Path(args.reload))
        if args.compare:
            baseline = json.loads(Path(args.compare).read_text(encoding="utf-8"))
            same = (baseline["weightDigest"] == loaded["weightDigest"]
                    and baseline["perCaseLogits"] == loaded["perCaseLogits"])
            print(json.dumps({"mode": "reload", "identical": same,
                              "weightDigest": loaded["weightDigest"]}))
            return 0 if same else 3
        print(json.dumps({"mode": "reload", **loaded})[:400])
        return 0

    out = Path(args.out) if args.out else Path(tempfile.mkdtemp(prefix="tiny-head-"))
    out.mkdir(parents=True, exist_ok=True)
    head = build_head()
    training = train_steps(head, steps=6)
    metrics = evaluate(head)
    digest = weight_digest(head)
    head_path = out / "head.pt"
    torch.save(head.state_dict(), head_path)
    manifest = {
        "schema": "frostecho.jev04.tiny-head/1",
        "evidenceClass": "fixture",
        "arm": "CPU-tiny",
        "seed": SEED,
        "config": {"features": FEATURES, "hidden": HIDDEN, "K": 4,
                   "loss": "multi-acceptable-negative-log-mass"},
        "budget": {"steps": training["steps"], "gpuSeconds": 0},
        "device": training["device"],
        "durationSeconds": training["durationSeconds"],
        "initialLoss": training["initialLoss"],
        "finalLoss": training["finalLoss"],
        "top1InAcceptable": metrics["top1InAcceptable"],
        "acceptableLoss": metrics["acceptableLoss"],
        "weightDigest": digest,
        "headPath": str(head_path),
        "weightsSha256": hashlib.sha256(head_path.read_bytes()).hexdigest(),
        "realModel": False,
        "note": "mechanism proof only; not a training result and not model quality",
    }
    (out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (out / "metrics.json").write_text(
        json.dumps({"weightDigest": digest,
                    "perCaseLogits": metrics["perCaseLogits"]},
                   ensure_ascii=False) + "\n", encoding="utf-8")

    reload = subprocess_run([sys.executable, str(Path(__file__).resolve()),
                             "--reload", str(head_path),
                             "--compare", str(out / "metrics.json")])
    ok = reload.returncode == 0 and json.loads(reload.stdout).get("identical") is True
    manifest["reloadIdentical"] = ok
    (out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": ok, "out": str(out), "manifest": manifest},
                     ensure_ascii=False)[:800])
    return 0 if ok else 2


def subprocess_run(command: list[str]):
    import subprocess
    return subprocess.run(command, capture_output=True, text=True)


if __name__ == "__main__":
    sys.exit(main())
