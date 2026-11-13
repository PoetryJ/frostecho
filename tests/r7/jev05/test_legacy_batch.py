"""Order-batching mechanics only, no model-performance claims."""
import importlib.util
import sys
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
LEGACY = ROOT / "research/decision-choice/jev05/legacy"
sys.path.insert(0, str(LEGACY))
spec = importlib.util.spec_from_file_location("jev05_bf16_batch_encoder", LEGACY / "encode_bf16.py")
encoder = importlib.util.module_from_spec(spec)
spec.loader.exec_module(encoder)


class Renderer:
    def __init__(self, lengths):
        self.lengths = lengths
        self.calls = []

    def rendered_chat(self, tokenizer, row, order, arm):
        self.calls.append((row["caseId"], order, arm))
        length = self.lengths[order]
        return {"ids": [order * 100 + index for index in range(length)],
                "positions": [order % 2, 2, 4, 6], "final": length - 1}


class OrderBatchMechanismTests(unittest.TestCase):
    def test_all_four_orders_render_independently_and_equal_lengths_group(self):
        renderer = Renderer([9, 10, 9, 10])
        row = {"caseId": "unit", "context": "context", "playerText": "request"}
        batches = encoder.order_batches(renderer, None, row, range(4), 4, 32)
        self.assertEqual(renderer.calls, [("unit", index, "label") for index in range(4)])
        self.assertEqual([[order for order, _ in batch] for batch in batches], [[0, 2], [1, 3]])
        self.assertEqual([np.asarray([built["ids"] for _, built in batch]).shape for batch in batches], [(2, 9), (2, 10)])
        self.assertNotEqual(batches[0][0][1]["ids"], batches[0][1][1]["ids"])
        self.assertEqual(batches[0][0][1]["ids"], list(range(9)))

    def test_each_hidden_row_uses_its_own_candidate_and_final_positions(self):
        renderer = Renderer([10] * 4)
        row = {"caseId": "unit", "context": "context", "playerText": "request"}
        batches = encoder.order_batches(renderer, None, row, range(4), 4, 32)
        self.assertEqual(len(batches), 1)
        hidden = np.arange(4 * 10 * 3).reshape(4, 10, 3)
        built = [value for _, value in batches[0]]
        features = encoder.gather_numpy_features(hidden, built)
        for index, (candidates, final) in enumerate(features):
            np.testing.assert_array_equal(candidates, hidden[index, built[index]["positions"]])
            np.testing.assert_array_equal(final, hidden[index, 9])
        self.assertFalse(np.array_equal(features[0][0], features[1][0]))

    def test_batch_limit_splits_without_padding_or_truncation(self):
        renderer = Renderer([10] * 4)
        row = {"caseId": "unit", "context": "context", "playerText": "request"}
        batches = encoder.order_batches(renderer, None, row, range(4), 2, 32)
        self.assertEqual([len(batch) for batch in batches], [2, 2])
        with self.assertRaisesRegex(ValueError, "no silent truncation"):
            encoder.order_batches(renderer, None, row, range(4), 4, 9)


if __name__ == "__main__":
    unittest.main()
