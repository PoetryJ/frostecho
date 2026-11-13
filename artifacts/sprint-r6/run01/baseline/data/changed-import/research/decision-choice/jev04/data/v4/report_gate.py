#!/usr/bin/env python3
"""Write the human-readable gate-v4 report from the CURRENT bytes.

The report is an output, never an input: `encoder_train.py` recomputes
`validate_v4.check()` and never reads this file.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import validate_v4  # noqa: E402


def main() -> int:
    failures, summary = validate_v4.check(HERE)
    adjudication_path = HERE / "adjudication-summary.json"
    adjudication = (json.loads(adjudication_path.read_text(encoding="utf-8"))
                    if adjudication_path.is_file() else {})
    payload = {
        "schema": "frostecho.jev04.gate-v4/2",
        "purpose": "report from the current bytes; not an input to training",
        "validator": "research/decision-choice/jev04/data/v4/validate_v4.py",
        "hashProtocol": "frostecho.jev04.visible/4 (task/narrative/facts/"
                        "candidate order+id+text+kind+params)",
        "summary": summary,
        "failures": failures,
        "adjudication": {
            "eligible": adjudication.get("eligible"),
            "ambiguous": adjudication.get("ambiguous"),
            "inconsistent": adjudication.get("inconsistent"),
            "acceptableSetDisagreements": len(
                adjudication.get("acceptableSetDisagreements", [])),
            "statusDifferences": len(adjudication.get("statusDifferences", [])),
            "humanDoubleLabel": False,
            "crossModelValidation": False,
        },
        "researchTrainReady": bool(summary.get("researchTrainReady")),
        "formalTraining": {
            "status": "closed" if not summary.get("researchTrainReady") else "open",
            "reason": "qualified counts below 512/128" if not summary.get(
                "researchTrainReady") else "gate passed",
        },
        "note": "the 39-case review is an independent-session adjudication "
                "start point, not 512/128 training data",
    }
    (HERE / "gate-v4.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": not failures, "ready": summary["researchTrainReady"],
                      "qualifiedTrain": summary["qualifiedTrain"],
                      "qualifiedDev": summary["qualifiedDev"]}, ensure_ascii=False))
    return 0 if not failures else 1


if __name__ == "__main__":
    raise SystemExit(main())
