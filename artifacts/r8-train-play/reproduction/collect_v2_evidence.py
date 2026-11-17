"""Archive completed frozen run; keep large raw evidence outside Git."""
from pathlib import Path
import collections, gzip, hashlib, json, math, shutil, statistics, tarfile

base=Path(__file__).resolve().parent
source=base/'source-v2'; exp=source/'artifacts/r8-train-play'
run=base/'runs/round-v2'
assert json.loads((run/'status.json').read_text())['status']=='complete'
compact=base/'compact-v2'; compact.mkdir(exist_ok=False)
def sha(p):
 h=hashlib.sha256()
 with p.open('rb') as f:
  for chunk in iter(lambda:f.read(1024*1024),b''):h.update(chunk)
 return h.hexdigest()
def doc(p):return json.loads(p.read_text())
def one(folder,stem):
 ps=[p for p in folder.glob(stem+'-*') if not p.name.endswith('.r8.json')]
 assert len(ps)==1,(stem,ps)
 return ps[0]
def copy(p,d):d.parent.mkdir(parents=True,exist_ok=True);shutil.copy2(p,d)
def counts(v):return dict(sorted(collections.Counter(v).items()))
paired={}
for arm,folder in [('jev','live-fullmap-fourday-v2'),('reference','reference-fullmap-v2')]:
 d=exp/folder
 summary=doc(one(d,'summary'));runtime=doc(one(d,'runtime'));session=doc(one(d,'session'))
 rows=[json.loads(line) for line in one(d,'trajectory').read_text().splitlines() if line]
 neural=[r for r in rows if r['scorerId']!='council-reference/1']
 tasks=runtime['states']['tasks']['tasks']
 paired[arm]={'summary':summary,'allRows':len(rows),'referenceCouncilRows':len(rows)-len(neural),
  'actionRows':len(neural),'actionScorers':counts(r['scorerId'] for r in neural),
  'executionStatus':counts(r['executionStatus'] for r in neural),
  'reasons':counts(r.get('reason') or '(none)' for r in neural if not r['executed']),
  'finalResources':session['world']['resources'],
  'taskStatuses':counts(t['status'] for t in tasks),
  'doneTasks':counts(t['type'] for t in tasks if t['status']=='done'),
  'committedTaskCompletions':sum(e['type']=='task_completed' for e in runtime['committed'])}
 if arm=='jev':
  transcript=[json.loads(l) for l in one(d,'scorer').read_text().splitlines() if l]
  req={r['envelope']['request']['requestId']:r['envelope'] for r in transcript if r['event']=='score_request'}
  replies={r['reply']['requestId']:r['reply'] for r in transcript if r['event']=='score_reply' and 'requestId' in r['reply']}
  assert len(req)==len(replies)==len(neural)
  for r in neural:
   request=req[r['requestId']];reply=replies[r['requestId']]
   assert hashlib.sha256(request['requestJson'].encode()).hexdigest()==request['inputSha256']==reply['inputSha256']==r['inputSha256']
   assert r['selectedId']==reply['selectedId'] and r['candidateSetHash']==reply['candidateSetHash']
  times=sorted(r['latencyMs'] for r in replies.values())
  paired[arm]['realForwards']=max(r['identity']['encoderForwardCalls'] for r in replies.values())
  paired[arm]['failedReplies']=sum(bool(r.get('error')) for r in replies.values())
  paired[arm]['latencyMs']={'median':statistics.median(times),'p95NearestRank':times[math.ceil(.95*len(times))-1],'max':max(times),'sum':sum(times)}
  paired[arm]['headSha256s']=sorted(set(r['identity']['headSha256'] for r in replies.values())) if 'headSha256' in next(iter(replies.values()))['identity'] else []
assert paired['jev']['summary']['seed']==paired['reference']['summary']['seed']
assert paired['jev']['summary']['sourceHEAD']==paired['reference']['summary']['sourceHEAD']
report={'schema':'frostecho.real-fullmap-paired/1','arms':paired,
 'limits':['One paired seed. Same survival is not a gain.','Council voting and negotiation are reference mechanics.','Weak reference labels; no calibrated risk or general long-memory guarantee.']}
(base/'v2-fullmap-paired.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
roots=[exp/n for n in ['corpus-96-v2','features-96-v2-dualgpu-single','trained-96-v2','reference-fullmap-v2','live-fullmap-restore-v2','live-commitment-v2','live-service-v2','live-fullmap-fourday-v2']]
roots += [run]+[base/n for n in ['environment.json','online-deploy-v2.json','v2-fullmap-paired.json','full-tests-v2.json','full-tests-v2.log','full-tests-isolated-v2.json','full-tests-isolated-v2.log','r8-train-play-source-v2.bundle','run_round_v2.py','collect_v2_evidence.py']]
files=sorted(set(p for r in roots if r.exists() for p in ([r] if r.is_file() else r.rglob('*')) if p.is_file()))
index=[{'path':str(p.relative_to(base)),'bytes':p.stat().st_size,'sha256':sha(p)} for p in files]
(base/'v2-raw-index.json').write_text(json.dumps(index,indent=2)+'\n')
full=base/'v2-full-evidence.tar.gz'
with tarfile.open(full,'x:gz') as a:
 for p in files:a.add(p,arcname=str(p.relative_to(base)))
 a.add(base/'v2-raw-index.json',arcname='v2-raw-index.json')
for p in (exp/'trained-96-v2').rglob('*'):
 if p.is_file():copy(p,compact/'training'/p.name)
for n in ['metadata.json','records.jsonl','qualification.json','forward-events.jsonl']:
 copy(exp/'features-96-v2-dualgpu-single'/n,compact/'encoding'/n)
for n in ['environment.json','online-deploy-v2.json','v2-fullmap-paired.json','full-tests-v2.json','full-tests-isolated-v2.json']:
 copy(base/n,compact/n)
for folder in ['reference-fullmap-v2','live-fullmap-restore-v2','live-commitment-v2','live-fullmap-fourday-v2']:
 for p in (exp/folder).iterdir():
  if p.name.startswith('summary-') or p.name in ['online-report.json','report.json']:copy(p,compact/folder/p.name)
  if p.name.startswith('trajectory-') or p.name=='decisions.jsonl':
   dest=compact/folder/(p.name+'.gz');dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(gzip.compress(p.read_bytes(),mtime=0))
for p in run.iterdir():
 if p.suffix=='.json' or p.name=='resources.jsonl':copy(p,compact/'run'/p.name)
for folder in sorted((exp/'live-service-v2').iterdir()):
 copy(folder/'startup.json',compact/'service'/folder.name/'startup.json')
 results=sorted(folder.glob('*.result.json'))
 for p in results[:2]+results[-2:]:
  copy(p,compact/'service'/folder.name/p.name)
  q=p.with_name(p.name.replace('.result.json','.request.json'));copy(q,compact/'service'/folder.name/q.name)
manifest={'rawArchive':str(full),'rawArchiveBytes':full.stat().st_size,'rawArchiveSha256':sha(full),'rawFiles':len(files),
 'compactFiles':[{'path':str(p.relative_to(compact)),'bytes':p.stat().st_size,'sha256':sha(p)} for p in sorted(compact.rglob('*')) if p.is_file()]}
(compact/'EVIDENCE-INDEX.json').write_text(json.dumps(manifest,indent=2)+'\n')
small=base/'compact-v2.tar.gz'
with tarfile.open(small,'x:gz') as a:
 for p in sorted(compact.rglob('*')):
  if p.is_file():a.add(p,arcname=str(p.relative_to(compact)))
print(json.dumps({'archive':str(small),'sha256':sha(small),'bytes':small.stat().st_size,'rawBytes':full.stat().st_size,'rawSha256':sha(full)}))
