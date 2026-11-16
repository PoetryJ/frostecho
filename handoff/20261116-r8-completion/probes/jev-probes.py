"""CPU-only independent R8 audit. Synthetic vectors test mechanics, not accuracy."""
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import numpy as np

HERE = pathlib.Path(__file__).resolve().parent
import argparse
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repo', type=pathlib.Path, required=True)
parser.add_argument('--out', type=pathlib.Path, required=True)
audit_args = parser.parse_args()
ROOT = audit_args.repo.resolve()
SCRIPT = ROOT / 'research/decision-choice/jev05/action/train.py'
spec = importlib.util.spec_from_file_location('r8_action', SCRIPT)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

# Simulate fully free physical A10s; never access or modify a GPU.
module.gpu_free_mib = lambda: [
    {'index': 0, 'freeMiB': 23028, 'totalMiB': 23028, 'usedMiB': 0},
    {'index': 1, 'freeMiB': 24564, 'totalMiB': 24564, 'usedMiB': 0},
]
module.encoder_hidden = lambda _: 5120
args = module.build_parser().parse_args(['--encoder', str(ROOT), 'preflight', '--json'])
preflight = module.preflight(args)

cases = [json.loads(line) for line in
         (ROOT / 'artifacts/sprint-r8/D/cases/dynamic-cases.jsonl').read_text(encoding='utf-8').splitlines()]
weight = module.read_head(module.HEAD)
index = int(np.argmax(abs(weight)))
features = np.zeros((2, 5120))
features[1, index] = 2 / weight[index]
centered = features - features.mean(-1, keepdims=True)
original_logits = (centered / np.sqrt(np.mean(centered ** 2, -1, keepdims=True) + 1e-5)) @ weight

temp = pathlib.Path(tempfile.mkdtemp(prefix='frostecho-r8-jev-audit-')).resolve()
feature_map = temp / 'mechanism-fixture-features.json'
feature_map.write_text(json.dumps({'a': features[0].tolist(), 'b': features[1].tolist()}), encoding='utf-8')
request = {'requestId': 'probe', 'candidateSetHash': 'mechanism-fixture',
           'candidates': [{'id': 'a', 'parameters': {'featureKey': 'a'}},
                          {'id': 'b', 'parameters': {'featureKey': 'b'}}]}
responses = []
for temperature in ['0.1', '100']:
    command = [sys.executable, '-B', str(SCRIPT), 'serve', '--feature-map', str(feature_map),
               '--mode', 'jev-admitted', '--temperature', temperature]
    process = subprocess.run(command, input=json.dumps(request) + '\n',
                             capture_output=True, text=True, check=True, timeout=20)
    responses.append({'command': command, 'exitCode': process.returncode,
                      'response': json.loads(process.stdout)})

report = {
    'sourceHEAD': subprocess.run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'],
                                capture_output=True, text=True, check=True).stdout.strip(),
    'evidenceClass': 'CPU-mechanism-probes-and-existing-data-inspection',
    'gpuUsed': False,
    'emptyA10Pair': {'readyForLiveEncoding': preflight['readyForLiveEncoding'],
                    'requiredVramMiB': preflight['requiredVramMiB'], 'gpus': preflight['gpus']},
    'data': {'cases': len(cases), 'episodes': sorted({row['episode'] for row in cases}),
             'splits': sorted({row['split'] for row in cases}),
             'reviewers': sorted({row['reviewers'] for row in cases}),
             'missingObservationText': sum('observationText' not in row for row in cases),
             'missingCandidateText': sum(any('text' not in c for c in row['candidates']) for row in cases),
             'singleCandidate': sum(len(row['candidates']) == 1 for row in cases)},
    'normalization': {'r8Logits': module.score_matrix(weight, features).tolist(),
                      'originalLayerNormLogits': original_logits.tolist()},
    'serve': responses,
    'temperatureHasNoEffect': responses[0]['response']['scores'] == responses[1]['response']['scores'],
}
audit_args.out.parent.mkdir(parents=True, exist_ok=True)
audit_args.out.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps(report, ensure_ascii=True, indent=2))
