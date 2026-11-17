import copy, hashlib, importlib.util, json, shutil, subprocess, sys
from pathlib import Path

root=Path(sys.argv[1]); out=Path(sys.argv[2]); handoff=Path(sys.argv[3]); out.mkdir(parents=True,exist_ok=True)
jev=root/'research/decision-choice/jev04'
def rows(p): return [json.loads(x) for x in p.read_text(encoding='utf-8').splitlines() if x.strip()]
def load(name,path):
    spec=importlib.util.spec_from_file_location(name,path);mod=importlib.util.module_from_spec(spec);sys.modules[name]=mod;spec.loader.exec_module(mod);return mod
def sha(b): return hashlib.sha256(b).hexdigest()
def write(p,v): p.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
sys.path.insert(0,str(jev/'scorers')); import port_v3 as port
result={}
packet={x['caseId']:x for x in rows(handoff/'packet.jsonl')}
v4={x['caseId']:x for x in rows(jev/'data/v4/cases.v4.jsonl')}
raws={}; current=[]
for name,label in [('a','s1'),('b','s2')]:
    lines=[x for x in (handoff/f'review-{name}.jsonl').read_text(encoding='utf-8').splitlines() if x.strip()]
    raw={json.loads(x)['caseId']:(json.loads(x),sha(x.encode())) for x in lines};raws[name]=raw
    for r in rows(jev/f'data/v4/review-{label}.v4.jsonl'):
        original,h=raw[r['caseId']]
        current.append({'caseId':r['caseId'],'reviewer':name,'rawShaMatches':r['rawReviewSha256']==h,'judgmentPreserved':all(r[k]==original[k] for k in ['acceptableCandidateIds','status','reason','missingInformation'])})
semantic_unchanged=[]
for key,c in v4.items():
    old=packet[key]['visibleInput']
    semantic_unchanged.append({'caseId':key,'narrative':c['narrative']==old['narrative'],'facts':c['facts']==old['facts'],'candidateIdTextParams':[{k:x.get(k) for k in ['id','text','params']} for x in c['candidates']]==[{k:x.get(k) for k in ['id','text','params']} for x in old['candidates']]})
result['current_review_integrity']={'rows':len(current),'allRawShaMatch':all(x['rawShaMatches'] for x in current),'allJudgmentsPreserved':all(x['judgmentPreserved'] for x in current),'caseCount':len(semantic_unchanged),'allReviewedTextFactsParamsUnchanged':all(x['narrative'] and x['facts'] and x['candidateIdTextParams'] for x in semantic_unchanged),'details':current,'semanticProjection':semantic_unchanged}

# A changed source is copied into a separate miniature tree; never mutate the audited checkout.
mini=out/'changed-import'
data=mini/'research/decision-choice/jev04/data';data.mkdir(parents=True,exist_ok=True)
shutil.copytree(jev/'data/v3',data/'v3',dirs_exist_ok=True);shutil.copytree(jev/'data/v4',data/'v4',dirs_exist_ok=True)
mini_h=mini/'handoff/20261112-sprint-r5/blind-review';shutil.copytree(handoff,mini_h,dirs_exist_ok=True)
source=rows(data/'v3/cases.v3.jsonl');target=source[0]['caseId'];source[0]['candidates'][1]['text']='未经新审查的候选：取消所有既有承诺'
(data/'v3/cases.v3.jsonl').write_text(''.join(json.dumps(x,ensure_ascii=False)+'\n' for x in source),encoding='utf-8')
p=subprocess.run([sys.executable,str(data/'v4/import_blind_review.py')],capture_output=True,text=True)
(out/'changed-import.stdout').write_text(p.stdout);(out/'changed-import.stderr').write_text(p.stderr)
q=subprocess.run([sys.executable,str(data/'v4/validate_v4.py')],capture_output=True,text=True)
(out/'changed-validation.stdout').write_text(q.stdout);(out/'changed-validation.stderr').write_text(q.stderr)
rewritten=next(x for x in rows(data/'v4/review-s1.v4.jsonl') if x['caseId']==target)
current_review=next(x for x in rows(jev/'data/v4/review-s1.v4.jsonl') if x['caseId']==target)
result['changed_source_import']={'caseId':target,'importExit':p.returncode,'validatorExit':q.returncode,'rawReviewShaUnchanged':rewritten['rawReviewSha256']==current_review['rawReviewSha256'],'contentHashRebound':rewritten['contentHash']!=current_review['contentHash'],'newCandidateText':next(x for x in rows(data/'v4/cases.v4.jsonl') if x['caseId']==target)['candidates'][1]['text'],'validation':json.loads(q.stdout),'note':'current shipped judgments were preserved; this is a synthetic mutation proving import lacks original-input check, not evidence of current label fabrication'}

# Three distinct files with correct hashes but contradictory risk counts and artifact policy.
ident=port.ScorerIdentity(model='audit/fake',head='shared-scalar/1',adapter='audit',tokenizer='audit',renderer='audit',task='choose_action',k=4,policy_version='audit',memory_policy_version='audit')
policy={k:getattr(ident,k) for k in port.POLICY_FIELDS}; refs={}; certdir=out/'contradictory-cert';certdir.mkdir(exist_ok=True)
for partition in ['calT','select','cert']:
    payload={'schema':'frostecho.jev04.evidence/1','partition':partition,'protocol_version':port.RISK_PROTOCOL_VERSION,'valid':True,'policy':policy,'sampleIds':[partition+'-only-one']}
    if partition=='calT': payload.update(temperature=1.2,tau=.8)
    elif partition=='select': payload.update(tau=.8,accepted=120,coverage=.4)
    else:payload.update(n=120,errors=120,upper=.01,coverage=.4,alpha=.05)
    path=certdir/(partition+'.json');write(path,payload);refs[partition]={'path':str(path),'sha256':sha(path.read_bytes())}
manifest={'schema':port.MANIFEST_SCHEMA,'registrations':[{'identity':ident.as_dict(),'mode':'real','utility_source':None,'evidence':{**refs,'protocol_version':port.RISK_PROTOCOL_VERSION}}]}
art=port.ScorerArtifact(port.ARTIFACT_SCHEMA,ident,'real',.01,0.0,.4,.01)
request=port.ScorerRequest('audit',ident,['c0','c1','c2','c3'],[1,0,0,0])
decision=port.decide(art,request,manifest)
write(certdir/'manifest.json',manifest)
result['inconsistent_risk_certificate']={'decision':decision.__dict__,'certificateClaims':{'n':120,'errors':120,'upper':.01,'sampleIdsCount':1,'calibrationTemperature':1.2,'selectionTau':.8},'artifactUsed':{'temperature':art.temperature,'tau':art.tau},'note':'fabricated CPU negative case; no model/weights/GPU/world action'}
write(out/'probe.json',result)
print(json.dumps({k:({x:y for x,y in v.items() if x not in ['details','semanticProjection']} if isinstance(v,dict) else v) for k,v in result.items()},ensure_ascii=False,indent=2))
