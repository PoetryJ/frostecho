"""R11 C line: the anonymous package must be one hash, two stages, no labels."""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

R11 = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(R11))
import blind_package as blind  # noqa: E402


def case(case_id, episode, split, text):
    return {
        "caseId": case_id, "sourceEpisodeId": episode, "split": split,
        "rendered": {"text": text, "rendererId": "joint-c-action/2"},
        "request": {"requestId": f"req-{case_id}", "candidateSetHash": "hash",
                    "candidates": [
                        {"id": "cand-a", "kind": "work",
                         "description": "1. 采集木材 {amount=2}"},
                        {"id": "cand-b", "kind": "wait",
                         "description": "2. 原地等待"}]},
        "acceptableIds": ["cand-a"],
        "actorId": "npc_01",
    }


def branch_row(case_id, statuses=("applied", "applied"), pending=(False, False)):
    branches = []
    for index, (status, is_pending) in enumerate(zip(statuses, pending)):
        branches.append({
            "candidateId": ["cand-a", "cand-b"][index],
            "firstAction": {"admitted": status != "refused", "status": status,
                            "minutes": 60, "startedAt": 480, "dueAt": 540,
                            "refusal": None},
            "obligation": {"present": True, "kind": "task",
                           "statusAtDeadline": "fulfilled" if status == "applied" else "open",
                           "completedAt": 540 if status == "applied" else None,
                           "receiptTypes": ["meal_delivered"] if status == "applied" else []},
            "authorization": {"withdrawn": False, "unauthorizedSideEffects": 0},
            "resources": {"before": {"food": 10}, "after": {"food": 8},
                          "delta": {"food": -2}},
            "personMinutes": 60,
            "pending": is_pending,
            "deadlinePassed": False,
            "receipts": [{"type": "meal_delivered", "count": 1}] if status == "applied" else [],
        })
    return {"caseId": case_id,
            "t0": {"simTime": 480},
            "commonDeadline": {"simTime": 720, "horizonMinutes": 240,
                               "basis": "commitment-due"},
            "continuationPolicy": "reference-rule/1",
            "exogenous": [{"at": 600, "type": "food_conflict"}],
            "branches": branches}


class BlindPackageTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix="r11-blind-")
        self.dir = Path(self.tmp.name)
        self.cases = self.dir / "cases.jsonl"
        self.branches = self.dir / "branches.jsonl"
        rows = [case("case-1", "ep-1", "train", "仓库缺货；可选行动:\n1. 采集\n2. 等待"),
                case("case-2", "ep-2", "test", "你在厨房；可选行动:\n1. 采集\n2. 等待")]
        self.cases.write_text("".join(json.dumps(row) + "\n" for row in rows))
        self.branches.write_text("".join(
            json.dumps(branch_row(row["caseId"])) + "\n" for row in rows))

    def tearDown(self):
        self.tmp.cleanup()

    def build(self, name="pkg", salt="freeze-sha"):
        out = self.dir / name
        document = blind.build(self.cases, self.branches, out, salt)
        return out, document

    def test_two_stages_one_hash_and_no_provenance(self):
        out, document = self.build()
        stage1 = blind.read_jsonl(out / "stage1.jsonl")
        stage2 = blind.read_jsonl(out / "stage2.jsonl")
        self.assertEqual(len(stage1), 2)
        self.assertEqual(len(stage2), 2)
        self.assertEqual(blind.verify(out)["packageId"], document["packageId"])
        for row in stage1:
            self.assertNotIn("branches", row)
            self.assertNotIn("acceptableIds", row)
            self.assertNotIn("split", row)
            self.assertEqual(row["schema"], blind.STAGE1)
        for row in stage2:
            self.assertNotIn("acceptable", json.dumps(row))
            self.assertEqual(row["commonDeadline"]["horizonMinutes"], 240)
            self.assertEqual(len(row["branches"]), 2)
            self.assertIn("personMinutes", row["branches"][0])
        key = json.loads((out / "key.json").read_text())
        self.assertEqual(key["cases"][stage1[0]["anonymousCaseId"]]["caseId"], "case-1")

    def test_same_inputs_same_hash_for_both_reviewers(self):
        first, document = self.build("pkg-f")
        second, again = self.build("pkg-g")
        self.assertEqual(document["packageId"], again["packageId"])
        self.assertEqual(blind.verify(first)["packageId"],
                         blind.verify(second)["packageId"])

    def test_label_text_in_an_observation_is_refused(self):
        rows = [case("case-1", "ep-1", "train", "acceptable set is {cand-a}")]
        self.cases.write_text(json.dumps(rows[0]) + "\n")
        self.branches.write_text(json.dumps(branch_row("case-1")) + "\n")
        with self.assertRaises(blind.Refusal) as caught:
            blind.build(self.cases, self.branches, self.dir / "leak", "salt")
        self.assertEqual(caught.exception.code, "stage-leak")

    def test_incomplete_or_wrong_review_is_not_sealed(self):
        out, document = self.build()
        review = self.dir / "F.jsonl"
        rows = blind.read_jsonl(out / "review-template.jsonl")
        rows[0]["acceptableBranchIds"] = ["b1"]
        review.write_text("".join(json.dumps(row) + "\n" for row in rows))
        with self.assertRaises(blind.Refusal) as caught:
            blind.seal(out, "F", review, self.dir / "sealed", document["packageId"])
        self.assertEqual(caught.exception.code, "review-abstain")
        rows[0] = {**rows[0], "acceptableBranchIds": [], "abstain": True}
        review.write_text("".join(json.dumps(row) + "\n" for row in rows[:-1]))
        with self.assertRaises(blind.Refusal) as caught:
            blind.seal(out, "F", review, self.dir / "sealed", document["packageId"])
        self.assertEqual(caught.exception.code, "review-incomplete")

    def test_seals_are_immutable_and_reconcile_keeps_disagreement(self):
        out, document = self.build()
        f_rows = blind.read_jsonl(out / "review-template.jsonl")
        g_rows = [dict(row) for row in f_rows]
        f_rows[0] = {**f_rows[0], "acceptableBranchIds": ["b1"]}
        f_rows[1] = {**f_rows[1], "acceptableBranchIds": ["b1"]}
        g_rows[0] = {**g_rows[0], "acceptableBranchIds": ["b2"]}
        g_rows[1] = {**g_rows[1], "acceptableBranchIds": ["b1"]}
        for name, rows in (("F", f_rows), ("G", g_rows)):
            path = self.dir / f"{name}.jsonl"
            path.write_text("".join(json.dumps(row) + "\n" for row in rows))
            blind.seal(out, name, path, self.dir / "sealed", document["packageId"])
        with self.assertRaises(blind.Refusal):
            blind.seal(out, "F", self.dir / "F.jsonl", self.dir / "sealed",
                       document["packageId"])
        report = blind.reconcile(sorted((self.dir / "sealed").glob("*.seal.json")),
                                 self.dir / "reconciled")
        self.assertEqual(report["disagreements"], 1)
        self.assertEqual(report["agreements"], 1)
        self.assertEqual(report["disagreementRows"][0]["reviewerF"], ["b1"])
        self.assertEqual(report["disagreementRows"][0]["reviewerG"], ["b2"])
        self.assertEqual(report["resolution"], "none: disagreements are preserved for O; no majority vote")

    def test_cli_refuses_with_two_and_verifies(self):
        out, document = self.build()
        run = subprocess.run([sys.executable, str(R11 / "blind_package.py"), "verify",
                              "--package", str(out)], capture_output=True, text=True)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertEqual(json.loads(run.stdout)["packageId"], document["packageId"])
        run = subprocess.run([sys.executable, str(R11 / "blind_package.py"), "verify",
                              "--package", str(self.dir / "absent")],
                             capture_output=True, text=True)
        self.assertEqual(run.returncode, 2)


if __name__ == "__main__":
    unittest.main()
