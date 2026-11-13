"""CPU/fake-backend gate for JEV-01. No model weights are loaded here."""
from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
import torch

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

import contracts as C  # noqa: E402
from data.generate import common_text  # noqa: E402
from data.rules import coverage, predict  # noqa: E402
from eval.metrics import (  # noqa: E402
    ece, fit_temperature, macro_f1, nll_brier, order_consistency, softmax,
)
from heads.models import LinearHead, PointerHead, build_head, masked_cross_entropy  # noqa: E402
from heads.train import state_hash  # noqa: E402

CASES = C.read_jsonl(HERE / "data/base_cases.jsonl")


class ContractsTest(unittest.TestCase):
    def test_orders_are_permutations(self):
        for order in C.ORDERS:
            self.assertEqual(sorted(order), sorted(C.CLASSES))
        self.assertEqual(C.display_to_stable(0)["A"], "PLAYER_FIRST")
        self.assertEqual(C.display_to_stable(1)["A"], "NEEDS_CLARIFICATION")
        for index in range(2):
            mapping = C.letters_for(index)
            self.assertEqual({v: k for k, v in mapping.items()}, C.display_to_stable(index))

    def test_case_validation_rejects_duplicates(self):
        case = dict(CASES[0])
        C.validate_case(case)
        bad = dict(case)
        bad["candidates"] = [case["candidates"][0]] * 4
        with self.assertRaises(ValueError):
            C.validate_case(bad)
        leak = dict(case)
        leak["visibleInput"] = {"context": "x", "playerText": "labelId=PLAYER_FIRST"}
        with self.assertRaises(ValueError):
            C.validate_case(leak)

    def test_ledger_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = C.Ledger(Path(tmp) / "jobs.jsonl", {**C.CAPS, "feature_jobs": 1, "total_model_jobs": 2})
            ledger.add(C.Job("f1", "feature", "feature", "c", "0", 1, 0, 1, 0, 0.1, C.now_iso()))
            with self.assertRaises(RuntimeError):
                ledger.add(C.Job("f2", "feature", "feature", "c", "0", 1, 0, 1, 0, 0.1, C.now_iso()))


class DatasetTest(unittest.TestCase):
    def test_sizes_and_balance(self):
        counts = {}
        for case in CASES:
            if "labelId" not in case:
                continue
            counts.setdefault(case["split"], {}).setdefault(case["labelId"], 0)
            counts[case["split"]][case["labelId"]] += 1
        self.assertEqual({split: sum(v.values()) for split, v in counts.items()},
                         {"train": 384, "dev": 64, "cal": 64})
        for split, buckets in counts.items():
            self.assertEqual(sorted(buckets.values()), [C.PER_CLASS[split]] * 4)
        gold = C.read_json(HERE / "data/test.gold.json")["gold"]
        test_counts = {}
        for entry in gold.values():
            test_counts[entry["labelId"]] = test_counts.get(entry["labelId"], 0) + 1
        self.assertEqual(sorted(test_counts.values()), [32] * 4)

    def test_groups_never_cross_splits(self):
        seen = {}
        for case in CASES:
            prior = seen.setdefault(case["groupId"], case["split"])
            self.assertEqual(prior, case["split"])

    def test_test_inputs_carry_no_label(self):
        inputs = C.read_jsonl(HERE / "data/test.inputs.jsonl")
        self.assertEqual(len(inputs), 128)
        self.assertTrue(all("labelId" not in row for row in inputs))
        gold = C.read_json(HERE / "data/test.gold.json")
        self.assertEqual(gold["sha256"], C.sha256_json(gold["gold"]))
        self.assertEqual(len(gold["gold"]), 128)

    def test_two_orders_change_letters_not_semantics(self):
        case = next(c for c in CASES if c["split"] == "test")
        texts = [common_text(case, index) for index in (0, 1)]
        self.assertNotEqual(texts[0], texts[1])
        self.assertEqual(texts[0].count("候选："), 1)
        self.assertEqual(len(C.ORDERS[0]), 4)
        self.assertEqual(set(C.ORDERS[0]), set(C.ORDERS[1]))

    def test_no_leak_tokens_in_visible_input(self):
        for case in CASES:
            blob = json.dumps(case["visibleInput"], ensure_ascii=False)
            for token in ("request.kind", "selectedGoal", "activeGoal", "gold"):
                self.assertNotIn(token, blob)


class RulesTest(unittest.TestCase):
    def test_deterministic_and_train_coverage(self):
        train = [case for case in CASES if case["split"] == "train"]
        result = coverage(train)
        self.assertEqual(result["n"], 384)
        self.assertEqual(result["covered"], 384)
        self.assertGreaterEqual(result["accuracyAll"], 0.9)
        sample = train[0]["visibleInput"]["playerText"]
        self.assertEqual(predict(sample), predict(sample))

    def test_abstains_on_unknown(self):
        self.assertIsNone(predict("完全无关的一句话").predictedId)


class HeadTest(unittest.TestCase):
    def test_parameter_counts(self):
        self.assertEqual(sum(p.numel() for p in LinearHead().parameters()), 5120)
        self.assertEqual(sum(p.numel() for p in PointerHead().parameters()), 1310848)

    def test_variable_k_and_mask(self):
        hidden, batch = 32, 2
        head = build_head("pointer_head", hidden=hidden, rank=8)
        cand = torch.randn(batch, 3, hidden)
        hq = torch.randn(batch, hidden)
        logits = head(cand, hq)
        self.assertEqual(tuple(logits.shape), (batch, 3))
        target = torch.tensor([0, 2])
        mask = torch.tensor([[True, True, False], [True, True, True]])
        loss = masked_cross_entropy(logits, target, mask)
        self.assertTrue(torch.isfinite(loss))
        with self.assertRaises(ValueError):
            masked_cross_entropy(logits, torch.tensor([2, 2]), mask)

    def test_nonfinite_rejected(self):
        head = build_head("linear_head", hidden=8)
        cand = torch.randn(1, 3, 8)
        logits = head(cand)
        logits[0, 0] = float("nan")
        with self.assertRaises(ValueError):
            masked_cross_entropy(logits, torch.tensor([0]), torch.ones(1, 3, dtype=torch.bool))

    def test_gradient_reaches_only_head(self):
        head = build_head("linear_head", hidden=16)
        cand = torch.randn(4, 4, 16)
        loss = masked_cross_entropy(head(cand), torch.zeros(4, dtype=torch.long), torch.ones(4, 4, dtype=torch.bool))
        loss.backward()
        for name, param in head.named_parameters():
            self.assertIsNotNone(param.grad, name)
        # every trainable tensor belongs to the head module
        self.assertEqual({name for name, _ in head.named_parameters()}, {"w"})

    def test_temperature_keeps_argmax(self):
        rng = np.random.default_rng(0)
        logits = rng.normal(size=(10, 4))
        self.assertTrue((softmax(logits, 0.3).argmax(axis=1) == softmax(logits, 5.0).argmax(axis=1)).all())

    def test_state_hash_stable(self):
        head = build_head("pointer_head", hidden=8, rank=4)
        first = state_hash(head.state_dict())
        second = state_hash(head.state_dict())
        self.assertEqual(first, second)
        with torch.no_grad():
            head.v[0] += 1
        self.assertNotEqual(first, state_hash(head.state_dict()))


class MetricsTest(unittest.TestCase):
    def test_macro_f1_perfect_and_ece(self):
        gold = {f"c{i}": C.CLASSES[i % 4] for i in range(8)}
        rows = [{"caseId": key, "order": 0, "predictedId": value} for key, value in gold.items()]
        self.assertEqual(macro_f1(rows, gold)["macroF1"], 1.0)
        probs = np.full((8, 4), 0.25)
        target = np.array([C.CLASSES.index(gold[f"c{i}"]) for i in range(8)])
        report = ece(probs, target)
        self.assertEqual(sum(b["n"] for b in report["bins"]), 8)
        self.assertAlmostEqual(report["ece"], 0.0, places=6)
        self.assertEqual(sum(1 for b in report["bins"] if b["n"] > 0), 1)

    def test_order_consistency_uses_stable_ids(self):
        rows = [
            {"caseId": "c1", "order": 0, "predictedId": "PLAYER_FIRST"},
            {"caseId": "c1", "order": 1, "predictedId": "PLAYER_FIRST"},
            {"caseId": "c2", "order": 0, "predictedId": "NPC_FIRST"},
            {"caseId": "c2", "order": 1, "predictedId": "PLAYER_FIRST"},
        ]
        self.assertEqual(order_consistency(rows)["consistency"], 0.5)

    def test_nll_brier_and_temperature(self):
        logits = np.array([[4.0, 1.0, 0.0, 0.0], [0.0, 3.0, 1.0, 0.0]], dtype=np.float64)
        target = np.array([0, 1])
        probs = softmax(logits, 1.0)
        values = nll_brier(probs, target)
        self.assertGreater(values["nll"], 0)
        fit = fit_temperature(logits, target)
        self.assertGreater(fit["T"], 0)


class TokenPositionTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from transformers import AutoTokenizer
        cls.tokenizer = AutoTokenizer.from_pretrained(str(C.MODEL_PATH))

    def test_positions_are_prefix_stable_and_inside(self):
        from backends.local_qwen import candidate_end_tokens
        cases = [case for case in CASES if case["split"] == "test"][:4]
        for case in cases:
            for order in (0, 1):
                common = common_text(case, order)
                rendered = self.tokenizer.apply_chat_template(
                    [{"role": "user", "content": common}], tokenize=False,
                    add_generation_prompt=True, enable_thinking=False)
                positions, final = candidate_end_tokens(self.tokenizer, rendered, common, order)
                ids = self.tokenizer(rendered, add_special_tokens=False)["input_ids"]
                self.assertEqual(final, len(ids) - 1)
                self.assertEqual(len(set(positions)), 4)
                self.assertTrue(max(positions) < final)
                self.assertTrue(all(0 < p < final for p in positions))
                for letter in C.LETTERS:
                    self.assertEqual(len(self.tokenizer.encode(letter, add_special_tokens=False)), 1)


class FakeBackendTest(unittest.TestCase):
    def test_strict_json_is_rejected_not_repaired(self):
        from run import strict_selected_id
        self.assertEqual(strict_selected_id('{"selectedId":"B"}'), ("B", True))
        self.assertEqual(strict_selected_id('{"selectedId":"B"}<|im_end|>'), ("B", True))
        self.assertEqual(strict_selected_id(' {"selectedId": "B"} ')[1], True)
        for bad in ('{"selectedId":"E"}', '{"selectedId":"B","x":1}', 'A', '```json\n{"selectedId":"B"}```'):
            self.assertEqual(strict_selected_id(bad)[1], False, bad)


if __name__ == "__main__":
    unittest.main()
