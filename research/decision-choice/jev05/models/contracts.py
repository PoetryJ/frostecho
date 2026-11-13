"""Dependency-free input/provenance contracts for the real JEV-05 pipeline."""
from __future__ import annotations

import hashlib
import json
import math
import subprocess
from pathlib import Path

RENDERER = "jev05-context-candidate/1"
SPLITS = {"train", "dev", "calT", "select", "cert", "test"}


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode("utf-8")).hexdigest()


def file_sha(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def read_jsonl(path):
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


def write_json(path, value):
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(target.name + ".tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8", newline="\n")
    temporary.replace(target)


def visible(case):
    return {"context": case["context"], "candidates": [
        {"id": item["id"], "text": item["text"], "params": item.get("params", {})}
        for item in case["candidates"]]}


def validate_case(case, *, require_label=False):
    if not isinstance(case.get("caseId"), str) or not case["caseId"]:
        raise ValueError("caseId must be nonempty")
    if not isinstance(case.get("context"), (str, dict)):
        raise ValueError(f"{case['caseId']}: context must be text or object")
    candidates = case.get("candidates")
    if not isinstance(candidates, list) or len(candidates) < 2:
        raise ValueError(f"{case['caseId']}: at least two candidates required")
    ids = []
    for item in candidates:
        if not isinstance(item.get("id"), str) or not item["id"] or not isinstance(item.get("text"), str) or not item["text"]:
            raise ValueError(f"{case['caseId']}: candidate id/text missing")
        if not isinstance(item.get("params", {}), dict):
            raise ValueError("candidate params must be an object")
        ids.append(item["id"])
    if len(set(ids)) != len(ids):
        raise ValueError(f"{case['caseId']}: repeated candidate id")
    actual = digest(visible(case))
    if "contentHash" in case and case["contentHash"] != actual:
        raise ValueError(f"{case['caseId']}: contentHash mismatch")
    if require_label:
        acceptable = case.get("acceptableIds")
        if not isinstance(acceptable, list) or not acceptable or len(set(acceptable)) != len(acceptable) or not set(acceptable) <= set(ids):
            raise ValueError(f"{case['caseId']}: invalid acceptableIds")
    return actual


def render_candidates(case):
    """No labels, IDs or candidate positions in model text; permutation equivariant."""
    validate_case(case)
    context = case["context"] if isinstance(case["context"], str) else canonical(case["context"])
    return ["Observed context and current goals:\n" + context +
            "\nCandidate action:\n" + item["text"] +
            "\nCandidate parameters:\n" + canonical(item.get("params", {}))
            for item in case["candidates"]]


def unique_rows(path):
    rows = read_jsonl(path)
    by_id = {}
    for row in rows:
        key = row.get("caseId")
        if not isinstance(key, str) or not key or key in by_id:
            raise ValueError(f"{path}: missing/duplicate caseId {key!r}")
        by_id[key] = row
    return by_id


def checked_file(root, entry):
    path = (Path(root) / entry["path"]).resolve()
    if not path.is_file() or file_sha(path) != entry.get("sha256"):
        raise ValueError(f"missing or SHA mismatch: {entry.get('path')}")
    return path


def qualify(manifest_path, *, external_validator=None):
    """Recompute eligibility from bound original files; no cached ready boolean.

    An optional validator argv is run WITHOUT a shell after these checks. It
    cannot override a failure or lower the fixed 512/128 training thresholds.
    """
    manifest_path = Path(manifest_path).resolve()
    manifest = read_json(manifest_path)
    if manifest.get("schema") != "frostecho.jev05.qualification/1":
        raise ValueError("unknown qualification schema")
    files = manifest.get("files", {})
    required = ("cases", "reviewA", "reviewB", "adjudications")
    paths = {name: checked_file(manifest_path.parent, files[name]) for name in required}
    sources = manifest.get("sources", {})
    if not sources:
        raise ValueError("qualification needs original source artifacts")
    for entry in sources.values():
        checked_file(manifest_path.parent, entry)
    cases, reviews_a, reviews_b, boards = (unique_rows(paths[name]) for name in required)
    if any(set(rows) != set(cases) for rows in (reviews_a, reviews_b, boards)):
        raise ValueError("review/adjudication IDs must equal the frozen case IDs")
    groups, families, counts = {}, {}, {split: 0 for split in SPLITS}
    semantic_inputs = set()
    sessions_a, sessions_b = set(), set()
    for case_id, case in cases.items():
        actual = validate_case(case, require_label=True)
        semantic_hash = digest(sorted(render_candidates(case)))
        if semantic_hash in semantic_inputs:
            raise ValueError(f"{case_id}: duplicate visible task (candidate ID/order changes do not create new data)")
        semantic_inputs.add(semantic_hash)
        if case.get("contentHash") != actual or case.get("synthetic") is True or case.get("evidenceClass") in ("fixture", "cpu-mechanism", "unit-test"):
            raise ValueError(f"{case_id}: unbound or mechanism-only case")
        origin = case.get("origin", {})
        if origin.get("type") not in ("world-event", "human-authored") or origin.get("source") not in sources:
            raise ValueError(f"{case_id}: missing original world/author source")
        split = case.get("split")
        if split not in SPLITS:
            raise ValueError(f"{case_id}: unknown split")
        for name, seen in (("sourceGroup", groups), ("templateFamily", families)):
            group = case.get(name)
            if not isinstance(group, str) or not group:
                raise ValueError(f"{case_id}: {name} missing")
            if group in seen and seen[group] != split:
                raise ValueError(f"{case_id}: {name} crosses splits")
            seen[group] = split
        a, b, board = reviews_a[case_id], reviews_b[case_id], boards[case_id]
        for review in (a, b):
            if (review.get("contentHash") != actual or review.get("status") != "supported" or
                    review.get("blind") is not True or not review.get("reviewerId") or not review.get("sessionId") or
                    not isinstance(review.get("rawResponse"), str) or not review["rawResponse"].strip() or
                    set(review.get("acceptableIds", [])) != set(case["acceptableIds"])):
                raise ValueError(f"{case_id}: review not independently supported/bound")
        if a["sessionId"] == b["sessionId"] or a["reviewerId"] == b["reviewerId"]:
            raise ValueError(f"{case_id}: reviewers are not independent")
        sessions_a.add(a["sessionId"])
        sessions_b.add(b["sessionId"])
        if (board.get("contentHash") != actual or board.get("status") != "supported" or
                set(board.get("acceptableIds", [])) != set(case["acceptableIds"]) or
                board.get("reviewASha256") != digest(a) or board.get("reviewBSha256") != digest(b)):
            raise ValueError(f"{case_id}: adjudication does not bind both original reviews")
        counts[split] += 1
    if sessions_a & sessions_b:
        raise ValueError("reviewer sessions overlap between blind arms")
    if counts["train"] < 512 or counts["dev"] < 128:
        raise ValueError(f"training gate closed: train={counts['train']}/512 dev={counts['dev']}/128")
    if external_validator:
        if not isinstance(external_validator, list) or not all(isinstance(x, str) for x in external_validator):
            raise ValueError("external validator must be an argv array")
        result = subprocess.run(external_validator + [str(manifest_path)], shell=False, capture_output=True, text=True, timeout=120)
        if result.returncode != 0:
            raise ValueError(f"external data validator failed: exit={result.returncode}; {result.stderr[-1000:]}")
    return {"schema": "frostecho.jev05.qualified/1", "mayTrainOnJev": True,
            "manifestSha256": file_sha(manifest_path), "casesSha256": file_sha(paths["cases"]),
            "counts": counts, "reviewSessions": sorted(sessions_a | sessions_b)}, cases
