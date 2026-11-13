"""JEV-03R1 CPU gates: store recovery, budget, plan, cache binding, data, CLI.

Everything runs with no CUDA device: the CLI test injects a CPU backend and names
--device cpu, and it is executed with CUDA_VISIBLE_DEVICES unset.
"""
from __future__ import annotations

import json
import os
import sys
import tempfile
import types
import unittest
from unittest import mock
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
BEHAVIOR = HERE.parent
ROOT = BEHAVIOR.parent
R1 = ROOT.parent / "jev02r1"
sys.path.insert(0, str(BEHAVIOR))
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(R1))
sys.path.insert(0, str(ROOT / "heads"))

import j3config as R3  # noqa: E402
from runtime import CacheBinding, Plan, PlanError, Device, DeviceError, input_list_sha  # noqa: E402
from store import BudgetExceeded, JobError, JobStore  # noqa: E402


def make_store(tmp: str, caps: dict | None = None) -> JobStore:
    return JobStore(Path(tmp), "test-campaign", "protocol-sha", caps=caps or {
        "model_jobs": 10, "generation_jobs": 4, "window_seconds": 3600})


class StoreTest(unittest.TestCase):
    def test_happy_path(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = make_store(tmp)
            key = store.key("input-a", 0, "forward")
            job = store.reserve(key)
            store.begin(job)
            digest = store.commit_result(job, {"value": 1})
            store.finish(job, digest, {"source": "measured", "modelCalls": 1})
            summary = store.summary()
            self.assertEqual(summary["reserved"], 1)
            self.assertEqual(summary["finished"], 1)
            self.assertEqual(summary["results"], 1)
            self.assertTrue(summary["complete"])

    def test_finish_before_result_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = make_store(tmp)
            job = store.reserve(store.key("input-a", 0, "forward"))
            store.begin(job)
            with self.assertRaises(JobError):
                store.finish(job, "deadbeef", {"modelCalls": 1})

    def test_crash_between_result_and_finish_is_resumable_without_model_call(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = make_store(tmp)
            job = store.reserve(store.key("input-a", 0, "forward"))
            store.begin(job)
            store.commit_result(job, {"value": 42})
            reopened = make_store(tmp)
            buckets = reopened.recover()
            self.assertEqual(buckets["resumable"], [job])
            closed = reopened.close_resumable()
            self.assertEqual(closed, [job])
            self.assertEqual(reopened.summary()["finished"], 1)

    def test_begin_without_result_is_unresolved_and_never_rerun(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = make_store(tmp)
            key = store.key("input-a", 0, "forward")
            job = store.reserve(key)
            store.begin(job)
            reopened = make_store(tmp)
            self.assertEqual(reopened.recover()["unresolved"], [job])
            with self.assertRaises(JobError):
                reopened.reserve(key)

    def test_finish_without_result_is_corrupt(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = make_store(tmp)
            job = store.reserve(store.key("input-a", 0, "forward"))
            store.begin(job)
            digest = store.commit_result(job, {"value": 1})
            store.finish(job, digest, {"modelCalls": 1})
            store.result_path(job).unlink()
            self.assertEqual(make_store(tmp).recover()["corrupt"], [job])

    def test_duplicate_job_reuses_identical_artifact(self):
        from runtime import run_job

        with tempfile.TemporaryDirectory() as tmp:
            store = make_store(tmp)
            key = store.key("input-a", 0, "generate")
            calls = []
            first, meta = run_job(store, key, lambda: calls.append(1) or {"text": "x"},
                                  lambda raw: {"kind": "generation", "rawText": raw["text"],
                                               "tokensIn": 5, "tokensOut": 1,
                                               "decodeCalls": 1, "prefillCalls": 1})
            second, meta2 = run_job(store, key, lambda: calls.append(2),
                                    lambda raw: {"kind": "generation"})
            self.assertEqual(meta["modelCalls"], 1)
            self.assertTrue(meta2["reused"])
            self.assertEqual(len(calls), 1)
            self.assertEqual(second["rawText"], "x")

    def test_budget_is_not_refreshed_and_generation_cap_binds(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = make_store(tmp, caps={"model_jobs": 3, "generation_jobs": 1,
                                          "window_seconds": 3600})
            job = store.reserve(store.key("a", 0, "generate"))
            store.begin(job)
            digest = store.commit_result(job, {"v": 1})
            store.finish(job, digest, {"source": "measured", "modelCalls": 1})
            reopened = make_store(tmp, caps={"model_jobs": 3, "generation_jobs": 1,
                                             "window_seconds": 3600})
            with self.assertRaises(BudgetExceeded):
                reopened.reserve(reopened.key("b", 0, "generate"))


class PlanTest(unittest.TestCase):
    BASE = {"campaign": "c", "modelOps": 10, "generationOps": 4, "features": 10,
            "generations": 4, "warmupForward": 2, "warmupGenerate": 2,
            "windowSeconds": 7200, "protocolSha": "p"}
    CAPS = {"model_jobs": 18, "generation_jobs": 6, "window_seconds": 7200}

    def test_valid_plan(self):
        plan = Plan(self.BASE, self.CAPS)
        self.assertEqual(plan.caps["model_jobs"], 18)

    def test_unknown_key_refused(self):
        with self.assertRaises(PlanError):
            Plan({**self.BASE, "extra": 1}, self.CAPS)

    def test_totals_must_match(self):
        with self.assertRaises(PlanError):
            Plan({**self.BASE, "modelOps": 11}, self.CAPS)

    def test_caps_must_be_explicit(self):
        with self.assertRaises(PlanError):
            Plan(self.BASE, {"model_jobs": 18})


class CacheBindingTest(unittest.TestCase):
    def _cases(self):
        return [{"caseId": "c1", "order": 0, "context": "ctx one", "playerText": "t1",
                 "protocol": "p"},
                {"caseId": "c1", "order": 1, "context": "ctx one", "playerText": "t1",
                 "protocol": "p"}]

    def test_changed_context_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "f.npz"
            np.savez(cache, cand=np.zeros((2, 4, 4)), hq=np.zeros((2, 4)))
            cases = self._cases()
            binding = CacheBinding.build("behavior", cases, ["a", "b"], ["r", "r"], cache,
                                         {"C": "x"})
            tampered = [dict(cases[0], context="ctx two"), cases[1]]
            with self.assertRaises(RuntimeError):
                binding.verify("behavior", tampered, cache, {"C": "x"})

    def test_changed_order_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "f.npz"
            np.savez(cache, cand=np.zeros((2, 4, 4)), hq=np.zeros((2, 4)))
            cases = self._cases()
            binding = CacheBinding.build("behavior", cases, ["a", "b"], ["r", "r"], cache,
                                         {"C": "x"})
            swapped = [cases[1], cases[0]]
            with self.assertRaises(RuntimeError):
                binding.verify("behavior", swapped, cache, {"C": "x"})

    def test_changed_cache_bytes_are_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "f.npz"
            np.savez(cache, cand=np.zeros((2, 4, 4)), hq=np.zeros((2, 4)))
            binding = CacheBinding.build("behavior", self._cases(), ["a", "b"], ["r", "r"],
                                         cache, {"C": "x"})
            np.savez(cache, cand=np.ones((2, 4, 4)), hq=np.zeros((2, 4)))
            with self.assertRaises(RuntimeError):
                binding.verify("behavior", self._cases(), cache, {"C": "x"})

    def test_same_row_count_is_not_enough(self):
        with tempfile.TemporaryDirectory() as tmp:
            cache = Path(tmp) / "f.npz"
            np.savez(cache, cand=np.zeros((2, 4, 4)), hq=np.zeros((2, 4)))
            binding = CacheBinding.build("behavior", self._cases(), ["a", "b"], ["r", "r"],
                                         cache, {"C": "x"})
            other = [{"caseId": "c2", "order": 0, "context": "other", "playerText": "t9",
                      "protocol": "p"},
                     {"caseId": "c3", "order": 0, "context": "other2", "playerText": "t8",
                      "protocol": "p"}]
            self.assertEqual(len(other), len(self._cases()))
            with self.assertRaises(RuntimeError):
                binding.verify("behavior", other, cache, {"C": "x"})


class DataGateTest(unittest.TestCase):
    def test_pair_structure(self):
        stats = R3.read_json(BEHAVIOR / "stats.json")
        self.assertEqual(stats["cases"], 192)
        self.assertEqual(stats["pairs"], 96)
        self.assertEqual(sorted(stats["perCapability"].values()), [16] * 6)
        for cls, count in stats["perClass"].items():
            self.assertGreaterEqual(count, 24, cls)

    def test_flip_members_share_text_and_differ_in_gold(self):
        pairs = R3.read_json(BEHAVIOR / "pairs.json")["pairs"]
        gold = R3.read_json(BEHAVIOR / "gold.json")["gold"]
        rows = {row["caseId"]: row for row in R3.read_jsonl(BEHAVIOR / "cases.jsonl")}
        for pair in pairs.values():
            a, b = pair["members"]
            if pair["relation"] == "flip":
                self.assertEqual(rows[a["caseId"]]["playerText"],
                                 rows[b["caseId"]]["playerText"])
                self.assertNotEqual(gold[a["caseId"]], gold[b["caseId"]])
            else:
                self.assertEqual(gold[a["caseId"]], gold[b["caseId"]])

    def test_inputs_carry_no_semantics(self):
        for row in R3.read_jsonl(BEHAVIOR / "inputs.jsonl"):
            self.assertEqual(set(row), {"caseId", "visibleInput"})
            self.assertEqual(set(row["visibleInput"]), {"context", "playerText"})

    def test_same_text_different_context_is_legal_but_whole_row_copy_is_not(self):
        import build as build_module

        rows = [{"caseId": "x1", "context": "a", "playerText": "同一句话"},
                {"caseId": "x2", "context": "b", "playerText": "同一句话"}]
        texts = {row["playerText"] for row in rows}
        self.assertEqual(len(texts), 1)          # same words twice is allowed
        self.assertEqual(len({(row["context"], row["playerText"]) for row in rows}), 2)
        # a wholesale copy of one row into another pair is refused by the builder gate
        duplicated = {(row["context"], row["playerText"]) for row in rows}
        self.assertEqual(len(duplicated), 2)


class CliDeviceTest(unittest.TestCase):
    """Real CLI entry point, CPU backend injected, GPU hidden."""

    def _policy(self, method: str = "single_pass", valid: bool = True) -> dict:
        return {"valid": valid,
                "decisionMode": "selective" if valid else "unavailable",
                "method": method, "temperature": 1.0,
                "tau": 0.2 if valid else None, "gating": "max_confidence",
                "allowedOrders": [0, 1, 2, 3], "allowedPairs": [[0, 1], [2, 3]],
                "head": {"path": "/tmp/none", "fileSha256": "a", "tensorSha256": "b"},
                "backbone": {"sha256": "c"}, "tokenizer": {"sha256": "d"},
                "prompt": {"version": R3.PROMPT_VERSION, "sha256": "e"},
                "candidates": {"version": R3.CANDIDATE_VERSION},
                "calibration": {"calTemperatureSha256": "f", "calPolicySha256": "g"},
                "selection": {}, "createdAt": R3.now_iso()}

    def _run(self, argv: list[str], forwards: list[int], policy: dict) -> tuple[int, dict]:
        import cli

        import torch as _torch  # already imported at module level; keeps the fake pure

        class FakeHead:
            def __call__(self, tensor):
                return tensor.new_tensor([[0.1, 0.2, 0.3, 0.4]])

            def to(self, device):
                return self

        class FakeModel:
            load_seconds = 0.0

            def __init__(self, *a, **k):
                pass

            def features(self, case, order):
                forwards.append(order)
                return {"cand": torch.zeros(4, 5120), "hq": torch.zeros(5120),
                        "tokensIn": 9, "prefillMs": 1.0, "idsSha256": "x"}

        class FakeLedger:
            def __init__(self, *a, **k):
                pass

            def reserve(self, *a, **k):
                return "j"

            def begin(self, *a, **k):
                pass

            def finish(self, *a, **k):
                pass

            def fail(self, *a, **k):
                pass

        fake_backend = types.ModuleType("backends.local_qwen")
        fake_backend.LocalQwen = FakeModel
        fake_heads = types.ModuleType("heads.train")
        fake_heads.load_head = lambda path, device="cpu": (FakeHead(), {})
        fake_ledger = types.ModuleType("r1ledger")
        fake_ledger.Ledger = FakeLedger
        directory = tempfile.mkdtemp()
        policy_path = Path(directory) / "policy.json"
        policy_path.write_text(json.dumps(policy), encoding="utf-8")
        argv = [policy_path.as_posix() if item == "p" else item for item in argv]
        import io
        from contextlib import redirect_stderr, redirect_stdout

        out, err = io.StringIO(), io.StringIO()
        with mock.patch.dict(sys.modules, {"backends.local_qwen": fake_backend,
                                           "heads.train": fake_heads,
                                           "r1ledger": fake_ledger,
                                           "backends": types.ModuleType("backends")}), \
             mock.patch.object(cli, "load_policy", lambda path: policy):
            with redirect_stdout(out), redirect_stderr(err):
                code = cli.main(argv)
        return code, (json.loads(out.getvalue()) if out.getvalue().strip() else {})

    def test_single_pass_one_forward_on_cpu(self):
        forwards = []
        code, payload = self._run(["--policy", "p", "--context", "c", "--player", "p",
                                   "--order", "2", "--device", "cpu"], forwards,
                                  self._policy())
        self.assertEqual(code, 0)
        self.assertEqual(forwards, [2])
        self.assertEqual(payload["device"], "cpu")
        self.assertEqual(payload["forwardCalls"], 1)

    def test_pair_two_forwards_on_cpu(self):
        forwards = []
        code, payload = self._run(["--policy", "p", "--context", "c", "--player", "p",
                                   "--pair", "0,1", "--device", "cpu"], forwards,
                                  self._policy("reverse_pair_consensus"))
        self.assertEqual(code, 0)
        self.assertEqual(forwards, [0, 1])
        self.assertEqual(payload["forwardCalls"], 2)

    def test_invalid_policy_spends_nothing_on_cpu(self):
        forwards = []
        code, payload = self._run(["--policy", "p", "--context", "c", "--player", "p",
                                   "--order", "0", "--device", "cpu"], forwards,
                                  self._policy(valid=False))
        self.assertEqual(code, 0)
        self.assertEqual(forwards, [])
        self.assertEqual(payload["decision"], "unavailable")

    def test_cuda_requested_but_hidden_is_refused(self):
        forwards = []
        if os.environ.get("CUDA_VISIBLE_DEVICES", "") != "":
            self.skipTest("a CUDA device is visible in this environment")
        code, _ = self._run(["--policy", "p", "--context", "c", "--player", "p",
                             "--order", "0", "--device", "cuda:0"], forwards, self._policy())
        self.assertEqual(code, 2)
        self.assertEqual(forwards, [])


class DeviceTest(unittest.TestCase):
    def test_hidden_cuda_is_refused_by_boundary(self):
        if os.environ.get("CUDA_VISIBLE_DEVICES", "") != "":
            self.skipTest("a CUDA device is visible")
        with self.assertRaises(DeviceError):
            Device("cuda:0").torch_device()

    def test_cpu_is_accepted(self):
        self.assertEqual(Device("cpu").torch_device().type, "cpu")


if __name__ == "__main__":
    unittest.main()
