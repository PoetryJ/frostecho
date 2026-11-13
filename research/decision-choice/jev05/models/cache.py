"""Resumable candidate feature caches with byte/content/encoder binding."""
from __future__ import annotations

from pathlib import Path
import numpy as np

from contracts import canonical, digest, file_sha, read_json, read_jsonl, validate_case, write_json


def encode_cache(cases_path, output, encoder):
    cases = read_jsonl(cases_path)
    ids = [case.get("caseId") for case in cases]
    if len(ids) != len(set(ids)) or not cases:
        raise ValueError("case IDs must be unique and nonempty")
    for case in cases:
        validate_case(case)
    root = Path(output)
    root.mkdir(parents=True, exist_ok=True)
    binding = {"casesSha256": file_sha(cases_path), "encoderSha256": encoder.identity["encoderSha256"]}
    progress_file = root / "progress.json"
    if progress_file.exists():
        progress = read_json(progress_file)
        if progress.get("binding") != binding:
            raise ValueError("existing cache belongs to different inputs/model; choose a new output path")
    else:
        progress = {"binding": binding, "records": []}
    completed = progress["records"]
    if len(completed) > len(cases):
        raise ValueError("corrupt cache progress")
    for index, case in enumerate(cases):
        path = root / f"features-{index:06d}.npy"
        if index < len(completed):
            record = completed[index]
            if record["caseId"] != case["caseId"] or record["contentHash"] != validate_case(case) or file_sha(path) != record["featuresSha256"]:
                raise ValueError(f"cache resume mismatch at {case['caseId']}")
            continue
        features, lengths = encoder.encode_case(case)
        features = np.asarray(features, dtype=np.float32)
        if features.shape != (len(case["candidates"]), encoder.dimension) or not np.isfinite(features).all():
            raise ValueError("encoder output shape/values invalid")
        with path.with_suffix(".tmp").open("wb") as handle:
            np.save(handle, features, allow_pickle=False)
        path.with_suffix(".tmp").replace(path)
        record = {"caseId": case["caseId"], "contentHash": validate_case(case),
                  "candidateIds": [item["id"] for item in case["candidates"]],
                  "path": path.name, "featuresSha256": file_sha(path), "tokenLengths": lengths,
                  "truncated": False, "split": case.get("split"), "sourceGroup": case.get("sourceGroup")}
        completed.append(record)
        if len(completed) % 16 == 0 or len(completed) == len(cases):
            write_json(progress_file, progress)
    manifest = {"schema": "frostecho.jev05.feature-cache/1", **binding,
                "encoder": encoder.identity, "dimension": encoder.dimension, "records": completed}
    manifest["cacheSha256"] = digest(manifest)
    write_json(root / "manifest.json", manifest)
    return manifest


def load_cache(root, *, cases=None, require_real=True):
    root = Path(root)
    manifest = read_json(root / "manifest.json")
    frozen = dict(manifest)
    claimed = frozen.pop("cacheSha256", None)
    if claimed != digest(frozen) or manifest.get("schema") != "frostecho.jev05.feature-cache/1":
        raise ValueError("cache manifest hash/schema mismatch")
    encoder = manifest["encoder"]
    identity_copy = dict(encoder)
    encoder_sha = identity_copy.pop("encoderSha256", None)
    if encoder_sha != digest(identity_copy) or manifest.get("encoderSha256") != encoder_sha:
        raise ValueError("encoder identity hash mismatch")
    if require_real and (encoder.get("evidenceClass") != "real-model" or encoder.get("backend") not in ("qwen-frozen", "api-embedding")):
        raise ValueError("training/scoring requires real encoded features")
    features = {}
    for record in manifest["records"]:
        case_id = record["caseId"]
        if case_id in features:
            raise ValueError("duplicate cached case")
        path = root / record["path"]
        if file_sha(path) != record["featuresSha256"]:
            raise ValueError(f"{case_id}: feature bytes changed")
        values = np.load(path, allow_pickle=False)
        if values.shape != (len(record["candidateIds"]), manifest["dimension"]) or not np.isfinite(values).all():
            raise ValueError(f"{case_id}: invalid feature matrix")
        if cases is not None:
            case = cases.get(case_id)
            if case is None or record["contentHash"] != validate_case(case) or record["candidateIds"] != [item["id"] for item in case["candidates"]]:
                raise ValueError(f"{case_id}: cached input does not match qualified input")
        features[case_id] = values.astype(np.float32, copy=False)
    if cases is not None and set(features) != set(cases):
        raise ValueError("cache and qualified case IDs differ")
    return manifest, features
