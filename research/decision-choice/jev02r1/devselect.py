"""Fix for the JEV-02 dev-selection gap (contract 34).

JEV-02 selected the best epoch on order 0 only (dev NLL .0400 at order 0 vs .1332
averaged over orders). No checkpoint is reselected this round; this module is the
rule that future training must call, and tests/test_r1.py pins its behaviour.
"""
from __future__ import annotations


def balanced_loss(records: list[dict]) -> float:
    """Mean over presentations of the mean over groups.

    records: [{"group": str, "order": int, "loss": float}]. Every group and every
    presentation gets the same weight, so a group with more presentations (or an
    order with an easier sample) cannot dominate.
    """
    if not records:
        raise ValueError("no dev records")
    orders = sorted({int(row["order"]) for row in records})
    groups = sorted({row["group"] for row in records})
    seen = {(row["group"], int(row["order"])) for row in records}
    missing = [(group, order) for group in groups for order in orders if (group, order) not in seen]
    if missing:
        raise ValueError(f"unbalanced dev grid, missing {missing[:5]}")
    per_order = []
    for order in orders:
        values = [float(row["loss"]) for row in records if int(row["order"]) == order]
        per_order.append(sum(values) / len(values))
    return sum(per_order) / len(per_order)


def select_epoch(epochs: list[dict]) -> dict:
    """epochs: [{"epoch": int, "records": [...]}]; earliest wins a tie."""
    scored = [{"epoch": int(item["epoch"]), "balancedLoss": balanced_loss(item["records"])}
              for item in epochs]
    best = min(scored, key=lambda item: (item["balancedLoss"], item["epoch"]))
    return {"selected": best, "all": scored}


def order0_loss(epochs: list[dict]) -> dict:
    """The JEV-02 rule, kept only to demonstrate the difference."""
    scored = []
    for item in epochs:
        values = [float(row["loss"]) for row in item["records"] if int(row["order"]) == 0]
        scored.append({"epoch": int(item["epoch"]), "order0Loss": sum(values) / len(values)})
    best = min(scored, key=lambda item: (item["order0Loss"], item["epoch"]))
    return {"selected": best, "all": scored}
