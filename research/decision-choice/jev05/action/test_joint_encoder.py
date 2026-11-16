"""CPU mechanism checks for joint readout; no Torch, weights, or GPU access."""
import copy
import importlib.util
import json
from pathlib import Path
import struct
import tempfile
import types
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('joint_encoder_under_test', Path(__file__).with_name('joint_encoder.py'))
core = importlib.util.module_from_spec(spec)
spec.loader.exec_module(core)


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
                         'spanUnit': 'utf16-code-unit', 'rendererId': 'joint-c-action/1'}}


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
