from pathlib import Path
from datetime import datetime
import argparse,json,statistics
ap=argparse.ArgumentParser();ap.add_argument('--repo',required=True,type=Path);ap.add_argument('--out',required=True,type=Path);args=ap.parse_args()
p=args.repo/'artifacts/r10/c';meta=json.loads((p/'enc-gpu1/metadata.json').read_text(encoding='utf-8'));events=[json.loads(s) for s in (p/'enc-gpu1/forward-events.jsonl').read_text(encoding='utf-8').splitlines()]
starts={r['callId']:r for r in events if r['event']=='started'};completed={r['callId']:r for r in events if r['event']=='completed'}
assert len(starts)==len(completed)==158 and set(starts)==set(completed)
traces=[r['trace'] for r in completed.values()];s=sum(t['forwardSeconds'] for t in traces)
span=(datetime.fromisoformat(events[-1]['utc'])-datetime.fromisoformat(events[0]['utc'])).total_seconds()
report={'scope':'R10 C evidence only; no new GPU/model invocation','realGpuEncodingForwardsVerified':158,
 'allCallsHaveLogicalGpuPeak':all(t['peakCudaAllocatedMiBByLogical']['0']>1000 for t in traces),'physicalGpu':meta['featureIdentity']['physicalGpus'],
 'peakAllocatedMiB':max(t['peakCudaAllocatedMiBByLogical']['0'] for t in traces),'sumForwardSeconds':s,'forwardCardHours':s/3600,
 'forwardJournalSpanSeconds':span,'invocationWallSeconds':meta['wallSecondsThisInvocation'],'invocationCardHourEstimate':meta['wallSecondsThisInvocation']/3600,
 'entireGpuResidentSeconds':None,'entireGpuResidentCardHours':None,'allR10CResourceConsumption':None,
 'unknownReason':'Forward traces prove GPU use during calls. No complete independent allocation/free monitor or process lifetime for encoding, three identity loads, intervening idle periods and all attempts; cannot claim exact total GPU residence or billing.',
 'supersededEvidence':json.loads((p/'EVIDENCE.json').read_text(encoding='utf-8'))['cost'][:2],
 'deliveredTrainerCpuSeconds':{recipe:json.loads((p/f'train-{recipe}-gpu1/training-manifest.json').read_text(encoding='utf-8'))['seconds'] for recipe in ['base','discharge']},
 'interpretation':'About 0.465 single-card hours is an invocation-duration estimate, not audited full lifetime. Delivered heads are CPU-trained on GPU-extracted features. Do not count superseded all-CPU wall time as GPU-card hours.'}
args.out.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8');print(json.dumps(report))
