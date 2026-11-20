"""Independent CPU-only arithmetic and provenance audit; no production imports."""
from pathlib import Path
import argparse, collections, hashlib, json, math, statistics, struct
import numpy as np

ap=argparse.ArgumentParser();ap.add_argument('--repo',type=Path,required=True);ap.add_argument('--out',type=Path,required=True)
args=ap.parse_args();root=args.repo.resolve();p=root/'artifacts/r10/c'
sha=lambda raw:hashlib.sha256(raw).hexdigest()
load=lambda file:json.loads(file.read_text(encoding='utf-8'))
lines=lambda file:[json.loads(s) for s in file.read_text(encoding='utf-8').splitlines() if s]
counts=lambda vs:dict(sorted(collections.Counter(vs).items()))
def stable(value):return sha(json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode())
def head(file):
 raw=file.read_bytes();n=struct.unpack('<Q',raw[:8])[0];header=json.loads(raw[8:8+n]);assert set(header)=={'score.weight'}
 row=header['score.weight'];assert row['dtype']=='F32' and row['shape']==[1,5120]
 a,b=row['data_offsets'];return np.frombuffer(raw[8+n+a:8+n+b],dtype='<f4').astype('float64').reshape(-1)
def summary(rows,case_map):
 sizes=[(len(r['acceptableIds']),len(case_map[r['caseId']]['request']['candidates'])) for r in rows]
 nonempty=[x for x in sizes if x[0]>0];partial=[x for x in sizes if 0<x[0]<x[1]]
 return {'cases':len(rows),'all':sum(a==k for a,k in sizes),'none':sum(a==0 for a,k in sizes),'partial':len(partial),
  'uniformExpectedAllCases':statistics.mean(a/k for a,k in sizes) if sizes else None,
  'uniformExpectedNonemptyOnly':statistics.mean(a/k for a,k in nonempty) if nonempty else None,
  'uniformExpectedDiscriminativeOnly':statistics.mean(a/k for a,k in partial) if partial else None}
captures=lines(p/'capture/cases.jsonl');byid={r['caseId']:r for r in captures};assert len(byid)==312
for r in captures:
 assert sha(r['requestJson'].encode())==r['inputSha256'];assert json.loads(r['requestJson'])==r['request']
 assert sha(r['rendered']['text'].encode())==r['renderedTextSha256']
 assert r['actorId']==r['request']['actorId']
primary=lines(p/'labels-primary/labels.jsonl');derived={name:lines(p/f'labels-{name}/labels.jsonl') for name in ['base','discharge'] if (p/f'labels-{name}/labels.jsonl').exists()}
missing_derived=[name for name in ['base','discharge'] if name not in derived]
if 'discharge' in missing_derived:derived['discharge']=primary
primary_map={r['caseId']:r for r in primary};fact_errors=[];label_errors=[];branchtimes=[];branch_analyses=[]
for r in primary:
 case=byid[r['caseId']];candidates=case['request']['candidates'];assert [b['candidateId'] for b in r['branches']]==[c['id'] for c in candidates]
 for b in r['branches']:
  base=b['firstAction']['status']=='applied' and b['terminal']['actorAlive'] and b['terminal']['alive']>=b['branchPoint']['alive'] and not b['acceptedTaskLost']
  discharge=base and not b['obligationsStillOwed']
  if base!=b['acceptableBase'] or discharge!=b['acceptable']:fact_errors.append((r['caseId'],b['candidateId']))
  assert b['parameters']==candidates[b['candidateIndex']]['parameters']
  t=b['terminal']['simTime']-((b['branchPoint']['day']-1)*1440+b['branchPoint']['minuteOfDay'])
  branchtimes.append(t)
 terminaltimes=[b['terminal']['simTime'] for b in r['branches']]
 branch_analyses.append({'caseId':r['caseId'],'differentTerminalTimeAcrossCandidates':min(terminaltimes)!=max(terminaltimes),
  'terminalTimeRange':max(terminaltimes)-min(terminaltimes),
  'hasAcceptedTasks':bool(r['branches'][0]['branchPoint']['acceptedTasks']),
  'allLabelsAccept':r['allAcceptable'],'noLabelsAccept':r['noneAcceptable'],
  'firstActionFailureBranches':sum(b['firstAction']['status']!='applied' for b in r['branches']),
  'allBranchesFirstApplied':all(b['firstAction']['status']=='applied' for b in r['branches']),
  'pendingObligationBranches':sum(bool(b['obligationsStillOwed']) for b in r['branches'])})
for name,rows in derived.items():
 for r in rows:
  expected=[]
  for b in primary_map[r['caseId']]['branches']:
   good=b['firstAction']['status']=='applied' and b['terminal']['actorAlive'] and b['terminal']['alive']>=b['branchPoint']['alive'] and not b['acceptedTaskLost']
   if name=='discharge':good=good and not b['obligationsStillOwed']
   if good:expected.append(b['candidateId'])
  if expected!=r['acceptableIds']:label_errors.append((name,r['caseId']))
corpora={name:lines(p/f'corpus-{name}-e2/corpus.jsonl') for name in ['base','discharge']}
cache=p/'enc-gpu1';meta=load(cache/'metadata.json');records=lines(cache/'records.jsonl')
assert sha((cache/'features.npz').read_bytes())==meta['cacheSha256'];assert sha((cache/'records.jsonl').read_bytes())==meta['recordsSha256'];assert stable(meta['featureIdentity'])==meta['featureIdentityHash']
record_map={r['caseId']:r for r in records}
with np.load(cache/'features.npz',allow_pickle=False) as z:
 vectors=z['cand'];offsets=z['rowOffsets'];caseids=z['caseIds'].tolist()
assert set(caseids)==set(record_map)==set(r['caseId'] for r in corpora['base'])==set(r['caseId'] for r in corpora['discharge'])
features={}
for i,caseid in enumerate(caseids):
 record=record_map[caseid];case=byid[caseid];x=vectors[int(offsets[i]):int(offsets[i+1])].astype('float64')
 assert x.shape==(len(case['request']['candidates']),5120);assert np.isfinite(x).all()
 assert record['inputSha256']==case['inputSha256'];assert record['candidateIds']==[c['id'] for c in case['request']['candidates']]
 features[caseid]=(x-x.mean(axis=1,keepdims=True))/np.sqrt(x.var(axis=1,keepdims=True)+1e-5)
def metrics(rows,w):
 hits=0;loss=[];dhits=0;dloss=[];allhit=0;predictions=[];allrows=len(rows)
 for r in rows:
  ids=[c['id'] for c in byid[r['caseId']]['request']['candidates']];z=features[r['caseId']]@w;idx=int(z.argmax());selected=ids[idx]
  a=[ids.index(x) for x in r['acceptableIds']];good=idx in a;allhit+=good
  record={'caseId':r['caseId'],'selectedId':selected,'logits':z.tolist(),'acceptableCount':len(a),'candidateCount':len(ids),'hit':good}
  predictions.append(record)
  if not a:continue
  logz=float(np.logaddexp.reduce(z));lossvalue=logz-float(np.logaddexp.reduce(z[a]));loss.append(lossvalue);hits+=good
  if len(a)<len(ids):dhits+=good;dloss.append(lossvalue)
 return {'allCases':allrows,'allCaseHits':allhit,'allCaseHitRate':allhit/allrows if allrows else None,
  'nonemptyCases':len(loss),'nonemptyHits':hits,'nonemptyHitRate':hits/len(loss) if loss else None,'nonemptyNll':statistics.mean(loss) if loss else None,
  'discriminativeCases':len(dloss),'discriminativeHits':dhits,'discriminativeHitRate':dhits/len(dloss) if dloss else None,'discriminativeNll':statistics.mean(dloss) if dloss else None,
  'predictions':predictions}
train={};metric_differences=[];splitstats={};basepath=root/'artifacts/sprint-r7/legacy-reuse/c43-increment-batch4-1/warm-start-17/best.safetensors'
for recipe,rows in corpora.items():
 folder=p/f'train-{recipe}-gpu1';manifest=load(folder/'training-manifest.json');decision=load(folder/'dev-decisions.json')
 assert sha((folder/manifest['selectedCheckpoint']).read_bytes())==manifest['selectedCheckpointSha256']
 assert sha((p/f'corpus-{recipe}-e2/corpus.jsonl').read_bytes())==manifest['corpusSha256']
 assert manifest['cacheSha256']==meta['cacheSha256'] and manifest['featureIdentityHash']==meta['featureIdentityHash']
 owners={};texts={};splitstats[recipe]={}
 for r in rows:
  e=r['envelope'];cap=byid[r['caseId']];assert e['inputSha256']==cap['inputSha256'] and e['requestJson']==cap['requestJson']
  assert owners.setdefault(r['sourceEpisodeId'],r['split'])==r['split'];assert texts.setdefault(e['renderedTextSha256'],r['split'])==r['split']
 for split in ['train','dev','test']:
  group=[r for r in rows if r['split']==split];splitstats[recipe][split]=summary(group,byid)
  splitstats[recipe][split]['episodes']=sorted(set(r['sourceEpisodeId'] for r in group))
 expected=sorted(decision['candidates'],key=lambda r:(r['dev']['setNll'],r['selectedEpoch'],0 if r['init']=='warm' else 1,r['seed']))[0]
 assert expected['checkpoint']==decision['chosen']==manifest['selectedCheckpoint']
 entry={'selected':manifest['selectedCheckpoint'],'selectionFromRoundedDevVerified':True,'headResults':{},'trainingManifest':manifest}
 for name in ['initial','warm-17','warm-43','random-17','random-43']:
  path=basepath if name=='initial' else folder/(name+'.safetensors');w=head(path);result={};deltas=[]
  for split in ['train','dev','test']:result[split]=metrics([r for r in rows if r['split']==split],w)
  if name!='initial':
   details=load(folder/(name+'.json'));assert sha(path.read_bytes())==details['checkpointSha256']
   curve=details['curve'];assert len(curve)==manifest['epochs']==40
   dev=result['dev'];metric_differences.append(abs(round(dev['nonemptyNll'],6)-details['dev']['setNll']))
   entry['headResults'][name]={'sha256':sha(path.read_bytes()),'matchesInitialBytes':path.read_bytes()==basepath.read_bytes(),'selectedEpoch':details['selectedEpoch'],
    'curveEpochs':len(curve),'devNllRaw':dev['nonemptyNll'],'recordedRoundedDevNll':details['dev']['setNll'],
    'rawBetterThanChosen':dev['nonemptyNll']<metrics([r for r in rows if r['split']=='dev'],head(folder/manifest['selectedCheckpoint']))['nonemptyNll'], 'metrics':result}
  else:entry['headResults'][name]={'sha256':sha(path.read_bytes()),'metrics':result}
 selected_name=manifest['selectedCheckpoint'].replace('.safetensors','');shipped=load(folder/'test-eval.json')['metrics'];test=entry['headResults'][selected_name]['metrics']['test']
 assert shipped['cases']==test['nonemptyCases'] and abs(shipped['top1InAcceptable']-test['nonemptyHitRate'])<=0.00000051
 train[recipe]=entry
report={'schema':'frostecho.r10.independent-training-audit/1','sourceHead':'288a28859a4eb872345771d25618769e127e434b','actualNewGpuOrModelCalls':0,
 'capture':{'cases':len(captures),'episodes':len(set(r['sourceEpisodeId'] for r in captures)),'actorCounts':counts(r['actorId'] for r in captures),
  'profiles':counts(r['scenarioProfile'] for r in captures),'policyScorers':counts(r['policyRun']['scorerId'] for r in captures),'modelVisited':sum(r['realModel'] for r in captures),
  'sourceHeads':counts(str(r['sourceHEAD']) for r in captures),'days':counts(str(r['day']) for r in captures),'withMedical':sum(any(c['parameters']['action']=='medical' for c in r['request']['candidates']) for r in captures),
  'withGoals':sum(bool(r['request']['goals']) for r in captures),'allDistinctRendered':len(set(r['renderedTextSha256'] for r in captures))==len(captures)},
 'labels':{name:summary(rows,byid) for name,rows in {'primary':primary,**derived}.items()},'missingDerivedFullLabelsFiles':missing_derived,'predicateFactErrors':fact_errors,'derivedLabelErrors':label_errors,
 'branchCounts':sum(len(r['branches']) for r in primary),'branchHorizonDurations':counts(str(t) for t in branchtimes),
 'casesDifferentTerminalTimeAcrossCandidates':sum(r['differentTerminalTimeAcrossCandidates'] for r in branch_analyses),
 'primaryNoAcceptAllFirstAppliedCases':sum(r['noLabelsAccept'] and r['allBranchesFirstApplied'] for r in branch_analyses),
 'branchAnalyses':branch_analyses,'encodedCases':len(caseids),'encodedCandidateRows':len(vectors),'cacheIdentity':meta['featureIdentityHash'],
 'corpusSplitStats':splitstats,'training':train,'maxRoundedDevMetricDifference':max(metric_differences)}
args.out.parent.mkdir(parents=True,exist_ok=True);args.out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:report[k] for k in ['capture','labels','branchCounts','casesDifferentTerminalTimeAcrossCandidates','primaryNoAcceptAllFirstAppliedCases','encodedCases','corpusSplitStats','maxRoundedDevMetricDifference']},ensure_ascii=True,indent=2))
