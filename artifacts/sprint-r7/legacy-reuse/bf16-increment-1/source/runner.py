#!/usr/bin/env python3
"""Recover and extend the actual JEV-03 C head without replacing its readout.

Historical protocol: semantic-contract/2, joint-rendered candidates, four
display orders, frozen 5120-D backbone, non-affine LayerNorm eps=1e-5, scalar
head. This is not a claim of v5 data eligibility or calibrated execution.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
DEFAULT_LEGACY = HERE.parents[1] / "jev03"
CLASSES = ("PLAYER_FIRST", "NPC_FIRST", "NO_PRIORITY_REQUEST", "NEEDS_CLARIFICATION")
ORDERS = (CLASSES, tuple(reversed(CLASSES)),
          ("NPC_FIRST", "PLAYER_FIRST", "NEEDS_CLARIFICATION", "NO_PRIORITY_REQUEST"),
          ("NO_PRIORITY_REQUEST", "NEEDS_CLARIFICATION", "PLAYER_FIRST", "NPC_FIRST"))


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def digest(value):
    return hashlib.sha256(canonical(value).encode()).hexdigest()


def sha(path):
    result = hashlib.sha256()
    with Path(path).open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            result.update(block)
    return result.hexdigest()


def read(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def rows(path):
    return [json.loads(line) for line in Path(path).read_text(encoding="utf-8").splitlines() if line.strip()]


def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n", encoding="utf-8", newline="\n")


def output_directory(path, legacy):
    output = Path(path).resolve()
    if output.is_relative_to(Path(legacy).resolve()):
        raise ValueError("new output must be outside the archived JEV-03 tree")
    output.mkdir(parents=True, exist_ok=True)
    if any(output.iterdir()):
        raise ValueError("use a new empty output directory; historical or previous run files will not be overwritten")
    return output


def checkpoint_record(checkpoint, training_record):
    actual = sha(checkpoint)
    matches = [entry for entry in read(training_record)["runs"] if entry.get("fileSha256") == actual and entry.get("arm") == "C"]
    if len(matches) != 1:
        raise ValueError("checkpoint bytes do not match exactly one recorded historical C training")
    return matches[0]


def make_head(checkpoint=None):
    import torch
    from torch import nn

    class CandidateHead(nn.Module):
        def __init__(self):
            super().__init__()
            self.norm = nn.LayerNorm(5120, elementwise_affine=False, eps=1e-5)
            self.score = nn.Linear(5120, 1, bias=False)

        def forward(self, values):
            if values.ndim != 3 or tuple(values.shape[1:]) != (4, 5120):
                raise ValueError("legacy C requires [batch,4,5120] candidate-position features")
            return self.score(self.norm(values)).squeeze(-1)

    head = CandidateHead()
    if checkpoint:
        from safetensors.torch import load_file
        state = load_file(str(checkpoint), device="cpu")
        if set(state) != {"score.weight"} or tuple(state["score.weight"].shape) != (1, 5120):
            raise ValueError("not the historical shared C checkpoint")
        head.load_state_dict(state, strict=True)
    return head.eval()


def load_cache(path, expected_identity, *, data_path=None, expected_split=None):
    path = Path(path)
    meta_path = path.with_suffix(".meta.json")
    meta = read(meta_path)
    if meta.get("featureIdentityHash") != expected_identity:
        raise ValueError("cache encoder/tokenizer/renderer/readout identity differs from historical C")
    if "featureIdentity" in meta and digest(meta["featureIdentity"]) != expected_identity:
        raise ValueError("cache feature identity object does not match its hash")
    if expected_split is not None and meta.get("split") != expected_split:
        raise ValueError("cache split mismatch")
    with np.load(path, allow_pickle=False) as data:
        cand = np.array(data["cand"], dtype=np.float32)
    ids, orders = meta.get("caseIds", []), meta.get("orderIds", [])
    if cand.shape != (len(ids), 4, 5120) or len(orders) != len(ids) or not np.isfinite(cand).all():
        raise ValueError("malformed historical candidate feature cache")
    presentations = set()
    for key, order in zip(ids, orders):
        if not isinstance(key, str) or not key or isinstance(order, bool) or order not in (0, 1, 2, 3) or (key, order) in presentations:
            raise ValueError("duplicate/invalid cached case/order")
        presentations.add((key, order))
    if any({order for key2, order in presentations if key2 == key} != {0, 1, 2, 3} for key in set(ids)):
        raise ValueError("every case needs all four re-encoded display orders")
    token_hashes = meta.get("tokenHash")
    if not isinstance(token_hashes, list) or len(token_hashes) != len(ids) or not all(isinstance(value, str) and value for value in token_hashes):
        raise ValueError("cache must retain per-presentation token hashes from the original renderer")
    labels, by_id = None, None
    if data_path is not None:
        data_rows = rows(data_path)
        by_id = {row["caseId"]: row for row in data_rows}
        if len(by_id) != len(data_rows) or set(by_id) != set(ids):
            raise ValueError("training/evaluation data IDs differ from cache")
        if any(row.get("labelId") not in CLASSES or (expected_split is not None and row.get("split") != expected_split) for row in data_rows):
            raise ValueError("wrong historical label/split")
        labels = np.asarray([ORDERS[order].index(by_id[key]["labelId"]) for key, order in zip(ids, orders)], dtype=np.int64)
    return {"cand": cand, "ids": ids, "orders": orders, "labels": labels, "cases": by_id, "meta": meta,
            "provenance": {"cacheSha256": sha(path), "metaSha256": sha(meta_path),
                           "featureIdentityHash": expected_identity,
                           "dataSha256": sha(data_path) if data_path else None}}


def stable_scores(head, cache):
    import torch
    head.eval()
    output = []
    with torch.inference_mode():
        # Match the historical one-presentation CPU call, avoiding changes in
        # GEMM batch layout while checking old numeric predictions.
        for index, (key, order) in enumerate(zip(cache["ids"], cache["orders"])):
            display = head(torch.from_numpy(cache["cand"][index:index + 1]))[0].tolist()
            logits = [0.0] * 4
            for position, stable_id in enumerate(ORDERS[order]):
                logits[CLASSES.index(stable_id)] = float(display[position])
            output.append({"caseId": key, "order": order, "arm": "C", "classIds": list(CLASSES),
                           "logits": logits, "prediction": CLASSES[max(range(4), key=lambda i: logits[i])]})
    return output


def visible_hash(row):
    value = row.get("visibleInput")
    if value is None and "context" in row and "playerText" in row:
        value = {"context": row["context"], "playerText": row["playerText"]}
    return digest(value) if value else None


def historical_test_sources(legacy):
    parent = Path(legacy).parent
    return [path for name in ("jev01", "jev02", "jev02r1", "jev03")
            for path in (parent / name / "data" / "test.jsonl", parent / name / "data" / "test.inputs.jsonl") if path.exists()]


def validate_increment(train, dev, legacy):
    archived_train = rows(Path(legacy) / "data" / "train.jsonl")
    archived_hashes = {visible_hash(row) for row in archived_train}
    for split, data in (("train", train), ("dev", dev)):
        archived_path = Path(legacy) / "data" / (split + ".jsonl")
        if data["provenance"]["dataSha256"] != sha(archived_path):
            meta = data["meta"]
            if meta.get("dataSha256") != data["provenance"]["dataSha256"]:
                raise ValueError("incremental cache must bind the exact new dataSha256")
            expected_inputs = [visible_hash(data["cases"][key]) for key in data["ids"]]
            if meta.get("inputHashes") != expected_inputs:
                raise ValueError("incremental cache needs per-presentation visible-input hashes; changing IDs/text alone does not produce new features")
    train_cases, dev_cases = train["cases"], dev["cases"]
    if set(train_cases) & set(dev_cases):
        raise ValueError("train/dev case IDs overlap")
    train_hashes = {visible_hash(row) for row in train_cases.values()}
    dev_hashes = {visible_hash(row) for row in dev_cases.values()}
    if None in train_hashes or None in dev_hashes or train_hashes & dev_hashes:
        raise ValueError("missing visible input or train/dev semantic overlap")
    train_groups = {row.get("groupId") for row in train_cases.values()}
    dev_groups = {row.get("groupId") for row in dev_cases.values()}
    if None in train_groups or None in dev_groups or train_groups & dev_groups:
        raise ValueError("missing source group or train/dev source overlap")
    heldout_ids, heldout_hashes = set(), set()
    for path in historical_test_sources(legacy):
        for row in rows(path):
            heldout_ids.add(row.get("caseId"))
            if visible_hash(row):
                heldout_hashes.add(visible_hash(row))
    # Historical tests remain evaluation-only, including when relabelled or renamed.
    if (set(train_cases) | set(dev_cases)) & heldout_ids or (train_hashes | dev_hashes) & heldout_hashes:
        raise ValueError("historical test inputs cannot enter train/dev or new model selection")
    return {"newSemanticCases": sum(visible_hash(row) not in archived_hashes for row in train_cases.values()),
            "trainCases": len(train_cases), "devCases": len(dev_cases),
            "historicalTestFiles": [str(path) for path in historical_test_sources(legacy)]}


def evaluate(head, data):
    import torch
    head.eval()
    correct, loss, count = 0, 0.0, 0
    with torch.inference_mode():
        for start in range(0, len(data["ids"]), 128):
            logits = head(torch.from_numpy(data["cand"][start:start + 128]))
            target = torch.from_numpy(data["labels"][start:start + 128])
            loss += float(torch.nn.functional.cross_entropy(logits, target, reduction="sum"))
            correct += int((logits.argmax(dim=-1) == target).sum())
            count += len(target)
    return {"presentations": count, "cases": len(set(data["ids"])), "nll": loss / count, "accuracy": correct / count}


def train_extension(head, train, dev, output, args, provenance):
    import torch
    from safetensors.torch import save_file
    torch.manual_seed(args.seed)
    rng = np.random.default_rng(args.seed)
    optimizer = torch.optim.AdamW(head.parameters(), lr=1e-3, weight_decay=1e-2)
    cases = sorted(set(train["ids"]))
    by_case = {key: [index for index, value in enumerate(train["ids"]) if value == key] for key in cases}
    baseline = evaluate(head, dev)
    best, best_state, selected_epoch = baseline["nll"], {key: value.detach().clone() for key, value in head.state_dict().items()}, 0
    curve = [{"epoch": 0, "dev": baseline}]
    for epoch in range(1, args.epochs + 1):
        head.train()
        order = rng.permutation(len(cases))
        losses = []
        for start in range(0, len(cases), 32):
            selected = [cases[int(index)] for index in order[start:start + 32]]
            indices = [index for key in selected for index in by_case[key]]
            logits = head(torch.from_numpy(train["cand"][indices]))
            target = torch.from_numpy(train["labels"][indices])
            # Every case has exactly four presentations, so row mean equals
            # historical equal-case mean over four orders.
            loss = torch.nn.functional.cross_entropy(logits, target)
            optimizer.zero_grad()
            loss.backward()
            torch.nn.utils.clip_grad_norm_(head.parameters(), 1.0)
            optimizer.step()
            losses.append(float(loss.detach()))
        validation = evaluate(head, dev)
        curve.append({"epoch": epoch, "trainNll": sum(losses) / len(losses), "dev": validation})
        if validation["nll"] < best - 1e-12:
            best, selected_epoch = validation["nll"], epoch
            best_state = {key: value.detach().clone() for key, value in head.state_dict().items()}
            torch.save(optimizer.state_dict(), output / "best-optimizer.pt")
        write(output / "curve.json", curve)
    head.load_state_dict(best_state)
    save_file({key: value.contiguous().cpu() for key, value in head.state_dict().items()}, str(output / "best.safetensors"))
    result = {"schema": "frostecho.jev05.legacy-extension/1", "protocol": "historical-semantic-contract/2",
              "mode": args.mode, "optimizerResumed": False, "optimizer": "new AdamW state; weights-only warm-start",
              "selectedEpoch": selected_epoch, "initDev": baseline, "finalDev": evaluate(head, dev),
              "checkpointSha256": sha(output / "best.safetensors"), "provenance": provenance,
              "config": {"seed": args.seed, "epochs": args.epochs, "lr": 1e-3, "weightDecay": 1e-2,
                         "batchGroups": 32, "fourOrders": True, "normalization": "LayerNorm eps=1e-5"},
              "newGainProven": False, "v5Qualified": False, "executionAdmitted": False,
              "note": "New held-out evaluation is required; old test remains evaluation-only. This run does not claim new calibrated action capability."}
    write(output / "result.json", result)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("verify", "train"):
        command = sub.add_parser(name)
        command.add_argument("--legacy-root", default=str(DEFAULT_LEGACY))
        command.add_argument("--init-checkpoint", required=True)
        command.add_argument("--training-record", help="defaults to archived runs/trainings.json")
        command.add_argument("--output-dir", required=True)
        if name == "verify":
            command.add_argument("--cache", required=True)
            command.add_argument("--reference-scores", required=True)
            command.add_argument("--tolerance", type=float, default=1e-5)
        else:
            command.add_argument("--train-data", required=True)
            command.add_argument("--dev-data", required=True)
            command.add_argument("--train-cache", required=True)
            command.add_argument("--dev-cache", required=True)
            command.add_argument("--mode", choices=["warm-start", "random"], default="warm-start")
            command.add_argument("--seed", type=int, default=43)
            command.add_argument("--epochs", type=int, default=20)
    args = parser.parse_args(argv)
    legacy = Path(args.legacy_root)
    record_path = args.training_record or legacy / "runs" / "trainings.json"
    record = checkpoint_record(args.init_checkpoint, record_path)
    expected_identity = record["meta"]["featureIdentityHash"]
    output = output_directory(args.output_dir, legacy)
    provenance = {"initialCheckpointSha256": sha(args.init_checkpoint), "trainingRecordSha256": sha(record_path),
                  "featureIdentityHash": expected_identity,
                  "legacyRendererSha256": sha(legacy.parent / "jev02" / "render.py"),
                  "semanticContractSha256": sha(legacy / "data" / "contract.json")}
    if args.command == "verify":
        cache = load_cache(args.cache, expected_identity)
        restored = stable_scores(make_head(args.init_checkpoint), cache)
        reference = {(row["caseId"], row["order"]): row for row in rows(args.reference_scores) if row.get("arm") == "C"}
        expected_keys = {(row["caseId"], row["order"]) for row in restored}
        if set(reference) != expected_keys:
            raise ValueError("reference and restored C case/order populations differ")
        max_error, mismatches = 0.0, 0
        for row in restored:
            old = reference[(row["caseId"], row["order"])]
            if old["classIds"] != row["classIds"]:
                raise ValueError("stable class mapping changed")
            error = max(abs(left - right) for left, right in zip(old["logits"], row["logits"]))
            max_error = max(max_error, error)
            mismatches += int(row["prediction"] != old["prediction"])
        (output / "restored-scores.jsonl").write_text("".join(canonical(row) + "\n" for row in restored), encoding="utf-8", newline="\n")
        result = {"schema": "frostecho.jev05.legacy-restore/1", "status": "pass" if max_error <= args.tolerance and mismatches == 0 else "fail",
                  "presentations": len(restored), "cases": len({row['caseId'] for row in restored}),
                  "maxAbsoluteLogitError": max_error, "bitExactLogits": max_error == 0,
                  "predictionMismatches": mismatches, "tolerance": args.tolerance,
                  "trainedNewHead": False, "newGainProven": False, "executionAdmitted": False,
                  "provenance": {**provenance, **cache["provenance"], "referenceScoresSha256": sha(args.reference_scores)}}
        write(output / "result.json", result)
        print(canonical(result))
        return 0 if result["status"] == "pass" else 3
    if not 1 <= args.epochs <= 100:
        raise ValueError("legacy training requires 1..100 epochs")
    train = load_cache(args.train_cache, expected_identity, data_path=args.train_data, expected_split="train")
    dev = load_cache(args.dev_cache, expected_identity, data_path=args.dev_data, expected_split="dev")
    increment = validate_increment(train, dev, legacy)
    provenance.update(train=train["provenance"], dev=dev["provenance"], increment=increment)
    if increment["newSemanticCases"] == 0:
        result = {"status": "restored-baseline-only", "trainedNewHead": False, "reason": "no incremental semantic training inputs",
                  "baselineDev": evaluate(make_head(args.init_checkpoint), dev), "provenance": provenance,
                  "v5Qualified": False, "newGainProven": False, "executionAdmitted": False}
        write(output / "result.json", result)
        print(canonical(result))
        return 0
    import torch
    torch.manual_seed(args.seed)
    head = make_head(args.init_checkpoint if args.mode == "warm-start" else None)
    result = train_extension(head, train, dev, output, args, provenance)
    print(canonical(result))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(canonical({"status": "failed", "errorType": type(error).__name__, "error": str(error)}), file=sys.stderr)
        raise SystemExit(2)
