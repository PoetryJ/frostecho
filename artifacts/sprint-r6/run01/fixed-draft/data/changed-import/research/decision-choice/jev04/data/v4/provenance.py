"""Bind a v4 case to the blind-review packet the reviewers actually saw.

The v4 content hash is a schema projection. It is not, by itself, proof that
the review was about these words. The chain is:

  canonical serializedInput SHA
    -> packet visible input
    -> the A/B review's declared contentHash
    -> the source case's narrative, facts and candidate id/text/params

Pure schema additions are the explicit task map and a candidate kind copied
from params.action. Any other semantic change needs a new review.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

TASK_MAP = {
    "reference_resolution": "interpret_request",
    "promise_cancel": "choose_goal",
    "info_asymmetry": "choose_action",
}

ALLOWED_KIND_FROM = ("params.action", "task-map")


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def raw_lines(path: Path) -> dict[str, tuple[str, dict]]:
    found: dict[str, tuple[str, dict]] = {}
    if not path.exists():
        return found
    for line in path.read_text(encoding="utf-8").splitlines():
        if not line.strip():
            continue
        row = json.loads(line)
        found[row["caseId"]] = (line, row)
    return found


def semantic_view(visible: dict) -> dict:
    candidates = []
    for candidate in visible.get("candidates") or []:
        params = candidate.get("params")
        candidates.append({
            "id": candidate.get("id"),
            "text": candidate.get("text"),
            "params": params if isinstance(params, dict) else {},
        })
    return {
        "task": visible.get("task"),
        "narrative": visible.get("narrative"),
        "facts": visible.get("facts") or [],
        "question": visible.get("question"),
        "observation": visible.get("observation"),
        "candidates": candidates,
    }


def field_diffs(left, right, prefix: str = "") -> list[str]:
    if type(left) is not type(right):
        return [prefix.rstrip(".") or "value"]
    if isinstance(left, dict):
        diffs: list[str] = []
        for key in sorted(set(left) | set(right)):
            path = f"{prefix}{key}"
            if key not in left or key not in right:
                diffs.append(path)
            else:
                diffs.extend(field_diffs(left[key], right[key], path + "."))
        return diffs
    if isinstance(left, list):
        if len(left) != len(right):
            return [prefix.rstrip(".") or "list"]
        diffs = []
        for index, (item, other) in enumerate(zip(left, right)):
            diffs.extend(field_diffs(item, other, f"{prefix}[{index}]."))
        return diffs
    if left != right:
        return [prefix.rstrip(".") or "value"]
    return []


def duplicate_ids(rows: list[dict]) -> list[str]:
    seen: set[str] = set()
    duplicates: list[str] = []
    for row in rows:
        case_id = row.get("caseId")
        if not isinstance(case_id, str) or not case_id:
            duplicates.append("<missing>")
            continue
        if case_id in seen:
            duplicates.append(case_id)
        seen.add(case_id)
    return duplicates


def allowed_kind(candidate: dict, source_task: str) -> set:
    params = candidate.get("params") if isinstance(candidate.get("params"), dict) else {}
    action = params.get("action")
    mapped = TASK_MAP.get(source_task)
    return {value for value in (action, mapped) if isinstance(value, str)}


def check_source_against_packet(case: dict, packet_visible: dict) -> list[str]:
    case_id = case.get("caseId")
    diffs = field_diffs(semantic_view(case), semantic_view(packet_visible))
    errors = [f"{case_id}: field={field} reviewed input differs from source" for field in diffs]
    source_task = case.get("task")
    if source_task not in TASK_MAP:
        errors.append(f"{case_id}: field=task unreviewed task {source_task!r}")
    for index, candidate in enumerate(case.get("candidates") or []):
        kind = candidate.get("kind")
        if kind is None:
            continue
        if kind not in allowed_kind(candidate, str(source_task)):
            errors.append(f"{case_id}: field=candidates[{index}].kind unreviewed kind {kind!r}")
    return errors


def check_blind_bundle(handoff: Path, cases: list[dict]) -> list[str]:
    """Whole-batch check. Callers must not write until this list is empty."""
    errors: list[str] = []
    packet_path = handoff / "packet.jsonl"
    canonical_path = handoff / "canonical-inputs.jsonl"
    review_a_path = handoff / "review-a.jsonl"
    review_b_path = handoff / "review-b.jsonl"
    for label, path in (("packet", packet_path), ("canonical-inputs", canonical_path),
                        ("review-a", review_a_path), ("review-b", review_b_path)):
        if not path.is_file():
            errors.append(f"missing original {label} at {path.name}")
    if errors:
        return errors
    packets = load_jsonl(packet_path)
    canonicals = load_jsonl(canonical_path)
    raw_a = raw_lines(review_a_path)
    raw_b = raw_lines(review_b_path)
    for label, rows in (("source", cases), ("packet", packets), ("canonical", canonicals),
                        ("review-a", [row for _, row in raw_a.values()]),
                        ("review-b", [row for _, row in raw_b.values()])):
        dupes = duplicate_ids(rows)
        if dupes:
            errors.append(f"{label}: duplicate caseId {dupes[:5]}")
    by_packet = {row.get("caseId"): row for row in packets}
    by_canonical = {row.get("caseId"): row for row in canonicals}
    for case in cases:
        case_id = case.get("caseId")
        packet = by_packet.get(case_id)
        canonical = by_canonical.get(case_id)
        review_a = raw_a.get(case_id)
        review_b = raw_b.get(case_id)
        if packet is None or canonical is None or review_a is None or review_b is None:
            errors.append(f"{case_id}: missing original packet/review/canonical-inputs")
            continue
        serialized = canonical.get("serializedInput")
        if not isinstance(serialized, str):
            errors.append(f"{case_id}: field=serializedInput missing")
            continue
        digest = sha256_text(serialized)
        if canonical.get("contentHash") != digest:
            errors.append(f"{case_id}: field=canonical.contentHash != serializedInput sha")
        if packet.get("contentHash") != digest:
            errors.append(f"{case_id}: field=packet.contentHash != serializedInput sha")
        line_a, row_a = review_a
        line_b, row_b = review_b
        if row_a.get("contentHash") != digest:
            errors.append(f"{case_id}: field=review-a.contentHash != serializedInput sha")
        if row_b.get("contentHash") != digest:
            errors.append(f"{case_id}: field=review-b.contentHash != serializedInput sha")
        try:
            parsed = json.loads(serialized)
        except json.JSONDecodeError:
            errors.append(f"{case_id}: field=serializedInput is not JSON")
            continue
        packet_diffs = field_diffs(semantic_view(parsed), semantic_view(packet.get("visibleInput") or {}))
        for field in packet_diffs:
            errors.append(f"{case_id}: field={field} packet visible input != canonical serializedInput")
        errors.extend(check_source_against_packet(case, packet.get("visibleInput") or {}))
        if sha256_text(line_a) != sha256_text(line_a) or not line_a:
            errors.append(f"{case_id}: field=rawReviewSha empty review-a")
        _ = line_b
    return errors


def check_v4_snapshot(handoff: Path, cases: dict[str, dict],
                      s1: dict[str, dict], s2: dict[str, dict]) -> list[str]:
    """Validator chain. Uses the original packet and raw review bytes, not the
    editable v4 hashes agreeing with each other."""
    formal = {case_id: case for case_id, case in cases.items()
              if case.get("synthetic") is not True}
    if not formal:
        return []
    errors: list[str] = []
    if not handoff.is_dir():
        return ["missing original blind-review packet"]
    raw_a = raw_lines(handoff / "review-a.jsonl")
    raw_b = raw_lines(handoff / "review-b.jsonl")
    packets = {row.get("caseId"): row for row in load_jsonl(handoff / "packet.jsonl")}
    canonicals = {row.get("caseId"): row for row in load_jsonl(handoff / "canonical-inputs.jsonl")}
    for case_id, case in formal.items():
        packet = packets.get(case_id)
        canonical = canonicals.get(case_id)
        if packet is None or canonical is None or case_id not in raw_a or case_id not in raw_b:
            errors.append(f"{case_id}: missing original packet/review")
            continue
        serialized = canonical.get("serializedInput")
        if not isinstance(serialized, str) or sha256_text(serialized) != canonical.get("contentHash"):
            errors.append(f"{case_id}: field=canonical.contentHash recomputed mismatch")
            continue
        digest = canonical["contentHash"]
        if packet.get("contentHash") != digest:
            errors.append(f"{case_id}: field=packet.contentHash != original serializedInput")
        line_a, row_a = raw_a[case_id]
        line_b, row_b = raw_b[case_id]
        if row_a.get("contentHash") != digest or row_b.get("contentHash") != digest:
            errors.append(f"{case_id}: field=review.contentHash != original serializedInput")
        for label, stored, line, row in (
                ("s1", s1.get(case_id), line_a, row_a),
                ("s2", s2.get(case_id), line_b, row_b)):
            if not stored:
                errors.append(f"{case_id}: missing_review_{label}")
                continue
            raw = stored.get("rawReviewSha256")
            if raw != sha256_text(line):
                errors.append(f"{case_id}: field=rawReviewSha {label} does not match the original review line")
            if row.get("caseId") != case_id:
                errors.append(f"{case_id}: field=caseId review identity drift")
        visible = packet.get("visibleInput") or {}
        projected = semantic_view({
            "task": case.get("sourceTask") or case.get("task"),
            "narrative": case.get("narrative"),
            "facts": case.get("facts") or [],
            "question": case.get("question"),
            "observation": case.get("observation"),
            "candidates": case.get("candidates") or [],
        })
        # v4 task is the mapped production task. Compare the source task.
        source_task = case.get("sourceTask")
        if source_task != (visible.get("task")):
            errors.append(f"{case_id}: field=sourceTask {source_task!r} != reviewed {visible.get('task')!r}")
        if case.get("task") != TASK_MAP.get(source_task):
            errors.append(f"{case_id}: field=task mapping {case.get('task')!r} is not the explicit map")
        diffs = field_diffs(
            {key: projected[key] for key in ("narrative", "facts", "question", "observation", "candidates")},
            {key: semantic_view(visible)[key] for key in ("narrative", "facts", "question", "observation", "candidates")},
        )
        for field in diffs:
            errors.append(f"{case_id}: field={field} v4 projection != reviewed input")
        for index, candidate in enumerate(case.get("candidates") or []):
            kind = candidate.get("kind")
            if kind not in allowed_kind(candidate, str(source_task)):
                errors.append(f"{case_id}: field=candidates[{index}].kind is not the explicit schema map")
    return errors
