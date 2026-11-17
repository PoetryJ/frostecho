from pathlib import Path
import json,hashlib,tarfile,subprocess
b=Path(__file__).resolve().parent
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
sessions=sorted((b/'web-service-v2').iterdir());assert len(sessions)==1
s=sessions[0];result_files=sorted(s.glob('*.result.json'))
results=[json.loads(p.read_text()) for p in result_files];assert len(results)==16
for p,r in zip(result_files,results):
 q=json.loads(p.with_name(p.name.replace('.result.json','.request.json')).read_text())
 assert hashlib.sha256(q['requestJson'].encode()).hexdigest()==q['inputSha256']==r['inputSha256']
 assert r['candidateSetHash']==q['request']['candidateSetHash']
 assert r['identity']['headSha256']=='a3a2196a72b081838e3379e86dc2e3bbc27e3b8473cce11eddb04c23e2d909c2'
 assert not r.get('error') and r['identity']['countsAsAdmitted'] is False
comparison=json.loads((b/'web-restore-comparison.json').read_text());assert len(comparison)==7 and all(r['equal'] for r in comparison)
world=json.loads((b/'web-after-restore/session.json').read_text())['world']
report={'schema':'frostecho.real-web-verification/1','backendSourceHead':'3f8121aaeb7057dc928606cd41a6ce4568fec193',
 'frontendPatch':'Only public/r7/app.js replaces raw candidate IDs with their descriptions; backend/model frozen.',
 'frontendSha256':sha(b/'source-v2/public/r7/app.js'),'modelDecisions':16,'encoderForwardCalls':results[-1]['identity']['encoderForwardCalls'],
 'headSha256':results[-1]['identity']['headSha256'],'mode':'jev-experimental','countsAsAdmitted':False,
 'saveRestore':comparison,'restoredClock':world['simTime'],'restoredVersion':world.get('version'),
 'restoredResources':world['resources'],'gpuProcessesAfterRestore':subprocess.run(['nvidia-smi','--query-compute-apps=pid,used_gpu_memory','--format=csv,noheader'],capture_output=True,text=True).stdout,
 'url':'http://127.0.0.1:18748/','transport':'Existing SSH loopback forward; server only binds 127.0.0.1',
 'knownGameplayIssue':'npc_05 gather firewood at warehouse; real receipt npc_05-r8-673:gathered:673, missing authoritative gathering location precondition'}
(b/'web-verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
roots=[b/n for n in ['web-before-restore','web-after-restore','web-service-v2','web-restore-comparison.json','web-verification.json','runs/web-v2','source-v2/public/r7/app.js','collect_web_evidence.py']]
files=sorted(set(p for r in roots for p in ([r] if r.is_file() else r.rglob('*')) if p.is_file()))
index=[{'path':str(p.relative_to(b)),'bytes':p.stat().st_size,'sha256':sha(p)} for p in files]
(b/'web-raw-index.json').write_text(json.dumps(index,indent=2)+'\n')
archive=b/'web-v2-evidence.tar.gz'
with tarfile.open(archive,'x:gz') as t:
 for p in files:t.add(p,arcname=str(p.relative_to(b)))
 t.add(b/'web-raw-index.json',arcname='web-raw-index.json')
print(json.dumps({'archive':str(archive),'bytes':archive.stat().st_size,'sha256':sha(archive),'files':len(files),'report':report}))
