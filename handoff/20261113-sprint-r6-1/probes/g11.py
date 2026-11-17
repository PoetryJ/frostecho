import hashlib,json,pathlib,shutil,subprocess,sys,tarfile
repo=pathlib.Path(sys.argv[1]);out=pathlib.Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True)
pkg=repo/'evidence/g11-original-evidence.tar.gz'
expected={}
with tarfile.open(pkg) as tar:
 for m in tar.getmembers():
  if m.isfile():expected[m.name]=tar.extractfile(m).read()
marker='artifacts/g11-live/g11-live-20261105-r1/w1/w1-wait-run.run.json'
prefix='artifacts/g11-live/g11-live-20261105-r1/w1/w1-prefix-run.run.json'
results={}
for case in ('empty','existing-other-preserved','marker-only'):
 mini=out/case;(mini/'scripts').mkdir(parents=True);(mini/'evidence').mkdir()
 shutil.copy2(repo/'scripts/run-tests.mjs',mini/'scripts/run-tests.mjs')
 shutil.copy2(pkg,mini/'evidence'/pkg.name)
 shutil.copy2(repo/'evidence/g11-original-evidence.sha256',mini/'evidence/g11-original-evidence.sha256')
 existing={}
 if case=='existing-other-preserved':
  path=mini/'artifacts/g11-live/g11-live-20261105-r1/plan.json';path.parent.mkdir(parents=True);path.write_bytes(b'owned-existing-plan\n');existing[path.relative_to(mini).as_posix()]=path.read_bytes()
 if case=='marker-only':
  path=mini/marker;path.parent.mkdir(parents=True);path.write_bytes(expected[marker]);existing[marker]=expected[marker]
 p=subprocess.run(['node','scripts/run-tests.mjs','--restore-only'],cwd=mini,capture_output=True,timeout=15)
 (mini/'stdout.txt').write_bytes(p.stdout);(mini/'stderr.txt').write_bytes(p.stderr)
 missing=[name for name in expected if not (mini/name).is_file()]
 preserved=all((mini/name).read_bytes()==data for name,data in existing.items())
 results[case]={'exit':p.returncode,'archiveFiles':len(expected),'missing':missing,'preservedExisting':preserved,'prefixRestored':(mini/prefix).exists(),'allAvailableExactExceptOwned':all((mini/name).is_file() and ((mini/name).read_bytes()==data or name in existing) for name,data in expected.items())}
(out/'summary.json').write_text(json.dumps(results,indent=2)+'\n',encoding='utf-8');print(json.dumps(results,indent=2))
