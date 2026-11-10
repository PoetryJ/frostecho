#!/usr/bin/env python3
"""Reproducible training-pipeline fixture (B).

This is NOT a JEV result and NOT trained on JEV data. The data gate for the
4096-case set has not passed, so instead of training on dirty data this script
proves the pipeline on synthetic feature vectors:
  - frozen trunk + shared scalar head, K independent candidate encodings;
  - listwise cross-entropy over one correct candidate per group;
  - two registered seeds, gradient audit, save/load equality;
  - a checkpoint and full per-epoch loss log for each seed.

It deliberately does not claim model quality. Replacing `encode()` with a real
frozen backbone is the only step needed once the data gate passes.
"""
from __future__ import annotations

import hashlib
import json
import sys
from pathlib import Path

import torch
from torch import nn

HERE = Path(__file__).resolve().parent
OUT = HERE / "fixture-run"
DIM = 32
K = 4
GROUPS = 128
STEPS = 80
LR = 1e-3
SEEDS = (17, 43)


class Scorer(nn.Module):
    def __init__(self, seed: int) -> None:
        super().__init__()
        generator = torch.Generator().manual_seed(seed)
        self.trunk = nn.Linear(DIM, DIM)
        with torch.no_grad():
            self.trunk.weight.copy_(torch.randn(DIM, DIM, generator=generator) * 0.1)
            self.trunk.bias.zero_()
        for parameter in self.trunk.parameters():
            parameter.requires_grad_(False)
        self.head = nn.Linear(DIM, 1, bias=False)

    def forward(self, candidates: torch.Tensor) -> torch.Tensor:
        # candidates: [groups, K, DIM] -> one scalar per candidate
        hidden = torch.tanh(self.trunk(candidates))
        return self.head(hidden).squeeze(-1)

    def encode(self, features: torch.Tensor) -> torch.Tensor:
        return torch.tanh(self.trunk(features))


def make_data(seed: int) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor, torch.Tensor]:
    generator = torch.Generator().manual_seed(seed)
    features = torch.randn(GROUPS, K, DIM, generator=generator)
    # The correct candidate is the one with the largest projection on a fixed
    # direction; this is synthetic and unrelated to any FrostEcho label.
    direction = torch.randn(DIM, generator=torch.Generator().manual_seed(999))
    labels = (features @ direction).argmax(dim=-1)
    split = 96
    return features[:split], labels[:split], features[split:], labels[split:]


def evaluate(model: Scorer, features: torch.Tensor, labels: torch.Tensor) -> dict:
    with torch.no_grad():
        logits = model(features)
        loss = nn.functional.cross_entropy(logits, labels).item()
        accuracy = (logits.argmax(dim=-1) == labels).float().mean().item()
    return {"loss": round(loss, 6), "accuracy": round(accuracy, 6)}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def overfit_probe(seed: int = 17, groups: int = 16, steps: int = 300) -> dict:
    """Small-batch overfit: proves label mapping, gradients and loss wiring."""
    torch.manual_seed(seed)
    features, labels, _, _ = make_data(seed)
    features, labels = features[:groups], labels[:groups]
    model = Scorer(seed)
    parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
    optimizer = torch.optim.AdamW(parameters, lr=0.05)
    for _ in range(steps):
        optimizer.zero_grad()
        loss = nn.functional.cross_entropy(model(features), labels)
        loss.backward()
        optimizer.step()
    with torch.no_grad():
        logits = model(features)
        accuracy = (logits.argmax(dim=-1) == labels).float().mean().item()
    return {"groups": groups, "steps": steps, "trainAccuracy": round(accuracy, 6)}


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {"schema": "frostecho.jev04.training-fixture/1",
                "note": "synthetic pipeline fixture only; not JEV data, not a model result",
                "config": {"dim": DIM, "k": K, "groups": GROUPS, "steps": STEPS, "lr": LR,
                           "seeds": list(SEEDS), "optimizer": "AdamW", "loss": "listwise CE"},
                "runs": []}
    for seed in SEEDS:
        torch.manual_seed(seed)
        train_x, train_y, dev_x, dev_y = make_data(seed)
        model = Scorer(seed)
        parameters = [parameter for parameter in model.parameters() if parameter.requires_grad]
        optimizer = torch.optim.AdamW(parameters, lr=LR)
        log_path = OUT / f"train-{seed}.jsonl"
        with log_path.open("w", encoding="utf-8") as log:
            for step in range(STEPS):
                model.train()
                optimizer.zero_grad()
                logits = model(train_x)
                loss = nn.functional.cross_entropy(logits, train_y)
                loss.backward()
                # Gradient audit: the frozen trunk must have no gradient.
                trunk_grads = [p.grad for p in model.trunk.parameters()]
                head_grads = [p.grad for p in model.head.parameters()]
                if any(grad is not None for grad in trunk_grads):
                    raise SystemExit("trunk received a gradient")
                if all(grad is None for grad in head_grads):
                    raise SystemExit("head received no gradient")
                optimizer.step()
                log.write(json.dumps({"step": step, "trainLoss": round(loss.item(), 6),
                                      "dev": evaluate(model, dev_x, dev_y)}) + "\n")
        final = evaluate(model, dev_x, dev_y)
        checkpoint = OUT / f"checkpoint-{seed}.pt"
        torch.save({"config": manifest["config"], "seed": seed,
                    "stateDict": model.state_dict(), "dev": final}, checkpoint)
        # Save/load equality on the same dev features.
        loaded = Scorer(seed)
        payload = torch.load(checkpoint, weights_only=False)
        loaded.load_state_dict(payload["stateDict"])
        with torch.no_grad():
            delta = (model(dev_x) - loaded(dev_x)).abs().max().item()
        trainable = sum(parameter.numel() for parameter in parameters)
        manifest["runs"].append({
            "seed": seed, "dev": final, "trainableParameters": trainable,
            "frozenParameters": sum(parameter.numel() for parameter in model.trunk.parameters()),
            "saveLoadMaxDelta": delta, "checkpoint": checkpoint.name,
            "checkpointSha256": sha256_file(checkpoint),
            "log": log_path.name, "logSha256": sha256_file(log_path),
        })
        print(json.dumps(manifest["runs"][-1], ensure_ascii=False))
    manifest["overfitProbe"] = overfit_probe()
    path = OUT / "model-manifest.json"
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
