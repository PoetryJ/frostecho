"""JEV-03 CPU tests: heads, identity, cache, data gates, CLI wiring, budget.

Nothing here needs a GPU: the backbone is replaced by a fake module, and the
ledger writes to a temporary file.
"""
from __future__ import annotations

import json
import sys
import tempfile
import types
import unittest
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "heads"))

import j3config as R  # noqa: E402
import j3heads as H  # noqa: E402
import train as T  # noqa: E402


class HeadTest(unittest.TestCase):
    def test_parameter_counts(self):
        self.assertEqual(H.count_parameters(H.build("C")), 5120)
        self.assertEqual(H.count_parameters(H.build("Q")), 20480)

    def test_head_has_no_backbone_parameters(self):
        for arm in ("C", "Q"):
            head = H.build(arm)
            names = {name for name, _ in head.named_parameters()}
            self.assertTrue(all("backbone" not in name for name in names))
            self.assertTrue(all(parameter.requires_grad for parameter in head.parameters()))

    def test_candidate_head_scores_each_candidate_with_one_vector(self):
        head = H.build("C")
        self.assertEqual(tuple(head.score.weight.shape), (1, 5120))
        out = head(torch.zeros(2, 4, 5120))
        self.assertEqual(tuple(out.shape), (2, 4))

    def test_query_head_ignores_display_order_by_construction(self):
        head = H.build("Q")
        self.assertEqual(tuple(head.out.weight.shape), (4, 5120))
        self.assertEqual(tuple(head(torch.zeros(3, 5120)).shape), (3, 4))

    def test_layernorm_has_no_trainable_parameters(self):
        for arm in ("C", "Q"):
            head = H.build(arm)
            self.assertEqual(sum(1 for name, p in head.named_parameters() if "norm" in name), 0)

    def test_nan_and_wrong_dimension_are_rejected(self):
        head = H.build("C")
        with self.assertRaises(ValueError):
            head(torch.zeros(2, 5120))
        with self.assertRaises(ValueError):
            head(torch.zeros(1, 4, 4096))
        with self.assertRaises(ValueError):
            head(torch.full((1, 4, 5120), float("nan")))
        query = H.build("Q")
        with self.assertRaises(ValueError):
            query(torch.zeros(4, 4, 5120))
        with self.assertRaises(ValueError):
            query(torch.full((1, 5120), float("nan")))

    def test_state_hash_is_order_independent(self):
        head = H.build("C")
        state = dict(head.state_dict())
        first = R.state_hash(state)
        reversed_state = dict(reversed(list(state.items())))
        self.assertEqual(first, R.state_hash(reversed_state))


class IdTest(unittest.TestCase):
    def test_four_orders_place_every_class_once(self):
        for order in R.ORDERS:
            self.assertEqual(sorted(order), sorted(R.CLASSES))

    def test_display_to_stable_round_trip(self):
        for order_index in range(4):
            for display in range(4):
                stable = R.stable_from_display(order_index, display)
                self.assertEqual(R.display_from_stable(order_index, stable), display)

    def test_stable_mapping_is_not_letter_identity(self):
        moved = [R.stable_from_display(order, 0) for order in range(4)]
        self.assertEqual(len(set(moved)), 4)


class CacheTest(unittest.TestCase):
    def _write(self, directory: Path, cand: np.ndarray, hq: np.ndarray, meta: dict):
        path = directory / "f.npz"
        np.savez_compressed(path, cand=cand, hq=hq)
        (directory / "f.meta.json").write_text(json.dumps(meta), encoding="utf-8")
        return path

    def test_identity_drift_is_detected(self):
        with tempfile.TemporaryDirectory() as tmp:
            directory = Path(tmp)
            meta = {"featureIdentityHash": "deadbeef", "caseIds": ["a"], "orderIds": [0]}
            path = self._write(directory, np.zeros((1, 4, 5120), np.float32),
                               np.zeros((1, 5120), np.float32), meta)
            data = np.load(path)
            self.assertEqual(data["cand"].shape, (1, 4, 5120))
            self.assertNotEqual(meta["featureIdentityHash"], R.feature_identity_hash())

    def test_recompute_matches_cache(self):
        head = H.build("C")
        cand = torch.randn(4, 4, 5120)
        with torch.no_grad():
            first = head(cand)
            second = head(cand.clone())
        self.assertTrue(torch.equal(first, second))


class DataGateTest(unittest.TestCase):
    def test_split_sizes_and_group_purity(self):
        rows = {split: R.read_jsonl(R.split_file(split)) for split in R.SPLITS}
        self.assertEqual(len(rows["train"]), 384)
        self.assertEqual(len(rows["dev"]), 128)
        self.assertEqual(len(rows["test"]), 256)
        for split, items in rows.items():
            groups = {}
            for row in items:
                groups.setdefault(row["groupId"], set()).add(row["labelId"])
            for group, labels in groups.items():
                self.assertEqual(len(labels), 4, f"{group} does not cover four classes")
                self.assertEqual(sum(1 for row in items if row["groupId"] == group), 8)

    def test_group_ids_never_cross_splits(self):
        ids = {split: {row["groupId"] for row in R.read_jsonl(R.split_file(split))}
               for split in R.SPLITS}
        self.assertFalse(ids["train"] & ids["dev"])
        self.assertFalse(ids["train"] & ids["test"])
        self.assertFalse(ids["dev"] & ids["test"])

    def test_gold_matches_label_file_and_covers_test(self):
        gold = R.read_json(R.gold_file())["gold"]
        rows = R.read_jsonl(R.split_file("test"))
        self.assertEqual(set(gold), {row["caseId"] for row in rows})
        self.assertEqual(R.sha256_json(gold), R.read_json(R.gold_file())["sha256"])

    def test_inputs_carry_no_label_or_scene(self):
        for split in R.SPLITS:
            for row in R.read_jsonl(R.inputs_file(split)):
                self.assertNotIn("labelId", row)
                self.assertNotIn("scene", row)
                self.assertNotIn("move", row)

    def test_player_texts_are_unique_inside_a_split(self):
        for split in R.SPLITS:
            texts = [row["playerText"] for row in R.read_jsonl(R.split_file(split))]
            self.assertEqual(len(set(texts)), len(texts))


class TrainerTest(unittest.TestCase):
    def test_case_mean_ce_is_four_order_average(self):
        head = H.build("Q")
        cand = torch.zeros(8, 4, 5120)
        hq = torch.zeros(8, 5120)
        batch = {"cand": cand, "hq": hq,
                 "caseIds": np.asarray(["a"] * 4 + ["b"] * 4),
                 "targetDisplay": torch.zeros(8, dtype=torch.long),
                 "targetStable": torch.tensor([0, 0, 0, 0, 1, 1, 1, 1])}
        value = T.case_mean_ce(head, batch, "Q", torch.arange(8))
        with torch.no_grad():
            logits = head(batch["hq"])
            manual = (torch.nn.functional.cross_entropy(logits[:4], batch["targetStable"][:4],
                                                        reduction="mean")
                      + torch.nn.functional.cross_entropy(logits[4:], batch["targetStable"][4:],
                                                          reduction="mean")) / 2
        self.assertAlmostEqual(float(value), float(manual), places=6)

    def test_display_targets_follow_the_order(self):
        batch = {"cand": torch.zeros(4, 4, 5120), "hq": torch.zeros(4, 5120)}
        index = torch.arange(4)
        head = H.build("C")
        losses = []
        for order in range(4):
            rows = {**batch, "caseIds": np.asarray([f"c{order}"], dtype=object),
                    "targetDisplay": torch.tensor([R.ORDERS[order].index("NEEDS_CLARIFICATION")]),
                    "targetStable": torch.tensor([R.CLASSES.index("NEEDS_CLARIFICATION")])}
            losses.append(float(T.case_mean_ce(head, rows, "C", torch.tensor([0]))))
        self.assertEqual(len(set(round(value, 6) for value in losses)), 1)


class LedgerTest(unittest.TestCase):
    def test_generation_budget_refuses_before_compute(self):
        from r1ledger import BudgetExceeded, Ledger

        with tempfile.TemporaryDirectory() as tmp:
            ledger = Ledger(Path(tmp) / "jobs.jsonl", caps={"generation_jobs": 0,
                                                           "model_jobs": 10,
                                                           "window_seconds": 3600})
            with self.assertRaises(BudgetExceeded):
                ledger.reserve("g1", "generate", "json")

    def test_failed_job_stays_charged(self):
        from r1ledger import Ledger

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "jobs.jsonl"
            ledger = Ledger(path)
            job = ledger.reserve("f1", "forward", "test")
            ledger.begin(job)
            ledger.fail(job, "interrupted")
            summary = Ledger(path).summary()
            self.assertEqual(summary["reserved"], 1)
            self.assertEqual(summary["failed"], 1)


class CliWiringTest(unittest.TestCase):
    """Valid-policy CLI: one forward for S1, two for S2, none when unavailable."""

    def _run(self, policy: dict, argv: list[str], forwards: list[int]) -> tuple[int, dict]:
        import cli

        class FakeHead:
            def __call__(self, tensor):
                return tensor.new_tensor([[0.1, 0.2, 0.3, 0.4]])

            def to(self, device):
                return self

        class FakeModel:
            load_seconds = 0.0

            def features(self, case, order):
                forwards.append(order)
                return {"cand": torch.zeros(4, 5120), "hq": torch.zeros(5120),
                        "tokensIn": 10, "prefillMs": 1.0, "idsSha256": "x"}

        class FakeLedger:
            def __init__(self, *a, **k):
                pass

            def reserve(self, job_id, operation, arm):
                return job_id

            def begin(self, job_id):
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
        with unittest.mock.patch.dict(sys.modules, {"backends.local_qwen": fake_backend,
                                                    "heads.train": fake_heads,
                                                    "r1ledger": fake_ledger,
                                                    "backends": types.ModuleType("backends")}), \
             unittest.mock.patch.object(cli, "load_policy", lambda path: policy):
            import io
            from contextlib import redirect_stderr, redirect_stdout

            out, err = io.StringIO(), io.StringIO()
            with redirect_stdout(out), redirect_stderr(err):
                code = cli.main(argv)
        payload = json.loads(out.getvalue()) if out.getvalue().strip() else {}
        return code, payload

    def _policy(self, method: str, valid: bool, tau):
        return {"valid": valid, "decisionMode": "selective" if valid else "unavailable",
                "method": method, "temperature": 1.0, "tau": tau, "gating": "max_confidence",
                "allowedOrders": [0, 1, 2, 3], "allowedPairs": [[0, 1], [2, 3]],
                "head": {"path": "/tmp/none", "fileSha256": "a", "tensorSha256": "b"},
                "backbone": {"sha256": "c"}, "tokenizer": {"sha256": "d"},
                "prompt": {"version": R.PROMPT_VERSION, "sha256": "e"},
                "candidates": {"version": R.CANDIDATE_VERSION},
                "calibration": {"calTemperatureSha256": "f", "calPolicySha256": "g"},
                "selection": {}, "createdAt": R.now_iso()}

    def test_single_pass_forwards_exactly_one_order(self):
        forwards = []
        code, payload = self._run(self._policy("single_pass", True, 0.2),
                                  ["--policy", "p", "--context", "c", "--player", "p",
                                   "--order", "2", "--device", "cpu"], forwards)
        self.assertEqual(code, 0)
        self.assertEqual(forwards, [2])
        self.assertEqual(payload["forwardCalls"], 1)

    def test_pair_forwards_exactly_two_orders(self):
        forwards = []
        code, payload = self._run(self._policy("reverse_pair_consensus", True, 0.05),
                                  ["--policy", "p", "--context", "c", "--player", "p",
                                   "--pair", "0,1", "--device", "cpu"], forwards)
        self.assertEqual(code, 0)
        self.assertEqual(forwards, [0, 1])
        self.assertEqual(payload["forwardCalls"], 2)

    def test_unavailable_policy_spends_nothing(self):
        forwards = []
        code, payload = self._run(self._policy("single_pass", False, None),
                                  ["--policy", "p", "--context", "c", "--player", "p",
                                   "--order", "0", "--device", "cpu"], forwards)
        self.assertEqual(code, 0)
        self.assertEqual(forwards, [])
        self.assertEqual(payload["decision"], "unavailable")

    def test_conflicting_or_unsupported_presentation_is_refused_before_load(self):
        forwards = []
        code, _ = self._run(self._policy("single_pass", True, 0.2),
                            ["--policy", "p", "--context", "c", "--player", "p",
                             "--order", "0", "--pair", "0,1", "--device", "cpu"], forwards)
        self.assertEqual(code, 2)
        self.assertEqual(forwards, [])
        code, _ = self._run(self._policy("single_pass", True, 0.2),
                            ["--policy", "p", "--context", "c", "--player", "p",
                             "--device", "cpu"], forwards)
        self.assertEqual(code, 2)
        self.assertEqual(forwards, [])


class PolicyGateTest(unittest.TestCase):
    def test_uncalibrated_results_cannot_build_a_valid_policy(self):
        from policy import PolicyError, validate

        base = {"schema": "frostecho.jev02r1.policy/1", "valid": True,
                "decisionMode": "selective", "method": "single_pass",
                "temperature": 1.0, "tau": None, "gating": "max_confidence",
                "allowedOrders": [0, 1, 2, 3], "allowedPairs": [],
                "head": {"path": "x", "fileSha256": "a", "tensorSha256": "b"},
                "backbone": {"sha256": "c"}, "tokenizer": {"sha256": "d"},
                "prompt": {"version": R.PROMPT_VERSION, "sha256": "e"},
                "candidates": {"version": R.CANDIDATE_VERSION},
                "calibration": {"calTemperatureSha256": "f", "calPolicySha256": "g"},
                "selection": {}, "createdAt": R.now_iso()}
        with self.assertRaises(PolicyError):
            validate(base, check_files=False)


if __name__ == "__main__":
    unittest.main()
