#!/usr/bin/env python3
"""Tests for the canonical cost resolver, written from real payload shapes."""
from __future__ import annotations

import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "runtime"))

from cost import resolve_cost  # noqa: E402


def generation_payload() -> dict:
    # exact shape of behavior/run.py::generation_payload (JEV-03R1)
    return {
        "kind": "generation",
        "rawText": '{"selectedId":"A"}',
        "newTokens": 7,
        "tokensIn": 133,
        "renderedSha256": "abc",
        "measuredCost": {"source": "measured", "modelCalls": 1, "tokensIn": 133,
                         "tokensOut": 7, "decodeCalls": 7, "prefillCalls": 1},
        "timing": {"e2eMs": 1041.2},
    }


def feature_payload() -> dict:
    return {
        "kind": "feature", "candShape": [4, 64], "hqShape": [1, 64],
        "tokensIn": 114,
        "measuredCost": {"source": "measured", "modelCalls": 1, "tokensIn": 114,
                         "tokensOut": 0, "decodeCalls": 0, "prefillCalls": 1},
    }


class CanonicalCostTest(unittest.TestCase):
    def test_generation_payload_uses_canonical_field(self) -> None:
        cost = resolve_cost(generation_payload())
        self.assertEqual(cost["source"], "measured")
        self.assertEqual(cost["tokensIn"], 133)
        self.assertEqual(cost["tokensOut"], 7)
        self.assertEqual(cost["costBasis"], "payload.measuredCost")

    def test_feature_payload_uses_canonical_field(self) -> None:
        cost = resolve_cost(feature_payload())
        self.assertEqual(cost["source"], "measured")
        self.assertEqual(cost["tokensOut"], 0)
        self.assertEqual(cost["prefillCalls"], 1)

    def test_legacy_payload_without_canonical_but_with_newtokens(self) -> None:
        payload = {"kind": "generation", "tokensIn": 100, "newTokens": 5,
                   "decodeCalls": 5, "prefillCalls": 1}
        cost = resolve_cost(payload)
        self.assertEqual(cost["source"], "measured")
        self.assertEqual(cost["tokensOut"], 5)
        self.assertEqual(cost["costBasis"], "top-level")

    def test_missing_counts_is_unknown_not_zero(self) -> None:
        cost = resolve_cost({"kind": "generation"})
        self.assertEqual(cost["source"], "unknown")
        self.assertNotIn("tokensIn", cost)

    def test_nan_is_invalid(self) -> None:
        payload = generation_payload()
        payload["measuredCost"] = dict(payload["measuredCost"], tokensIn=float("nan"))
        cost = resolve_cost(payload)
        self.assertEqual(cost["source"], "invalid")
        self.assertIn("tokensIn", cost["reason"])

    def test_negative_is_invalid(self) -> None:
        payload = generation_payload()
        payload["measuredCost"] = dict(payload["measuredCost"], decodeCalls=-1)
        self.assertEqual(resolve_cost(payload)["source"], "invalid")

    def test_bool_is_not_an_integer(self) -> None:
        payload = generation_payload()
        payload["measuredCost"] = dict(payload["measuredCost"], tokensOut=True)
        self.assertEqual(resolve_cost(payload)["source"], "invalid")

    def test_missing_key_is_invalid(self) -> None:
        payload = generation_payload()
        del payload["measuredCost"]["decodeCalls"]
        cost = resolve_cost(payload)
        self.assertEqual(cost["source"], "invalid")
        self.assertIn("decodeCalls", cost["reason"])

    def test_unknown_source_is_invalid(self) -> None:
        payload = generation_payload()
        payload["measuredCost"] = dict(payload["measuredCost"], source="recovered")
        self.assertEqual(resolve_cost(payload)["source"], "invalid")

    def test_zero_model_calls_is_invalid(self) -> None:
        payload = generation_payload()
        payload["measuredCost"] = dict(payload["measuredCost"], modelCalls=0)
        self.assertEqual(resolve_cost(payload)["source"], "invalid")


if __name__ == "__main__":
    unittest.main()
