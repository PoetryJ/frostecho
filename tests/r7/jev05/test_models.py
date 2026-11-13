"""CPU mechanism tests only. No research/model performance claims."""
from __future__ import annotations

import copy
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
MODELS = ROOT / "research" / "decision-choice" / "jev05" / "models"
sys.path.insert(0, str(MODELS))
from contracts import canonical, digest, file_sha, qualify, render_candidates, validate_case, visible, write_json
from cache import encode_cache, load_cache
from head import load_checkpoint, normalized, score_features, set_loss_gradient, train_model
from cli import scored_row


def case(key="sample", split="train"):
    return {"caseId": key, "context": {"observed": "empty warehouse", "goal": "deliver food"},
            "candidates": [{"id": "a", "text": "Gather food", "params": {"action": "gather"}},
                           {"id": "b", "text": "Withdraw from empty warehouse", "params": {"action": "withdraw"}}],
            "acceptableIds": ["a"], "split": split}


class FakeEncoder:
    dimension = 3
    identity = {"backend": "unit-test", "evidenceClass": "unit-test", "dimension": 3}
    identity["encoderSha256"] = digest(identity)

    def __init__(self):
        self.calls = 0

    def encode_case(self, value):
        self.calls += 1
        return np.array([[1, 0, 1], [0, 1, 1]], dtype=np.float32), [14, 18]


class ModelMechanismTests(unittest.TestCase):
    def test_full_candidate_render_and_permutation(self):
        value = case()
        value["context"]["long"] = "history " * 800
        first = render_candidates(value)
        value["candidates"].reverse()
        self.assertEqual(render_candidates(value), list(reversed(first)))
        self.assertIn('"action":"gather"', first[0])
        self.assertIn("history " * 800, first[0])
        self.assertNotIn("acceptableIds", first[0])

    def test_set_loss_has_correct_gradient(self):
        values = np.array([0.7, -1.2, 0.9])
        _, gradient = set_loss_gradient(values, [0, 2])
        numerical = []
        for index in range(3):
            bump = np.zeros(3)
            bump[index] = 1e-5
            numerical.append((set_loss_gradient(values + bump, [0, 2])[0] - set_loss_gradient(values - bump, [0, 2])[0]) / 2e-5)
        np.testing.assert_allclose(gradient, numerical, atol=1e-7)
        self.assertLess(set_loss_gradient([1000, -1000], [0])[0], 1e-8)
        self.assertAlmostEqual(set_loss_gradient([4, 5], [0, 1])[0], 0)

    def test_cache_resume_and_corruption(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            source = root / "cases.jsonl"
            source.write_text(canonical(case()) + "\n", encoding="utf-8")
            encoder = FakeEncoder()
            manifest = encode_cache(source, root / "cache", encoder)
            self.assertEqual(encoder.calls, 1)
            encode_cache(source, root / "cache", encoder)
            self.assertEqual(encoder.calls, 1)
            with self.assertRaisesRegex(ValueError, "real encoded"):
                load_cache(root / "cache")
            load_cache(root / "cache", require_real=False)
            (root / "cache" / "features-000000.npy").write_bytes(b"bad")
            with self.assertRaisesRegex(ValueError, "bytes changed"):
                load_cache(root / "cache", require_real=False)

    def test_head_learns_then_reloads_in_new_process(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            cases = {str(i): case(str(i), "train" if i < 16 else "dev") for i in range(20)}
            features = {key: np.array([[1, 0, 0.2], [0, 1, 0.2]], dtype=np.float32) for key in cases}
            report = train_model(cases, features, root, {"evidenceClass": "unit-test", "encoderSha256": "unit-test"}, epochs=20, seed=17)
            self.assertEqual(report["dev"]["top1InAcceptable"], 1)
            self.assertFalse(report["executionAdmitted"])
            manifest, weights = load_checkpoint(root)
            first = score_features(weights, features["0"])
            script = "import sys,json,numpy as np;sys.path.insert(0,sys.argv[1]);from head import load_checkpoint,score_features;m,w=load_checkpoint(sys.argv[2]);print(json.dumps(score_features(w,np.array([[1,0,.2],[0,1,.2]],dtype=np.float32)).tolist()))"
            other = subprocess.run([sys.executable, "-c", script, str(MODELS), str(root)], check=True, capture_output=True, text=True)
            np.testing.assert_array_equal(first, json.loads(other.stdout))
            np.testing.assert_allclose(score_features(weights, features["0"][::-1]), first[::-1], atol=0)
            with self.assertRaisesRegex(ValueError, "mechanism"):
                scored_row(cases["0"], features["0"], manifest, weights)

    def test_gate_rejects_unbound_review_and_small_counts(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            value = case()
            value.update(sourceGroup="source-1", templateFamily="family-1", origin={"type": "world-event", "source": "trace"})
            value["contentHash"] = validate_case(value)
            reviews = [{"caseId": "sample", "contentHash": value["contentHash"], "acceptableIds": ["a"],
                        "status": "supported", "blind": True, "sessionId": f"s{index}", "reviewerId": f"r{index}",
                        "rawResponse": "unit-test simulated review"} for index in range(2)]
            board = {"caseId": "sample", "contentHash": value["contentHash"], "acceptableIds": ["a"],
                     "status": "supported", "reviewASha256": digest(reviews[0]), "reviewBSha256": digest(reviews[1])}
            files = {}
            for name, data in (("cases", value), ("reviewA", reviews[0]), ("reviewB", reviews[1]), ("adjudications", board)):
                path = root / (name + ".jsonl")
                path.write_text(canonical(data) + "\n", encoding="utf-8")
                files[name] = {"path": path.name, "sha256": file_sha(path)}
            trace = root / "trace.json"
            trace.write_text('{"unitTest":true}', encoding="utf-8")
            manifest = {"schema": "frostecho.jev05.qualification/1", "files": files,
                        "sources": {"trace": {"path": trace.name, "sha256": file_sha(trace)}}}
            write_json(root / "qualification.json", manifest)
            with self.assertRaisesRegex(ValueError, "train=1/512"):
                qualify(root / "qualification.json")
            reviews[0]["contentHash"] = "forged"
            path = root / "reviewA.jsonl"
            path.write_text(canonical(reviews[0]) + "\n", encoding="utf-8")
            manifest["files"]["reviewA"]["sha256"] = file_sha(path)
            write_json(root / "qualification.json", manifest)
            with self.assertRaisesRegex(ValueError, "review not"):
                qualify(root / "qualification.json")

    def test_hash_covers_candidate_parameters(self):
        value = case()
        value["contentHash"] = validate_case(value)
        value["candidates"][0]["params"]["amount"] = 2
        with self.assertRaisesRegex(ValueError, "contentHash"):
            validate_case(value)


if __name__ == "__main__":
    unittest.main()
