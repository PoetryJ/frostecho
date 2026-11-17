"""Four frozen R5 defect probes with explicit before/after assertions.

exit 0 = requested phase verified (baseline is NOT a product pass).
exit 1 = observed result does not satisfy requested phase.
exit 2 = prerequisite/process/protocol failure, never counted as rejection.
No source edits; mutations occur only in a new output subtree.
"""
import argparse
import datetime
import hashlib
import importlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import traceback

BASE = 'f4739493b9dcec7214f04ab68c05f92bd5a8ea21'
os.environ.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1',
                  CUDA_VISIBLE_DEVICES='', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
sys.dont_write_bytecode = True
for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8')


def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def read(path):
    return json.loads(Path(path).read_text(encoding='utf-8-sig'))


def rows(path):
    return [json.loads(line) for line in Path(path).read_text(encoding='utf-8-sig').splitlines() if line.strip()]


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(argv, repo, out, label, timeout=90):
    start = datetime.datetime.now(datetime.timezone.utc).isoformat()
    try:
        proc = subprocess.run([str(x) for x in argv], cwd=repo, capture_output=True,
                              text=True, encoding='utf-8', errors='replace', timeout=timeout)
    except subprocess.TimeoutExpired as exc:
        def text(value):
            return value.decode('utf-8', errors='replace') if isinstance(value, bytes) else (value or '')
        (out / (label + '.stdout')).write_text(text(exc.stdout), encoding='utf-8')
        (out / (label + '.stderr')).write_text(text(exc.stderr), encoding='utf-8')
        write(out / (label + '.process.json'), {'argv': [str(x) for x in argv], 'cwd': str(repo),
              'start': start, 'end': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'exit': None, 'timeout': True, 'timeoutSeconds': timeout})
        raise
    (out / (label + '.stdout')).write_text(proc.stdout, encoding='utf-8')
    (out / (label + '.stderr')).write_text(proc.stderr, encoding='utf-8')
    write(out / (label + '.process.json'), {'argv': [str(x) for x in argv], 'cwd': str(repo),
          'start': start, 'end': datetime.datetime.now(datetime.timezone.utc).isoformat(),
          'exit': proc.returncode, 'timeout': False})
    return proc


def check_product(repo, out):
    node = shutil.which('node')
    if not node or not (repo / 'dist/scripts/play-sprint.js').is_file():
        raise RuntimeError('Node or built CLI missing; run npm ci && npm run build')
    proc = run([node, repo / 'checkpoints/20261112-r5/evidence/product-audit/supply-probe.cjs', repo, out / 'raw'], repo, out, 'probe')
    if proc.returncode:
        raise RuntimeError('supply probe process failed')
    value = read(out / 'raw/summary.json')
    cm, task = value['commitment'], value['task']
    linked = task['commitmentId'] == cm['commitmentId'] and cm['taskId'] == task['taskId']
    observed = linked and task['status'] == 'done' and cm['status'] == 'active' and cm['evidenceEventIds'] == [] and value['warehouseFood'] == 6
    # Full event type/actor/amount and third-process checks are mandatory in 02;
    # this minimum original probe verifies state plus nonempty receipt linkage.
    fixed = linked and task['status'] == 'done' and cm['status'] == 'fulfilled' and bool(cm['evidenceEventIds']) and value['warehouseFood'] == 6
    return {'defectObserved': observed, 'fixed': bool(fixed), 'taskStatus': task['status'],
            'commitmentStatus': cm['status'], 'evidenceIds': cm['evidenceEventIds'], 'warehouseFood': value['warehouseFood']}


def check_lifecycle(repo, out):
    node = shutil.which('node')
    if not node or not (repo / 'dist/scripts/play-sprint.js').is_file():
        raise RuntimeError('Node or built CLI missing')
    proc = run([node, repo / 'checkpoints/20261112-r5/evidence/lifecycle-audit/r5-lifecycle-probe.cjs', repo, out / 'raw'], repo, out, 'probe')
    if proc.returncode:
        raise RuntimeError('lifecycle probe process failed')
    value = read(out / 'raw/outside-result.json')
    before, outside = value['afterOutside'][0]['decisions'], value['afterOutside'][1]['decisions']
    old_denied = bool(before) and all(x['executed'] is False and not x['eventIds'] for x in before)
    third = value['allSteps'][2]['decisions']
    context = value['savedVersion'] == 0 and old_denied and value['process']['code'] == 0 and all(x['executed'] for x in third)
    observed = context and outside[0]['executed'] is False and outside[0]['reason'] == 'generation_changed_before_start' and value['finalVersion'] == 1
    fixed = context and len(outside) == 1 and outside[0]['executed'] is True and bool(outside[0]['eventIds']) and value['finalVersion'] == 2
    return {'defectObserved': bool(observed), 'fixed': bool(fixed), 'oldDenied': old_denied,
            'outside': outside, 'savedVersion': value['savedVersion'], 'finalVersion': value['finalVersion']}


def data_hashes(path):
    return {x.relative_to(path).as_posix(): digest(x) for x in sorted(path.rglob('*'))
            if x.is_file() and x.suffix in ('.json', '.jsonl')}


def check_data(repo, out):
    jev = repo / 'research/decision-choice/jev04'
    mini = out / 'changed-import'
    data = mini / 'research/decision-choice/jev04/data'
    data.mkdir(parents=True)
    for version in ('v3', 'v4'):
        shutil.copytree(jev / 'data' / version, data / version, ignore=shutil.ignore_patterns('__pycache__'))
    handoff = repo / 'handoff/20261112-sprint-r5/blind-review'
    shutil.copytree(handoff, mini / 'handoff/20261112-sprint-r5/blind-review')
    source = rows(data / 'v3/cases.v3.jsonl')
    target = source[0]['caseId']
    source[0]['candidates'][1]['text'] = '未经新审查的候选：取消所有既有承诺'
    (data / 'v3/cases.v3.jsonl').write_text(''.join(json.dumps(x, ensure_ascii=False) + '\n' for x in source), encoding='utf-8')
    before = data_hashes(data / 'v4')
    proc = run([sys.executable, '-B', data / 'v4/import_blind_review.py'], mini, out, 'import')
    after = data_hashes(data / 'v4')
    validation = run([sys.executable, '-B', data / 'v4/validate_v4.py'], mini, out, 'validate')
    old = next(x for x in rows(jev / 'data/v4/review-s1.v4.jsonl') if x['caseId'] == target)
    new = next(x for x in rows(data / 'v4/review-s1.v4.jsonl') if x['caseId'] == target)
    raw_same, rebound = new['rawReviewSha256'] == old['rawReviewSha256'], new['contentHash'] != old['contentHash']
    observed = proc.returncode == 0 and validation.returncode == 0 and raw_same and rebound
    # A syntax/import crash is not an intentional provenance rejection.
    diagnostic = (proc.stdout + '\n' + proc.stderr).lower()
    crash = 'traceback (most recent call last)' in diagnostic or 'syntaxerror' in diagnostic or 'modulenotfounderror' in diagnostic
    reasoned_rejection = target.lower() in diagnostic and any(x in diagnostic for x in ('review', 'hash', 'input', 'content', '审查', '输入', '内容'))
    fixed = proc.returncode != 0 and before == after and raw_same and not rebound and reasoned_rejection and not crash
    write(out / 'before-hashes.json', before)
    write(out / 'after-hashes.json', after)
    return {'defectObserved': bool(observed), 'fixed': bool(fixed), 'caseId': target,
            'importExit': proc.returncode, 'validatorExit': validation.returncode,
            'rawReviewShaUnchanged': raw_same, 'contentHashRebound': rebound,
            'dataBytesUnchanged': before == after, 'reasonedRejection': reasoned_rejection, 'unexpectedCrash': crash}


def check_risk(repo, out):
    sys.path.insert(0, str(repo / 'research/decision-choice/jev04/scorers'))
    port = importlib.import_module('port_v3')
    ident = port.ScorerIdentity(model='audit/fake', head='shared-scalar/1', adapter='audit',
            tokenizer='audit', renderer='audit', task='choose_action', k=4, policy_version='audit', memory_policy_version='audit')
    policy = {key: getattr(ident, key) for key in port.POLICY_FIELDS}
    refs = {}
    for partition in ('calT', 'select', 'cert'):
        payload = {'schema': 'frostecho.jev04.evidence/1', 'partition': partition,
                   'protocol_version': port.RISK_PROTOCOL_VERSION, 'valid': True,
                   'policy': policy, 'sampleIds': [partition + '-only-one']}
        if partition == 'calT':
            payload.update(temperature=1.2, tau=.8)
        elif partition == 'select':
            payload.update(tau=.8, accepted=120, coverage=.4)
        else:
            payload.update(n=120, errors=120, upper=.01, coverage=.4, alpha=.05)
        path = out / (partition + '.json')
        write(path, payload)
        refs[partition] = {'path': str(path), 'sha256': digest(path)}
    manifest = {'schema': port.MANIFEST_SCHEMA, 'registrations': [{'identity': ident.as_dict(),
                'mode': 'real', 'utility_source': None, 'evidence': {**refs, 'protocol_version': port.RISK_PROTOCOL_VERSION}}]}
    write(out / 'manifest.json', manifest)
    artifact = port.ScorerArtifact(port.ARTIFACT_SCHEMA, ident, 'real', .01, 0.0, .4, .01)
    request = port.ScorerRequest('r6-negative-fixture', ident, ['c0', 'c1', 'c2', 'c3'], [1, 0, 0, 0])
    write(out / 'artifact-input.json', {'identity': ident.as_dict(), 'temperature': .01, 'tau': 0.0,
                                      'note': 'Artificial negative test only; not registered in production manifest.'})
    try:
        decision = port.decide(artifact, request, manifest)
        result = {'defectObserved': decision.counts_as_real is True and decision.disposition == 'accept',
                  'fixed': decision.counts_as_real is False and decision.selected_index is None and decision.disposition in ('shadow_only', 'abstain'),
                  'decision': decision.__dict__}
    except port.IdentityError as exc:
        result = {'defectObserved': False, 'fixed': bool(str(exc)),
                  'explicitRejection': type(exc).__name__ + ': ' + str(exc)}
    write(out / 'result.json', result)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--expect', choices=('baseline', 'fixed'), required=True)
    parser.add_argument('--only', choices=('product', 'lifecycle', 'data', 'risk'))
    args = parser.parse_args()
    repo, out = Path(args.repo).resolve(), Path(args.out).resolve()
    if out.exists():
        raise SystemExit('refusing existing output directory: ' + str(out))
    out.mkdir(parents=True)
    summary = {'schema': 'frostecho.r6.four-probes/1', 'phase': args.expect,
               'note': 'baseline success proves defects reproduced, NOT product acceptance; synthetic CPU probes, no model',
               'repo': str(repo), 'checks': {}, 'errors': {}}
    try:
        head = run(['git', 'rev-parse', 'HEAD'], repo, out, 'head')
        if head.returncode:
            raise RuntimeError('not a Git checkout')
        summary['head'] = head.stdout.strip()
        if args.expect == 'baseline':
            p = run(['git', 'diff', '--exit-code', BASE, '--', 'src', 'scripts', 'tests', 'research/decision-choice/jev04'], repo, out, 'baseline-product-diff')
            if p.returncode:
                raise RuntimeError('baseline product code/data changed before reproduction')
        functions = {'product': check_product, 'lifecycle': check_lifecycle, 'data': check_data, 'risk': check_risk}
        for name, function in functions.items():
            if args.only and args.only != name:
                continue
            target = out / name
            target.mkdir()
            try:
                summary['checks'][name] = function(repo, target)
            except Exception as exc:
                summary['errors'][name] = type(exc).__name__ + ': ' + str(exc)
                (target / 'unexpected-error.txt').write_text(traceback.format_exc(), encoding='utf-8')
        key = 'defectObserved' if args.expect == 'baseline' else 'fixed'
        summary['verified'] = bool(summary['checks']) and not summary['errors'] and all(x[key] for x in summary['checks'].values())
        summary['scope'] = 'partial:' + args.only if args.only else 'four_minimal_probes'
    except Exception as exc:
        summary['errors']['setup'] = type(exc).__name__ + ': ' + str(exc)
        summary['verified'] = False
    summary['exit'] = 2 if summary['errors'] else (0 if summary['verified'] else 1)
    write(out / 'summary.json', summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary['exit']


if __name__ == '__main__':
    raise SystemExit(main())
