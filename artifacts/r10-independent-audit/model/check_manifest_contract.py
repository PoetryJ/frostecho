"""Exercise only the service's metadata loader; never construct an encoder."""
from pathlib import Path
import argparse, hashlib, importlib.util, json, sys
ap=argparse.ArgumentParser();ap.add_argument('--repo',required=True,type=Path);ap.add_argument('--out',required=True,type=Path);args=ap.parse_args()
root=args.repo.resolve();path=root/'research/decision-choice/jev05/action/serve_joint.py'
spec=importlib.util.spec_from_file_location('r10_audit_serve_manifest',path);module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
rows=[]
for recipe in ['base','discharge']:
 folder=root/f'artifacts/r10/c/train-{recipe}-gpu1';manifest=folder/'training-manifest.json';document=json.loads(manifest.read_text(encoding='utf-8'))
 head=folder/document['selectedCheckpoint'];digest=hashlib.sha256(head.read_bytes()).hexdigest();error=None
 try:module.load_training_manifest(manifest,digest)
 except ValueError as exc:error=str(exc)
 rows.append({'recipe':recipe,'actualSchema':document['schema'],'actualLabelSource':document['labelSource'],
  'schemaMatchesRequired':document['schema']=='frostecho.action-weak-experiment/1','labelSourceMatchesService':document['labelSource']=='reference-imitation',
  'reportedMatchesSchema':document['serveCompatibility']['matchesSchema'],'loaderRejected':error is not None,'reason':error})
assert 'torch' not in sys.modules,'manifest-only check unexpectedly imported torch'
report={'actualModelForwards':0,'torchImported':False,'cases':rows,'harnessBinding':'run-matrix.mjs deliberately omits manifest, but validates headSha256/featureIdentityHash/rendererId against its loaded manifest on every reply. This is a documented adapter, unlike the R9 unbound run. A shared loader supporting honest branch-rollout label provenance should replace the duplicated compatibility path.'}
args.out.write_text(json.dumps(report,indent=2)+'\n',encoding='utf-8');print(json.dumps(report))
