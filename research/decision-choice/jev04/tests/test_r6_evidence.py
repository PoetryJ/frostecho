"""R6: certificate numbers are recomputed, and a legal CPU fixture can accept."""
from __future__ import annotations

import copy
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path

HERE = Path(__file__).resolve()
sys.path.insert(0, str(HERE.parents[1] / "scorers"))
sys.path.insert(0, str(HERE.parents[1] / "calibration"))

import port_v3 as port
from calibration import ALPHA, cp_upper
from sealed import build_cpu_bundle


IDENTITY = dict(
    model="fixture/r6", head="shared-scalar/1", adapter="jev-choice/1",
    tokenizer="fixture-tok/1", renderer="jev04-render/3", task="choose_action",
    k=4, policy_version="softmax-accept/1", memory_policy_version="memory-policy/1",
)


def write_bundle(root: Path, bundle: dict) -> dict:
    refs = {}
    for name, payload in bundle.items():
        path = root / f"{name}.json"
        path.write_text(json.dumps(payload), encoding="utf-8")
        refs[name] = {"path": str(path), "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}
    manifest = {"schema": port.MANIFEST_SCHEMA, "registrations": [{
        "identity": IDENTITY, "mode": "real", "utility_source": None,
        "evidence": {**refs, "protocol_version": port.RISK_PROTOCOL_VERSION}}]}
    path = root / "manifest.json"
    path.write_text(json.dumps(manifest), encoding="utf-8")
    return port.load_trusted_manifest(str(path))


class EvidenceTests(unittest.TestCase):
    def setUp(self):
        self.identity = port.ScorerIdentity(**IDENTITY)
        self.bundle = build_cpu_bundle(IDENTITY, calibration_id="fixture-r6-cpu",
                                       evidence_class="cpu-mechanism", seeds=(17, 43))

    def decide(self, bundle, mode="real", temperature=None, tau=None, calibration_id=None):
        with tempfile.TemporaryDirectory() as tmp:
            loaded = write_bundle(Path(tmp), bundle)
            inspection = port.resolve_registration(loaded, self.identity).inspect()
            if not inspection.ok or inspection.temperature is None or inspection.tau is None:
                return inspection, None, None
            art = port.ScorerArtifact(
                port.ARTIFACT_SCHEMA, self.identity, mode,
                inspection.temperature if temperature is None else temperature,
                inspection.tau if tau is None else tau,
                inspection.coverage or 0, inspection.upper,
                calibration_id=inspection.calibration_id if calibration_id is None else calibration_id)
            high = port.decide(art, port.ScorerRequest(
                "high", self.identity, ["c0", "c1", "c2", "c3"], [6, 0, 0, 0]), loaded)
            low = port.decide(art, port.ScorerRequest(
                "low", self.identity, ["c0", "c1", "c2", "c3"], [0, 0, 0, 0]), loaded)
            return inspection, high, low

    def test_legal_mechanism_accepts_and_abstains_and_fixture_is_not_real(self):
        fixture = build_cpu_bundle(IDENTITY, evidence_class="fixture", seeds=(17, 43))
        inspection, high, low = self.decide(fixture, mode="fixture")
        self.assertTrue(inspection.ok, inspection.reason)
        self.assertEqual(high.disposition, "accept")
        self.assertEqual(low.disposition, "abstain")
        self.assertFalse(high.counts_as_real)
        self.assertFalse(low.counts_as_real)
        self.assertIsNone(high.utility)
        _, as_real, _ = self.decide(fixture, mode="real")
        self.assertFalse(as_real.counts_as_real)
        self.assertIn("fixture", as_real.reason or "")

    def test_cpu_mechanism_can_count_when_parameters_bind(self):
        inspection, high, _low = self.decide(self.bundle, mode="real")
        self.assertTrue(inspection.ok, inspection.reason)
        self.assertTrue(high.counts_as_real)
        self.assertEqual(high.disposition, "accept")
        self.assertEqual(high.selected_index, 0)

    def test_each_tamper_names_itself(self):
        base = self.bundle
        cases = {
            "errors": lambda payload: payload["cert"].__setitem__("errors", payload["cert"]["errors"] + 1),
            "n": lambda payload: payload["cert"].__setitem__("n", payload["cert"]["n"] - 1),
            "upper": lambda payload: payload["cert"].__setitem__("upper", 0.01),
            "coverage": lambda payload: payload["cert"].__setitem__("coverage", 0.01),
            "alpha": lambda payload: payload["cert"].__setitem__("alpha", 0.2),
            "temperature": lambda payload: payload["calT"].__setitem__("temperature", 1.7),
            "tau": lambda payload: payload["select"].__setitem__("tau", 0.99),
        }
        for name, edit in cases.items():
            bundle = copy.deepcopy(base)
            edit(bundle)
            inspection, _high, _low = self.decide(bundle)
            self.assertFalse(inspection.ok, name)
            self.assertTrue(name in inspection.reason or name[:4] in inspection.reason, inspection.reason)
        bundle = copy.deepcopy(base)
        bundle["cert"]["records"][0]["sampleId"] = bundle["cert"]["records"][1]["sampleId"]
        bundle["cert"]["sampleIds"][0] = bundle["cert"]["sampleIds"][1]
        bundle["cert"]["data_sha256"] = "0" * 64
        inspection, _, _ = self.decide(bundle)
        self.assertFalse(inspection.ok)
        self.assertIn("sampleId", inspection.reason)
        bundle = copy.deepcopy(base)
        bundle["cert"]["records"][0]["sourceGroup"] = bundle["calT"]["records"][0]["sourceGroup"]
        bundle["cert"]["data_sha256"] = __import__("sealed").sha256_text(
            __import__("sealed").canonical(bundle["cert"]["records"]))
        inspection, _, _ = self.decide(bundle)
        self.assertFalse(inspection.ok)
        self.assertIn("sourceGroup", inspection.reason)

    def test_zero_of_120_matches_the_closed_form(self):
        upper = cp_upper(0, 120, ALPHA)
        self.assertIsNotNone(upper)
        self.assertLess(abs(upper - (1 - ALPHA ** (1 / 120))), 1e-9)

    def test_bool_and_non_integer_counts_are_refused(self):
        bundle = copy.deepcopy(self.bundle)
        bundle["cert"]["n"] = True
        inspection, _, _ = self.decide(bundle)
        self.assertFalse(inspection.ok)
        self.assertIn("n", inspection.reason)


if __name__ == "__main__":
    unittest.main()
