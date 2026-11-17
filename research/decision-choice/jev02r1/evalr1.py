"""Selective-classification metrics with explicit denominators.

Every number carries numerator/denominator. Four presentations of one base case
are never treated as four independent examples: coverage is a mean over the
supported orders/pairs, and uncertainty comes from a group bootstrap over
source families.
"""
from __future__ import annotations

import math

from r1config import CLASSES, ORDERS, PAIR, SINGLE
from policy import stable_probs


def _rate(numerator: int, denominator: int):
    return None if denominator == 0 else numerator / denominator


def nll_brier(rows: list[dict]) -> dict:
    """rows: {"probs": {class: p}, "label": class}. Equal weight per row."""
    if not rows:
        return {"n": 0, "nll": None, "brier": None}
    nll = 0.0
    brier = 0.0
    for row in rows:
        prob = min(max(row["probs"].get(row["label"], 0.0), 1e-12), 1.0)
        nll -= math.log(prob)
        brier += sum((row["probs"].get(cls, 0.0) - (1.0 if cls == row["label"] else 0.0)) ** 2
                     for cls in CLASSES)
    return {"n": len(rows), "nll": nll / len(rows), "brier": brier / len(rows)}


def ece(rows: list[dict], bins: int = 10) -> dict:
    if not rows:
        return {"n": 0, "ece": None}
    buckets = [[] for _ in range(bins)]
    for row in rows:
        confidence = max(row["probs"].values())
        predicted = max(row["probs"], key=row["probs"].get)
        index = min(bins - 1, int(confidence * bins))
        buckets[index].append((confidence, predicted == row["label"]))
    total = len(rows)
    value = 0.0
    for bucket in buckets:
        if not bucket:
            continue
        confidence = sum(item[0] for item in bucket) / len(bucket)
        accuracy = sum(1.0 for item in bucket if item[1]) / len(bucket)
        value += len(bucket) / total * abs(confidence - accuracy)
    return {"n": total, "ece": value}


def rows_for_order(policy: dict, logits_by_order: dict[int, list[float]]) -> dict:
    """Per-supported-order probabilities and argmax for one base case."""
    temperature = float(policy["temperature"])
    out = {}
    if policy["method"] == SINGLE:
        for order in policy["allowedOrders"]:
            order = int(order)
            probs = stable_probs(order, logits_by_order[order], temperature)
            out[order] = {"probs": probs, "candidateId": max(probs, key=probs.get)}
        return out
    for pair in policy["allowedPairs"]:
        forward, reverse = int(pair[0]), int(pair[1])
        first = stable_probs(forward, logits_by_order[forward], temperature)
        second = stable_probs(reverse, logits_by_order[reverse], temperature)
        candidate_first = max(first, key=first.get)
        candidate_second = max(second, key=second.get)
        agree = candidate_first == candidate_second
        # Mean of the two calibrated distributions as the reported probability;
        # the gate uses min(max) and is reported separately as `score`.
        mean = {cls: (first[cls] + second[cls]) / 2 for cls in CLASSES}
        out[forward] = {"probs": mean, "candidateId": candidate_first if agree else None,
                        "agree": agree, "pair": [forward, reverse],
                        "probabilities": {"forward": first, "reverse": second},
                        "score": min(first[candidate_first], second[candidate_second]) if agree else 0.0}
    return out


def selective_table(items: list[dict], tau: float, method: str) -> dict:
    """items: [{"order": k, "candidateId": str|None, "probs": {...}, "label": str,
                "family": str, "agree": bool}] one per base per supported order/pair."""
    keys = sorted({item["order"] for item in items})
    per_key = {}
    for key in keys:
        subset = [item for item in items if item["order"] == key]
        accepted = [item for item in subset if _accepted(item, tau)]
        errors = sum(1 for item in accepted if item["candidateId"] != item["label"])
        per_key[str(key)] = {
            "bases": len(subset),
            "accepted": len(accepted),
            "errors": errors,
            "coverage": round(_rate(len(accepted), len(subset)), 6) if subset else None,
            "risk": round(_rate(errors, len(accepted)), 6) if accepted else None,
            "riskDenominator": len(accepted),
            "disagreements": sum(1 for item in subset if item.get("agree") is False),
        }
    coverages = [value["coverage"] for value in per_key.values() if value["coverage"] is not None]
    accepted_total = sum(value["accepted"] for value in per_key.values())
    error_total = sum(value["errors"] for value in per_key.values())
    return {
        "tau": tau,
        "method": method,
        "supported": [str(key) for key in keys],
        "perSupported": per_key,
        "meanCoverage": round(sum(coverages) / len(coverages), 6) if coverages else None,
        "pooled": {"accepted": accepted_total, "errors": error_total,
                   "risk": round(_rate(error_total, accepted_total), 6) if accepted_total else None,
                   "n": sum(value["bases"] for value in per_key.values())},
    }


def _accepted(item: dict, tau: float) -> bool:
    if item.get("candidateId") is None:
        return False
    if item.get("agree") is False:
        return False
    return float(item.get("score", 0.0)) >= tau


def gate(table: dict, max_risk: float, min_accepted: int, min_per_class: int,
         bases_per_key: dict[str, dict[str, int]]) -> dict:
    """Contract 25: every supported order/pair must pass, not merely one of them."""
    failures = []
    for key, value in table["perSupported"].items():
        if value["accepted"] == 0 or value["risk"] is None:
            failures.append(f"{key}: zero acceptance (risk is null, not 0)")
            continue
        if value["risk"] > max_risk:
            failures.append(f"{key}: risk {value['risk']:.4f} > {max_risk}")
        if value["accepted"] < min_accepted:
            failures.append(f"{key}: accepted {value['accepted']} < {min_accepted} bases")
        counts = bases_per_key.get(key, {})
        for cls in CLASSES:
            if counts.get(cls, 0) < min_per_class:
                failures.append(f"{key}: accepted {counts.get(cls, 0)} {cls} bases < {min_per_class}")
    return {"passes": not failures, "failures": failures}


def accepted_per_class(items: list[dict], tau: float) -> dict[str, dict[str, int]]:
    out: dict[str, dict[str, int]] = {}
    for item in items:
        key = str(item["order"])
        bucket = out.setdefault(key, {cls: 0 for cls in CLASSES})
        if _accepted(item, tau):
            bucket[item["label"]] = bucket.get(item["label"], 0) + 1
    return out


def group_bootstrap(items: list[dict], tau: float, iterations: int = 2000, seed: int = 20261110) -> dict:
    """Resample families (never presentations) and report percentile intervals."""
    import numpy as np
    rng = np.random.default_rng(seed)
    families = sorted({item["family"] for item in items})
    by_family = {family: [item for item in items if item["family"] == family] for family in families}
    keys = sorted({item["order"] for item in items})
    risks, coverages = [], []
    for _ in range(iterations):
        picked = rng.choice(len(families), size=len(families), replace=True)
        sample = [item for index in picked for item in by_family[families[index]]]
        accepted = [item for item in sample if _accepted(item, tau)]
        if accepted:
            risks.append(sum(1 for item in accepted if item["candidateId"] != item["label"]) / len(accepted))
        coverage = []
        for key in keys:
            subset = [item for item in sample if item["order"] == key]
            if subset:
                coverage.append(sum(1 for item in subset if _accepted(item, tau)) / len(subset))
        if coverage:
            coverages.append(sum(coverage) / len(coverage))

    def interval(values):
        if not values:
            return {"lo": None, "hi": None, "median": None, "n": 0}
        array = np.array(values)
        return {"lo": round(float(np.percentile(array, 2.5)), 6),
                "hi": round(float(np.percentile(array, 97.5)), 6),
                "median": round(float(np.median(array)), 6), "n": len(values)}

    return {"iterations": iterations, "seed": seed, "families": len(families),
            "risk": interval(risks), "coverage": interval(coverages)}


def per_class_family(items: list[dict], tau: float, gold: dict[str, dict]) -> dict:
    accepted = [item for item in items if _accepted(item, tau)]
    per_class = {}
    for cls in CLASSES:
        bucket = [item for item in accepted if item["label"] == cls]
        universe = [item for item in items if item["label"] == cls]
        wrong = sum(1 for item in bucket if item["candidateId"] != cls)
        per_class[cls] = {"accepted": len(bucket), "bases": len(universe),
                          "errors": wrong,
                          "coverage": round(_rate(len(bucket), len(universe)), 6) if universe else None,
                          "risk": round(_rate(wrong, len(bucket)), 6) if bucket else None}
    per_family = {}
    for family in sorted({item["family"] for item in items}):
        bucket = [item for item in accepted if item["family"] == family]
        universe = [item for item in items if item["family"] == family]
        wrong = sum(1 for item in bucket if item["candidateId"] != item["label"])
        per_family[family] = {"accepted": len(bucket), "bases": len(universe), "errors": wrong,
                              "coverage": round(_rate(len(bucket), len(universe)), 6) if universe else None,
                              "risk": round(_rate(wrong, len(bucket)), 6) if bucket else None}
    return {"perClass": per_class, "perFamily": per_family}


def accuracy_table(items: list[dict], gold: dict[str, dict]) -> dict:
    per_order = {}
    for key in sorted({item["order"] for item in items}):
        subset = [item for item in items if item["order"] == key]
        correct = sum(1 for item in subset if item["candidateId"] == item["label"])
        per_order[str(key)] = {"correct": correct, "n": len(subset),
                               "accuracy": round(correct / len(subset), 6) if subset else None}
    correct = sum(1 for item in items if item["candidateId"] == item["label"])
    per_class = {}
    for cls in CLASSES:
        subset = [item for item in items if item["label"] == cls]
        hit = sum(1 for item in subset if item["candidateId"] == cls)
        per_class[cls] = {"correct": hit, "n": len(subset),
                          "recall": round(hit / len(subset), 6) if subset else None}
    per_family = {}
    for family in sorted({item["family"] for item in items}):
        subset = [item for item in items if item["family"] == family]
        hit = sum(1 for item in subset if item["candidateId"] == item["label"])
        per_family[family] = {"correct": hit, "n": len(subset),
                              "accuracy": round(hit / len(subset), 6) if subset else None}
    return {"perSupported": per_order, "combined": {"correct": correct, "n": len(items),
                                                   "accuracy": round(correct / len(items), 6) if items else None},
            "perClass": per_class, "perFamily": per_family}


def agreement_stats(items_a: list[dict], items_b: list[dict]) -> dict:
    """Two label sets keyed by caseId; disagreements are returned verbatim."""
    by_a = {item["caseId"]: item for item in items_a}
    by_b = {item["caseId"]: item for item in items_b}
    shared = sorted(set(by_a) & set(by_b))
    disagreements = []
    for case_id in shared:
        if by_a[case_id]["labelId"] != by_b[case_id]["labelId"]:
            disagreements.append({"caseId": case_id,
                                  "author": by_a[case_id]["labelId"],
                                  "reviewer": by_b[case_id]["labelId"],
                                  "context": by_a[case_id].get("context"),
                                  "playerText": by_a[case_id].get("playerText")})
    confusion: dict[str, int] = {}
    for row in disagreements:
        key = f"{row['author']}->{row['reviewer']}"
        confusion[key] = confusion.get(key, 0) + 1
    return {"n": len(shared), "agree": len(shared) - len(disagreements),
            "disagree": len(disagreements),
            "rate": round((len(shared) - len(disagreements)) / len(shared), 6) if shared else None,
            "confusion": confusion, "disagreements": disagreements}
