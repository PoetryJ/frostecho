#!/usr/bin/env python3
"""Train real shared action heads on frozen joint features, as weak supervision.

This experiment does not change the formal research data or execution gates.
Train/dev select a head; test is evaluated after selection, never optimized.
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import time

import numpy as np


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def load_bound(corpus, directory):
    rows = [json.loads(line) for line in corpus.read_text(encoding='utf-8').splitlines() if line]
    by_id = {row['caseId']: row for row in rows}
    if len(rows) != len(by_id):
        raise ValueError('duplicate caseIds')
    meta = json.loads((directory / 'metadata.json').read_text())
    cache, records_file = directory / 'features.npz', directory / 'records.jsonl'
    if sha(cache) != meta['cacheSha256'] or sha(records_file) != meta['recordsSha256']:
        raise ValueError('feature file hash mismatch')
    if meta['encoderForwardCalls'] <= 0:
        raise ValueError('real completed encoder calls required')
    records = [json.loads(line) for line in records_file.read_text().splitlines() if line]
    with np.load(cache, allow_pickle=False) as data:
        vectors, offsets = data['cand'], data['rowOffsets']
        case_ids, candidate_ids = data['caseIds'].tolist(), data['candidateIds'].tolist()
    if case_ids != [row['caseId'] for row in records] or set(case_ids) != set(by_id):
        raise ValueError('cache/corpus identity differs')
    result, owners, text_owners = [], {}, {}
    for i, rec in enumerate(records):
        source = by_id[rec['caseId']]
        env = source.get('envelope', source)
        request = env['request']
        split = source['split']
        if split not in ('train', 'dev', 'test') or rec['split'] != split:
            raise ValueError('wrong split')
        if source.get('labelSource') != 'reference-imitation' or source.get('researchTrainReady') is not False:
            raise ValueError('this tool only runs explicitly labelled weak-reference experiments')
        if hashlib.sha256(env['requestJson'].encode()).hexdigest() != rec['inputSha256']:
            raise ValueError('original model input mismatch')
        family = source.get('sourceFamily', source.get('episode'))
        if not family:
            raise ValueError('source family required')
        if family in owners and owners[family] != split:
            raise ValueError('source family crosses partitions')
        owners[family] = split
        text_hash = env['renderedTextSha256']
        if text_hash in text_owners and text_owners[text_hash] != split:
            raise ValueError('visible text crosses partitions')
        text_owners[text_hash] = split
        begin, end = int(offsets[i]), int(offsets[i+1])
        ids = [c['id'] for c in request['candidates']]
        if candidate_ids[begin:end] != ids or rec['candidateIds'] != ids:
            raise ValueError('candidate rows do not match original input')
        good = source['acceptableIds']
        if rec['acceptableIds'] != good or not good or not set(good) <= set(ids):
            raise ValueError('label identity mismatch')
        values = vectors[begin:end]
        if values.shape != (len(ids), 5120) or not 2 <= len(ids) <= 8 or not np.isfinite(values).all():
            raise ValueError('invalid real joint feature shape')
        result.append({'caseId': rec['caseId'], 'split': split, 'features': values,
                       'ids': ids, 'good': [ids.index(x) for x in good], 'inputSha256': rec['inputSha256']})
    if any(not any(r['split'] == split for r in result) for split in ('train', 'dev', 'test')):
        raise ValueError('train/dev/test all required')
    return result, meta


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--corpus', type=Path, required=True)
    p.add_argument('--features-dir', type=Path, required=True)
    p.add_argument('--head', type=Path, required=True)
    p.add_argument('--out', type=Path, required=True)
    p.add_argument('--device', default='cuda:0')
    p.add_argument('--epochs', type=int, default=40)
    p.add_argument('--batch-size', type=int, default=16)
    p.add_argument('--lr', type=float, default=0.001)
    p.add_argument('--allow-weak-reference', action='store_true', required=True)
    args = p.parse_args()
    if args.out.exists():
        raise SystemExit('choose a new experiment output')
    import torch
    from torch import nn
    from safetensors.torch import load_file, save_file
    started = time.monotonic()
    rows, meta = load_bound(args.corpus, args.features_dir)
    args.out.mkdir(parents=True)
    device = torch.device(args.device)
    if device.type == 'cuda':
        torch.cuda.init()
        torch.cuda.reset_peak_memory_stats(device)
    groups = {split: [i for i,r in enumerate(rows) if r['split'] == split] for split in ('train','dev','test')}
    max_k = max(len(r['ids']) for r in rows)
    h = torch.zeros(len(rows), max_k, 5120, device=device)
    valid = torch.zeros(len(rows), max_k, device=device, dtype=torch.bool)
    acceptable = torch.zeros_like(valid)
    for i,row in enumerate(rows):
        h[i,:len(row['ids'])] = torch.from_numpy(row['features']).to(device)
        valid[i,:len(row['ids'])] = True
        acceptable[i,row['good']] = True

    class Head(nn.Module):
        def __init__(self):
            super().__init__()
            self.norm = nn.LayerNorm(5120, elementwise_affine=False, eps=1e-5)
            self.score = nn.Linear(5120, 1, bias=False)

        def forward(self, indices):
            return self.score(self.norm(h[indices])).squeeze(-1).masked_fill(~valid[indices], -torch.inf)

    def set_loss(logits, indices):
        return (torch.logsumexp(logits, -1) -
                torch.logsumexp(logits.masked_fill(~acceptable[indices], -torch.inf), -1)).mean()

    def evaluate(head, split, details=False):
        indices = groups[split]
        with torch.no_grad():
            logits = head(indices)
            selected = logits.argmax(-1)
            correct = acceptable[indices, selected]
            result = {'cases': len(indices), 'setNll': float(set_loss(logits, indices)),
                      'referenceAgreement': float(correct.float().mean())}
            if details:
                result['predictions'] = [{'caseId':rows[i]['caseId'], 'inputSha256':rows[i]['inputSha256'],
                    'candidateIds':rows[i]['ids'], 'logits':logits[j,:len(rows[i]['ids'])].cpu().tolist(),
                    'selectedId':rows[i]['ids'][int(selected[j])], 'agreesWithWeakLabel':bool(correct[j])}
                    for j,i in enumerate(indices)]
            return result

    baseline = Head().to(device)
    baseline.load_state_dict(load_file(str(args.head)), strict=True)
    baseline_metrics = {split:evaluate(baseline,split) for split in groups}
    results=[]
    for init in ['warm','random']:
        for seed in [17,43]:
            torch.manual_seed(seed)
            head = Head().to(device)
            if init=='warm': head.load_state_dict(baseline.state_dict())
            optimizer=torch.optim.AdamW(head.parameters(),lr=args.lr,weight_decay=0.01)
            best_epoch=0
            best_dev=evaluate(head,'dev')
            best={k:v.detach().cpu().clone() for k,v in head.state_dict().items()}
            curve=[]
            for epoch in range(args.epochs):
                order=np.random.default_rng(seed+epoch).permutation(groups['train']).tolist()
                for start in range(0,len(order),args.batch_size):
                    indices=order[start:start+args.batch_size]
                    optimizer.zero_grad(set_to_none=True)
                    loss=set_loss(head(indices),indices)
                    loss.backward()
                    optimizer.step()
                train,dev=evaluate(head,'train'),evaluate(head,'dev')
                curve.append({'epoch':epoch+1,'train':train,'dev':dev})
                if dev['setNll']<best_dev['setNll']:
                    best_epoch,best_dev=epoch+1,dev
                    best={k:v.detach().cpu().clone() for k,v in head.state_dict().items()}
            head.load_state_dict(best)
            path=args.out/f'{init}-{seed}.safetensors'
            save_file(best,str(path))
            restored=Head().to(device)
            restored.load_state_dict(load_file(str(path)),strict=True)
            with torch.no_grad():
                left,right=head(groups['dev']),restored(groups['dev'])
                restore_delta=float((left[valid[groups['dev']]]-right[valid[groups['dev']]]).abs().max())
            result={'init':init,'seed':seed,'selectedEpoch':best_epoch,'dev':best_dev,
                    'checkpoint':path.name,'checkpointSha256':sha(path),'restoreMaxAbsDelta':restore_delta,
                    'curve':curve,'train':evaluate(head,'train'),'test':evaluate(head,'test',True)}
            results.append(result)
            (args.out/f'{init}-{seed}.json').write_text(json.dumps(result,indent=2)+'\n')
            print(json.dumps({k:result[k] for k in ['init','seed','selectedEpoch','dev','train','checkpointSha256']}),flush=True)
    chosen=min(results,key=lambda r:r['dev']['setNll'])
    selected={'schema':'frostecho.action-weak-experiment/1','experimental':True,
      'researchTrainReady':False,'mayTrainOnJev':False,'countsAsAdmitted':False,'calibrated':False,
      'labelSource':'reference-imitation','independentReviews':0,'device':str(device),
      'corpusSha256':sha(args.corpus),'cacheSha256':meta['cacheSha256'],
      'featureIdentityHash':meta['featureIdentityHash'],'featureIdentity':meta['featureIdentity'],
      'encodingExecution':meta['execution'],'encodingQualification':meta['qualification'],
      'torchVersion':torch.__version__,'cudaRuntime':torch.version.cuda,
      'initialHeadSha256':sha(args.head),'selectedCheckpoint':chosen['checkpoint'],
      'selectedCheckpointSha256':chosen['checkpointSha256'],'selection':'lowest dev set-NLL, never test',
      'counts':{k:len(v) for k,v in groups.items()},'baseline':baseline_metrics,
      'selectedMetrics':{k:chosen[k] for k in ['init','seed','selectedEpoch','dev','train','test']},
      'trainingCodeSha256':sha(__file__),'backboneGradients':0,'backboneLoadedByTrainer':False,
      'epochs':args.epochs,'batchSize':args.batch_size,'learningRate':args.lr,
      'seconds':time.monotonic()-started,
      'peakCudaAllocatedMiB':torch.cuda.max_memory_allocated(device)/2**20 if device.type=='cuda' else 0,
      'limitations':['Weak reference agreement is not action optimality or long-horizon intelligence.',
                     'No independent blind labels or calibration/risk certificate in this experiment.']}
    (args.out/'selected.json').write_text(json.dumps(selected,indent=2)+'\n')
    print(json.dumps({'status':'trained','selected':chosen['checkpoint'],'seconds':selected['seconds']}),flush=True)


if __name__=='__main__':
    main()
