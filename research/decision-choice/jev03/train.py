#!/usr/bin/env python3
"""Six CPU trainings: two read-out structures x three seeds, nothing else.

Objective and schedule are fixed by the contract: cross-entropy averaged over the
four presentations of a case, AdamW lr=1e-3 weight_decay=1e-2, 32 groups per
batch, at most 100 epochs, deterministic seeding. No hyper-parameter search and
no early stopping on test: the epoch kept for a seed is the one with the lowest
dev four-order mean NLL.
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np
import torch
from torch import nn

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
sys.path.insert(0, str(HERE / "heads"))

import j3config as R  # noqa: E402
import j3heads as H  # noqa: E402

ORDERS = [list(order) for order in R.ORDERS]


def load_split(split: str) -> dict:
    features = np.load(R.features_file(split))
    meta = R.read_json(R.features_file(split).with_suffix(".meta.json"))
    labels = {row["caseId"]: row["labelId"] for row in R.read_jsonl(R.split_file(split))}
    if meta["featureIdentityHash"] != R.feature_identity_hash():
        raise SystemExit("feature cache was built with a different identity")
    case_ids = np.asarray(meta["caseIds"])
    order_ids = np.asarray(meta["orderIds"], dtype=np.int64)
    cand = torch.from_numpy(features["cand"])
    hq = torch.from_numpy(features["hq"])
    target_display = torch.tensor([ORDERS[int(order)].index(labels[case_id])
                                   for case_id, order in zip(case_ids, order_ids)])
    target_stable = torch.tensor([R.CLASSES.index(labels[case_id]) for case_id in case_ids])
    return {"cand": cand, "hq": hq, "caseIds": case_ids, "orders": order_ids,
            "targetDisplay": target_display, "targetStable": target_stable,
            "labels": labels}


def arm_logits(head, batch: dict, arm: str) -> torch.Tensor:
    return head(batch["cand"]) if arm == "C" else head(batch["hq"])


def case_mean_ce(head, batch: dict, arm: str, index: torch.Tensor) -> torch.Tensor:
    """Mean CE over the four presentations of the selected cases."""
    logits = arm_logits(head, {"cand": batch["cand"][index], "hq": batch["hq"][index]}, arm)
    target = batch["targetDisplay"][index] if arm == "C" else batch["targetStable"][index]
    per_row = nn.functional.cross_entropy(logits, target, reduction="none")
    _, inverse = np.unique(np.asarray(batch["caseIds"])[index.numpy()], return_inverse=True)
    inverse = torch.as_tensor(inverse, dtype=torch.long)
    sums = torch.zeros(int(inverse.max()) + 1).index_add_(0, inverse, per_row)
    counts = torch.zeros_like(sums).index_add_(0, inverse, torch.ones_like(per_row))
    return (sums / counts).mean()


def evaluate(head, batch: dict, arm: str) -> dict:
    with torch.no_grad():
        logits = arm_logits(head, batch, arm)
        target = batch["targetDisplay"] if arm == "C" else batch["targetStable"]
        ce = nn.functional.cross_entropy(logits, target, reduction="none")
        preds = logits.argmax(dim=-1)
        correct = (preds == target)
        per_order = {}
        for order in (0, 1, 2, 3):
            mask = batch["orders"] == order
            per_order[str(order)] = {"n": int(mask.sum()),
                                     "correct": int(correct[mask].sum())}
        prob = torch.softmax(logits, dim=-1)
        onehot = nn.functional.one_hot(target, num_classes=len(R.CLASSES)).float()
        return {"nll": float(ce.mean()), "accuracy": float(correct.float().mean()),
                "brier": float(((prob - onehot) ** 2).sum(dim=-1).mean()),
                "perOrder": per_order}
        # NLL/Brier here are uncalibrated, per contract; no temperature is fitted.


def train_one(arm: str, seed: int, train: dict, dev: dict, epochs: int) -> dict:
    torch.manual_seed(seed)
    np.random.seed(seed)
    head = H.build(arm)
    expected = R.C_PARAMS if arm == "C" else R.Q_PARAMS
    if H.count_parameters(head) != expected:
        raise SystemExit(f"{arm} has {H.count_parameters(head)} params, expected {expected}")
    optimiser = torch.optim.AdamW(head.parameters(), lr=R.TRAIN["lr"],
                                  weight_decay=R.TRAIN["weight_decay"])
    cases = np.array(sorted(set(train["caseIds"].tolist())))
    rows_by_case = {name: np.where(train["caseIds"] == name)[0] for name in cases}
    generator = np.random.default_rng(seed)
    curve = []
    best = {"nll": math.inf, "epoch": -1, "state": None}
    for epoch in range(1, epochs + 1):
        head.train()
        order = generator.permutation(len(cases))
        losses = []
        for start in range(0, len(cases), R.TRAIN["batch_groups"]):
            chunk = [cases[index] for index in order[start:start + R.TRAIN["batch_groups"]]]
            index = torch.tensor([row for name in chunk for row in rows_by_case[name]],
                                 dtype=torch.long)
            optimiser.zero_grad()
            loss = case_mean_ce(head, train, arm, index)
            loss.backward()
            nn.utils.clip_grad_norm_(head.parameters(), 1.0)
            optimiser.step()
            losses.append(float(loss))
        head.eval()
        dev_metrics = evaluate(head, dev, arm)
        train_metrics = evaluate(head, train, arm)
        entry = {"epoch": epoch, "trainNll": round(float(np.mean(losses)), 6),
                 "trainAcc": round(train_metrics["accuracy"], 6),
                 "devNll": round(dev_metrics["nll"], 6),
                 "devAcc": round(dev_metrics["accuracy"], 6),
                 "devBrier": round(dev_metrics["brier"], 6),
                 "devPerOrder": {key: round(value["correct"] / value["n"], 6)
                                 for key, value in dev_metrics["perOrder"].items()}}
        curve.append(entry)
        if dev_metrics["nll"] < best["nll"] - 1e-12:
            best = {"nll": dev_metrics["nll"], "epoch": epoch,
                    "state": {key: value.detach().clone() for key, value in head.state_dict().items()},
                    "devAcc": dev_metrics["accuracy"], "devBrier": dev_metrics["brier"]}
    head.load_state_dict(best["state"])
    run_dir = R.RUNS / f"{arm}-seed{seed}"
    meta = {"schema": "frostecho.jev03.head/1", "arm": arm, "seed": seed,
            "bestEpoch": best["epoch"], "devNll": best["nll"], "devAcc": best["devAcc"],
            "epochs": epochs, "objective": R.TRAIN["objective"], "config": R.TRAIN,
            "params": H.count_parameters(head), "featureIdentityHash": R.feature_identity_hash(),
            "at": R.now_iso()}
    record = H.save_head(head, run_dir / "best.safetensors", meta)
    R.write_json(run_dir / "curve.json", {"schema": "frostecho.jev03.curve/1", "arm": arm,
                                          "seed": seed, "curve": curve, "bestEpoch": best["epoch"]})
    return {**record, "arm": arm, "seed": seed, "bestEpoch": best["epoch"],
            "devNll": best["nll"], "epochsRun": len(curve)}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--arms", nargs="+", default=["C", "Q"])
    parser.add_argument("--seeds", nargs="+", type=int, default=list(R.SEEDS))
    parser.add_argument("--epochs", type=int, default=R.TRAIN["epochs_max"])
    args = parser.parse_args(argv)
    R.RUNS.mkdir(parents=True, exist_ok=True)
    train_split, dev_split = load_split("train"), load_split("dev")
    runs = []
    for arm in args.arms:
        for seed in args.seeds:
            result = train_one(arm, seed, train_split, dev_split, args.epochs)
            runs.append(result)
            print(json.dumps({"arm": arm, "seed": seed, "bestEpoch": result["bestEpoch"],
                              "devNll": round(result["devNll"], 6),
                              "params": result["params"]}), flush=True)
    R.write_json(R.RUNS / "trainings.json", {"schema": "frostecho.jev03.trainings/1",
                                             "at": R.now_iso(), "runs": runs})
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
