"""C: six fixed training runs (2 heads x 3 seeds), dev-NLL checkpointing."""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import torch
from torch import nn

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from contracts import RUNS, TRAIN, sha256_json, write_json  # noqa: E402
from heads.models import build_head, masked_cross_entropy  # noqa: E402


def state_hash(state: dict[str, torch.Tensor]) -> str:
    parts = []
    for key in sorted(state):
        tensor = state[key].detach().cpu().contiguous()
        parts.append(key + ":" + str(tuple(tensor.shape)) + ":")
        parts.append(tensor.numpy().tobytes().hex())
    return sha256_json(parts)


def _tensors(features: dict, indices: np.ndarray) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    cand = torch.from_numpy(features["cand"][indices]).float()
    hq = torch.from_numpy(features["hq"][indices]).float()
    target = torch.from_numpy(features["labelIndex"][indices]).long()
    mask = torch.ones(target.shape[0], cand.shape[1], dtype=torch.bool)
    return cand, hq, target, mask


def _forward(head: nn.Module, kind: str, cand, hq):
    return head(cand) if kind == "linear_head" else head(cand, hq)


def _eval(head: nn.Module, kind: str, features: dict, indices: np.ndarray) -> dict:
    head.eval()
    with torch.no_grad():
        cand, hq, target, mask = _tensors(features, indices)
        logits = _forward(head, kind, cand, hq)
        loss = masked_cross_entropy(logits, target, mask)
        pred = logits.argmax(dim=1)
        acc = (pred == target).float().mean().item()
    return {"nll": float(loss), "accuracy": acc}


def train_head(kind: str, seed: int, train: dict, dev: dict) -> dict:
    torch.manual_seed(seed)
    np.random.seed(seed)
    head = build_head(kind, hidden=TRAIN["hidden"], rank=TRAIN["rank"])
    params = [p for p in head.parameters() if p.requires_grad]
    optimizer = torch.optim.AdamW(params, lr=TRAIN["lr"], weight_decay=TRAIN["weight_decay"])
    rng = np.random.default_rng(seed)
    n = len(train["labelIndex"])
    indices = np.arange(n)
    best = {"nll": float("inf"), "epoch": 0, "state": None}
    history = []
    bad_epochs = 0
    started = time.time()
    for epoch in range(1, TRAIN["epochs_max"] + 1):
        head.train()
        rng.shuffle(indices)
        losses = []
        for start in range(0, n, TRAIN["batch_size"]):
            batch = indices[start:start + TRAIN["batch_size"]]
            cand, hq, target, mask = _tensors(train, batch)
            logits = _forward(head, kind, cand, hq)
            loss = masked_cross_entropy(logits, target, mask)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(params, TRAIN["grad_clip"])
            only_head = all(p.grad is None or p.grad.shape == p.shape for p in params)
            if not only_head:
                raise RuntimeError("a non-head tensor received a gradient")
            optimizer.step()
            losses.append(float(loss))
        dev_metrics = _eval(head, kind, dev, np.arange(len(dev["labelIndex"])))
        history.append({"epoch": epoch, "trainLoss": round(float(np.mean(losses)), 6),
                        "devNll": round(dev_metrics["nll"], 6), "devAcc": round(dev_metrics["accuracy"], 6)})
        if dev_metrics["nll"] < best["nll"] - 1e-6:
            best = {"nll": dev_metrics["nll"], "epoch": epoch,
                    "state": {k: v.detach().clone() for k, v in head.state_dict().items()}}
            bad_epochs = 0
        else:
            bad_epochs += 1
            if bad_epochs >= TRAIN["patience"]:
                break
    assert best["state"] is not None
    head.load_state_dict(best["state"])
    dev_final = _eval(head, kind, dev, np.arange(len(dev["labelIndex"])))
    out_dir = RUNS / f"{kind}-seed{seed}"
    out_dir.mkdir(parents=True, exist_ok=True)
    torch.save({"state": best["state"], "kind": kind, "seed": seed, "hidden": TRAIN["hidden"],
                "rank": TRAIN["rank"], "bestEpoch": best["epoch"], "devNll": best["nll"]},
               out_dir / "head.pt")
    weight_sha = state_hash(best["state"])
    record = {
        "schema": "frostecho.jev01.head-run/1",
        "kind": kind,
        "seed": seed,
        "bestEpoch": best["epoch"],
        "devNll": best["nll"],
        "devAccuracy": dev_final["accuracy"],
        "epochsRun": len(history),
        "seconds": round(time.time() - started, 3),
        "paramCount": int(sum(p.numel() for p in head.parameters())),
        "trainable": [name for name, p in head.named_parameters() if p.requires_grad],
        "weightSha256": weight_sha,
        "history": history,
        "optimizer": {"name": "AdamW", "lr": TRAIN["lr"], "weightDecay": TRAIN["weight_decay"],
                      "batchSize": TRAIN["batch_size"], "gradClip": TRAIN["grad_clip"], "maxEpochs": TRAIN["epochs_max"],
                      "patience": TRAIN["patience"]},
        "trainCount": int(n),
        "devCount": int(len(dev["labelIndex"])),
    }
    write_json(out_dir / "run.json", record)
    return record


def train_all(train: dict, dev: dict) -> list[dict]:
    records = []
    for kind in ("linear_head", "pointer_head"):
        for seed in TRAIN["seeds"]:
            records.append(train_head(kind, seed, train, dev))
    return records


def load_head(kind: str, seed: int, hidden: int = TRAIN["hidden"], rank: int = TRAIN["rank"]):
    path = RUNS / f"{kind}-seed{seed}" / "head.pt"
    payload = torch.load(path, map_location="cpu", weights_only=False)
    head = build_head(kind, hidden=hidden, rank=rank)
    head.load_state_dict(payload["state"])
    head.eval()
    return head
