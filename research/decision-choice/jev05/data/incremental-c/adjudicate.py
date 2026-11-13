#!/usr/bin/env python3
"""Assemble the frozen 64-case semantic/2 consensus; not a third review.

Uses only the named incremental-c evidence and the original semantic contract.
No old test set, authoring source, model calls, or automatic semantic judging.
Existing output files are never overwritten. All validation precedes writing.
"""

from __future__ import annotations

import hashlib
import json
from collections import Counter, defaultdict
from datetime import datetime, timezone
from pathlib import Path


BASE = Path(__file__).resolve().parent
CONTRACT = BASE.parents[2] / "jev03" / "data" / "contract.json"
CONTRACT_ID = "frostecho.jev03.semantic/2"
CLASSES = {"PLAYER_FIRST", "NPC_FIRST", "NO_PRIORITY_REQUEST", "NEEDS_CLARIFICATION"}
PROVENANCE = "model-authored-independent-session"
FROZEN_SHA256 = {
    "batch-016.freeze.json": "0abf4cf3306bce2efa5b26a6d45693bba2b61a81c3b09603db3f902c8ae84aa3",
    "batch-064.freeze.json": "4f1b9be7ef3028e3b08932673911790836437209986a19b8ddcfd7f64f5ac810",
    "reviews/arm-a-016.jsonl": "e19812d7e601165b43de3e6e9e954584b37b2f86057afe01d5a2b28ace0a02d2",
    "reviews/arm-a-remaining48.jsonl": "0a2a86bef13ef25a64391d30c4733abd9785f75a628046c256658d3c2da4fa8d",
    "reviews/arm-b-016.jsonl": "1f538de8049933119cfc88abb604480afbc5e6d5f08a2933572ae75375a36e71",
    "reviews/arm-b-remaining48.jsonl": "c7925a5ad89e127217ed813edeb7b2e8054dd35be695a1c405ae0ebf01058d9a",
}


def canonical(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True,
                      separators=(",", ":"), allow_nan=False).encode("utf-8")


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def require(condition: bool, message: str) -> None:
    if not condition:
        raise ValueError(message)


def indexed(rows: list[dict], description: str) -> dict[str, dict]:
    result = {}
    for row in rows:
        case_id = row.get("caseId")
        require(isinstance(case_id, str) and bool(case_id), f"{description}: missing caseId")
        require(case_id not in result, f"{description}: duplicate caseId {case_id}")
        result[case_id] = row
    return result


def main() -> None:
    originals: dict[str, dict] = {}

    def read_bytes(name: str) -> bytes:
        payload = (BASE / name).read_bytes()
        digest = sha256(payload)
        if name in FROZEN_SHA256:
            require(digest == FROZEN_SHA256[name], f"Frozen file SHA mismatch: {name}")
        originals[name] = {"path": name, "sha256": digest, "bytes": len(payload)}
        return payload

    def read_jsonl(name: str) -> list[dict]:
        lines = read_bytes(name).decode("utf-8").splitlines()
        require(all(line.strip() for line in lines), f"Blank JSONL row: {name}")
        rows = [json.loads(line) for line in lines]
        require(all(isinstance(row, dict) for row in rows), f"Non-object JSONL row: {name}")
        originals[name]["rows"] = len(rows)
        return rows

    contract_bytes = CONTRACT.read_bytes()
    contract = json.loads(contract_bytes)
    contract_hash = sha256(contract_bytes)
    require(contract["schema"] == CONTRACT_ID, "Unexpected semantic contract")
    require(set(contract["classes"]) == CLASSES, "Unexpected four-class label set")
    originals["../../../jev03/data/contract.json"] = {
        "path": "../../../jev03/data/contract.json", "sha256": contract_hash,
        "bytes": len(contract_bytes),
    }

    batches = {}
    for size in (16, 64):
        stem = f"batch-{size:03d}"
        freeze = json.loads(read_bytes(f"{stem}.freeze.json"))
        require(freeze["schema"] == "frostecho.jev03.incremental-freeze/1", "Unknown freeze schema")
        require(freeze["count"] == size and freeze["contract"] == CONTRACT_ID,
                f"Wrong frozen batch count/contract: {stem}")
        require(freeze["contractSha256"] == contract_hash, f"Contract SHA mismatch: {stem}")
        require(freeze["worldTraceUsed"] is False and freeze["playerHumanAuthored"] is False,
                f"Unexpected source provenance: {stem}")
        require(freeze["source"] == "model-authored game scenarios", f"Unexpected source: {stem}")
        rows = {}
        for kind, hash_key in (("blind", "blindSha256"), ("inputs", "inputsSha256"),
                               ("author-labels", "authorLabelsSha256")):
            name = f"{stem}.{kind}.jsonl"
            rows[kind] = read_jsonl(name)
            require(len(rows[kind]) == size, f"Wrong row count: {name}")
            require(originals[name]["sha256"] == freeze[hash_key], f"Frozen member SHA mismatch: {name}")
        blind = indexed(rows["blind"], stem + " blind")
        inputs = indexed(rows["inputs"], stem + " inputs")
        authors = indexed(rows["author-labels"], stem + " authors")
        require(blind.keys() == inputs.keys() == authors.keys(), f"ID coverage mismatch: {stem}")
        for case_id, case in blind.items():
            visible = {"context": case["context"], "playerText": case["playerText"]}
            require(all(isinstance(value, str) and value for value in visible.values()),
                    f"Invalid visible input: {case_id}")
            require(inputs[case_id]["visibleInput"] == visible, f"Visible input mismatch: {case_id}")
            require(inputs[case_id]["groupId"] == case["groupId"], f"Input group mismatch: {case_id}")
            require(sha256(canonical(visible)) == case["contentHash"], f"Canonical input mismatch: {case_id}")
            require(authors[case_id]["contentHash"] == case["contentHash"], f"Author binding mismatch: {case_id}")
            require(authors[case_id]["contract"] == CONTRACT_ID, f"Author contract mismatch: {case_id}")
            require(isinstance(authors[case_id].get("labelId"), str), f"Missing author label: {case_id}")
            require(case["split"] in {"train", "dev"}, f"Disallowed split: {case_id}")
            require(isinstance(case["groupId"], str) and bool(case["groupId"]), f"Missing group: {case_id}")
        batches[size] = {"freeze": freeze, "blind": blind, "inputs": inputs, "authors": authors}

    small, full = batches[16], batches[64]
    require(small["blind"].keys() <= full["blind"].keys(), "First 16 missing from full batch")
    for kind in ("blind", "inputs", "authors"):
        require(all(row == full[kind][case_id] for case_id, row in small[kind].items()),
                f"First 16 changed in batch 064: {kind}")

    group_splits: dict[str, set[str]] = defaultdict(set)
    for case in full["blind"].values():
        group_splits[case["groupId"]].add(case["split"])
    require(all(len(splits) == 1 for splits in group_splits.values()), "A group crosses train/dev splits")

    arms = {}
    for arm in ("a", "b"):
        reviews = {}
        for suffix, size in (("016", 16), ("remaining48", 64)):
            name = f"reviews/arm-{arm}-{suffix}.jsonl"
            source_rows = read_jsonl(name)
            review_map = indexed(source_rows, name)
            expected_ids = set(small["blind"]) if size == 16 else set(full["blind"]) - set(small["blind"])
            require(set(review_map) == expected_ids, f"Review ID coverage mismatch: {name}")
            frozen = batches[size]["freeze"]
            for case_id, review in review_map.items():
                require(case_id not in reviews, f"Review repeated across files: {case_id}")
                require(review["reviewerId"] == f"jev05-blind-{arm}", f"Wrong reviewer identity: {name}")
                require(review["sessionId"] == f"/root/jev05_blind_{arm}", f"Wrong session identity: {name}")
                require(review.get("provenance", review.get("reviewerType")) == PROVENANCE,
                        f"Review not declared independent-session: {case_id}")
                if "provenance" in review and "reviewerType" in review:
                    require(review["provenance"] == review["reviewerType"], f"Conflicting review provenance: {case_id}")
                require(review["blind"] is True, f"Review not blind: {case_id}")
                require(review["contentHash"] == review["canonicalInputSha256"] == full["blind"][case_id]["contentHash"],
                        f"Review input binding mismatch: {case_id}")
                for field in ("blindSha256", "inputsSha256", "contractSha256"):
                    require(review[field] == frozen[field], f"Review frozen {field} mismatch: {case_id}")
                labels = review["acceptableLabels"]
                require(isinstance(labels, list) and all(isinstance(label, str) and label in CLASSES for label in labels)
                        and len(labels) == len(set(labels)), f"Invalid acceptable labels: {case_id}")
                if "acceptableIds" in review:
                    require(review["acceptableIds"] == labels, f"Conflicting label aliases: {case_id}")
                require(review["status"] in {"supported", "ambiguous", "inconsistent"}, f"Unknown review status: {case_id}")
                require(isinstance(review["rawResponse"], str) and bool(review["rawResponse"].strip()),
                        f"Missing original review response: {case_id}")
                reviews[case_id] = {"row": review, "path": name,
                                    "fileSha256": originals[name]["sha256"],
                                    "rowSha256": sha256(canonical(review))}
            read_bytes(f"reviews/arm-{arm}-{suffix}.raw.txt")
            if arm == "a":
                read_bytes(f"reviews/arm-{arm}-{suffix}.raw.jsonl")
        require(set(reviews) == set(full["blind"]), f"Arm {arm} does not cover exactly 64 unique cases")
        arms[arm] = reviews

    sessions = {arm: {item["row"]["sessionId"] for item in reviews.values()} for arm, reviews in arms.items()}
    identities = {arm: {item["row"]["reviewerId"] for item in reviews.values()} for arm, reviews in arms.items()}
    require(sessions["a"].isdisjoint(sessions["b"]) and identities["a"].isdisjoint(identities["b"]),
            "A/B session or reviewer identities overlap")

    accepted = {"train": [], "dev": []}
    pending = []
    author_differences = []
    for case_id, case in full["blind"].items():
        evidence_a, evidence_b = arms["a"][case_id], arms["b"][case_id]
        review_a, review_b = evidence_a["row"], evidence_b["row"]
        labels_a, labels_b = review_a["acceptableLabels"], review_b["acceptableLabels"]
        reasons = []
        if review_a["status"] != "supported" or review_b["status"] != "supported":
            reasons.append("both_reviews_must_be_supported")
        if len(labels_a) != 1 or len(labels_b) != 1:
            reasons.append("both_acceptable_sets_must_be_singletons")
        if labels_a != labels_b:
            reasons.append("review_label_disagreement")
        output = {key: case[key] for key in ("caseId", "contentHash", "split", "context", "playerText", "groupId")}
        output.update({"reviewASha256": evidence_a["rowSha256"], "reviewBSha256": evidence_b["rowSha256"],
                       "reviewAFile": evidence_a["path"], "reviewBFile": evidence_b["path"],
                       "reviewAFileSha256": evidence_a["fileSha256"], "reviewBFileSha256": evidence_b["fileSha256"]})
        if reasons:
            output.update({"status": "pending", "reasons": reasons,
                           "reviewA": {"status": review_a["status"], "acceptableLabels": labels_a},
                           "reviewB": {"status": review_b["status"], "acceptableLabels": labels_b}})
            pending.append(output)
        else:
            output["labelId"] = labels_a[0]
            accepted[case["split"]].append(output)
        author_label = full["authors"][case_id]["labelId"]
        if labels_a != [author_label] or labels_b != [author_label]:
            author_differences.append({"caseId": case_id, "contentHash": case["contentHash"],
                                       "authorLabelId": author_label, "reviewALabels": labels_a,
                                       "reviewBLabels": labels_b, "consensusLabelId": None if reasons else labels_a[0],
                                       "authorInReviewASet": author_label in labels_a,
                                       "authorInReviewBSet": author_label in labels_b,
                                       "acceptedConsensusMismatch": not reasons and author_label != labels_a[0],
                                       "authorLabelUsedForDecision": False})

    outputs = {"train.jsonl": accepted["train"], "dev.jsonl": accepted["dev"],
               "pending.jsonl": pending, "author-differences.jsonl": author_differences}
    encoded = {name: b"".join(canonical(row) + b"\n" for row in rows) for name, rows in outputs.items()}
    count = len(accepted["train"]) + len(accepted["dev"])
    require(count + len(pending) == 64, "Accepted/pending partition does not cover 64 cases")
    manifest = {
        "schema": "frostecho.jev03.incremental-consensus-assembly/1",
        "createdAt": datetime.now(timezone.utc).isoformat(),
        "protocol": "old-semantic/2", "contract": CONTRACT_ID, "contractSha256": contract_hash,
        "assembler": {"sessionId": "/root/jev05_blind_a", "role": "engineering-assembly-not-third-independent-adjudicator",
                      "script": "adjudicate.py", "scriptSha256": sha256(Path(__file__).read_bytes())},
        "policy": "Accept only two supported independent-session reviews with identical singleton acceptableLabels; retain all other cases pending. Author labels are comparison-only.",
        "authorComparisonPolicy": "Report any non-identical singleton comparison, including a multi-label review that still contains the author label; a reported difference does not itself establish an author error.",
        "source": {"kind": "model-authored game scenarios", "modelSynthetic": True,
                   "playerHumanAuthored": False, "humanAnnotated": False, "worldTraceUsed": False},
        "scope": "Original four-class priority-request semantic task only; not general gameplay/JEV certification.",
        "generalJevCertified": False, "oldTestRead": False,
        "provenanceLimit": "Hashes and identity checks bind recorded evidence; the assembler is not an additional independent review.",
        "reviewSessions": {arm: sorted(values) for arm, values in sessions.items()},
        "reviewerIds": {arm: sorted(values) for arm, values in identities.items()},
        "counts": {"input": 64, "accepted": count, "train": len(accepted["train"]), "dev": len(accepted["dev"]),
                   "pending": len(pending), "authorDifferences": len(author_differences), "groups": len(group_splits),
                   "authorConsensusMismatches": sum(row["acceptedConsensusMismatch"] for row in author_differences),
                   "authorOutsideAnyReviewSet": sum(not row["authorInReviewASet"] or not row["authorInReviewBSet"]
                                                     for row in author_differences),
                   "labelsBySplit": {split: dict(sorted(Counter(row["labelId"] for row in rows).items()))
                                     for split, rows in accepted.items()}},
        "groups": {group: next(iter(splits)) for group, splits in sorted(group_splits.items())},
        "originalFiles": dict(sorted(originals.items())),
        "outputs": {name: {"path": "reviewed/" + name, "sha256": sha256(payload), "rows": len(outputs[name])}
                    for name, payload in encoded.items()},
    }
    encoded["manifest.json"] = json.dumps(manifest, ensure_ascii=False, sort_keys=True, indent=2,
                                          allow_nan=False).encode("utf-8") + b"\n"
    output_dir = BASE / "reviewed"
    require(not any((output_dir / name).exists() for name in encoded), "Refusing to overwrite existing reviewed output")
    output_dir.mkdir(exist_ok=True)
    for name, payload in encoded.items():
        with (output_dir / name).open("xb") as handle:
            handle.write(payload)
        require((output_dir / name).read_bytes() == payload, f"Output reread mismatch: {name}")
    print(json.dumps({"result": "assembled", "counts": manifest["counts"],
                      "manifest": str(output_dir / "manifest.json"),
                      "manifestSha256": sha256(encoded["manifest.json"])}, ensure_ascii=False))


if __name__ == "__main__":
    main()
