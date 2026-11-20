#!/usr/bin/env python3
"""Persistent real joint-C scorer. JSONL only on stdout; diagnostics on stderr.

Weak-reference trained heads remain experimental. Admission requires recomputed
per-sample calibration and a separately supplied trusted SHA/runtime identity.
"""
from __future__ import annotations

import argparse
import contextlib
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import sys
import time

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
CONTRACT_DIR = HERE.parents[1] / "r11"
if str(CONTRACT_DIR) not in sys.path:
    sys.path.insert(0, str(CONTRACT_DIR))
from joint_encoder import JointEncoder, ROOT, file_sha, prepare
import manifest_contract

HEAD = ROOT / "artifacts/sprint-r7/legacy-reuse/c43-increment-batch4-1/warm-start-17/best.safetensors"
ENCODER = Path("/data2/model_weights/Qwen3.8-27B")
EPS = 1e-5
RENDERER = "joint-c-action/2"
ENCODER_SOURCE = HERE / "joint_encoder.py"


def canonical(value):
    # Runtime memory plans contain integer logical GPU keys and the "cpu" key.
    clean = json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    return json.dumps(clean, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def stable_sha(value):
    return sha256_bytes(canonical(value).encode("utf-8"))


def log(value):
    print(canonical(value) if isinstance(value, dict) else value, file=sys.stderr, flush=True)


@contextlib.contextmanager
def diagnostics_to_stderr():
    """Redirect Python and native loader writes; reserve stdout for JSONL."""
    saved_fd = None
    try:
        sys.stdout.flush()
        stdout_fd, stderr_fd = sys.stdout.fileno(), sys.stderr.fileno()
        saved_fd = os.dup(stdout_fd)
        os.dup2(stderr_fd, stdout_fd)
    except (AttributeError, OSError, ValueError):
        if saved_fd is not None:
            os.close(saved_fd)
        saved_fd = None
    try:
        with contextlib.redirect_stdout(sys.stderr):
            yield
    finally:
        if saved_fd is not None:
            sys.stderr.flush()
            os.dup2(saved_fd, stdout_fd)
            os.close(saved_fd)


def load_head(path: Path) -> np.ndarray:
    from safetensors.numpy import load_file
    tensors = load_file(str(path))
    if set(tensors) != {"score.weight"} or tensors["score.weight"].shape != (1, 5120):
        raise ValueError("head must be exactly one bias-free score.weight[1,5120]")
    weights = tensors["score.weight"].reshape(-1).astype(np.float32)
    if not np.isfinite(weights).all():
        raise ValueError("nonfinite joint-C head")
    return weights


def normalized(features: np.ndarray) -> np.ndarray:
    values = np.asarray(features, dtype=np.float32)
    centered = values - values.mean(axis=-1, keepdims=True)
    return centered / np.sqrt(np.mean(centered ** 2, axis=-1, keepdims=True) + EPS)


def validate_policy_numbers(temperature, tau):
    if type(temperature) not in (int, float) or not math.isfinite(temperature) or temperature <= 0:
        raise ValueError("temperature must be finite and strictly positive")
    if type(tau) not in (int, float) or not math.isfinite(tau) or not 0 <= tau <= 1:
        raise ValueError("tau must be finite in [0,1]")


def score_features(features, weights, temperature, tau):
    validate_policy_numbers(temperature, tau)
    if features.ndim != 2 or features.shape[1] != 5120 or not 2 <= features.shape[0] <= 8:
        raise ValueError("invalid candidate feature shape")
    if not np.isfinite(features).all() or not np.isfinite(weights).all():
        raise ValueError("nonfinite features or head")
    logits = (normalized(features) @ weights).astype(np.float64)
    scaled = logits / temperature
    if not np.isfinite(scaled).all():
        raise ValueError("nonfinite scaled logits")
    shifted = np.exp(scaled - scaled.max())
    probabilities = shifted / shifted.sum()
    best = int(np.argmax(probabilities))
    return logits, probabilities, best, bool(probabilities[best] >= tau)


def validate_training_manifest(path, head_sha, *, head_path=None, features_dir=None,
                               memory=None):
    """One shared, versioned contract. Missing/tampered manifests raise here,
    before `load_head` or the encoder is touched."""
    return manifest_contract.validate(
        Path(path), Path(head_path) if head_path is not None else None,
        head_sha=head_sha, renderer_source=ROOT / "src/r7/jev/render.ts",
        encoder_source=ENCODER_SOURCE, memory=memory, features_dir=features_dir)


def load_training_manifest(path, head_sha, *, head_path=None, features_dir=None,
                           memory=None):
    """Validate, then return the raw document (kept for existing callers/tests)."""
    if path is None:
        return None
    validate_training_manifest(path, head_sha, head_path=head_path,
                               features_dir=features_dir, memory=memory)
    return json.loads(Path(path).read_text(encoding="utf-8"))


def calibration_policy():
    directory = HERE.parent / "calibration"
    if str(directory) not in sys.path:
        sys.path.insert(0, str(directory))
    spec = importlib.util.spec_from_file_location("joint_runtime_calibration_policy", directory / "policy.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def read_certificate(path, *, trusted_artifact_sha=None, expected_identity=None):
    """Recompute sealed statistics; a self-declared file is insufficient."""
    if path is None or trusted_artifact_sha is None or expected_identity is None:
        raise ValueError("admission requires certificate, out-of-band trusted SHA, and expected runtime identity")
    if (not isinstance(trusted_artifact_sha, str) or len(trusted_artifact_sha) != 64
            or any(char not in "0123456789abcdef" for char in trusted_artifact_sha)):
        raise ValueError("invalid trusted calibration artifact SHA")
    loaded = calibration_policy().load_calibration(path, expected_artifact_sha=trusted_artifact_sha,
                                                   expected_identity=expected_identity)
    if loaded.get("executionAdmitted") is not True:
        raise ValueError("calibration did not admit execution: " + str(loaded.get("reason")))
    return loaded


class EvidenceWriter:
    def __init__(self, output):
        self.directory = None
        if output is not None:
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S")
            self.directory = Path(output) / f"session-{stamp}-{os.getpid()}-{time.time_ns()}"
            self.directory.mkdir(parents=True, exist_ok=False)

    def write_json(self, name, value):
        if self.directory is not None:
            (self.directory / name).write_text(canonical(value) + "\n", encoding="utf-8", newline="\n")

    def request(self, index, raw):
        if self.directory is not None:
            (self.directory / f"{index:06d}.request.json").write_text(raw + "\n", encoding="utf-8", newline="\n")

    def features(self, index, features, ids):
        if self.directory is None:
            return None
        path = self.directory / f"{index:06d}.features.npz"
        np.savez(path, cand=features, candidateIds=np.asarray(ids, dtype=np.str_))
        return {"path": path.name, "sha256": file_sha(path)}


def build_parser():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--encoder", type=Path, default=ENCODER)
    parser.add_argument("--head", type=Path, default=HEAD)
    parser.add_argument("--training-manifest", type=Path)
    parser.add_argument("--physical-gpus", default=None, help="physical indices, e.g. 0,1")
    parser.add_argument("--physical-gpu", type=int, default=1, help="legacy single-GPU option")
    parser.add_argument("--placement", default="auto", choices=["auto", "one-layer-offload"])
    parser.add_argument("--max-length", type=int, default=2048)
    parser.add_argument("--temperature", type=float, default=None)
    parser.add_argument("--tau", type=float, default=None)
    parser.add_argument("--memory-policy", default="conditional-experience")
    parser.add_argument("--memory-selection", default="obligation-first")
    parser.add_argument("--memory-token-budget", type=int, default=640)
    parser.add_argument("--features-dir", type=Path,
                        help="optional feature cache whose bytes the manifest must also match")
    parser.add_argument("--diagnostic-unbound", action="store_true",
                        help="score without a manifest; never selects an action")
    parser.add_argument("--mode", default="jev-experimental", choices=["jev-experimental", "jev-admitted"])
    parser.add_argument("--certificate", type=Path)
    parser.add_argument("--trusted-artifact-sha")
    parser.add_argument("--expected-identity", type=Path)
    parser.add_argument("--output-dir", type=Path)
    return parser


def run(args):
    # This precedes safetensors/transformers/Torch imports.
    physical = [int(value.strip()) for value in args.physical_gpus.split(",")] if args.physical_gpus else [args.physical_gpu]
    if not physical or len(set(physical)) != len(physical) or min(physical) < 0:
        raise ValueError("physical GPUs must be unique nonnegative indices")
    os.environ["CUDA_VISIBLE_DEVICES"] = ",".join(map(str, physical))
    if (args.max_length < 1 or not args.memory_policy or not args.memory_selection
            or args.memory_token_budget < 1):
        raise ValueError("positive token budget, a memory policy, a selection and a budget are required")
    temperature = args.temperature if args.temperature is not None else 1.0
    tau = args.tau if args.tau is not None else 0.0
    validate_policy_numbers(temperature, tau)
    admitted = args.mode == "jev-admitted"
    bound = args.training_manifest is not None
    if args.diagnostic_unbound and bound:
        raise ValueError("--diagnostic-unbound cannot be combined with --training-manifest")
    if admitted and args.diagnostic_unbound:
        raise ValueError("an unbound diagnostic cannot admit execution")
    if admitted and (args.certificate is None or not args.trusted_artifact_sha or args.expected_identity is None):
        raise ValueError("admitted mode requires --certificate, --trusted-artifact-sha and --expected-identity")
    if admitted and bound:
        raise ValueError("weak-reference training manifest cannot admit execution")
    if not admitted and not bound and not args.diagnostic_unbound:
        raise ValueError("a --training-manifest is required; --diagnostic-unbound is the only unbound mode")
    if not Path(args.head).exists():
        raise ValueError(f"head {args.head} does not exist")
    head_sha = file_sha(args.head)
    manifest = validate_training_manifest(
        args.training_manifest, head_sha, head_path=args.head,
        features_dir=args.features_dir,
        memory={"policy": args.memory_policy, "selection": args.memory_selection,
                "tokenBudget": args.memory_token_budget}) if bound else None
    if manifest and manifest["memory"] and manifest["memory"].get("renderer") not in (None, RENDERER):
        raise ValueError("manifest memory renderer differs from the loaded renderer")
    expected = json.loads(args.expected_identity.read_text(encoding="utf-8")) if admitted else None
    loaded = read_certificate(args.certificate, trusted_artifact_sha=args.trusted_artifact_sha,
                              expected_identity=expected) if admitted else None
    if admitted:
        for key, value in {"checkpointSha256": head_sha, "renderer": RENDERER,
                           "memoryPolicyVersion": args.memory_policy}.items():
            if expected.get(key) != value:
                raise ValueError("runtime calibration identity mismatch: " + key)
        artifact = loaded["artifact"]
        if ((args.temperature is not None and args.temperature != artifact["temperature"])
                or (args.tau is not None and args.tau != artifact["tau"])):
            raise ValueError("runtime T/tau override differs from recomputed certificate")
        temperature, tau = artifact["temperature"], artifact["tau"]
        validate_policy_numbers(temperature, tau)
    evidence = EvidenceWriter(args.output_dir)
    work = evidence.directory or ROOT / "artifacts/r8-live-joint"
    with diagnostics_to_stderr():
        weights = load_head(args.head)
        encoder = JointEncoder(args.encoder, work, placement=args.placement, physical_gpus=physical)
    feature_identity = encoder.feature_identity(pad_multiple=8)
    feature_hash = stable_sha(feature_identity)
    if manifest and (manifest["featureIdentityHash"] != feature_hash or manifest["featureIdentity"] != feature_identity):
        raise ValueError("online encoder/backend/placement differs from the selected training features")
    if admitted and expected.get("encoderSha256") != feature_hash:
        raise ValueError("runtime calibration encoder identity mismatch")
    identity = {"scorerId": "jev-joint-c/1", "mode": args.mode, "bound": bound,
                "encoderId": str(args.encoder),
                "headSha256": head_sha, "rendererId": RENDERER, "memoryPolicyId": args.memory_policy,
                "memorySelection": args.memory_selection,
                "memoryTokenBudget": args.memory_token_budget,
                "temperature": temperature, "tau": tau, "featureIdentityHash": feature_hash,
                "certificateSha256": loaded["artifact"]["artifactSha256"] if admitted else None,
                "trainingManifestSha256": manifest["sha256"] if manifest else None,
                "manifestSha256": manifest["sha256"] if manifest else None,
                "manifestContractVersion": manifest["contractVersion"] if manifest else None,
                "manifestSchema": manifest["schema"] if manifest else None,
                "experimental": not admitted, "countsAsAdmitted": admitted,
                "labelSource": manifest["labelSource"] if manifest else None,
                "labelRule": manifest["labelRule"] if manifest else None,
                "deadlineProtocol": manifest["deadlineProtocol"] if manifest else None,
                "independentReviews": manifest.get("independentReviews") if manifest else None,
                "realModel": True, "utility": None}
    if not bound:
        identity["diagnosticUnbound"] = True
    startup = {"event": "ready", "identity": identity, "featureIdentity": feature_identity,
               "encoder": encoder.identity, "serveSourceSha256": file_sha(Path(__file__)),
               "evidenceDirectory": str(evidence.directory) if evidence.directory else None}
    evidence.write_json("startup.json", startup)
    log(startup)
    counts = {"requestsReceived": 0, "scoresSucceeded": 0, "requestsFailed": 0,
              "encoderForwardCalls": 0, "encoderForwardAttempts": 0}
    for line in sys.stdin:
        raw = line.rstrip("\r\n")
        if not raw.strip():
            continue
        counts["requestsReceived"] += 1
        index = counts["requestsReceived"]
        started = time.monotonic()
        envelope, trace = None, None
        evidence.request(index, raw)
        try:
            envelope = json.loads(raw, parse_constant=lambda value: (_ for _ in ()).throw(ValueError("nonfinite JSON: " + value)))
            request = envelope["request"]
            if any(not isinstance(request.get(key), str) or not request[key]
                   for key in ("requestId", "candidateSetHash")):
                raise ValueError("requestId and candidateSetHash must be nonempty strings")
            if request.get("memoryPolicyVersion") != args.memory_policy:
                raise ValueError("request memoryPolicyVersion differs from the loaded policy")
            if envelope["rendered"].get("rendererId") != RENDERER:
                raise ValueError("request renderer differs from the loaded policy")
            prepared = prepare(encoder.tokenizer, envelope, args.max_length)
            counts["encoderForwardAttempts"] += 1
            with diagnostics_to_stderr():
                values, trace = encoder.encode_batch([prepared], 8)
            counts["encoderForwardCalls"] += 1
            # Keep the old single-request trace fields for existing replay tools,
            # alongside the full batching/VRAM evidence.
            trace = {**trace["rows"][0], **trace}
            vectors = values[0]
            logits, probabilities, best, accept = score_features(vectors, weights, temperature, tau)
            selected = prepared["candidateIds"][best] if accept else None
            if admitted:
                decision = calibration_policy().predict(logits.tolist(), prepared["candidateIds"], loaded,
                                                        identity=expected, content_hash=prepared["inputSha256"])
                probabilities = np.asarray(decision["probabilities"])
                selected, accept = decision["selectedId"], decision["disposition"] == "accept"
            if not bound:
                # Diagnostic evidence only: an unbound run never executes an action.
                selected, accept = None, False
            feature_evidence = evidence.features(index, vectors, prepared["candidateIds"])
            reason = (f"diagnostic-unbound: pmax={float(probabilities[best]):.6f}; no action executed"
                      if not bound else
                      f"joint-C pmax={float(probabilities[best]):.6f}, T={temperature}, tau={tau}")
            result = {"requestId": request["requestId"], "candidateSetHash": request["candidateSetHash"],
                      "inputSha256": envelope["inputSha256"],
                      "scores": [{"candidateId": candidate_id, "logit": float(logits[i]), "probability": float(probabilities[i])}
                                 for i, candidate_id in enumerate(prepared["candidateIds"])],
                      "selectedId": selected, "disposition": "accept" if accept else "abstain",
                      "reason": reason,
                      "bound": bound,
                      "manifestSha256": identity["manifestSha256"],
                      "identity": {**identity, **counts}, "encoder": trace, "utility": None,
                      "featureEvidence": feature_evidence,
                      "latencyMs": round((time.monotonic() - started) * 1000, 3)}
            counts["scoresSucceeded"] += 1
            result["identity"] = {**identity, **counts}
        except Exception as error:
            counts["requestsFailed"] += 1
            request = envelope.get("request", {}) if isinstance(envelope, dict) else {}
            if not isinstance(request, dict):
                request = {}
            result = {"requestId": request.get("requestId"), "candidateSetHash": request.get("candidateSetHash"),
                      "inputSha256": envelope.get("inputSha256") if isinstance(envelope, dict) else None,
                      "error": f"{type(error).__name__}: {error}", "selectedId": None,
                      "disposition": "error", "scores": [], "identity": {**identity, **counts},
                      "bound": bound, "manifestSha256": identity["manifestSha256"],
                      "encoder": trace, "latencyMs": round((time.monotonic() - started) * 1000, 3)}
        evidence.write_json(f"{index:06d}.result.json", result)
        sys.stdout.write(canonical(result) + "\n")
        sys.stdout.flush()
    summary = {"event": "exit", **counts, "countsAsAdmitted": admitted, "bound": bound,
               "manifestSha256": identity["manifestSha256"],
               "exitCode": 2 if counts["requestsFailed"] else 0}
    evidence.write_json("summary.json", summary)
    log(summary)
    return summary["exitCode"]


def main(argv=None):
    args = build_parser().parse_args(argv)
    try:
        return run(args)
    except Exception as error:
        log({"event": "startup_failed", "error": f"{type(error).__name__}: {error}"})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
