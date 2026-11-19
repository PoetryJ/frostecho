#!/usr/bin/env python3
"""R10 C line: train the four action heads on frozen joint-c-action/2 features.

  python train-heads.py train --corpus <corpus.jsonl> --features-dir <enc> \
      --training-manifest <enc/metadata.json> --head <base.safetensors> \
      --output-dir <newDir> --renderer-source <src/r7/jev/render.ts>

Hard gates, all fail-closed before a single optimiser step:
  1. `--training-manifest` and `--output-dir` are required (no implicit paths);
     the output directory must not exist yet;
  2. the feature cache is the manifest's cache: both SHA256s must match, the
     encoder must report >0 real forwards, and its feature identity hash must be
     the hash of the identity document it ships;
  3. the manifest's renderer source SHA256 must equal the LIVE renderer's file
     hash, so a cache produced under `joint-c-action/1` (the R9 heads) is
     refused instead of silently reused;
  4. every corpus row must bind to the same renderer, the same request bytes and
     the same candidate order as the cache records;
  5. no source episode and no visible input text may cross a split; all three
     splits must be non-empty;
  6. only `train` rows reach the optimiser, `dev` selects the checkpoint, and
     `test` is not touched here at all (see eval-test-once.py).

The head is exactly `LayerNorm(5120, affine=False, eps=1e-5) -> Linear(5120,1)`,
the same function `serve_joint.py` applies (`normalized()` + `score.weight`).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

HIDDEN = 5120
EPS = 1e-5
INITS = ('warm', 'random')
SEEDS = (17, 43)


def sha(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def stable_sha(value) -> str:
    canonical = json.dumps(json.loads(json.dumps(value, ensure_ascii=False)),
                           ensure_ascii=False, sort_keys=True, separators=(',', ':'))
    return hashlib.sha256(canonical.encode()).hexdigest()


class Refusal(Exception):
    pass


REFUSAL_DIR: Path | None = None


def refuse(code: str, detail: str, out_dir: Path | None = None):
    """Fail closed, and leave the reason on disk next to the requested output."""
    payload = {'schema': 'frostecho.r10c.train-refusal/1', 'refused': True,
               'code': code, 'detail': detail}
    target = out_dir if out_dir is not None else REFUSAL_DIR
    if target is not None:
        try:
            target.mkdir(parents=True, exist_ok=True)
            (target / 'refusal.json').write_text(json.dumps(payload, indent=2) + '\n')
        except OSError:
            pass
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(2)


def load_manifest(path: Path, features: Path, renderer_source: Path | None = None) -> dict:
    """Identity first, bytes second: the renderer gate is the one that stops an
    R9 (`joint-c-action/1`) cache from being reused for a /2 corpus."""
    if not path.exists():
        refuse('manifest-missing', f'no training manifest at {path}', None)
    document = json.loads(path.read_text())
    if document.get('schema') != 'frostecho.joint-corpus-cache/1':
        refuse('manifest-schema', f"unexpected schema {document.get('schema')}", None)
    if document.get('status') != 'complete':
        refuse('manifest-incomplete', f"status={document.get('status')}", None)
    if document.get('realEncoder') is not True:
        refuse('manifest-not-real-encoder', 'realEncoder is not true', None)
    if int(document.get('encoderForwardCalls') or 0) <= 0:
        refuse('manifest-no-forwards', 'encoderForwardCalls <= 0', None)
    identity = document.get('featureIdentity')
    if not isinstance(identity, dict) or stable_sha(identity) != document.get('featureIdentityHash'):
        refuse('feature-identity-hash', 'featureIdentityHash does not hash featureIdentity', None)
    if renderer_source is not None:
        check_renderer(document, renderer_source)
    for name, key in (('features.npz', 'cacheSha256'), ('records.jsonl', 'recordsSha256')):
        if not (features / name).exists():
            refuse('cache-missing', f'{features / name} does not exist', None)
        if sha(features / name) != document.get(key):
            refuse('cache-sha' if name == 'features.npz' else 'records-sha',
                   f'{name} does not match the manifest {key}', None)
    return document


def check_renderer(manifest: dict, renderer_source: Path):
    if not renderer_source.exists():
        refuse('renderer-missing', f'no renderer at {renderer_source}', None)
    live = sha(renderer_source)
    recorded = (manifest.get('featureIdentity') or {}).get('rendererSourceSha256')
    if recorded != live:
        refuse('renderer-identity-mismatch',
               f'cache renderer {recorded} != live renderer {live}; '
               'this cache belongs to a different renderer and must be re-encoded', None)
    return live


def load_corpus(corpus_path: Path, manifest: dict, records_path: Path) -> list[dict]:
    rows = [json.loads(line) for line in corpus_path.read_text().splitlines() if line.strip()]
    if not rows:
        refuse('corpus-empty', 'no corpus rows', None)
    records = [json.loads(line) for line in records_path.read_text().splitlines() if line.strip()]
    by_id = {record['caseId']: record for record in records}
    if len(by_id) != len(records):
        refuse('records-duplicate', 'duplicate caseId in cache records', None)
    seen = set()
    owners, texts = {}, {}
    out = []
    for row in rows:
        case_id, split = row.get('caseId'), row.get('split')
        if not isinstance(case_id, str) or case_id in seen:
            refuse('corpus-caseId', f'bad or duplicate caseId {case_id}', None)
        seen.add(case_id)
        if split not in ('train', 'dev', 'test'):
            refuse('corpus-split', f'{case_id} has split {split}', None)
        envelope = row.get('envelope', row)
        if envelope.get('rendererSourceSha256') != (manifest['featureIdentity']
                                                    .get('rendererSourceSha256')):
            refuse('corpus-renderer', f'{case_id} was rendered by a different renderer', None)
        record = by_id.get(case_id)
        if record is None:
            refuse('corpus-not-encoded', f'{case_id} has no cache record', None)
        if hashlib.sha256(envelope['requestJson'].encode()).hexdigest() != record['inputSha256']:
            refuse('corpus-input-bytes', f'{case_id} request bytes differ from the cache', None)
        candidates = [candidate['id'] for candidate in envelope['request']['candidates']]
        if record['candidateIds'] != candidates:
            refuse('corpus-candidates', f'{case_id} candidate order differs from the cache', None)
        acceptable = row.get('acceptableIds') or []
        if any(value not in candidates for value in acceptable):
            refuse('corpus-labels', f'{case_id} acceptableIds are not actual candidates', None)
        episode = row.get('sourceEpisodeId') or row.get('sourceFamily') or row.get('episode')
        if not episode:
            refuse('corpus-episode', f'{case_id} has no source episode', None)
        if owners.setdefault(episode, split) != split:
            refuse('split-episode-leak', f'episode {episode} crosses partitions', None)
        text = envelope.get('renderedTextSha256')
        if texts.setdefault(text, split) != split:
            refuse('split-text-leak', f'{case_id} visible text crosses partitions', None)
        out.append({'caseId': case_id, 'split': split, 'episode': episode,
                    'acceptable': acceptable, 'candidates': candidates,
                    'inputSha256': record['inputSha256'], 'labelStatus': row.get('labelStatus'),
                    'captureKind': row.get('captureKind'),
                    'scenarioProfile': row.get('scenarioProfile')})
    for split in ('train', 'dev', 'test'):
        if not any(row['split'] == split for row in out):
            refuse('split-empty', f'split {split} is empty', None)
    return out


def load_features(features_dir: Path, rows: list[dict]) -> dict:
    records = {json.loads(line)['caseId']: json.loads(line)
               for line in (features_dir / 'records.jsonl').read_text().splitlines() if line.strip()}
    with np.load(features_dir / 'features.npz', allow_pickle=False) as archive:
        vectors, offsets = archive['cand'], archive['rowOffsets']
        case_ids = archive['caseIds'].tolist()
    index = {case_id: position for position, case_id in enumerate(case_ids)}
    features = {}
    for row in rows:
        position = index.get(row['caseId'])
        if position is None:
            refuse('cache-missing-case', f"{row['caseId']} absent from the cache", None)
        begin, end = int(offsets[position]), int(offsets[position + 1])
        values = np.asarray(vectors[begin:end], dtype=np.float32)
        if values.shape != (len(row['candidates']), HIDDEN) or not np.isfinite(values).all():
            refuse('cache-shape', f"{row['caseId']} features are not [{len(row['candidates'])},{HIDDEN}]", None)
        if records[row['caseId']]['candidateIds'] != row['candidates']:
            refuse('cache-candidates', f"{row['caseId']} cache order mismatch", None)
        features[row['caseId']] = values
    return features


def normalise(values):
    import torch
    centered = values - values.mean(dim=-1, keepdim=True)
    return centered / torch.sqrt((centered ** 2).mean(dim=-1, keepdim=True) + EPS)


def set_nll(logits, acceptable):
    import torch
    mask = torch.full_like(logits, float('-inf'))
    mask[acceptable] = logits[acceptable]
    return torch.logsumexp(logits, dim=0) - torch.logsumexp(mask, dim=0)


def read_head(path: Path):
    from safetensors.numpy import load_file
    tensors = load_file(str(path))
    if set(tensors) != {'score.weight'} or tensors['score.weight'].shape != (1, HIDDEN):
        raise SystemExit('base head must be exactly one bias-free score.weight[1,5120]')
    weights = tensors['score.weight'].reshape(-1).astype(np.float32)
    if not np.isfinite(weights).all():
        raise SystemExit('base head contains nonfinite values')
    return weights


def save_head(path: Path, weight):
    from safetensors.numpy import save_file
    save_file({'score.weight': weight.reshape(1, HIDDEN).astype(np.float32)}, str(path))


def evaluate(state, rows, features):
    """Set-NLL and top1 over the labelled subset; discriminative subset apart."""
    import torch
    if not rows:
        return {'cases': 0, 'labelledCases': 0, 'discriminativeCases': 0,
                'setNll': None, 'top1InAcceptable': None,
                'discriminativeSetNll': None, 'discriminativeTop1': None}
    total = 0.0
    labelled = 0
    correct = 0
    disc_total = 0.0
    disc_count = 0
    disc_correct = 0
    with torch.no_grad():
        for row in rows:
            values = torch.from_numpy(features[row['caseId']].astype(np.float32)).to(torch.float64)
            ids = row['candidates']
            acceptable = [ids.index(value) for value in row['acceptable']]
            logits = normalise(values) @ state
            if not acceptable:
                continue
            labelled += 1
            loss = float(set_nll(logits, acceptable))
            total += loss
            hit = int(torch.argmax(logits)) in acceptable
            correct += hit
            if len(acceptable) < len(ids):
                disc_count += 1
                disc_total += loss
                disc_correct += hit
    return {'cases': len(rows), 'labelledCases': labelled,
            'discriminativeCases': disc_count,
            'setNll': round(total / labelled, 6) if labelled else None,
            'top1InAcceptable': round(correct / labelled, 6) if labelled else None,
            'discriminativeSetNll': round(disc_total / disc_count, 6) if disc_count else None,
            'discriminativeTop1': round(disc_correct / disc_count, 6) if disc_count else None}


def train_one(init, seed, args, rows, features, base):
    import torch
    torch.manual_seed(seed)
    torch.set_num_threads(min(8, torch.get_num_threads()))
    if init == 'warm':
        start = torch.from_numpy(base.astype(np.float32)).to(torch.float64)
    else:
        generator = torch.Generator().manual_seed(seed)
        start = torch.randn(HIDDEN, dtype=torch.float64, generator=generator) * 0.02
    weight = torch.nn.Parameter(start.clone())
    optimiser = torch.optim.AdamW([weight], lr=args.lr, weight_decay=args.weight_decay)
    train_rows = [row for row in rows if row['split'] == 'train' and row['acceptable']]
    dev_rows = [row for row in rows if row['split'] == 'dev']
    best = {'epoch': 0, 'weight': weight.detach().clone(), 'dev': evaluate(weight.detach(), dev_rows, features)}
    curve = []
    for epoch in range(args.epochs):
        order = np.random.default_rng(seed + epoch).permutation(len(train_rows))
        running, batches = 0.0, 0
        for start_index in range(0, len(order), args.batch_size):
            batch = [train_rows[int(index)] for index in order[start_index:start_index + args.batch_size]]
            optimiser.zero_grad(set_to_none=True)
            losses = []
            for row in batch:
                values = torch.from_numpy(features[row['caseId']].astype(np.float32)).to(torch.float64)
                ids = row['candidates']
                logits = normalise(values) @ weight
                losses.append(set_nll(logits, [ids.index(value) for value in row['acceptable']]))
            loss = torch.stack(losses).mean()
            loss.backward()
            optimiser.step()
            running += float(loss.detach())
            batches += 1
        dev = evaluate(weight.detach(), dev_rows, features)
        curve.append({'epoch': epoch + 1, 'trainLoss': round(running / max(1, batches), 6),
                      'dev': dev})
        if dev['setNll'] is not None and (best['dev']['setNll'] is None
                                          or dev['setNll'] < best['dev']['setNll']):
            best = {'epoch': epoch + 1, 'weight': weight.detach().clone(), 'dev': dev}
    return best, curve


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--corpus', type=Path, required=True)
    parser.add_argument('--features-dir', type=Path, required=True)
    parser.add_argument('--training-manifest', type=Path, required=True)
    parser.add_argument('--head', type=Path, required=True)
    parser.add_argument('--output-dir', type=Path, required=True)
    parser.add_argument('--renderer-source', type=Path,
                        default=Path('src/r7/jev/render.ts'))
    parser.add_argument('--epochs', type=int, default=40)
    parser.add_argument('--lr', type=float, default=1e-3)
    parser.add_argument('--weight-decay', type=float, default=0.01)
    parser.add_argument('--batch-size', type=int, default=16)
    args = parser.parse_args()
    global REFUSAL_DIR
    REFUSAL_DIR = args.output_dir
    out = args.output_dir
    if out.exists():
        refuse('output-exists', f'{out} already exists; choose a new experiment dir', None)

    manifest = load_manifest(args.training_manifest, args.features_dir, args.renderer_source)
    if sha(args.training_manifest) != sha(args.features_dir / 'metadata.json'):
        refuse('manifest-not-from-cache',
               'the --training-manifest is not the metadata.json of --features-dir', None)
    renderer_sha = check_renderer(manifest, args.renderer_source)
    rows = load_corpus(args.corpus, manifest, args.features_dir / 'records.jsonl')
    features = load_features(args.features_dir, rows)
    base = read_head(args.head)
    out.mkdir(parents=True)
    started = time.monotonic()

    import torch
    counts = {split: len([row for row in rows if row['split'] == split])
              for split in ('train', 'dev', 'test')}
    acceptable_only = {split: len([row for row in rows if row['split'] == split and row['acceptable']])
                       for split in ('train', 'dev', 'test')}
    baseline = {'weight': 'initial head', 'headSha256': sha(args.head),
                'dev': evaluate(torch.from_numpy(base.astype(np.float64)), 
                                [row for row in rows if row['split'] == 'dev'], features)}
    results = []
    for init in INITS:
        for seed in SEEDS:
            best, curve = train_one(init, seed, args, rows, features, base)
            path = out / f'{init}-{seed}.safetensors'
            save_head(path, best['weight'].numpy().astype(np.float32))
            from safetensors.numpy import load_file
            reloaded = torch.from_numpy(load_file(str(path))['score.weight']
                                        .reshape(-1).astype(np.float64))
            with torch.no_grad():
                reference_case = torch.from_numpy(
                    features[rows[0]['caseId']].astype(np.float32)).to(torch.float64)
                left = normalise(reference_case) @ best['weight']
                right = normalise(reference_case) @ reloaded
                restore_delta = float((left - right).abs().max())
            entry = {'init': init, 'seed': seed, 'selectedEpoch': best['epoch'],
                     'dev': best['dev'], 'checkpoint': path.name,
                     'checkpointSha256': sha(path), 'restoreMaxAbsDelta': restore_delta,
                     'train': evaluate(best['weight'], [row for row in rows if row['split'] == 'train'], features),
                     'curve': curve}
            results.append(entry)
            (out / f'{init}-{seed}.json').write_text(json.dumps(entry, indent=2) + '\n')
            print(json.dumps({'trained': path.name, 'selectedEpoch': best['epoch'],
                              'dev': best['dev']}), flush=True)
    # Deterministic tie-break, declared up front: lower dev set-NLL, then the
    # earlier epoch, then the warm arm, then the smaller seed. Never test.
    chosen = min(results, key=lambda entry: (entry['dev']['setNll'],
                                             entry['selectedEpoch'],
                                             0 if entry['init'] == 'warm' else 1,
                                             entry['seed']))
    decisions = {
        'schema': 'frostecho.r10c.dev-decision/1',
        'selectionRule': 'lowest dev set-NLL, tie-break earliest epoch, then warm, then seed; test never read',
        'candidates': [{'checkpoint': entry['checkpoint'], 'init': entry['init'],
                        'seed': entry['seed'], 'selectedEpoch': entry['selectedEpoch'],
                        'dev': entry['dev']} for entry in results],
        'chosen': chosen['checkpoint'],
        'chosenDev': chosen['dev'],
        'baselineDev': baseline['dev'],
        'counts': counts,
        'labelledCounts': acceptable_only,
        'discriminativeCounts': {split: len([row for row in rows
                                             if row['split'] == split and row['acceptable']
                                             and len(row['acceptable']) < len(row['candidates'])])
                                 for split in ('train', 'dev', 'test')},
        'testTouched': False,
    }
    (out / 'dev-decisions.json').write_text(json.dumps(decisions, indent=2) + '\n')

    artifact = {
        'schema': 'frostecho.action-weak-experiment/1',
        'experimental': True, 'researchTrainReady': False, 'mayTrainOnJev': False,
        'countsAsAdmitted': False, 'calibrated': False,
        'labelSource': 'same-snapshot-branch-rollout', 'independentReviews': 0,
        'device': 'cpu', 'torchVersion': torch.__version__,
        'corpusSha256': sha(args.corpus),
        'cacheSha256': manifest['cacheSha256'],
        'featureIdentityHash': manifest['featureIdentityHash'],
        'featureIdentity': manifest['featureIdentity'],
        'encodingExecution': manifest.get('execution'),
        'encodingQualification': manifest.get('qualification'),
        'rendererSourceSha256': renderer_sha,
        'initialHeadSha256': sha(args.head),
        'selectedCheckpoint': chosen['checkpoint'],
        'selectedCheckpointSha256': chosen['checkpointSha256'],
        'selection': 'lowest dev set-NLL, never test',
        'counts': counts, 'labelledCounts': acceptable_only,
        'baseline': baseline, 'selectedMetrics': {
            'init': chosen['init'], 'seed': chosen['seed'],
            'selectedEpoch': chosen['selectedEpoch'], 'dev': chosen['dev'],
            'train': chosen['train']},
        'fourHeads': [{'init': entry['init'], 'seed': entry['seed'],
                       'checkpoint': entry['checkpoint'],
                       'checkpointSha256': entry['checkpointSha256'],
                       'selectedEpoch': entry['selectedEpoch'], 'dev': entry['dev']}
                      for entry in results],
        'trainingCodeSha256': sha(Path(__file__)),
        'backboneGradients': 0, 'backboneLoadedByTrainer': False,
        'epochs': args.epochs, 'batchSize': args.batch_size, 'learningRate': args.lr,
        'weightDecay': args.weight_decay,
        'normalisation': 'non-affine LayerNorm eps=1e-5 (serve_joint.normalized)',
        'seconds': time.monotonic() - started,
        # serve_joint.load_training_manifest hard-requires the weak-reference
        # schema and labelSource='reference-imitation'. This corpus is a
        # same-snapshot branch rollout, so the mismatch is stated, not papered
        # over by relabelling the data.
        'serveCompatibility': {
            'requiredSchema': 'frostecho.action-weak-experiment/1',
            'requiredLabelSource': 'reference-imitation',
            'matchesSchema': False,
            'matchesLabelSource': False,
            'presentFields': ['experimental', 'countsAsAdmitted', 'calibrated',
                              'researchTrainReady', 'mayTrainOnJev', 'featureIdentity',
                              'featureIdentityHash', 'encodingExecution',
                              'encodingQualification', 'selectedCheckpointSha256'],
            'note': 'fields serve checks are present and honest; the schema id and '
                    'labelSource differ because these labels are branch rollouts, '
                    'not reference imitation. Extending the serve allowlist is a src/ change.',
        },
        'limitations': [
            'Weak branch labels from one fixed rule controller; not human preference.',
            'All-acceptable cases carry zero gradient; see counts/discriminativeCounts.',
            'No independent blind review, no calibration or risk certificate.'],
    }
    (out / 'training-manifest.json').write_text(json.dumps(artifact, indent=2) + '\n')
    print(json.dumps({'status': 'trained', 'chosen': chosen['checkpoint'],
                      'dev': chosen['dev'], 'seconds': artifact['seconds']}, indent=2))


if __name__ == '__main__':
    main()
