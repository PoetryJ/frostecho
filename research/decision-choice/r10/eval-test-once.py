#!/usr/bin/env python3
"""Evaluate a selected head on the held-out test split, once.

  python eval-test-once.py --corpus <corpus.jsonl> --features-dir <enc> \
      --output-dir <training dir> [--renderer-source src/r7/jev/render.ts]

`test-eval.json` is written at most once per output directory. A second run
refuses (exit 2) and writes `test-eval-refused.json`; re-selection after seeing
test requires `--exploratory --reason`, which writes a separately named file and
records that the number must be re-checked on unseen episodes before any claim.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np

HIDDEN = 5120
EPS = 1e-5


def sha(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def normalise(values):
    import torch
    centered = values - values.mean(dim=-1, keepdim=True)
    return centered / torch.sqrt((centered ** 2).mean(dim=-1, keepdim=True) + EPS)


def metrics(state, rows, features):
    import torch
    rows = [row for row in rows if row['acceptable']]
    if not rows:
        return {'cases': 0}
    total, correct = 0.0, 0
    disc_total, disc_count, disc_correct = 0.0, 0, 0
    predictions = []
    with torch.no_grad():
        for row in rows:
            values = torch.from_numpy(features[row['caseId']].astype(np.float32)).to(torch.float64)
            ids = row['candidates']
            allowed = [ids.index(value) for value in row['acceptable']]
            logits = normalise(values) @ state
            loss = (torch.logsumexp(logits, dim=0)
                    - torch.logsumexp(logits[allowed], dim=0))
            top = int(torch.argmax(logits))
            total += float(loss)
            correct += int(top in allowed)
            if len(allowed) < len(ids):
                disc_count += 1
                disc_total += float(loss)
                disc_correct += int(top in allowed)
            predictions.append({'caseId': row['caseId'], 'episode': row['episode'],
                                'candidateIds': ids, 'acceptableIds': row['acceptable'],
                                'logits': [round(float(value), 6) for value in logits],
                                'selectedId': ids[top], 'inAcceptableSet': bool(top in allowed),
                                'discriminative': len(allowed) < len(ids)})
    return {'cases': len(rows),
            'setNll': round(total / len(rows), 6),
            'top1InAcceptable': round(correct / len(rows), 6),
            'discriminativeCases': disc_count,
            'discriminativeSetNll': round(disc_total / disc_count, 6) if disc_count else None,
            'discriminativeTop1': round(disc_correct / disc_count, 6) if disc_count else None,
            'predictions': predictions}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, required=True)
    parser.add_argument('--features-dir', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--renderer-source', type=Path, default=Path('src/r7/jev/render.ts'))
    parser.add_argument('--exploratory', action='store_true')
    parser.add_argument('--reason', default='')
    args = parser.parse_args()
    out = args.output_dir
    manifest_path = out / 'training-manifest.json'
    if not manifest_path.exists():
        print('no training manifest in the output dir', file=sys.stderr)
        raise SystemExit(2)
    manifest = json.loads(manifest_path.read_text())
    first = out / 'test-eval.json'
    exploratory = out / f"test-eval-exploratory-{time.strftime('%Y%m%dT%H%M%S')}.json"
    if first.exists() and not args.exploratory:
        payload = {'refused': True, 'code': 'test-already-evaluated',
                   'detail': 'test split was already evaluated once in this directory; '
                             'use --exploratory with a reason and re-check on new episodes'}
        (out / 'test-eval-refused.json').write_text(json.dumps(payload, indent=2) + '\n')
        print(json.dumps(payload), file=sys.stderr)
        raise SystemExit(2)
    if args.exploratory and not args.reason.strip():
        print('--exploratory requires --reason', file=sys.stderr)
        raise SystemExit(2)

    corpus = [json.loads(line) for line in args.corpus.read_text().splitlines() if line.strip()]
    rows = []
    for row in corpus:
        envelope = row.get('envelope', row)
        rows.append({'caseId': row['caseId'], 'split': row['split'],
                     'episode': row.get('sourceEpisodeId'), 'acceptable': row.get('acceptableIds') or [],
                     'candidates': [candidate['id'] for candidate in envelope['request']['candidates']]})
    test_rows = [row for row in rows if row['split'] == 'test']
    with np.load(args.features_dir / 'features.npz', allow_pickle=False) as archive:
        vectors, offsets = archive['cand'], archive['rowOffsets']
        case_ids = archive['caseIds'].tolist()
    index = {case_id: position for position, case_id in enumerate(case_ids)}
    features = {}
    for row in test_rows:
        position = index[row['caseId']]
        begin, end = int(offsets[position]), int(offsets[position + 1])
        features[row['caseId']] = np.asarray(vectors[begin:end], dtype=np.float32)

    import torch
    from safetensors.numpy import load_file
    head_path = out / manifest['selectedCheckpoint']
    if sha(head_path) != manifest['selectedCheckpointSha256']:
        print('selected checkpoint SHA does not match the training manifest', file=sys.stderr)
        raise SystemExit(2)
    weight = torch.from_numpy(load_file(str(head_path))['score.weight']
                              .reshape(-1).astype(np.float64))
    result = metrics(weight, test_rows, features)
    document = {
        'schema': 'frostecho.r10c.test-eval/1',
        'firstAndOnlyRun': not first.exists(),
        'exploratory': bool(args.exploratory),
        'exploratoryReason': args.reason if args.exploratory else None,
        'evaluatedAt': time.strftime('%Y-%m-%dT%H:%M:%S'),
        'outputDir': str(out),
        'selectedCheckpoint': manifest['selectedCheckpoint'],
        'selectedCheckpointSha256': manifest['selectedCheckpointSha256'],
        'corpusSha256': sha(args.corpus),
        'cacheSha256': sha(args.features_dir / 'features.npz'),
        'featureIdentityHash': manifest['featureIdentityHash'],
        'rendererSourceSha256': sha(args.renderer_source),
        'counts': {'test': len(test_rows)},
        'metrics': {key: value for key, value in result.items() if key != 'predictions'},
        'trainEpochs': manifest.get('epochs'),
        'epochs': manifest.get('epochs'),
        'selection': manifest.get('selection'),
        'limitations': manifest.get('limitations'),
        'baseline': manifest.get('baseline'),
    }
    target = exploratory if args.exploratory else first
    target.write_text(json.dumps(document, indent=2) + '\n')
    (out / 'test-predictions.jsonl').write_text(
        '\n'.join(json.dumps(entry) for entry in result['predictions']) + '\n')
    print(json.dumps({key: document[key] for key in
                      ('firstAndOnlyRun', 'exploratory', 'counts')}
                     | {'metrics': document['metrics']}, indent=2))


if __name__ == '__main__':
    main()
