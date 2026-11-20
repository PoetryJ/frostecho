"""CPU mechanism checks for joint readout; no Torch, weights, or GPU access."""
import copy
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import struct
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import numpy as np

spec = importlib.util.spec_from_file_location('joint_encoder_under_test', Path(__file__).with_name('joint_encoder.py'))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)
corpus_spec = importlib.util.spec_from_file_location('corpus_under_test', Path(__file__).with_name('encode_joint_corpus.py'))
corpus = importlib.util.module_from_spec(corpus_spec)
with patch.dict(sys.modules, {'joint_encoder': core}):
    corpus_spec.loader.exec_module(corpus)


class CharacterTokenizer:
    def __init__(self):
        self.calls = []

    def apply_chat_template(self, messages, **kwargs):
        self.message = messages[0]['content']
        return '[user]\n' + self.message + '\n[assistant]'

    def __call__(self, text, **kwargs):
        self.calls.append((text, kwargs))
        return {'input_ids': [ord(char) for char in text],
                'offset_mapping': [(i, i + 1) for i in range(len(text))]}


def js_units(text):
    return len(text.encode('utf-16-le')) // 2


def envelope():
    text = '亲见仓库缺货；玩家说“1.伪候选”。\n可选行动:'
    lines = ['\n1. 采集木材🪵 {amount=2}', '\n2. 向玩家说明延误 {to=player}']
    spans = []
    for index, line in enumerate(lines):
        start = js_units(text)
        text += line
        spans.append({'index': index, 'start': start, 'end': js_units(text)})
    request = {'requestId': 'cpu-mechanism', 'candidateSetHash': 'fixture-not-real',
               'candidates': [{'id': 'opaque-a'}, {'id': 'opaque-b'}]}
    raw = json.dumps(request, ensure_ascii=False, separators=(',', ':'))
    return {'schema': 'frostecho.joint-encoding-request/1', 'request': request,
            'requestJson': raw, 'inputSha256': core.digest_bytes(raw.encode()),
            'rendererSourceSha256': core.file_sha(core.ROOT / 'src/r7/jev/render.ts'),
            'renderedTextSha256': core.digest_bytes(text.encode()),
            'rendered': {'text': text, 'candidateSpans': spans,
                         'spanUnit': 'utf16-code-unit', 'rendererId': 'joint-c-action/2'}}


class JointEncoderMechanismTests(unittest.TestCase):
    def test_utf16_emoji_offsets_and_half_surrogate_refused(self):
        text = 'A🪵中'
        self.assertEqual(core.utf16_position(text, 0), 0)
        self.assertEqual(core.utf16_position(text, 1), 1)
        self.assertEqual(core.utf16_position(text, 3), 2)
        self.assertEqual(core.utf16_position(text, 4), 3)
        for units in (2, -1, 5, True):
            with self.assertRaises(ValueError):
                core.utf16_position(text, units)

    def test_all_endpoints_come_from_one_joint_tokenization(self):
        tokenizer = CharacterTokenizer()
        source = envelope()
        built = core.prepare(tokenizer, source)
        self.assertEqual(len(tokenizer.calls), 1)
        self.assertFalse(tokenizer.calls[0][1]['truncation'])
        self.assertEqual(tokenizer.message, source['rendered']['text'])
        self.assertEqual(built['candidateIds'], ['opaque-a', 'opaque-b'])
        expected = [len('[user]\n') + core.utf16_position(source['rendered']['text'], span['end']) - 1
                    for span in source['rendered']['candidateSpans']]
        self.assertEqual(built['positions'], expected)
        self.assertLess(expected[0], expected[1])
        # A forged marker in the observation cannot hijack structural endpoints.
        self.assertTrue(all(pos > tokenizer.calls[0][0].index('可选行动:') for pos in expected))

    def test_raw_request_and_hash_are_both_checked(self):
        source = envelope()
        for change in ('hash', 'raw', 'object', 'renderer'):
            bad = copy.deepcopy(source)
            if change == 'hash': bad['inputSha256'] = '0' * 64
            elif change == 'raw': bad['requestJson'] += ' '
            elif change == 'object': bad['request']['candidates'][0]['id'] = 'changed'
            else: bad['rendererSourceSha256'] = '0' * 64
            with self.assertRaises(ValueError, msg=change):
                core.prepare(CharacterTokenizer(), bad)

    def test_token_budget_refuses_instead_of_truncating(self):
        tokenizer = CharacterTokenizer()
        with self.assertRaisesRegex(ValueError, 'no silent truncation'):
            core.prepare(tokenizer, envelope(), max_tokens=3)
        self.assertFalse(tokenizer.calls[0][1]['truncation'])
        self.assertGreater(len(tokenizer.calls[0][0]), 3)

    def test_rendered_text_hash_and_span_unit_are_checked(self):
        for kind in ('text', 'digest', 'units'):
            source = envelope()
            if kind == 'text': source['rendered']['text'] += ' changed'
            elif kind == 'digest': source['renderedTextSha256'] = '0' * 64
            else: source['rendered']['spanUnit'] = 'unicode-code-point'
            with self.assertRaises(ValueError, msg=kind):
                core.prepare(CharacterTokenizer(), source)

    def test_bad_span_identity_overlap_and_partial_surrogate_refused(self):
        for kind in ('index', 'overlap', 'half-surrogate'):
            source = envelope()
            spans = source['rendered']['candidateSpans']
            if kind == 'index': spans[0]['index'] = 1
            elif kind == 'overlap': spans[1]['start'] = spans[0]['start']
            else:
                text = source['rendered']['text']
                spans[0]['end'] = js_units(text[:text.index('🪵')]) + 1
            with self.assertRaises(ValueError, msg=kind):
                core.prepare(CharacterTokenizer(), source)

    def test_memory_limits_are_bytes_after_both_reserves(self):
        result = types.SimpleNamespace(stdout='0, 4071\n1, 5974\n')
        meminfo = f'MemAvailable: {64 * 1024 ** 2} kB\nMemTotal: {88 * 1024 ** 2} kB\n'
        with patch.object(core.subprocess, 'run', return_value=result), \
                patch.object(core.Path, 'read_text', return_value=meminfo):
            plan = core.memory_plan(1)
        self.assertEqual(plan['maxMemoryBytes'][0], (5974 - 1536) * 1024 ** 2)
        self.assertEqual(plan['maxMemoryBytes']['cpu'], (64 - 12) * 1024 ** 3)
        self.assertEqual(plan['physicalGpu'], 1)
        with patch.object(core.subprocess, 'run', return_value=result), \
                patch.object(core.Path, 'read_text', return_value=f'MemAvailable: {100 * 1024 ** 2} kB\n'):
            self.assertEqual(core.memory_plan(1)['maxMemoryBytes']['cpu'], 55 * 1024 ** 3)
        with patch.object(core.subprocess, 'run', return_value=types.SimpleNamespace(stdout='1, 2000\n')), \
                patch.object(core.Path, 'read_text', return_value=meminfo):
            with self.assertRaises(RuntimeError): core.memory_plan(1)

    def test_asymmetric_multigpu_budget_keeps_physical_order_and_bytes(self):
        result = types.SimpleNamespace(stdout='0, 22500\n1, 24000\n')
        with patch.object(core.subprocess, 'run', return_value=result), \
                patch.object(core.Path, 'read_text', return_value=f'MemAvailable: {80 * 1024 ** 2} kB\n'):
            plan = core.memory_plan([1, 0])
        self.assertEqual(plan['maxMemoryBytes'][0], (24000 - 1536) * core.MIB)
        self.assertEqual(plan['maxMemoryBytes'][1], (22500 - 1536) * core.MIB)
        self.assertEqual(plan['logicalToPhysical'], {'0': 1, '1': 0})
        for bad in ([1, 1], [], [True]):
            with self.assertRaises(ValueError): core.memory_plan(bad)

    def test_right_padding_mask_and_each_rows_candidate_offsets(self):
        rows = [{'tokenIds': [11, 12, 13], 'positions': [0, 2], 'candidateIds': ['a', 'b']},
                {'tokenIds': [21, 22, 23, 24, 25], 'positions': [1, 3, 4], 'candidateIds': ['x', 'y', 'z']}]
        batch = core.padded_batch(rows, 99, pad_multiple=8)
        self.assertEqual(batch['shape'], [2, 8])
        np.testing.assert_array_equal(batch['inputIds'][0], [11, 12, 13, 99, 99, 99, 99, 99])
        np.testing.assert_array_equal(batch['attentionMask'], [[1, 1, 1, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 0, 0, 0]])
        np.testing.assert_array_equal(batch['positionIds'][1], [0, 1, 2, 3, 4, 0, 0, 0])
        hidden = np.arange(2 * 8 * 4).reshape(2, 8, 4)
        gathered = core.gather_candidate_rows(hidden, rows)
        np.testing.assert_array_equal(gathered[0], hidden[0, [0, 2]])
        np.testing.assert_array_equal(gathered[1], hidden[1, [1, 3, 4]])
        bad = copy.deepcopy(rows)
        bad[0]['positions'][1] = 3
        with self.assertRaises(ValueError): core.padded_batch(bad, 99)
        with self.assertRaises(ValueError): core.gather_candidate_rows(hidden, bad)

    def test_ragged_cache_restore_rejects_bytes_and_case_mapping_changes(self):
        with tempfile.TemporaryDirectory(prefix='joint-corpus-') as directory:
            output = Path(directory)
            source = [{'caseId': 'one', 'sourceRowSha256': 'source-one'},
                      {'caseId': 'two', 'sourceRowSha256': 'source-two'}]
            features = [np.full((2, 5120), 1.0, dtype=np.float32), np.full((3, 5120), 2.0, dtype=np.float32)]
            records = [{**row, 'candidateIds': ['a', 'b'] if i == 0 else ['x', 'y', 'z'],
                        'featureIdentityHash': 'backend', 'featureSha256': core.digest_bytes(features[i].tobytes())}
                       for i, row in enumerate(source)]
            corpus.atomic_npz(output / 'part.npz', **corpus.pack_features(features, records))
            corpus.atomic_bytes(output / 'part.jsonl', ('\n'.join(map(corpus.canonical, records)) + '\n').encode())
            progress = {'featureIdentityHash': 'backend', 'completedCases': 2,
                        'parts': [{'npz': 'part.npz', 'records': 'part.jsonl',
                                   'npzSha256': core.file_sha(output / 'part.npz'),
                                   'recordsSha256': core.file_sha(output / 'part.jsonl')}]}
            restored, actual = corpus.checked_parts(output, progress, source)
            np.testing.assert_array_equal(restored[1], features[1])
            self.assertEqual(actual[1]['candidateIds'], ['x', 'y', 'z'])
            with self.assertRaisesRegex(ValueError, 'mapping or identity'):
                corpus.checked_parts(output, progress, list(reversed(source)))
            with (output / 'part.npz').open('ab') as stream: stream.write(b'tampered')
            with self.assertRaisesRegex(ValueError, 'SHA mismatch'):
                corpus.checked_parts(output, progress, source)

    def test_actual_envelope_input_preserves_labels_and_refuses_foreign_candidate(self):
        with tempfile.TemporaryDirectory(prefix='joint-input-') as directory:
            path = Path(directory) / 'requests.jsonl'
            row = {**envelope(), 'caseId': 'one', 'split': 'train', 'acceptableIds': ['opaque-a'],
                   'sourceFamily': 'episode-1', 'episodeSeed': 'episode-1', 'labelSource': 'reference-imitation'}
            corpus.atomic_bytes(path, (corpus.canonical(row) + '\n').encode())
            actual = corpus.load_inputs(path)[0]
            self.assertEqual(actual['sourceGroup'], 'episode-1')
            self.assertEqual(actual['episode'], 'episode-1')
            self.assertEqual(actual['labelClass'], 'reference-imitation')
            self.assertEqual(actual['acceptableIds'], ['opaque-a'])
            self.assertEqual(actual['envelope']['request'], row['request'])
            row['acceptableIds'] = ['made-up']
            corpus.atomic_bytes(path, (corpus.canonical(row) + '\n').encode())
            with self.assertRaisesRegex(ValueError, 'actual candidates'): corpus.load_inputs(path)

    def test_forward_journal_counts_completed_failed_and_interrupted_separately(self):
        with tempfile.TemporaryDirectory(prefix='joint-journal-') as directory:
            journal = corpus.ForwardJournal(Path(directory))
            journal.append({'event': 'started', 'callId': 1})
            journal.append({'event': 'completed', 'callId': 1})
            journal.append({'event': 'started', 'callId': 2})
            journal.append({'event': 'failed', 'callId': 2})
            journal.append({'event': 'started', 'callId': 3})
            counts = corpus.ForwardJournal(Path(directory)).counts()
            self.assertEqual(counts, {'encoderForwardCalls': 1, 'forwardCallsAttempted': 3,
                                     'forwardCallsFailed': 1, 'forwardCallsUnknownAfterInterruption': 1})

    def test_corpus_resume_skips_committed_batches_and_preserves_failed_forward(self):
        class FakeEncoder:
            fail_next_last_batch = True
            production_sizes = []

            def __init__(self, *args, **kwargs):
                self.tokenizer = CharacterTokenizer()
                self.identity = {'fixture': True}
                self.calls = 0

            def feature_identity(self, pad_multiple):
                return {'schema': 'CPU-TEST-ONLY', 'padding': pad_multiple}

            def encode_batch(self, prepared, pad_multiple):
                self.calls += 1
                # The first invocation has two qualifications and a committed
                # batch before this injected crash on the final partial batch.
                if self.calls == 4 and FakeEncoder.fail_next_last_batch:
                    FakeEncoder.fail_next_last_batch = False
                    raise RuntimeError('injected final-batch failure')
                features = [np.full((len(row['candidateIds']), 5120), 3.0, dtype=np.float32)
                            for row in prepared]
                traces = [{**{key: value for key, value in row.items() if key != 'tokenIds'},
                           'featureSha256': core.digest_bytes(value.tobytes())}
                          for row, value in zip(prepared, features)]
                FakeEncoder.production_sizes.append(len(prepared))
                return features, {'rows': traces, 'forwardSeconds': 0.0}

        with tempfile.TemporaryDirectory(prefix='joint-full-resume-') as directory:
            root = Path(directory)
            inputs = [{**envelope(), 'caseId': f'case-{i}', 'split': 'train' if i < 2 else 'dev',
                       'acceptableIds': ['opaque-a']} for i in range(3)]
            corpus.atomic_bytes(root / 'input.jsonl', ('\n'.join(map(corpus.canonical, inputs)) + '\n').encode())
            args = types.SimpleNamespace(out=str(root / 'cache'), inputs=str(root / 'input.jsonl'), limit=0,
                                         encoder='CPU-TEST-ONLY', physical_gpus='0,1', placement='auto',
                                         resume=False, batch_size=2, max_length=2048, pad_multiple=8,
                                         qualify_relative_l2=0.02, qualify_max_abs=1.0, qualify_duplicate_abs=0.001)
            with patch.object(corpus, 'JointEncoder', FakeEncoder), contextlib.redirect_stdout(io.StringIO()):
                with self.assertRaisesRegex(RuntimeError, 'injected'):
                    corpus.run(args)
                progress = json.loads((root / 'cache/progress.json').read_text())
                self.assertEqual(progress['completedCases'], 2)
                first_part = (root / 'cache/parts/batch-000000.npz').read_bytes()
                args.resume = True
                result = corpus.run(args)
            self.assertEqual(FakeEncoder.production_sizes, [1, 2, 2, 1])
            self.assertEqual(result['cases'], 3)
            self.assertEqual(result['encoderForwardCalls'], 4)
            self.assertEqual(result['forwardCallsAttempted'], 5)
            self.assertEqual(result['forwardCallsFailed'], 1)
            self.assertEqual(first_part, (root / 'cache/parts/batch-000000.npz').read_bytes())
            with np.load(root / 'cache/features.npz', allow_pickle=False) as cache:
                np.testing.assert_array_equal(cache['rowOffsets'], [0, 2, 4, 6])
                self.assertEqual(cache['caseIds'].tolist(), ['case-0', 'case-1', 'case-2'])
            records = [json.loads(line) for line in (root / 'cache/records.jsonl').read_text().splitlines()]
            self.assertEqual([(row['rowStart'], row['rowEnd']) for row in records], [(0, 2), (2, 4), (4, 6)])
            self.assertEqual(result['counts'], {'dev': 1, 'train': 2})

    @staticmethod
    def write_header_fixture(root, omit_norm=False):
        # Header-only files: no tensors are loaded and no large arrays allocated.
        names = {
            'model.embed_tokens.weight': [10, 8],
            'model.layers.0.weight': [4, 8],
            'model.layers.1.first.weight': [1, 4],
            'model.layers.1.second.weight': [1, 4],
            'model.layers.2.weight': [3, 8],
            'model.norm.weight': [8],
            'lm_head.weight': [10, 8],
        }
        if omit_norm:
            del names['model.norm.weight']
        shards, weight_map = {'part-a.safetensors': {}, 'part-b.safetensors': {}}, {}
        for index, (name, shape) in enumerate(names.items()):
            shard = 'part-a.safetensors' if index % 2 == 0 else 'part-b.safetensors'
            weight_map[name] = shard
            shards[shard][name] = {'dtype': 'BF16', 'shape': shape, 'data_offsets': [0, 0]}
        for name, header in shards.items():
            raw = json.dumps(header).encode()
            (root / name).write_bytes(struct.pack('<Q', len(raw)) + raw)
        (root / 'config.json').write_text(json.dumps({'text_config': {'num_hidden_layers': 3}}))
        (root / 'model.safetensors.index.json').write_text(json.dumps({'weight_map': weight_map}))

    def test_one_layer_header_plan_accumulates_shards_and_bounds_bytes(self):
        with tempfile.TemporaryDirectory(prefix='joint-headers-') as directory:
            root = Path(directory)
            self.write_header_fixture(root)
            expected_bound = 16 + 160 + 512 * 1024 ** 2
            mapping, evidence = core.one_layer_plan(root, expected_bound)
            self.assertEqual(evidence['residentModule'], 'model.layers.1')
            self.assertEqual(evidence['residentBytes'], 16)
            self.assertEqual(evidence['largestStreamedBytes'], 160)
            self.assertEqual(evidence['plannedPeakBoundBytes'], expected_bound)
            self.assertEqual(mapping['model.layers.1'], 0)
            self.assertEqual(sum(device == 0 for device in mapping.values()), 1)
            self.assertEqual(mapping['model.embed_tokens'], 'cpu')
            self.assertEqual(mapping['lm_head'], 'cpu')
            with self.assertRaises(RuntimeError):
                core.one_layer_plan(root, expected_bound - 1)

    def test_one_layer_plan_refuses_unknown_or_missing_module_headers(self):
        with tempfile.TemporaryDirectory(prefix='joint-missing-header-') as directory:
            root = Path(directory)
            self.write_header_fixture(root, omit_norm=True)
            with self.assertRaisesRegex(ValueError, 'checkpoint module names'):
                core.one_layer_plan(root, 4 * 1024 ** 3)

    def test_checkpoint_language_model_prefix_maps_to_runtime_text_modules(self):
        with tempfile.TemporaryDirectory(prefix='joint-qwen-text-prefix-') as directory:
            root = Path(directory)
            self.write_header_fixture(root)
            index_path = root / 'model.safetensors.index.json'
            index = json.loads(index_path.read_text())['weight_map']
            rename = lambda key: ('model.language_model.' + key[len('model.'):]
                                  if key.startswith('model.') else key)
            renamed_index = {rename(key): shard for key, shard in index.items()}
            for shard in set(index.values()):
                path = root / shard
                content = path.read_bytes()
                length = struct.unpack('<Q', content[:8])[0]
                header = json.loads(content[8:8 + length])
                renamed = {rename(key): info for key, info in header.items()}
                # These are outside the CausalLM text backbone and must not be budgeted.
                for key in ('model.visual.patch_embed.weight', 'model.language_model.mtp.layers.0.weight'):
                    renamed[key] = {'dtype': 'BF16', 'shape': [100000, 100000], 'data_offsets': [0, 0]}
                    renamed_index[key] = shard
                raw = json.dumps(renamed).encode()
                path.write_bytes(struct.pack('<Q', len(raw)) + raw)
            index_path.write_text(json.dumps({'weight_map': renamed_index}))
            expected_bound = 16 + 160 + 512 * 1024 ** 2
            mapping, evidence = core.one_layer_plan(root, expected_bound)
            self.assertEqual(evidence['residentModule'], 'model.layers.1')
            self.assertEqual(evidence['residentBytes'], 16)
            self.assertEqual(evidence['plannedPeakBoundBytes'], expected_bound)
            self.assertEqual(mapping['model.layers.1'], 0)
            self.assertEqual(mapping['model.embed_tokens'], 'cpu')
            self.assertFalse(any('language_model' in key or 'visual' in key or 'mtp' in key
                                 for key in mapping))


if __name__ == '__main__':
    unittest.main()
