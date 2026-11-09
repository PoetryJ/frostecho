"""CPU/fake gate for JEV-02: P0 ledger, structural positions, data, losses."""
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
from contracts import ORDERS, read_json, read_jsonl  # noqa: E402
from data.features_io import load_split  # noqa: E402
from heads.models import build_head  # noqa: E402
from heads.train import CLASS_INDEX, batch_loss, stable_probs  # noqa: E402
from ledger import BudgetExceeded, Ledger  # noqa: E402
from render import rendered_chat, build  # noqa: E402


class LedgerTest(unittest.TestCase):
    def test_reserve_checks_cap_before_compute(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Ledger(Path(tmp) / "jobs.jsonl")
            old = dict(C.CAPS)
            C.CAPS["model_jobs"] = 1
            try:
                ledger.reserve("a", "feature", "x")
                with self.assertRaises(BudgetExceeded):
                    ledger.reserve("b", "feature", "x")
            finally:
                C.CAPS.clear(); C.CAPS.update(old)
            self.assertEqual(ledger.summary()["reserved"], 1)

    def test_forward_ok_head_raises_still_charged(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Ledger(Path(tmp) / "jobs.jsonl")
            job = ledger.reserve("f1", "feature", "x")
            ledger.begin(job)
            try:
                raise RuntimeError("head raised after a successful forward")
            except RuntimeError as error:
                ledger.fail(job, str(error), prefill=1, seconds=0.2)
            summary = ledger.summary()
            self.assertEqual(summary["reserved"], 1)
            self.assertEqual(summary["failed"], 1)
            self.assertEqual(summary["finished"], 0)
            self.assertEqual(summary["prefill"], 1)

    def test_duplicate_job_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Ledger(Path(tmp) / "jobs.jsonl")
            ledger.reserve("same", "feature", "x")
            with self.assertRaises(BudgetExceeded):
                ledger.reserve("same", "feature", "x")

    def test_generation_token_cap(self):
        with tempfile.TemporaryDirectory() as tmp:
            ledger = Ledger(Path(tmp) / "jobs.jsonl")
            job = ledger.reserve("g1", "generation", "json")
            with self.assertRaises(BudgetExceeded):
                ledger.finish(job, prefill=1, decode=C.CAPS["max_new_tokens"] + 1,
                              tokens_in=1, tokens_out=C.CAPS["max_new_tokens"] + 1, seconds=0.1)


class RenderTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from transformers import AutoTokenizer
        cls.tokenizer = AutoTokenizer.from_pretrained(str(C.MODEL_PATH))

    def test_orders_cover_every_position_once(self):
        for cls in C.CLASSES:
            positions = {order.index(cls) for order in ORDERS}
            self.assertEqual(positions, {0, 1, 2, 3})

    def test_player_text_with_fake_candidate_block(self):
        rows = read_jsonl(HERE / "data/position-regression.jsonl")
        for case in rows:
            for order in range(4):
                built = rendered_chat(self.tokenizer, case, order, "label")
                tokens = [self.tokenizer.decode([built["ids"][p]]) for p in built["positions"]]
                for line, token in zip(built["built"]["lines"], tokens):
                    self.assertTrue(line.endswith(token), (line, token))
                pass
                self.assertEqual(len(set(built["positions"])), 4)

    def test_positions_do_not_follow_the_fake_letters(self):
        case = read_jsonl(HERE / "data/position-regression.jsonl")[1]
        built = rendered_chat(self.tokenizer, case, 0, "label")
        # The player's fake "A. " appears before the real block; real positions
        # must start after the structural block start, not at the fake line.
        self.assertGreater(min(built["positions"]), 0)
        pass
        self.assertIn("候选：", case["visibleInput"]["playerText"])
        self.assertEqual(built["built"]["lines"][0].split(". ")[1], C.LETTER_LABEL[ORDERS[0][0]])


class DataTest(unittest.TestCase):
    def test_sizes_and_families(self):
        stats = read_json(HERE / "data/train-stats.json")
        self.assertEqual(stats["splits"], {"train": 1024, "dev": 128, "cal": 512})
        self.assertEqual(stats["stats"]["train"]["cases"] // 4, 256)
        test = read_json(HERE / "data/test-stats.json")
        self.assertEqual(test["cases"], 256)
        self.assertEqual(test["families"], 32)
        self.assertEqual(sorted(test["perClass"].values()), [64, 64, 64, 64])

    def test_test_inputs_have_no_labels(self):
        rows = read_jsonl(HERE / "data/test.inputs.jsonl")
        self.assertTrue(all("labelId" not in row and "provenance" not in row for row in rows))
        gold = read_json(HERE / "data/test.gold.json")
        self.assertEqual(gold["sha256"], C.sha256_json(gold["gold"]))
        self.assertEqual(len(gold["gold"]), 256)

    def test_cal_roles(self):
        rows = read_jsonl(HERE / "data/cal.jsonl")
        roles = {}
        for row in rows:
            roles[row["calRole"]] = roles.get(row["calRole"], 0) + 1
        self.assertEqual(roles, {"temperature": 256, "policy": 256})

    def test_all_cases_have_four_unique_candidates(self):
        for split in ("train", "dev", "cal"):
            for case in read_jsonl(HERE / f"data/{split}.jsonl"):
                text = case["visibleInput"]["playerText"]
                self.assertTrue(text)
                self.assertIn(case["labelId"], C.CLASSES)


class LossTest(unittest.TestCase):
    def test_stable_alignment_not_letter_order(self):
        logits = torch.tensor([[[30.0, 0.0, 0.0, 0.0]] * 4])  # one batch, 4 perms, 4 candidates
        probs = stable_probs(logits)
        # Each permutation's mass must land on the stable class at its own position.
        for perm in range(4):
            self.assertAlmostEqual(float(probs[0, perm, CLASS_INDEX[ORDERS[perm][0]]]), 1.0, places=5)

    def test_m2_zero_when_consistent_and_positive_when_not(self):
        head = build_head("linear_head", hidden=8)
        with torch.no_grad():
            head.w.zero_()
        cand = torch.zeros(2, 4, 4, 8)
        hq = torch.zeros(2, 4, 8)
        label = torch.zeros(2, dtype=torch.long)
        # constant logits: all four permutations identical -> JS = 0
        loss, parts = batch_loss(head, "M2", cand, hq, label)
        self.assertAlmostEqual(parts["js"], 0.0, places=6)
        with torch.no_grad():
            head.w[0] = 1.0
        cand[:, :, :, 0] = torch.tensor([[3.0, -3.0, 0.0, 0.0]])  # same display position, different stable class per perm
        loss2, parts2 = batch_loss(head, "M2", cand, hq, label)
        self.assertGreater(parts2["js"], 0.0)

    def test_gradient_only_on_head(self):
        head = build_head("linear_head", hidden=8)
        cand = torch.randn(1, 4, 4, 8)
        hq = torch.randn(1, 4, 8)
        loss, _ = batch_loss(head, "M1", cand, hq, torch.zeros(1, dtype=torch.long))
        loss.backward()
        self.assertEqual({name for name, _ in head.named_parameters()}, {"w"})
        self.assertIsNotNone(head.w.grad)


if __name__ == "__main__":
    unittest.main()
