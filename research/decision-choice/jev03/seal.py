#!/usr/bin/env python3
"""Freeze the winners and the comparison rule *before* any test score exists.

Selection rule (contract section 4): inside an arm keep the seed with the lowest
dev four-order mean NLL; ties go to the earlier epoch and then the smaller seed.
The main comparison between C and Q is decided by the same dev metric; the test
set is reported for both arms and never used to re-pick a model.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import j3config as R  # noqa: E402


def main() -> int:
    trainings = R.read_json(R.RUNS / "trainings.json")["runs"]
    selected = {}
    for arm in ("C", "Q"):
        candidates = [run for run in trainings if run["arm"] == arm]
        if not candidates:
            raise SystemExit(f"no training run for arm {arm}")
        best = min(candidates, key=lambda run: (round(run["devNll"], 12), run["seed"]))
        selected[arm] = {"seed": best["seed"], "bestEpoch": best["bestEpoch"],
                         "devNll": best["devNll"], "params": best["params"],
                         "path": best["path"], "fileSha256": best["fileSha256"],
                         "tensorSha256": best["tensorSha256"]}
        print(f"{arm}: seed {best['seed']} epoch {best['bestEpoch']} devNll {best['devNll']:.6f}")

    m0 = R.state_hash_identity()
    seal = {
        "schema": "frostecho.jev03.selection/1", "at": R.now_iso(),
        "rule": "per arm: lowest dev four-order mean NLL; tie -> earlier epoch, then smaller seed; "
                "C vs Q decided by the same dev metric, test never used to re-pick",
        "selected": selected, "M0": m0,
        "arms": {"M0": {"kind": "frozen jev02 M1 head", "params": m0["params"]},
                 "C": {"kind": "shared candidate scorer", "params": R.C_PARAMS},
                 "Q": {"kind": "final-query classifier", "params": R.Q_PARAMS}},
        "dataHashes": {split: R.sha256_file(R.split_file(split)) for split in R.SPLITS},
        "goldSha256": R.sha256_file(R.gold_file()),
        "groupsSha256": R.sha256_file(R.DATA / "groups.json"),
        "contractSha256": R.sha256_file(R.DATA / "contract.json"),
        "boundarySha256": R.sha256_file(R.DATA / "boundary.jsonl"),
        "featureIdentityHash": R.feature_identity_hash(),
        "testScoresExist": any(R.RESULTS.glob("test-scores*.jsonl")),
    }
    if seal["testScoresExist"]:
        raise SystemExit("test scores already exist; the selection must be sealed before them")
    R.write_json(R.RESULTS / "selection-seal.json", seal)
    print(R.canonical({"sealed": {arm: selected[arm]["seed"] for arm in selected},
                       "rule": seal["rule"][:40]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
