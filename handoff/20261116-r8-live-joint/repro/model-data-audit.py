"""Independent CPU mechanics/data audit of delivered R8C; no encoder/GPU calls."""
import contextlib
import hashlib
import importlib.util
import io
import json
import pathlib
import subprocess
import sys
from collections import Counter, defaultdict
import numpy as np

ROOT = pathlib.Path(sys.argv[1]).resolve()
HERE = pathlib.Path(sys.argv[2]).resolve()
HERE.mkdir(parents=True, exist_ok=True)
SCRIPT = ROOT / 'research/decision-choice/jev05/action/train.py'
spec = importlib.util.spec_from_file_location('r8c_action_audit', SCRIPT)
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
rows = [json.loads(line) for line in (ROOT / 'artifacts/sprint-r8/D/cases/dynamic-cases.jsonl').read_text(encoding='utf-8').splitlines()]
owners = defaultdict(set)
visible_owners = defaultdict(set)
for row in rows:
    owners[row['episode']].add(row['split'])
    visible_owners[hashlib.sha256(row['observationText'].encode()).hexdigest()].add(row['split'])

work = HERE / 'mechanism-inputs'
work.mkdir(exist_ok=True)
rng = np.random.default_rng(4317)
features = rng.normal(size=(2,2,5120)).astype(np.float32) * 3 + 7
cases = [{'caseId': 'mechanism-train', 'split': 'train', 'candidates': [{'id':'a'},{'id':'b'}], 'acceptableIds':['a']},
         {'caseId': 'mechanism-dev', 'split': 'dev', 'candidates': [{'id':'a'},{'id':'b'}], 'acceptableIds':['b']}]
case_path = work / 'cases.jsonl'
case_path.write_text(''.join(json.dumps(c)+'\n' for c in cases),encoding='utf-8')
cache = work / 'features.npz'
np.savez(cache,cand=features)
(work / 'cache-binding.json').write_text(json.dumps({'caseIds':[c['caseId'] for c in cases]}),encoding='utf-8')
train_command = [sys.executable,'-B',str(SCRIPT),'--cases',str(case_path),'--features',str(cache),
                 'train','--epochs','1','--out',str(work/'trained-mechanism-head')]
trained = subprocess.run(train_command, capture_output=True, text=True, check=True, timeout=30)
training = json.loads(trained.stdout)
normalized = m.normalize_rows(features[0])
zero_weight = np.zeros(5120)
loss, grad_logits = m.set_nll(m.score_matrix(zero_weight,features[0]),[0])
correct_grad = normalized.T @ grad_logits
implemented_grad = features[0].astype(np.float64).T @ grad_logits
grad_relative_error = float(np.linalg.norm(implemented_grad-correct_grad) / np.linalg.norm(correct_grad))

feature_map = work/'features.json'
feature_map.write_text(json.dumps({'a':features[0,0].tolist(),'b':features[0,1].tolist()}),encoding='utf-8')
certificate=work/'not-a-certificate.json'
certificate.write_text('{}',encoding='utf-8')
request = {'requestId':'cpu-mechanism-audit','candidateSetHash':'mechanism-fixture',
           'candidates':[{'id':'a','parameters':{'featureKey':'a'}},{'id':'b','parameters':{'featureKey':'b'}}]}
serve_command=[sys.executable,'-B',str(SCRIPT),'serve','--feature-map',str(feature_map),
               '--mode','jev-admitted','--data-certificate',str(certificate)]
served=subprocess.run(serve_command,input=json.dumps(request)+'\n',capture_output=True,text=True,check=True,timeout=20)
response=json.loads(served.stdout)
report={'sourceHEAD':subprocess.check_output(['git','-C',str(ROOT),'rev-parse','HEAD'],text=True).strip(),
        'scope':'CPU-mechanism-fixtures and delivered-data inspection; no real model run',
        'data':{'cases':len(rows),'splits':dict(Counter(r['split'] for r in rows)),
                'episodes':len(owners),'episodeSplitLeaks':sum(len(s)>1 for s in owners.values()),
                'distinctVisibleTexts':len(visible_owners),
                'visibleTextsCrossingSplits':sum(len(s)>1 for s in visible_owners.values()),
                'reviewBEqualsAllCandidates':sum(set(r['reviews'][1]['ids'])=={c['id'] for c in r['candidates']} for r in rows),
                'labelEqualsReceiptOnly':sum(r['acceptableIds']==r['reviews'][0]['ids'] for r in rows),
                'quarantined':sum(r['quarantined'] for r in rows),
                'ruleReviewKinds':sorted({r2['kind'] for r in rows for r2 in r['reviews']})},
        'training':{'fixtureTrainRows':1,'fixtureDevRows':1,'rowsOptimized':training['cases'],
                    'gradientRelativeError':grad_relative_error,'command':train_command,'rawResult':training},
        'admission':{'emptyJsonFileAdmitted':response['identity']['countsAsAdmitted'],
                     'command':serve_command,'rawResponse':response},
        'encoderCodeFindings':['live_encode_probe max_memory contains MiB integers passed as byte counts',
                               'live_encode_probe batches observation/candidates independently',
                               'cmd_encode still uses AutoModel/cuda:0/truncation and no joint readout',
                               'serve only uses static featureKey lookup'],
        'gpuUsed':False}
(HERE/'model-data-audit.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({k:v for k,v in report.items() if k not in ('training','admission')},ensure_ascii=True,indent=2))
print(json.dumps({'rowsOptimized':training['cases'],'gradientRelativeError':grad_relative_error,
                  'emptyJsonFileAdmitted':response['identity']['countsAsAdmitted']},ensure_ascii=True))
