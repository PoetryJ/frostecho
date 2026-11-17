"""Recompute sealed calT/select/cert evidence from per-sample records.

Summary fields (n, errors, upper, coverage, temperature, tau) are claims.
Admission uses fit_temperature, select_policy, certify and cp_upper on the
records. A file with only a summary is not evidence. This module does not
load a model and does not mark a fixture as research data.
"""
from __future__ import annotations

import hashlib
import json
import math
import random
from dataclasses import dataclass

from calibration import (
    ALPHA, MAX_RISK, MIN_ACCEPTED, TAU_GRID, cp_upper, fit_temperature,
    select_policy, softmax,
)

TOLERANCE = 1e-9
CANDIDATE_PROTOCOL = ("c0", "c1", "c2", "c3")


@dataclass(frozen=True)
class Inspection:
    ok: bool
    reason: str
    temperature: float | None = None
    tau: float | None = None
    calibration_id: str | None = None
    evidence_class: str | None = None
    upper: float | None = None
    n: int | None = None
    errors: int | None = None
    coverage: float | None = None


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _exact_int(value, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{name} must be a real integer, got {type(value).__name__}:{value!r}")
    if value < 0:
        raise ValueError(f"{name} must be non-negative")
    return value


def _close(left: float, right: float) -> bool:
    return math.isfinite(left) and math.isfinite(right) and abs(left - right) <= TOLERANCE


def _argmax(values: list[float]) -> int:
    return max(range(len(values)), key=lambda index: values[index])


def _records(payload: dict, name: str) -> list[dict]:
    records = payload.get("records")
    if not isinstance(records, list) or not records:
        raise ValueError(f"{name}: missing per-sample records; summary n/errors/upper is not evidence")
    sample_ids = payload.get("sampleIds")
    if not isinstance(sample_ids, list) or len(sample_ids) != len(records):
        raise ValueError(f"{name}: sampleIds must list every record exactly once")
    seen: set[str] = set()
    for index, (record, sample_id) in enumerate(zip(records, sample_ids)):
        if not isinstance(record, dict):
            raise ValueError(f"{name}: record {index} is not an object")
        if record.get("sampleId") != sample_id or not isinstance(sample_id, str) or not sample_id:
            raise ValueError(f"{name}: sampleId at {index} does not match the record")
        if sample_id in seen:
            raise ValueError(f"{name}: duplicate sampleId {sample_id}")
        seen.add(sample_id)
        group = record.get("sourceGroup")
        if not isinstance(group, str) or not group:
            raise ValueError(f"{name}: record {sample_id} missing sourceGroup")
    declared = sha256_text(canonical(records))
    if payload.get("data_sha256") != declared:
        raise ValueError(f"{name}: data_sha256 does not match the per-sample records")
    return records


def _logits_and_label(record: dict, name: str, protocol: tuple[str, ...]) -> tuple[list[float], int]:
    candidates = record.get("candidateIds")
    if list(candidates or []) != list(protocol):
        raise ValueError(f"{name}: candidate protocol drift at {record.get('sampleId')}")
    logits = record.get("logits")
    if not isinstance(logits, list) or len(logits) != len(protocol):
        raise ValueError(f"{name}: logits do not match K at {record.get('sampleId')}")
    values: list[float] = []
    for position, value in enumerate(logits):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(float(value)):
            raise ValueError(f"{name}: non-finite logit at {record.get('sampleId')}[{position}]")
        values.append(float(value))
    label = record.get("label")
    if isinstance(label, bool) or not isinstance(label, int) or not 0 <= label < len(protocol):
        raise ValueError(f"{name}: label is not a candidate index at {record.get('sampleId')}")
    return values, label


def _pmax_and_correct(records: list[dict], name: str, temperature: float,
                      protocol: tuple[str, ...]) -> tuple[list[float], list[bool]]:
    probabilities: list[float] = []
    correct: list[bool] = []
    for record in records:
        logits, label = _logits_and_label(record, name, protocol)
        scaled = softmax(logits, temperature)
        chosen = _argmax(scaled)
        probabilities.append(scaled[chosen])
        correct.append(chosen == label)
    return probabilities, correct


def _check_frozen_flags(records: list[dict], name: str, temperature: float, tau: float,
                        protocol: tuple[str, ...]) -> None:
    for record in records:
        logits, label = _logits_and_label(record, name, protocol)
        scaled = softmax(logits, temperature)
        chosen = _argmax(scaled)
        accepted = scaled[chosen] >= tau
        error = accepted and chosen != label
        if "accepted" in record and record["accepted"] is not accepted:
            raise ValueError(f"{name}: frozen accepted flag does not match the logits at {record['sampleId']}")
        if "error" in record and record["error"] is not error:
            raise ValueError(f"{name}: frozen error flag does not match the logits at {record['sampleId']}")


def inspect_partitions(payloads: dict[str, dict], identity: dict) -> Inspection:
    """Return whether the three payloads are one sealed, recomputed bundle.

    `payloads` maps calT/select/cert to already-loaded JSON objects. File
    identity, distinct paths and the risk-protocol version are the caller's
    responsibility. This function never treats `valid: true` as proof.
    """
    try:
        return _inspect(payloads, identity)
    except ValueError as exc:
        return Inspection(ok=False, reason=str(exc))


def _inspect(payloads: dict[str, dict], identity: dict) -> Inspection:
    required = ("calT", "select", "cert")
    if set(payloads) != set(required):
        raise ValueError("sealed evidence requires calT, select and cert")
    # Records first: a summary-only certificate must not be rejected merely as
    # a missing file, and `valid: true` is not consulted.
    for name in required:
        _records(payloads[name], name)
    classes = {str(payloads[name].get("evidenceClass")) for name in required}
    if len(classes) != 1:
        raise ValueError("evidenceClass drifted across partitions")
    evidence_class = classes.pop()
    if evidence_class not in ("fixture", "cpu-mechanism"):
        raise ValueError(f"evidenceClass {evidence_class!r} is not a known sealed class")
    calibration_ids = {payloads[name].get("calibration_id") for name in required}
    if len(calibration_ids) != 1:
        raise ValueError("calibration_id drifted across partitions")
    calibration_id = calibration_ids.pop()
    if not isinstance(calibration_id, str) or not calibration_id:
        raise ValueError("calibration_id is missing")
    if identity.get("calibration_id") not in (None, calibration_id) \
            and "calibration_id" in identity:
        raise ValueError("identity calibration_id does not match the evidence")
    protocol: tuple[str, ...] | None = None
    groups: dict[str, set[str]] = {}
    parsed: dict[str, list[dict]] = {}
    for name in required:
        payload = payloads[name]
        if payload.get("partition") != name:
            raise ValueError(f"{name}: partition field drift")
        records = _records(payload, name)
        parsed[name] = records
        groups[name] = {str(record["sourceGroup"]) for record in records}
        candidate_ids = records[0].get("candidateIds")
        if protocol is None:
            protocol = tuple(candidate_ids)
        declared_k = payload.get("policy", {}).get("k")
        if declared_k != len(protocol):
            raise ValueError(f"{name}: policy k does not match the candidate protocol")
        if identity.get("k") != len(protocol):
            raise ValueError(f"{name}: identity k drifted from the candidate protocol")
        for field in ("model", "head", "adapter", "tokenizer", "renderer", "task",
                      "policy_version", "memory_policy_version"):
            policy = payload.get("policy") or {}
            if field in identity and policy.get(field) != identity.get(field):
                raise ValueError(f"{name}: policy {field} does not match the identity")
            if field in policy and field in identity and policy.get(field) != identity.get(field):
                raise ValueError(f"{name}: policy {field} drifted")
    assert protocol is not None
    if groups["calT"] & groups["select"] or groups["calT"] & groups["cert"] \
            or groups["select"] & groups["cert"]:
        raise ValueError("sourceGroup crosses calT/select/cert")
    for name in required:
        for record in parsed[name]:
            record_class = record.get("evidenceClass")
            if record_class is not None and str(record_class) != evidence_class:
                raise ValueError(
                    f"{name}: record evidenceClass {record_class!r} != "
                    f"partition evidenceClass {evidence_class!r}")
            _logits_and_label(record, name, protocol)

    cal_rows = [_logits_and_label(record, "calT", protocol) for record in parsed["calT"]]
    temperature = fit_temperature([row[0] for row in cal_rows], [row[1] for row in cal_rows])
    declared_t = payloads["calT"].get("temperature")
    if isinstance(declared_t, bool) or not isinstance(declared_t, (int, float)) \
            or not _close(float(declared_t), temperature):
        raise ValueError(f"calT temperature {declared_t!r} != fitted {temperature}")

    select_p, select_correct = _pmax_and_correct(parsed["select"], "select", temperature, protocol)
    selection = select_policy(select_p, select_correct, taus=TAU_GRID,
                              min_accepted=MIN_ACCEPTED, max_risk=MAX_RISK)
    if not selection.valid or selection.tau is None:
        raise ValueError(f"select did not freeze a tau: {selection.reason}")
    declared_tau = payloads["select"].get("tau")
    if isinstance(declared_tau, bool) or not isinstance(declared_tau, (int, float)) \
            or not _close(float(declared_tau), selection.tau):
        raise ValueError(f"select tau {declared_tau!r} != frozen {selection.tau}")
    declared_accepted = _exact_int(payloads["select"].get("accepted"), "select.accepted")
    if declared_accepted != selection.accepted:
        raise ValueError(f"select accepted {declared_accepted} != recomputed {selection.accepted}")
    if not _close(float(payloads["select"].get("coverage")), selection.coverage):
        raise ValueError("select coverage does not match the recomputed value")
    _check_frozen_flags(parsed["select"], "select", temperature, selection.tau, protocol)

    cert_p, cert_correct = _pmax_and_correct(parsed["cert"], "cert", temperature, protocol)
    accepted_flags = [probability >= selection.tau for probability in cert_p]
    n = sum(1 for flag in accepted_flags if flag)
    errors = sum(1 for flag, correct in zip(accepted_flags, cert_correct) if flag and not correct)
    alpha = payloads["cert"].get("alpha")
    if alpha != ALPHA:
        raise ValueError(f"cert alpha {alpha!r} != frozen {ALPHA}")
    upper = cp_upper(errors, n, ALPHA)
    if upper is None:
        raise ValueError("cert n=0 is refused")
    coverage = n / len(parsed["cert"]) if parsed["cert"] else 0.0
    declared_n = _exact_int(payloads["cert"].get("n"), "cert.n")
    declared_errors = _exact_int(payloads["cert"].get("errors"), "cert.errors")
    if declared_n != n or declared_errors != errors:
        raise ValueError(f"cert counts n/errors {declared_n}/{declared_errors} != recomputed {n}/{errors}")
    declared_upper = payloads["cert"].get("upper")
    if isinstance(declared_upper, bool) or not isinstance(declared_upper, (int, float)) \
            or not math.isfinite(float(declared_upper)) or not _close(float(declared_upper), upper):
        raise ValueError(f"cert upper {declared_upper!r} != cp_upper {upper}")
    declared_coverage = payloads["cert"].get("coverage")
    if isinstance(declared_coverage, bool) or not isinstance(declared_coverage, (int, float)) \
            or not _close(float(declared_coverage), coverage):
        raise ValueError("cert coverage does not match n/all-records")
    if payloads["cert"].get("tau") is not None and not _close(float(payloads["cert"]["tau"]), selection.tau):
        raise ValueError("cert tau is not the frozen select tau")
    _check_frozen_flags(parsed["cert"], "cert", temperature, selection.tau, protocol)
    if coverage < 0.30:
        raise ValueError("cert coverage is below 0.30")
    if upper > MAX_RISK:
        raise ValueError(f"cert upper {upper} is above max risk {MAX_RISK}")
    if "valid" in payloads["cert"] and payloads["cert"]["valid"] is not True and upper <= MAX_RISK:
        # A contradictory valid flag is ignored: the recomputed bound decides.
        pass
    return Inspection(ok=True, reason="recomputed evidence matches the frozen policy",
                      temperature=temperature, tau=float(selection.tau),
                      calibration_id=calibration_id, evidence_class=evidence_class,
                      upper=upper, n=n, errors=errors, coverage=coverage)


def _float_token(value: float) -> float:
    """Decimal form that Python and JS canonical JSON both print the same way."""
    rounded = round(float(value), 6)
    if rounded == int(rounded):
        rounded = round(rounded + 0.000001, 6)
    if abs(rounded) < 1e-4:
        rounded = 0.0001 if rounded >= 0 else -0.0001
    return rounded


def synthesize_records(n: int, seed: int, source_group: str, prefix: str,
                       protocol: tuple[str, ...] = CANDIDATE_PROTOCOL,
                       evidence_class: str = "fixture") -> list[dict]:
    """Peaked correct logits. Seeded, synthetic, and not a research sample."""
    rng = random.Random(seed)
    records = []
    for index in range(n):
        label = 0
        logits = [_float_token(rng.uniform(-0.15, 0.15)) for _ in protocol]
        logits[label] = _float_token(rng.uniform(4.0, 6.0))
        records.append({
            "sampleId": f"{prefix}-{index:04d}",
            "sourceGroup": source_group,
            "candidateIds": list(protocol),
            "logits": logits,
            "label": label,
            "evidenceClass": evidence_class,
        })
    return records


def build_cpu_bundle(identity: dict, *, calibration_id: str = "fixture-r6-cpu",
                     evidence_class: str = "fixture", n: int = 160,
                     seeds: tuple[int, int] = (17, 43)) -> dict[str, dict]:
    """Build three partitions whose declared statistics are the production ones."""
    if evidence_class not in ("fixture", "cpu-mechanism"):
        raise ValueError("bundle evidenceClass must be fixture or cpu-mechanism")
    protocol = CANDIDATE_PROTOCOL
    cal_records = synthesize_records(n, seeds[0], f"{calibration_id}-calT", "calT", protocol,
                                     evidence_class=evidence_class)
    select_records = synthesize_records(n, seeds[1], f"{calibration_id}-select", "select", protocol,
                                        evidence_class=evidence_class)
    cert_records = synthesize_records(n, seeds[0] + seeds[1], f"{calibration_id}-cert", "cert", protocol,
                                      evidence_class=evidence_class)
    policy = {field: identity[field] for field in (
        "model", "head", "adapter", "tokenizer", "renderer", "task", "k",
        "policy_version", "memory_policy_version")}
    temperature = fit_temperature(
        [record["logits"] for record in cal_records],
        [record["label"] for record in cal_records])
    select_scaled = [softmax(record["logits"], temperature) for record in select_records]
    select_p = [max(row) for row in select_scaled]
    select_correct = [_argmax(row) == record["label"]
                      for row, record in zip(select_scaled, select_records)]
    selection = select_policy(select_p, select_correct)
    if not selection.valid or selection.tau is None:
        raise RuntimeError(f"cpu fixture failed to freeze tau: {selection.reason}")
    tau = float(selection.tau)
    cert_scaled = [softmax(record["logits"], temperature) for record in cert_records]
    cert_p = [max(row) for row in cert_scaled]
    cert_correct = [_argmax(row) == record["label"]
                    for row, record in zip(cert_scaled, cert_records)]
    accepted = [probability >= tau for probability in cert_p]
    cert_n = sum(1 for flag in accepted if flag)
    cert_errors = sum(1 for flag, correct in zip(accepted, cert_correct) if flag and not correct)
    upper = cp_upper(cert_errors, cert_n, ALPHA)
    coverage = cert_n / len(cert_records)

    def stamp(records: list[dict], tau_value: float | None) -> None:
        if tau_value is None:
            return
        for record in records:
            scaled = softmax(record["logits"], temperature)
            chosen = _argmax(scaled)
            record["accepted"] = scaled[chosen] >= tau_value
            record["error"] = record["accepted"] and chosen != record["label"]

    stamp(select_records, tau)
    stamp(cert_records, tau)

    def payload(partition: str, records: list[dict], **extra) -> dict:
        body = {
            "schema": "frostecho.jev04.evidence/1",
            "partition": partition,
            "protocol_version": "jev04-risk/1",
            "evidenceClass": evidence_class,
            "calibration_id": calibration_id,
            "policy": policy,
            "sampleIds": [record["sampleId"] for record in records],
            "records": records,
            "data_sha256": sha256_text(canonical(records)),
            "note": "synthetic CPU fixture; not research train/dev/cal registration",
        }
        body.update(extra)
        return body

    return {
        "calT": payload("calT", cal_records, temperature=temperature, tau=tau),
        "select": payload("select", select_records, tau=tau, accepted=selection.accepted,
                          coverage=selection.coverage, temperature=temperature),
        "cert": payload("cert", cert_records, tau=tau, n=cert_n, errors=cert_errors,
                        upper=upper, coverage=coverage, alpha=ALPHA, temperature=temperature,
                        valid=bool(upper is not None and upper <= MAX_RISK and coverage >= 0.30)),
    }
