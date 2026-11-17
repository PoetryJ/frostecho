"""Persistent BF16 joint-candidate corpus encoder. No training or admission.

Input JSONL rows: {caseId, split, acceptableIds, envelope, ...provenance}.
Output features.npz: cand[sum(K),5120], rowOffsets[N+1], caseIds[N],
candidateIds[sum(K)]. records.jsonl binds each slice to the original request.
Each completed batch is checksummed and journaled, so --resume skips it.
"""
from __future__ import annotations

import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import time
import traceback

import numpy as np

from joint_encoder import JointEncoder, digest_bytes, file_sha, prepare


def canonical(value):
    # HF max_memory uses integer GPU keys beside the string "cpu" key.
    # Normalize to JSON's string object keys before canonical sorting.
    value = json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def stable_sha(value):
    return digest_bytes(canonical(value).encode("utf-8"))


def atomic_bytes(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("wb") as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def atomic_json(path, value):
    atomic_bytes(path, (canonical(value) + "\n").encode("utf-8"))


def atomic_npz(path, **arrays):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".tmp")
    with temporary.open("wb") as stream:
        np.savez(stream, **arrays)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


def load_inputs(path, limit=0):
    rows, seen = [], set()
    with Path(path).open(encoding="utf-8") as stream:
        for line_number, line in enumerate(stream, 1):
            if not line.strip():
                continue
            row = json.loads(line)
            case_id, split = row.get("caseId"), row.get("split")
            if not isinstance(case_id, str) or not case_id or case_id in seen:
                raise ValueError(f"line {line_number}: caseId missing or duplicated")
            if not isinstance(split, str) or not split:
                raise ValueError(f"line {line_number}: original split required")
            envelope = row.get("envelope", row)
            candidates = [item["id"] for item in envelope["request"]["candidates"]]
            labels = row.get("acceptableIds", [])
            if (not isinstance(labels, list) or any(not isinstance(value, str) for value in labels)
                    or len(set(labels)) != len(labels) or not set(labels).issubset(candidates)):
                raise ValueError(f"line {line_number}: acceptableIds not a subset of actual candidates")
            seen.add(case_id)
            rows.append({"caseId": case_id, "split": split, "acceptableIds": labels,
                         "sourceGroup": row.get("sourceGroup", row.get("sourceFamily", row.get("episode"))),
                         "episode": row.get("episode", row.get("episodeSeed")),
                         "labelClass": row.get("labelClass", row.get("labelSource", "unspecified")),
                         "sourceFamily": row.get("sourceFamily"), "labelSource": row.get("labelSource", "unspecified"),
                         "augmentationGroup": row.get("augmentationGroup"), "scenario": row.get("scenario"),
                         "independentReviews": row.get("independentReviews", 0),
                         "researchTrainReady": row.get("researchTrainReady", False),
                         "sourceRowSha256": stable_sha(row), "inputLine": line_number,
                         "envelope": envelope})
    if not rows:
        raise ValueError("empty input corpus")
    return rows[:limit] if limit else rows


def feature_identity(encoder, args):
    return encoder.feature_identity(args.pad_multiple)


def pack_features(features, records):
    if len(features) != len(records) or not records:
        raise ValueError("feature/record count mismatch")
    offsets = [0]
    ids = []
    for feature, record in zip(features, records):
        if feature.shape != (len(record["candidateIds"]), 5120) or not np.isfinite(feature).all():
            raise ValueError("invalid candidate feature shape or nonfinite feature")
        offsets.append(offsets[-1] + feature.shape[0])
        ids.extend(record["candidateIds"])
    return {"cand": np.concatenate(features).astype(np.float32),
            "rowOffsets": np.asarray(offsets, dtype=np.int64),
            "caseIds": np.asarray([row["caseId"] for row in records], dtype=np.str_),
            "candidateIds": np.asarray(ids, dtype=np.str_)}


def checked_parts(output, progress, source_rows):
    """Check persisted bytes, request identities, and ragged slice mapping."""
    records, features = [], []
    for part in progress["parts"]:
        npz_path, jsonl_path = output / part["npz"], output / part["records"]
        if file_sha(npz_path) != part["npzSha256"] or file_sha(jsonl_path) != part["recordsSha256"]:
            raise ValueError("resume part SHA mismatch")
        batch_records = [json.loads(line) for line in jsonl_path.read_text(encoding="utf-8").splitlines()]
        with np.load(npz_path, allow_pickle=False) as cache:
            offsets = cache["rowOffsets"]
            if (len(offsets) != len(batch_records) + 1 or offsets[0] != 0
                    or offsets[-1] != len(cache["cand"]) or np.any(np.diff(offsets) <= 0)):
                raise ValueError("resume ragged offsets invalid")
            for i, record in enumerate(batch_records):
                source = source_rows[len(records)]
                begin, end = int(offsets[i]), int(offsets[i + 1])
                feature = cache["cand"][begin:end].copy()
                if (record["caseId"] != source["caseId"] or cache["caseIds"][i] != source["caseId"]
                        or record["sourceRowSha256"] != source["sourceRowSha256"]
                        or record["featureIdentityHash"] != progress["featureIdentityHash"]
                        or cache["candidateIds"][begin:end].tolist() != record["candidateIds"]
                        or digest_bytes(feature.tobytes()) != record["featureSha256"]):
                    raise ValueError("resume case mapping or identity changed")
                records.append(record)
                features.append(feature)
    if len(records) != progress["completedCases"]:
        raise ValueError("resume journal case count mismatch")
    return features, records


class ForwardJournal:
    def __init__(self, output):
        self.path = output / "forward-events.jsonl"
        self.events = [json.loads(line) for line in self.path.read_text(encoding="utf-8").splitlines()] if self.path.exists() else []

    def append(self, event):
        event = {**event, "utc": datetime.now(timezone.utc).isoformat()}
        with self.path.open("a", encoding="utf-8", newline="\n") as stream:
            stream.write(canonical(event) + "\n")
            stream.flush()
            os.fsync(stream.fileno())
        self.events.append(event)

    def forward(self, encoder, rows, stage, pad_multiple):
        call_id = sum(event["event"] == "started" for event in self.events) + 1
        self.append({"event": "started", "callId": call_id, "stage": stage,
                     "requestHashes": [row["inputSha256"] for row in rows], "batchSize": len(rows)})
        try:
            features, trace = encoder.encode_batch(rows, pad_multiple)
        except Exception as error:
            self.append({"event": "failed", "callId": call_id, "error": repr(error)})
            raise
        self.append({"event": "completed", "callId": call_id, "trace": trace})
        return features, trace

    def counts(self):
        started = {event["callId"] for event in self.events if event["event"] == "started"}
        completed = {event["callId"] for event in self.events if event["event"] == "completed"}
        failed = {event["callId"] for event in self.events if event["event"] == "failed"}
        return {"encoderForwardCalls": len(completed), "forwardCallsAttempted": len(started),
                "forwardCallsFailed": len(failed), "forwardCallsUnknownAfterInterruption": len(started - completed - failed)}


def qualify(encoder, first, args, journal, output, identity_hash):
    # Exactly two calls; the repeated row checks cross-row contamination.
    one, one_trace = journal.forward(encoder, [first], "qualification-batch1", args.pad_multiple)
    many, many_trace = journal.forward(encoder, [first] * args.batch_size, "qualification-batchN-duplicates", args.pad_multiple)
    reference, actual = one[0], many[0]
    delta = actual.astype(np.float64) - reference
    relative_l2 = float(np.linalg.norm(delta) / max(np.linalg.norm(reference), 1e-12))
    max_abs = float(np.max(np.abs(delta)))
    duplicate_max = max(float(np.max(np.abs(value - actual))) for value in many)
    ok = relative_l2 <= args.qualify_relative_l2 and max_abs <= args.qualify_max_abs and duplicate_max <= args.qualify_duplicate_abs
    result = {"schema": "frostecho.batch-qualification/1", "ok": ok, "featureIdentityHash": identity_hash,
              "relativeL2": relative_l2, "maxAbs": max_abs, "duplicateMaxAbs": duplicate_max,
              "limits": {"relativeL2": args.qualify_relative_l2, "maxAbs": args.qualify_max_abs,
                         "duplicateMaxAbs": args.qualify_duplicate_abs},
              "batch1": one_trace, "batchN": many_trace,
              "scope": "Numerical batching check on one repeated real request; no model-quality or calibration claim."}
    atomic_npz(output / "qualification-features.npz", batch1=reference, batchN=np.stack(many))
    result["featuresSha256"] = file_sha(output / "qualification-features.npz")
    atomic_json(output / "qualification.json", result)
    if not ok:
        raise ValueError("batch qualification failed; see qualification.json; bulk encoding not started")
    return result


def run(args):
    output = Path(args.out)
    output.mkdir(parents=True, exist_ok=True)
    progress_path = output / "progress.json"
    if progress_path.exists() and not args.resume:
        raise ValueError("progress exists; choose a new output or explicit --resume")
    if args.resume and not progress_path.exists():
        raise ValueError("--resume requires an existing progress.json")
    rows = load_inputs(args.inputs, args.limit)
    source = {"inputsSha256": file_sha(Path(args.inputs)), "selectedRowsSha256": stable_sha([row["sourceRowSha256"] for row in rows]),
              "selectedCases": len(rows), "limit": args.limit}
    execution = {"batchSize": args.batch_size, "padMultiple": args.pad_multiple,
                 "maxTokens": args.max_length, "placement": args.placement,
                 "runnerSourceSha256": file_sha(Path(__file__)),
                 "qualificationLimits": [args.qualify_relative_l2, args.qualify_max_abs, args.qualify_duplicate_abs]}
    progress = json.loads(progress_path.read_text(encoding="utf-8")) if args.resume else None
    if progress and progress["source"] != source:
        raise ValueError("resume source bytes or selected rows changed")
    if progress and progress["execution"] != execution:
        raise ValueError("resume execution protocol changed; start a separate cache")
    physical_gpus = [int(value.strip()) for value in args.physical_gpus.split(",")]
    os.environ["CUDA_VISIBLE_DEVICES"] = ",".join(map(str, physical_gpus))
    started = time.monotonic()
    encoder = JointEncoder(Path(args.encoder), output, placement=args.placement, physical_gpus=physical_gpus)
    identity = feature_identity(encoder, args)
    identity_hash = stable_sha(identity)
    if progress and progress["featureIdentityHash"] != identity_hash:
        raise ValueError("resume encoder/backend/placement/code identity changed; do not mix features")
    atomic_json(output / f"load-{time.time_ns()}.json", encoder.identity)
    prepared = [prepare(encoder.tokenizer, row["envelope"], args.max_length) for row in rows]
    if progress is None:
        progress = {"schema": "frostecho.joint-corpus-progress/1", "source": source,
                    "execution": execution,
                    "featureIdentityHash": identity_hash, "featureIdentity": identity,
                    "completedCases": 0, "parts": [], "qualification": None}
        atomic_json(progress_path, progress)
    features, records = checked_parts(output, progress, rows)
    journal = ForwardJournal(output)
    if progress["qualification"] is None:
        qualification = qualify(encoder, prepared[0], args, journal, output, identity_hash)
        progress["qualification"] = {"path": "qualification.json", "sha256": file_sha(output / "qualification.json"),
                                     "featuresSha256": qualification["featuresSha256"]}
        atomic_json(progress_path, progress)
    else:
        entry = progress["qualification"]
        if (file_sha(output / entry["path"]) != entry["sha256"]
                or file_sha(output / "qualification-features.npz") != entry["featuresSha256"]):
            raise ValueError("resume qualification bytes changed")
    for start in range(progress["completedCases"], len(rows), args.batch_size):
        end = min(start + args.batch_size, len(rows))
        batch_features, trace = journal.forward(encoder, prepared[start:end], f"corpus-{start}-{end}", args.pad_multiple)
        part_index = len(progress["parts"])
        part_stem = f"parts/batch-{part_index:06d}"
        row_start = sum(len(record["candidateIds"]) for record in records)
        batch_records = []
        for original, row_trace, value in zip(rows[start:end], trace["rows"], batch_features):
            record = {**{key: value for key, value in original.items() if key != "envelope"},
                      **row_trace, "featureIdentityHash": identity_hash,
                      "rowStart": row_start, "rowEnd": row_start + len(row_trace["candidateIds"]),
                      "part": part_stem + ".npz", "realEncoder": True, "countsAsAdmitted": False}
            row_start = record["rowEnd"]
            batch_records.append(record)
        atomic_npz(output / (part_stem + ".npz"), **pack_features(batch_features, batch_records))
        atomic_bytes(output / (part_stem + ".jsonl"), ("\n".join(map(canonical, batch_records)) + "\n").encode("utf-8"))
        progress["parts"].append({"npz": part_stem + ".npz", "records": part_stem + ".jsonl",
                                  "npzSha256": file_sha(output / (part_stem + ".npz")),
                                  "recordsSha256": file_sha(output / (part_stem + ".jsonl")),
                                  "start": start, "end": end, "trace": trace})
        progress["completedCases"] = end
        atomic_json(progress_path, progress)
        features.extend(batch_features)
        records.extend(batch_records)
        print(canonical({"event": "batch-committed", "completedCases": end, "totalCases": len(rows),
                         "batchSeconds": trace["forwardSeconds"], **journal.counts()}), flush=True)
    atomic_npz(output / "features.npz", **pack_features(features, records))
    atomic_bytes(output / "records.jsonl", ("\n".join(map(canonical, records)) + "\n").encode("utf-8"))
    counts = {split: sum(record["split"] == split for record in records) for split in sorted({record["split"] for record in records})}
    metadata = {"schema": "frostecho.joint-corpus-cache/1", "status": "complete",
                "source": source, "featureIdentityHash": identity_hash, "featureIdentity": identity,
                "execution": execution,
                "recordsSha256": file_sha(output / "records.jsonl"), "cacheSha256": file_sha(output / "features.npz"),
                "cases": len(records), "candidateRows": sum(len(record["candidateIds"]) for record in records),
                "counts": counts, **journal.counts(), "wallSecondsThisInvocation": time.monotonic() - started,
                "qualification": progress["qualification"], "realEncoder": True, "countsAsAdmitted": False,
                "labelScope": "Input labels copied with provenance; encoding supplies no independent label review or risk certificate."}
    atomic_json(output / "metadata.json", metadata)
    print(canonical({"event": "complete", "cases": len(records), "counts": counts,
                     "featureIdentityHash": identity_hash, **journal.counts()}), flush=True)
    return metadata


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--inputs", "--requests", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--encoder", required=True)
    parser.add_argument("--physical-gpus", default="0,1")
    parser.add_argument("--placement", choices=("auto", "one-layer-offload"), default="auto")
    parser.add_argument("--batch-size", type=int, choices=(1, 2, 4), default=2)
    parser.add_argument("--max-length", type=int, default=2048)
    parser.add_argument("--pad-multiple", type=int, default=8)
    parser.add_argument("--limit", type=int, default=0)
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--qualify-relative-l2", type=float, default=0.02)
    parser.add_argument("--qualify-max-abs", type=float, default=1.0)
    parser.add_argument("--qualify-duplicate-abs", type=float, default=0.001)
    args = parser.parse_args()
    if args.limit < 0 or args.max_length < 1 or args.pad_multiple < 1:
        parser.error("limit must be nonnegative and token/padding bounds positive")
    if any(not np.isfinite(value) or value < 0 for value in
           (args.qualify_relative_l2, args.qualify_max_abs, args.qualify_duplicate_abs)):
        parser.error("qualification thresholds must be finite and nonnegative")
    try:
        run(args)
    except Exception as error:
        output = Path(args.out)
        output.mkdir(parents=True, exist_ok=True)
        atomic_json(output / f"failure-{time.time_ns()}.json", {"error": repr(error), "traceback": traceback.format_exc(),
                                                               "realEncoderResult": False})
        traceback.print_exc()
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
