"""CPU-only protocol/admission tests; fake encoder is never product evidence."""
import contextlib
import copy
import importlib.util
import io
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from test_joint_encoder import CharacterTokenizer, envelope

spec = importlib.util.spec_from_file_location('serve_joint_under_test', Path(__file__).with_name('serve_joint.py'))
serve = importlib.util.module_from_spec(spec)
spec.loader.exec_module(serve)


def request(policy='conditional-experience'):
    value = envelope()
    value['request']['memoryPolicyVersion'] = policy
    value['requestJson'] = json.dumps(value['request'], ensure_ascii=False, separators=(',', ':'))
    value['inputSha256'] = serve.sha256_bytes(value['requestJson'].encode())
    return value


def manifest(head_sha, identity):
    return {'schema': 'frostecho.action-weak-experiment/1', 'experimental': True,
            'countsAsAdmitted': False, 'calibrated': False, 'researchTrainReady': False,
            'mayTrainOnJev': False, 'labelSource': 'reference-imitation', 'independentReviews': 0,
            'selectedCheckpointSha256': head_sha, 'featureIdentity': identity,
            'featureIdentityHash': serve.stable_sha(identity),
            'encodingExecution': {'batchSize': 1, 'padMultiple': 8},
            'encodingQualification': {'path': 'qualification.json', 'sha256': 'a' * 64, 'featuresSha256': 'b' * 64}}


class FakeEncoder:
    calls = 0
    actual_identity = {'schema': 'CPU-TEST-ONLY', 'padding': 8}

    def __init__(self, *args, **kwargs):
        if os.environ.get('CUDA_VISIBLE_DEVICES') != '0,1':
            raise AssertionError('visible devices must be set before loader entry')
        print('fake loader diagnostic must never reach protocol stdout')
        self.identity = {'memoryPlan': {'maxMemoryBytes': {0: 1000, 1: 2000, 'cpu': 3000}}, 'fake': True}
        self.tokenizer = CharacterTokenizer()

    def feature_identity(self, pad_multiple=8):
        return copy.deepcopy(self.actual_identity)

    def encode_batch(self, rows, pad_multiple):
        FakeEncoder.calls += 1
        if len(rows) != 1 or pad_multiple != 8:
            raise AssertionError('online must use the qualified single-row masked protocol')
        print('fake forward diagnostic must remain on stderr')
        features = np.tile(np.arange(5120, dtype=np.float32), (2, 1))
        features[1] *= -1
        return [features], {'rows': [{'tokens': len(rows[0]['tokenIds'])}], 'forwardSeconds': 0.0,
                            'peakCudaAllocatedMiBByLogical': {'0': 0.0, '1': 0.0}, 'fixture': True}


class ServeJointTests(unittest.TestCase):
    def setUp(self):
        FakeEncoder.calls = 0

    def test_policy_numbers_reject_nonfinite_and_invalid_ranges(self):
        for temperature in (0, -1, True, float('nan'), float('inf')):
            with self.assertRaises(ValueError): serve.validate_policy_numbers(temperature, 0.5)
        for tau in (-0.01, 1.01, True, float('nan'), float('inf')):
            with self.assertRaises(ValueError): serve.validate_policy_numbers(1.0, tau)
        serve.validate_policy_numbers(0.1, 0.0)
        serve.validate_policy_numbers(100.0, 1.0)

    def test_layernorm_temperature_accept_and_abstain(self):
        features = np.tile(np.arange(5120, dtype=np.float32), (2, 1))
        features[1] *= -1
        weights = np.zeros(5120, dtype=np.float32)
        weights[0] = -1
        _, cold, best, accept = serve.score_features(features, weights, 0.1, 0.9)
        _, hot, _, abstain = serve.score_features(features, weights, 100.0, 0.9)
        self.assertEqual(best, 0)
        self.assertTrue(accept)
        self.assertFalse(abstain)
        self.assertGreater(cold[0], hot[0])
        features[0, 0] = np.nan
        with self.assertRaises(ValueError): serve.score_features(features, weights, 1, 0)

    def test_manifest_rejects_head_and_identity_changes_and_false_admission(self):
        with tempfile.TemporaryDirectory(prefix='joint-manifest-') as directory:
            path = Path(directory) / 'selected.json'
            valid = manifest('a' * 64, FakeEncoder.actual_identity)
            path.write_text(json.dumps(valid))
            self.assertEqual(serve.load_training_manifest(path, 'a' * 64), valid)
            for mutation in ('head', 'identity', 'admit', 'batch2'):
                bad = copy.deepcopy(valid)
                if mutation == 'head': bad['selectedCheckpointSha256'] = 'b' * 64
                elif mutation == 'identity': bad['featureIdentity']['padding'] = 16
                elif mutation == 'admit': bad['countsAsAdmitted'] = True
                else: bad['encodingExecution']['batchSize'] = 2
                path.write_text(json.dumps(bad))
                with self.assertRaises(ValueError, msg=mutation): serve.load_training_manifest(path, 'a' * 64)

    def test_self_reported_certificate_without_trust_refuses_before_model_load(self):
        out, err = io.StringIO(), io.StringIO()
        with patch.object(serve, 'JointEncoder') as loader, contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            code = serve.main(['--mode', 'jev-admitted', '--certificate', 'forged.json', '--physical-gpus', '0,1'])
        self.assertEqual(code, 2)
        self.assertEqual(out.getvalue(), '')
        loader.assert_not_called()
        self.assertIn('trusted-artifact-sha', err.getvalue())
        with self.assertRaisesRegex(ValueError, 'out-of-band'):
            serve.read_certificate(Path('forged.json'))

    def test_native_and_python_loading_output_both_go_to_stderr(self):
        path = str(Path(__file__).with_name('serve_joint.py'))
        code = ("import importlib.util,os\n"
                f"s=importlib.util.spec_from_file_location('joint_serve_native_test',{path!r})\n"
                "m=importlib.util.module_from_spec(s);s.loader.exec_module(m)\n"
                "with m.diagnostics_to_stderr():\n"
                " print('python-loader-log')\n"
                " os.write(1,b'native-loader-log\\n')\n"
                "print('{\"ok\":true}')\n")
        run = subprocess.run([sys.executable, '-c', code], capture_output=True, text=True, timeout=20)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout), {'ok': True})
        self.assertIn('python-loader-log', run.stderr)
        self.assertIn('native-loader-log', run.stderr)

    def test_real_calibration_loader_recomputes_and_unit_evidence_never_admits(self):
        policy = serve.calibration_policy()
        identity = {'checkpointSha256': 'head', 'encoderSha256': 'encoder',
                    'renderer': 'joint-c-action/1', 'memoryPolicyVersion': 'conditional-experience'}
        partitions = {split: [{**identity, 'caseId': split + str(i), 'split': split,
                              'evidenceClass': 'unit-test', 'contentHash': split + str(i),
                              'sourceGroup': split, 'templateFamily': split,
                              'candidateIds': ['a', 'b'], 'acceptableIds': ['a'], 'rawLogits': [10.0, 0.0]}
                             for i in range(120)] for split in policy.PARTITIONS}
        artifact = policy.build_artifact(partitions, identity, evidence_class='unit-test')
        with tempfile.TemporaryDirectory(prefix='joint-certificate-') as directory:
            path = Path(directory) / 'artifact.json'
            path.write_text(json.dumps(artifact))
            with self.assertRaisesRegex(ValueError, 'did not admit'):
                serve.read_certificate(path, trusted_artifact_sha=artifact['artifactSha256'], expected_identity=identity)
            tampered = copy.deepcopy(artifact)
            tampered['temperature'] *= 2
            tampered.pop('artifactSha256')
            tampered['artifactSha256'] = policy.digest(tampered)
            path.write_text(json.dumps(tampered))
            with self.assertRaisesRegex(ValueError, 'recomputed'):
                serve.read_certificate(path, trusted_artifact_sha=tampered['artifactSha256'], expected_identity=identity)

    def run_fixture(self, directory, inputs, identity_drift=False):
        root = Path(directory)
        head = root / 'head.safetensors'
        head.write_bytes(b'CPU test placeholder, loader patched')
        declared = copy.deepcopy(FakeEncoder.actual_identity)
        if identity_drift: declared['padding'] = 16
        selected = root / 'selected.json'
        selected.write_text(json.dumps(manifest(serve.file_sha(head), declared)))
        args = ['--head', str(head), '--training-manifest', str(selected), '--physical-gpus', '0,1',
                '--output-dir', str(root / 'evidence')]
        output, diagnostic = io.StringIO(), io.StringIO()
        weights = np.zeros(5120, dtype=np.float32)
        weights[0] = -1
        with patch.object(serve, 'JointEncoder', FakeEncoder), patch.object(serve, 'load_head', return_value=weights), \
                patch.object(serve.sys, 'stdin', io.StringIO('\n'.join(inputs) + '\n')), \
                contextlib.redirect_stdout(output), contextlib.redirect_stderr(diagnostic):
            exit_code = serve.main(args)
        return exit_code, output.getvalue(), diagnostic.getvalue()

    def test_stdout_jsonl_load_once_online_forward_and_evidence(self):
        with tempfile.TemporaryDirectory(prefix='joint-online-') as directory:
            row = request()
            code, raw, diagnostic = self.run_fixture(directory, [json.dumps(row), json.dumps(row)])
            replies = [json.loads(line) for line in raw.splitlines()]
            self.assertEqual(code, 0)
            self.assertEqual(len(replies), 2)
            self.assertEqual(FakeEncoder.calls, 2)
            self.assertEqual(diagnostic.count('fake loader diagnostic'), 1)
            self.assertIn('fake forward diagnostic', diagnostic)
            self.assertEqual(replies[0]['requestId'], row['request']['requestId'])
            self.assertEqual(replies[0]['inputSha256'], row['inputSha256'])
            self.assertIsNone(replies[0]['utility'])
            self.assertTrue(replies[0]['identity']['experimental'])
            self.assertFalse(replies[0]['identity']['countsAsAdmitted'])
            self.assertEqual(replies[1]['identity']['scoresSucceeded'], 2)
            session = next((Path(directory) / 'evidence').iterdir())
            summary = json.loads((session / 'summary.json').read_text())
            self.assertEqual(summary['encoderForwardCalls'], 2)
            self.assertTrue((session / '000001.request.json').exists())
            self.assertTrue((session / '000001.features.npz').exists())
            self.assertTrue((session / '000001.result.json').exists())

    def test_bad_request_does_not_count_as_success_and_next_request_recovers(self):
        with tempfile.TemporaryDirectory(prefix='joint-online-errors-') as directory:
            code, raw, _ = self.run_fixture(directory, [json.dumps(request('wrong-memory')), '{bad-json', json.dumps(request())])
            replies = [json.loads(line) for line in raw.splitlines()]
            self.assertEqual(code, 2)
            self.assertEqual(len(replies), 3)
            self.assertEqual(FakeEncoder.calls, 1)
            self.assertIn('memoryPolicyVersion', replies[0]['error'])
            self.assertEqual(replies[0]['identity']['scoresSucceeded'], 0)
            self.assertEqual(replies[1]['identity']['encoderForwardCalls'], 0)
            self.assertEqual(replies[2]['identity']['scoresSucceeded'], 1)
            self.assertEqual(replies[2]['identity']['requestsFailed'], 2)

    def test_feature_identity_drift_stops_before_processing_requests(self):
        with tempfile.TemporaryDirectory(prefix='joint-drift-') as directory:
            code, raw, diagnostic = self.run_fixture(directory, [json.dumps(request())], identity_drift=True)
            self.assertEqual(code, 2)
            self.assertEqual(raw, '')
            self.assertEqual(FakeEncoder.calls, 0)
            self.assertIn('differs from the selected training features', diagnostic)


if __name__ == '__main__':
    unittest.main()
