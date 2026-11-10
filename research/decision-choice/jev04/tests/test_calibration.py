#!/usr/bin/env python3
from __future__ import annotations

import math
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "calibration"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))

from calibration import (  # noqa: E402
    Certificate,
    PolicyIdentity,
    assert_policy_compatible,
    certify,
    cp_upper,
    fit_temperature,
    select_policy,
    softmax,
)


def policy(**overrides) -> PolicyIdentity:
    base = dict(model="qwen27b", head="ln-scalar", tokenizer="t27", renderer="jev04",
                task="choose_action", k=4, memory_policy_version="memory-policy/1")
    base.update(overrides)
    return PolicyIdentity(**base)


class SoftmaxTest(unittest.TestCase):
    def test_empty_set_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            softmax([])

    def test_probabilities_sum_to_one(self) -> None:
        probabilities = softmax([2.0, 1.0, 0.0, -1.0])
        self.assertAlmostEqual(sum(probabilities), 1.0, places=12)


class TemperatureTest(unittest.TestCase):
    def test_fitted_temperature_minimises_nll_on_labelled_data(self) -> None:
        # Separable data drives T to zero without bound, so use label noise.
        row = [1.2, -0.4, 0.1, -0.9]
        rows = [list(row) for _ in range(100)]
        labels = [0] * 80 + [3] * 20
        fitted = fit_temperature(rows, labels)
        self.assertGreater(fitted, 0.0)
        self.assertLess(fitted, 20.0)

        def mean_nll(temperature: float) -> float:
            from calibration import nll
            return sum(nll(row, label, temperature) for row, label in zip(rows, labels)) / len(rows)

        self.assertLessEqual(mean_nll(fitted), mean_nll(1.0) + 1e-9)
        self.assertLessEqual(mean_nll(fitted), mean_nll(3.0) + 1e-9)


class ClopperPearsonTest(unittest.TestCase):
    def test_zero_of_hundred_matches_published_fixture(self) -> None:
        self.assertAlmostEqual(cp_upper(0, 100), 1 - 0.05 ** (1 / 100), places=9)

    def test_all_errors_is_one(self) -> None:
        self.assertEqual(cp_upper(100, 100), 1.0)

    def test_empty_is_none(self) -> None:
        self.assertIsNone(cp_upper(0, 0))

    def test_matches_scipy_oracle(self) -> None:
        try:
            from scipy.stats import beta  # type: ignore
        except Exception:  # pragma: no cover - scipy may be absent
            self.skipTest("scipy not installed")
        for errors, n in ((3, 120), (7, 400), (0, 50)):
            oracle = 1.0 if errors == n else beta.ppf(0.95, errors + 1, n - errors)
            self.assertAlmostEqual(cp_upper(errors, n), oracle, places=6)


class SelectionTest(unittest.TestCase):
    def test_picks_max_coverage_under_risk(self) -> None:
        probabilities = [0.95] * 200 + [0.2] * 200
        correct = [True] * 196 + [False] * 4 + [True] * 80 + [False] * 120
        selection = select_policy(probabilities, correct)
        self.assertTrue(selection.valid)
        self.assertGreaterEqual(selection.accepted, 100)
        self.assertLessEqual(selection.risk, 0.05)

    def test_all_wrong_has_no_valid_point(self) -> None:
        selection = select_policy([0.99] * 200, [False] * 200)
        self.assertFalse(selection.valid)
        self.assertIsNone(selection.tau)


class CertificateTest(unittest.TestCase):
    def test_coverage_below_minimum_is_refused(self) -> None:
        certificate = certify(policy(), [0.99] * 10 + [0.1] * 90, [True] * 10 + [True] * 90, 0.9)
        self.assertIsInstance(certificate, Certificate)
        self.assertFalse(certificate.valid)
        self.assertIn("coverage", certificate.reason)

    def test_incomplete_evidence_cannot_certify(self) -> None:
        certificate = certify(policy(), [0.99] * 200, [True] * 200, 0.9, evidence_complete=False)
        self.assertFalse(certificate.valid)

    def test_perfect_evidence_certifies(self) -> None:
        certificate = certify(policy(), [0.99] * 200, [True] * 200, 0.9)
        self.assertTrue(certificate.valid)
        self.assertLess(certificate.upper, 0.05)

    def test_policy_identity_mismatch_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            assert_policy_compatible(policy(), policy(memory_policy_version="memory-policy/2"))
        with self.assertRaises(ValueError):
            assert_policy_compatible(policy(k=8), policy(k=8, task="interpret_request"))
        with self.assertRaises(ValueError):
            assert_policy_compatible(policy(k=3), policy(k=3))


if __name__ == "__main__":
    unittest.main()
