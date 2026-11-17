"""Frozen second experiment: corrected labels -> four heads -> live original maps."""
import json, os, pathlib, signal, subprocess, time

base=pathlib.Path(__file__).resolve().parent
source=base/'source-v2'
output=base/'runs/round-v2'
output.mkdir(parents=True,exist_ok=False)
python='/data/home/user_00/frostecho-r7/.venv/bin/python'
node='/data/home/user_00/.local/node22/bin/node'
experiment=source/'artifacts/r8-train-play'
cache=experiment/'features-96-v2-dualgpu-single'
corpus=experiment/'corpus-96-v2/cases.jsonl'
trained=experiment/'trained-96-v2'
initial=source/'artifacts/sprint-r7/legacy-reuse/c43-increment-batch4-1/warm-start-17/best.safetensors'
env=os.environ.copy();env['PATH']=str(pathlib.Path(node).parent)+':'+env['PATH']
env['FROSTECHO_SCORER_TIMEOUT_MS']='300000'
deployment=json.loads((base/'online-deploy-v2.json').read_text())
env['FROSTECHO_SOURCE_HEAD']=deployment['sourceIdentity']
commands=[
 ['encode',python,'-u','research/decision-choice/jev05/action/encode_joint_corpus.py',
  '--encoder','/data2/model_weights/Qwen3.8-27B','--inputs',str(corpus),'--out',str(cache),
  '--physical-gpus','0,1','--placement','auto','--batch-size','1','--limit','96','--max-length','4096'],
 ['train',python,'-u','research/decision-choice/jev05/action/train_action_experiment.py',
  '--corpus',str(corpus),'--features-dir',str(cache),'--head',str(initial),'--out',str(trained),
  '--device','cuda:0','--epochs','40','--batch-size','16','--lr','0.001','--allow-weak-reference'],
 ['reference',node,'dist/scripts/r8/playthrough.js','--mode','reference','--full-map',
  '--seed','live-pair-2','--out','artifacts/r8-train-play/reference-fullmap-v2'],
 ['online',node,'scripts/r8/online-play.mjs','--mode','jev-experimental','--fresh','--full-map',
  '--steps','6','--actors','npc_01,npc_02','--seed','live-pair-2','--out','artifacts/r8-train-play/live-fullmap-restore-v2'],
 ['story',node,'scripts/r8/live-commitment-story.mjs','--mode','jev-experimental','--max-steps','24',
  '--out','artifacts/r8-train-play/live-commitment-v2'],
 ['fourday',node,'dist/scripts/r8/playthrough.js','--mode','jev-experimental','--full-map',
  '--seed','live-pair-2','--out','artifacts/r8-train-play/live-fullmap-fourday-v2']]
(output/'commands.json').write_text(json.dumps({'commands':commands,'source':deployment},indent=2)+'\n')
incomplete=[]
with (output/'resources.jsonl').open('x') as monitor:
 for stage,*argv in commands:
  if stage in ('online','story','fourday'):
   selected=json.loads((trained/'selected.json').read_text())
   service=[python,'-u','research/decision-choice/jev05/action/serve_joint.py','--encoder','/data2/model_weights/Qwen3.8-27B',
    '--physical-gpus','0,1','--placement','auto','--max-length','4096','--temperature','1','--tau','0',
    '--mode','jev-experimental','--head',str(trained/selected['selectedCheckpoint']),
    '--training-manifest',str(trained/'selected.json'),'--output-dir',str(experiment/'live-service-v2')]
   env['FROSTECHO_SCORER_COMMAND_JSON']=json.dumps(service)
   (output/'service.json').write_text(json.dumps(service,indent=2)+'\n')
  started=time.time()
  with (output/f'{stage}.log').open('xb') as log:
   p=subprocess.Popen(argv,cwd=source,env=env,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT,start_new_session=True)
   (output/'status.json').write_text(json.dumps({'stage':stage,'pid':p.pid,'startedAt':started}))
   while p.poll() is None:
    gpu=subprocess.run(['nvidia-smi','--query-gpu=index,memory.used,memory.free,utilization.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=15)
    monitor.write(json.dumps({'time':time.time(),'stage':stage,'pid':p.pid,'gpuCsv':gpu.stdout.strip()})+'\n');monitor.flush()
    if time.time()-started>7200:
     os.killpg(p.pid,signal.SIGTERM)
     try:p.wait(timeout=20)
     except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()
     (output/f'{stage}-timeout.json').write_text(json.dumps({'seconds':time.time()-started}))
     break
    time.sleep(5)
   result={'stage':stage,'returncode':p.returncode,'wallSeconds':time.time()-started}
   (output/f'{stage}-exit.json').write_text(json.dumps(result))
   if stage=='story' and p.returncode==2:
    story=json.loads((experiment/'live-commitment-v2/report.json').read_text())
    if story['outcome']=='incomplete' and story['restoreEqual']:
     incomplete.append({'stage':stage,'outcome':'incomplete','report':str(experiment/'live-commitment-v2/report.json')})
     continue
   if p.returncode:
    (output/'status.json').write_text(json.dumps({'status':'failed',**result}));raise SystemExit(p.returncode)
(output/'status.json').write_text(json.dumps({'status':'complete' if not incomplete else 'complete-with-incomplete-scenarios','incompleteScenarios':incomplete}))
