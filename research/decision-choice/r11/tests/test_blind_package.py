"""R11 C line: packet-A/B must be one hash, two rounds, no labels."""
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
        "acceptableIds": ["cand-a"], "actorId": "npc_01",
    }


def branch_row(case_id):
    branches = []
    for index, candidate in enumerate(["cand-a", "cand-b"]):
        applied = index == 0
        branches.append({
            "candidateId": candidate,
            "firstAction": {"admitted": True, "status": "applied", "minutes": 60,
                            "startedAt": 480, "dueAt": 540, "refusal": None},
            "obligation": {"present": True, "kind": "task",
                           "statusAtDeadline": "fulfilled" if applied else "open",
                           "completedAt": 540 if applied else None,
                           "receiptTypes": ["meal_delivered"] if applied else []},
            "authorization": {"withdrawn": False, "unauthorizedSideEffects": 0},
            "resources": {"before": {"food": 10}, "after": {"food": 8},
                          "delta": {"food": -2}},
            "personMinutes": 60, "pending": False, "deadlinePassed": False,
            "receipts": [{"type": "meal_delivered", "count": 1}] if applied else [],
        })
    return {"caseId": case_id, "t0": {"simTime": 480},
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

    def seals(self, out, document, f_accept=("b1",), g_accept=("b1",)):
        produced = []
        for reviewer, accepted in (("F", f_accept), ("G", g_accept)):
            path = self.dir / f"{reviewer}-A.jsonl"
            rows = blind.read_jsonl(out / "review-template-A.jsonl")
            for index, row in enumerate(rows):
                picks = ["o1"] if index == 0 else []
                row["expectedAcceptableCandidateIds"] = picks
                row["abstain"] = len(picks) == 0
            path.write_text("".join(json.dumps(row) + "\n" for row in rows))
            blind.seal(out, reviewer, "A", path, self.dir / "sealed",
                       document["packageId"])
        produced = sorted((self.dir / "sealed").glob("*-A.seal.json"))
        release = blind.release_b(out, produced, self.dir / "sealed")
        self.assertEqual(release["packageId"], document["packageId"])
        for reviewer, accepted in (("F", f_accept), ("G", g_accept)):
            path = self.dir / f"{reviewer}-B.jsonl"
            rows = blind.read_jsonl(out / "review-template-B.jsonl")
            for index, row in enumerate(rows):
                picks = list(accepted) if index == 0 else []
                row["acceptableBranchIds"] = picks
                row["abstain"] = len(picks) == 0
            path.write_text("".join(json.dumps(row) + "\n" for row in rows))
            blind.seal(out, reviewer, "B", path, self.dir / "sealed",
                       document["packageId"], prior_seals=produced)
        return produced + sorted((self.dir / "sealed").glob("*-B.seal.json"))

    def test_two_rounds_one_hash_and_no_provenance(self):
        out, document = self.build()
        packet_a = blind.read_jsonl(out / "packet-A.jsonl")
        packet_b = blind.read_jsonl(out / "packet-B.jsonl")
        self.assertEqual(len(packet_a), 2)
        self.assertEqual(len(packet_b), 2)
        self.assertEqual(blind.verify(out)["packageId"], document["packageId"])
        for row in packet_a:
            self.assertNotIn("branches", row)
            self.assertNotIn("acceptableIds", row)
            self.assertNotIn("split", row)
            self.assertEqual(row["schema"], blind.PACKET_A)
        for row in packet_b:
            self.assertNotIn("acceptable", json.dumps(row))
            self.assertEqual(row["commonDeadline"]["horizonMinutes"], 240)
            self.assertEqual(len(row["branches"]), 2)
            self.assertIn("personMinutes", row["branches"][0])
        self.assertIn("expectedAcceptableCandidateIds",
                      blind.read_jsonl(out / "review-template-A.jsonl")[0])
        key = json.loads((out / "key.json").read_text())
        self.assertEqual(key["cases"][packet_a[0]["anonymousCaseId"]]["caseId"], "case-1")

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
        self.assertEqual(caught.exception.code, "packet-leak")

    def test_b_cannot_be_released_before_both_a_seals(self):
        out, document = self.build()
        rows = blind.read_jsonl(out / "review-template-B.jsonl")
        for row in rows:
            row["abstain"] = True
        path = self.dir / "F-B.jsonl"
        path.write_text("".join(json.dumps(row) + "\n" for row in rows))
        with self.assertRaises(blind.Refusal) as caught:
            blind.seal(out, "F", "B", path, self.dir / "sealed",
                       document["packageId"])
        self.assertEqual(caught.exception.code, "release-b")
        with self.assertRaises(blind.Refusal) as caught:
            blind.release_b(out, [], self.dir / "sealed")
        self.assertEqual(caught.exception.code, "release-b")

    def test_seals_are_immutable_and_reconcile_keeps_disagreement(self):
        out, document = self.build()
        all_seals = self.seals(out, document, f_accept=("b1",), g_accept=("b2",))
        with self.assertRaises(blind.Refusal):
            blind.seal(out, "F", "A", self.dir / "F-A.jsonl", self.dir / "sealed",
                       document["packageId"])
        report = blind.reconcile(all_seals, self.dir / "reconciled")
        self.assertEqual(report["stageB"]["disagreements"], 1)
        self.assertEqual(report["stageB"]["agreements"], 1)
        self.assertEqual(report["stageA"]["agreements"], 2)
        self.assertEqual(report["disagreementRows"][0]["reviewerF"], ["b1"])
        self.assertEqual(report["disagreementRows"][0]["reviewerG"], ["b2"])
        self.assertEqual(report["resolution"],
                         "none: disagreements are preserved for O; no majority vote")
        with self.assertRaises(blind.Refusal):
            blind.reconcile(all_seals, self.dir / "reconciled")

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
