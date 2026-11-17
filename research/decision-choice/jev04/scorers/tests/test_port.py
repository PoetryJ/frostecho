"""R2 scorer-port acceptance: legal fake artifact positive path + fail-closed negatives."""
import math
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "scorers"))
sys.path.insert(0, str(ROOT / "calibration"))

from calibration import CalibrationArtifact, PolicyIdentity, ScorerInputError, decide as decide_calibration
from port import (IdentityError, ScorerArtifact, ScorerIdentity, ScorerRequest,
                  decide, load_artifact, save_artifact)


def identity(overrides=None):
    values = dict(model="fake-qwen", head="choice", adapter="none",
                  tokenizer="tok/1", renderer="renderer/1", task="choose_action",
                  k=4, policy_version="policy/1", memory_policy_version="memory/1")
    values.update(overrides or {})
    return ScorerIdentity(**values)


def artifact(mode="fixture"):
    return ScorerArtifact(schema="frostecho.jev04.scorer-artifact/1",
                          identity=identity(), mode=mode, temperature=1.0, tau=0.5,
                          coverage=0.4, upper=0.04)


class PositivePath(unittest.TestCase):
    def test_legal_fake_artifact_full_chain(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "artifact.json")
            save_artifact(path, artifact())
            loaded = load_artifact(path, identity())
            request = ScorerRequest(request_id="r1", identity=identity(),
                                    candidate_ids=["a", "b", "c", "d"],
                                    raw_logits=[3.0, 1.0, 0.5, 0.1])
            output = decide(loaded, request)
            self.assertEqual(len(output.raw_logits), 4)
            self.assertEqual(len(output.softmax_probabilities), 4)
            self.assertEqual(len(output.temperature_probabilities), 4)
            self.assertEqual(len(output.utility), 4)
            self.assertAlmostEqual(sum(output.softmax_probabilities), 1.0, places=9)
            self.assertEqual(output.selected_index, 0)
            self.assertEqual(output.disposition, "accept")
            self.assertEqual(output.mode, "fixture")

    def test_abstain_below_tau(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "artifact.json")
            save_artifact(path, artifact())
            loaded = load_artifact(path, identity())
            request = ScorerRequest(request_id="r2", identity=identity(),
                                    candidate_ids=["a", "b", "c", "d"],
                                    raw_logits=[0.0, 0.0, 0.0, 0.0])
            output = decide(loaded, request)
            self.assertEqual(output.disposition, "abstain")
            self.assertIsNone(output.selected_index)


class FailClosed(unittest.TestCase):
    def _loaded(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "artifact.json")
            save_artifact(path, artifact())
            return load_artifact(path, identity())

    def test_k4_two_logits_refused(self):
        loaded = self._loaded()
        request = ScorerRequest(request_id="r3", identity=identity(),
                                candidate_ids=["a", "b", "c", "d"], raw_logits=[10.0, 0.0])
        with self.assertRaises(ScorerInputError):
            decide(loaded, request)

    def test_nan_refused(self):
        loaded = self._loaded()
        request = ScorerRequest(request_id="r4", identity=identity(),
                                candidate_ids=["a", "b", "c", "d"],
                                raw_logits=[float("nan"), 0.0, 0.0, 0.0])
        with self.assertRaises(ScorerInputError):
            decide(loaded, request)

    def test_infinity_refused(self):
        loaded = self._loaded()
        request = ScorerRequest(request_id="r5", identity=identity(),
                                candidate_ids=["a", "b", "c", "d"],
                                raw_logits=[float("inf"), 0.0, 0.0, 0.0])
        with self.assertRaises(ScorerInputError):
            decide(loaded, request)

    def test_identity_drift_refused(self):
        loaded = self._loaded()
        drifted = identity({"tokenizer": "tok/2"})
        request = ScorerRequest(request_id="r6", identity=drifted,
                                candidate_ids=["a", "b", "c", "d"],
                                raw_logits=[1.0, 0.0, 0.0, 0.0])
        with self.assertRaises(IdentityError):
            decide(loaded, request)

    def test_load_with_drifted_request_identity_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "artifact.json")
            save_artifact(path, artifact())
            with self.assertRaises(IdentityError):
                load_artifact(path, identity({"renderer": "renderer/2"}))

    def test_unknown_policy_k_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = str(Path(tmp) / "artifact.json")
            bad = ScorerArtifact(schema="frostecho.jev04.scorer-artifact/1",
                                 identity=identity({"k": 3}), mode="fixture",
                                 temperature=1.0, tau=0.5, coverage=0.4, upper=0.04)
            save_artifact(path, bad)
            with self.assertRaises(IdentityError):
                load_artifact(path, identity({"k": 3}))

    def test_candidate_count_mismatch_refused(self):
        loaded = self._loaded()
        request = ScorerRequest(request_id="r7", identity=identity(),
                                candidate_ids=["a", "b", "c"], raw_logits=[1.0, 0.0, 0.0, 0.0])
        with self.assertRaises(ScorerInputError):
            decide(loaded, request)


class CalibrationBoundary(unittest.TestCase):
    """The baseline cost-recovery repro (K=4 accepting 2 logits / NaN) must fail."""

    def _artifact(self):
        policy = PolicyIdentity(model="fake", head="head", tokenizer="none",
                                renderer="renderer", task="choose_action", k=4,
                                memory_policy_version="memory/1")
        return CalibrationArtifact(schema="frostecho.jev04.calibration-artifact/1",
                                   policy=policy, temperature=1, tau=0.5, valid=True,
                                   coverage=0.4, upper=0.04)

    def test_two_logits_refused(self):
        with self.assertRaises(ScorerInputError):
            decide_calibration(self._artifact(), [10.0, 0.0])

    def test_nan_logit_refused(self):
        with self.assertRaises(ScorerInputError):
            decide_calibration(self._artifact(), [float("nan"), 0.0, 0.0, 0.0])

    def test_finite_four_logits_reports_all_layers(self):
        value = decide_calibration(self._artifact(), [3.0, 1.0, 0.5, 0.1])
        self.assertEqual(len(value["rawLogits"]), 4)
        self.assertEqual(len(value["softmaxProbabilities"]), 4)
        self.assertEqual(len(value["temperatureProbabilities"]), 4)
        self.assertEqual(len(value["utility"]), 4)
        self.assertEqual(value["disposition"], "accept")

    def test_infinite_logit_refused(self):
        with self.assertRaises(ScorerInputError):
            decide_calibration(self._artifact(), [float("inf"), 0.0, 0.0, 0.0])


if __name__ == "__main__":
    unittest.main()
