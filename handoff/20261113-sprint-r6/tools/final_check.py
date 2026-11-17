"""One final CPU suite in a fresh clone; no server, GPU, or model access."""
import argparse
import json
import os
from pathlib import Path
import re
import shutil
import sys
sys.dont_write_bytecode = True
from repro import run, write


def unittest_counts(text):
    ran = re.search(r'Ran (\d+) tests?', text)
    skip = re.search(r'skipped=(\d+)', text)
    failed = re.search(r'failures=(\d+)', text)
    errors = re.search(r'errors=(\d+)', text)
    return {'ran': int(ran.group(1)) if ran else None,
            'skipped': int(skip.group(1)) if skip else 0,
            'failures': int(failed.group(1)) if failed else 0,
            'errors': int(errors.group(1)) if errors else 0}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True)
    parser.add_argument('--out', required=True)
    args = parser.parse_args()
    repo, out = Path(args.repo).resolve(), Path(args.out).resolve()
    if out.exists():
        raise SystemExit('refusing existing final output directory: ' + str(out))
    out.mkdir(parents=True)
    logs, clone, scratch = out / 'logs', out / 'acceptance-clone', out / 'scratch'
    logs.mkdir()
    scratch.mkdir()
    os.environ.update(TMP=str(scratch), TEMP=str(scratch), TMPDIR=str(scratch))
    summary = {'schema': 'frostecho.r6.final-check/1', 'status': 'blocked',
               'note': 'CPU actual host only; G11 packaged historical evidence, not live', 'checks': {}}
    try:
        for name in ('git', 'node', 'npm'):
            if not shutil.which(name):
                raise RuntimeError('missing executable: ' + name)
        for label, argv in [('tracked-clean', ['git', 'diff', '--quiet']),
                            ('index-clean', ['git', 'diff', '--cached', '--quiet'])]:
            if run(argv, repo, logs, label).returncode:
                raise RuntimeError('commit tracked changes before final clone')
        head = run(['git', 'rev-parse', 'HEAD'], repo, logs, 'source-head')
        if head.returncode:
            raise RuntimeError('cannot read source commit')
        summary['sourceHead'] = head.stdout.strip()
        operations = [('clone', ['git', 'clone', '--no-hardlinks', '--no-checkout', str(repo), str(clone)], repo),
                      ('checkout', ['git', 'checkout', '--detach', summary['sourceHead']], clone),
                      ('preflight', [sys.executable, '-B', str(clone / 'handoff/20261113-sprint-r6/tools/preflight.py'), '--repo', str(clone), '--out', str(out / 'preflight'), '--restore-g11'], clone),
                      ('install', [shutil.which('npm'), 'ci'], clone),
                      ('build', [shutil.which('npm'), 'run', 'build'], clone)]
        for label, argv, cwd in operations:
            proc = run(argv, cwd, logs, label, timeout=600)
            summary['checks'][label] = {'exit': proc.returncode}
            if proc.returncode:
                if label == 'build':
                    summary['status'] = 'failed_or_blocked'
                raise RuntimeError(label + ' failed; inspect logs')
        summary['status'] = 'failed_or_blocked'
        gates = [
            ('eval-full', [shutil.which('node'), 'dist/scripts/eval-full.js', '--out', str(out / 'eval-full')]),
            ('acceptance-v6', [shutil.which('node'), '--test', '--test-reporter=tap', 'dist/tests/acceptance-v6/gate-r6.test.js']),
            ('python-core', [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'research/decision-choice/jev04/tests', '-p', 'test_*.py', '-v']),
            ('python-port', [sys.executable, '-B', '-m', 'unittest', 'discover', '-s', 'research/decision-choice/jev04/scorers/tests', '-p', 'test_*.py', '-v'])]
        for label, argv in gates:
            proc = run(argv, clone, logs, label, timeout=900)
            summary['checks'][label] = {'exit': proc.returncode, 'ok': proc.returncode == 0}
            if label.startswith('python'):
                counts = unittest_counts(proc.stdout + '\n' + proc.stderr)
                summary['checks'][label]['counts'] = counts
                summary['checks'][label]['ok'] = proc.returncode == 0 and bool(counts['ran']) and not counts['failures'] and not counts['errors']
        value = json.loads((out / 'eval-full/summary.json').read_text(encoding='utf-8'))
        summary['checks']['eval-full']['summary'] = value
        summary['checks']['eval-full']['ok'] = summary['checks']['eval-full']['exit'] == 0 and value.get('failed') == 0 and value.get('blocked') == 0 and value.get('passed', 0) > 0
        post = run([sys.executable, '-B', str(clone / 'handoff/20261113-sprint-r6/tools/preflight.py'),
                    '--repo', str(clone), '--out', str(out / 'postflight')], clone, logs, 'frozen-after')
        summary['checks']['frozen-after'] = {'exit': post.returncode, 'ok': post.returncode == 0}
        summary['status'] = 'cpu_checks_passed' if post.returncode == 0 and all(summary['checks'][label]['ok'] for label, _ in gates) else 'failed_or_blocked'
    except Exception as exc:
        summary['error'] = type(exc).__name__ + ': ' + str(exc)
    summary['exit'] = 0 if summary['status'] == 'cpu_checks_passed' else (1 if summary['status'] == 'failed_or_blocked' else 2)
    write(out / 'final-summary.json', summary)
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return summary['exit']


if __name__ == '__main__':
    raise SystemExit(main())
