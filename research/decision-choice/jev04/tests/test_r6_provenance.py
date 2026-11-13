"""R6: a review stays bound to the input the reviewer saw."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
V4 = ROOT / "research/decision-choice/jev04/data/v4"
DATA = V4.parent
HANDOFF = ROOT / "handoff/20261112-sprint-r5/blind-review"


def copy_tree(dest: Path) -> Path:
    mini = dest / "mini"
    data = mini / "research/decision-choice/jev04/data"
    data.mkdir(parents=True)
    for version in ("v3", "v4"):
        shutil.copytree(DATA / version, data / version)
    shutil.copytree(HANDOFF, mini / "handoff/20261112-sprint-r5/blind-review")
    return mini


def hashes(path: Path) -> dict[str, bytes]:
    return {item.relative_to(path).as_posix(): item.read_bytes()
            for item in sorted(path.rglob("*"))
            if item.is_file() and item.suffix in {".json", ".jsonl"}}


class ProvenanceTests(unittest.TestCase):
    def test_unchanged_import_is_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp:
            mini = copy_tree(Path(tmp))
            v4 = mini / "research/decision-choice/jev04/data/v4"
            before = hashes(v4)
            result = subprocess.run([sys.executable, "-B", str(v4 / "import_blind_review.py")],
                                    cwd=mini, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(before, hashes(v4))
            self.assertIn('"eligible": 0', result.stdout)

    def _mutate(self, mini: Path, edit) -> subprocess.CompletedProcess:
        v3 = mini / "research/decision-choice/jev04/data/v3/cases.v3.jsonl"
        rows = [json.loads(line) for line in v3.read_text(encoding="utf-8").splitlines() if line.strip()]
        edit(rows[0])
        v3.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
                      encoding="utf-8")
        v4 = mini / "research/decision-choice/jev04/data/v4"
        before = hashes(v4)
        result = subprocess.run([sys.executable, "-B", str(v4 / "import_blind_review.py")],
                                cwd=mini, capture_output=True, text=True)
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertEqual(before, hashes(v4))
        diagnostic = (result.stdout + result.stderr).lower()
        self.assertIn(rows[0]["caseId"].lower(), diagnostic)
        self.assertTrue(any(word in diagnostic for word in ("review", "input", "content", "hash")))
        return result

    def test_candidate_text_params_facts_and_narrative_are_rejected(self):
        edits = [
            lambda case: case["candidates"][1].__setitem__("text", "另一句没人审过的话"),
            lambda case: case["candidates"][0]["params"].__setitem__("amount", 9),
            lambda case: case["facts"][0].__setitem__("content", "radio"),
            lambda case: case["narrative"].__setitem__("text", "叙述被换成了另一件事"),
        ]
        for edit in edits:
            with tempfile.TemporaryDirectory() as tmp:
                self._mutate(copy_tree(Path(tmp)), edit)

    def test_case_id_packet_and_raw_review_sha_are_rejected(self):
        with tempfile.TemporaryDirectory() as tmp:
            mini = copy_tree(Path(tmp))
            v3 = mini / "research/decision-choice/jev04/data/v3/cases.v3.jsonl"
            rows = [json.loads(line) for line in v3.read_text(encoding="utf-8").splitlines() if line.strip()]
            rows[0]["caseId"] = "not-the-reviewed-id"
            v3.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows),
                          encoding="utf-8")
            v4 = mini / "research/decision-choice/jev04/data/v4"
            before = hashes(v4)
            result = subprocess.run([sys.executable, "-B", str(v4 / "import_blind_review.py")],
                                    cwd=mini, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(before, hashes(v4))
        with tempfile.TemporaryDirectory() as tmp:
            mini = copy_tree(Path(tmp))
            packet = mini / "handoff/20261112-sprint-r5/blind-review/packet.jsonl"
            lines = packet.read_text(encoding="utf-8").splitlines()
            row = json.loads(lines[0])
            row["visibleInput"]["narrative"] = {"text": "packet 被换掉了"}
            lines[0] = json.dumps(row, ensure_ascii=False)
            packet.write_text("\n".join(lines) + "\n", encoding="utf-8")
            v4 = mini / "research/decision-choice/jev04/data/v4"
            before = hashes(v4)
            result = subprocess.run([sys.executable, "-B", str(v4 / "import_blind_review.py")],
                                    cwd=mini, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(before, hashes(v4))
            self.assertIn("field=", result.stdout + result.stderr)
        with tempfile.TemporaryDirectory() as tmp:
            mini = copy_tree(Path(tmp))
            review = mini / "handoff/20261112-sprint-r5/blind-review/review-a.jsonl"
            lines = review.read_text(encoding="utf-8").splitlines()
            row = json.loads(lines[0])
            row["reason"] = row["reason"] + "（改过的审查原文）"
            lines[0] = json.dumps(row, ensure_ascii=False)
            review.write_text("\n".join(lines) + "\n", encoding="utf-8")
            v4 = mini / "research/decision-choice/jev04/data/v4"
            before = hashes(v4)
            result = subprocess.run([sys.executable, "-B", str(v4 / "import_blind_review.py")],
                                    cwd=mini, capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(before, hashes(v4))
            self.assertIn("rawReviewSha", result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
