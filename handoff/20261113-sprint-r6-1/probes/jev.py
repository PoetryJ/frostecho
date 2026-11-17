"""Two bounded R6 audit counterexamples; does not modify the audited tree."""
import copy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

sys.dont_write_bytecode = True
os.environ.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1',
                  CUDA_VISIBLE_DEVICES='', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')
root, out = Path(sys.argv[1]).resolve(), Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=False)
jev = root / 'research/decision-choice/jev04'

def rows(path):
    return [json.loads(line) for line in path.read_text(encoding='utf-8').splitlines() if line.strip()]

def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8', newline='\n')

def write_rows(path, value):
    path.write_text(''.join(json.dumps(row, ensure_ascii=False) + '\n' for row in value), encoding='utf-8', newline='\n')

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def run(argv, cwd, stem):
    p = subprocess.run([str(x) for x in argv], cwd=cwd, capture_output=True, text=True, encoding='utf-8', timeout=30)
    (out / (stem + '.stdout')).write_text(p.stdout, encoding='utf-8')
    (out / (stem + '.stderr')).write_text(p.stderr, encoding='utf-8')
    write(out / (stem + '.process.json'), {'argv': [str(x) for x in argv], 'cwd': str(cwd), 'exit': p.returncode})
    return p

result = {'sourceHead': subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=root, text=True).strip(),
          'noModel': True, 'noServer': True}

# D: validator reads original canonical SHA but omits checking the visible
# packet's content against parsed serializedInput. Two editable projections
# can agree while both differ from the original reviewers' immutable input.
mini = out / 'validator-projection-mini'
data = mini / 'research/decision-choice/jev04/data'
data.mkdir(parents=True)
shutil.copytree(jev / 'data/v4', data / 'v4', ignore=shutil.ignore_patterns('__pycache__'))
handoff = mini / 'handoff/20261112-sprint-r5/blind-review'
shutil.copytree(root / 'handoff/20261112-sprint-r5/blind-review', handoff)
immutable = {name: sha(handoff / name) for name in ('canonical-inputs.jsonl', 'review-a.jsonl', 'review-b.jsonl')}
v4_cases = rows(data / 'v4/cases.v4.jsonl')
packets = rows(handoff / 'packet.jsonl')
case = v4_cases[0]
target = case['caseId']
old_hash = case['contentHash']
case['narrative']['text'] = '独立审计反例：这句话从未出现在原始审查输入中。'
packet = next(row for row in packets if row['caseId'] == target)
packet['visibleInput']['narrative'] = copy.deepcopy(case['narrative'])
spec = importlib.util.spec_from_file_location('audit_validator', jev / 'data/v4/validate_v4.py')
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)
case['contentHash'] = validator.content_hash(case)
write_rows(data / 'v4/cases.v4.jsonl', v4_cases)
write_rows(handoff / 'packet.jsonl', packets)
for name in ('review-s1.v4.jsonl', 'review-s2.v4.jsonl', 'adjudication.v4.jsonl'):
    values = rows(data / 'v4' / name)
    for row in values:
        if row['caseId'] == target:
            row['contentHash'] = case['contentHash']
    write_rows(data / 'v4' / name, values)
p = run([sys.executable, '-B', data / 'v4/validate_v4.py'], mini, 'validator-projection')
v = json.loads(p.stdout)
canonical = next(row for row in rows(handoff / 'canonical-inputs.jsonl') if row['caseId'] == target)
result['validatorProjectionGap'] = {
    'caseId': target, 'exit': p.returncode, 'result': v,
    'originalReviewAndCanonicalHashesUnchanged': immutable == {name: sha(handoff / name) for name in immutable},
    'packetDeclaredHashStillOriginal': packet['contentHash'] == canonical['contentHash'],
    'visibleTextDiffersFromCanonical': packet['visibleInput']['narrative'] != json.loads(canonical['serializedInput'])['narrative'],
    'oldV4Hash': old_hash, 'newV4Hash': case['contentHash'],
    'note': 'Synthetic mutation in isolated copy; current shipped dataset not accused of tampering. Research gate remains false.'}

# M: only change the top-level evidence class from fixture to cpu-mechanism.
# Per-sample synthetic logits/labels and statistics are identical.
sys.path.insert(0, str(jev / 'scorers'))
import port_v3 as port
from sealed import build_cpu_bundle
ident = port.ScorerIdentity(model='fixture/r6', head='shared-scalar/1', adapter='jev-choice/1',
    tokenizer='fixture-tok/1', renderer='jev04-render/3', task='choose_action', k=4,
    policy_version='softmax-accept/1', memory_policy_version='memory-policy/1')
base = build_cpu_bundle(ident.as_dict(), evidence_class='fixture', calibration_id='audit-r6-shared', seeds=(17, 43))
summaries = {}
for name in ('fixture', 'cpu-mechanism'):
    dest = out / name
    dest.mkdir()
    bundle = copy.deepcopy(base)
    refs = {}
    for partition, payload in bundle.items():
        payload['evidenceClass'] = name
        path = dest / (partition + '.json')
        write(path, payload)
        refs[partition] = {'path': str(path), 'sha256': sha(path)}
    manifest = {'schema': port.MANIFEST_SCHEMA, 'registrations': [{'identity': ident.as_dict(), 'mode': 'real',
        'utility_source': None, 'evidence': {**refs, 'protocol_version': port.RISK_PROTOCOL_VERSION}}]}
    write(dest / 'manifest.json', manifest)
    loaded = port.load_trusted_manifest(str(dest / 'manifest.json'))
    inspection = port.resolve_registration(loaded, ident).inspect()
    if name == 'fixture':
        frozen = inspection
        fixture_manifest = loaded
    art = port.ScorerArtifact(port.ARTIFACT_SCHEMA, ident, 'real', frozen.temperature, frozen.tau,
        frozen.coverage, frozen.upper, calibration_id=frozen.calibration_id)
    port.save_artifact(str(dest / 'artifact.json'), art)
    write(dest / 'payloads.json', bundle)
    write(dest / 'identity.json', ident.as_dict())
    rejection = None
    decision = None
    try:
        reloaded = port.load_artifact(str(dest / 'artifact.json'), ident, loaded)
        decision = port.decide(reloaded, port.ScorerRequest('audit', ident, ['c0','c1','c2','c3'], [6,0,0,0]), loaded)
    except port.IdentityError as exc:
        rejection = {'type': type(exc).__name__, 'reason': str(exc)}
    summaries[name] = {'inspection': inspection.__dict__, 'decision': decision.__dict__ if decision else None,
                       'explicitRejection': rejection,
                       'recordEvidenceClasses': sorted({r['evidenceClass'] for payload in bundle.values() for r in payload['records']})}
result['cpuClassRealAdmission'] = summaries
fixture_art = port.ScorerArtifact(port.ARTIFACT_SCHEMA, ident, 'fixture', frozen.temperature, frozen.tau,
    frozen.coverage, frozen.upper, calibration_id=frozen.calibration_id)
result['positiveFixture'] = {key: port.decide(fixture_art,
    port.ScorerRequest(key, ident, ['c0','c1','c2','c3'], logits), fixture_manifest).__dict__
    for key, logits in [('high',[6,0,0,0]),('low',[0,0,0,0])]}
write(out / 'result.json', result)
print(json.dumps(result, ensure_ascii=False, indent=2))
