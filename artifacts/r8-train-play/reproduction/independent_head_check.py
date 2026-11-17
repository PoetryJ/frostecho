"""Independent NumPy arithmetic; no import of the trainer, model or torch."""
from pathlib import Path
import json, hashlib, struct
import numpy as np

base=Path(__file__).resolve().parent/'source/artifacts/r8-train-play'
trained=base/'trained-96-v1'; cache=base/'features-96-dualgpu-single'
manifest=json.loads((trained/'selected.json').read_text())
def sha(path): return hashlib.sha256(path.read_bytes()).hexdigest()
def weights(path):
 raw=path.read_bytes(); n=struct.unpack('<Q',raw[:8])[0]; header=json.loads(raw[8:8+n])
 keys=[k for k in header if k!='__metadata__']; assert len(keys)==1,keys
 item=header[keys[0]]; assert item['dtype']=='F32',item
 start,end=item['data_offsets']
 return np.frombuffer(raw[8+n+start:8+n+end],dtype='<f4').reshape(item['shape']).astype('float64').reshape(-1)
assert sha(trained/manifest['selectedCheckpoint'])==manifest['selectedCheckpointSha256']
assert sha(cache/'features.npz')==manifest['cacheSha256']
data=np.load(cache/'features.npz',allow_pickle=False)
rows=[json.loads(s) for s in (cache/'records.jsonl').read_text().splitlines()]
preds={p['caseId']:p for p in manifest['selectedMetrics']['test']['predictions']}
w=weights(trained/manifest['selectedCheckpoint'])
metrics={}; max_delta=0.0
for split in ('train','dev','test'):
 losses=[];good=0
 for i,row in enumerate(rows):
  if row['split']!=split:continue
  x=data['cand'][int(data['rowOffsets'][i]):int(data['rowOffsets'][i+1])].astype('float64')
  y=(x-x.mean(axis=1,keepdims=True))/np.sqrt(x.var(axis=1,keepdims=True)+1e-5)
  logits=y@w; z=logits-logits.max(); p=np.exp(z)/np.exp(z).sum()
  acceptable=[row['candidateIds'].index(c) for c in row['acceptableIds']]
  losses.append(float(-np.log(p[acceptable].sum())))
  selected=row['candidateIds'][int(logits.argmax())];good+=selected in row['acceptableIds']
  if split=='test':
   expected=preds[row['caseId']]; assert selected==expected['selectedId']
   max_delta=max(max_delta,float(np.max(np.abs(logits-np.asarray(expected['logits'])))))
 metrics[split]={'cases':len(losses),'agreement':good/len(losses),'setNll':float(np.mean(losses))}
 expected=manifest['selectedMetrics'][split]
 assert metrics[split]['agreement']==expected['referenceAgreement']
 assert abs(metrics[split]['setNll']-expected['setNll'])<1e-5
assert max_delta<1e-5,max_delta
report={'schema':'frostecho.independent-head-check/1','ok':True,'method':'NumPy float64 LayerNorm and dot product; no trainer/torch imports','headSha256':manifest['selectedCheckpointSha256'],'metrics':metrics,'maxTestLogitDelta':max_delta,'weakLabelsOnly':True}
out=trained/'independent-numpy.json';out.write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report))
