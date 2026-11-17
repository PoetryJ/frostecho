"""R6.1 minimum counterexamples, CPU only. baseline success is NOT acceptance."""
import argparse
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
sys.dont_write_bytecode = True
os.environ.update(PYTHONUTF8='1', PYTHONIOENCODING='utf-8', PYTHONDONTWRITEBYTECODE='1',
                  CUDA_VISIBLE_DEVICES='', HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')


def read(path):
    return json.loads(path.read_text(encoding='utf-8'))


def write(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2)+'\n', encoding='utf-8', newline='\n')


def main():
    parser=argparse.ArgumentParser()
    parser.add_argument('--repo', required=True)
    parser.add_argument('--out', required=True)
    parser.add_argument('--expect', choices=('baseline','fixed'), required=True)
    args=parser.parse_args()
    repo,out=Path(args.repo).resolve(),Path(args.out).resolve()
    package=Path(__file__).resolve().parent
    if out.exists():
        raise SystemExit('fresh output directory required')
    out.mkdir(parents=True)
    result={'schema':'frostecho.r61.minimum/1','phase':args.expect,'checks':{},'errors':{},
            'note':'baseline exit0 means defects reproduced, not product pass; fixed mode only covers minimum probes'}
    def run(argv,label,timeout=90):
        argv=[str(x) for x in argv]
        try:
            p=subprocess.run(argv,cwd=repo,capture_output=True,text=True,encoding='utf-8',errors='replace',timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            write(out/(label+'.process.json'),{'argv':argv,'exit':None,'timeout':True})
            raise RuntimeError(label+' timed out; inspect owned children before continuing') from exc
        (out/(label+'.stdout')).write_text(p.stdout,encoding='utf-8')
        (out/(label+'.stderr')).write_text(p.stderr,encoding='utf-8')
        write(out/(label+'.process.json'),{'argv':argv,'exit':p.returncode,'timeout':False})
        if p.returncode:
            raise RuntimeError(label+' process failed; a crash is not a valid rejection')
        return p
    def denied(item):
        rejection=item.get('explicitRejection')
        if rejection:
            return rejection.get('type')=='IdentityError' and bool(rejection.get('reason'))
        d=item.get('decision') or {}
        return d.get('counts_as_real') is False and d.get('selected_index') is None and d.get('disposition') in ('shadow_only','abstain')
    try:
        result['head']=run(['git','rev-parse','HEAD'],'head').stdout.strip()
        if args.expect=='baseline':
            run(['git','diff','--exit-code','12cc208124c1b6d73c8fd5af66352091f8db9027','--','src','scripts','tests','research/decision-choice/jev04'],'baseline-diff')
        node=shutil.which('node')
        if not node or not (repo/'dist/scripts/play-sprint.js').is_file():
            raise RuntimeError('Node or built CLI missing')
        life=out/'lifecycle';life.mkdir()
        run([node,repo/'checkpoints/20261112-r5/evidence/product-audit/supply-probe.cjs',repo,life/'supply'],'supply')
        run([node,package/'probes/lifecycle.cjs',repo,life],'lifecycle')
        lr=read(life/'extra-summary.json')
        rr=lr['twoSave']
        result['checks']['R']={'defectObserved':rr['outside']['executed'] is False and rr['finalVersion']==1,
                              'fixed':rr['outside']['executed'] is True and bool(rr['outside']['eventIds']) and rr['finalVersion']==2}
        result['checks']['P_cancel_control']={'pass':lr['cancel']['outside']['executed'] is False and not lr['cancel']['outside']['eventIds'] and lr['cancel']['finalVersion']==1}
        run([sys.executable,'-B',package/'probes/jev.py',repo,out/'jev'],'jev')
        j=read(out/'jev/result.json');d=j['validatorProjectionGap'];m=j['cpuClassRealAdmission']
        unchanged=d['originalReviewAndCanonicalHashesUnchanged'] and d['visibleTextDiffersFromCanonical']
        result['checks']['D']={'defectObserved':unchanged and d['exit']==0 and d['result']['ok'] is True,
                              'fixed':unchanged and d['exit']!=0 and d['result']['ok'] is False}
        cpu=m['cpu-mechanism'].get('decision') or {}
        result['checks']['M']={'defectObserved':denied(m['fixture']) and cpu.get('counts_as_real') is True,
                              'fixed':denied(m['fixture']) and denied(m['cpu-mechanism'])}
        positive=j['positiveFixture']
        result['checks']['fixture_control']={'pass':positive['high']['disposition']=='accept' and positive['low']['disposition']=='abstain' and all(x['counts_as_real'] is False and x['utility'] is None for x in positive.values())}
        run([sys.executable,'-B',package/'probes/g11.py',repo,out/'g11'],'g11')
        g=read(out/'g11/summary.json')
        controls=all(g[x]['exit']==0 and not g[x]['missing'] and g[x]['preservedExisting'] and g[x]['allAvailableExactExceptOwned'] for x in ('empty','existing-other-preserved'))
        marker=g['marker-only']
        result['checks']['G11']={'defectObserved':controls and marker['exit']==0 and bool(marker['missing']),
                                'fixed':controls and marker['exit']==0 and not marker['missing'] and marker['preservedExisting'] and marker['allAvailableExactExceptOwned']}
        key='defectObserved' if args.expect=='baseline' else 'fixed'
        result['verified']=all(result['checks'][x][key] for x in ('R','D','M','G11')) and all(result['checks'][x]['pass'] for x in ('P_cancel_control','fixture_control'))
    except Exception as exc:
        result['errors']['execution']=type(exc).__name__+': '+str(exc)
        result['verified']=False
    result['exit']=2 if result['errors'] else (0 if result['verified'] else 1)
    write(out/'summary.json',result)
    print(json.dumps(result,ensure_ascii=False,indent=2))
    return result['exit']


if __name__=='__main__':
    raise SystemExit(main())
