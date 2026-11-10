#!/usr/bin/env python3
"""Probability calibration, abstention policy and risk certification (C).

The conventions are the ones in handoff/03-JEV-EXPERIMENT.md:
  - temperature is fitted on calT only;
  - tau is selected on the fixed grid with empirical risk <= 5% and at least
    100 accepted decisions;
  - the final certificate is a one-sided 95% Clopper-Pearson upper bound on the
    error rate over an independent cert set, and it is refused when evidence is
    incomplete or the policy identity changed.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

TAU_GRID = (0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.925, 0.95, 0.975, 0.99)
SUPPORTED_K = (2, 4, 8)
MIN_ACCEPTED = 100
MAX_RISK = 0.05
ALPHA = 0.05


def softmax(logits: list[float], temperature: float = 1.0) -> list[float]:
    if not logits:
        raise ValueError("softmax over an empty candidate set is undefined")
    if temperature <= 0:
        raise ValueError("temperature must be positive")
    scaled = [value / temperature for value in logits]
    top = max(scaled)
    exps = [math.exp(value - top) for value in scaled]
    total = sum(exps)
    return [value / total for value in exps]


def nll(logits: list[float], label: int, temperature: float) -> float:
    probabilities = softmax(logits, temperature)
    return -math.log(max(probabilities[label], 1e-12))


def fit_temperature(rows: list[list[float]], labels: list[int]) -> float:
    """Golden-section search over log temperature on calT only."""
    if len(rows) != len(labels) or not rows:
        raise ValueError("rows and labels must be non-empty and aligned")
    if any(label < 0 or label >= len(row) for row, label in zip(rows, labels)):
        raise ValueError("label outside candidate range")

    def objective(log_t: float) -> float:
        temperature = math.exp(log_t)
        return sum(nll(row, label, temperature) for row, label in zip(rows, labels)) / len(rows)

    low, high = math.log(0.05), math.log(20.0)
    ratio = (math.sqrt(5) - 1) / 2
    left = high - ratio * (high - low)
    right = low + ratio * (high - low)
    f_left, f_right = objective(left), objective(right)
    for _ in range(200):
        if f_left < f_right:
            high, right, f_right = right, left, f_left
            left = high - ratio * (high - low)
            f_left = objective(left)
        else:
            low, left, f_left = left, right, f_right
            right = low + ratio * (high - low)
            f_right = objective(right)
        if high - low < 1e-9:
            break
    return round(math.exp((low + high) / 2), 6)


def binom_cdf(k: int, n: int, p: float) -> float:
    return sum(math.comb(n, i) * (p ** i) * ((1 - p) ** (n - i)) for i in range(0, k + 1))


def cp_upper(errors: int, n: int, alpha: float = ALPHA) -> float | None:
    """One-sided Clopper-Pearson upper bound for a binomial proportion."""
    if n < 0 or errors < 0 or errors > n:
        raise ValueError("errors must satisfy 0 <= errors <= n")
    if n == 0:
        return None
    if errors == n:
        return 1.0
    low, high = 0.0, 1.0
    for _ in range(200):
        mid = (low + high) / 2
        if binom_cdf(errors, n, mid) > alpha:
            low = mid
        else:
            high = mid
    return high


@dataclass(frozen=True)
class PolicyIdentity:
    model: str
    head: str
    tokenizer: str
    renderer: str
    task: str
    k: int
    memory_policy_version: str
    calibration_id: str | None = None


def assert_policy_compatible(policy: PolicyIdentity, request: PolicyIdentity) -> None:
    for name in ("model", "head", "tokenizer", "renderer", "task", "k", "memory_policy_version"):
        if getattr(policy, name) != getattr(request, name):
            raise ValueError(f"policy mismatch on {name}: {getattr(policy, name)!r} != {getattr(request, name)!r}")
    if policy.k not in SUPPORTED_K:
        raise ValueError(f"K={policy.k} is outside the covered range {SUPPORTED_K}")


@dataclass
class Selection:
    tau: float | None
    coverage: float
    risk: float
    accepted: int
    valid: bool
    reason: str
    per_slice: dict = field(default_factory=dict)


def select_policy(probabilities: list[float], correct: list[bool], *,
                  taus: tuple[float, ...] = TAU_GRID,
                  min_accepted: int = MIN_ACCEPTED,
                  max_risk: float = MAX_RISK) -> Selection:
    """Pick the maximum-coverage tau whose empirical risk meets the budget."""
    if len(probabilities) != len(correct) or not probabilities:
        raise ValueError("probabilities and correctness must be aligned and non-empty")
    best: Selection | None = None
    for tau in taus:
        accepted = [index for index, probability in enumerate(probabilities) if probability >= tau]
        if len(accepted) < min_accepted:
            continue
        errors = sum(1 for index in accepted if not correct[index])
        risk = errors / len(accepted)
        coverage = len(accepted) / len(probabilities)
        selection = Selection(tau=tau, coverage=round(coverage, 4), risk=round(risk, 4),
                              accepted=len(accepted), valid=risk <= max_risk,
                              reason="empirical risk within budget" if risk <= max_risk
                              else "empirical risk above budget")
        if selection.valid and (best is None or selection.accepted > best.accepted):
            best = selection
    if best is None:
        return Selection(tau=None, coverage=0.0, risk=float("nan"), accepted=0, valid=False,
                         reason="no tau met accepted/risk constraints")
    return best


@dataclass
class Certificate:
    valid: bool
    upper: float | None
    errors: int
    n: int
    coverage: float
    reason: str
    alpha: float
    policy: PolicyIdentity


def certify(policy: PolicyIdentity, probabilities: list[float], correct: list[bool],
            tau: float, *, alpha: float = ALPHA, min_coverage: float = 0.30,
            evidence_complete: bool = True) -> Certificate:
    if len(probabilities) != len(correct):
        raise ValueError("probabilities and correctness must be aligned")
    if not evidence_complete:
        return Certificate(False, None, 0, 0, 0.0, "evidence incomplete", alpha, policy)
    accepted = [index for index, probability in enumerate(probabilities) if probability >= tau]
    n = len(accepted)
    errors = sum(1 for index in accepted if not correct[index])
    coverage = n / len(probabilities) if probabilities else 0.0
    upper = cp_upper(errors, n, alpha)
    if upper is None:
        return Certificate(False, None, errors, n, coverage, "no accepted decisions", alpha, policy)
    if coverage < min_coverage:
        return Certificate(False, upper, errors, n, coverage, "coverage below minimum", alpha, policy)
    return Certificate(upper <= MAX_RISK, upper, errors, n, coverage,
                       "certificate meets risk and coverage" if upper <= MAX_RISK
                       else "upper bound above risk budget", alpha, policy)
