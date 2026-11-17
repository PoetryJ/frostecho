"""C: M1/M2 training. Four permutations per case; loss aligned by stable ID."""
from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from contracts import ORDERS, RUNS, TRAIN, sha256_json  # noqa: E402
from heads.models import build_head  # noqa: E402
from data.features_io import load_split  # noqa: E402

PERM = len(ORDERS)


def state_hash(state: dict[str, torch.Tensor]) -> str:
    parts = []
    for key in sorted(state):
        tensor = state[key].detach().cpu().contiguous()
        parts.append(key + ":" + str(tuple(tensor.shape)) + ":" + tensor.numpy().tobytes().hex())
    return sha256_json(parts)


def _perm_index(stable: str, order_index: int) -> int:
    return ORDERS[order_index].index(stable)


class Grouped:
    """Rows grouped by case; each case has 4 presentation permutations."""

    def __init__(self, split: str, model_sha: str, cases_sha: str):
        data, meta = load_split(split, model_sha, cases_sha)
        self.cand = data["cand"].astype(np.float32)
        self.hq = data["hq"].astype(np.float32)
        self.orders = data["orderIdx"].astype(np.int64)
        self.caseIds = [str(v) for v in data["caseIds"]]
        self.labelIndex = data["labelIndex"].astype(np.int64)
        self.meta = meta
        groups: dict[str, list[int]] = {}
        for index, case_id in enumerate(self.caseIds):
            groups.setdefault(case_id, []).append(index)
        self.cases = sorted(groups)
        self.rows = [groups[case] for case in self.cases]
        for case, rows in zip(self.cases, self.rows):
            if len(rows) != PERM or sorted(int(self.orders[r]) for r in rows) != list(range(PERM)):
                raise ValueError(f"{case}: expected {PERM} permutations, got {rows}")

    def batch(self, ids: list[int], device: str):
        rows = [self.rows[i] for i in ids]
        cand = np.stack([self.cand[r] for r in rows])          # [B,4,K,H]
        hq = np.stack([self.hq[r] for r in rows])              # [B,4,H]
        label = np.array([self.labelIndex[r[0]] for r in rows])
        cand = torch.from_numpy(cand).to(device)
        hq = torch.from_numpy(hq).to(device)
        return cand, hq, torch.from_numpy(label).to(device)

    def __len__(self) -> int:
        return len(self.cases)


def stable_probs(logits: torch.Tensor) -> torch.Tensor:
    """logits [B,P,K] in display order -> probabilities in stable class order."""
    probs = torch.softmax(logits, dim=-1)
    out = torch.empty_like(probs)
    for perm in range(PERM):
        for position, stable in enumerate(ORDERS[perm]):
            out[:, perm, CLASS_INDEX[stable]] = probs[:, perm, position]
    return out


CLASS_INDEX = {stable: index for index, stable in enumerate(
    ("PLAYER_FIRST", "NPC_FIRST", "NO_PRIORITY_REQUEST", "NEEDS_CLARIFICATION"))}


def batch_loss(head, variant: str, cand, hq, label, mask=None):
    logits = torch.stack([head(cand[:, perm]) for perm in range(PERM)], dim=1)  # [B,P,K]
    if mask is not None:
        logits = logits.masked_fill(~mask[:, None, :], float("-inf"))
    # label is the true position in the PRIMARY permutation; each permutation
    # needs its own target position for the same stable semantic ID.
    stable_ids = [ORDERS[0][int(index)] for index in label]
    targets = torch.tensor([[ORDERS[perm].index(stable) for perm in range(PERM)] for stable in stable_ids],
                           device=label.device)
    logp = logits - torch.logsumexp(logits, dim=-1, keepdim=True)
    ce = F.cross_entropy(logp.reshape(-1, logits.shape[-1]), targets.reshape(-1))
    if variant == "M1":
        return ce, {"ce": float(ce)}
    aligned = stable_probs(logits)                          # [B,P,K] stable order
    mean = aligned.mean(dim=1, keepdim=True)
    kl = (aligned * (torch.log(aligned.clamp_min(1e-12)) - torch.log(mean.clamp_min(1e-12)))).sum(-1).mean()
    loss = ce + TRAIN["consistency_weight"] * kl
    return loss, {"ce": float(ce), "js": float(kl), "total": float(loss)}


def evaluate(head, grouped: Grouped, device: str) -> dict:
    head.eval()
    total_loss = 0.0
    correct = 0
    n = 0
    with torch.no_grad():
        for start in range(0, len(grouped), TRAIN["batch_groups"]):
            ids = list(range(start, min(start + TRAIN["batch_groups"], len(grouped))))
            cand, hq, label = grouped.batch(ids, device)
            logits = torch.stack([head(cand[:, perm]) for perm in range(PERM)], dim=1)
            logp = logits - torch.logsumexp(logits, dim=-1, keepdim=True)
            loss = F.nll_loss(logp[:, 0], label)
            total_loss += float(loss) * len(ids)
            correct += int((logp[:, 0].argmax(dim=-1) == label).sum())
            n += len(ids)
    return {"nll": total_loss / n, "accuracy": correct / n, "n": n}


def train_run(variant: str, seed: int, train: Grouped, dev: Grouped, device: str = "cuda:0") -> dict:
    torch.manual_seed(seed)
    np.random.seed(seed)
    head = build_head("linear_head", hidden=TRAIN["hidden"]).to(device)
    optimizer = torch.optim.AdamW(head.parameters(), lr=TRAIN["lr"], weight_decay=TRAIN["weight_decay"])
    rng = np.random.default_rng(seed)
    out_dir = RUNS / f"{variant}-seed{seed}"
    out_dir.mkdir(parents=True, exist_ok=True)
    history = []
    best = {"nll": float("inf"), "epoch": 0}
    bad = 0
    started = time.time()
    order = np.arange(len(train))
    for epoch in range(1, TRAIN["epochs_max"] + 1):
        head.train()
        rng.shuffle(order)
        losses = []
        for start in range(0, len(order), TRAIN["batch_groups"]):
            ids = sorted(int(i) for i in order[start:start + TRAIN["batch_groups"]])
            cand, hq, label = train.batch(ids, device)
            loss, parts = batch_loss(head, variant, cand, hq, label)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            torch.nn.utils.clip_grad_norm_(head.parameters(), TRAIN["grad_clip"])
            for name, param in head.named_parameters():
                if param.grad is not None and param.grad.shape != param.shape:
                    raise RuntimeError(f"{name}: wrong gradient shape")
            optimizer.step()
            losses.append(parts)
        dev_metrics = evaluate(head, dev, device)
        torch.save({"state": head.state_dict(), "variant": variant, "seed": seed, "epoch": epoch},
                   out_dir / "last.pt")
        improved = dev_metrics["nll"] < best["nll"] - 1e-6
        if improved:
            best = {"nll": dev_metrics["nll"], "epoch": epoch,
                    "state": {k: v.detach().clone() for k, v in head.state_dict().items()}}
            torch.save({"state": best["state"], "variant": variant, "seed": seed, "epoch": epoch},
                       out_dir / "best.pt")
            _save_safetensors(best["state"], out_dir / "candidate.safetensors")
            bad = 0
        else:
            bad += 1
        history.append({"epoch": epoch, "trainCe": round(float(np.mean([p["ce"] for p in losses])), 6),
                        "trainJs": round(float(np.mean([p.get("js", 0.0) for p in losses])), 6) if variant == "M2" else None,
                        "devNll": round(dev_metrics["nll"], 6), "devAcc": round(dev_metrics["accuracy"], 6)})
        if bad >= TRAIN["patience"]:
            break
    best_state = torch.load(out_dir / "best.pt", map_location="cpu", weights_only=False)["state"]
    record = {
        "schema": "frostecho.jev02.head-run/1",
        "variant": variant, "seed": seed, "bestEpoch": best["epoch"],
        "devNll": round(best["nll"], 6), "epochsRun": len(history),
        "seconds": round(time.time() - started, 3),
        "paramCount": int(sum(p.numel() for p in head.parameters())),
        "trainable": [name for name, _ in head.named_parameters()],
        "weightSha256": state_hash(best_state),
        "bestPath": str(out_dir / "best.pt"), "lastPath": str(out_dir / "last.pt"),
        "candidatePath": str(out_dir / "candidate.safetensors"),
        "history": history,
        "config": {k: TRAIN[k] for k in ("lr", "weight_decay", "batch_groups", "epochs_max", "patience", "grad_clip")},
        "trainCases": len(train), "devCases": len(dev),
    }
    head.load_state_dict(best_state)
    return {"record": record, "head": head, "best": best_state}


def _save_safetensors(state: dict[str, torch.Tensor], path: Path) -> None:
    try:
        from safetensors.torch import save_file
        save_file({k: v.contiguous() for k, v in state.items()}, str(path))
    except Exception:
        pass


def load_head(path: Path, device: str = "cpu"):
    path = Path(path)
    if path.suffix == ".safetensors":
        from safetensors.torch import load_file
        state = load_file(str(path))
        payload = {"state": state, "format": "safetensors", "path": str(path)}
    else:
        payload = torch.load(path, map_location="cpu", weights_only=False)
        state = payload["state"]
    head = build_head("linear_head", hidden=TRAIN["hidden"])
    head.load_state_dict(state)
    head.to(device).eval()
    return head, payload
