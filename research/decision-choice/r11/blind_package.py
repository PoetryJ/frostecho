#!/usr/bin/env python3
"""R11 C line: the two-round anonymous package for the two independent reviewers.

O's contract is packet-A then packet-B, each byte-identical for F and G:

  packet-A  what the resident could see: the rendered observation and the actual
            candidate list.  No episode, split, actor id, capture policy, story
            tag or acceptable set.  A reviewer writes its expectation
            (`expectedAcceptableCandidateIds`), which is sealed before B exists.

  packet-B  anonymous branch facts from the same snapshot under one continuation
            policy and one absolute deadline: first-action admission/pending,
            obligation status, authorisation, resource net change,
            person-minutes and receipts.  B is released only after both A seals
            exist; `release-b` enforces that.

Subcommands:

  build      cases+branches -> packet-A, packet-B, both review templates
  verify     recompute packageId and every hash, rescan both packets
  seal       bind one reviewer's A or B answers to one packageId (immutable;
             B requires the other reviewer's A seal and this reviewer's A seal)
  release-b  refuse unless both A seals exist; write release-B.json
  reconcile  keep every disagreement; never resolve by majority

Only stdlib.  `key.json` (anonymous id -> real case/candidate/episode) is for O,
not for the reviewers.
"""
from __future__ import annotations

import argparse
import datetime
import hashlib
import json
import sys
from pathlib import Path

SCHEMA = "frostecho.r11c.blind-package/1"
PACKET_A = "frostecho.r11c.packet-a/1"
PACKET_B = "frostecho.r11c.packet-b/1"
REVIEW_A = "frostecho.r11c.review-a/1"
REVIEW_B = "frostecho.r11c.review-b/1"
SEAL = "frostecho.r11c.review-seal/1"
RELEASE = "frostecho.r11c.packet-b-release/1"
RECONCILE = "frostecho.r11c.reconciliation/1"

# Keys that must never reach a reviewer.  They name provenance, not evidence.
FORBIDDEN_KEYS = {
    "acceptableIds", "acceptable", "acceptableFulfillmentIds", "labelStatus",
    "labelRule", "labelSource", "split", "sourceEpisodeId", "episode",
    "episodeIndex", "actorId", "captureKind", "scenarioProfile", "policyRun",
    "policyMode", "seed", "sourceHEAD", "snapshotBase", "caseId", "candidateId",
    "commitmentId", "taskId", "sourceFamily", "scenarioSetup", "wants",
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


def scan_packet(value, where: str) -> None:
    """Refuse any forbidden key or provenance word anywhere in a packet."""
    if isinstance(value, dict):
        for key, item in value.items():
            if key in FORBIDDEN_KEYS:
                raise Refusal("packet-leak", f"{where} carries forbidden key {key!r}")
            scan_packet(item, f"{where}.{key}")
    elif isinstance(value, list):
        for index, item in enumerate(value):
            scan_packet(item, f"{where}[{index}]")
    elif isinstance(value, str):
        lowered = value.lower()
        for word in FORBIDDEN_TEXT:
            if word.lower() in lowered:
                raise Refusal("packet-leak", f"{where} contains provenance text {word!r}")


def _package_id(packet_a_sha: str, packet_b_sha: str, template_a_sha: str,
                template_b_sha: str, cases: int) -> str:
    return stable_sha({"protocol": SCHEMA, "packetA": packet_a_sha,
                       "packetB": packet_b_sha, "reviewTemplateA": template_a_sha,
                       "reviewTemplateB": template_b_sha, "cases": cases})


def build(cases_path: Path, branches_path: Path, out: Path, salt: str) -> dict:
    require(salt.strip() != "", "salt", "a nonempty salt (the freeze/tree id) is required")
    require(not out.exists(), "output-exists", f"{out} already exists")
    cases = read_jsonl(cases_path)
    branch_rows = read_jsonl(branches_path)
    branches = {row["caseId"]: row for row in branch_rows}
    require(len(branches) == len(branch_rows), "branches-duplicate",
            "a caseId appears twice in the branch file")
    require(cases, "cases-empty", "no captured cases")
    out.mkdir(parents=True)
    packet_a, packet_b, template_a, template_b = [], [], [], []
    key = {"schema": "frostecho.r11c.package-key/1", "cases": {}, "salt": salt}
    for case in cases:
        case_id = case["caseId"]
        branch_row = branches.get(case_id)
        require(branch_row is not None, "branches-missing", f"{case_id} has no branch rollout")
        anonymous_case = anonymise(salt, "c", case_id)
        request = case.get("request") or {}
        candidates = request.get("candidates") or []
        require(len(candidates) >= 2, "candidates", f"{case_id} has fewer than two candidates")
        rendered = case.get("rendered") or {}
        text = rendered.get("text")
        require(isinstance(text, str) and text.strip(), "observation",
                f"{case_id} has no rendered observation")
        option_ids, options = {}, []
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
        packet_a.append({"schema": PACKET_A, "anonymousCaseId": anonymous_case,
                         "observation": text, "candidates": options})
        rows, mapping = [], {}
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
            rows.append({
                "anonymousBranchId": anonymous_branch,
                "anonymousCandidateId": option_ids[branch["candidateId"]],
                "firstAction": {"admitted": bool(first["admitted"]),
                                "status": first["status"], "minutes": first["minutes"],
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
        require(len(rows) == len(candidates), "branches-incomplete",
                f"{case_id} must have one branch per candidate")
        packet_b.append({
            "schema": PACKET_B, "anonymousCaseId": anonymous_case,
            "t0": {"simTime": t0["simTime"]},
            "commonDeadline": {"simTime": deadline["simTime"],
                               "horizonMinutes": deadline["horizonMinutes"],
                               "basis": deadline["basis"]},
            "continuationPolicy": branch_row.get("continuationPolicy"),
            "exogenous": branch_row.get("exogenous") or [],
            "branches": rows,
        })
        template_a.append({"schema": REVIEW_A, "anonymousCaseId": anonymous_case,
                           "expectedAcceptableCandidateIds": [], "abstain": False,
                           "rationale": ""})
        template_b.append({"schema": REVIEW_B, "anonymousCaseId": anonymous_case,
                           "acceptableBranchIds": [], "abstain": False, "rationale": ""})
        key["cases"][anonymous_case] = {"caseId": case_id, "candidateIds": option_ids,
                                        "branchIds": mapping}
    for row in packet_a:
        scan_packet(row, "packet-A")
    for row in packet_b:
        scan_packet(row, "packet-B")
    require(len({row["anonymousCaseId"] for row in packet_a}) == len(packet_a),
            "anonymous-duplicate", "anonymous case ids collided")
    write_jsonl(out / "packet-A.jsonl", packet_a)
    write_jsonl(out / "packet-B.jsonl", packet_b)
    write_jsonl(out / "review-template-A.jsonl", template_a)
    write_jsonl(out / "review-template-B.jsonl", template_b)
    write_json(out / "key.json", key)
    packet_a_sha, packet_b_sha = file_sha(out / "packet-A.jsonl"), file_sha(out / "packet-B.jsonl")
    template_a_sha = file_sha(out / "review-template-A.jsonl")
    template_b_sha = file_sha(out / "review-template-B.jsonl")
    package_id = _package_id(packet_a_sha, packet_b_sha, template_a_sha, template_b_sha,
                             len(packet_a))
    document = {
        "schema": SCHEMA, "packageId": package_id, "salt": salt,
        "packetA": {"path": "packet-A.jsonl", "sha256": packet_a_sha},
        "packetB": {"path": "packet-B.jsonl", "sha256": packet_b_sha},
        "reviewTemplateA": {"path": "review-template-A.jsonl", "sha256": template_a_sha},
        "reviewTemplateB": {"path": "review-template-B.jsonl", "sha256": template_b_sha},
        "key": {"path": "key.json", "sha256": file_sha(out / "key.json")},
        "counts": {"cases": len(packet_a),
                   "branches": sum(len(row["branches"]) for row in packet_b),
                   "candidates": sum(len(row["candidates"]) for row in packet_a)},
        "reviewers": ["F", "G"],
        "rule": "same packageId for F and G; A seals before B is released; "
                "disagreements are preserved",
    }
    write_json(out / "package.json", document)
    return document


def verify(package: Path) -> dict:
    package = Path(package)
    manifest = package / "package.json"
    require(manifest.exists(), "package-missing", f"no package.json under {package}")
    document = json.loads(manifest.read_text(encoding="utf-8"))
    require(document.get("schema") == SCHEMA, "package-schema", "not a blind-package/1")
    for stage in ("packetA", "packetB", "reviewTemplateA", "reviewTemplateB"):
        entry = document.get(stage) or {}
        path = package / entry.get("path", "")
        require(path.exists(), "package-missing", f"{stage} file is missing")
        require(file_sha(path) == entry.get("sha256"), "package-tampered",
                f"{stage} bytes differ from the manifest")
    effective = _package_id(document["packetA"]["sha256"], document["packetB"]["sha256"],
                            document["reviewTemplateA"]["sha256"],
                            document["reviewTemplateB"]["sha256"],
                            document["counts"]["cases"])
    require(effective == document.get("packageId"), "package-id",
            "packageId does not recompute from its packets")
    packet_a = read_jsonl(package / document["packetA"]["path"])
    packet_b = read_jsonl(package / document["packetB"]["path"])
    require(len(packet_a) == document["counts"]["cases"], "package-count",
            "packet-A row count differs from the manifest")
    require(len(packet_b) == document["counts"]["cases"], "package-count",
            "packet-B row count differs from the manifest")
    for row in packet_a:
        scan_packet(row, "packet-A")
    for row in packet_b:
        scan_packet(row, "packet-B")
    require({row["anonymousCaseId"] for row in packet_a}
            == {row["anonymousCaseId"] for row in packet_b}, "package-cases",
            "the two packets do not cover the same cases")
    return {"ok": True, "packageId": document["packageId"],
            "cases": document["counts"]["cases"],
            "branches": document["counts"]["branches"],
            "packetASha256": document["packetA"]["sha256"],
            "packetBSha256": document["packetB"]["sha256"]}


def _seal_name(reviewer: str, stage: str) -> str:
    return f"{reviewer}-{stage}.seal.json"


def seal(package: Path, reviewer: str, stage: str, review_path: Path, out: Path,
         expect_package_id: str | None, prior_seals: list[Path] | None = None) -> dict:
    prior_seals = list(prior_seals or [])
    require(reviewer in ("F", "G"), "reviewer", "reviewer must be F or G")
    require(stage in ("A", "B"), "stage", "stage must be A or B")
    verified = verify(package)
    require(expect_package_id is None or expect_package_id == verified["packageId"],
            "package-id", "the expected packageId differs from the built package")
    key = json.loads((package / "key.json").read_text(encoding="utf-8"))
    rows = read_jsonl(review_path)
    require(len({row["anonymousCaseId"] for row in rows}) == len(rows), "review-duplicate",
            "a case appears twice in one review")
    label_field = "expectedAcceptableCandidateIds" if stage == "A" else "acceptableBranchIds"
    for row in rows:
        case = key["cases"].get(row.get("anonymousCaseId"))
        require(case is not None, "review-case", "review names an unknown anonymous case")
        allowed = set(case["candidateIds"].values() if stage == "A"
                      else case["branchIds"])
        labels = row.get(label_field) or []
        require(isinstance(labels, list) and len(set(labels)) == len(labels), "review-labels",
                f"{label_field} must be a duplicate-free list")
        require(set(labels) <= allowed, "review-labels",
                "review names an option that is not in the packet")
        require(bool(row.get("abstain")) == (len(labels) == 0), "review-abstain",
                "an empty set is an explicit abstention and vice versa")
    missing = set(key["cases"]) - {row["anonymousCaseId"] for row in rows}
    require(not missing, "review-incomplete",
            f"{len(missing)} cases have no review row; partial reviews are not sealed")

    priors = {}
    if stage == "B":
        require(len(prior_seals) == 2, "release-b",
                "B requires both A seals (one per reviewer) on the command line")
        for path in prior_seals:
            sealed = json.loads(Path(path).read_text(encoding="utf-8"))
            require(sealed.get("schema") == SEAL and sealed.get("stage") == "A",
                    "release-b", f"{path} is not an A seal")
            require(sealed.get("packageId") == verified["packageId"], "release-b",
                    f"{path} belongs to another packageId")
            priors[sealed["reviewer"]] = sealed
        require(set(priors) == {"F", "G"}, "release-b", "the A seals must be F and G")

    out.mkdir(parents=True, exist_ok=True)
    target = out / _seal_name(reviewer, stage)
    require(not target.exists(), "seal-exists", f"{target} already exists; seals are immutable")
    copy = out / f"{reviewer}-{stage}.review.jsonl"
    require(not copy.exists(), "seal-exists", f"{copy} already exists")
    copy.write_bytes(review_path.read_bytes())
    sealed = {"schema": SEAL, "stage": stage, "packageId": verified["packageId"],
              "reviewer": reviewer, "reviewSha256": file_sha(copy), "cases": len(rows),
              "sealedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
              "rows": rows,
              "priorSealSha256": {name: file_sha(Path(path))
                                  for name, path in zip(("F", "G"), prior_seals)}
              if stage == "B" else None,
              "note": "sealed against one packageId; both reviewers receive identical bytes"}
    write_json(target, sealed)
    return {"ok": True, "stage": stage, "seal": str(target),
            "packageId": verified["packageId"], "reviewSha256": sealed["reviewSha256"]}


def release_b(package: Path, seals: list[Path], out: Path) -> dict:
    verified = verify(package)
    require(len(seals) == 2, "release-b", "exactly two A seals are required")
    found = {}
    for path in seals:
        sealed = json.loads(Path(path).read_text(encoding="utf-8"))
        require(sealed.get("schema") == SEAL and sealed.get("stage") == "A", "release-b",
                f"{path} is not an A seal")
        require(sealed.get("packageId") == verified["packageId"], "release-b",
                f"{path} belongs to another packageId")
        found[sealed["reviewer"]] = file_sha(Path(path))
    require(set(found) == {"F", "G"}, "release-b", "the A seals must be F and G")
    out.mkdir(parents=True, exist_ok=True)
    target = out / "release-B.json"
    require(not target.exists(), "release-b", f"{target} already exists")
    document = {"schema": RELEASE, "packageId": verified["packageId"],
                "packetASha256": verified["packetASha256"],
                "packetBSha256": verified["packetBSha256"],
                "aSealSha256": found,
                "releasedAt": datetime.datetime.now(datetime.timezone.utc).isoformat(),
                "rule": "B is released only after both A reviews are sealed"}
    write_json(target, document)
    return document


def reconcile(seal_paths: list[Path], out: Path, derived_path: Path | None = None,
              test_ids_path: Path | None = None) -> dict:
    seals = [json.loads(path.read_text(encoding="utf-8")) for path in seal_paths]
    require(seals, "reconcile-reviewers", "at least one sealed review is required")
    package_ids = {seal["packageId"] for seal in seals}
    require(len(package_ids) == 1, "reconcile-package",
            "the reviews were not produced from the same packageId")
    grouped = {}
    for seal in seals:
        grouped.setdefault(seal["stage"], {})[seal["reviewer"]] = seal
    require("B" in grouped and set(grouped["B"]) == {"F", "G"}, "reconcile-reviewers",
            "the final B seals from F and G are required")
    by_reviewer = {name: {row["anonymousCaseId"]: row for row in seal["rows"]}
                   for name, seal in grouped["B"].items()}
    f_rows, g_rows = by_reviewer["F"], by_reviewer["G"]
    require(set(f_rows) == set(g_rows), "reconcile-cases", "the reviews cover different cases")
    derived = {}
    if derived_path is not None:
        derived = {row["anonymousCaseId"]: set(row["acceptableBranchIds"])
                   for row in read_jsonl(derived_path)}
    cases, disagreements = [], []
    for case_id in sorted(f_rows):
        left = set(f_rows[case_id].get("acceptableBranchIds") or [])
        right = set(g_rows[case_id].get("acceptableBranchIds") or [])
        union = left | right
        entry = {"anonymousCaseId": case_id, "reviewerF": sorted(left),
                 "reviewerG": sorted(right), "agreement": left == right,
                 "jaccard": round(len(left & right) / len(union), 6) if union else 1.0,
                 "abstainF": bool(f_rows[case_id].get("abstain")),
                 "abstainG": bool(g_rows[case_id].get("abstain"))}
        if "A" in grouped and set(grouped["A"]) == {"F", "G"}:
            entry["reviewerA"] = {
                name: sorted(
                    {row["anonymousCaseId"]: row for row in grouped["A"][name]["rows"]}
                    .get(case_id, {}).get("expectedAcceptableCandidateIds") or [])
                for name in ("F", "G")}
            entry["aAgreement"] = entry["reviewerA"]["F"] == entry["reviewerA"]["G"]
        entry["derived"] = sorted(derived[case_id]) if case_id in derived else None
        if case_id in derived:
            entry["fMatchesDerived"] = left == derived[case_id]
            entry["gMatchesDerived"] = right == derived[case_id]
        cases.append(entry)
        if left != right:
            disagreements.append(entry)
    agreed = len(cases) - len(disagreements)
    a_cases = [entry for entry in cases if "aAgreement" in entry]
    report = {
        "schema": RECONCILE, "packageId": seals[0]["packageId"],
        "seals": [{"reviewer": seal["reviewer"], "stage": seal["stage"],
                   "reviewSha256": seal["reviewSha256"]} for seal in seals],
        "cases": len(cases),
        "stageB": {"agreements": agreed, "disagreements": len(disagreements),
                   "agreementRate": round(agreed / len(cases), 6) if cases else None},
        "stageA": {"cases": len(a_cases),
                   "agreements": sum(1 for entry in a_cases if entry["aAgreement"]),
                   "agreementRate": round(sum(1 for entry in a_cases if entry["aAgreement"])
                                          / len(a_cases), 6) if a_cases else None} if a_cases else None,
        "perCase": cases,
        "disagreementRows": disagreements,
        "resolution": "none: disagreements are preserved for O; no majority vote",
        "derivedAvailable": bool(derived),
    }
    if derived:
        report["perReviewerAgreementWithDerived"] = {
            reviewer: {"cases": sum(1 for row in cases if row["derived"] is not None),
                       "matches": sum(1 for row in cases
                                      if row.get(f"{reviewer.lower()}MatchesDerived") is True)}
            for reviewer in ("F", "G")}
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
                                 "evaluatedOnce": True, "rows": test_rows})
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
    seal_parser.add_argument("--stage", required=True, choices=("A", "B"))
    seal_parser.add_argument("--review", type=Path, required=True)
    seal_parser.add_argument("--out", type=Path, required=True)
    seal_parser.add_argument("--expect-package-id", default=None)
    seal_parser.add_argument("--prior-seal", type=Path, action="append", default=[])
    release_parser = sub.add_parser("release-b")
    release_parser.add_argument("--package", type=Path, required=True)
    release_parser.add_argument("--seal", type=Path, action="append", required=True)
    release_parser.add_argument("--out", type=Path, required=True)
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
            result = seal(args.package, args.reviewer, args.stage, args.review,
                          args.out, args.expect_package_id, args.prior_seal)
        elif args.command == "release-b":
            result = release_b(args.package, args.seal, args.out)
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
