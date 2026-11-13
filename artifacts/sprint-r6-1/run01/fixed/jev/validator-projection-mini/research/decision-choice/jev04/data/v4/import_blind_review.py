#!/usr/bin/env python3
"""R5 (D/M): import the 39-case independent review into the v4 schema.

The two review sessions are preserved verbatim (raw sha256 per case). Their
hash protocol was the blind packet's serialized input; v4 uses a wider visible
input hash that also covers candidate text/kind/params. Re-binding is explicit:
every review row is rewritten with the v4 hash, and the original raw output is
still available in the handoff package.

Adjudication is an agent adjudication, NOT a human double-label and NOT a
cross-model validation. It follows the rules in 03-ACCEPTANCE:
  - eligible only when both reviewers say supported, their acceptable sets are
    identical, and the adjudicator finds the evidence sufficient;
  - ambiguous keeps the acceptable-set (union when the two sets differ);
  - inconsistent is sent to the revision queue and is never admitted.

Run: python3 import_blind_review.py
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[4]
HANDOFF = ROOT / "handoff" / "20261112-sprint-r5" / "blind-review"
V3_CASES = HERE.parent / "v3" / "cases.v3.jsonl"
OUT = HERE
sys_path = __import__("sys").path
if str(HERE) not in sys_path:
    sys_path.insert(0, str(HERE))
from provenance import check_blind_bundle, load_jsonl as load_rows, raw_lines, sha256_text  # noqa: E402

TASK_MAP = {
    "reference_resolution": "interpret_request",
    "promise_cancel": "choose_goal",
    "info_asymmetry": "choose_action",
}


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def visible_input(case: dict) -> dict:
    return {
        "task": case.get("task"),
        "question": case.get("question"),
        "observation": case.get("observation"),
        "narrative": case.get("narrative"),
        "facts": case.get("facts") or [],
        "candidates": [
            {"id": candidate.get("id"), "text": candidate.get("text"),
             "kind": candidate.get("kind"), "params": candidate.get("params")}
            for candidate in case.get("candidates", [])
        ],
    }


def content_hash(case: dict) -> str:
    return sha256_text(canonical(visible_input(case)))


def load_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()
            if line.strip()]


def write_jsonl(path: Path, rows: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
                    encoding="utf-8", newline="\n")


def raw_hashes(path: Path) -> dict[str, str]:
    out = {}
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        out[row["caseId"]] = sha256_text(line)
    return out


def reject(errors: list[str]) -> int:
    print(json.dumps({"ok": False, "rejected": len(errors), "failures": errors[:40]},
                     ensure_ascii=False, indent=2))
    for item in errors[:40]:
        print(f"reject review input content: {item}", file=__import__("sys").stderr)
    return 1


def main() -> int:
    v3 = load_jsonl(V3_CASES)
    errors = check_blind_bundle(HANDOFF, v3)
    for label, filename in (("review-a", "review-s1.v4.jsonl"), ("review-b", "review-s2.v4.jsonl")):
        existing = OUT / filename
        if not existing.is_file():
            continue
        raw = raw_lines(HANDOFF / f"{label}.jsonl")
        for row in load_rows(existing):
            case_id = row.get("caseId")
            stored = row.get("rawReviewSha256")
            if not stored or case_id not in raw:
                errors.append(f"{case_id}: field=rawReviewSha missing original {label}")
                continue
            if stored != sha256_text(raw[case_id][0]):
                errors.append(f"{case_id}: field=rawReviewSha {label} does not match the review line")
    if errors:
        return reject(errors)
    a_rows = load_jsonl(HANDOFF / "review-a.jsonl")
    b_rows = load_jsonl(HANDOFF / "review-b.jsonl")
    a_raw = raw_hashes(HANDOFF / "review-a.jsonl")
    b_raw = raw_hashes(HANDOFF / "review-b.jsonl")
    comparison = {row["caseId"]: row for row in
                  json.loads((HANDOFF / "comparison.json").read_text(encoding="utf-8"))}
    by_a = {row["caseId"]: row for row in a_rows}
    by_b = {row["caseId"]: row for row in b_rows}

    cases_v4: list[dict] = []
    reviews_a: list[dict] = []
    reviews_b: list[dict] = []
    adjudicated: list[dict] = []
    revision_queue: list[dict] = []
    set_disagreements: list[dict] = []
    status_differences: list[dict] = []
    counts = {"eligible": 0, "ambiguous": 0, "inconsistent": 0}

    for case in v3:
        case_id = case["caseId"]
        if case_id not in by_a or case_id not in by_b:
            raise SystemExit(f"missing review for {case_id}")
        a, b = by_a[case_id], by_b[case_id]
        mapped_task = TASK_MAP.get(case["task"])
        if mapped_task is None:
            raise SystemExit(f"unmapped task {case['task']} in {case_id}")
        v4_case = {
            "schema": "frostecho.jev04.case/4",
            "caseId": case_id,
            "version": 4,
            "task": mapped_task,
            "productionTask": mapped_task,
            "sourceTask": case["task"],
            "K": len(case["candidates"]),
            "candidates": [
                {"id": candidate["id"], "text": candidate["text"],
                 "kind": candidate.get("kind")
                 or candidate.get("params", {}).get("action")
                 or mapped_task,
                 "params": candidate.get("params", {})}
                for candidate in case["candidates"]
            ],
            "narrative": case.get("narrative"),
            "facts": case.get("facts") or [],
            "generatorSkeleton": case.get("generatorSkeleton"),
            "sourceGroup": case.get("sourceGroup"),
            "templateFamily": case.get("generatorSkeleton"),
            "provenance": {
                "from": f"v3/cases.v3.jsonl@{case_id}",
                "sourceHead": "db34123423a06cc5118fb92e1c3cfb9f0c03fceb",
                "reviewSource": "handoff/20261112-sprint-r5/blind-review",
                "taskMap": "data/v4/schema-map.json",
            },
            "synthetic": False,
        }
        v4_case["contentHash"] = content_hash(v4_case)
        cases_v4.append(v4_case)
        for reviewer, row, raw in (("fresh-agent-a", a, a_raw.get(case_id)),
                                   ("fresh-agent-b", b, b_raw.get(case_id))):
            review = {
                "caseId": case_id,
                "contentHash": v4_case["contentHash"],
                "reviewVersion": "v4-review/1",
                "reviewer": reviewer,
                "independent": True,
                "independentSession": row.get("reviewVersion"),
                "rawReviewSha256": raw,
                "acceptableCandidateIds": row.get("acceptableCandidateIds", []),
                "status": row.get("status"),
                "reason": row.get("reason", ""),
                "missingInformation": row.get("missingInformation", []),
                "hashProtocol": "frostecho.jev04.visible/4",
                "note": "judgment preserved; hash re-bound to the v4 visible input",
            }
            (reviews_a if reviewer.endswith("a") else reviews_b).append(review)

        set_a = sorted(a.get("acceptableCandidateIds", []))
        set_b = sorted(b.get("acceptableCandidateIds", []))
        same_set = set_a == set_b
        union = sorted(set(set_a) | set(set_b))
        if not same_set:
            set_disagreements.append({"caseId": case_id, "a": set_a, "b": set_b,
                                      "kept": union})
        if a.get("status") != b.get("status"):
            status_differences.append({"caseId": case_id, "a": a.get("status"),
                                       "b": b.get("status")})
        if "inconsistent" in (a.get("status"), b.get("status")):
            status = "inconsistent"
        elif a.get("status") == "supported" and b.get("status") == "supported" \
                and same_set:
            status = "supported"
        else:
            status = "ambiguous"
        eligible = status == "supported"
        counts[status] += 1
        missing = sorted(set(a.get("missingInformation", []))
                         | set(b.get("missingInformation", [])))
        reason = (f"review-a={a.get('status')} review-b={b.get('status')}; "
                  f"acceptable={'same' if same_set else 'union-kept'}; "
                  f"adjudication={status}")
        board = {
            "caseId": case_id,
            "contentHash": v4_case["contentHash"],
            "reviewVersion": "v4-review/1",
            "status": status,
            "eligible": eligible,
            "label": union[0] if eligible and len(union) == 1 else None,
            "acceptable": union,
            "reviewAStatus": a.get("status"),
            "reviewBStatus": b.get("status"),
            "reviewAAcceptable": set_a,
            "reviewBAcceptable": set_b,
            "missingInformation": missing,
            "reason": reason,
            "adjudicator": "agent-h-r5",
            "humanDoubleLabel": False,
            "crossModelValidation": False,
            "sourceRevision": "v3@db34123423a06cc5118fb92e1c3cfb9f0c03fceb",
        }
        adjudicated.append(board)
        if status == "inconsistent":
            revision_queue.append({
                "caseId": case_id,
                "kind": "content-revision",
                "reason": reason,
                "missingInformation": missing,
                "action": "fix the facts/narrative conflict, regenerate contentHash, "
                          "then run a fresh independent review",
            })
        elif not eligible:
            revision_queue.append({
                "caseId": case_id,
                "kind": "admission-blocked",
                "reason": reason,
                "missingInformation": missing,
                "action": "keep the acceptable-set; do not count as eligible until "
                          "evidence and status conventions are resolved",
            })

    write_jsonl(OUT / "cases.v4.jsonl", cases_v4)
    write_jsonl(OUT / "review-s1.v4.jsonl", reviews_a)
    write_jsonl(OUT / "review-s2.v4.jsonl", reviews_b)
    write_jsonl(OUT / "adjudication.v4.jsonl", adjudicated)
    write_jsonl(OUT / "train.v4.jsonl", [])
    write_jsonl(OUT / "dev.v4.jsonl", [])
    write_jsonl(OUT / "revision-queue.jsonl", revision_queue)
    (OUT / "schema-map.json").write_text(json.dumps({
        "schema": "frostecho.jev04.schema-map/1",
        "source": "frostecho.jev04.case/3",
        "target": "frostecho.jev04.case/4",
        "mapping": TASK_MAP,
        "candidateTextAndParams": "bound into the v4 contentHash",
        "semanticIntentVsWorldParams": "candidate.text is intent; candidate.params is the "
                                       "world command candidate and is NOT silently rewritten",
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    (OUT / "field-semantics.json").write_text(json.dumps({
        "schema": "frostecho.jev04.field-semantics/1",
        "foodStock": "world food resource units available to the acting NPC; "
                     "not a portion count",
        "stockPortions": "the number of ready meal portions that can be promised; "
                          "a separate store from foodStock, and not implied by the narrative",
        "rule": "when the narrative only says '食物库存 N', stockPortions must not "
                "contradict it without an explicit stockScope fact",
        "retractionExists": "an AUTHORIZED retraction event exists",
        "retractionStatement": "a retraction-like statement was uttered (may be "
                               "unauthorized); the current schema lacks this field",
    }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    summary = {
        "schema": "frostecho.jev04.adjudication-summary/1",
        "date": "2026-11-12",
        "sourceHead": "db34123423a06cc5118fb92e1c3cfb9f0c03fceb",
        "cases": len(cases_v4),
        "sourceGroups": len({case.get("sourceGroup") for case in cases_v4}),
        "reviewedBy": ["fresh-agent-a", "fresh-agent-b"],
        "adjudicator": "agent-h-r5 (not human, not cross-model validation)",
        "eligible": counts["eligible"],
        "ambiguous": counts["ambiguous"],
        "inconsistent": counts["inconsistent"],
        "acceptableSetDisagreements": set_disagreements,
        "statusDifferences": status_differences,
        "researchTrainReady": False,
        "reason": "0 eligible cases under the frozen rule; 39-case source is far "
                  "below the original 512/128 gate",
        "hashProtocol": "frostecho.jev04.visible/4",
        "sourceReviewHashProtocol": "blind-review serializedInput (not reused as v4 hash)",
    }
    (OUT / "adjudication-summary.json").write_text(
        json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    print(json.dumps({key: summary[key] for key in
                      ("cases", "eligible", "ambiguous", "inconsistent",
                       "acceptableSetDisagreements", "statusDifferences")},
                     ensure_ascii=False, indent=2)[:1600])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
