#!/usr/bin/env python3
"""R4 (G6): validator self-test — every tampering class must be rejected non-zero.

Builds a SYNTHETIC fixture tree (mechanism only; NOT review data, never
admissible as training data), runs validate_v4.py on it (must pass), then
mutates one binding at a time and asserts the gate fails.

Run: python3 rejections.py [--out DIR]
"""
from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
VALIDATOR = HERE / "validate_v4.py"


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
    return hashlib.sha256(canonical(visible_input(case)).encode("utf-8")).hexdigest()


def write_rows(path: Path, rows: list[dict]) -> None:
    path.write_text("\n".join(json.dumps(row, ensure_ascii=False) for row in rows) + "\n",
                    encoding="utf-8")


def build_fixture(root: Path) -> dict:
    cases, reviews, adj, train, dev = [], {"s1": [], "s2": []}, [], [], []
    for index in range(4):
        case_id = f"v4-fixture-{index:02d}"
        case = {"caseId": case_id,
                "question": f"合成测试问题 {index}：现在最该做什么？",
                "observation": {"day": 1, "hunger": 60 + index, "food": 4},
                "candidates": [{"id": "c-eat", "kind": "eat"},
                               {"id": "c-wait", "kind": "wait"}],
                "synthetic": True}
        case["contentHash"] = content_hash(case)
        cases.append(case)
        for session in ("s1", "s2"):
            reviews[session].append({"caseId": case_id,
                                     "contentHash": case["contentHash"],
                                     "reviewVersion": "v4-review/1",
                                     "label": "c-eat" if index % 2 == 0 else "c-wait"})
        adj.append({"caseId": case_id, "contentHash": case["contentHash"],
                    "label": "c-eat"})
        visible = canonical(visible_input(case))
        (train if index < 2 else dev).append({
            "caseId": case_id, "contentHash": case["contentHash"],
            "sourceGroup": f"fixture-group-{index}",
            "templateFamily": f"fixture-family-{index}", "text": visible})
    write_rows(root / "cases.v4.jsonl", cases)
    write_rows(root / "review-s1.v4.jsonl", reviews["s1"])
    write_rows(root / "review-s2.v4.jsonl", reviews["s2"])
    write_rows(root / "adjudication.v4.jsonl", adj)
    write_rows(root / "train.v4.jsonl", train)
    write_rows(root / "dev.v4.jsonl", dev)
    return {"cases": cases, "s1": reviews["s1"], "s2": reviews["s2"],
            "adj": adj, "train": train}


def run_validator(root: Path) -> tuple[int, dict]:
    result = subprocess.run([sys.executable, str(VALIDATOR), "--dir", str(root)],
                            capture_output=True, text=True)
    try:
        return result.returncode, json.loads(result.stdout)
    except json.JSONDecodeError:
        return result.returncode, {"stdout": result.stdout, "stderr": result.stderr}


def mutate(root: Path, fixture: dict, kind: str) -> None:
    if kind == "review_hash":
        fixture["s1"][0]["contentHash"] = "0" * 64
        write_rows(root / "review-s1.v4.jsonl", fixture["s1"])
    elif kind == "review_version":
        fixture["s2"][0]["reviewVersion"] = "v3-review/1"
        write_rows(root / "review-s2.v4.jsonl", fixture["s2"])
    elif kind == "label":
        fixture["adj"][0]["label"] = "c-not-a-candidate"
        write_rows(root / "adjudication.v4.jsonl", fixture["adj"])
    elif kind == "train_text":
        fixture["train"][0]["text"] = "tampered training text"
        write_rows(root / "train.v4.jsonl", fixture["train"])
    elif kind == "case_content":
        fixture["cases"][0]["question"] = "被篡改的问题文本"
        write_rows(root / "cases.v4.jsonl", fixture["cases"])


def main() -> int:
    out = Path(sys.argv[sys.argv.index("--out") + 1]) if "--out" in sys.argv else None
    if out is not None:
        out.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="v4-fixture-"))
    evidence = {"note": "synthetic mechanism fixture; never training data",
                "baseline": None, "rejections": []}
    try:
        fixture = build_fixture(root)
        code, payload = run_validator(root)
        evidence["baseline"] = {"exit": code, "summary": payload.get("summary")}
        if code != 0:
            print(json.dumps({"ok": False, "stage": "baseline", "payload": payload},
                             ensure_ascii=False, indent=2))
            return 1
        for kind in ("review_hash", "review_version", "label", "train_text",
                     "case_content"):
            shutil.rmtree(root)
            root.mkdir()
            mutate(root, build_fixture(root), kind)
            code, payload = run_validator(root)
            failures = payload.get("failures") or []
            rejected = code != 0 and len(failures) > 0
            evidence["rejections"].append({"kind": kind, "exit": code,
                                           "rejected": rejected,
                                           "failures": failures[:3]})
            if not rejected:
                print(json.dumps({"ok": False, "kind": kind, "payload": payload},
                                 ensure_ascii=False, indent=2))
                return 1
    finally:
        shutil.rmtree(root, ignore_errors=True)
    if out is not None:
        (out / "validator-rejections.json").write_text(
            json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "baseline": evidence["baseline"],
                      "rejections": evidence["rejections"]},
                     ensure_ascii=False, indent=2)[:1200])
    return 0


if __name__ == "__main__":
    sys.exit(main())
