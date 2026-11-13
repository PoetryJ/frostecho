"""Synthetic logit mechanism checks; these never certify a real model."""
from __future__ import annotations

import copy
import importlib.util
import math
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
CAL = ROOT / "research" / "decision-choice" / "jev05" / "calibration"
sys.path.insert(0, str(CAL))
from math_core import cp_upper, fit_temperature, metrics, set_nll
from policy import build_artifact, load_calibration, predict, verify_artifact
from contracts import digest, write_json

spec = importlib.util.spec_from_file_location("jev05_calibration_cli", CAL / "cli.py")
cal_cli = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cal_cli)

IDENTITY = {"checkpointSha256": "unit-checkpoint", "encoderSha256": "unit-encoder",
            "renderer": "unit-renderer", "memoryPolicyVersion": "unit-memory"}


def partitions(n=120):
    result = {}
    for split in ("calT", "select", "cert"):
        result[split] = [{"caseId": f"{split}-{index}", "split": split,
                          "sourceGroup": f"{split}-source-{index}", "templateFamily": f"{split}-family-{index}",
                          "contentHash": f"unit-input-{split}-{index}", "evidenceClass": "unit-test",
                          "candidateIds": ["c0", "c1", "c2", "c3"], "acceptableIds": ["c0", "c1"],
                          "rawLogits": [1.0, 6.0, -4.0, -4.0], **IDENTITY} for index in range(n)]
    return result


class CalibrationMechanismTests(unittest.TestCase):
    def test_set_label_temperature_and_exact_zero_error_bound(self):
        rows = partitions()["calT"]
        temperature = fit_temperature(rows)
        self.assertLess(set_nll(rows[0]["rawLogits"], [0, 1], temperature), set_nll(rows[0]["rawLogits"], [0, 1], 1))
        self.assertEqual(metrics(rows, temperature)["top1InAcceptable"], 1)
        self.assertLess(abs(cp_upper(0, 120) - (1 - 0.05 ** (1 / 120))), 1e-14)
        self.assertIsNone(cp_upper(0, 0))
        self.assertEqual(cp_upper(10, 10), 1)
        self.assertGreater(cp_upper(1, 120), cp_upper(0, 120))

    def test_unit_policy_accept_abstain_never_execution(self):
        artifact = build_artifact(partitions(), IDENTITY, evidence_class="unit-test")
        self.assertTrue(artifact["riskProtocolPassed"])
        self.assertFalse(artifact["eligibleForExecution"])
        with tempfile.TemporaryDirectory() as temp:
            path = Path(temp) / "calibration.json"
            write_json(path, artifact)
            loaded = load_calibration(path, expected_artifact_sha=artifact["artifactSha256"], expected_identity=IDENTITY)
            accepted = predict([1., 6., -4., -4.], ["c0", "c1", "c2", "c3"], loaded, identity=IDENTITY)
            abstained = predict([0., 0., 0., 0.], ["c0", "c1", "c2", "c3"], loaded, identity=IDENTITY)
            self.assertEqual(accepted["disposition"], "accept")
            self.assertEqual(accepted["proposedId"], "c1")
            self.assertIsNone(accepted["selectedId"])
            self.assertFalse(accepted["executionAdmitted"])
            self.assertEqual(abstained["disposition"], "abstain")
            self.assertIsNone(abstained["proposedId"])
            with self.assertRaisesRegex(ValueError, "identity mismatch"):
                predict([1., 6., -4., -4.], ["c0", "c1", "c2", "c3"], loaded,
                        identity={**IDENTITY, "memoryPolicyVersion": "changed"})

    def test_declared_statistics_are_recomputed(self):
        artifact = build_artifact(partitions(), IDENTITY, evidence_class="unit-test")
        artifact["temperature"] = 19.0
        artifact.pop("artifactSha256")
        artifact["artifactSha256"] = digest(artifact)
        with self.assertRaisesRegex(ValueError, "recomputed"):
            verify_artifact(artifact)

    def test_split_and_evidence_laundering_rejected(self):
        rows = partitions()
        rows["cert"][0]["sourceGroup"] = rows["calT"][0]["sourceGroup"]
        with self.assertRaisesRegex(ValueError, "crosses"):
            build_artifact(rows, IDENTITY, evidence_class="unit-test")
        rows = partitions()
        rows["select"][0]["evidenceClass"] = "real-model"
        with self.assertRaisesRegex(ValueError, "class drift"):
            build_artifact(rows, IDENTITY, evidence_class="unit-test")

    def test_wrong_cert_fails_without_changing_tau(self):
        rows = partitions()
        for row in rows["cert"][:30]:
            row["rawLogits"] = [-4., -4., 6., 1.]
        artifact = build_artifact(rows, IDENTITY, evidence_class="unit-test")
        self.assertEqual(artifact["tau"], 0.5)
        self.assertEqual(artifact["certificate"]["errors"], 30)
        self.assertFalse(artifact["certificate"]["valid"])
        self.assertFalse(artifact["eligibleForExecution"])

    def test_certificate_dataset_cannot_select_another_policy(self):
        rows = partitions()["cert"]
        with tempfile.TemporaryDirectory() as temp:
            first = cal_cli.claim_certificate(temp, rows, IDENTITY, 0.5, 0.5)
            self.assertEqual(first, cal_cli.claim_certificate(temp, rows, IDENTITY, 0.5, 0.5))
            with self.assertRaisesRegex(ValueError, "already consumed"):
                cal_cli.claim_certificate(temp, rows, IDENTITY, 0.5, 0.9)


if __name__ == "__main__":
    unittest.main()
