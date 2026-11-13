"""Metrics: accuracy/macro-F1/order consistency, NLL/Brier/ECE, temperature."""
from __future__ import annotations

import math
from collections import defaultdict

import numpy as np
import torch

CLASSES = ("PLAYER_FIRST", "NPC_FIRST", "NO_PRIORITY_REQUEST", "NEEDS_CLARIFICATION")


def accuracy(rows: list[dict], gold: dict[str, str]) -> dict:
    ok = 0
    total = 0
    for row in rows:
        if row["predictedId"] is None:
            total += 1
            continue
        total += 1
        if row["predictedId"] == gold[row["caseId"]]:
            ok += 1
    return {"correct": ok, "n": total, "accuracy": round(ok / total, 6) if total else None}


def macro_f1(rows: list[dict], gold: dict[str, str]) -> dict:
    per = {}
    for cls in CLASSES:
        tp = fp = fn = 0
        for row in rows:
            predicted = row["predictedId"]
            actual = gold[row["caseId"]]
            if predicted == cls and actual == cls:
                tp += 1
            elif predicted == cls and actual != cls:
                fp += 1
            elif predicted != cls and actual == cls:
                fn += 1
        precision = tp / (tp + fp) if tp + fp else 0.0
        recall = tp / (tp + fn) if tp + fn else 0.0
        f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
        per[cls] = {"precision": round(precision, 6), "recall": round(recall, 6), "f1": round(f1, 6), "support": tp + fn}
    return {"macroF1": round(sum(v["f1"] for v in per.values()) / 4, 6), "perClass": per}


def order_consistency(rows: list[dict]) -> dict:
    by_case: dict[str, dict[int, str | None]] = defaultdict(dict)
    for row in rows:
        by_case[row["caseId"]][row["order"]] = row["predictedId"]
    both = [pred for pred in by_case.values() if 0 in pred and 1 in pred]
    same = sum(1 for pred in both if pred[0] is not None and pred[0] == pred[1])
    valid = sum(1 for pred in both if pred[0] is not None and pred[1] is not None)
    return {"cases": len(both), "bothAnswered": valid, "same": same,
            "consistency": round(same / valid, 6) if valid else None}


def nll_brier(probs: np.ndarray, target: np.ndarray) -> dict:
    """probs [N,4] in CLASSES order, target [N] index. Sums over the true class."""
    probs = np.clip(probs.astype(np.float64), 1e-12, 1.0)
    rows = np.arange(len(target))
    p_true = probs[rows, target]
    onehot = np.zeros_like(probs)
    onehot[rows, target] = 1.0
    return {"nll": round(float(-np.log(p_true).mean()), 6),
            "brier": round(float(((probs - onehot) ** 2).sum(axis=1).mean()), 6)}


def ece(probs: np.ndarray, target: np.ndarray, bins: int = 5) -> dict:
    probs = probs.astype(np.float64)
    confidence = probs.max(axis=1)
    prediction = probs.argmax(axis=1)
    correct = (prediction == target).astype(np.float64)
    edges = np.linspace(0.0, 1.0, bins + 1)
    table = []
    total = len(target)
    ece_value = 0.0
    for i in range(bins):
        low, high = edges[i], edges[i + 1]
        mask = (confidence > low) & (confidence <= high) if i > 0 else (confidence >= low) & (confidence <= high)
        count = int(mask.sum())
        if count == 0:
            table.append({"bin": i, "range": [round(low, 2), round(high, 2)], "n": 0, "accuracy": None, "confidence": None})
            continue
        acc = float(correct[mask].mean())
        conf = float(confidence[mask].mean())
        ece_value += (count / total) * abs(acc - conf)
        table.append({"bin": i, "range": [round(low, 2), round(high, 2)], "n": count,
                      "accuracy": round(acc, 6), "confidence": round(conf, 6)})
    return {"ece": round(ece_value, 6), "bins": table}


def fit_temperature(logits: np.ndarray, target: np.ndarray) -> dict:
    """A single positive T on cal only; argmax is unchanged by scaling."""
    logits_t = torch.from_numpy(logits.astype(np.float32))
    target_t = torch.from_numpy(target.astype(np.int64))
    best = {"T": 1.0, "nll": float("inf")}
    for temperature in np.exp(np.linspace(math.log(0.05), math.log(10.0), 400)):
        scaled = logits_t / float(temperature)
        nll = float(torch.nn.functional.cross_entropy(scaled, target_t))
        if nll < best["nll"] - 1e-9:
            best = {"T": float(temperature), "nll": nll}
    return best


def softmax(logits: np.ndarray, temperature: float = 1.0) -> np.ndarray:
    scaled = logits.astype(np.float64) / temperature
    scaled = scaled - scaled.max(axis=1, keepdims=True)
    exp = np.exp(scaled)
    return exp / exp.sum(axis=1, keepdims=True)


def bootstrap_group_delta(rows_a: list[dict], rows_b: list[dict], gold: dict[str, str], groups: dict[str, str],
                          reps: int = 1000, seed: int = 7) -> dict:
    """Paired accuracy difference (A - B), resampling GROUPS (families)."""
    by_group: dict[str, list[str]] = defaultdict(list)
    pred_a = {(row["caseId"], row["order"]): row["predictedId"] for row in rows_a}
    pred_b = {(row["caseId"], row["order"]): row["predictedId"] for row in rows_b}
    keys = sorted(set(pred_a) | set(pred_b))
    for key in keys:
        by_group[groups[key[0]]].append(key)
    group_ids = sorted(by_group)
    if len(group_ids) < 10:
        return {"groups": len(group_ids), "ci": None,
                "note": "too few source groups; per-group results only, no precise interval"}
    rng = np.random.default_rng(seed)
    deltas = []
    for _ in range(reps):
        chosen = rng.choice(group_ids, size=len(group_ids), replace=True)
        correct_a = correct_b = n = 0
        for group in chosen:
            for key in by_group[group]:
                label = gold[key[0]]
                n += 1
                correct_a += int(pred_a.get(key) == label)
                correct_b += int(pred_b.get(key) == label)
        deltas.append((correct_a - correct_b) / n if n else 0.0)
    deltas = np.array(deltas)
    return {"groups": len(group_ids), "reps": reps,
            "deltaMean": round(float(deltas.mean()), 6),
            "ci95": [round(float(np.percentile(deltas, 2.5)), 6), round(float(np.percentile(deltas, 97.5)), 6)]}
