"""R11 C line: the shared manifest contract must fail closed.

Every test builds real bytes (a real [1,5120] safetensors head, real
qualification files) and mutates one field at a time.  A mutation must be
refused with a stable code, and the service must refuse before any encoder is
constructed.
"""
from __future__ import annotations

import copy
import hashlib
import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path

import numpy as np
from safetensors.numpy import save_file

R11 = Path(__file__).resolve().parents[1]
ACTION = R11.parent / "jev05" / "action"
sys.path.insert(0, str(R11))
sys.path.insert(0, str(ACTION))
import manifest_contract as contract  # noqa: E402


def sha(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def write_qualification(directory: Path, identity_hash: str) -> dict:
    features = directory / "qualification-features.npz"
    with features.open("wb") as stream:
        np.savez(stream, batch1=np.zeros((2, 5120), dtype=np.float32))
    sealed = {"schema": "frostecho.batch-qualification/1", "ok": True,
              "featureIdentityHash": identity_hash, "relativeL2": 0.0,
              "maxAbs": 0.0, "duplicateMaxAbs": 0.0}
    path = directory / "qualification.json"
    path.write_text(json.dumps(sealed, sort_keys=True) + "\n", encoding="utf-8")
    return {"path": path.name, "sha256": sha(path), "featuresSha256": sha(features),
            "ok": True, "featureIdentityHash": identity_hash}


def build(directory: Path, *, label_source="same-snapshot-branch-rollout",
          schema=contract.SCHEMA_V2) -> tuple[Path, Path, dict]:
    head = directory / "warm-17.safetensors"
    weight = np.linspace(-1.0, 1.0, 5120, dtype=np.float32).reshape(1, 5120)
    save_file({"score.weight": weight}, str(head))
    feature_identity = {
        "schema": "frostecho.joint-c-feature-identity/1", "modelPath": "/model",
        "class": "Qwen3_5ForCausalLM", "torch": "2.6", "transformers": "4.57",
        "precision": "bfloat16", "quantization": "none", "attention": "eager",
        "deviceMap": {"model.layers.0": "0"}, "actualParameterBytesByDevice": {"cuda:0": 1},
        "rotaryBufferDevices": {"inv_freq": "cpu"}, "physicalGpus": [1],
        "metadataSha256": {"config.json": "a" * 64},
        "encoderSourceSha256": sha(ACTION / "joint_encoder.py"),
        "weightIdentityScope": "local checkpoint metadata",
        "readout": "joint-candidate-end-token", "dimension": 5120,
        "padding": "right-masked-position-ids/1", "padMultiple": 8,
        "rendererSourceSha256": sha(R11.parents[2] / "src/r7/jev/render.ts")}
    identity_hash = contract.stable_sha(feature_identity)
    qualification = write_qualification(directory, identity_hash)
    (directory / "records.jsonl").write_text("{}\n", encoding="utf-8")
    (directory / "features.npz").write_bytes(b"cache-placeholder")
    corpus = directory / "corpus.jsonl"
    corpus.write_text("{}\n", encoding="utf-8")
    document = {
        "schema": schema, "experimental": True, "countsAsAdmitted": False,
        "calibrated": False, "researchTrainReady": False, "mayTrainOnJev": False,
        "labelSource": label_source,
        "labelRule": "first-action-admitted && actor-alive && no-population-loss && "
                     "no-accepted-task-lost",
        "independentReviews": 2,
        "selectedCheckpoint": head.name, "selectedCheckpointSha256": sha(head),
        "featureIdentity": feature_identity, "featureIdentityHash": identity_hash,
        "encodingExecution": {"batchSize": 1, "padMultiple": 8, "maxTokens": 2048,
                              "placement": "auto"},
        "encodingQualification": qualification,
        "cacheSha256": sha(directory / "features.npz"),
        "recordsSha256": sha(directory / "records.jsonl"),
        "corpusSha256": sha(corpus), "corpusSplits": {"train": 1, "dev": 1, "test": 1},
        "memory": {"policy": "conditional-experience", "selection": "obligation-first",
                   "tokenBudget": 640, "renderer": "joint-c-action/2"},
        "deadlineProtocol": {"continuationPolicy": "reference-rule/1",
                             "horizonMinutes": 240, "absolute": True,
                             "pendingIsNotFailure": True},
        "splitUnit": "sourceEpisodeId",
        "trainingCodeSha256": sha(Path(__file__)),
        "backboneGradients": 0, "backboneLoadedByTrainer": False,
        "selection": "lowest unrounded dev set-NLL",
    }
    manifest = directory / "training-manifest.json"
    manifest.write_text(json.dumps(document, sort_keys=True) + "\n", encoding="utf-8")
    return manifest, head, document


class ManifestContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="r11-manifest-")
        self.dir = Path(self.tmp.name)
        self.manifest, self.head, self.document = build(self.dir)

    def tearDown(self):
        self.tmp.cleanup()

    def rewrite(self, mutate, *, rehash=True) -> Path:
        document = copy.deepcopy(self.document)
        mutate(document)
        if rehash:
            document["featureIdentityHash"] = contract.stable_sha(document["featureIdentity"])
        self.manifest.write_text(json.dumps(document, sort_keys=True) + "\n", encoding="utf-8")
        return self.manifest

    def validate(self, **kwargs):
        return contract.validate(
            self.manifest, self.head, renderer_source=R11.parents[2] / "src/r7/jev/render.ts",
            encoder_source=ACTION / "joint_encoder.py",
            memory={"policy": "conditional-experience", "selection": "obligation-first",
                    "tokenBudget": 640},
            features_dir=self.dir, corpus=self.dir / "corpus.jsonl", **kwargs)

    def assert_refused(self, code, mutate=None, *, rehash=True, **kwargs):
        if mutate is not None:
            self.rewrite(mutate, rehash=rehash)
        with self.assertRaises(contract.Refusal) as caught:
            self.validate(**kwargs)
        self.assertEqual(caught.exception.code, code)

    def test_valid_branch_manifest_reports_both_label_sources_and_bindings(self):
        report = self.validate()
        self.assertEqual(report["contractVersion"], 2)
        self.assertEqual(report["labelSource"], contract.LABEL_BRANCH)
        self.assertEqual(report["deadlineProtocol"]["horizonMinutes"], 240)
        self.assertEqual(report["memory"]["tokenBudget"], 640)
        self.assertEqual(report["qualification"]["sha256"],
                         sha(self.dir / "qualification.json"))
        self.assertFalse(report["countsAsAdmitted"])

    def test_the_integration_schema_alias_is_the_same_contract(self):
        self.rewrite(lambda d: d.update(schema=contract.SCHEMA_R11))
        report = self.validate()
        self.assertEqual(report["contractVersion"], 2)
        self.assertEqual(report["schemaCanonical"], contract.SCHEMA_R11)

    def test_reference_imitation_is_accepted_by_the_same_contract(self):
        self.rewrite(lambda d: d.update(labelSource=contract.LABEL_REFERENCE,
                                       deadlineProtocol=None))
        report = self.validate()
        self.assertEqual(report["labelSource"], contract.LABEL_REFERENCE)

    def test_missing_manifest_is_refused_before_importing_torch(self):
        self.assertNotIn("torch", sys.modules)
        with self.assertRaises(contract.Refusal) as caught:
            contract.validate(self.dir / "absent.json", self.head)
        self.assertEqual(caught.exception.code, "manifest-missing")
        self.assertNotIn("torch", sys.modules)

    def test_unknown_label_source_and_v1_branch_are_both_refused(self):
        self.assert_refused("label-source",
                            lambda d: d.update(labelSource="human-preference"))
        self.assert_refused(
            "label-source",
            lambda d: d.update(schema=contract.SCHEMA_V1))

    def test_admission_flags_cannot_be_flipped(self):
        for field in ("experimental", "countsAsAdmitted", "calibrated",
                      "researchTrainReady", "mayTrainOnJev"):
            with self.subTest(field=field):
                self.rewrite(lambda d: d.update({**self.document, field: not self.document[field]}))
                self.assert_refused("manifest-admission-flags")

    def test_head_sha_name_and_tensor_are_bound(self):
        self.assert_refused("head-sha", lambda d: d.update(selectedCheckpointSha256="b" * 64))
        self.assert_refused("head-name", lambda d: d.update(selectedCheckpoint="other.safetensors"))
        from safetensors.numpy import save_file as save
        save({"score.weight": np.zeros((1, 5120), dtype=np.float32),
              "extra": np.zeros(1, dtype=np.float32)}, str(self.head))
        self.rewrite(lambda d: d.update(selectedCheckpointSha256=sha(self.head)))
        self.assert_refused("head-tensor")

    def test_feature_identity_renderer_and_encoder_drift_are_refused(self):
        self.assert_refused("feature-identity-hash",
                            lambda d: d.update(featureIdentityHash="c" * 64), rehash=False)
        self.assert_refused(
            "feature-identity-renderer",
            lambda d: d["featureIdentity"].update(rendererSourceSha256="d" * 64))
        self.assert_refused(
            "feature-identity-encoder",
            lambda d: d["featureIdentity"].update(encoderSourceSha256="e" * 64))
        self.assert_refused(
            "feature-identity-dimension",
            lambda d: d["featureIdentity"].update(dimension=4096))

    def test_execution_and_qualification_bytes_are_checked(self):
        self.assert_refused("encoding-execution",
                            lambda d: d["encodingExecution"].update(batchSize=2))
        self.assert_refused("encoding-execution",
                            lambda d: d["encodingExecution"].update(placement="cpu"))
        self.assert_refused("encoding-qualification",
                            lambda d: d["encodingQualification"].update(ok=False))
        self.rewrite(lambda d: None)
        (self.dir / "qualification.json").write_text("{}\n", encoding="utf-8")
        self.assert_refused("encoding-qualification-bytes")

    def test_memory_corpus_and_deadline_protocol_are_bound(self):
        self.assert_refused("memory-identity",
                            lambda d: d["memory"].update(tokenBudget=512))
        self.assert_refused("corpus-sha", lambda d: d.update(corpusSha256="f" * 64))
        self.assert_refused("deadline-protocol", lambda d: d.pop("deadlineProtocol"))
        self.assert_refused("deadline-protocol",
                            lambda d: d["deadlineProtocol"].update(absolute=False))
        self.assert_refused("deadline-protocol",
                            lambda d: d["deadlineProtocol"].update(pendingIsNotFailure=False))

    def test_backbone_training_claims_are_refused(self):
        self.assert_refused("backbone", lambda d: d.update(backboneGradients=1))
        self.assert_refused("backbone", lambda d: d.update(backboneLoadedByTrainer=True))

    def test_cli_exits_two_and_writes_the_refusal(self):
        out = self.dir / "report.json"
        code = contract.main(["--manifest", str(self.dir / "absent.json"),
                              "--head", str(self.head), "--json-out", str(out)])
        self.assertEqual(code, 2)
        self.assertEqual(json.loads(out.read_text())["code"], "manifest-missing")


class ServeContractTests(unittest.TestCase):
    """The service must reject before constructing the encoder."""

    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location("r11_serve", ACTION / "serve_joint.py")
        cls.serve = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.serve)

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="r11-serve-")
        self.dir = Path(self.tmp.name)
        self.manifest, self.head, self.document = build(self.dir)

    def tearDown(self):
        self.tmp.cleanup()

    def run_service(self, extra):
        from unittest.mock import patch
        import contextlib
        import io

        class FakeEncoder:
            identity = {"fake": True}

            def __init__(self, *args, **kwargs):
                calls.append(args)

            def feature_identity(self, pad_multiple=8):
                return {"schema": "UNIT-TEST-ONLY"}

        calls = []
        out, err = io.StringIO(), io.StringIO()
        with patch.object(self.serve, "JointEncoder", FakeEncoder), \
                patch.object(self.serve.sys, "stdin", io.StringIO("")), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = self.serve.main(["--head", str(self.head),
                                    "--physical-gpus", "1", *extra])
        return code, out.getvalue(), err.getvalue(), calls

    def test_missing_manifest_refuses_before_model_load(self):
        code, out, err, calls = self.run_service([])
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertEqual(calls, [])
        self.assertIn("training-manifest is required", err)

    def test_tampered_manifest_refuses_before_model_load(self):
        document = copy.deepcopy(self.document)
        document["featureIdentity"]["rendererSourceSha256"] = "0" * 64
        document["featureIdentityHash"] = contract.stable_sha(document["featureIdentity"])
        self.manifest.write_text(json.dumps(document, sort_keys=True) + "\n")
        code, out, err, calls = self.run_service(["--training-manifest", str(self.manifest)])
        self.assertEqual(code, 2)
        self.assertEqual(out, "")
        self.assertEqual(calls, [])
        self.assertIn("feature-identity-renderer", err)

    def test_bound_v2_reply_carries_the_manifest_sha(self):
        from unittest.mock import patch
        import contextlib
        import io

        import numpy as np
        from test_joint_encoder import CharacterTokenizer
        from test_serve_joint import request as serve_request

        declared = copy.deepcopy(self.document["featureIdentity"])

        class FakeEncoder:
            identity = {"fake": True}

            def __init__(self, *args, **kwargs):
                self.tokenizer = CharacterTokenizer()

            def feature_identity(self, pad_multiple=8):
                return copy.deepcopy(declared)

            def encode_batch(self, rows, pad_multiple):
                features = np.tile(np.arange(5120, dtype=np.float32), (2, 1))
                features[1] *= -1
                return [features], {"rows": [{"tokens": 1}], "forwardSeconds": 0.0}

        weights = np.zeros(5120, dtype=np.float32)
        weights[0] = -1
        row = serve_request()
        out, err = io.StringIO(), io.StringIO()
        with patch.object(self.serve, "JointEncoder", FakeEncoder), \
                patch.object(self.serve, "load_head", return_value=weights), \
                patch.object(self.serve.sys, "stdin", io.StringIO(json.dumps(row) + "\n")), \
                contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = self.serve.main(["--head", str(self.head),
                                    "--training-manifest", str(self.manifest),
                                    "--physical-gpus", "1"])
        self.assertEqual(code, 0, err.getvalue())
        reply = json.loads(out.getvalue().strip())
        self.assertTrue(reply["bound"])
        self.assertEqual(reply["manifestSha256"], sha(self.manifest))
        self.assertEqual(reply["identity"]["manifestSha256"], sha(self.manifest))
        self.assertEqual(reply["identity"]["manifestContractVersion"], 2)
        self.assertEqual(reply["identity"]["labelSource"],
                         "same-snapshot-branch-rollout")
        self.assertNotEqual(reply["disposition"], "error")

    def test_unbound_diagnostic_never_selects_an_action(self):
        code, out, err, calls = self.run_service(["--diagnostic-unbound"])
        self.assertEqual(code, 0)
        startup = json.loads(err.strip().splitlines()[0])
        self.assertFalse(startup["identity"]["bound"])
        self.assertIsNone(startup["identity"]["manifestSha256"])
        self.assertEqual(len(calls), 1)


if __name__ == "__main__":
    unittest.main()
