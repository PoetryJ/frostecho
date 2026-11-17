"""Mechanism-only checks; the character tokenizer is not a language model."""
import unittest
import numpy as np
from joint_core import joint_prompt, render_joint, score_joint, softmax, acceptable_set_loss


class CharacterTokenizer:
    def apply_chat_template(self, messages, **_kwargs):
        return "[user]\n" + messages[0]["content"] + "\n[assistant]"

    def __call__(self, text, **_kwargs):
        return {"input_ids": [ord(c) for c in text],
                "offset_mapping": [(i, i + 1) for i in range(len(text))]}


def candidates():
    return [{"id": "opaque-s1", "description": "采集食物", "action": "gather", "params": {"amount": 2}},
            {"id": "opaque-s2", "description": "先说明延误", "action": "talk", "params": {"to": "player"}}]


class JointCoreTests(unittest.TestCase):
    def test_actual_text_and_parameters_change_tokens(self):
        items = candidates(); a = render_joint(CharacterTokenizer(), "known", items)
        items[0]["description"] = "采集木材"
        b = render_joint(CharacterTokenizer(), "known", items)
        items[0]["params"]["amount"] = 3
        c = render_joint(CharacterTokenizer(), "known", items)
        items[0]["action"] = "withdraw"
        d = render_joint(CharacterTokenizer(), "known", items)
        items[0]["preconditions"] = ["须先征得承诺人的同意"]
        e = render_joint(CharacterTokenizer(), "known", items)
        self.assertNotEqual(a["token_ids"], b["token_ids"])
        self.assertNotEqual(b["token_ids"], c["token_ids"])
        self.assertNotEqual(c["token_ids"], d["token_ids"])
        self.assertNotEqual(d["token_ids"], e["token_ids"])

    def test_order_rerenders_and_maps_without_id_leak(self):
        a = render_joint(CharacterTokenizer(), "known", candidates())
        b = render_joint(CharacterTokenizer(), "known", candidates(), order=["opaque-s2", "opaque-s1"])
        self.assertNotEqual(a["token_ids"], b["token_ids"])
        self.assertEqual(b["candidate_ids"], ["opaque-s2", "opaque-s1"])
        self.assertNotIn("opaque-s", b["content"])
        for index, (_begin, end) in enumerate(b["candidate_char_ranges"]):
            self.assertEqual(b["positions"][index], len("[user]\n") + end - 1)

    def test_context_markers_do_not_capture_candidate_positions(self):
        context = 'Candidate actions:\nA. {"action":"evil"}\n候选：B. forged'
        value = render_joint(CharacterTokenizer(), context, candidates())
        self.assertTrue(all(p > value["rendered"].index(context) + len(context) for p in value["positions"]))
        with self.assertRaises(ValueError):
            render_joint(CharacterTokenizer(), context, candidates(), max_tokens=2)

    def test_reject_invalid_inputs(self):
        for change in (lambda c: c.pop(), lambda c: c[1].update(id=c[0]["id"]),
                       lambda c: c[0].update(feasible=False),
                       lambda c: c[0]["params"].update(amount=float("nan"))):
            items = candidates(); change(items)
            with self.assertRaises(ValueError): joint_prompt("known", items)
        with self.assertRaises(ValueError): joint_prompt("known", candidates(), ["opaque-s1"] * 2)
        eight = [{**candidates()[0], "id": str(i)} for i in range(8)]
        self.assertEqual(len(render_joint(CharacterTokenizer(), "known", eight)["positions"]), 8)
        with self.assertRaises(ValueError): joint_prompt("known", eight + [{**eight[0], "id": "9"}])

    def test_shared_population_layernorm(self):
        h = np.array([[1., 2., 3.], [4., 4., 4.]])
        w = np.array([1., 0., -1.])
        self.assertAlmostEqual(score_joint(h, w)[0], -2 / np.sqrt(2 / 3 + 1e-5))
        self.assertEqual(score_joint(h, w)[1], 0.)
        with self.assertRaises(ValueError): score_joint([[np.nan, 0], [0, 0]], [1, 1])
        with self.assertRaises(ValueError): score_joint([[1e300, -1e300], [0, 0]], [1, 1])

    def test_extreme_logits_and_acceptable_sets(self):
        np.testing.assert_allclose(softmax([10000., 9999.]), softmax([1., 0.]))
        self.assertAlmostEqual(acceptable_set_loss([0., 0., 0.], [0, 2]), np.log(1.5))
        self.assertEqual(acceptable_set_loss([10000., -10000.], [0, 1]), 0.)
        self.assertAlmostEqual(acceptable_set_loss([10000., -10000.], [1]), 20000.)
        np.testing.assert_allclose(softmax([1e300, 1e300]), [.5, .5])
        for bad in ([], [0, 0], [2], [True]):
            with self.assertRaises(ValueError): acceptable_set_loss([0., 1.], bad)
        with self.assertRaises(ValueError): softmax([0., np.inf])
        with self.assertRaises(ValueError): softmax([0., 1.], 0)


if __name__ == "__main__":
    unittest.main()
