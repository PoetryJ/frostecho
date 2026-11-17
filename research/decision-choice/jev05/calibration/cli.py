#!/usr/bin/env python3
"""Calibrate real JEV checkpoint scores, seal independent cert, predict JSONL."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

MODELS = Path(__file__).resolve().parents[1] / "models"
sys.path.insert(0, str(MODELS))
from contracts import canonical, digest, file_sha, qualify, read_json, read_jsonl, validate_case, write_json
from head import load_checkpoint
from math_core import fit_temperature, select_tau
from policy import IDENTITY_FIELDS, PARTITIONS, build_artifact, load_calibration, predict


def assemble_partitions(cases, scores_path, checkpoint, memory_policy_version):
    identity = {"checkpointSha256": checkpoint["checkpointSha256"],
                "encoderSha256": checkpoint["encoderSha256"],
                "renderer": checkpoint["encoder"]["renderer"],
                "memoryPolicyVersion": memory_policy_version}
    scores = {}
    for row in read_jsonl(scores_path):
        key = row.get("caseId")
        if key in scores or key not in cases:
            raise ValueError(f"score ID missing/duplicate/outside qualified dataset: {key}")
        scores[key] = row
    partitions = {name: [] for name in PARTITIONS}
    for key, case in cases.items():
        if case["split"] not in partitions:
            continue
        row = scores.get(key)
        if row is None:
            raise ValueError(f"{key}: missing real score")
        if (row.get("evidenceClass") != "real-model" or
                row.get("contentHash") != validate_case(case) or
                row.get("checkpointSha256") != identity["checkpointSha256"] or
                row.get("encoderSha256") != identity["encoderSha256"] or
                row.get("candidateIds") != [value["id"] for value in case["candidates"]]):
            raise ValueError(f"{key}: real score identity/input binding mismatch")
        partitions[case["split"]].append({
            "caseId": key, "split": case["split"], "sourceGroup": case["sourceGroup"],
            "templateFamily": case["templateFamily"], "contentHash": row["contentHash"],
            "candidateIds": row["candidateIds"], "acceptableIds": case["acceptableIds"],
            "rawLogits": row["rawLogits"], "evidenceClass": "real-model", **identity,
        })
    return identity, partitions


def claim_certificate(registry, cert_records, identity, temperature, tau):
    """Consume a cert dataset once per frozen policy; repeat same policy is safe.

    This registry must be retained across experiments; deleting it does not
    scientifically create new independent data. Claim happens before cert math.
    """
    population = sorted([{"caseId": row["caseId"], "contentHash": row["contentHash"],
                          "acceptableIds": sorted(row["acceptableIds"]), "sourceGroup": row["sourceGroup"]}
                         for row in cert_records], key=lambda row: row["caseId"])
    dataset_sha = digest(population)
    claim = {"schema": "frostecho.jev05.cert-consumption/1", "certDatasetSha256": dataset_sha,
             "policySha256": digest({"identity": identity, "temperature": temperature, "tau": tau})}
    root = Path(registry)
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"{dataset_sha}.json"
    try:
        with path.open("x", encoding="utf-8", newline="\n") as handle:
            handle.write(canonical(claim) + "\n")
    except FileExistsError:
        if read_json(path) != claim:
            raise ValueError("this independent cert dataset was already consumed by another model/T/tau; use new independent cert data")
    return claim


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    build = sub.add_parser("calibrate")
    build.add_argument("--qualification", required=True)
    build.add_argument("--checkpoint", required=True)
    build.add_argument("--scores", required=True)
    build.add_argument("--memory-policy-version", required=True)
    build.add_argument("--certificate-registry", required=True, help="persistent across all runs; never delete to retry a failed cert")
    build.add_argument("--out", required=True)
    for name in ("inspect", "predict"):
        command = sub.add_parser(name)
        command.add_argument("--calibration", required=True)
        command.add_argument("--trusted-artifact-sha", required=True)
        command.add_argument("--runtime-identity", required=True, help="JSON file with checkpoint/encoder/renderer/memory identity")
        if name == "predict":
            command.add_argument("--scores", required=True)
            command.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    if args.command == "calibrate":
        qualification, cases = qualify(args.qualification)
        checkpoint, _weights = load_checkpoint(args.checkpoint)
        if checkpoint.get("evidenceClass") != "real-model" or checkpoint.get("encoder", {}).get("backend") != "qwen-frozen":
            raise ValueError("the R7 calibration mainline requires real frozen Qwen model evidence")
        if checkpoint.get("encoder", {}).get("model") not in ("Qwen/Qwen3.5-4B", "Qwen/Qwen3.5-27B"):
            raise ValueError("registered R7 model identity must be Qwen3.5-4B/27B")
        if checkpoint.get("qualification", {}).get("manifestSha256") != qualification["manifestSha256"]:
            raise ValueError("checkpoint was not trained under this frozen qualified dataset manifest")
        identity, partitions = assemble_partitions(cases, args.scores, checkpoint, args.memory_policy_version)
        temperature = fit_temperature(partitions["calT"])
        selection = select_tau(partitions["select"], temperature)
        if selection["valid"]:
            claim_certificate(args.certificate_registry, partitions["cert"], identity, temperature, selection["tau"])
        artifact = build_artifact(partitions, identity, evidence_class="real-model", qualification=qualification,
                                  source={"scoresSha256": file_sha(args.scores),
                                          "checkpointManifestSha256": file_sha(Path(args.checkpoint) / "manifest.json")})
        target = Path(args.out)
        if target.exists() and read_json(target).get("artifactSha256") != artifact["artifactSha256"]:
            raise ValueError("refusing to overwrite a different calibration artifact")
        write_json(target, artifact)
        print(canonical({"artifactSha256": artifact["artifactSha256"], "temperature": artifact["temperature"],
                         "tau": artifact["tau"], "certificate": artifact["certificate"],
                         "eligibleForExecution": artifact["eligibleForExecution"], "executionAdmitted": False}))
        # Failed research result is retained; process nonzero means not deployable.
        return 0 if artifact["eligibleForExecution"] else 3
    identity = read_json(args.runtime_identity)
    loaded = load_calibration(args.calibration, expected_artifact_sha=args.trusted_artifact_sha,
                              expected_identity=identity)
    if args.command == "inspect":
        print(canonical({"executionAdmitted": loaded["executionAdmitted"], "reason": loaded["reason"],
                         "artifactSha256": loaded["artifact"]["artifactSha256"]}))
        return 0 if loaded["executionAdmitted"] else 3
    decisions = []
    for row in read_jsonl(args.scores):
        # The caller supplies frozen memory/renderer identity; scores must bind
        # the actual checkpoint/encoder and cannot override those with a flag.
        for field in ("checkpointSha256", "encoderSha256"):
            if row.get(field) != identity[field]:
                raise ValueError(f"input score identity mismatch: {field}")
        if row.get("evidenceClass") != "real-model":
            raise ValueError("input scores are not real-model records")
        decision = predict(row["rawLogits"], row["candidateIds"], loaded, identity=identity,
                           content_hash=row.get("contentHash"))
        decision["caseId"] = row.get("caseId")
        decisions.append(decision)
    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("".join(canonical(value) + "\n" for value in decisions), encoding="utf-8", newline="\n")
    print(canonical({"decisions": len(decisions), "executionAdmitted": loaded["executionAdmitted"], "out": str(target)}))
    return 0 if loaded["executionAdmitted"] else 3


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(canonical({"status": "failed", "errorType": type(error).__name__, "error": str(error)}), file=sys.stderr)
        raise SystemExit(2)
