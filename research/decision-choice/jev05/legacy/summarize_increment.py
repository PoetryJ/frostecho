#!/usr/bin/env python3
"""Dev-only seed selection, then read-only historical C43 test regression.

Uses the training run's runner snapshot for actual CPU head/cache scoring.
No training, epoch reselection, calibration, or historical-file writes occur.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import math
import os
import sys
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path

sys.dont_write_bytecode = True
CLASSES = ("PLAYER_FIRST", "NPC_FIRST", "NO_PRIORITY_REQUEST", "NEEDS_CLARIFICATION")
BASELINE_SHA = "a55cc47f1c30353b9c1a38e6de3d79e1765a26412b215486d40e06e04514c989"
HISTORICAL_CHALLENGE_SHA = "0e3adb915dffb9d45903166032ae4eec67516ec882b30e68abfa5399d42d25c1"


def require(condition, message):
    if not condition:
        raise ValueError(message)


def canonical(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def jsonl(path):
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


def write_json(path, value):
    with Path(path).open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n")
        handle.flush()
        os.fsync(handle.fileno())


def metric_shape(value, description):
    require(isinstance(value, dict), f"Missing dev metrics: {description}")
    require(isinstance(value.get("cases"), int) and value["cases"] > 0, f"Invalid case count: {description}")
    require(value.get("presentations") == value["cases"] * 4, f"Not four presentations/case: {description}")
    require(isinstance(value.get("nll"), (int, float)) and math.isfinite(value["nll"]) and value["nll"] >= 0,
            f"Invalid dev NLL: {description}")
    require(isinstance(value.get("accuracy"), (int, float)) and 0 <= value["accuracy"] <= 1,
            f"Invalid dev accuracy: {description}")


def load_runs(run_root):
    runs, shared = [], None
    for mode in ("warm-start", "random"):
        for seed in (17, 43):
            folder = run_root / f"{mode}-{seed}"
            result_path, checkpoint = folder / "result.json", folder / "best.safetensors"
            result = read(result_path)
            require(result.get("schema") == "frostecho.jev05.legacy-extension/1", f"Run incomplete: {folder}")
            require(result.get("protocol") == "historical-semantic-contract/2", f"Wrong protocol: {folder}")
            require(result.get("mode") == mode and result["config"]["seed"] == seed, f"Wrong run identity: {folder}")
            require(result["config"]["epochs"] == 20 and result["config"].get("fourOrders") is True,
                    f"Expected the authorized 20-epoch four-order run: {folder}")
            require(isinstance(result["selectedEpoch"], int) and 0 <= result["selectedEpoch"] <= 20,
                    f"Invalid selected epoch: {folder}")
            require(sha(checkpoint) == result["checkpointSha256"], f"Checkpoint SHA mismatch: {folder}")
            original = result["finalDevComponents"]["original"]
            increment = result["finalDevComponents"]["increment"]
            combined = result["finalDev"]
            for name, value in (("original", original), ("increment", increment), ("combined", combined)):
                metric_shape(value, f"{folder.name}/{name}")
            require(increment["cases"] == 16, f"Expected the frozen 16-case new dev: {folder}")
            require(combined["cases"] == original["cases"] + increment["cases"], f"Dev composition count mismatch: {folder}")
            provenance = result["provenance"]
            require(provenance["initialCheckpointSha256"] == BASELINE_SHA, f"Unexpected original C43: {folder}")
            population = {key: provenance[key] for key in ("combinedDev", "combinedTraining", "featureIdentityHash")}
            if shared is None:
                shared = population
            require(population == shared, "The four runs did not use the same train/dev provenance")
            runs.append({"run": folder.name, "mode": mode, "seed": seed,
                         "selectedEpoch": result["selectedEpoch"], "checkpoint": str(checkpoint),
                         "checkpointSha256": result["checkpointSha256"], "resultPath": str(result_path),
                         "resultSha256": sha(result_path), "originalDev": original,
                         "new16Dev": increment, "combinedDev": combined,
                         "featureIdentityHash": provenance["featureIdentityHash"]})
    return runs, shared


def choose_warm(runs):
    candidates = [run for run in runs if run["mode"] == "warm-start"]
    require({run["seed"] for run in candidates} == {17, 43} and len(candidates) == 2,
            "Need exactly warm-start seeds 17 and 43")
    return min(candidates, key=lambda run: (run["combinedDev"]["nll"], run["seed"]))


def load_gold_and_population(legacy):
    """Called only after selection.json is persisted; never infers exclusions."""
    gold_path = legacy / "data" / "test.gold.json"
    document = read(gold_path)
    require(document.get("schema") == "frostecho.jev03.gold/1", "Unexpected historical gold schema")
    gold = document["gold"]
    require(isinstance(gold, dict) and len(gold) == 256, "Expected all 256 historical test cases")
    digest = hashlib.sha256(canonical(gold).encode("utf-8")).hexdigest()
    require(document["sha256"] == digest, "Historical gold self-hash mismatch")
    require(all(isinstance(key, str) and row.get("labelId") in CLASSES and isinstance(row.get("groupId"), str)
                for key, row in gold.items()), "Malformed historical gold rows")
    evidence = {"goldPath": str(gold_path), "goldSha256": sha(gold_path), "goldCanonicalSha256": digest,
                "goldFormat": "gold[caseId]={groupId,labelId}; no per-case challenge/scored fields",
                "historical246Available": False, "challengeIds": [], "allCases": len(gold)}
    # The original seal binds gold, not challenge.jsonl. Reconstruct the exact
    # historical subset from the preserved list plus its original adjudication.
    seal_path = legacy / "results" / "selection-seal.json"
    require(read(seal_path)["goldSha256"] == evidence["goldSha256"], "Original selection seal does not bind this gold")
    evidence.update(selectionSealSha256=sha(seal_path), goldSealVerified=True)
    try:
        challenge_path = legacy / "data" / "challenge.jsonl"
        evidence["challengeSha256"] = sha(challenge_path)
        require(evidence["challengeSha256"] == HISTORICAL_CHALLENGE_SHA, "Challenge bytes differ from preserved historical list")
        challenge_rows = jsonl(challenge_path)
        challenge = {row["caseId"] for row in challenge_rows}
        require(len(challenge) == len(challenge_rows) == 10 and challenge <= set(gold), "Invalid historical challenge coverage")
        require(all(row.get("split") == "test" for row in challenge_rows), "Historical challenge contains non-test rows")
        adjudication_path = legacy / "data" / "adjudication.json"
        adjudication = read(adjudication_path)
        adjudicated = {row["caseId"] for row in adjudication["records"] if row["resolution"] == "challenge"}
        require(challenge == adjudicated, "Challenge list differs from original adjudication")
        inputs_path = legacy / "data" / "test.inputs.jsonl"
        input_rows = jsonl(inputs_path)
        require(len(input_rows) == len(gold) and {row["caseId"] for row in input_rows} == set(gold), "Test input/gold IDs differ")
        evidence.update(historical246Available=True, challengeIds=sorted(challenge),
                        scoredCases=len(set(gold) - challenge), challengeCases=len(challenge),
                        adjudicationSha256=sha(adjudication_path), testInputsSha256=sha(inputs_path),
                        basis="Reconstructed from preserved historical challenge list, checked against original adjudication; the original selection seal did not separately bind challenge bytes.")
        return gold, set(gold) - challenge, evidence
    except (OSError, KeyError, TypeError, ValueError) as error:
        evidence["historical246UnavailableReason"] = str(error)
        evidence["basis"] = "Only all256 is reported; no guessed challenge exclusions."
        return gold, None, evidence


def validate_scores(scores, gold):
    expected = {(key, order) for key in gold for order in range(4)}
    actual = {(row["caseId"], row["order"]) for row in scores}
    require(len(scores) == len(expected) and actual == expected, "Scores do not cover exactly 256 cases x four orders")
    for row in scores:
        logits = row["logits"]
        require(row["classIds"] == list(CLASSES) and len(logits) == 4 and all(math.isfinite(value) for value in logits),
                "Invalid stable-class logits")
        require(row["prediction"] == CLASSES[max(range(4), key=lambda index: logits[index])], "Prediction/logit mismatch")


def metrics(scores, gold, included):
    rows = [row for row in scores if row["caseId"] in included]
    require(rows, "Empty metric population")
    correct, nll, brier, order_hits, predictions = 0, 0.0, 0.0, defaultdict(list), defaultdict(set)
    for row in rows:
        target = gold[row["caseId"]]["labelId"]
        hit = int(row["prediction"] == target)
        correct += hit
        order_hits[row["order"]].append(hit)
        predictions[row["caseId"]].add(row["prediction"])
        peak = max(row["logits"])
        exponentials = [math.exp(value - peak) for value in row["logits"]]
        total = sum(exponentials)
        probabilities = [value / total for value in exponentials]
        target_index = CLASSES.index(target)
        nll -= math.log(max(probabilities[target_index], 1e-12))
        brier += sum((value - int(index == target_index)) ** 2 for index, value in enumerate(probabilities))
    per_order = {str(order): {"cases": len(hits), "correct": sum(hits), "accuracy": sum(hits) / len(hits)}
                 for order, hits in sorted(order_hits.items())}
    return {"cases": len(predictions), "presentations": len(rows), "correct": correct,
            "accuracy": correct / len(rows), "nll": nll / len(rows), "brier": brier / len(rows),
            "temperature": 1.0, "calibrated": False, "nllProbabilityFloor": 1e-12,
            "perOrder": per_order, "worstOrderAccuracy": min(row["accuracy"] for row in per_order.values()),
            "allFourSamePrediction": sum(len(values) == 1 for values in predictions.values()),
            "unit": "case x presentation; four presentations are not four independent cases"}


def comparison(baseline, selected, gold, included):
    old = {(row["caseId"], row["order"]): row for row in baseline if row["caseId"] in included}
    changed, improved, regressed, changed_cases = 0, 0, 0, set()
    for row in selected:
        if row["caseId"] not in included:
            continue
        before = old[(row["caseId"], row["order"])]["prediction"]
        target = gold[row["caseId"]]["labelId"]
        after = row["prediction"]
        changed += int(before != after)
        improved += int(before != target and after == target)
        regressed += int(before == target and after != target)
        if before != after:
            changed_cases.add(row["caseId"])
    before_metrics, after_metrics = metrics(baseline, gold, included), metrics(selected, gold, included)
    return {"baselineC43": before_metrics, "selectedWarm": after_metrics,
            "deltaSelectedMinusBaseline": {name: after_metrics[name] - before_metrics[name] for name in ("accuracy", "nll", "brier")},
            "changedPresentations": changed, "changedCases": len(changed_cases),
            "correctedPresentations": improved, "regressedPresentations": regressed}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-root", required=True, type=Path)
    parser.add_argument("--run-root", required=True, type=Path)
    parser.add_argument("--output-dir", required=True, type=Path)
    args = parser.parse_args(argv)
    legacy, run_root, output = (path.resolve() for path in (args.legacy_root, args.run_root, args.output_dir))
    require(not output.is_relative_to(legacy), "Output must be outside the read-only historical tree")
    require(not output.exists(), "Use a new output directory; existing files are never overwritten")
    runs, dev_provenance = load_runs(run_root)
    selected = choose_warm(runs)
    output.mkdir(parents=True, exist_ok=False)
    selection = {"schema": "frostecho.jev05.increment-dev-selection/1", "at": datetime.now(timezone.utc).isoformat(),
                 "rule": "Lowest final combined-dev NLL among warm-start seeds 17/43; exact ties choose lower seed.",
                 "epochRule": "Use each result.json's already dev-selected epoch/checkpoint; do not reselect epochs.",
                 "selected": selected, "devRuns": runs, "devProvenance": dev_provenance,
                 "testUsedForSeedOrEpochSelection": False, "testOpenedByThisCLIYet": False}
    selection_path = output / "selection.json"
    write_json(selection_path, selection)  # Must precede every old-test read.
    print(canonical({"status": "selection-persisted", "run": selected["run"],
                     "selectedEpoch": selected["selectedEpoch"], "selectionSha256": sha(selection_path)}), flush=True)

    runner_path = run_root / "source" / "runner.py"
    spec = importlib.util.spec_from_file_location("increment_summary_runner", runner_path)
    require(spec is not None and spec.loader is not None, "Missing training runner snapshot")
    runner = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(runner)
    import torch
    torch.set_num_threads(2)
    baseline_checkpoint = legacy / "runs" / "C-seed43" / "best.safetensors"
    require(sha(baseline_checkpoint) == BASELINE_SHA, "Original C43 checkpoint bytes changed")
    training_path = legacy / "runs" / "trainings.json"
    record = runner.checkpoint_record(baseline_checkpoint, training_path)
    require(record["seed"] == 43, "Historical checkpoint record is not C seed43")
    identity = record["meta"]["featureIdentityHash"]
    require(identity == selected["featureIdentityHash"], "Training/test backbone feature identities differ")
    cache = runner.load_cache(legacy / "cache" / "features-test.npz", identity, expected_split="test")
    baseline_scores = runner.stable_scores(runner.make_head(baseline_checkpoint), cache)
    selected_scores = runner.stable_scores(runner.make_head(selected["checkpoint"]), cache)
    gold, scored_ids, population = load_gold_and_population(legacy)
    score_files = {}
    for name, scores in (("baseline-c43-scores.jsonl", baseline_scores), ("selected-warm-scores.jsonl", selected_scores)):
        validate_scores(scores, gold)
        target = output / name
        with target.open("x", encoding="utf-8", newline="\n") as handle:
            handle.write("".join(canonical(row) + "\n" for row in scores))
        score_files[name] = {"path": str(target), "sha256": sha(target), "rows": len(scores)}
    require(sha(selected["checkpoint"]) == selected["checkpointSha256"], "Selected checkpoint changed during scoring")
    require(all(sha(row["resultPath"]) == row["resultSha256"] for row in runs), "Run result changed during summarization")
    summary = {"schema": "frostecho.jev05.increment-regression-summary/1", "at": datetime.now(timezone.utc).isoformat(),
               "selected": selected, "selectionPath": str(selection_path), "selectionSha256": sha(selection_path),
               "devRuns": runs, "population": population, "temperature": 1.0, "calibrated": False,
               "all256": comparison(baseline_scores, selected_scores, gold, set(gold)),
               "historicalScored": comparison(baseline_scores, selected_scores, gold, scored_ids) if scored_ids is not None else None,
               "evidence": {"runnerSnapshotSha256": sha(runner_path), "baselineCheckpointSha256": BASELINE_SHA,
                            "selectedCheckpointSha256": selected["checkpointSha256"], "trainingRecordSha256": sha(training_path),
                            "testCache": cache["provenance"], "rawScores": score_files,
                            "summarizerSha256": sha(Path(__file__))},
               "limits": {"dev": "Original dev, new16 dev and combined dev were used for model/epoch selection, not independent proof.",
                          "test": "Previously revealed historical test regression, not a new certification set.",
                          "calibration": "T=1; no temperature fitting or execution-admission claim.",
                          "training": "No training or parameter updates; random-init runs are dev controls and are not selected for test.",
                          "newGainProven": False, "newCertificate": False, "executionAdmitted": False}}
    write_json(output / "summary.json", summary)
    print(canonical({"status": "complete", "summary": str(output / "summary.json"),
                     "selectedRun": selected["run"], "historicalScoredCases": len(scored_ids) if scored_ids is not None else None,
                     "allCases": len(gold)}), flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(canonical({"status": "failed", "errorType": type(error).__name__, "error": str(error)}), file=sys.stderr)
        raise SystemExit(2)
