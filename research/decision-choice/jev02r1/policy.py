"""One policy artifact, one decision function.

CLI and evaluation both call `load_policy` + `decide`, so there is no second set
of defaults to drift (JEV-02 had T=1/threshold=0 hard-coded in predict.py while
the report used a fitted value). Any identity/parameter conflict is refused
before the backbone is loaded or any job is charged.
"""
from __future__ import annotations

import math
from pathlib import Path

from r1config import (CANDIDATE_VERSION, DECISION_MODES, FAILSAFE_METHODS, GATING, LETTERS,
                      ORDERS, PAIR, POLICY_SCHEMA, PROMPT_VERSION, SINGLE, SUPPORTED_ORDERS,
                      SUPPORTED_PAIRS, read_json, sha256_file, sha256_json, write_json)

REQUIRED_KEYS = (
    "schema", "valid", "decisionMode", "method", "temperature", "tau", "gating",
    "allowedOrders", "allowedPairs", "head", "backbone", "tokenizer", "prompt",
    "candidates", "calibration", "selection", "createdAt",
)
OPTIONAL_KEYS = ("notes", "selectionFacts")


class PolicyError(ValueError):
    pass


def _finite_positive(value, name: str) -> float:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise PolicyError(f"{name} must be a number")
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise PolicyError(f"{name} must be finite and > 0, got {value!r}")
    return number


def softmax(logits, temperature: float) -> list[float]:
    scaled = [float(value) / temperature for value in logits]
    peak = max(scaled)
    exps = [math.exp(value - peak) for value in scaled]
    total = sum(exps)
    return [value / total for value in exps]


def stable_probs(order_index: int, logits, temperature: float) -> dict[str, float]:
    probs = softmax(logits, temperature)
    return {ORDERS[order_index][position]: probs[position] for position in range(4)}


def argmax_stable(order_index: int, logits) -> str:
    best = max(range(len(logits)), key=lambda position: float(logits[position]))
    return ORDERS[order_index][best]


def validate(policy: dict, *, check_files: bool = True) -> None:
    if not isinstance(policy, dict):
        raise PolicyError("policy must be an object")
    missing = [key for key in REQUIRED_KEYS if key not in policy]
    if missing:
        raise PolicyError(f"policy is missing required keys {missing}")
    unknown = [key for key in policy if key not in REQUIRED_KEYS and key not in OPTIONAL_KEYS]
    if unknown:
        raise PolicyError(f"policy has unknown keys {unknown}")
    if policy["schema"] != POLICY_SCHEMA:
        raise PolicyError(f"schema {policy['schema']!r} != {POLICY_SCHEMA!r}")
    if not isinstance(policy["valid"], bool):
        raise PolicyError("valid must be a boolean")
    method = policy["method"]
    if method not in FAILSAFE_METHODS:
        raise PolicyError(f"unknown method {method!r}")
    mode = policy["decisionMode"]
    if mode not in DECISION_MODES:
        raise PolicyError(f"unknown decisionMode {mode!r}")
    if mode != ("selective" if policy["valid"] else "unavailable"):
        raise PolicyError(f"decisionMode {mode!r} conflicts with valid={policy['valid']}")
    if policy["gating"] != GATING[method]:
        raise PolicyError(f"gating {policy['gating']!r} != {GATING[method]!r} for {method}")
    orders = policy["allowedOrders"]
    pairs = [tuple(pair) for pair in policy["allowedPairs"]]
    if not isinstance(orders, list) or not isinstance(policy["allowedPairs"], list):
        raise PolicyError("allowedOrders/allowedPairs must be lists")
    if method == SINGLE:
        if not orders:
            raise PolicyError("single_pass needs at least one allowed order")
        if pairs:
            raise PolicyError("single_pass must not declare allowedPairs")
        if any(int(order) not in SUPPORTED_ORDERS for order in orders):
            raise PolicyError(f"allowedOrders {orders} outside {SUPPORTED_ORDERS}")
        if len(set(int(order) for order in orders)) != len(orders):
            raise PolicyError("duplicate allowed order")
    else:
        if not pairs:
            raise PolicyError("reverse_pair_consensus needs at least one pair")
        if orders:
            raise PolicyError("reverse_pair_consensus must not declare allowedOrders")
        if any(pair not in SUPPORTED_PAIRS for pair in pairs):
            raise PolicyError(f"allowedPairs {pairs} outside {SUPPORTED_PAIRS}")
    _finite_positive(policy["temperature"], "temperature")
    if policy["valid"]:
        tau = _finite_positive(policy["tau"], "tau")
        if not 0 < tau < 1:
            raise PolicyError(f"tau {tau} must be in (0, 1)")
    elif policy["tau"] is not None:
        raise PolicyError("an unavailable policy must not carry a tau")
    head = policy["head"]
    for key in ("path", "fileSha256", "tensorSha256"):
        if not head.get(key):
            raise PolicyError(f"head.{key} is required")
    if policy["prompt"]["version"] != PROMPT_VERSION:
        raise PolicyError(f"prompt version {policy['prompt']['version']!r} != {PROMPT_VERSION!r}")
    if policy["candidates"]["version"] != CANDIDATE_VERSION:
        raise PolicyError(f"candidate version {policy['candidates']['version']!r} != {CANDIDATE_VERSION!r}")
    if policy["calibration"]["calTemperatureSha256"] == policy["calibration"]["calPolicySha256"]:
        raise PolicyError("calibration and policy splits must be different files")
    if check_files:
        check_identity(policy)


def check_identity(policy: dict) -> None:
    """Refuse a stale/foreign policy before any weights are loaded."""
    from heads.train import state_hash
    from safetensors.torch import load_file
    from r1config import identity, prompt_identity

    path = Path(policy["head"]["path"])
    if not path.exists():
        raise PolicyError(f"head file missing: {path}")
    if sha256_file(path) != policy["head"]["fileSha256"]:
        raise PolicyError("head file bytes differ from the policy")
    if state_hash(load_file(str(path))) != policy["head"]["tensorSha256"]:
        raise PolicyError("head tensors differ from the policy")
    live = identity()
    if live["backbone"]["sha256"] != policy["backbone"]["sha256"]:
        raise PolicyError("backbone identity differs from the policy")
    if live["tokenizer"]["sha256"] != policy["tokenizer"]["sha256"]:
        raise PolicyError("tokenizer identity differs from the policy")
    if prompt_identity()["sha256"] != policy["prompt"]["sha256"]:
        raise PolicyError("prompt/candidate rendering differs from the policy")
    for key in ("calTemperatureSha256", "calPolicySha256"):
        recorded = policy["calibration"][key]
        name = "cal-temperature" if key == "calTemperatureSha256" else "cal-policy"
        from r1config import split_file
        if sha256_file(split_file(name)) != recorded:
            raise PolicyError(f"{name} changed after the policy was fitted ({key})")


def load_policy(path: Path, *, check_files: bool = True) -> dict:
    policy = read_json(Path(path))
    validate(policy, check_files=check_files)
    return policy


def decide(policy: dict, logits_by_order: dict[int, list[float]]) -> dict:
    """Decision for one base case. `logits_by_order` holds raw head logits in
    display order for each available presentation."""
    if not policy["valid"] or policy["decisionMode"] != "selective":
        return {"decision": "unavailable", "candidateId": None, "reason": "policy_invalid",
                "score": None, "gating": None, "probabilities": None, "orders": []}
    temperature = float(policy["temperature"])
    tau = float(policy["tau"])
    method = policy["method"]
    if method == SINGLE:
        results = []
        for order in policy["allowedOrders"]:
            order = int(order)
            if order not in logits_by_order:
                raise PolicyError(f"missing logits for order {order}")
            probs = stable_probs(order, logits_by_order[order], temperature)
            candidate = max(probs, key=probs.get)
            results.append({"order": order, "candidateId": candidate,
                            "score": float(probs[candidate]), "probabilities": probs})
        accepted = [row for row in results if row["score"] >= tau]
        if not accepted:
            best = max(results, key=lambda row: row["score"])
            return {"decision": "abstain", "candidateId": None, "reason": "below_threshold",
                    "score": best["score"], "gating": "max_confidence",
                    "probabilities": best["probabilities"], "orders": [row["order"] for row in results]}
        winner = max(accepted, key=lambda row: row["score"])
        return {"decision": "accept", "candidateId": winner["candidateId"], "reason": "confident",
                "score": winner["score"], "gating": "max_confidence",
                "probabilities": winner["probabilities"], "orders": [row["order"] for row in results],
                "perOrder": results}

    results = []
    for pair in policy["allowedPairs"]:
        forward, reverse = int(pair[0]), int(pair[1])
        for order in (forward, reverse):
            if order not in logits_by_order:
                raise PolicyError(f"missing logits for pair order {order}")
        first = stable_probs(forward, logits_by_order[forward], temperature)
        second = stable_probs(reverse, logits_by_order[reverse], temperature)
        candidate_first = max(first, key=first.get)
        candidate_second = max(second, key=second.get)
        agree = candidate_first == candidate_second
        score = min(first[candidate_first], second[candidate_second])
        results.append({"pair": [forward, reverse], "agree": agree,
                        "candidateId": candidate_first if agree else None,
                        "score": float(score) if agree else 0.0,
                        "probabilityFirst": first[candidate_first],
                        "probabilitySecond": second[candidate_second]})
    disagree = [row for row in results if not row["agree"]]
    if disagree:
        return {"decision": "abstain", "candidateId": None, "reason": "order_disagreement",
                "score": 0.0, "gating": "min_confidence", "probabilities": None,
                "pairs": results}
    accepted = [row for row in results if row["score"] >= tau]
    if not accepted:
        best = max(results, key=lambda row: row["score"])
        return {"decision": "abstain", "candidateId": None, "reason": "below_threshold",
                "score": best["score"], "gating": "min_confidence", "probabilities": None,
                "pairs": results}
    winner = max(accepted, key=lambda row: row["score"])
    return {"decision": "accept", "candidateId": winner["candidateId"], "reason": "confident",
            "score": winner["score"], "gating": "min_confidence", "probabilities": None,
            "pairs": results}


def build_policy(*, valid: bool, method: str, temperature: float, tau, calibration: dict,
                 selection: dict, notes: str = "", selection_facts: dict | None = None,
                 head_path: Path | None = None) -> dict:
    from r1config import find_head, head_identity
    path = Path(head_path) if head_path else find_head()
    head = head_identity(path)
    live = identity_all()
    return {
        "schema": POLICY_SCHEMA,
        "valid": bool(valid),
        "decisionMode": "selective" if valid else "unavailable",
        "method": method,
        "temperature": float(temperature),
        "tau": None if tau is None else float(tau),
        "gating": GATING[method],
        "allowedOrders": list(SUPPORTED_ORDERS) if method == SINGLE else [],
        "allowedPairs": [list(pair) for pair in SUPPORTED_PAIRS] if method == PAIR else [],
        "head": head,
        "backbone": live["backbone"],
        "tokenizer": live["tokenizer"],
        "prompt": live["prompt"],
        "candidates": {"version": CANDIDATE_VERSION, "labels": dict(sorted(
            __import__("r1config").LETTER_LABEL.items()))},
        "calibration": calibration,
        "selection": selection,
        "createdAt": __import__("r1config").now_iso(),
        "notes": notes,
        **({"selectionFacts": selection_facts} if selection_facts else {}),
    }


def identity_all() -> dict:
    from r1config import identity, prompt_identity
    return {**identity(), "prompt": prompt_identity()}


def save_policy(path: Path, policy: dict) -> str:
    validate(policy, check_files=False)
    write_json(Path(path), policy)
    return sha256_json(policy)


def outcome_by_order(policy: dict, logits_by_order: dict[int, list[float]]) -> dict[int, dict]:
    """Per-supported-order view used by calibration/selection and by evaluation.
    S1: one row per order. S2: one row per pair (keyed by the forward order)."""
    temperature = float(policy["temperature"])
    out: dict[int, dict] = {}
    if policy["method"] == SINGLE:
        for order in policy["allowedOrders"]:
            order = int(order)
            probs = stable_probs(order, logits_by_order[order], temperature)
            candidate = max(probs, key=probs.get)
            out[order] = {"candidateId": candidate, "score": float(probs[candidate])}
        return out
    for pair in policy["allowedPairs"]:
        forward, reverse = int(pair[0]), int(pair[1])
        first = stable_probs(forward, logits_by_order[forward], temperature)
        second = stable_probs(reverse, logits_by_order[reverse], temperature)
        candidate_first = max(first, key=first.get)
        candidate_second = max(second, key=second.get)
        agree = candidate_first == candidate_second
        out[forward] = {"candidateId": candidate_first if agree else None,
                        "score": float(min(first[candidate_first], second[candidate_second])) if agree else 0.0,
                        "agree": agree}
    return out
