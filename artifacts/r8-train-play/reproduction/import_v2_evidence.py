from pathlib import Path
import hashlib,json,shutil,tarfile
b=Path(__file__).resolve().parent
dest=b.parent/'source/artifacts/r8-train-play/results/v2/full-run'
assert not dest.exists();dest.mkdir(parents=True)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(b/'compact-v2.tar.gz')=='069f2ae5b4dc0f324d53b05f9584251da4c115afa034f0de789e4a481cbdfa6e'
with tarfile.open(b/'compact-v2.tar.gz') as t:t.extractall(dest,filter='data')
manifest=json.loads((dest/'EVIDENCE-INDEX.json').read_text())
for row in manifest['compactFiles']:
 p=dest/row['path'];assert p.stat().st_size==row['bytes'] and sha(p)==row['sha256'],row['path']
assert sha(b/'v2-full-evidence.tar.gz')==manifest['rawArchiveSha256']=='ea928e8b3707dbd0972a847a6e7c051ee7defd742c77133c95bf5dc94b1a0f81'
actual={};index=None
with tarfile.open(b/'v2-full-evidence.tar.gz','r|gz') as t:
 for m in t:
  assert m.isfile()
  raw=t.extractfile(m).read()
  if m.name=='v2-raw-index.json':index=json.loads(raw)
  else:actual[m.name]={'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw)}
assert index is not None and len(index)==len(actual)==manifest['rawFiles']
for row in index:assert actual[row['path']]=={'sha256':row['sha256'],'bytes':row['bytes']},row['path']
shutil.copy2(b/'v2-cost.json',dest.parent/'cost.json')
result={'ok':True,'compactFilesVerified':len(manifest['compactFiles']),'rawFilesVerified':len(index),'rawArchiveSha256':manifest['rawArchiveSha256'],'rawArchiveLocal':str(b/'v2-full-evidence.tar.gz')}
(dest.parent/'local-import-verification.json').write_text(json.dumps(result,indent=2)+'\n')
print(json.dumps(result))
