"""R5 gate tests: data entry, port evidence, download path, encoder refusal."""
from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve()
JEV = HERE.parents[1]
DATA_V4 = JEV / "data" / "v4"
MODELS = JEV / "models"
SCORERS = JEV / "scorers"
sys.path.insert(0, str(SCORERS))
sys.path.insert(0, str(MODELS))


def module(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    sys.modules[name] = value
    spec.loader.exec_module(value)
    return value


validate_v4 = module("r5_validate_v4", DATA_V4 / "validate_v4.py")
rejections = module("r5_rejections", DATA_V4 / "rejections.py")
encoder_train = module("r5_encoder_train", MODELS / "encoder_train.py")
prepare_t27 = module("r5_prepare_t27", MODELS / "prepare_t27.py")
port = module("r5_port_v3", SCORERS / "port_v3.py")


def run_validator(directory: Path) -> tuple[int, dict]:
    result = subprocess.run([sys.executable, str(DATA_V4 / "validate_v4.py"),
                             "--dir", str(directory)], capture_output=True, text=True)
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError:
        payload = {"stdout": result.stdout, "stderr": result.stderr}
    return result.returncode, payload


def write_json(path: Path, payload: dict) -> dict:
    path.write_text(json.dumps(payload), encoding="utf-8")
    return {"path": str(path),
            "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


class DataGateTests(unittest.TestCase):
    def test_current_v4_is_structurally_valid_but_not_ready(self):
        failures, summary = validate_v4.check(DATA_V4)
        self.assertEqual(failures, [])
        self.assertEqual(summary["cases"], 39)
        self.assertEqual(summary["s1"], 39)
        self.assertEqual(summary["s2"], 39)
        self.assertEqual(summary["adjudicated"], 39)
        self.assertFalse(summary["researchTrainReady"])
        self.assertEqual(summary["qualifiedTrain"], 0)

    def test_candidate_text_and_params_change_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = rejections.build_fixture(root)
            fixture["cases"][0]["candidates"][0]["text"] = "never reviewed"
            fixture["cases"][0]["candidates"][0]["params"] = {"action": "withdraw"}
            rejections.write_rows(root / "cases.v4.jsonl", fixture["cases"])
            code, payload = run_validator(root)
            self.assertNotEqual(code, 0)
            self.assertTrue(any("content_hash_mismatch" in item
                                for item in payload["failures"]))

    def test_illegal_training_label_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = rejections.build_fixture(root)
            fixture["train"][0]["label"] = "not-a-candidate"
            fixture["train"][0]["acceptableOpaque"] = ["not-a-candidate"]
            rejections.write_rows(root / "train.v4.jsonl", fixture["train"])
            code, payload = run_validator(root)
            self.assertNotEqual(code, 0)
            self.assertTrue(any("illegal_label" in item
                                for item in payload["failures"]))

    def test_duplicate_rows_cannot_inflate_512_128(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = rejections.build_fixture(root)
            dev = [json.loads(line) for line in
                   (root / "dev.v4.jsonl").read_text().splitlines() if line.strip()]
            rejections.write_rows(root / "train.v4.jsonl", fixture["train"][:1] * 512)
            rejections.write_rows(root / "dev.v4.jsonl", dev[:1] * 128)
            code, payload = run_validator(root)
            self.assertNotEqual(code, 0)
            self.assertTrue(any("duplicate_ids" in item
                                for item in payload["failures"]))

    def test_group_overlap_is_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            fixture = rejections.build_fixture(root)
            dev = [json.loads(line) for line in
                   (root / "dev.v4.jsonl").read_text().splitlines() if line.strip()]
            for row in fixture["train"]:
                row["sourceGroup"] = "shared-group"
            for row in dev:
                row["sourceGroup"] = "shared-group"
            rejections.write_rows(root / "train.v4.jsonl", fixture["train"])
            rejections.write_rows(root / "dev.v4.jsonl", dev)
            code, payload = run_validator(root)
            self.assertNotEqual(code, 0)
            self.assertTrue(any("group_overlap" in item
                                for item in payload["failures"]))


BASE_IDENTITY = dict(
    model="fixture/r5", head="shared-scalar/1", adapter="jev-choice/1",
    tokenizer="fixture-tok/1", renderer="jev04-render/3",
    task="reference_resolution", k=4, policy_version="softmax-accept/1",
    memory_policy_version="memory-policy/1",
)


def identity():
    return port.ScorerIdentity(**BASE_IDENTITY)


def evidence_payload(partition: str, protocol: str = port.RISK_PROTOCOL_VERSION) -> dict:
    policy = {"model": BASE_IDENTITY["model"], "head": BASE_IDENTITY["head"],
              "tokenizer": BASE_IDENTITY["tokenizer"],
              "renderer": BASE_IDENTITY["renderer"],
              "task": BASE_IDENTITY["task"], "k": BASE_IDENTITY["k"],
              "memory_policy_version": BASE_IDENTITY["memory_policy_version"]}
    payload = {"schema": "frostecho.jev04.evidence/1", "partition": partition,
               "protocol_version": protocol, "valid": True, "policy": policy,
               "sampleIds": [f"{partition}-{index}" for index in range(4)]}
    if partition == "cert":
        payload.update({"upper": 0.03, "n": 120, "errors": 2, "coverage": 0.4,
                        "alpha": 0.05})
    elif partition == "calT":
        payload.update({"temperature": 1.2, "tau": 0.8})
    else:
        payload.update({"tau": 0.8, "accepted": 120, "coverage": 0.4})
    return payload


def manifest(mode: str = "real", evidence: dict | None = None) -> dict:
    return {"schema": port.MANIFEST_SCHEMA, "registrations": [{
        "identity": BASE_IDENTITY, "mode": mode, "utility_source": None,
        "evidence": evidence}]}


class PortEvidenceTests(unittest.TestCase):
    def test_empty_certificate_never_counts_as_real(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            empty = root / "empty.json"
            empty.write_text("{}\n", encoding="utf-8")
            ref = {"path": str(empty),
                   "sha256": hashlib.sha256(empty.read_bytes()).hexdigest()}
            board = manifest(evidence={"calT": ref, "select": ref, "cert": ref,
                                       "protocol_version": port.RISK_PROTOCOL_VERSION})
            art = port.ScorerArtifact(port.ARTIFACT_SCHEMA, identity(), "real", 1.0,
                                      0.3, 0, None)
            request = port.ScorerRequest("r", identity(), ["c0", "c1", "c2", "c3"],
                                         [5, 0, 0, 0])
            out = port.decide(art, request, board)
            self.assertEqual(out.disposition, "shadow_only")
            self.assertFalse(out.counts_as_real)

    def test_fixture_artifact_with_real_registration_never_counts(self):
        board = manifest(evidence=None)
        art = port.ScorerArtifact(port.ARTIFACT_SCHEMA, identity(), "fixture", 1.0,
                                  0.3, 0, None)
        request = port.ScorerRequest("r", identity(), ["c0", "c1", "c2", "c3"],
                                     [5, 0, 0, 0])
        out = port.decide(art, request, board)
        self.assertFalse(out.counts_as_real)

    def test_duplicate_partition_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            refs = {}
            for name in ("calT", "select", "cert"):
                path = root / f"{name}.json"
                refs[name] = write_json(path, evidence_payload("calT"))
            board = manifest(evidence={**refs,
                                       "protocol_version": port.RISK_PROTOCOL_VERSION})
            registration = port.load_trusted_manifest(
                write_json(root / "manifest.json", board)["path"])
            resolved = port.resolve_registration(registration, identity())
            self.assertFalse(resolved.allows_real_execution())

    def test_protocol_mismatch_is_refused(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            refs = {}
            for name in ("calT", "select", "cert"):
                path = root / f"{name}.json"
                refs[name] = write_json(path, evidence_payload(name, "other/1"))
            board = manifest(evidence={**refs,
                                       "protocol_version": port.RISK_PROTOCOL_VERSION})
            registration = port.load_trusted_manifest(
                write_json(root / "manifest.json", board)["path"])
            resolved = port.resolve_registration(registration, identity())
            self.assertFalse(resolved.allows_real_execution())

    def test_valid_distinct_evidence_binds_the_identity(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            refs = {}
            for name in ("calT", "select", "cert"):
                path = root / f"{name}.json"
                refs[name] = write_json(path, evidence_payload(name))
            board = manifest(evidence={**refs,
                                       "protocol_version": port.RISK_PROTOCOL_VERSION})
            registration = port.load_trusted_manifest(
                write_json(root / "manifest.json", board)["path"])
            resolved = port.resolve_registration(registration, identity())
            self.assertTrue(resolved.allows_real_execution())
            # The same registration still cannot make a fixture artifact real.
            art = port.ScorerArtifact(port.ARTIFACT_SCHEMA, identity(), "fixture", 1.0,
                                      0.3, 0, None)
            out = port.decide(art, port.ScorerRequest(
                "r", identity(), ["c0", "c1", "c2", "c3"], [5, 0, 0, 0]), board)
            self.assertFalse(out.counts_as_real)


class DownloadPathTests(unittest.TestCase):
    def test_first_request_and_snapshot_args(self):
        seen: list[str] = []
        snapshot: list[dict] = []

        class Response:
            status = 200

            def read(self) -> bytes:
                return b"{}"

            def __enter__(self):
                return self

            def __exit__(self, *args):
                return False

        def fake_urlopen(url, *args, **kwargs):
            seen.append(str(url))
            return Response()

        import urllib.request
        import huggingface_hub
        original_url = urllib.request.urlopen
        original_snapshot = huggingface_hub.snapshot_download
        try:
            urllib.request.urlopen = fake_urlopen
            def fake_snapshot(repo, **kwargs):
                snapshot.append({"repo": repo, **kwargs})
                return "/tmp/fake-snapshot"
            huggingface_hub.snapshot_download = fake_snapshot
            result = prepare_t27.download("rev-r5")
        finally:
            urllib.request.urlopen = original_url
            huggingface_hub.snapshot_download = original_snapshot
        self.assertEqual(seen[0],
                         "https://huggingface.co/Qwen/Qwen3.5-27B/resolve/rev-r5/config.json")
        self.assertEqual(snapshot[0]["repo"], "Qwen/Qwen3.5-27B")
        self.assertEqual(snapshot[0]["revision"], "rev-r5")
        self.assertIn("--revision rev-r5", result["resumeCommand"])
        self.assertEqual(result["status"], "ok")


class EncoderEntryTests(unittest.TestCase):
    def test_refusal_happens_before_any_model_import(self):
        with tempfile.TemporaryDirectory() as tmp:
            stub = Path(tmp) / "stubs"
            stub.mkdir()
            sentinel = Path(tmp) / "model-imported"
            for name in ("torch.py", "transformers.py"):
                (stub / name).write_text(
                    "import os\n"
                    f"open({str(sentinel)!r}, 'a').write('imported')\n"
                    "def __getattr__(name):\n"
                    "    raise RuntimeError('stub module must not be used')\n",
                    encoding="utf-8")
            env = {**os.environ, "PYTHONPATH": str(stub)}
            result = subprocess.run(
                [sys.executable, str(MODELS / "encoder_train.py"),
                 "--data-dir", str(DATA_V4)],
                capture_output=True, text=True, env=env)
            self.assertEqual(result.returncode, 2, result.stderr)
            self.assertFalse(sentinel.exists(),
                             "the formal entry imported a model despite a closed gate")
            self.assertIn("refused", result.stdout)

    def test_gate_status_does_not_trust_gate_v4_json(self):
        status = encoder_train.gate_status()
        self.assertFalse(status["mayTrainOnJev"])
        self.assertEqual(status["modelLoads"] if "modelLoads" in status else 0, 0)


if __name__ == "__main__":
    unittest.main()
