"""CPU/fake gate for JEV-02R1. No model, no GPU, no network."""
from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

import r1config as R  # noqa: E402
from devselect import balanced_loss, order0_loss, select_epoch  # noqa: E402
from evalr1 import gate, rows_for_order, selective_table  # noqa: E402
from guards import GoldBlocked, GoldSeal  # noqa: E402
from policy import (PolicyError, build_policy, check_identity, decide, softmax,  # noqa: E402
                    stable_probs, validate)
from r1config import ORDERS, PAIR, SINGLE, THRESHOLDS  # noqa: E402
from r1ledger import BudgetExceeded, Ledger  # noqa: E402


def fake_policy(**overrides) -> dict:
    policy = {
        "schema": R.POLICY_SCHEMA, "valid": True, "decisionMode": "selective",
        "method": SINGLE, "temperature": 1.0, "tau": 0.9, "gating": "max_confidence",
        "allowedOrders": [0, 1, 2, 3], "allowedPairs": [],
        "head": {"path": "x", "fileSha256": "y", "tensorSha256": "z"},
        "backbone": {"sha256": "b"}, "tokenizer": {"sha256": "t"},
        "prompt": {"version": R.PROMPT_VERSION, "sha256": "p"},
        "candidates": {"version": R.CANDIDATE_VERSION},
        "calibration": {"calTemperatureSha256": "c1", "calPolicySha256": "c2"},
        "selection": {}, "createdAt": "2026-11-10",
    }
    policy.update(overrides)
    return policy


class LedgerTest(unittest.TestCase):
    def test_generation_cap_is_keyed_on_operation_not_display_kind(self):
        with tempfile.TemporaryDirectory() as tmp:
            caps = dict(R.CAPS)
            caps["generation_jobs"] = 1
            ledger = Ledger(Path(tmp) / "jobs.jsonl", caps=caps)
            # A JSON latency/demo job is still a generation job.
            ledger.reserve("latency-json-1", "generate", "latency")
            with self.assertRaises(BudgetExceeded):
                ledger.reserve("latency-json-2", "generate", "latency")
            ledger.reserve("feature-1", "forward", "shared")

    def test_zero_generation_cap_refuses_before_compute(self):
        with tempfile.TemporaryDirectory() as tmp:
            caps = dict(R.CAPS)
            caps["generation_jobs"] = 0
            ledger = Ledger(Path(tmp) / "jobs.jsonl", caps=caps)
            with self.assertRaises(BudgetExceeded):
                ledger.reserve("gen-1", "generate", "json")
            self.assertEqual(ledger.summary()["reserved"], 0)

    def test_window_cap_uses_first_reservation(self):
        clock = {"now": 1000.0}
        with tempfile.TemporaryDirectory() as tmp:
            caps = dict(R.CAPS)
            caps["window_seconds"] = 60
            ledger = Ledger(Path(tmp) / "jobs.jsonl", caps=caps, clock=lambda: clock["now"])
            ledger.reserve("a", "forward", "shared")
            clock["now"] = 1050
            ledger.reserve("b", "forward", "shared")
            clock["now"] = 1100
            with self.assertRaises(BudgetExceeded):
                ledger.reserve("c", "forward", "shared")

    def test_duplicate_and_failure_accounting(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Ledger(Path(tmp) / "jobs.jsonl")
            job = ledger.reserve("f1", "forward", "x")
            with self.assertRaises(BudgetExceeded):
                ledger.reserve("f1", "forward", "x")
            ledger.begin(job)
            ledger.fail(job, "head raised after a successful forward", prefill=1, seconds=0.2)
            summary = ledger.summary()
            self.assertEqual((summary["reserved"], summary["failed"], summary["finished"]), (1, 1, 0))
            self.assertEqual(summary["prefillCalls"], 1)

    def test_decode_calls_are_bounded_not_output_tokens(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Ledger(Path(tmp) / "jobs.jsonl")
            job = ledger.reserve("g1", "generate", "json")
            with self.assertRaises(BudgetExceeded):
                ledger.finish(job, prefill=1, decode=R.CAPS["max_new_tokens"] + 1,
                              tokens_in=1, tokens_out=1, seconds=0.1)

    def test_unknown_operation_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Ledger(Path(tmp) / "jobs.jsonl")
            with self.assertRaises(ValueError):
                ledger.reserve("x", "latency", "json")


class PolicyValidationTest(unittest.TestCase):
    def test_valid_policy_passes_without_file_checks(self):
        validate(fake_policy(), check_files=False)

    def test_missing_and_unknown_keys(self):
        broken = fake_policy()
        broken.pop("gating")
        with self.assertRaises(PolicyError):
            validate(broken, check_files=False)
        with self.assertRaises(PolicyError):
            validate(fake_policy(extraOption=1), check_files=False)

    def test_temperature_must_be_finite_positive(self):
        for value in (0.0, -1.0, float("nan"), float("inf"), "0.5", None):
            with self.assertRaises(PolicyError):
                validate(fake_policy(temperature=value), check_files=False)

    def test_tau_bounds_and_unavailable_mode(self):
        for value in (0.0, 1.0, 1.2, float("nan"), None):
            with self.assertRaises(PolicyError):
                validate(fake_policy(tau=value), check_files=False)
        unavailable = fake_policy(valid=False, decisionMode="unavailable", tau=None)
        validate(unavailable, check_files=False)
        with self.assertRaises(PolicyError):
            validate(fake_policy(valid=False, decisionMode="unavailable", tau=0.9), check_files=False)
        with self.assertRaises(PolicyError):
            validate(fake_policy(valid=False, tau=0.9), check_files=False)

    def test_method_and_support_conflicts(self):
        # A pair policy with one pre-registered pair is valid.
        validate(fake_policy(method=PAIR, gating="min_confidence", allowedOrders=[],
                             allowedPairs=[[0, 1]]), check_files=False)
        with self.assertRaises(PolicyError):
            validate(fake_policy(method=SINGLE, allowedOrders=[0], allowedPairs=[[0, 1]]),
                     check_files=False)
        with self.assertRaises(PolicyError):
            validate(fake_policy(method=SINGLE, allowedOrders=[]), check_files=False)
        with self.assertRaises(PolicyError):
            validate(fake_policy(method=PAIR, gating="max_confidence", allowedOrders=[],
                                 allowedPairs=[[0, 1]]), check_files=False)
        with self.assertRaises(PolicyError):
            validate(fake_policy(method=PAIR, gating="min_confidence", allowedOrders=[],
                                 allowedPairs=[[0, 3]]), check_files=False)

    def test_decision_mode_must_match_valid_flag(self):
        with self.assertRaises(PolicyError):
            validate(fake_policy(decisionMode="unavailable"), check_files=False)
        with self.assertRaises(PolicyError):
            validate(fake_policy(valid=False, tau=None), check_files=False)

    def test_calibration_splits_must_differ(self):
        with self.assertRaises(PolicyError):
            validate(fake_policy(calibration={"calTemperatureSha256": "same",
                                              "calPolicySha256": "same"}), check_files=False)

    def test_stale_head_and_changed_calibration_are_refused(self):
        policy = build_policy(valid=True, method=SINGLE, temperature=1.0, tau=0.9,
                              calibration={"calTemperatureSha256": R.sha256_file(
                                  R.split_file("cal-temperature")),
                                  "calPolicySha256": R.sha256_file(R.split_file("cal-policy"))},
                              selection={})
        check_identity(policy)  # untouched policy passes
        tampered = {**policy, "head": {**policy["head"], "fileSha256": "0" * 64}}
        with self.assertRaises(PolicyError):
            check_identity(tampered)
        tampered = {**policy, "calibration": {**policy["calibration"],
                                              "calPolicySha256": "0" * 64}}
        with self.assertRaises(PolicyError):
            check_identity(tampered)
        tampered = {**policy, "prompt": {**policy["prompt"], "sha256": "0" * 64}}
        with self.assertRaises(PolicyError):
            check_identity(tampered)


class DecideTest(unittest.TestCase):
    def s1(self, **overrides):
        return fake_policy(**overrides)

    def test_below_threshold_abstains_above_accepts(self):
        logits = {order: [3.0, 0.0, 0.0, 0.0] for order in range(4)}
        low = decide(self.s1(tau=0.99), logits)
        self.assertEqual(low["decision"], "abstain")
        self.assertIsNone(low["candidateId"])
        high = decide(self.s1(tau=0.8), logits)
        self.assertEqual(high["decision"], "accept")
        self.assertEqual(high["candidateId"], "PLAYER_FIRST")

    def test_invalid_policy_is_unavailable_not_threshold_zero(self):
        result = decide(fake_policy(valid=False, decisionMode="unavailable", tau=None),
                        {order: [9.0, 0.0, 0.0, 0.0] for order in range(4)})
        self.assertEqual(result["decision"], "unavailable")
        self.assertIsNone(result["candidateId"])
        self.assertEqual(result["reason"], "policy_invalid")

    def test_temperature_never_changes_argmax(self):
        logits = [2.5, 1.0, 0.2, -0.7]
        for temperature in (0.05, 0.2, 1.0, 3.0, 20.0):
            probs = stable_probs(0, logits, temperature)
            self.assertEqual(max(probs, key=probs.get), ORDERS[0][0])
            self.assertAlmostEqual(sum(probs.values()), 1.0, places=9)

    def test_s2_disagreement_abstains_and_agreement_uses_min(self):
        policy = fake_policy(method=PAIR, gating="min_confidence", tau=0.8,
                             allowedOrders=[], allowedPairs=[[2, 3]])
        # ORDERS[2]=(NF,PF,NC,NO), ORDERS[3]=(NO,NC,PF,NF).
        logits = {2: [3.0, 0.0, 0.0, 0.0], 3: [3.0, 0.0, 0.0, 0.0]}
        # order 2 -> NPC_FIRST, order 3 -> NO_PRIORITY_REQUEST: the pair disagrees.
        result = decide(policy, logits)
        self.assertEqual(result["decision"], "abstain")
        self.assertEqual(result["reason"], "order_disagreement")
        # Point order 3 at its NFC position: the pair agrees and the gate uses
        # the smaller of the two maxima.
        logits[3] = [0.0, 0.0, 0.0, 3.0]
        result = decide(policy, logits)
        self.assertEqual(result["decision"], "accept")
        self.assertEqual(result["candidateId"], "NPC_FIRST")
        expected = min(softmax([3.0, 0.0, 0.0, 0.0], 1.0)[0], softmax([0.0, 0.0, 0.0, 3.0], 1.0)[3])
        self.assertAlmostEqual(result["score"], expected, places=9)
        self.assertEqual(result["gating"], "min_confidence")

    def test_missing_order_logits_is_an_error(self):
        with self.assertRaises(PolicyError):
            decide(self.s1(), {0: [1.0, 0.0, 0.0, 0.0]})

    def test_cli_and_eval_use_the_same_decision(self):
        logits = {order: [3.0, 0.4, -0.2, 0.1] for order in range(4)}
        policy = self.s1(tau=0.5)
        direct = decide(policy, logits)
        table = selective_table(
            [{"caseId": "c1", "order": order, "family": "f", "label": "PLAYER_FIRST",
              "candidateId": next(iter(rows_for_order(policy, logits).values()))["candidateId"],
              "probs": next(iter(rows_for_order(policy, logits).values()))["probs"],
              "agree": True,
              "score": max(next(iter(rows_for_order(policy, logits).values()))["probs"].values())}
             for order in policy["allowedOrders"]], 0.5, SINGLE)
        self.assertEqual(direct["decision"], "accept")
        self.assertEqual(table["pooled"]["accepted"], 4)


class GoldSealTest(unittest.TestCase):
    def test_sealed_path_is_blocked_and_counted(self):
        with tempfile.TemporaryDirectory() as tmp:
            sealed = Path(tmp) / "gold.json"
            sealed.write_text("{}", encoding="utf-8")
            other = Path(tmp) / "inputs.jsonl"
            other.write_text("{}\n", encoding="utf-8")
            seal = GoldSeal([sealed])
            with seal:
                with self.assertRaises(GoldBlocked):
                    open(sealed, encoding="utf-8")
                with self.assertRaises(GoldBlocked):
                    sealed.read_text(encoding="utf-8")
                with self.assertRaises(GoldBlocked):
                    sealed.open("rb")
                open(other, encoding="utf-8").close()
                report = seal.report()
                self.assertEqual(report["blockedAttempts"], 3)
            with open(sealed, encoding="utf-8") as handle:
                self.assertEqual(handle.read(), "{}")

    def test_unsealed_paths_still_work(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.txt"
            path.write_text("ok", encoding="utf-8")
            with GoldSeal([Path(tmp) / "gold.json"]):
                self.assertEqual(path.read_text(encoding="utf-8"), "ok")


class EvalTest(unittest.TestCase):
    def items(self, n=60, errors=0):
        rows = []
        for index in range(n):
            label = ("PLAYER_FIRST", "NPC_FIRST", "NO_PRIORITY_REQUEST", "NEEDS_CLARIFICATION")[index % 4]
            wrong = index < errors
            predicted = "NPC_FIRST" if wrong and label != "NPC_FIRST" else label
            rows.append({"caseId": f"c{index}", "order": 0, "family": f"f{index % 12}",
                         "label": label, "candidateId": predicted, "agree": True, "score": 0.9,
                         "probs": {label: 0.9}})
        return rows

    def test_zero_acceptance_risk_is_null_and_fails_gate(self):
        rows = self.items()
        table = selective_table(rows, 0.99, SINGLE)
        self.assertEqual(table["pooled"]["accepted"], 0)
        self.assertIsNone(table["pooled"]["risk"])
        verdict = gate(table, 0.05, 50, 5, {"0": {cls: 0 for cls in R.CLASSES}})
        self.assertFalse(verdict["passes"])

    def test_per_order_denominators_and_equal_weight_coverage(self):
        rows = self.items()
        rows = [row for row in rows if row["order"] == 0]
        for row in rows:
            row["order"] = 1
        rows.append({**rows[0], "caseId": "c0b", "candidateId": None, "score": 0.0})
        table = selective_table(rows, 0.5, SINGLE)
        self.assertEqual(table["perSupported"]["1"]["bases"], 61)
        self.assertEqual(table["perSupported"]["1"]["accepted"], 60)

    def test_gate_requires_every_supported_order(self):
        items = []
        for order in (0, 1):
            for index in range(60):
                label = R.CLASSES[index % 4]
                items.append({"caseId": f"c{index}", "order": order, "family": f"f{index % 10}",
                              "label": label, "candidateId": label, "agree": True,
                              "score": 0.95, "probs": {label: 0.95}})
        table = selective_table(items, 0.9, SINGLE)
        counts = {"0": {cls: 15 for cls in R.CLASSES}, "1": {cls: 15 for cls in R.CLASSES}}
        self.assertTrue(gate(table, 0.05, 50, 5, counts)["passes"])


class DevSelectTest(unittest.TestCase):
    def test_order0_rule_and_balanced_rule_pick_different_epochs(self):
        epoch_one = [{"group": f"g{group}", "order": order, "loss": 0.1 if order == 0 else 1.0}
                     for group in range(4) for order in range(4)]
        epoch_two = [{"group": f"g{group}", "order": order, "loss": 0.35}
                     for group in range(4) for order in range(4)]
        epochs = [{"epoch": 1, "records": epoch_one}, {"epoch": 2, "records": epoch_two}]
        self.assertEqual(order0_loss(epochs)["selected"]["epoch"], 1)
        self.assertEqual(select_epoch(epochs)["selected"]["epoch"], 2)
        self.assertAlmostEqual(balanced_loss(epoch_two), 0.35, places=9)

    def test_missing_cells_are_refused(self):
        with self.assertRaises(ValueError):
            balanced_loss([{"group": "g0", "order": 0, "loss": 0.1},
                           {"group": "g0", "order": 1, "loss": 0.1},
                           {"group": "g1", "order": 0, "loss": 0.1}])


class DataGateTest(unittest.TestCase):
    def _rows(self, split, count, prefix):
        base = {"a": 0, "b": 400, "c": 900}[prefix]

        def phrase(index: int, salt: int) -> str:
            return "".join(chr(0x4E00 + ((base + index * 97 + salt * 31 + step * 13) % 4000))
                           for step in range(8))

        return [{"caseId": f"{prefix}-{index}", "family": f"{prefix}-fam-{index // 8}",
                 "labelId": R.CLASSES[index % 4],
                 "context": f"场景{prefix}里{phrase(index, 3)}的完整上下文。",
                 "playerText": f"{phrase(index, 1)}，{phrase(index + 7, 2)}。",
                 "reason": "测试用理由。"} for index in range(count)]

    def test_good_split_passes_and_bad_ones_fail(self):
        import datagate
        splits = {"cal-temperature": self._rows("cal-temperature", 128, "a"),
                  "cal-policy": self._rows("cal-policy", 128, "b"),
                  "test": self._rows("test", 256, "c")}
        self.assertTrue(datagate.check(splits)["passes"])

        cloned = {key: [dict(row) for row in value] for key, value in splits.items()}
        for row in cloned["cal-temperature"][:20]:
            row["playerText"] = cloned["cal-temperature"][0]["playerText"]
        self.assertFalse(datagate.check(cloned)["passes"])

        overlapping = {key: [dict(row) for row in value] for key, value in splits.items()}
        overlapping["cal-policy"][0]["family"] = overlapping["cal-temperature"][0]["family"]
        self.assertTrue(any("family overlap" in failure
                            for failure in datagate.check(overlapping)["failures"]))

        leaked = {key: [dict(row) for row in value] for key, value in splits.items()}
        leaked["test"][0]["context"] += " PLAYER_FIRST"
        self.assertTrue(any("leak" in failure for failure in datagate.check(leaked)["failures"]))


if __name__ == "__main__":
    unittest.main()
