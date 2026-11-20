#!/usr/bin/env python3
"""R11 C line: two-stage anonymous package for the two independent reviewers.

The package has one identity and one hash for F and G, so their reviews are
comparable without either reviewer seeing the other's input or the labels.

  stage 1  what the resident could see: the rendered observation and the actual
           candidate list.  No episode, split, actor id, capture policy, story
           tag or acceptable set.

  stage 2  anonymous branch facts: what happened from the same snapshot ``t0``
           under one continuation policy and one absolute deadline ``t*``,
           including first-action admission/pending, obligation status,
           authorisation, resource net change, person-minutes and receipts.

Subcommands:

  build     cases+branches -> package (refuses if a stage leaks a label)
  verify    recompute packageId and hashes, scan both stages again
  seal      bind one reviewer's answers to one packageId (never overwrites)
  reconcile keep every disagreement; never resolve by majority

Only stdlib.  ``key.json`` (anonymous id -> real case/candidate/episode) is
written next to the package and is for O, not for the reviewers.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import sys
from pathlib import Path

SCHEMA = "frostecho.r11c.blind-package/1"
STAGE1 = "frostecho.r11c.blind-stage1/1"
STAGE2 = "frostecho.r11c.blind-stage2/1"
REVIEW = "frostecho.r11c.blind-review/1"
SEAL = "frostecho.r11c.review-seal/1"
RECONCILE = "frostecho.r11c.reconciliation/1"

# Keys that must never reach a reviewer.  They name the provenance, not the
# evidence the resident could perceive.
FORBIDDEN_KEYS = {
    "acceptableIds", "acceptable", "labelStatus", "labelRule", "labelSource",
    "split", "sourceEpisodeId", "episode", "episodeIndex", "actorId",
    "captureKind", "scenarioProfile", "policyRun", "policyMode", "seed",
    "sourceHEAD", "snapshotBase", "caseId", "candidateId", "commitmentId",
    "taskId", "sourceFamily", "scenarioSetup", "wants",
}
FORBIDDEN_TEXT = ("acceptable", "split=", "sourceEpisode", "scenarioProfile",
                  "reference-imitation", "same-snapshot-branch-rollout")


class Refusal(ValueError):
    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail


def sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def canonical(value) -> str:
    clean = json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    return json.dumps(clean, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False)


def stable_sha(value) -> str:
    return sha_bytes(canonical(value).encode("utf-8"))


def file_sha(path: Path) -> str:
    return sha_bytes(Path(path).read_bytes())


def read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines()
            if line.strip()]


def write_json(path: Path, value) -> None:
    path.write_text(canonical(value) + "\n", encoding="utf-8", newline="\n")


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("".join(canonical(row) + "\n" for row in rows),
                    encoding="utf-8", newline="\n")


def anonymise(salt: str, kind: str, value: str) -> str:
    return f"{kind}-{sha_bytes(f'{salt}|{kind}|{value}'.encode())[:16]}"


def require(condition, code: str, detail: str):
    if not condition:
        raise Refusal(code, detail)


def scan_stage(value, where: str) -> None:
    """Refuse any forbidden key or provenance word anywhere in a stage."""
    if isinstance(value, dict):
        for key, item in value.items():
            if key in FORBIDDEN_KEYS:
                raise Refusal("stage-leak", f"{where} carries forbidden key {key!r}")
            scan_stage(item, f"{where}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            scan_stage(item, f"{where}[{index}]")
    elif isinstance(value, str):
        lowered = value.lower()
        for word in FORBIDDEN_TEXT:
            if word.lower() in lowered:
                raise Refusal("stage-leak", f"{where} contains provenance text {word!r}")


def build(cases_path: Path, branches_path: Path, out: Path, salt: str) -> dict:
    require(salt.strip() != "", "salt", "a nonempty salt (the freeze/tree id) is required")
    require(not out.exists(), "output-exists", f"{out} already exists")
    cases = read_jsonl(cases_path)
    branches = {row["caseId"]: row for row in read_jsonl(branches_path)}
    require(len(branches) == len(read_jsonl(branches_path)), "branches-duplicate",
            "a caseId appears twice in the branch file")
    require(cases, "cases-empty", "no captured cases")
    out.mkdir(parents=True)
    stage1, stage2, template, key = [], [], [], {"schema": "frostecho.r11c.package-key/1",
                                                 "cases": {}, "salt": salt}
    for case in cases:
        case_id = case["caseId"]
        branch_row = branches.get(case_id)
        require(branch_row is not None, "branches-missing", f"{case_id} has no branch rollout")
        package_anonymous = anonymise(salt, "c", case_id)
        request = case.get("request") or {}
        candidates = request.get("candidates") or []
        require(len(candidates) >= 2, "candidates", f"{case_id} has fewer than two candidates")
        rendered = case.get("rendered") or {}
        text = rendered.get("text")
        require(isinstance(text, str) and text.strip(), "observation",
                f"{case_id} has no rendered observation")
        option_ids = {}
        options = []
        for index, candidate in enumerate(candidates):
            anonymous = f"o{index + 1}"
            option_ids[candidate["id"]] = anonymous
            options.append({"anonymousCandidateId": anonymous,
                            "description": candidate.get("description"),
                            "kind": candidate.get("kind")})
        deadline = branch_row.get("commonDeadline") or {
            "simTime": branch_row.get("tStar"),
            "horizonMinutes": branch_row.get("horizonMinutes"),
            "basis": branch_row.get("deadlineBasis")}
        for field in ("simTime", "horizonMinutes", "basis"):
            require(deadline.get(field) is not None, "deadline",
                    f"{case_id} branch row lacks {field}")
        t0 = branch_row.get("t0")
        t0 = t0 if isinstance(t0, dict) else {"simTime": t0}
        require("simTime" in t0, "t0", f"{case_id} branch row lacks t0.simTime")
        stage1.append({
            "schema": STAGE1, "anonymousCaseId": package_anonymous,
            "observation": text,
            "candidates": options,
        })
        branch_rows = []
        mapping = {}
        for index, branch in enumerate(branch_row.get("branches") or []):
            require(branch.get("candidateId") in option_ids, "branch-candidate",
                    f"{case_id} branch points at an unknown candidate")
            anonymous_branch = f"b{index + 1}"
            mapping[anonymous_branch] = branch["candidateId"]
            first = branch.get("firstAction") or {}
            obligation = branch.get("obligation") or {}
            authorization = branch.get("authorization") or {}
            resources = branch.get("resources") or {}
            require({"admitted", "status", "minutes"} <= set(first), "branch-first",
                    f"{case_id} branch {index} lacks first-action facts")
            require(first["status"] in ("applied", "pending", "refused", "rejected",
                                        "unresolved"), "branch-first",
                    f"{case_id} branch {index} has unknown first status {first['status']!r}")
            require({"before", "after", "delta"} <= set(resources), "branch-resources",
                    f"{case_id} branch {index} lacks resource facts")
            require("personMinutes" in branch and "receipts" in branch, "branch-accounting",
                    f"{case_id} branch {index} lacks person-minutes/receipts")
            branch_rows.append({
                "anonymousBranchId": anonymous_branch,
                "anonymousCandidateId": option_ids[branch["candidateId"]],
                "firstAction": {"admitted": bool(first["admitted"]),
                                "status": first["status"],
                                "minutes": first["minutes"],
                                "startedAt": first.get("startedAt"),
                                "dueAt": first.get("dueAt"),
                                "refusal": first.get("refusal")},
                "obligation": {"present": bool(obligation.get("present")),
                               "kind": obligation.get("kind"),
                               "statusAtDeadline": obligation.get("statusAtDeadline"),
                               "completedAt": obligation.get("completedAt"),
                               "receiptTypes": obligation.get("receiptTypes") or []},
                "authorization": {"withdrawn": bool(authorization.get("withdrawn")),
                                  "unauthorizedSideEffects":
                                      int(authorization.get("unauthorizedSideEffects") or 0)},
                "resources": {"before": resources["before"], "after": resources["after"],
                              "delta": resources["delta"]},
                "personMinutes": branch["personMinutes"],
                "pending": bool(branch.get("pending")),
                "deadlinePassed": bool(branch.get("deadlinePassed")),
                "receipts": branch["receipts"],
            })
        require(len(branch_rows) == len(candidates), "branches-incomplete",
                f"{case_id} must have one branch per candidate")
        stage2.append({
            "schema": STAGE2, "anonymousCaseId": package_anonymous,
            "t0": {"simTime": t0["simTime"]},
            "commonDeadline": {"simTime": deadline["simTime"],
                               "horizonMinutes": deadline["horizonMinutes"],
                               "basis": deadline["basis"]},
            "continuationPolicy": branch_row.get("continuationPolicy"),
            "exogenous": branch_row.get("exogenous") or [],
            "branches": branch_rows,
        })
        template.append({"schema": REVIEW, "anonymousCaseId": package_anonymous,
                         "acceptableBranchIds": [], "abstain": False, "rationale": ""})
        key["cases"][package_anonymous] = {"caseId": case_id,
                                           "candidateIds": option_ids,
                                           "branchIds": mapping}
    for row in stage1:
        scan_stage(row, "stage1")
    for row in stage2:
        scan_stage(row, "stage2")
    require(len({row["anonymousCaseId"] for row in stage1}) == len(stage1), "anonymous-duplicate",
            "anonymous case ids collided")
    write_jsonl(out / "stage1.jsonl", stage1)
    write_jsonl(out / "stage2.jsonl", stage2)
    write_jsonl(out / "review-template.jsonl", template)
    write_json(out / "key.json", key)
    stage1_sha, stage2_sha = file_sha(out / "stage1.jsonl"), file_sha(out / "stage2.jsonl")
    template_sha = file_sha(out / "review-template.jsonl")
    package_id = stable_sha({"protocol": SCHEMA, "stage1": stage1_sha,
                             "stage2": stage2_sha, "reviewTemplate": template_sha,
                             "cases": len(stage1)})
    document = {
        "schema": SCHEMA, "packageId": package_id, "salt": salt,
        "stage1": {"path": "stage1.jsonl", "sha256": stage1_sha},
        "stage2": {"path": "stage2.jsonl", "sha256": stage2_sha},
        "reviewTemplate": {"path": "review-template.jsonl", "sha256": template_sha},
        "key": {"path": "key.json", "sha256": file_sha(out / "key.json")},
        "counts": {"cases": len(stage1),
                   "branches": sum(len(row["branches"]) for row in stage2),
                   "candidates": sum(len(row["candidates"]) for row in stage1)},
        "reviewers": ["F", "G"],
        "rule": "same packageId for both reviewers; two seals; disagreements preserved",
    }
    write_json(out / "package.json", document)
    return document


def verify(package: Path) -> dict:
    package = Path(package)
    manifest = package / "package.json"
    require(manifest.exists(), "package-missing", f"no package.json under {package}")
    document = json.loads(manifest.read_text(encoding="utf-8"))
    require(document.get("schema") == SCHEMA, "package-schema", "not a blind-package/1")
    for stage in ("stage1", "stage2", "reviewTemplate"):
        entry = document.get(stage) or {}
        path = package / entry.get("path", "")
        require(path.exists(), "package-missing", f"{stage} file is missing")
        require(file_sha(path) == entry.get("sha256"), "package-tampered",
                f"{stage} bytes differ from the manifest")
    effective = stable_sha({"protocol": SCHEMA,
                            "stage1": document["stage1"]["sha256"],
                            "stage2": document["stage2"]["sha256"],
                            "reviewTemplate": document["reviewTemplate"]["sha256"],
                            "cases": document["counts"]["cases"]})
    require(effective == document.get("packageId"), "package-id",
            "packageId does not recompute from its stages")
    stage1 = read_jsonl(package / document["stage1"]["path"])
    stage2 = read_jsonl(package / document["stage2"]["path"])
    require(len(stage1) == document["counts"]["cases"], "package-count",
            "stage1 row count differs from the manifest")
    require(len(stage2) == document["counts"]["cases"], "package-count",
            "stage2 row count differs from the manifest")
    for row in stage1:
        scan_stage(row, "stage1")
    for row in stage2:
        scan_stage(row, "stage2")
    require({row["anonymousCaseId"] for row in stage1}
            == {row["anonymousCaseId"] for row in stage2}, "package-cases",
            "the two stages do not cover the same cases")
    return {"ok": True, "packageId": document["packageId"],
            "cases": document["counts"]["cases"],
            "branches": document["counts"]["branches"]}


def seal(package: Path, reviewer: str, review_path: Path, out: Path,
         expect_package_id: str | None) -> dict:
    require(reviewer in ("F", "G"), "reviewer", "reviewer must be F or G")
    verified = verify(package)
    require(expect_package_id is None or expect_package_id == verified["packageId"],
            "package-id", "the expected packageId differs from the built package")
    rows = read_jsonl(review_path)
    key = json.loads((package / "key.json").read_text(encoding="utf-8"))
    require(len({row["anonymousCaseId"] for row in rows}) == len(rows), "review-duplicate",
            "a case appears twice in one review")
    for row in rows:
        case = key["cases"].get(row.get("anonymousCaseId"))
        require(case is not None, "review-case", "review names an unknown anonymous case")
        allowed = set(case["branchIds"])
        labels = row.get("acceptableBranchIds") or []
        require(isinstance(labels, list) and len(set(labels)) == len(labels), "review-labels",
                "acceptableBranchIds must be a duplicate-free list")
        require(set(labels) <= allowed, "review-labels",
                "review accepts a branch that is not in the package")
        require(bool(row.get("abstain")) == (len(labels) == 0), "review-abstain",
                "an empty acceptable set is an explicit abstention and vice versa")
    missing = set(key["cases"]) - {row["anonymousCaseId"] for row in rows}
    require(not missing, "review-incomplete",
            f"{len(missing)} cases have no review row; partial reviews are not sealed")
    out.mkdir(parents=True, exist_ok=True)
    target = out / f"{reviewer}.seal.json"
    require(not target.exists(), "seal-exists", f"{target} already exists; seals are immutable")
    copy = out / f"{reviewer}.review.jsonl"
    require(not copy.exists(), "seal-exists", f"{copy} already exists")
    copy.write_bytes(review_path.read_bytes())
    sealed = {"schema": SEAL, "packageId": verified["packageId"], "reviewer": reviewer,
              "reviewSha256": file_sha(copy), "cases": len(rows),
              "sealedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "rows": rows,
              "note": "sealed against one packageId; the other reviewer's input is identical bytes"}
    write_json(target, sealed)
    return {"ok": True, "seal": str(target), "packageId": verified["packageId"],
            "reviewSha256": sealed["reviewSha256"]}


def reconcile(seal_paths: list[Path], out: Path, derived_path: Path | None = None,
              test_ids_path: Path | None = None) -> dict:
    seals = [json.loads(path.read_text(encoding="utf-8")) for path in seal_paths]
    require(len(seals) == 2, "reconcile-reviewers", "exactly two sealed reviews are required")
    require({seal["reviewer"] for seal in seals} == {"F", "G"}, "reconcile-reviewers",
            "the two seals must be F and G")
    require(seals[0]["packageId"] == seals[1]["packageId"], "reconcile-package",
            "the two reviews were not produced from the same packageId")
    by_reviewer = {seal["reviewer"]: {row["anonymousCaseId"]: row for row in seal["rows"]}
                   for seal in seals}
    f_rows, g_rows = by_reviewer["F"], by_reviewer["G"]
    require(set(f_rows) == set(g_rows), "reconcile-cases", "the reviews cover different cases")
    derived = {}
    if derived_path is not None:
        derived = {row["anonymousCaseId"]: set(row["acceptableBranchIds"])
                   for row in read_jsonl(derived_path)}
    cases = []
    disagreements = []
    for case_id in sorted(f_rows):
        left = set(f_rows[case_id].get("acceptableBranchIds") or [])
        right = set(g_rows[case_id].get("acceptableBranchIds") or [])
        union = left | right
        entry = {"anonymousCaseId": case_id, "reviewerF": sorted(left),
                 "reviewerG": sorted(right),
                 "agreement": left == right,
                 "jaccard": round(len(left & right) / len(union), 6) if union else 1.0,
                 "abstainF": bool(f_rows[case_id].get("abstain")),
                 "abstainG": bool(g_rows[case_id].get("abstain"))}
        if case_id in derived:
            entry["derived"] = sorted(derived[case_id])
            entry["fMatchesDerived"] = left == derived[case_id]
            entry["gMatchesDerived"] = right == derived[case_id]
        else:
            entry["derived"] = None
        cases.append(entry)
        if left != right:
            disagreements.append(entry)
    agreed = len(cases) - len(disagreements)
    report = {
        "schema": RECONCILE, "packageId": seals[0]["packageId"],
        "seals": [{"reviewer": seal["reviewer"], "reviewSha256": seal["reviewSha256"]}
                  for seal in seals],
        "cases": len(cases),
        "agreements": agreed,
        "disagreements": len(disagreements),
        "agreementRate": round(agreed / len(cases), 6) if cases else None,
        "perCase": cases,
        "disagreementRows": disagreements,
        "resolution": "none: disagreements are preserved for O; no majority vote",
        "derivedAvailable": bool(derived),
    }
    if derived:
        report["perReviewerAgreementWithDerived"] = {
            reviewer: {
                "cases": sum(1 for row in cases if row["derived"] is not None
                             and row.get(f"{reviewer.lower()}MatchesDerived") is not None),
                "matches": sum(1 for row in cases
                               if row.get(f"{reviewer.lower()}MatchesDerived") is True),
            } for reviewer in ("F", "G")}
    out.mkdir(parents=True, exist_ok=True)
    target = out / "reconciliation.json"
    require(not target.exists(), "reconcile-exists",
            "reconciliation already written; O records one reconciliation")
    write_json(target, report)
    if test_ids_path is not None:
        test_ids = set(json.loads(test_ids_path.read_text(encoding="utf-8"))["anonymousCaseIds"])
        test_rows = [row for row in cases if row["anonymousCaseId"] in test_ids]
        test_target = out / "test-once.json"
        require(not test_target.exists(), "test-already-evaluated",
                "the test split was already evaluated once")
        write_json(test_target, {"schema": "frostecho.r11c.review-test-once/1",
                                 "packageId": report["packageId"],
                                 "cases": len(test_rows),
                                 "agreementRate": round(
                                     sum(1 for row in test_rows if row["agreement"])
                                     / len(test_rows), 6) if test_rows else None,
                                 "evaluatedOnce": True,
                                 "rows": test_rows})
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build_parser = sub.add_parser("build")
    build_parser.add_argument("--cases", type=Path, required=True)
    build_parser.add_argument("--branches", type=Path, required=True)
    build_parser.add_argument("--out", type=Path, required=True)
    build_parser.add_argument("--salt", required=True)
    verify_parser = sub.add_parser("verify")
    verify_parser.add_argument("--package", type=Path, required=True)
    seal_parser = sub.add_parser("seal")
    seal_parser.add_argument("--package", type=Path, required=True)
    seal_parser.add_argument("--reviewer", required=True)
    seal_parser.add_argument("--review", type=Path, required=True)
    seal_parser.add_argument("--out", type=Path, required=True)
    seal_parser.add_argument("--expect-package-id", default=None)
    reconcile_parser = sub.add_parser("reconcile")
    reconcile_parser.add_argument("--seal", type=Path, action="append", required=True)
    reconcile_parser.add_argument("--out", type=Path, required=True)
    reconcile_parser.add_argument("--derived", type=Path, default=None)
    reconcile_parser.add_argument("--test-ids", type=Path, default=None)
    args = parser.parse_args(argv)
    try:
        if args.command == "build":
            result = build(args.cases, args.branches, args.out, args.salt)
        elif args.command == "verify":
            result = verify(args.package)
        elif args.command == "seal":
            result = seal(args.package, args.reviewer, args.review, args.out,
                          args.expect_package_id)
        else:
            result = reconcile(args.seal, args.out, args.derived, args.test_ids)
    except Refusal as error:
        print(json.dumps({"ok": False, "refused": True, "code": error.code,
                          "detail": error.detail}, ensure_ascii=False), flush=True)
        return 2
    print(json.dumps({"ok": True, **result}, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
