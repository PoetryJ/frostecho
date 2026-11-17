"""JEV-04 ScorerPort (R2). The actual adapter entry the application calls.

Contract: `scorers/PORT.md`. This module is CPU-only and has no network or GPU
dependency; a real model adapter fills `ScorerRequest.raw_logits`.
"""
from __future__ import annotations

import json
import math
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[1] / "calibration"))
from calibration import SUPPORTED_K, ScorerInputError, softmax  # noqa: E402

ARTIFACT_SCHEMA = "frostecho.jev04.scorer-artifact/1"
IDENTITY_FIELDS = ("model", "head", "adapter", "tokenizer", "renderer",
                   "task", "k", "policy_version", "memory_policy_version")


class IdentityError(ValueError):
    """The artifact/policy identity is missing, unknown or drifted."""


@dataclass(frozen=True)
class ScorerIdentity:
    model: str
    head: str
    adapter: str
    tokenizer: str
    renderer: str
    task: str
    k: int
    policy_version: str
    memory_policy_version: str

    def as_dict(self) -> dict:
        return {name: getattr(self, name) for name in IDENTITY_FIELDS}


@dataclass(frozen=True)
class ScorerArtifact:
    schema: str
    identity: ScorerIdentity
    mode: str                    # "fixture" | "real"
    temperature: float
    tau: float
    coverage: float
    upper: Optional[float]
    calibration_id: Optional[str] = None


@dataclass(frozen=True)
class ScorerRequest:
    request_id: str
    identity: ScorerIdentity
    candidate_ids: list
    raw_logits: list


@dataclass(frozen=True)
class ScorerOutput:
    raw_logits: list
    softmax_probabilities: list
    temperature_probabilities: list
    utility: list
    selected_index: Optional[int]
    disposition: str             # "accept" | "abstain"
    pmax: float
    mode: str                    # mirrors the artifact: fixture results never count as model evidence


def load_artifact(path: str, request_identity: ScorerIdentity) -> ScorerArtifact:
    """Load an artifact and verify the full nine-field identity, fail closed."""
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if payload.get("schema") != ARTIFACT_SCHEMA:
        raise IdentityError("unexpected scorer artifact schema")
    identity_payload = payload.get("identity")
    if not isinstance(identity_payload, dict):
        raise IdentityError("artifact has no identity")
    missing = [name for name in IDENTITY_FIELDS if name not in identity_payload]
    if missing:
        raise IdentityError(f"artifact identity missing fields: {missing}")
    identity = ScorerIdentity(**identity_payload)
    for name in IDENTITY_FIELDS:
        if getattr(identity, name) != getattr(request_identity, name):
            raise IdentityError(
                f"identity mismatch on {name}: {getattr(identity, name)!r} != "
                f"{getattr(request_identity, name)!r}")
    mode = payload.get("mode")
    if mode not in ("fixture", "real"):
        raise IdentityError(f"artifact mode must be fixture|real, got {mode!r}")
    if identity.k not in SUPPORTED_K:
        raise IdentityError(f"K={identity.k} outside {SUPPORTED_K}")
    temperature = float(payload.get("temperature"))
    tau = float(payload.get("tau"))
    if not math.isfinite(temperature) or temperature <= 0:
        raise IdentityError("artifact temperature must be positive and finite")
    if not math.isfinite(tau) or not (0 <= tau <= 1):
        raise IdentityError("artifact tau must lie in [0, 1]")
    return ScorerArtifact(schema=ARTIFACT_SCHEMA, identity=identity, mode=mode,
                          temperature=temperature, tau=tau,
                          coverage=float(payload.get("coverage", 0.0)),
                          upper=payload.get("upper"),
                          calibration_id=payload.get("calibration_id"))


def decide(artifact: ScorerArtifact, request: ScorerRequest) -> ScorerOutput:
    """Score one request; every illegal input is refused, never defaulted."""
    if request.identity.as_dict() != artifact.identity.as_dict():
        raise IdentityError("request identity does not match the loaded artifact")
    expected = artifact.identity.k
    if len(request.candidate_ids) != expected:
        raise ScorerInputError(
            f"candidate count {len(request.candidate_ids)} != policy K={expected}")
    if len(request.raw_logits) != expected:
        raise ScorerInputError(
            f"logits count {len(request.raw_logits)} != policy K={expected}")
    if len(set(map(str, request.candidate_ids))) != expected:
        raise ScorerInputError("candidate ids must be unique")
    for position, value in enumerate(request.raw_logits):
        if not isinstance(value, (int, float)) or isinstance(value, bool) \
                or not math.isfinite(float(value)):
            raise ScorerInputError(f"logit {position} is not finite: {value!r}")
    raw = [float(value) for value in request.raw_logits]
    plain = softmax(raw, 1.0)
    temperatured = softmax(raw, artifact.temperature)
    index = max(range(len(temperatured)), key=lambda i: temperatured[i])
    pmax = temperatured[index]
    accepted = pmax >= artifact.tau
    return ScorerOutput(raw_logits=raw, softmax_probabilities=plain,
                        temperature_probabilities=temperatured,
                        utility=list(temperatured),
                        selected_index=index if accepted else None,
                        disposition="accept" if accepted else "abstain",
                        pmax=pmax, mode=artifact.mode)


def save_artifact(path: str, artifact: ScorerArtifact) -> None:
    payload = {
        "schema": ARTIFACT_SCHEMA,
        "identity": artifact.identity.as_dict(),
        "mode": artifact.mode,
        "temperature": artifact.temperature,
        "tau": artifact.tau,
        "coverage": artifact.coverage,
        "upper": artifact.upper,
        "calibration_id": artifact.calibration_id,
    }
    Path(path).write_text(json.dumps(payload, ensure_ascii=False, sort_keys=True, indent=2),
                          encoding="utf-8")
