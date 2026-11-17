import json, os, pathlib, subprocess, time, signal

base = pathlib.Path(__file__).resolve().parent
source = base / 'source'
output = base / 'runs/online-v1'
output.mkdir(parents=True, exist_ok=False)
python = '/data/home/user_00/frostecho-r7/.venv/bin/python'
node = '/data/home/user_00/.local/node22/bin/node'
trained = source / 'artifacts/r8-train-play/trained-96-v1'
selected = json.loads((trained / 'selected.json').read_text())
service = [python, '-u', 'research/decision-choice/jev05/action/serve_joint.py',
  '--encoder', '/data2/model_weights/Qwen3.8-27B', '--physical-gpus', '0,1',
  '--placement', 'auto', '--head', str(trained/selected['selectedCheckpoint']),
  '--training-manifest', str(trained/'selected.json'), '--max-length', '4096',
  '--temperature', '1', '--tau', '0', '--mode', 'jev-experimental',
  '--output-dir', str(source/'artifacts/r8-train-play/live-service-v1')]
env = os.environ.copy()
env['PATH'] = str(pathlib.Path(node).parent) + ':' + env['PATH']
env['FROSTECHO_SCORER_COMMAND_JSON'] = json.dumps(service)
env['FROSTECHO_SCORER_TIMEOUT_MS'] = '300000'
env['FROSTECHO_SOURCE_HEAD'] = '9fba23610f44445b33936f360b63bef81e3e6c49+online-deploy-v1:43415a892eb55d6a9f0592e58e31aed21e3e3227127e0f9e177bfcfe6b474e1e'
commands = [
 ['reference', node, 'dist/scripts/r8/playthrough.js', '--mode','reference','--seed','live-pair-1','--out','artifacts/r8-train-play/reference-fourday-v1'],
 ['online', node, 'scripts/r8/online-play.mjs', '--mode','jev-experimental','--fresh','--steps','6','--actors','npc_01,npc_02','--seed','live-pair-1','--out','artifacts/r8-train-play/live-restore-v1'],
 ['fourday', node, 'dist/scripts/r8/playthrough.js', '--mode','jev-experimental','--seed','live-pair-1','--out','artifacts/r8-train-play/live-fourday-v1']]
(output/'commands.json').write_text(json.dumps({'commands':commands,'service':service,'source':env['FROSTECHO_SOURCE_HEAD']},indent=2)+'\n')
with (output/'resources.jsonl').open('x') as monitor:
 for stage,*argv in commands:
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
   if p.returncode:
    (output/'status.json').write_text(json.dumps({'status':'failed',**result}));raise SystemExit(p.returncode)
(output/'status.json').write_text(json.dumps({'status':'complete'}))
