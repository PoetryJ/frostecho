#!/usr/bin/env python3
"""R1-C: the actual run_job path consumes canonical measuredCost."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
sys.path.insert(0, str(ROOT / "research/decision-choice/jev03/behavior"))

import runtime as behavior  # noqa: E402


class FakeStore:
    def __init__(self) -> None:
        self._index: dict = {}
        self.finished: dict = {}
        self.payloads: dict = {}
        self.dir = Path(tempfile.mkdtemp())
        self.path = self.dir / "job-1.json"
        self.model_calls = 0

    def job_id(self, key) -> str:
        return "job-1"

    def reserve(self, key) -> None:
        self._index.setdefault("job-1", {})["reserve"] = True

    def begin(self, job_id) -> None:
        self._index[job_id]["begin"] = True

    def commit_result(self, job_id, payload) -> str:
        self.payloads[job_id] = payload
        self.path.write_text(json.dumps(payload), encoding="utf-8")
        return "digest-1"

    def finish(self, job_id, digest, cost) -> None:
        self.finished[job_id] = cost
        self._index[job_id]["finish"] = True

    def result_path(self, job_id: str) -> Path:
        return self.path

    def read_result(self, job_id):
        return self.payloads[job_id]


def canonical_payload(tokens_out: int = 7) -> dict:
    return {"kind": "generation", "rawText": '{"selectedId":"A"}', "newTokens": tokens_out,
            "tokensIn": 123,
            "measuredCost": {"source": "measured", "modelCalls": 1, "tokensIn": 123,
                             "tokensOut": tokens_out, "decodeCalls": tokens_out, "prefillCalls": 1}}


class RunJobCostTest(unittest.TestCase):
    def test_fresh_job_records_measured_cost(self) -> None:
        store = FakeStore()
        payload, meta = behavior.run_job(store, {"k": 1}, lambda: canonical_payload(), lambda raw: raw)
        self.assertEqual(meta["modelCalls"], 1)
        self.assertEqual(store.finished["job-1"]["source"], "measured")
        self.assertEqual(store.finished["job-1"]["tokensOut"], 7)
        self.assertEqual(payload["measuredCost"]["tokensIn"], 123)

    def test_restore_reuses_result_without_model_call(self) -> None:
        store = FakeStore()
        behavior.run_job(store, {"k": 1}, lambda: canonical_payload(), lambda raw: raw)
        second, meta = behavior.run_job(store, {"k": 1},
                                        lambda: self.fail("must not call the model"),
                                        lambda raw: raw)
        self.assertEqual(meta, {"reused": True, "modelCalls": 0})
        self.assertEqual(second["measuredCost"]["tokensOut"], 7)

    def test_invalid_cost_fails_without_finish(self) -> None:
        store = FakeStore()
        payload = canonical_payload()
        payload["measuredCost"] = dict(payload["measuredCost"], tokensOut="seven")
        with self.assertRaises(RuntimeError):
            behavior.run_job(store, {"k": 2}, lambda: payload, lambda raw: raw)
        self.assertNotIn("job-2", store.finished)

    def test_missing_cost_is_unknown_not_zero(self) -> None:
        payload = {"kind": "generation", "rawText": "{}"}
        cost = behavior.measured_cost(payload)
        self.assertEqual(cost["source"], "unknown")
        self.assertNotIn("tokensIn", cost)

    def test_top_level_real_shape_is_measured(self) -> None:
        payload = {"kind": "generation", "tokensIn": 10, "newTokens": 2,
                   "decodeCalls": 2, "prefillCalls": 1}
        cost = behavior.measured_cost(payload)
        self.assertEqual(cost["source"], "measured")
        self.assertEqual(cost["tokensOut"], 2)


if __name__ == "__main__":
    unittest.main()
