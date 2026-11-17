#!/usr/bin/env python3
"""Real model encode -> qualified head train -> batch/online raw scoring."""
from __future__ import annotations

import argparse
import json
import sys
import time
from pathlib import Path

import numpy as np

from contracts import RENDERER, canonical, digest, file_sha, qualify, read_json, read_jsonl, render_candidates, validate_case, write_json
from cache import encode_cache, load_cache
from head import load_checkpoint, score_features, softmax, train_model


def qwen_arguments(parser):
    parser.add_argument("--model-path", required=True)
    parser.add_argument("--model-id", required=True, choices=["Qwen/Qwen3.5-4B", "Qwen/Qwen3.5-27B"])
    parser.add_argument("--revision", required=True)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--dtype", default="auto", choices=["auto", "float32", "float16", "bfloat16"])
    parser.add_argument("--max-tokens", type=int, default=4096)
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--pooling", default="last-token", choices=["last-token", "masked-mean"])
    parser.add_argument("--load-in-4bit", action="store_true")
    parser.add_argument("--identity-mode", default="full", choices=["full", "probe"],
                        help="probe skips weight-byte hashing, cannot train/serve a real checkpoint")
    parser.add_argument("--max-memory", help='JSON device memory limits, e.g. {"0":"22GiB","1":"22GiB"}')


def encoder_from_args(args):
    from encoder import QwenEncoder
    return QwenEncoder(args.model_path, model_id=args.model_id, revision=args.revision,
                       device=args.device, dtype=args.dtype, max_tokens=args.max_tokens,
                       pooling=args.pooling, batch_size=args.batch_size,
                       load_in_4bit=args.load_in_4bit,
                       max_memory=json.loads(args.max_memory) if args.max_memory else None,
                       identity_mode=args.identity_mode)


def bound_encoder(checkpoint, encoder):
    if checkpoint.get("encoderSha256") != encoder.identity["encoderSha256"]:
        raise ValueError("runtime encoder/weights/tokenizer/renderer differs from trained checkpoint")


def scored_row(case, values, checkpoint, weights, *, token_lengths=None):
    validate_case(case)
    if checkpoint.get("evidenceClass") != "real-model":
        raise ValueError("production scorer refuses mechanism/unit-test checkpoints")
    if values.shape != (len(case["candidates"]), len(weights)):
        raise ValueError("candidate feature shape differs from checkpoint")
    logits = score_features(weights, values).astype(float).tolist()
    return {"schema": "frostecho.jev05.raw-score/1", "caseId": case["caseId"],
            "contentHash": validate_case(case), "candidateIds": [item["id"] for item in case["candidates"]],
            "rawLogits": logits, "uncalibratedProbabilities": softmax(logits).tolist(),
            "checkpointSha256": checkpoint["checkpointSha256"], "encoderSha256": checkpoint["encoderSha256"],
            "evidenceClass": "real-model", "selectedId": None, "executionAdmitted": False,
            "note": "raw real model score; calibrated acceptance belongs to the separate admission policy",
            "tokenLengths": token_lengths}


class RecordedEmbeddingEncoder:
    """Compatibility import for recorded real API responses; no API calls here.

    This is separately identified, never named Qwen4B/27B. The primary R7 arm
    is Qwen. Recorded requests must exactly contain this renderer's texts.
    """
    def __init__(self, records_path, *, model_id, revision):
        rows = read_jsonl(records_path)
        self.rows = {}
        dimensions = set()
        for row in rows:
            if row["caseId"] in self.rows:
                raise ValueError("duplicate recorded embedding case")
            if row.get("request", {}).get("model") != model_id or not isinstance(row.get("response", {}).get("data"), list):
                raise ValueError("recorded API model/request/response absent")
            data = sorted(row["response"]["data"], key=lambda item: item["index"])
            if [item["index"] for item in data] != list(range(len(data))):
                raise ValueError("recorded embedding response indices invalid")
            matrix = np.asarray([item["embedding"] for item in data], dtype=np.float32)
            if matrix.ndim != 2 or not np.isfinite(matrix).all():
                raise ValueError("recorded API embedding invalid")
            dimensions.add(matrix.shape[1])
            self.rows[row["caseId"]] = (row, matrix)
        if len(dimensions) != 1:
            raise ValueError("embedding dimensions drifted or no records")
        self.dimension = dimensions.pop()
        self.identity = {"schema": "frostecho.jev05.encoder/1", "backend": "api-embedding",
                         "evidenceClass": "real-model", "model": model_id, "revision": revision or "unknown/unversioned",
                         "renderer": RENDERER, "pooling": "provider-embedding", "dimension": self.dimension,
                         "recordedResponsesSha256": file_sha(records_path),
                         "versionVerified": bool(revision and revision != "unknown/unversioned")}
        self.identity["encoderSha256"] = digest(self.identity)

    def encode_case(self, case):
        row, matrix = self.rows[case["caseId"]]
        if row["request"].get("input") != render_candidates(case):
            raise ValueError("recorded embedding request differs from full context/candidate input")
        return matrix, [None] * len(matrix)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    validate = commands.add_parser("validate-data")
    validate.add_argument("--qualification", required=True)
    validate.add_argument("--external-validator-argv", help="JSON argv array; manifest path appended, shell=False")
    encode = commands.add_parser("encode")
    encode.add_argument("--cases", required=True)
    encode.add_argument("--out", required=True)
    qwen_arguments(encode)
    imported = commands.add_parser("import-embeddings")
    imported.add_argument("--cases", required=True)
    imported.add_argument("--records", required=True)
    imported.add_argument("--out", required=True)
    imported.add_argument("--model-id", required=True)
    imported.add_argument("--revision", default="unknown/unversioned")
    train = commands.add_parser("train")
    train.add_argument("--qualification", required=True)
    train.add_argument("--cache", required=True)
    train.add_argument("--out", required=True)
    train.add_argument("--epochs", type=int, default=30)
    train.add_argument("--batch-size", type=int, default=32)
    train.add_argument("--lr", type=float, default=0.03)
    train.add_argument("--weight-decay", type=float, default=0.001)
    train.add_argument("--seed", type=int, default=17)
    train.add_argument("--device", default="cpu")
    train.add_argument("--external-validator-argv")
    score = commands.add_parser("score")
    score.add_argument("--checkpoint", required=True)
    score.add_argument("--cache", required=True)
    score.add_argument("--cases", required=True)
    score.add_argument("--out", required=True)
    for name in ("score-live", "serve"):
        online = commands.add_parser(name)
        online.add_argument("--checkpoint", required=True)
        if name == "score-live":
            online.add_argument("--cases", required=True)
            online.add_argument("--out", required=True)
        qwen_arguments(online)
    args = parser.parse_args(argv)
    started = time.monotonic()
    if args.command in ("validate-data", "train"):
        external = json.loads(args.external_validator_argv) if args.external_validator_argv else None
        qualification, cases = qualify(args.qualification, external_validator=external)
        if args.command == "validate-data":
            print(canonical(qualification))
            return 0
        cache, features = load_cache(args.cache, cases=cases)
        if cache["casesSha256"] != qualification["casesSha256"]:
            raise ValueError("feature cache is not from the qualified case file bytes")
        report = train_model(cases, features, args.out, {
            "evidenceClass": "real-model", "qualification": qualification,
            "encoder": cache["encoder"], "encoderSha256": cache["encoderSha256"],
            "cacheSha256": cache["cacheSha256"],
        }, epochs=args.epochs, batch_size=args.batch_size, lr=args.lr,
            weight_decay=args.weight_decay, seed=args.seed, device=args.device)
        print(canonical(report))
        return 0
    if args.command in ("encode", "import-embeddings"):
        encoder = (encoder_from_args(args) if args.command == "encode" else
                   RecordedEmbeddingEncoder(args.records, model_id=args.model_id, revision=args.revision))
        manifest = encode_cache(args.cases, args.out, encoder)
        print(canonical({"cacheSha256": manifest["cacheSha256"], "cases": len(manifest["records"]),
                         "encoderSha256": manifest["encoderSha256"], "elapsedSeconds": time.monotonic() - started}))
        return 0
    checkpoint, weights = load_checkpoint(args.checkpoint)
    if checkpoint.get("evidenceClass") != "real-model":
        raise ValueError("production scoring refuses non-real checkpoint")
    if args.command == "score":
        cases = {case["caseId"]: case for case in read_jsonl(args.cases)}
        cache, features = load_cache(args.cache, cases=cases)
        if cache["encoderSha256"] != checkpoint.get("encoderSha256"):
            raise ValueError("scoring cache encoder differs from trained encoder")
        rows = [scored_row(case, features[key], checkpoint, weights) for key, case in cases.items()]
    else:
        encoder = encoder_from_args(args)
        bound_encoder(checkpoint, encoder)
        if args.command == "serve":
            print(canonical({"event": "ready", "checkpointSha256": checkpoint["checkpointSha256"]}), file=sys.stderr, flush=True)
            for line in sys.stdin:
                request = None
                try:
                    request = json.loads(line)
                    case = request.get("case", request)
                    values, lengths = encoder.encode_case(case)
                    result = scored_row(case, values, checkpoint, weights, token_lengths=lengths)
                    result["requestId"] = request.get("requestId")
                except Exception as error:
                    result = {"error": str(error), "selectedId": None, "executionAdmitted": False,
                              "requestId": request.get("requestId") if isinstance(request, dict) else None}
                print(canonical(result), flush=True)
            return 0
        rows = []
        for case in read_jsonl(args.cases):
            values, lengths = encoder.encode_case(case)
            rows.append(scored_row(case, values, checkpoint, weights, token_lengths=lengths))
    target = Path(args.out)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text("".join(canonical(row) + "\n" for row in rows), encoding="utf-8", newline="\n")
    print(canonical({"rows": len(rows), "out": str(target), "sha256": file_sha(target),
                     "elapsedSeconds": time.monotonic() - started}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(canonical({"status": "failed", "errorType": type(exc).__name__, "error": str(exc)}), file=sys.stderr)
        raise SystemExit(2)
