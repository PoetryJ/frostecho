"""Sealed, recomputable real JEV calibration and runtime selective decisions."""
from __future__ import annotations

import copy
import math
import sys
from pathlib import Path

MODELS = Path(__file__).resolve().parents[1] / "models"
if str(MODELS) not in sys.path:
    sys.path.insert(0, str(MODELS))
from contracts import digest, read_json
from math_core import ALPHA, MAX_RISK, MIN_CERT_COVERAGE, MIN_SELECT_ACCEPTED, TAU_GRID
from math_core import acceptable_indices, certify, fit_temperature, metrics, select_tau, softmax

IDENTITY_FIELDS = ("checkpointSha256", "encoderSha256", "renderer", "memoryPolicyVersion")
PARTITIONS = ("calT", "select", "cert")
PROTOCOL = {"version": "jev05-selective-risk/1", "alpha": ALPHA, "maxRisk": MAX_RISK,
            "minSelectAccepted": MIN_SELECT_ACCEPTED, "minCertCoverage": MIN_CERT_COVERAGE,
            "tauGrid": list(TAU_GRID), "temperatureBounds": [0.05, 20.0],
            "temperatureObjective": "acceptable-set-nll", "correctness": "argmax-in-acceptable-set"}


def validate_partitions(partitions, identity, evidence_class):
    if set(partitions) != set(PARTITIONS):
        raise ValueError("exactly calT/select/cert partitions are required")
    if evidence_class not in ("real-model", "unit-test"):
        raise ValueError("unrecognized evidence class")
    for key in IDENTITY_FIELDS:
        if not isinstance(identity.get(key), str) or not identity[key]:
            raise ValueError(f"missing policy identity {key}")
    all_ids, group_owner, family_owner = set(), {}, {}
    for split, records in partitions.items():
        if not isinstance(records, list) or not records:
            raise ValueError(f"{split}: per-sample records required")
        for row in records:
            case_id = row.get("caseId")
            if not isinstance(case_id, str) or not case_id or case_id in all_ids:
                raise ValueError("calibration IDs are missing/reused across partitions")
            all_ids.add(case_id)
            if row.get("split") != split or row.get("evidenceClass") != evidence_class:
                raise ValueError(f"{case_id}: split/evidence class drift")
            if not isinstance(row.get("contentHash"), str) or not row["contentHash"]:
                raise ValueError(f"{case_id}: missing original input hash")
            for key in IDENTITY_FIELDS:
                if row.get(key) != identity[key]:
                    raise ValueError(f"{case_id}: {key} drift")
            for key, owners in (("sourceGroup", group_owner), ("templateFamily", family_owner)):
                value = row.get(key)
                if not isinstance(value, str) or not value:
                    raise ValueError(f"{case_id}: missing {key}")
                if value in owners and owners[value] != split:
                    raise ValueError(f"{key} crosses calibration partitions")
                owners[value] = split
            acceptable_indices(row)


def build_artifact(partitions, identity, *, evidence_class, qualification=None, source=None):
    validate_partitions(partitions, identity, evidence_class)
    temperature = fit_temperature(partitions["calT"])
    selection = select_tau(partitions["select"], temperature)
    certificate = certify(partitions["cert"], temperature, selection["tau"])
    if evidence_class == "real-model":
        if (not isinstance(qualification, dict) or qualification.get("mayTrainOnJev") is not True or
                qualification.get("counts", {}).get("train", 0) < 512 or
                qualification.get("counts", {}).get("dev", 0) < 128 or
                not qualification.get("manifestSha256") or not qualification.get("casesSha256")):
            raise ValueError("real evidence needs recomputed qualified data binding")
        if not source or not source.get("scoresSha256") or not source.get("checkpointManifestSha256"):
            raise ValueError("real evidence needs raw score and checkpoint file binding")
    artifact = {
        "schema": "frostecho.jev05.calibration/1", "protocol": PROTOCOL,
        "identity": identity, "evidenceClass": evidence_class,
        "qualification": qualification, "source": source,
        "partitions": {name: {"records": rows, "recordsSha256": digest(rows)} for name, rows in partitions.items()},
        "temperature": temperature, "tau": selection["tau"], "selection": selection,
        "certificate": certificate,
        "metrics": {"calTBefore": metrics(partitions["calT"], 1.0),
                    "calTAfter": metrics(partitions["calT"], temperature),
                    "select": metrics(partitions["select"], temperature),
                    "cert": metrics(partitions["cert"], temperature)},
        "riskProtocolPassed": bool(selection["valid"] and certificate["valid"]),
        "eligibleForExecution": bool(evidence_class == "real-model" and selection["valid"] and certificate["valid"]),
        "executionAdmitted": False,
        "note": "Execution additionally requires this exact artifact in the trusted runtime registry and matching policy identity. Unit-test evidence never admits execution.",
    }
    artifact["artifactSha256"] = digest(artifact)
    return artifact


def verify_artifact(artifact):
    """Recompute T, tau, certificate and metrics; declarations are not evidence."""
    if artifact.get("schema") != "frostecho.jev05.calibration/1" or artifact.get("protocol") != PROTOCOL:
        raise ValueError("calibration schema/frozen protocol mismatch")
    frozen = copy.deepcopy(artifact)
    claimed = frozen.pop("artifactSha256", None)
    if digest(frozen) != claimed:
        raise ValueError("calibration artifact hash mismatch")
    partitions = {}
    for name in PARTITIONS:
        payload = artifact.get("partitions", {}).get(name, {})
        rows = payload.get("records")
        if payload.get("recordsSha256") != digest(rows):
            raise ValueError(f"{name}: record bytes/hash mismatch")
        partitions[name] = rows
    recomputed = build_artifact(partitions, artifact["identity"], evidence_class=artifact["evidenceClass"],
                                qualification=artifact.get("qualification"), source=artifact.get("source"))
    if recomputed["artifactSha256"] != claimed:
        raise ValueError("calibration declarations differ from recomputed per-sample statistics")
    return recomputed


def load_calibration(path, *, expected_artifact_sha=None, expected_identity=None):
    artifact = verify_artifact(read_json(path))
    reason = None
    if expected_artifact_sha is None:
        reason = "no out-of-band trusted artifact SHA registered"
    elif artifact["artifactSha256"] != expected_artifact_sha:
        raise ValueError("trusted calibration artifact SHA mismatch")
    if expected_identity is None:
        reason = reason or "no runtime model/memory identity supplied"
    else:
        for key in IDENTITY_FIELDS:
            if expected_identity.get(key) != artifact["identity"][key]:
                raise ValueError(f"runtime calibration identity mismatch: {key}")
    admitted = reason is None and artifact["eligibleForExecution"] is True
    if not admitted and reason is None:
        reason = "evidence is not real or the frozen risk/coverage protocol did not pass"
    return {"artifact": artifact, "executionAdmitted": admitted, "reason": reason}


def predict(logits, candidate_ids, loaded, *, identity, content_hash=None):
    artifact = loaded["artifact"]
    for key in IDENTITY_FIELDS:
        if identity.get(key) != artifact["identity"][key]:
            raise ValueError(f"score request identity mismatch: {key}")
    if not isinstance(candidate_ids, list) or len(candidate_ids) != len(logits) or len(candidate_ids) < 2 or len(set(candidate_ids)) != len(candidate_ids) or not all(isinstance(value, str) and value for value in candidate_ids):
        raise ValueError("invalid score candidate IDs")
    supported_k = {len(row["candidateIds"]) for row in artifact["partitions"]["cert"]["records"]}
    if len(candidate_ids) not in supported_k:
        raise ValueError("candidate cardinality outside certified records")
    probabilities = softmax(logits, artifact["temperature"])
    best = max(range(len(probabilities)), key=lambda index: probabilities[index])
    tau = artifact["tau"]
    accepted = tau is not None and probabilities[best] >= tau
    admitted = loaded["executionAdmitted"] is True and artifact["eligibleForExecution"] is True
    return {"schema": "frostecho.jev05.decision/1", "rawLogits": logits,
            "probabilities": probabilities, "temperature": artifact["temperature"], "tau": tau,
            "candidateIds": candidate_ids, "pmax": probabilities[best],
            "disposition": "accept" if accepted else "abstain",
            "proposedId": candidate_ids[best] if accepted else None,
            "selectedId": candidate_ids[best] if accepted and admitted else None,
            "executionAdmitted": admitted, "countsAsRealDecision": bool(admitted),
            "identity": artifact["identity"], "calibrationSha256": artifact["artifactSha256"],
            "contentHash": content_hash, "reason": loaded.get("reason"), "utility": None}
