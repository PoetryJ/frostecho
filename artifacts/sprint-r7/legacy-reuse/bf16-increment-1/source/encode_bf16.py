#!/usr/bin/env python3
"""Old joint-renderer C features on explicit BF16 GPU/CPU device migration.

Reads archived data/model/cache only. First checks four old TRAIN anchors in
all four orders. New cache has its own runtime identity and a compatibility
record; it never impersonates the original four-GPU feature identity.
"""
from __future__ import annotations

import argparse
import importlib.metadata
import importlib.util
import json
import os
import sys
import time
from pathlib import Path

import numpy as np

import runner as R


def module_from(path, name):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def original_renderer(legacy):
    folder = legacy.parent / "jev02"
    old = sys.modules.get("contracts")
    sys.modules["contracts"] = module_from(folder / "contracts.py", "jev05_archived_contracts")
    try:
        renderer = module_from(folder / "render.py", "jev05_archived_renderer")
    finally:
        if old is None:
            del sys.modules["contracts"]
        else:
            sys.modules["contracts"] = old
    return renderer


def as_case(row):
    visible = row.get("visibleInput") or {"context": row["context"], "playerText": row["playerText"]}
    if set(visible) != {"context", "playerText"} or not all(isinstance(visible[key], str) for key in visible):
        raise ValueError("legacy input is exactly context/playerText strings; labels never enter renderer")
    return {"caseId": row["caseId"], "visibleInput": visible}


def original_model_metadata(legacy, model_path):
    evidence = R.read(legacy / "evidence" / "model-identity.json")
    old = evidence.get("identity", evidence)["model"]
    found = {}
    for name, expected in old["files"].items():
        path = model_path / name
        actual = R.sha(path)
        if actual != expected["sha256"]:
            raise ValueError(f"model/tokenizer metadata differs from original checkpoint source: {name}")
        found[name] = {"sha256": actual, "bytes": path.stat().st_size}
    return {"files": found, "verification": "archived metadata and anchor compatibility; historical weight-shard hashes were not recorded"}


class LegacyBf16Encoder:
    def __init__(self, args, legacy, expected_identity, output):
        if not args.allow_device_migration:
            raise ValueError("this new hardware/runtime requires explicit --allow-device-migration")
        # Physical GPU0 is shared. CUDA_VISIBLE_DEVICES=1 remaps only physical
        # GPU1 to logical cuda:0; no other visible GPU is accepted by this run.
        if os.environ.get("CUDA_VISIBLE_DEVICES") != "1":
            raise ValueError("run with CUDA_VISIBLE_DEVICES=1; physical GPU0 must remain untouched")
        model_path = Path(args.model_path)
        metadata = original_model_metadata(legacy, model_path)
        self.renderer = original_renderer(legacy)
        self.max_tokens = args.max_tokens
        import torch
        from transformers import AutoModelForCausalLM, AutoTokenizer
        if torch.cuda.device_count() != 1:
            raise ValueError("exactly the authorized physical GPU1 must be visible")
        self.torch = torch
        self.tokenizer = AutoTokenizer.from_pretrained(str(model_path), local_files_only=True, trust_remote_code=False)
        started = time.monotonic()
        self.model, loading = AutoModelForCausalLM.from_pretrained(
            str(model_path), torch_dtype=torch.bfloat16, device_map="auto",
            max_memory={0: args.gpu_memory, "cpu": args.cpu_memory},
            low_cpu_mem_usage=True, offload_folder=str(output / "offload"),
            local_files_only=True, trust_remote_code=False, output_loading_info=True,
            attn_implementation="eager",
        )
        if loading.get("missing_keys") or loading.get("mismatched_keys") or loading.get("error_msgs"):
            raise ValueError(f"old model did not load fully: {loading}")
        if getattr(self.model, "is_loaded_in_4bit", False) or getattr(self.model, "is_loaded_in_8bit", False):
            raise ValueError("legacy continuation does not permit quantization")
        self.model.eval()
        for parameter in self.model.parameters():
            parameter.requires_grad_(False)
        self.base = self.model.model
        self.input_device = self.model.get_input_embeddings().weight.device
        hidden = getattr(self.model.config, "hidden_size", None)
        if hidden is None:
            hidden = getattr(getattr(self.model.config, "text_config", None), "hidden_size", None)
        if hidden != 5120:
            raise ValueError("legacy C needs the original 5120-dimensional backbone")
        self.identity = {
            "schema": "frostecho.jev05.legacy-bf16-device-migration/1",
            "legacyFeatureIdentityHash": expected_identity,
            "backboneMetadata": metadata,
            "rendererSha256": R.sha(legacy.parent / "jev02" / "render.py"),
            "renderer": "jev02/render.py", "readout": "joint-candidate-line-final-token",
            "orders": [list(order) for order in R.ORDERS], "precision": "bfloat16",
            "quantization": "none", "class": type(self.model).__name__,
            "torch": torch.__version__, "transformers": importlib.metadata.version("transformers"),
            "physicalCudaVisibleDevices": "1", "attentionImplementation": "eager",
            "deviceMap": {key: str(value) for key, value in self.model.hf_device_map.items()},
            "maxMemory": {"0": args.gpu_memory, "cpu": args.cpu_memory},
            "loadSeconds": time.monotonic() - started,
            "dimension": 5120, "batchSize": 1,
        }
        # Timing is evidence, not identity: repeated exact runtime can resume.
        identity_fields = {key: value for key, value in self.identity.items() if key != "loadSeconds"}
        self.identity_sha = R.digest(identity_fields)
        R.write(output / "runtime-identity.json", {**self.identity, "featureIdentityHash": self.identity_sha})

    def encode(self, row, order):
        built = self.renderer.rendered_chat(self.tokenizer, as_case(row), order, "label")
        if len(built["ids"]) > self.max_tokens:
            raise ValueError("legacy input exceeds --max-tokens; no silent truncation")
        ids = self.torch.tensor([built["ids"]], device=self.input_device)
        started = time.monotonic()
        with self.torch.inference_mode():
            hidden = self.base(input_ids=ids, use_cache=False, return_dict=True).last_hidden_state[0]
            cand = hidden[built["positions"]].float().cpu().numpy()
            hq = hidden[built["final"]].float().cpu().numpy()
        self.torch.cuda.synchronize()
        if cand.shape != (4, 5120) or hq.shape != (5120,) or not np.isfinite(cand).all() or not np.isfinite(hq).all():
            raise ValueError("actual backbone feature output is malformed/non-finite")
        return cand, hq, {"caseId": row["caseId"], "order": order,
                          "tokenHash": R.digest(built["ids"]), "tokensIn": len(built["ids"]),
                          "positions": built["positions"], "seconds": time.monotonic() - started,
                          "inputHash": R.visible_hash(row)}


def anchor_check(encoder, legacy, reference_cache, checkpoint, output):
    archived = R.rows(legacy / "data" / "train.jsonl")
    chosen = []
    for label in R.CLASSES:
        chosen.append(next(row for row in archived if row["labelId"] == label))
    reference = R.load_cache(reference_cache, encoder.identity["legacyFeatureIdentityHash"], expected_split="train")
    lookup = {(key, order): index for index, (key, order) in enumerate(zip(reference["ids"], reference["orders"]))}
    head = R.make_head(checkpoint)
    import torch
    records = []
    with (output / "anchor-records.jsonl").open("w", encoding="utf-8", newline="\n") as log:
        for row in chosen:
            for order in range(4):
                actual, _hq, trace = encoder.encode(row, order)
                index = lookup[(row["caseId"], order)]
                expected = reference["cand"][index]
                with torch.inference_mode():
                    old_logits = head(torch.from_numpy(expected).unsqueeze(0))[0].tolist()
                    new_logits = head(torch.from_numpy(actual).unsqueeze(0))[0].tolist()
                old_index = int(np.argmax(old_logits))
                new_index = int(np.argmax(new_logits))
                delta = actual.astype(np.float64) - expected.astype(np.float64)
                record = {**trace, "tokenMatch": trace["tokenHash"] == reference["meta"]["tokenHash"][index],
                          "featureMaxAbs": float(np.abs(delta).max()), "featureRmse": float(np.sqrt(np.mean(delta ** 2))),
                          "oldDisplayLogits": old_logits, "newDisplayLogits": new_logits,
                          "maxAbsoluteLogitError": max(abs(a - b) for a, b in zip(old_logits, new_logits)),
                          "oldPrediction": R.ORDERS[order][old_index], "newPrediction": R.ORDERS[order][new_index],
                          "predictionMatch": old_index == new_index}
                records.append(record)
                log.write(R.canonical(record) + "\n")
                log.flush()
                print(R.canonical({"phase": "anchor", "done": len(records), "of": 16, "tokenMatch": record["tokenMatch"], "predictionMatch": record["predictionMatch"]}), flush=True)
    valid = all(row["tokenMatch"] and row["predictionMatch"] for row in records)
    evidence = {"schema": "frostecho.jev05.legacy-device-compatibility/1",
                "legacyFeatureIdentityHash": encoder.identity["legacyFeatureIdentityHash"],
                "newFeatureIdentityHash": encoder.identity_sha,
                "checkpointSha256": R.sha(checkpoint), "anchorSplit": "train", "anchorCases": [row["caseId"] for row in chosen],
                "referenceCacheSha256": reference["provenance"]["cacheSha256"],
                "anchorRecordsSha256": R.sha(output / "anchor-records.jsonl"),
                "presentations": 16, "allTokenHashesEqual": all(row["tokenMatch"] for row in records),
                "predictionMismatches": sum(not row["predictionMatch"] for row in records),
                "maxAbsoluteLogitError": max(row["maxAbsoluteLogitError"] for row in records),
                "compatibleForWarmStart": valid,
                "scope": "four old training anchors across four orders; bounded migration evidence, not bitwise feature equivalence or unseen accuracy"}
    R.write(output / "compatibility.json", evidence)
    return evidence


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--legacy-root", required=True)
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--init-checkpoint", required=True)
    parser.add_argument("--reference-train-cache", required=True)
    parser.add_argument("--inputs", required=True)
    parser.add_argument("--split", choices=["train", "dev", "pending"], default="pending")
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--allow-device-migration", action="store_true")
    parser.add_argument("--gpu-memory", default="20GiB")
    parser.add_argument("--cpu-memory", default="50GiB")
    parser.add_argument("--max-tokens", type=int, default=4096)
    parser.add_argument("--anchors-only", action="store_true")
    args = parser.parse_args(argv)
    legacy = Path(args.legacy_root)
    record = R.checkpoint_record(args.init_checkpoint, legacy / "runs" / "trainings.json")
    output = R.output_directory(args.output_dir, legacy)
    input_rows = R.rows(args.inputs)
    if not input_rows or len({row["caseId"] for row in input_rows}) != len(input_rows):
        raise ValueError("inputs must have nonempty unique IDs")
    for row in input_rows:
        as_case(row)
    # Input encoding deliberately needs no labels; label reviews can proceed
    # independently. The new runtime signature never equals old 4-GPU identity.
    encoder = LegacyBf16Encoder(args, legacy, record["meta"]["featureIdentityHash"], output)
    compatibility = anchor_check(encoder, legacy, args.reference_train_cache, args.init_checkpoint, output)
    if not compatibility["compatibleForWarmStart"]:
        print(R.canonical({"status": "migration-not-compatible", "compatibility": compatibility}))
        return 3
    if args.anchors_only:
        print(R.canonical({"status": "anchors-complete", "compatibility": compatibility}))
        return 0
    cand_rows, hq_rows, traces = [], [], []
    with (output / "forward-records.jsonl").open("w", encoding="utf-8", newline="\n") as log:
        for index, row in enumerate(input_rows):
            for order in range(4):
                cand, hq, trace = encoder.encode(row, order)
                cand_rows.append(cand)
                hq_rows.append(hq)
                traces.append(trace)
                log.write(R.canonical(trace) + "\n")
                log.flush()
            # Preserve completed real feature bytes if interrupted. This first
            # implementation does not pretend an interrupted batch completed.
            if (index + 1) % 8 == 0 or index + 1 == len(input_rows):
                np.savez_compressed(output / "features-increment.npz", cand=np.stack(cand_rows), hq=np.stack(hq_rows))
                print(R.canonical({"phase": "increment", "casesDone": index + 1, "casesTotal": len(input_rows)}), flush=True)
    feature_identity = {key: value for key, value in encoder.identity.items() if key != "loadSeconds"}
    meta = {"schema": "frostecho.jev05.legacy-migrated-cache/1", "split": args.split,
            "rows": len(traces), "caseIds": [row["caseId"] for row in traces], "orderIds": [row["order"] for row in traces],
            "tokenHash": [row["tokenHash"] for row in traces], "inputHashes": [row["inputHash"] for row in traces],
            "inputFileSha256": R.sha(args.inputs), "featureIdentity": feature_identity,
            "featureIdentityHash": encoder.identity_sha, "legacyFeatureIdentityHash": record["meta"]["featureIdentityHash"],
            "compatibilityPath": "compatibility.json", "compatibilitySha256": R.sha(output / "compatibility.json"),
            "candShape": list(np.stack(cand_rows).shape), "hqShape": list(np.stack(hq_rows).shape),
            "evidenceClass": "real-model", "labelsRequiredForEncoding": False,
            "note": "new BF16 GPU1+CPU runtime; not the original four-GPU feature identity"}
    R.write(output / "features-increment.meta.json", meta)
    result = {"status": "encoded", "cases": len(input_rows), "presentations": len(traces),
              "newFeatureIdentityHash": encoder.identity_sha, "cacheSha256": R.sha(output / "features-increment.npz"),
              "metaSha256": R.sha(output / "features-increment.meta.json"), "compatibility": compatibility,
              "trainedNewHead": False}
    R.write(output / "encoding-result.json", result)
    print(R.canonical(result))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(R.canonical({"status": "failed", "errorType": type(error).__name__, "error": str(error)}), file=sys.stderr)
        raise SystemExit(2)
