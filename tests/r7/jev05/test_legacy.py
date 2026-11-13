"""Read-only historical identity and cache-contract checks, without a GPU."""
import importlib.util
import tempfile
import unittest
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("jev05_legacy_runner", ROOT / "research/decision-choice/jev05/legacy/runner.py")
legacy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(legacy)


class LegacyContractTests(unittest.TestCase):
    def test_actual_archived_c_checkpoint_matches_training_record(self):
        source = ROOT / "research/decision-choice/jev03"
        record = legacy.checkpoint_record(source / "runs/C-seed43/best.safetensors", source / "runs/trainings.json")
        self.assertEqual(record["fileSha256"], "a55cc47f1c30353b9c1a38e6de3d79e1765a26412b215486d40e06e04514c989")
        self.assertEqual(record["meta"]["featureIdentityHash"], "555f5f55f6f8037508067331c11e548e671e881fb5312e9d5cb62b0f0828e159")

    def test_four_order_cache_required_and_identity_bound(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "features-train.npz"
            np.savez(path, cand=np.zeros((4, 4, 5120), dtype=np.float32))
            identity = {"testOnly": True}
            sha = legacy.digest(identity)
            meta = {"featureIdentityHash": sha, "featureIdentity": identity, "split": "train",
                    "caseIds": ["one"] * 4, "orderIds": [0, 1, 2, 3], "tokenHash": ["unit"] * 4}
            legacy.write(path.with_suffix(".meta.json"), meta)
            loaded = legacy.load_cache(path, sha)
            self.assertEqual(loaded["cand"].shape, (4, 4, 5120))
            meta["orderIds"][-1] = 2
            legacy.write(path.with_suffix(".meta.json"), meta)
            with self.assertRaisesRegex(ValueError, "duplicate"):
                legacy.load_cache(path, sha)

    def test_no_output_inside_archive(self):
        with tempfile.TemporaryDirectory() as temp:
            with self.assertRaisesRegex(ValueError, "outside"):
                legacy.output_directory(Path(temp) / "runs/new", temp)

    def test_explicit_migration_and_reviewed_subset_preserve_identity(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            path = root / "features-increment.npz"
            np.savez(path, cand=np.zeros((8, 4, 5120), dtype=np.float32))
            new_identity = {"testOnly": True, "deviceMap": "new-runtime"}
            new_sha = legacy.digest(new_identity)
            anchors = [{"tokenMatch": True, "predictionMatch": True} for _ in range(16)]
            anchor_file = root / "anchor-records.jsonl"
            anchor_file.write_text("".join(legacy.canonical(row) + "\n" for row in anchors), encoding="utf-8")
            compatibility = {"legacyFeatureIdentityHash": "old", "newFeatureIdentityHash": new_sha,
                             "checkpointSha256": "head", "anchorSplit": "train", "presentations": 16,
                             "allTokenHashesEqual": True, "predictionMismatches": 0, "compatibleForWarmStart": True,
                             "anchorRecordsSha256": legacy.sha(anchor_file)}
            legacy.write(root / "compatibility.json", compatibility)
            item = {"caseId": "kept", "context": "context", "playerText": "player", "labelId": "PLAYER_FIRST", "split": "train", "groupId": "g"}
            data_file = root / "train.jsonl"
            data_file.write_text(legacy.canonical(item) + "\n", encoding="utf-8")
            meta = {"featureIdentityHash": new_sha, "featureIdentity": new_identity, "split": "pending",
                    "caseIds": ["kept"] * 4 + ["excluded"] * 4, "orderIds": [0, 1, 2, 3] * 2,
                    "tokenHash": ["unit"] * 8, "inputHashes": [legacy.visible_hash(item)] * 4 + ["excluded"] * 4,
                    "compatibilityPath": "compatibility.json", "compatibilitySha256": legacy.sha(root / "compatibility.json")}
            legacy.write(path.with_suffix(".meta.json"), meta)
            with self.assertRaisesRegex(ValueError, "explicit"):
                legacy.load_cache(path, "old")
            selected = legacy.load_cache(path, "old", data_path=data_file, expected_split="train",
                                         allow_device_migration=True, expected_checkpoint_sha="head")
            self.assertEqual(selected["ids"], ["kept"] * 4)
            self.assertEqual(selected["provenance"]["featureIdentityHash"], new_sha)
            self.assertEqual(selected["provenance"]["legacyFeatureIdentityHash"], "old")
            self.assertEqual(selected["provenance"]["selectedSourceRows"], [0, 1, 2, 3])
            self.assertEqual(len(legacy.read(path.with_suffix(".meta.json"))["caseIds"]), 8)


if __name__ == "__main__":
    unittest.main()
