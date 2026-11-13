"""JEV-04 ScorerPort v3 (R3).

Fixes the two R2 semantic gaps the audit called out:

1. Trusted policy manifest. In v2, an artifact whose self-reported identity
   equalled the request identity was enough to execute a policy. Self-report
   agreement proves nothing, so v3 resolves the identity against a trusted
   manifest registered out of band. An unregistered task/policy — even when
   artifact and request agree perfectly — is refused (fail closed). A `real`
   policy additionally requires sealed calibration/select/cert evidence
   referenced by the manifest; without it the policy degrades to shadow-only.
   A `fixture` artifact can never pose as real evidence.

2. Utility provenance. v2 copied `temperature_probabilities` into `utility`.
   v3 returns `utility=None` unless the manifest registration binds an
   explicit `utility_source`; probabilities are never silently reused as
   world utilities.
"""
from __future__ import annotations

import hashlib
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parent.parent / "calibration"))
from calibration import SUPPORTED_K, ScorerInputError, softmax  # noqa: E402
from sealed import Inspection, inspect_partitions  # noqa: E402

ARTIFACT_SCHEMA = "frostecho.jev04.scorer-artifact/1"
MANIFEST_SCHEMA = "frostecho.jev04.trusted-policy-manifest/1"
IDENTITY_FIELDS = ("model", "head", "adapter", "tokenizer", "renderer",
                   "task", "k", "policy_version", "memory_policy_version")
RISK_PROTOCOL_VERSION = "jev04-risk/1"
EVIDENCE_PARTITIONS = {"calT": "calT", "select": "select", "cert": "cert"}
POLICY_FIELDS = ("model", "head", "tokenizer", "renderer", "task", "k",
                 "memory_policy_version")


class IdentityError(ValueError):
    """Identity missing, unregistered or drifted; or evidence missing."""


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
class TrustedRegistration:
    identity: ScorerIdentity
    mode: str                              # fixture | real
    utility_source: Optional[str]          # explicit provenance or None
    evidence: Optional[dict] = None        # sealed calT/select/cert refs

    def inspect(self) -> Inspection:
        """Recompute the sealed bundle. `valid: true` is not evidence."""
        if self.mode != "real":
            return Inspection(ok=False, reason="registration mode is not real")
        loaded, reason = self._load_partitions()
        if reason:
            return Inspection(ok=False, reason=reason)
        return inspect_partitions(loaded, self.identity.as_dict())

    def _load_partitions(self) -> tuple[dict, str | None]:
        evidence = self.evidence or {}
        if evidence.get("protocol_version") != RISK_PROTOCOL_VERSION:
            return {}, "risk protocol missing or drifted"
        payloads: dict = {}
        paths: list[str] = []
        for key in ("calT", "select", "cert"):
            ref = evidence.get(key)
            if not isinstance(ref, dict):
                return {}, f"{key}: evidence reference missing"
            path = Path(str(ref.get("path", "")))
            if not path.is_file():
                return {}, f"{key}: evidence file missing"
            digest = hashlib.sha256(path.read_bytes()).hexdigest()
            if digest != ref.get("sha256"):
                return {}, f"{key}: sha256 does not match the file bytes"
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                return {}, f"{key}: unreadable evidence ({exc})"
            if not isinstance(payload, dict) or not payload:
                return {}, f"{key}: empty evidence"
            if payload.get("partition") != EVIDENCE_PARTITIONS[key]:
                return {}, f"{key}: partition name drift"
            if payload.get("protocol_version") != RISK_PROTOCOL_VERSION:
                return {}, f"{key}: protocol_version drift"
            policy = payload.get("policy")
            if not isinstance(policy, dict):
                return {}, f"{key}: policy missing"
            if any(policy.get(name) != getattr(self.identity, name) for name in POLICY_FIELDS):
                return {}, f"{key}: policy identity drift"
            payloads[key] = payload
            paths.append(str(path.resolve()))
        if len(set(paths)) != 3:
            return {}, "calT/select/cert are not three distinct files"
        return payloads, None

    def allows_real_execution(self) -> bool:
        """Distinct sealed partitions whose statistics recompute from records.

        Empty files, a reused file, a protocol or identity drift, a summary
        that does not match the records, or a parameter mismatch all fail
        closed. `valid: true` is not consulted.
        """
        return self.inspect().ok


@dataclass(frozen=True)
class ScorerArtifact:
    schema: str
    identity: ScorerIdentity
    mode: str
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
    utility: Optional[list]          # None unless an explicit utility_source is bound
    utility_source: Optional[str]
    selected_index: Optional[int]
    disposition: str                 # accept | abstain | shadow_only
    pmax: float
    mode: str
    counts_as_real: bool             # fixture output is never model evidence
    reason: Optional[str] = None     # explicit refusal; None on an ordinary fixture decision


def load_trusted_manifest(path: str) -> dict:
    payload = json.loads(Path(path).read_text(encoding="utf-8"))
    if payload.get("schema") != MANIFEST_SCHEMA:
        raise IdentityError(f"unexpected manifest schema {payload.get('schema')!r}")
    for registration in payload.get("registrations", []):
        identity = registration.get("identity")
        if not isinstance(identity, dict):
            raise IdentityError("manifest registration without identity")
        missing = [name for name in IDENTITY_FIELDS if name not in identity]
        if missing:
            raise IdentityError(f"manifest identity missing fields: {missing}")
        if registration.get("mode") not in ("fixture", "real"):
            raise IdentityError("manifest registration mode must be fixture|real")
    return payload


def resolve_registration(manifest: dict, identity: ScorerIdentity) -> TrustedRegistration:
    """Trusted-manifest lookup: request/artifact agreement is not registration."""
    for registration in manifest.get("registrations", []):
        candidate = registration["identity"]
        if all(candidate.get(name) == getattr(identity, name) for name in IDENTITY_FIELDS):
            return TrustedRegistration(
                identity=ScorerIdentity(**candidate),
                mode=registration["mode"],
                utility_source=registration.get("utility_source"),
                evidence=registration.get("evidence"))
    raise IdentityError(
        "policy_not_registered: identity is absent from the trusted manifest "
        f"(task={identity.task!r}, policy={identity.policy_version!r})")


def load_artifact(path: str, request_identity: ScorerIdentity,
                  manifest: Optional[dict] = None) -> ScorerArtifact:
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
    if manifest is not None:
        resolve_registration(manifest, identity)
    return ScorerArtifact(schema=ARTIFACT_SCHEMA, identity=identity, mode=mode,
                          temperature=temperature, tau=tau,
                          coverage=float(payload.get("coverage", 0.0)),
                          upper=payload.get("upper"),
                          calibration_id=payload.get("calibration_id"))


def decide(artifact: ScorerArtifact, request: ScorerRequest,
           manifest: Optional[dict] = None) -> ScorerOutput:
    if request.identity.as_dict() != artifact.identity.as_dict():
        raise IdentityError("request identity does not match the loaded artifact")
    registration = (resolve_registration(manifest, request.identity)
                    if manifest is not None else None)
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

    utility: Optional[list] = None
    utility_source: Optional[str] = None
    # A fixture artifact can never count as real, even when it reuses a real
    # registration; only a real artifact + real registration + recomputed
    # evidence whose T/tau/calibration_id match this artifact can be model
    # evidence. Fixture-class evidence stays counts_as_real false.
    inspection = registration.inspect() if registration is not None and registration.mode == "real" else None
    reason: Optional[str] = None
    bound = False
    if artifact.mode == "real":
        if inspection is None:
            reason = "real artifact has no real registration"
        elif not inspection.ok:
            reason = inspection.reason
        elif inspection.temperature is None or not math.isclose(
                artifact.temperature, inspection.temperature, rel_tol=0.0, abs_tol=1e-9):
            reason = (f"artifact temperature {artifact.temperature} != "
                      f"calT {inspection.temperature}")
        elif inspection.tau is None or not math.isclose(
                artifact.tau, inspection.tau, rel_tol=0.0, abs_tol=1e-9):
            reason = f"artifact tau {artifact.tau} != frozen tau {inspection.tau}"
        elif artifact.calibration_id != inspection.calibration_id:
            reason = (f"calibration_id {artifact.calibration_id!r} != "
                      f"evidence {inspection.calibration_id!r}")
        elif inspection.evidence_class in ("fixture", "cpu-mechanism"):
            reason = f"{inspection.evidence_class} synthetic evidence cannot count as real"
        else:
            reason = (f"evidenceClass {inspection.evidence_class!r} is not real-model evidence")
    counts_as_real = bool(artifact.mode == "real" and bound)
    if artifact.mode == "real" and not counts_as_real:
        # A real policy without sealed, bound evidence never executes.
        return ScorerOutput(raw_logits=raw, softmax_probabilities=plain,
                            temperature_probabilities=temperatured,
                            utility=None, utility_source=None,
                            selected_index=None, disposition="shadow_only",
                            pmax=pmax, mode=artifact.mode, counts_as_real=False,
                            reason=reason)
    if registration is not None and registration.utility_source and counts_as_real:
        # An explicit utility source would be consumed here from its own
        # sealed artifact; R3 ships none, so utility stays None.
        utility_source = registration.utility_source
    accepted = pmax >= artifact.tau
    return ScorerOutput(raw_logits=raw, softmax_probabilities=plain,
                        temperature_probabilities=temperatured,
                        utility=utility, utility_source=utility_source,
                        selected_index=index if accepted else None,
                        disposition="accept" if accepted else "abstain",
                        pmax=pmax, mode=artifact.mode,
                        counts_as_real=counts_as_real)


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
