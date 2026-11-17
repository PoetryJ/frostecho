import hashlib
import json
import pathlib
import subprocess
import time
import os

base=pathlib.Path(__file__).resolve().parent
source=base/'source'
output=base/'runs/batch96-v4'
output.mkdir(parents=True,exist_ok=False)
python='/data/home/user_00/frostecho-r7/.venv/bin/python'
cache=source/'artifacts/r8-train-play/features-96-dualgpu-single'
corpus=source/'artifacts/r8-train-play/corpus-96-v1/cases.jsonl'
trained=source/'artifacts/r8-train-play/trained-96-v1'
head=source/'artifacts/sprint-r7/legacy-reuse/c43-increment-batch4-1/warm-start-17/best.safetensors'
commands=[['encode',python,'-u','research/decision-choice/jev05/action/encode_joint_corpus.py',
  '--encoder','/data2/model_weights/Qwen3.8-27B','--inputs',str(corpus),'--out',str(cache),'--physical-gpus','0,1','--placement','auto',
  '--batch-size','1','--limit','96','--max-length','4096'],
 ['train',python,'-u','research/decision-choice/jev05/action/train_action_experiment.py',
  '--corpus',str(corpus),'--features-dir',str(cache),'--head',str(head),'--out',str(trained),
  '--device','cuda:0','--epochs','40','--batch-size','16','--lr','0.001','--allow-weak-reference']]
(output/'commands.json').write_text(json.dumps(commands,indent=2)+'\n')
with (output/'resources.jsonl').open('x') as monitor:
    for command in commands:
        name,*argv=command
        with (output/f'{name}.log').open('xb') as log:
            process=subprocess.Popen(argv,cwd=source,stdin=subprocess.DEVNULL,stdout=log,stderr=subprocess.STDOUT)
            started=time.time()
            (output/'status.json').write_text(json.dumps({'stage':name,'pid':process.pid,'startedAt':started}))
            while process.poll() is None:
                state=subprocess.run(['nvidia-smi','--query-gpu=index,memory.used,memory.free,utilization.gpu','--format=csv,noheader,nounits'],capture_output=True,text=True,timeout=15)
                monitor.write(json.dumps({'time':time.time(),'stage':name,'pid':process.pid,'gpuCsv':state.stdout.strip()})+'\n'); monitor.flush()
                if time.time()-started>3600:
                    process.terminate()
                    try: process.wait(timeout=20)
                    except subprocess.TimeoutExpired: process.kill(); process.wait()
                    (output/'timeout.json').write_text(json.dumps({'stage':name,'seconds':time.time()-started}))
                    break
                time.sleep(5)
            (output/f'{name}-exit.json').write_text(json.dumps({'returncode':process.returncode,'wallSeconds':time.time()-started}))
            if process.returncode!=0:
                (output/'status.json').write_text(json.dumps({'stage':name,'status':'failed','returncode':process.returncode}))
                raise SystemExit(process.returncode)
(output/'status.json').write_text(json.dumps({'status':'complete','trained':str(trained)}))
