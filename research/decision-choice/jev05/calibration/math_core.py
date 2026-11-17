"""Set-label temperature fitting and the frozen JEV selective-risk protocol."""
from __future__ import annotations

import math

TAU_GRID = (0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.925, 0.95, 0.975, 0.99)
MIN_SELECT_ACCEPTED = 100
MAX_RISK = 0.05
MIN_CERT_COVERAGE = 0.30
ALPHA = 0.05


def logsumexp(values):
    peak = max(values)
    return peak + math.log(sum(math.exp(value - peak) for value in values))


def softmax(logits, temperature=1.0):
    if not logits or not isinstance(temperature, (int, float)) or isinstance(temperature, bool) or not math.isfinite(temperature) or temperature <= 0:
        raise ValueError("nonempty logits and positive finite temperature required")
    if any(isinstance(x, bool) or not isinstance(x, (int, float)) or not math.isfinite(x) for x in logits):
        raise ValueError("logits must be finite real numbers")
    scaled = [value / temperature for value in logits]
    peak = max(scaled)
    exps = [math.exp(value - peak) for value in scaled]
    total = sum(exps)
    return [value / total for value in exps]


def acceptable_indices(row):
    ids, acceptable = row.get("candidateIds"), row.get("acceptableIds")
    logits = row.get("rawLogits")
    if not isinstance(ids, list) or len(ids) < 2 or len(set(ids)) != len(ids) or not all(isinstance(item, str) and item for item in ids):
        raise ValueError("candidate IDs must be distinct nonempty strings")
    if not isinstance(acceptable, list) or not acceptable or len(set(acceptable)) != len(acceptable) or not set(acceptable) <= set(ids):
        raise ValueError("acceptable set must be nonempty and inside candidates")
    if not isinstance(logits, list) or len(logits) != len(ids):
        raise ValueError("logits/candidate length mismatch")
    softmax(logits)
    return [ids.index(item) for item in acceptable]


def set_nll(logits, indices, temperature):
    scaled = [value / temperature for value in logits]
    return logsumexp(scaled) - logsumexp([scaled[index] for index in indices])


def fit_temperature(records):
    if not records:
        raise ValueError("calT must contain records")
    parsed = [(row["rawLogits"], acceptable_indices(row)) for row in records]

    def objective(log_t):
        temperature = math.exp(log_t)
        return sum(set_nll(logits, indices, temperature) for logits, indices in parsed) / len(parsed)

    low, high = math.log(0.05), math.log(20.0)
    ratio = (math.sqrt(5) - 1) / 2
    left, right = high - ratio * (high - low), low + ratio * (high - low)
    f_left, f_right = objective(left), objective(right)
    if max(objective(low), objective(high), objective(0)) - min(objective(low), objective(high), objective(0)) < 1e-12:
        return 1.0
    for _ in range(200):
        if f_left < f_right:
            high, right, f_right = right, left, f_left
            left = high - ratio * (high - low)
            f_left = objective(left)
        else:
            low, left, f_left = left, right, f_right
            right = low + ratio * (high - low)
            f_right = objective(right)
        if high - low < 1e-10:
            break
    return round(math.exp((low + high) / 2), 9)


def evaluated(records, temperature):
    output = []
    for row in records:
        indices = acceptable_indices(row)
        probabilities = softmax(row["rawLogits"], temperature)
        best = max(range(len(probabilities)), key=lambda index: probabilities[index])
        output.append({"caseId": row["caseId"], "candidateId": row["candidateIds"][best],
                       "pmax": probabilities[best], "correct": best in indices,
                       "setNll": set_nll(row["rawLogits"], indices, temperature)})
    return output


def metrics(records, temperature):
    values = evaluated(records, temperature)
    n = len(values)
    if not n:
        raise ValueError("metrics need observations")
    bins = []
    for index in range(10):
        rows = [row for row in values if min(int(row["pmax"] * 10), 9) == index]
        bins.append({"lower": index / 10, "upper": (index + 1) / 10, "n": len(rows),
                     "confidence": sum(row["pmax"] for row in rows) / len(rows) if rows else None,
                     "accuracy": sum(row["correct"] for row in rows) / len(rows) if rows else None})
    return {"n": n, "setNll": sum(row["setNll"] for row in values) / n,
            "top1InAcceptable": sum(row["correct"] for row in values) / n,
            "binaryBrier": sum((row["pmax"] - int(row["correct"])) ** 2 for row in values) / n,
            "topChoiceEce10": sum(row["n"] / n * abs(row["confidence"] - row["accuracy"]) for row in bins if row["n"]),
            "reliabilityBins": bins,
            "event": "argmax candidate belongs to acceptableIds", "confidence": "max softmax probability",
            "temperatureObjective": "negative log total probability of acceptableIds"}


def select_tau(records, temperature):
    values = evaluated(records, temperature)
    grid, best = [], None
    for tau in TAU_GRID:
        accepted = [row for row in values if row["pmax"] >= tau]
        errors = sum(not row["correct"] for row in accepted)
        risk = errors / len(accepted) if accepted else None
        entry = {"tau": tau, "accepted": len(accepted), "errors": errors,
                 "coverage": len(accepted) / len(values) if values else 0,
                 "risk": risk, "valid": len(accepted) >= MIN_SELECT_ACCEPTED and risk <= MAX_RISK}
        grid.append(entry)
        if entry["valid"] and (best is None or entry["accepted"] > best["accepted"]):
            best = entry
    return {"valid": best is not None, "tau": best["tau"] if best else None,
            "accepted": best["accepted"] if best else 0, "grid": grid,
            "reason": "maximum coverage on frozen tau grid" if best else "no tau satisfies accepted>=100 and empirical risk<=0.05"}


def binomial_cdf(k, n, probability):
    if probability <= 0:
        return 1.0
    if probability >= 1:
        return 1.0 if k >= n else 0.0
    logs = [math.lgamma(n + 1) - math.lgamma(index + 1) - math.lgamma(n - index + 1)
            + index * math.log(probability) + (n - index) * math.log1p(-probability)
            for index in range(k + 1)]
    return min(1.0, math.exp(logsumexp(logs)))


def cp_upper(errors, n, alpha=ALPHA):
    if isinstance(n, bool) or isinstance(errors, bool) or not isinstance(n, int) or not isinstance(errors, int) or not 0 <= errors <= n or n < 0:
        raise ValueError("integer 0<=errors<=n required")
    if not 0 < alpha < 1:
        raise ValueError("alpha must be inside (0,1)")
    if n == 0:
        return None
    if errors == n:
        return 1.0
    if errors == 0:
        return -math.expm1(math.log(alpha) / n)
    low, high = 0.0, 1.0
    for _ in range(100):
        mid = (low + high) / 2
        if binomial_cdf(errors, n, mid) > alpha:
            low = mid
        else:
            high = mid
    return high


def certify(records, temperature, tau):
    if tau not in TAU_GRID:
        return {"valid": False, "n": 0, "errors": 0, "coverage": 0.0, "upper": None, "reason": "no frozen select tau"}
    values = evaluated(records, temperature)
    accepted = [row for row in values if row["pmax"] >= tau]
    n, errors = len(accepted), sum(not row["correct"] for row in accepted)
    coverage = n / len(values) if values else 0.0
    upper = cp_upper(errors, n)
    valid = upper is not None and upper <= MAX_RISK and coverage >= MIN_CERT_COVERAGE
    return {"valid": valid, "n": n, "errors": errors, "total": len(values),
            "coverage": coverage, "upper": upper, "alpha": ALPHA, "tau": tau,
            "reason": "independent certificate meets frozen protocol" if valid else "certificate risk/coverage insufficient",
            "scope": "one-sided binomial bound on the frozen cert decision distribution; not a universal long-horizon safety guarantee"}
