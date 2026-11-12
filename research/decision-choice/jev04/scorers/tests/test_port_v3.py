"""Tests for port_v3 (R3): trusted manifest, evidence boundary, utility provenance.

Includes the audit repro: a fabricated `real` artifact whose identity agrees
with the request on every field is still refused, because registration in the
trusted manifest — not self-report agreement — authorizes a policy.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import sys

_HERE = Path(__file__).resolve()
sys.path.insert(0, str(_HERE.parents[1]))
from port_v3 import (  # noqa: E402
    ARTIFACT_SCHEMA, IDENTITY_FIELDS, IdentityError, MANIFEST_SCHEMA,
    ScorerArtifact, ScorerIdentity, ScorerRequest, decide, load_artifact,
    load_trusted_manifest, resolve_registration, save_artifact,
)

BASE_IDENTITY = dict(
    model="fixture/r3", head="shared-scalar/1", adapter="jev-choice/1",
    tokenizer="fixture-tok/1", renderer="jev04-render/3",
    task="reference_resolution", k=4, policy_version="softmax-accept/1",
    memory_policy_version="memory-policy/1",
)


def manifest_payload(mode: str, **overrides) -> dict:
    identity = {**BASE_IDENTITY, **overrides}
    return {
        "schema": MANIFEST_SCHEMA,
        "registrations": [{
            "identity": identity,
            "mode": mode,
            "utility_source": None,
            "evidence": None,
        }],
    }


def write_json(payload: dict) -> Path:
    tmp = tempfile.NamedTemporaryFile("w", suffix=".json", delete=False,
                                      encoding="utf-8")
    json.dump(payload, tmp)
    tmp.close()
    return Path(tmp.name)


class TrustedManifestTests(unittest.TestCase):
    def test_registered_identity_resolves(self):
        path = write_json(manifest_payload("fixture"))
        manifest = load_trusted_manifest(str(path))
        identity = ScorerIdentity(**BASE_IDENTITY)
        registration = resolve_registration(manifest, identity)
        self.assertEqual(registration.mode, "fixture")
        self.assertFalse(registration.allows_real_execution())

    def test_unregistered_task_is_refused_even_when_artifact_agrees(self):
        # Audit repro: self-report agreement is not registration.
        manifest = load_trusted_manifest(str(write_json(manifest_payload("fixture"))))
        rogue = ScorerIdentity(**{**BASE_IDENTITY, "task": "interpret_request"})
        artifact_payload = {
            "schema": ARTIFACT_SCHEMA,
            "identity": {**BASE_IDENTITY, "task": "interpret_request"},
            "mode": "real", "temperature": 1.0, "tau": 0.5, "coverage": 0.9,
            "upper": 0.1, "calibration_id": "cal/fake",
        }
        artifact_path = write_json(artifact_payload)
        with self.assertRaises(IdentityError):
            load_artifact(str(artifact_path), rogue, manifest=manifest)

    def test_unknown_policy_version_is_refused(self):
        manifest = load_trusted_manifest(str(write_json(manifest_payload("fixture"))))
        rogue = ScorerIdentity(**{**BASE_IDENTITY, "policy_version": "greedy-x/9"})
        with self.assertRaises(IdentityError):
            resolve_registration(manifest, rogue)

    def test_real_mode_without_sealed_evidence_is_shadow_only(self):
        manifest = load_trusted_manifest(str(write_json(manifest_payload("real"))))
        identity = ScorerIdentity(**BASE_IDENTITY)
        artifact = ScorerArtifact(
            schema=ARTIFACT_SCHEMA, identity=identity, mode="real",
            temperature=1.0, tau=0.30, coverage=0.0, upper=None,
            calibration_id=None)
        request = ScorerRequest("req-1", identity, ["c0", "c1", "c2", "c3"],
                                [3.0, 0.0, 0.0, 0.0])
        output = decide(artifact, request, manifest=manifest)
        self.assertEqual(output.disposition, "shadow_only")
        self.assertIsNone(output.selected_index)
        self.assertFalse(output.counts_as_real)

    def test_manifest_schema_is_enforced(self):
        with self.assertRaises(IdentityError):
            load_trusted_manifest(str(write_json({"schema": "other/1",
                                                  "registrations": []})))


class UtilityProvenanceTests(unittest.TestCase):
    def test_utility_is_none_not_copied_probability(self):
        manifest = load_trusted_manifest(str(write_json(manifest_payload("fixture"))))
        identity = ScorerIdentity(**BASE_IDENTITY)
        artifact = ScorerArtifact(schema=ARTIFACT_SCHEMA, identity=identity,
                                  mode="fixture", temperature=2.0, tau=0.30,
                                  coverage=0.0, upper=None)
        request = ScorerRequest("req-2", identity, ["a", "b", "c", "d"],
                                [2.0, 1.0, 0.0, -1.0])
        output = decide(artifact, request, manifest=manifest)
        self.assertIsNone(output.utility)
        self.assertIsNone(output.utility_source)
        self.assertIsNotNone(output.temperature_probabilities)
        # v2 copied temperature probabilities into utility; v3 must not.
        self.assertNotEqual(output.utility, output.temperature_probabilities)
        self.assertFalse(output.counts_as_real)

    def test_fixture_output_never_counts_as_real(self):
        manifest = load_trusted_manifest(str(write_json(manifest_payload("fixture"))))
        identity = ScorerIdentity(**BASE_IDENTITY)
        artifact = ScorerArtifact(schema=ARTIFACT_SCHEMA, identity=identity,
                                  mode="fixture", temperature=1.0, tau=0.30,
                                  coverage=0.9, upper=0.05)
        request = ScorerRequest("req-3", identity, ["a", "b", "c", "d"],
                                [5.0, 0.0, 0.0, 0.0])
        output = decide(artifact, request, manifest=manifest)
        self.assertEqual(output.disposition, "accept")
        self.assertFalse(output.counts_as_real)


class InputRefusalTests(unittest.TestCase):
    def test_k_drift_is_refused(self):
        identity = ScorerIdentity(**BASE_IDENTITY)
        manifest = load_trusted_manifest(str(write_json(manifest_payload("fixture"))))
        artifact = ScorerArtifact(schema=ARTIFACT_SCHEMA, identity=identity,
                                  mode="fixture", temperature=1.0, tau=0.3,
                                  coverage=0.0, upper=None)
        request = ScorerRequest("req-4", identity, ["a", "b"],
                                [1.0, 0.0])
        from calibration import ScorerInputError
        with self.assertRaises(ScorerInputError):
            decide(artifact, request, manifest=manifest)

    def test_nonfinite_logits_are_refused(self):
        identity = ScorerIdentity(**BASE_IDENTITY)
        manifest = load_trusted_manifest(str(write_json(manifest_payload("fixture"))))
        artifact = ScorerArtifact(schema=ARTIFACT_SCHEMA, identity=identity,
                                  mode="fixture", temperature=1.0, tau=0.3,
                                  coverage=0.0, upper=None)
        for bad in (float("nan"), float("inf")):
            request = ScorerRequest("req-5", identity, ["a", "b", "c", "d"],
                                    [1.0, 0.0, 0.0, bad])
            from calibration import ScorerInputError
            with self.assertRaises(ScorerInputError):
                decide(artifact, request, manifest=manifest)


class ArtifactRoundTripTests(unittest.TestCase):
    def test_save_and_load_round_trip(self):
        identity = ScorerIdentity(**BASE_IDENTITY)
        artifact = ScorerArtifact(schema=ARTIFACT_SCHEMA, identity=identity,
                                  mode="fixture", temperature=1.5, tau=0.25,
                                  coverage=0.8, upper=0.06,
                                  calibration_id="cal/x")
        path = Path(tempfile.mkdtemp()) / "artifact.json"
        save_artifact(str(path), artifact)
        loaded = load_artifact(str(path), identity)
        self.assertEqual(loaded.identity.as_dict(), artifact.identity.as_dict())


if __name__ == "__main__":
    unittest.main()
