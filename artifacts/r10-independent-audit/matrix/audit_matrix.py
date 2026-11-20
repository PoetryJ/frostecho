"""Read-only H/E evidence audit, no model/GPU/game/production mutation."""
from pathlib import Path
import collections,gzip,hashlib,json,subprocess,os,tempfile
repo=Path(os.environ.get('FROSTECHO_REPO_ROOT',Path(__file__).resolve().parents[3])).resolve()
out=Path(os.environ.get('FROSTECHO_AUDIT_OUT',tempfile.mkdtemp(prefix='frostecho-r10-audit-')));out.mkdir(parents=True,exist_ok=True)
matrix=repo/'artifacts/r10/matrix'
load=lambda p:json.loads(p.read_text(encoding='utf-8'))
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
dist=lambda x:dict(sorted(collections.Counter(x).items()))
table=load(matrix/'matrix-table.json')
reports=[]
for row in table['rows']:
 d=repo/row['dir'];report={'arm':row['arm'],'seed':row['seed'],'family':row['family'],'status':row['status'],'exits':row['exits'],'path':row['dir'],'source':row['source']}
 pre=load(d/'preflight.json');report['manifestPassedToService']='--training-manifest' in pre.get('command',[])
 report['preflight']={k:pre.get(k) for k in ['ok','code','reason','headSha256','manifestSha256','manifestFeatureIdentityHash','manifestBinding']}
 if (d/'metrics.json').exists():
  metrics=load(d/'metrics.json');final=load(d/'final-state.json');d2=load(d/'d2-exit.json');resume=load(d/'resume-load.json');replay=load(d/'replay.json')
  fp=final['fingerprint'];commitments=load(d/'d2/session.json.commitments.json')['commitments']
  allwork=fp['workLog'];retained=fp['intents']
  report['metrics']={k:metrics.get(k) for k in ['decisions','decisionStates','decisionsByPolicy','rejectedAtExecution','realFulfilment','authorisedExit','deadlineTimeouts','cancelled','effectsAfterCancel','unauthorisedChanges','duplicateReceipts','noProgressRounds','survivors','ending','resources','resourceCoverageHours','furnaceLitHours','workHours','crises','memory','reconciled']}
  report['settlement']={'reportedIntentsDenominator':metrics['settlement']['intents'],'reportedByStatus':metrics['settlement']['byStatus'],'reportedFailures':metrics['settlement']['failures'],
   'reportedReasons':dist(x.get('reason') for x in metrics['settlement']['failureList']),
   'retainedIntentCount':len(retained),'allWorkLogCount':len(allwork),'allWorkLogStatuses':dist(x['status'] for x in allwork),
   'prunedWorkLogIds':len({x['intentId'] for x in allwork}-{x['intentId'] for x in retained}),
   'failureList':metrics['settlement']['failureList']}
  report['checkpoint']={'at':d2['simTime'],'day':d2['simTime']//1440+1,'minuteOfDay':d2['simTime']%1440,'pending':d2['checkpoint']['pending'],
   'commitmentBoundPending':d2['checkpoint']['commitmentBound'],'pendingActions':dist(x['action'] for x in d2['checkpoint']['intents']),
   'commitmentStatuses':dist(x['status'] for x in commitments),'activeCommitmentIds':[x['commitmentId'] for x in commitments if x['status']=='active'],
   'interference':d2['interference'],'startPid':d2['pid'],'resumePid':resume['pid'],'newProcess':d2['pid']!=resume['pid'],'resumeMismatch':resume.get('mismatch'),
   'resumeChecksScope':'simTime, pending count, each saved working intent id/status/dueAt; fingerprint replay is selected projection, not full save equality',
   'replay':{'equivalent':replay['equivalent'],'countsAsModelResult':replay['countsAsModelResult']}}
  report['opportunityCoverage']={'initialActivePromises':4,'activePromisesAtInterference':(d2.get('interference') or {}).get('activeRows',0),
   'cancelTriggered':(d2.get('interference') or {}).get('cancel') is not None,'unagreedChangeTriggered':(d2.get('interference') or {}).get('change') is not None,
   'conditionLiftedInjected':False,'resourceContentionInjected':False,
   'activePromisesAtCheckpoint':sum(x['status']=='active' for x in commitments),'pendingPromiseWorkAtCheckpoint':d2['checkpoint']['commitmentBound']}
  report['serviceResults']=[];errors=[];requests={};reply_count=0
  for p in sorted(d.glob('scorer/**/*.result.json')):
   r=load(p);q=load(p.with_name(p.name.replace('.result.json','.request.json')))
   valid=hashlib.sha256(q['requestJson'].encode()).hexdigest()==q['inputSha256']==r['inputSha256'] and q['request']['candidateSetHash']==r['candidateSetHash']
   if not valid:errors.append(str(p.relative_to(repo)))
   ident=r['identity'];reply_count+=1;requests[q['request']['requestId']]=r['selectedId']
   report['serviceResults'].append({'requestId':r['requestId'],'inputSha256':r['inputSha256'],'headSha256':ident.get('headSha256'),
    'featureIdentityHash':ident.get('featureIdentityHash'),'trainingManifestSha256':ident.get('trainingManifestSha256'),'countsAsAdmitted':ident.get('countsAsAdmitted')})
  decision_rows=[]
  for p in [d/'decisions-start.jsonl',d/'decisions-resume.jsonl']:
   decision_rows.extend(json.loads(l) for l in p.read_text(encoding='utf-8').splitlines() if l)
  modelrows=[x for x in decision_rows if x.get('policy')=='model']
  report['liveBinding']={'results':reply_count,'uniqueRequests':len(requests),'requestHashErrors':errors,
   'trajectorySelectedMismatch':[x['requestId'] for x in modelrows if x['requestId'] in requests and requests[x['requestId']]!=x['selectedId']],
   'manifestShaDistribution':dist(str(x['trainingManifestSha256']) for x in report['serviceResults']),
   'headShaDistribution':dist(x['headSha256'] for x in report['serviceResults']),
   'featureIdentityDistribution':dist(x['featureIdentityHash'] for x in report['serviceResults'])}
  del report['serviceResults']
  report['evidenceHashCheck']={'checked':0,'missing':[],'different':[]}
  summary=load(d/'summary.json')
  for name,expected in summary.get('evidence',{}).items():
   p=d/name
   if not p.exists():report['evidenceHashCheck']['missing'].append(name)
   elif sha(p)!=expected:report['evidenceHashCheck']['different'].append(name)
   else:report['evidenceHashCheck']['checked']+=1
 reports.append(report)

e=repo/'artifacts/r10-e/parity/2026-11-18T08-29-51-291Z'
er=load(e/'report.json');tickchecks=[]
for i in range(9):
 a=json.loads(gzip.decompress((e/f'ticks/tick-{i:03}-2d.json.gz').read_bytes()))
 b=load(e/f'ticks/tick-{i:03}-3d.json')['snapshot']
 checks={'session':a['sessionId']==b['sessionId'],'simTime':a['observation']['simTime']==b['simTime'],'resources':a['observation']['resources']==b['resources'],
  'furnace':all(a['observation']['furnace'].get(k)==b['furnace'].get(k) for k in ['lit','fuel','warmth']),
  'actors':all(a['positions'][x['id']]['legacyPosition']['mapId']==x['mapId'] and a['positions'][x['id']]['legacyPosition']['cell']==x['cell'] for x in b['actors'])}
 tickchecks.append({'tick':i,'checks':checks})
vendored=load(repo/'public/r7/visual/VENDORED.json')
vbad=[p for p,s in vendored['upstreamFiles'].items() if sha(repo/'public/r7/visual'/p)!=s]
result={'schema':'frostecho.r10-independent-h-e-audit/1','auditSourceHead':subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),
 'matrixSource':table['source'],'matrixChecks':table['checks'],'rows':reports,
 'cost':{'matrixServiceWallSeconds':sum(r.get('gpuWallSeconds',0) for r in table['rows']),'matrixSingleGpuServiceWallHours':sum(r.get('gpuWallSeconds',0) for r in table['rows'])/3600,
  'scope':'one GPU configured; allocated service wall including load, not utilization/billing. Excludes encoding/training/probes/other runs. Whole R10 budget requires combined ledger; no automatic reset to 10h.'},
 'visual':{'source':er['identity'],'browser':er['browser'],'recordedVerdict':er['verdict'],'recomputedTickChecks':tickchecks,'clockProbe':er['observations']['clockProbe'],
  'vendoredFileCount':len(vendored['upstreamFiles']),'vendoredHashDifferences':vbad,
  'scope':'HTTP JSON projection parity and static module assets; no actual WebGPU canvas/frame/browser interaction evidence.'}}
(out/'independent-matrix-evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'rows':[{k:r[k] for k in ['arm','seed','status']}|({'checkpoint':r['checkpoint'],'opportunities':r['opportunityCoverage'],'settlement':{k:v for k,v in r['settlement'].items() if k!='failureList'},'binding':r['liveBinding']} if 'checkpoint' in r else {}) for r in reports],
 'cost':result['cost'],'visualTickPass':all(all(x['checks'].values()) for x in tickchecks),'vendoredBad':vbad},ensure_ascii=False))
