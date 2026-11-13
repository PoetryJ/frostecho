#!/usr/bin/env python3
"""Sealed test scoring for the three arms, plus the same-case JSON baseline.

Reads only the cached test features and the sealed selection; the test gold is
blocked behaviourally for the whole scoring pass and the block is positively
tested. No threshold, no temperature and no policy is produced this round: the
output is uncalibrated logits in stable class order plus argmax predictions.
"""
from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parent / "heads"))

import j3config as R  # noqa: E402
import j3heads as H  # noqa: E402
from guards import GoldSeal  # noqa: E402


def load_arm(arm: str, selection: dict):
    if arm == "M0":
        from safetensors.torch import load_file

        head = H.build("C")
        state = load_file(selection["M0"]["path"])
        head.load_state_dict({"score.weight": state["w"].reshape(1, -1)})
        head.eval()
        sha = selection["M0"]["tensorSha256"]
    else:
        head = H.load_trained(arm, Path(selection["selected"][arm]["path"]))
        sha = selection["selected"][arm]["tensorSha256"]
    return head, sha


def arm_logits_stable(head, arm: str, cand: np.ndarray, hq: np.ndarray, order: int) -> list[float]:
    """Return logits in stable class order for one presentation."""
    with torch.no_grad():
        if arm in ("M0", "C"):
            display = head(torch.from_numpy(cand).unsqueeze(0))[0].tolist()
            logits = [0.0] * len(R.CLASSES)
            for position, class_id in enumerate(R.ORDERS[order]):
                logits[R.CLASSES.index(class_id)] = float(display[position])
            return logits
        return [float(value) for value in head(torch.from_numpy(hq).unsqueeze(0))[0].tolist()]


def main() -> int:
    selection = R.read_json(R.RESULTS / "selection-seal.json")
    if selection["testScoresExist"]:
        raise SystemExit("selection seal says test scores already existed")
    for split, digest in selection["dataHashes"].items():
        if R.sha256_file(R.split_file(split)) != digest:
            raise SystemExit(f"{split} changed after the selection was sealed")

    features = np.load(R.features_file("test"))
    meta = R.read_json(R.features_file("test").with_suffix(".meta.json"))
    if meta["featureIdentityHash"] != selection["featureIdentityHash"]:
        raise SystemExit("test feature cache identity differs from the sealed identity")
    case_ids = meta["caseIds"]
    orders = meta["orderIds"]
    heads = {arm: load_arm(arm, selection) for arm in R.ARMS}

    seal = GoldSeal([R.gold_file(), R.split_file("test")])
    with seal:
        control = "not_attempted"
        try:
            open(R.gold_file(), encoding="utf-8")
        except Exception as error:
            control = f"blocked:{type(error).__name__}"
        rows = []
        for index, (case_id, order) in enumerate(zip(case_ids, orders)):
            for arm in R.ARMS:
                head, sha = heads[arm]
                logits = arm_logits_stable(head, arm, features["cand"][index],
                                           features["hq"][index], int(order))
                prediction = R.CLASSES[int(np.argmax(logits))]
                rows.append({"caseId": case_id, "order": int(order), "arm": arm,
                             "classIds": list(R.CLASSES), "logits": logits,
                             "prediction": prediction, "headSha": sha})
    scores_path = R.RESULTS / "test-scores.jsonl"
    scores_sha = R.write_jsonl(scores_path, rows)
    predictions_sha = R.write_jsonl(R.RESULTS / "test-predictions.jsonl",
                                    [{"caseId": row["caseId"], "order": row["order"],
                                      "arm": row["arm"], "prediction": row["prediction"]}
                                     for row in rows])
    record = {"schema": "frostecho.jev03.unseal-record/1", "at": R.now_iso(),
              "sealedPaths": [str(R.gold_file()), str(R.split_file("test"))],
              "goldSealControl": control, "blockedAttempts": len(seal.attempts),
              "blockedPaths": seal.attempts, "goldRead": False,
              "scores": {"path": str(scores_path), "sha256": scores_sha, "rows": len(rows)},
              "predictions": {"sha256": predictions_sha},
              "heads": {arm: heads[arm][1] for arm in R.ARMS},
              "selectionSha256": R.sha256_file(R.RESULTS / "selection-seal.json"),
              "jsonSha256": R.read_json(R.RESULTS / "test-json-meta.json")["sha256"]}
    R.write_json(R.RESULTS / "unseal-record.json", record)
    print(R.canonical({"rows": len(rows), "control": control, "scores": scores_sha[:16]}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
