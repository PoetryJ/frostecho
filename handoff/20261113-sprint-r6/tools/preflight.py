"""CPU-only prerequisite and immutable-byte checks. No server/model access."""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile

for stream in (sys.stdout, sys.stderr):
    if hasattr(stream, 'reconfigure'):
        stream.reconfigure(encoding='utf-8')

BASE = 'f4739493b9dcec7214f04ab68c05f92bd5a8ea21'
TAG = 'r5-saved-20261112'


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def verify_manifest(base, manifest):
    base = Path(base).resolve()
    records = []
    for line in Path(manifest).read_text(encoding='utf-8-sig').splitlines():
        expected, relative = line.split(None, 1)
        relative = relative.lstrip('*')
        target = (base / relative).resolve()
        if not target.is_relative_to(base) or len(expected) != 64:
            raise ValueError('invalid manifest path/hash: ' + relative)
        if not target.is_file() or sha(target) != expected.lower():
            raise ValueError('manifest mismatch: ' + relative)
        records.append(relative)
    if not records or len(records) != len(set(records)):
        raise ValueError('empty or duplicate manifest')
    return {'files': len(records), 'ok': True}


def restore_g11(repo):
    verify_manifest(repo / 'evidence', repo / 'evidence/g11-original-evidence.sha256')
    copied = 0
    # Validate every member and every existing destination before any writes.
    with tarfile.open(repo / 'evidence/g11-original-evidence.tar.gz', 'r:gz') as archive:
        pending = []
        for member in archive.getmembers():
            target = (repo / member.name).resolve()
            if not target.is_relative_to(repo / 'artifacts/g11-live'):
                if member.isdir() and target in (repo, repo / 'artifacts'):
                    continue
                raise ValueError('unexpected G11 archive path: ' + member.name)
            if member.isdir():
                continue
            if not member.isfile():
                raise ValueError('unsupported G11 archive member: ' + member.name)
            data = archive.extractfile(member).read()
            if target.exists():
                if not target.is_file() or target.read_bytes() != data:
                    raise ValueError('refusing to overwrite different G11 evidence: ' + member.name)
            else:
                pending.append((target, data))
        for target, data in pending:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data)
            copied += 1
    return {'copiedMissingFiles': copied, 'source': 'packaged historical evidence, not live'}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--repo', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--restore-g11', action='store_true')
    args = parser.parse_args()
    repo, out = Path(args.repo).resolve(), Path(args.out).resolve()
    if out.exists():
        raise SystemExit('refusing existing output directory: ' + str(out))
    out.mkdir(parents=True)
    result = {'schema': 'frostecho.r6.preflight/1', 'at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
              'repo': str(repo), 'python': sys.version, 'pythonExecutable': sys.executable,
              'platform': platform.platform(), 'machine': platform.machine(),
              'commands': [], 'checks': {}, 'status': 'blocked'}
    try:
        def run(argv):
            proc = subprocess.run(argv, cwd=repo, capture_output=True, text=True,
                                  encoding='utf-8', errors='replace', timeout=30)
            result['commands'].append({'argv': argv, 'exit': proc.returncode,
                                       'stdout': proc.stdout, 'stderr': proc.stderr})
            if proc.returncode:
                raise RuntimeError('command failed: ' + argv[0])
            return proc.stdout.strip()
        for name in ('git', 'node', 'npm'):
            resolved = shutil.which(name)
            if not resolved:
                raise RuntimeError('missing executable: ' + name)
            run([resolved, '--version'])
        result['head'] = run(['git', 'rev-parse', 'HEAD'])
        if run(['git', 'rev-parse', TAG + '^{commit}']) != BASE:
            raise RuntimeError('baseline tag mismatch')
        run(['git', 'merge-base', '--is-ancestor', BASE, 'HEAD'])
        package = Path(__file__).resolve().parents[1]
        result['checks']['package'] = verify_manifest(package, package / 'SHA256SUMS.txt')
        result['checks']['checkpoint'] = verify_manifest(repo, repo / 'checkpoints/20261112-r5/CHECKPOINT-SHA256')
        result['checks']['r5Delivery'] = verify_manifest(repo / 'artifacts/sprint-r5/delivery', repo / 'artifacts/sprint-r5/delivery/PACKAGE-SHA256')
        result['checks']['r5TaskPackage'] = verify_manifest(repo / 'handoff/20261112-sprint-r5', repo / 'handoff/20261112-sprint-r5/SHA256SUMS.txt')
        if args.restore_g11:
            result['g11'] = restore_g11(repo)
        result['status'] = 'ready_for_cpu_work'
    except Exception as exc:
        result['error'] = type(exc).__name__ + ': ' + str(exc)
    (out / 'preflight.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result['status'] == 'ready_for_cpu_work' else 2


if __name__ == '__main__':
    raise SystemExit(main())
