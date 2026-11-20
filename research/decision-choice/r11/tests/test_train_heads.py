"""R11 C line: the trainer mechanics on a synthetic (fixture) cache.

The data here is random and exists only to exercise the gates, the four-head
recipe, dev selection and the emitted /2 manifest.  It is not evidence about
any real head.
"""
from __future__ import annotations

import hashlib
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from safetensors.numpy import save_file

R11 = Path(__file__).resolve().parents[1]
REPO = R11.parents[2]
sys.path.insert(0, str(R11))
import manifest_contract as contract  # noqa: E402

HIDDEN = 5120


def sha(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(json.dumps(row, sort_keys=True) + "\n" for row in rows))


def build_fixture(directory: Path) -> tuple[Path, Path, Path, Path]:
    cache = directory / "cache"
    cache.mkdir()
    episodes = {"train": ["ep-tr"], "dev": ["ep-dev"], "test": ["ep-te"]}
    cases, records, features, offsets, ids = [], [], [], [0], []
    rng = np.random.default_rng(7)
    for split, group in episodes.items():
        for index in range(2):
            case_id = f"{split}-{index}"
            candidates = [{"id": f"c{index}a", "kind": "work", "description": "采集"},
                          {"id": f"c{index}b", "kind": "wait", "description": "等待"}]
            request = {"requestId": case_id, "candidateSetHash": case_id,
                       "candidates": candidates, "goals": []}
            request_json = json.dumps(request, sort_keys=True)
            envelope = {"schema": "frostecho.joint-encoding-request/1",
                        "request": request, "requestJson": request_json,
                        "inputSha256": hashlib.sha256(request_json.encode()).hexdigest(),
                        "renderedTextSha256": f"text-{split}-{index}",
                        "rendererSourceSha256": sha(REPO / "src/r7/jev/render.ts"),
                        "rendered": {"text": f"observation {split} {index}"}}
            acceptable = [candidates[0]["id"]] if index == 0 else []
            cases.append({"caseId": case_id, "split": split, "sourceEpisodeId": group[0],
                          "story": "cancel-heard", "fulfillmentDefined": True,
                          "deadline": {"horizonMinutes": 240, "t0": 480, "tStar": 720,
                                       "basis": "frozen-default"},
                          "acceptableIds": acceptable,
                          "acceptableFulfillmentIds": [candidates[0]["id"]],
                          "labelRule": "fixture-rule",
                          "envelope": envelope})
            records.append({"caseId": case_id, "candidateIds": [row["id"] for row in candidates],
                            "inputSha256": envelope["inputSha256"]})
            vector = rng.normal(size=(2, HIDDEN)).astype(np.float32)
            features.append(vector)
            offsets.append(offsets[-1] + vector.shape[0])
            ids.extend(row["id"] for row in candidates)
    np.savez(cache / "features.npz", cand=np.concatenate(features),
             rowOffsets=np.asarray(offsets, dtype=np.int64),
             caseIds=np.asarray([row["caseId"] for row in cases], dtype=np.str_),
             candidateIds=np.asarray(ids, dtype=np.str_))
    write_jsonl(cache / "records.jsonl", records)
    identity = {
        "schema": "frostecho.joint-c-feature-identity/1", "modelPath": "/model",
        "class": "Qwen3_5ForCausalLM", "torch": "2.6", "transformers": "4.57",
        "precision": "bfloat16", "quantization": "none", "attention": "eager",
        "deviceMap": {"model.layers.0": "0"}, "actualParameterBytesByDevice": {"cuda:0": 1},
        "rotaryBufferDevices": {"inv_freq": "cpu"}, "physicalGpus": [1],
        "metadataSha256": {"config.json": "a" * 64},
        "encoderSourceSha256": sha(R11.parent / "jev05/action/joint_encoder.py"),
        "weightIdentityScope": "fixture", "readout": "joint-candidate-end-token",
        "dimension": HIDDEN, "padding": "right-masked-position-ids/1", "padMultiple": 8,
        "rendererSourceSha256": sha(REPO / "src/r7/jev/render.ts")}
    with (cache / "qualification-features.npz").open("wb") as stream:
        np.savez(stream, batch1=np.zeros((2, HIDDEN), dtype=np.float32))
    sealed = {"ok": True, "featureIdentityHash": contract.stable_sha(identity)}
    (cache / "qualification.json").write_text(json.dumps(sealed) + "\n")
    metadata = {
        "schema": "frostecho.joint-corpus-cache/1", "status": "complete",
        "realEncoder": True, "encoderForwardCalls": 8, "featureIdentity": identity,
        "featureIdentityHash": contract.stable_sha(identity),
        "execution": {"batchSize": 1, "padMultiple": 8, "maxTokens": 2048,
                      "placement": "auto"},
        "cacheSha256": sha(cache / "features.npz"),
        "recordsSha256": sha(cache / "records.jsonl"),
        "qualification": {"path": "qualification.json",
                          "sha256": sha(cache / "qualification.json"),
                          "featuresSha256": sha(cache / "qualification-features.npz")}}
    (cache / "metadata.json").write_text(json.dumps(metadata, indent=2, sort_keys=True))
    corpus = directory / "corpus-fulfillment.jsonl"
    write_jsonl(corpus, cases)
    corpus_base = directory / "corpus-base.jsonl"
    base_rows = [{**row,
                  "acceptableIds": [candidate["id"]
                                    for candidate in row["envelope"]["request"]["candidates"]]
                  if row["caseId"].endswith("0") else []
                  } for row in cases]
    write_jsonl(corpus_base, base_rows)
    head = directory / "warm.safetensors"
    save_file({"score.weight": np.zeros((1, HIDDEN), dtype=np.float32)}, str(head))
    return cache, corpus, corpus_base, head


class TrainHeadsTests(unittest.TestCase):
    def test_four_heads_per_family_select_on_dev_and_emit_a_valid_manifest(self):
        with tempfile.TemporaryDirectory(prefix="r11-train-") as raw:
            directory = Path(raw)
            cache, corpus, corpus_base, head = build_fixture(directory)
            for family, path in (("base", corpus_base), ("fulfillment", corpus)):
                out = directory / f"train-{family}"
                run = subprocess.run(
                    [sys.executable, str(R11 / "train-heads.py"), "--family", family,
                     "--corpus", str(path), "--features-dir", str(cache),
                     "--training-manifest", str(cache / "metadata.json"),
                     "--head", str(head), "--output-dir", str(out),
                     "--renderer-source", str(REPO / "src/r7/jev/render.ts"),
                     "--epochs", "2", "--batch-size", "2"],
                    capture_output=True, text=True, cwd=str(REPO))
                self.assertEqual(run.returncode, 0, run.stderr)
                document = json.loads((out / "training-manifest.json").read_text())
                self.assertEqual(document["schema"], contract.SCHEMA_V2)
                self.assertEqual(len(document["fourHeads"]), 4)
                self.assertEqual({entry["init"] for entry in document["fourHeads"]},
                                 {"warm", "random"})
                self.assertEqual({entry["seed"] for entry in document["fourHeads"]}, {17, 43})
                decisions = json.loads((out / "dev-decisions.json").read_text())
                self.assertFalse(decisions["testTouched"])
                report = contract.validate(
                    out / "training-manifest.json", out / document["selectedCheckpoint"],
                    renderer_source=REPO / "src/r7/jev/render.ts",
                    encoder_source=R11.parent / "jev05/action/joint_encoder.py",
                    memory={"policy": "conditional-experience",
                            "selection": "obligation-first", "tokenBudget": 640},
                    features_dir=cache, corpus=path)
                self.assertEqual(report["contractVersion"], 2)
                self.assertEqual(report["labelSource"], "same-snapshot-branch-rollout")
                self.assertEqual(report["deadlineProtocol"]["horizonMinutes"], 240)
                first = subprocess.run(
                    [sys.executable, str(R11 / "eval-test-once.py"), "--family", family,
                     "--corpus", str(path), "--features-dir", str(cache),
                     "--output-dir", str(out),
                     "--renderer-source", str(REPO / "src/r7/jev/render.ts")],
                    capture_output=True, text=True, cwd=str(REPO))
                self.assertEqual(first.returncode, 0, first.stderr)
                second = subprocess.run(
                    [sys.executable, str(R11 / "eval-test-once.py"), "--family", family,
                     "--corpus", str(path), "--features-dir", str(cache),
                     "--output-dir", str(out),
                     "--renderer-source", str(REPO / "src/r7/jev/render.ts")],
                    capture_output=True, text=True, cwd=str(REPO))
                self.assertEqual(second.returncode, 2)
                self.assertIn("test-already-evaluated", second.stderr)


if __name__ == "__main__":
    unittest.main()
