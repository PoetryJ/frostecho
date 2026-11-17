import copy, hashlib, importlib.util, json, subprocess, sys, urllib.request
from pathlib import Path

repo, out = map(Path, sys.argv[1:3]); out.mkdir(parents=True, exist_ok=True)
base = repo / 'research/decision-choice/jev04'
def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); sys.modules[name] = value
    spec.loader.exec_module(value); return value
v4 = module('v4', base/'data/v4/validate_v4.py')
fixture = module('fixture', base/'data/v4/rejections.py')
trainer = module('trainer', base/'models/encoder_train.py')
prep = module('prep', base/'models/prepare_t27.py')
result = {'head': subprocess.check_output(['git','rev-parse','HEAD'],cwd=repo,text=True).strip(),
          'v4_declared': json.loads((base/'data/v4/gate-v4.json').read_text()),
          'actual_formal_training_gate': trainer.gate_status()}
def validate(name, mutate=None):
    root=out/name; root.mkdir(exist_ok=True)
    data=fixture.build_fixture(root)
    if mutate: mutate(root,data)
    p=subprocess.run([sys.executable,str(base/'data/v4/validate_v4.py'),'--dir',str(root)],capture_output=True,text=True)
    (out/(name+'.stdout')).write_text(p.stdout); (out/(name+'.stderr')).write_text(p.stderr)
    return {'exit':p.returncode, 'payload':json.loads(p.stdout)}
result['v4_fixture_baseline']=validate('baseline')
def candidate_change(root,data):
    data['cases'][0]['candidates'][0]['kind']='withdraw'
    data['cases'][0]['candidates'][0]['text']='New action content never reviewed'
    fixture.write_rows(root/'cases.v4.jsonl',data['cases'])
result['candidate_semantics_changed']=validate('candidate-semantics',candidate_change)
def label_change(root,data):
    data['train'][0]['label']='not-a-candidate'
    data['train'][0]['acceptableOpaque']=['not-a-candidate']
    fixture.write_rows(root/'train.v4.jsonl',data['train'])
result['training_label_invalid']=validate('training-label',label_change)
def duplicate_count(root,data):
    train=data['train'][:1]*512
    dev=[json.loads(x) for x in (root/'dev.v4.jsonl').read_text().splitlines()][:1]*128
    fixture.write_rows(root/'train.v4.jsonl',train)
    fixture.write_rows(root/'dev.v4.jsonl',dev)
result['synthetic_repeats_open_gate']=validate('repeated-fixtures',duplicate_count)
sys.path.insert(0,str(base/'scorers')); import port_v3 as port
identity=port.ScorerIdentity('audit/fake','shared-scalar/1','audit','audit','audit','choose_action',4,'audit','audit')
cert=out/'empty-certificate.json';cert.write_text('{}\n')
ref={'path':str(cert),'sha256':hashlib.sha256(cert.read_bytes()).hexdigest()}
manifest={'schema':port.MANIFEST_SCHEMA,'registrations':[{'identity':identity.as_dict(),'mode':'real','utility_source':None,'evidence':{'calT':ref,'select':ref,'cert':ref,'protocol_version':'audit-invalid'}}]}
request=port.ScorerRequest('audit',identity,['c0','c1','c2','c3'],[5,0,0,0])
for mode in ['real','fixture']:
    artifact=port.ScorerArtifact(port.ARTIFACT_SCHEMA,identity,mode,1,.3,0,None,None)
    result['empty_certificate_'+mode]=port.decide(artifact,request,manifest).__dict__
seen=[]; original=urllib.request.urlopen
def stopped(url,*args,**kwargs):
    seen.append(str(url));raise OSError('audit intercept; no external network call')
try:
    urllib.request.urlopen=stopped
    download=prep.download('0123456789abcdef')
finally: urllib.request.urlopen=original
result['actual_download_url']={'observed_first_request':seen,'returned_report':download,
                               'networkUsed':False}
(out/'probe.json').write_text(json.dumps(result,ensure_ascii=False,indent=2)+'\n')
print(json.dumps({'head':result['head'],'trainingGate':result['actual_formal_training_gate'],
      'v4_mutations':{k:{'exit':result[k]['exit'],'ready':result[k]['payload']['summary']['researchTrainReady']} for k in ['candidate_semantics_changed','training_label_invalid','synthetic_repeats_open_gate']},
      'certs':{m:{'disposition':result['empty_certificate_'+m]['disposition'],'counts_as_real':result['empty_certificate_'+m]['counts_as_real']}for m in ['real','fixture']},
      'actual_download_url':seen},ensure_ascii=False,indent=2))
