"""Read-only R9 audit: raw envelopes, corpus, head math, and saved authority."""
import argparse, collections, hashlib, json, math, struct, statistics
from pathlib import Path
import numpy as np

parser=argparse.ArgumentParser()
parser.add_argument('--repo',type=Path,required=True)
parser.add_argument('--features',type=Path)
parser.add_argument('--out',type=Path,required=True)
args=parser.parse_args();repo=args.repo;r9=repo/'artifacts/r9'
sha=lambda b:hashlib.sha256(b).hexdigest()
load=lambda p:json.loads(p.read_text(encoding='utf-8'))
lines=lambda p:[json.loads(s) for s in p.read_text(encoding='utf-8').splitlines() if s]
def counts(values):return dict(sorted(collections.Counter(values).items()))
def one(p,pattern):
 ps=[q for q in p.glob(pattern) if not q.name.endswith('.r8.json')];assert len(ps)==1,(p,pattern,ps);return ps[0]
def weights(p):
 raw=p.read_bytes();n=struct.unpack('<Q',raw[:8])[0];header=json.loads(raw[8:8+n]);item=header['score.weight']
 assert item['dtype']=='F32'
 a,z=item['data_offsets'];return np.frombuffer(raw[8+n+a:8+n+z],dtype='<f4').astype('float64').reshape(-1)
def logits(x,w):
 x=x.astype('float64');return (x-x.mean(axis=1,keepdims=True))/np.sqrt(x.var(axis=1,keepdims=True)+1e-5)@w
def metric(z,accept):
 p=np.exp(z-z.max());p/=p.sum();return int(z.argmax()) in accept,float(-np.log(p[accept].sum()))
rows=lines(r9/'corpus-v3/cases.jsonl');byid={r['caseId']:r for r in rows}
for r in rows:
 assert sha(r['requestJson'].encode())==r['inputSha256']
 assert json.loads(r['requestJson'])==r['request']
 assert sha(r['rendered']['text'].encode())==r['renderedTextSha256']
texts=collections.defaultdict(set)
for r in rows:texts[r['rendered']['text']].add(r['split'])
joined=load(r9/'blind-review/joined.json');agreed=[r for r in joined['rows'] if r['identical']]
corpus={
 'cases':len(rows),'sourceHeads':counts(str(r['sourceHEAD']) for r in rows),'actorIds':counts(r['request']['actorId'] for r in rows),
 'casesBySplit':counts(r['split'] for r in rows),'uniqueVisibleTexts':len(texts),'uniqueVisibleTextsBySplit':{split:len({r['rendered']['text'] for r in rows if r['split']==split}) for split in ['train','dev','test']},'crossSplitSameVisibleText':sum(len(s)>1 for s in texts.values()),
 'byScenario':{},'allRowsCapturedBeforeExecution':all(r['modelCalls']==r['worldCommits']==0 and r['realModel'] is False for r in rows),
 'sourceFamilySplits':{fam:counts(r['split'] for r in rows if r['sourceFamily']==fam) for fam in sorted(set(r['sourceFamily'] for r in rows))}}
for scenario in sorted(set(r['scenario'] for r in rows)):
 group=[r for r in rows if r['scenario']==scenario]
 corpus['byScenario'][scenario]={
 'cases':len(group),'uniqueVisibleTexts':len({r['rendered']['text'] for r in group}),'splits':counts(r['split'] for r in group),'medicalOffered':sum(any(c['parameters']['action']=='medical' for c in r['request']['candidates']) for r in group),
 'nonEmptyGoals':sum(bool(r['request']['goals']) for r in group),
 'cancelMemoryPresent':sum(any('cancel' in m['kind'] for m in r['request']['memoryFacts']) for r in group),
 'allCandidatesWeaklyAcceptable':sum(set(r['acceptableIds'])==set(c['id'] for c in r['request']['candidates']) for r in group),
 'nonwaitExactlyWeakLabel':sum(set(r['acceptableIds'])==set(c['id'] for c in r['request']['candidates'] if c['parameters']['action']!='wait') for r in group),
 'weakAcceptableFractionMean':statistics.mean(len(r['acceptableIds'])/len(r['request']['candidates']) for r in group)}
blind={
 'cases':len(joined['rows']),'agreed':len(agreed),'quarantined':len(joined['rows'])-len(agreed),
 'agreedByScenario':counts(r['scenario'] for r in agreed),'quarantinedByScenario':counts(r['scenario'] for r in joined['rows'] if not r['identical']),
 'allCandidatesAcceptedOnAgreed':sum(set(r['intersection'])==set(c['id'] for c in byid[r['realCaseId']]['request']['candidates']) for r in agreed),
 'uniformCandidateExpectedHitOnAgreed':statistics.mean(len(r['intersection'])/len(byid[r['realCaseId']]['request']['candidates']) for r in agreed),
 'acceptanceSizes':counts(str(len(r['intersection'])) for r in agreed)}
headpaths={'old':repo/'artifacts/sprint-r7/legacy-reuse/c43-increment-batch4-1/warm-start-17/best.safetensors',
 'warm-17':r9/'trained-v3/warm-17.safetensors','warm-43':r9/'trained-v3/warm-43.safetensors',
 'random-17':r9/'trained-v3/random-17.safetensors','random-43':r9/'trained-v3/random-43.safetensors'}
manifest=load(r9/'trained-v3/selected.json')
training={'headHashes':{k:sha(p.read_bytes()) for k,p in headpaths.items()},'selectedCheckpoint':manifest['selectedCheckpoint'],
 'selectedHeadIsOldBytes':headpaths['old'].read_bytes()==headpaths['warm-17'].read_bytes(),
 'featureIdentity':manifest['featureIdentity'],'featureIdentityHash':manifest['featureIdentityHash'],
 'selectionRule':manifest['selection'],'formalGates':{k:manifest[k] for k in ['researchTrainReady','mayTrainOnJev','countsAsAdmitted','calibrated']},
 'numpyRecomputed':False}
if args.features:
 f=args.features;data=np.load(f/'features.npz',allow_pickle=False);ids=data['caseIds'].tolist();offset=data['rowOffsets'];vectors=data['cand']
 assert sha((f/'features.npz').read_bytes())==manifest['cacheSha256']
 metadata=load(f/'metadata.json');records=lines(f/'records.jsonl')
 assert set(ids)==set(byid) and len(ids)==len(rows)
 training['cacheMetadata']=metadata;training['numpyRecomputed']=True;training['independentMetrics']={}
 training['cacheSourceInputShaMatchesCorpusSha']=metadata['source']['inputsSha256']==sha((r9/'corpus-v3/cases.jsonl').read_bytes())
 training['cacheRecordInputMismatches']=[r['caseId'] for r in records if r['inputSha256']!=byid[r['caseId']]['inputSha256']]
 training['cacheRecordAcceptableMismatches']=[r['caseId'] for r in records if set(r.get('acceptableIds',[]))!=set(byid[r['caseId']]['acceptableIds'])]
 training['cacheRecordSplitMismatches']=[r['caseId'] for r in records if r['split']!=byid[r['caseId']]['split']]
 training['individualPredictions']={}
 for name,p in headpaths.items():
  w=weights(p);predictions={};weak=collections.defaultdict(list);review=collections.defaultdict(list);fullreviewA=[];fullreviewB=[];quarantine=[]
  agreed_lookup={x['realCaseId']:x for x in agreed};all_lookup={x['realCaseId']:x for x in joined['rows']}
  for i,caseid in enumerate(ids):
   r=byid[caseid];candids=[c['id'] for c in r['request']['candidates']];z=logits(vectors[int(offset[i]):int(offset[i+1])],w)
   pred=candids[int(z.argmax())];predictions[caseid]={'selectedId':pred,'logits':z.tolist()}
   hit,nll=metric(z,[candids.index(x) for x in r['acceptableIds']]);weak[r['split']].append((hit,nll))
   if caseid in agreed_lookup:
    ar=agreed_lookup[caseid];hit,nll=metric(z,[candids.index(x) for x in ar['intersection']]);review['ALL'].append((hit,nll));review[ar['scenario']].append((hit,nll))
   if caseid in all_lookup:
    ar=all_lookup[caseid];fullreviewA.append(pred in ar['reviewA']);fullreviewB.append(pred in ar['reviewB'])
    if not ar['identical']:quarantine.append({'caseId':caseid,'selectedId':pred,'inA':pred in ar['reviewA'],'inB':pred in ar['reviewB']})
  summarise=lambda groups:{k:{'cases':len(v),'hits':sum(x[0] for x in v),'top1':statistics.mean(x[0] for x in v),'nll':statistics.mean(x[1] for x in v)} for k,v in groups.items()}
  training['independentMetrics'][name]={'weak':summarise(weak),'agreedReview':summarise(review),'reviewA48Hits':sum(fullreviewA),'reviewB48Hits':sum(fullreviewB),'quarantinedPredictions':quarantine}
  training['individualPredictions'][name]=predictions
 training['metricVsShippedMaxDelta']=max(abs(training['independentMetrics'][name]['agreedReview']['ALL']['nll']-next(x for x in load(r9/'review-eval.json')['heads'] if x['head']==headpaths[name].name)['setNll']) for name in ['warm-17','random-43'])
paired={}
for arm in ['reference','jev']:
 d=r9/'paired'/arm;summary=load(one(d,'summary-*.json'));trajectory=lines(one(d,'trajectory-*.jsonl'));runtime=load(one(d,'runtime-*.json'));session=load(one(d,'session-*.json'))
 def cand(r):return next((c for c in r['candidates'] if c['id']==r['selectedId']),None)
 def action(r):
  c=cand(r)
  if c is None:return 'none'
  p=c['parameters'];return p['action']+(':'+p.get('resource','') if p['action']=='gather' else '')
 actionrows=[r for r in trajectory if r['scorerId']!='council-reference/1']
 work=runtime['workLog'];tasks=runtime['states']['tasks']['tasks']
 pe={'sourceHEAD':summary['sourceHEAD'],'seed':summary['seed'],'memoryPolicy':summary['memoryPolicy'],'ending':summary['endings'],
 'totalDecisions':len(trajectory),'actionDecisions':len(actionrows),'councilReferenceDecisions':len(trajectory)-len(actionrows),'executionStatus':counts(r['executionStatus'] for r in trajectory),
 'actionSelection':counts(action(r) for r in actionrows),'actionExecutionStatus':counts(r['executionStatus'] for r in actionrows),
 'byActorActions':{a:counts(action(r) for r in actionrows if r['actorId']==a) for a in sorted(set(r['actorId'] for r in actionrows))},
 'resources':session['world']['resources'],'furnace':session['world']['furnace'],'workLogRecords':len(work),'workLogFirstRows':work[:2],
 'workLogStatuses':counts(x['status'] for x in work),'workRejectedDetails':[x for x in work if x['status']=='rejected'],
 'gatheredByResource':counts(e['payload'].get('resource') for e in runtime['committed'] if e['type']=='gathered'),
 'gatheredAmountByResource':{resource:sum(e['payload'].get('amount',0) for e in runtime['committed'] if e['type']=='gathered' and e['payload'].get('resource')==resource) for resource in ['food','firewood']},
 'tasks':counts(t['status'] for t in tasks),'doneByTaskType':counts(t['type'] for t in tasks if t['status']=='done'),
 'events':counts(e['type'] for e in runtime['committed']),
 'workPending':len(runtime['work']),'allNPCPromisesEmpty':all(not n.get('promises') for n in session['world']['npcs'].values()),
 'health':[n['health'] for n in session['world']['npcs'].values()]}
 if arm=='jev':
  transcript=lines(one(d,'scorer-*.jsonl'));requests=[r['envelope'] for r in transcript if r['event']=='score_request'];replies=[r['reply'] for r in transcript if r['event']=='score_reply']
  byreq={r['request']['requestId']:r for r in requests};byrep={r['requestId']:r for r in replies};assert len(byreq)==len(requests)==len(replies)==len(actionrows)
  for r in actionrows:
   q=byreq[r['requestId']];p=byrep[r['requestId']]
   assert sha(q['requestJson'].encode())==q['inputSha256']==p['inputSha256']==r['inputSha256']
   assert r['selectedId']==p['selectedId'] and r['candidateSetHash']==p['candidateSetHash']==q['request']['candidateSetHash']
  lat=sorted(r['latencyMs'] for r in replies)
  pe['neuralRequestsVerified']=len(requests);pe['lastIdentity']=replies[-1]['identity'];pe['latencyMs']={'median':statistics.median(lat),'p95NearestRank':lat[math.ceil(.95*len(lat))-1],'sum':sum(lat),'max':max(lat)}
  pe['requestPromisesNonEmpty']=sum(bool(r['request']['observation']['self']['promises']) for r in requests)
  pe['relationshipPromisesNonEmpty']=sum(bool(r['request']['relationships']['promises']) for r in requests)
  pe['goalKinds']=counts(str(g.get('goal',g.get('type'))) for r in requests for g in r['request']['goals'])
  pe['memorySelections']=counts(r.get('memorySelection') or '(none)' for r in actionrows)
  pe['encoderForwardCounts']=replies[-1]['identity']['encoderForwardCalls']
  pe['identityHashes']=counts(r['identity'].get('featureIdentityHash') or '(none)' for r in replies)
  pe['replyFeatureMetadataPresent']=sum('encoder' in r for r in replies)
  stderr=''.join(r['text'] for r in transcript if r['event']=='scorer_stderr')
  startup=None
  for line in stderr.splitlines():
   try:
    value=json.loads(line)
    if isinstance(value,dict) and value.get('event')=='ready':startup=value
   except json.JSONDecodeError:pass
  pe['recoveredStartup']=startup
  pe['peakCudaAllocatedMiBByLogical']={k:max(r['encoder']['peakCudaAllocatedMiBByLogical'].get(k,0) for r in replies) for k in sorted(set(k for r in replies for k in r['encoder'].get('peakCudaAllocatedMiBByLogical',{})))}
  pe['realRequestResourcesLast']={r['request']['actorId']:r['request']['observation']['resources'] for r in requests[-8:]}
 paired[arm]=pe
report={'schema':'frostecho.r9.independent-model-audit/1','repo':str(repo),'corpus':corpus,'blindReview':blind,'training':training,'paired':paired,
 'judgment':['Real online scoring and same-seed fourday survival tie are evidenced.','41/41 is on a broad acceptable-set agreed subset, after a non-dev head was selected for deployment; not confirmatory generalization.','The corpus is manually constructed decision capture, not actual model-visited trajectories.','The fourday runner does not pass goalBridge; no nonempty promise inputs means it is not a long-horizon commitment evaluation.','Blind-review provenance requires original model session metadata; raw output alone only verifies content consistency.']}
args.out.parent.mkdir(parents=True,exist_ok=True);args.out.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
startup=paired['jev']['recoveredStartup']
identity={'schema':'frostecho.r9.train-deploy-identity-comparison/1','trainingFeatureIdentityHash':manifest['featureIdentityHash'],
 'onlineFeatureIdentityHash':paired['jev']['lastIdentity']['featureIdentityHash'],
 'sameFeatureIdentity':manifest['featureIdentityHash']==paired['jev']['lastIdentity']['featureIdentityHash'],
 'onlineTrainingManifestSha256':paired['jev']['lastIdentity']['trainingManifestSha256'],
 'trainingActualParameterBytesByDevice':manifest['featureIdentity']['actualParameterBytesByDevice'],
 'onlineActualParameterBytesByDevice':startup['featureIdentity']['actualParameterBytesByDevice'],
 'onlineDeviceMap':startup['featureIdentity']['deviceMap'],'onlinePeakCudaAllocatedMiBByLogical':paired['jev']['peakCudaAllocatedMiBByLogical'],
 'onlinePhysicalGpus':startup['encoder']['physicalGpus'],'trainingMetadataRealEncoder':training['cacheMetadata']['realEncoder'] if args.features else None,
 'interpretation':'Online GPU inference is proved by recovered ready device map and per-forward peaks. Training and online feature identities differ; no cross-placement numerical qualification is supplied, and missing training manifest bypasses the available identity check. CPU-only training identity metadata contradicts claimed encoding placement; investigate its provenance without claiming the real feature values were CPU-computed.'}
(args.out.parent/'train-online-identity.json').write_text(json.dumps(identity,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k not in ['paired','training']},ensure_ascii=True))
print(json.dumps({'paired':{k:{n:v[n] for n in ['totalDecisions','actionDecisions','executionStatus','actionSelection','furnace','workLogRecords','tasks']} for k,v in paired.items()}},ensure_ascii=True))
