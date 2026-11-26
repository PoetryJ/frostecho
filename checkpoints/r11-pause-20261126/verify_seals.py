import hashlib,json,pathlib
root=pathlib.Path("r11-handoff")
def read(p):
    return [json.loads(line) for line in p.read_text(encoding="utf-8").splitlines()]
result={}
for stage in ("A","B"):
    packet=f"packet-{stage}.jsonl"
    assert (root/"in/F"/packet).read_bytes()==(root/"in/G"/packet).read_bytes()
    inputs=read(root/"in/F"/packet)
    field,idkey,choices,sel=("candidates","anonymousCandidateId","expectedAcceptableCandidateIds","candidate") if stage=="A" else ("branches","anonymousBranchId","acceptableBranchIds","branch")
    ids={r["anonymousCaseId"]:{x[idkey] for x in r[field]} for r in inputs}
    reviewers={};files={}
    for role in "FG":
        folder=root/"return"/role
        for line in (folder/f"review-{stage}.sha256").read_text().splitlines():
            digest,filename=line.split(maxsplit=1)
            assert hashlib.sha256((folder/filename.strip().lstrip("*")).read_bytes()).hexdigest()==digest, filename
        rows=read(folder/f"review-{stage}.jsonl")
        values={r["anonymousCaseId"]:set(r[choices]) for r in rows}
        assert len(values)==len(rows)==len(ids)==48 and values.keys()==ids.keys()
        assert all(v<=ids[k] for k,v in values.items())
        reviewers[role]=values
        files[role]=hashlib.sha256((folder/f"review-{stage}.jsonl").read_bytes()).hexdigest()
    diffs=[k for k in ids if reviewers["F"][k]!=reviewers["G"][k]]
    result[stage]={"cases":len(ids),"options":sum(map(len,ids.values())),"identicalAcceptableSets":len(ids)-len(diffs),"differentCaseIds":diffs,"reviewSha256":files}
print(json.dumps(result,indent=2))
