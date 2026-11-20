#!/usr/bin/env python3
"""R11 C line: the one versioned training-manifest contract.

Two honest label provenances are allowed and nothing else:

  * ``reference-imitation``      - the frozen R9/R10 reference corpus.
  * ``same-snapshot-branch-rollout`` - per-candidate rollouts from one snapshot
    under one continuation policy and one absolute deadline.

Version 1 is the historical ``frostecho.action-weak-experiment/1`` document and
stays limited to ``reference-imitation`` so an R10 branch manifest cannot be
silently promoted by re-using the old schema id.  Version 2 is
``frostecho.action-training-manifest/2`` and is the only schema that may carry
branch-rollout labels; it must also bind the corpus, the memory policy, the
deadline protocol, the encoder qualification and the independent reviews.

Every refusal is a stable code plus a human detail.  ``validate`` never imports
torch and never loads the backbone: a missing or tampered manifest is refused
before the service constructs any model.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

SCHEMA_V1 = "frostecho.action-weak-experiment/1"
SCHEMA_V2 = "frostecho.action-training-manifest/2"
# O's integration name for the same version-2 document. Accepted as an alias so
# the validator is genuinely shared instead of forking on the id.
SCHEMA_R11 = "frostecho.training-manifest/r11"
SCHEMA_V2_ALIASES = (SCHEMA_V2, SCHEMA_R11)
LABEL_REFERENCE = "reference-imitation"
LABEL_BRANCH = "same-snapshot-branch-rollout"
LABEL_SOURCES = (LABEL_REFERENCE, LABEL_BRANCH)
HIDDEN = 5120
EPS = 1e-5
PAD_MULTIPLE = 8
ONLINE_BATCH = 1
HEAD_TENSOR = "score.weight"


class Refusal(ValueError):
    """A contract violation with a stable machine code."""

    def __init__(self, code: str, detail: str):
        super().__init__(f"{code}: {detail}")
        self.code = code
        self.detail = detail

    def as_dict(self) -> dict:
        return {"code": self.code, "detail": self.detail}


def sha_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def file_sha(path: Path) -> str:
    return sha_bytes(Path(path).read_bytes())


def canonical(value) -> str:
    clean = json.loads(json.dumps(value, ensure_ascii=False, allow_nan=False))
    return json.dumps(clean, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False)


def stable_sha(value) -> str:
    return sha_bytes(canonical(value).encode("utf-8"))


def _digest(value, field: str, *, nullable: bool = False) -> str | None:
    if value is None and nullable:
        return None
    if not isinstance(value, str) or len(value) != 64 or any(
            char not in "0123456789abcdef" for char in value):
        raise Refusal("manifest-hash-field", f"{field} must be a lowercase sha256 hex digest")
    return value


def _nonempty(value, field: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise Refusal("manifest-field", f"{field} must be a nonempty string")
    return value


def _flag(document: dict, field: str, expected: bool):
    if document.get(field) is not expected:
        raise Refusal("manifest-admission-flags",
                      f"{field} must be {expected!r}; an experimental head cannot change identity here")


def _check_head(path: Path | None, document: dict, head_sha: str | None) -> dict:
    if head_sha is None and path is not None:
        head_sha = file_sha(path)
    if document.get("selectedCheckpointSha256") != head_sha:
        raise Refusal("head-sha", "selectedCheckpointSha256 differs from the supplied head")
    if path is None:
        return {"path": None, "sha256": head_sha, "tensor": None, "shape": None}
    if not path.exists():
        raise Refusal("head-missing", f"head {path} does not exist")
    declared = document.get("selectedCheckpoint")
    if declared is not None and declared != path.name:
        raise Refusal("head-name", f"selectedCheckpoint {declared!r} differs from {path.name!r}")
    shape = None
    try:
        from safetensors.numpy import load_file
        tensors = load_file(str(path))
    except ImportError:
        tensors = None
    if tensors is not None:
        if set(tensors) != {HEAD_TENSOR}:
            raise Refusal("head-tensor", f"head must contain exactly {HEAD_TENSOR}")
        shape = list(tensors[HEAD_TENSOR].shape)
        if shape != [1, HIDDEN]:
            raise Refusal("head-tensor", f"{HEAD_TENSOR} must be [1,{HIDDEN}], got {shape}")
        import numpy as np
        if not np.isfinite(tensors[HEAD_TENSOR]).all():
            raise Refusal("head-tensor", "head contains nonfinite values")
    return {"path": str(path), "sha256": head_sha,
            "tensor": HEAD_TENSOR if tensors is not None else None, "shape": shape}


def _check_feature_identity(document: dict, *, renderer_source: Path | None,
                            encoder_source: Path | None, require_full: bool) -> dict:
    identity = document.get("featureIdentity")
    if not isinstance(identity, dict):
        raise Refusal("feature-identity", "featureIdentity must be an object")
    if stable_sha(identity) != document.get("featureIdentityHash"):
        raise Refusal("feature-identity-hash",
                      "featureIdentityHash does not hash featureIdentity")
    if not require_full:
        return {"hash": document["featureIdentityHash"], "identity": identity,
                "dimension": identity.get("dimension")}
    if identity.get("dimension") != HIDDEN:
        raise Refusal("feature-identity-dimension", f"dimension must be {HIDDEN}")
    if identity.get("padMultiple") != PAD_MULTIPLE:
        raise Refusal("feature-identity-padding", f"padMultiple must be {PAD_MULTIPLE}")
    if renderer_source is not None:
        live_renderer = file_sha(renderer_source)
        if identity.get("rendererSourceSha256") != live_renderer:
            raise Refusal("feature-identity-renderer",
                          "cache renderer differs from the live renderer; re-encode, do not relabel")
    if encoder_source is not None and identity.get("encoderSourceSha256") is not None:
        live_encoder = file_sha(encoder_source)
        if identity["encoderSourceSha256"] != live_encoder:
            raise Refusal("feature-identity-encoder",
                          "cache encoder source differs from the live encoder")
    for key in ("modelPath", "precision", "readout", "padding"):
        _nonempty(identity.get(key), f"featureIdentity.{key}")
    if identity.get("precision") != "bfloat16":
        raise Refusal("feature-identity-precision", "the served features are bfloat16")
    return {"hash": document["featureIdentityHash"], "identity": identity,
            "dimension": identity.get("dimension")}


def _check_execution(document: dict) -> dict:
    execution = document.get("encodingExecution")
    if not isinstance(execution, dict):
        raise Refusal("encoding-execution", "encodingExecution is required")
    if execution.get("batchSize") != ONLINE_BATCH:
        raise Refusal("encoding-execution", f"online service requires batchSize {ONLINE_BATCH}")
    if execution.get("padMultiple") != PAD_MULTIPLE:
        raise Refusal("encoding-execution", f"online service requires padMultiple {PAD_MULTIPLE}")
    if not isinstance(execution.get("maxTokens"), int) or execution["maxTokens"] < 1:
        raise Refusal("encoding-execution", "maxTokens must be a positive integer")
    if execution.get("placement") not in ("auto", "one-layer-offload"):
        raise Refusal("encoding-execution", "placement must be auto or one-layer-offload")
    return execution


def _check_qualification(document: dict, features_dir: Path | None) -> dict:
    entry = document.get("encodingQualification")
    if not isinstance(entry, dict):
        raise Refusal("encoding-qualification", "encodingQualification is required")
    _nonempty(entry.get("path"), "encodingQualification.path")
    _digest(entry.get("sha256"), "encodingQualification.sha256")
    _digest(entry.get("featuresSha256"), "encodingQualification.featuresSha256")
    if entry.get("ok") is False:
        raise Refusal("encoding-qualification", "qualification did not pass (ok=false)")
    if entry.get("featureIdentityHash") not in (None, document.get("featureIdentityHash")):
        raise Refusal("encoding-qualification", "qualification identity differs from the manifest")
    if features_dir is not None:
        features_dir = Path(features_dir)
        qualification = features_dir / entry["path"]
        qualification_features = features_dir / "qualification-features.npz"
        if not qualification.exists() or file_sha(qualification) != entry["sha256"]:
            raise Refusal("encoding-qualification-bytes",
                          f"{qualification} is missing or does not match its sha256")
        if (not qualification_features.exists()
                or file_sha(qualification_features) != entry["featuresSha256"]):
            raise Refusal("encoding-qualification-bytes",
                          "qualification-features.npz is missing or differs from its sha256")
        sealed = json.loads(qualification.read_text(encoding="utf-8"))
        if sealed.get("ok") is not True:
            raise Refusal("encoding-qualification", "qualification.json did not pass")
        if sealed.get("featureIdentityHash") != document.get("featureIdentityHash"):
            raise Refusal("encoding-qualification",
                          "qualification.json was produced under another feature identity")
        cache = features_dir / "features.npz"
        records = features_dir / "records.jsonl"
        for path, key in ((cache, "cacheSha256"), (records, "recordsSha256")):
            if not path.exists() or document.get(key) is None:
                raise Refusal("cache-sha", f"{path.name} or its manifest digest is missing")
            if file_sha(path) != document[key]:
                raise Refusal("cache-sha", f"{path.name} differs from {key}")
    return entry


def _check_memory(document: dict, expected: dict | None) -> dict:
    memory = document.get("memory")
    if not isinstance(memory, dict):
        raise Refusal("memory-identity", "version 2 manifests must bind the memory policy")
    policy = _nonempty(memory.get("policy"), "memory.policy")
    selection = _nonempty(memory.get("selection"), "memory.selection")
    budget = memory.get("tokenBudget")
    if not isinstance(budget, int) or isinstance(budget, bool) or budget < 1:
        raise Refusal("memory-identity", "memory.tokenBudget must be a positive integer")
    if memory.get("renderer") is not None:
        _nonempty(memory.get("renderer"), "memory.renderer")
    if expected is not None:
        for key, value in (("policy", policy), ("selection", selection),
                           ("tokenBudget", budget)):
            if expected.get(key) is not None and expected.get(key) != value:
                raise Refusal("memory-identity",
                              f"served {key} {expected.get(key)!r} differs from manifest {value!r}")
    return {"policy": policy, "selection": selection, "tokenBudget": budget,
            "renderer": memory.get("renderer")}


def _check_corpus(document: dict, corpus: Path | None) -> dict:
    _digest(document.get("corpusSha256"), "corpusSha256")
    if corpus is not None and file_sha(corpus) != document["corpusSha256"]:
        raise Refusal("corpus-sha", "corpus file differs from corpusSha256")
    splits = document.get("corpusSplits")
    if splits is not None:
        if not isinstance(splits, dict) or set(splits) != {"train", "dev", "test"}:
            raise Refusal("corpus-splits", "corpusSplits must hold train/dev/test")
        if not all(isinstance(value, int) and value >= 0 for value in splits.values()):
            raise Refusal("corpus-splits", "split counts must be nonnegative integers")
    return {"sha256": document["corpusSha256"], "splits": splits}


def _check_deadline(document: dict) -> dict:
    protocol = document.get("deadlineProtocol")
    if not isinstance(protocol, dict):
        raise Refusal("deadline-protocol",
                      "branch-rollout labels must bind the common-deadline protocol")
    _nonempty(protocol.get("continuationPolicy"), "deadlineProtocol.continuationPolicy")
    horizon = protocol.get("horizonMinutes")
    if not isinstance(horizon, int) or isinstance(horizon, bool) or horizon < 1:
        raise Refusal("deadline-protocol", "horizonMinutes must be a positive integer")
    if protocol.get("absolute") is not True:
        raise Refusal("deadline-protocol",
                      "branches must run to one absolute deadline, not a per-branch horizon")
    if protocol.get("pendingIsNotFailure") is not True:
        raise Refusal("deadline-protocol",
                      "an unfinished slow action must be recorded as pending")
    return protocol


def _check_labels(document: dict, *, require_rule: bool) -> tuple[str, str]:
    source = document.get("labelSource")
    if source not in LABEL_SOURCES:
        raise Refusal("label-source",
                      f"labelSource {source!r} is not one of {LABEL_SOURCES}")
    rule = _nonempty(document.get("labelRule"), "labelRule") if require_rule \
        else str(document.get("labelRule") or "")
    reviews = document.get("independentReviews")
    if not isinstance(reviews, int) or isinstance(reviews, bool) or reviews < 0:
        raise Refusal("independent-reviews", "independentReviews must be a nonnegative integer")
    return source, rule


def validate(path: Path, head: Path | None = None, *, head_sha: str | None = None,
             renderer_source: Path | None = None,
             encoder_source: Path | None = None, memory: dict | None = None,
             features_dir: Path | None = None, corpus: Path | None = None,
             allow_legacy_v1: bool = True) -> dict:
    """Validate one manifest against the bytes it claims. Raises ``Refusal``."""
    path = Path(path)
    if not path.exists():
        raise Refusal("manifest-missing", f"no training manifest at {path}")
    raw = path.read_bytes()
    try:
        document = json.loads(raw)
    except json.JSONDecodeError as error:
        raise Refusal("manifest-json", f"manifest is not JSON: {error}") from error
    if not isinstance(document, dict):
        raise Refusal("manifest-json", "manifest root must be an object")
    schema = document.get("schema")
    if schema in SCHEMA_V2_ALIASES:
        version = 2
    elif schema == SCHEMA_V1:
        if not allow_legacy_v1:
            raise Refusal("manifest-schema", "legacy version 1 is not accepted here")
        version = 1
    else:
        raise Refusal("manifest-schema", f"unexpected schema {schema!r}")

    for field in ("experimental", "countsAsAdmitted", "calibrated",
                  "researchTrainReady", "mayTrainOnJev"):
        _flag(document, field, {"experimental": True, "countsAsAdmitted": False,
                                "calibrated": False, "researchTrainReady": False,
                                "mayTrainOnJev": False}[field])
    source, rule = _check_labels(document, require_rule=(schema == SCHEMA_V2))

    if version == 1:
        if source != LABEL_REFERENCE:
            raise Refusal("label-source",
                          "version 1 is reference-imitation only; branch rollouts require "
                          f"{SCHEMA_V2} / {SCHEMA_R11}")
        if document.get("selectedCheckpointSha256") != (
                head_sha if head_sha is not None else (file_sha(head) if head else None)):
            raise Refusal("head-sha", "selectedCheckpointSha256 differs from the supplied head")
        identity = _check_feature_identity(document, renderer_source=None,
                                           encoder_source=None, require_full=False)
        execution = document.get("encodingExecution")
        if (not isinstance(execution, dict) or execution.get("batchSize") != ONLINE_BATCH
                or execution.get("padMultiple") != PAD_MULTIPLE):
            raise Refusal("encoding-execution",
                          "online head requires the completed batch1 / pad8 encoding experiment")
        qualification = document.get("encodingQualification")
        if (not isinstance(qualification, dict) or not qualification.get("path")
                or _digest(qualification.get("sha256"), "encodingQualification.sha256") is None
                or _digest(qualification.get("featuresSha256"),
                           "encodingQualification.featuresSha256") is None):
            raise Refusal("encoding-qualification",
                          "training manifest lacks its encoding qualification binding")
        return {"schema": schema, "schemaCanonical": SCHEMA_V1, "contractVersion": 1, "sha256": sha_bytes(raw),
                "labelSource": source, "labelRule": rule,
                "labelFamily": document.get("labelFamily"),
                "independentReviews": document.get("independentReviews", 0),
                "selectedCheckpoint": document.get("selectedCheckpoint"),
                "selectedCheckpointSha256": document["selectedCheckpointSha256"],
                "featureIdentity": identity["identity"],
                "featureIdentityHash": identity["hash"],
                "rendererSourceSha256": identity["identity"].get("rendererSourceSha256"),
                "memory": None, "corpus": None, "deadlineProtocol": None,
                "execution": execution, "qualification": qualification,
                "experimental": True, "countsAsAdmitted": False}

    # Version 2: the full R11 binding.
    head_report = _check_head(Path(head) if head is not None else None, document,
                              head_sha or (file_sha(head) if head is not None else None))
    identity = _check_feature_identity(document, renderer_source=renderer_source,
                                       encoder_source=encoder_source, require_full=True)
    execution = _check_execution(document)
    qualification = _check_qualification(document, features_dir)
    memory_report = _check_memory(document, memory)
    corpus_report = _check_corpus(document, corpus)
    deadline = _check_deadline(document) if source == LABEL_BRANCH else None
    if source == LABEL_BRANCH:
        unit = document.get("splitUnit")
        if unit not in (None, "sourceEpisodeId"):
            raise Refusal("split-unit", "branch corpora must split by sourceEpisodeId")
        if document.get("independentReviews", 0) < 0:
            raise Refusal("independent-reviews", "independentReviews must be nonnegative")
    training_code = document.get("trainingCodeSha256")
    _digest(training_code, "trainingCodeSha256")
    if document.get("backboneGradients") != 0:
        raise Refusal("backbone", "this recipe trains small heads only (backboneGradients 0)")
    if document.get("backboneLoadedByTrainer") is not False:
        raise Refusal("backbone", "the trainer must not load the backbone")
    return {"schema": schema, "schemaCanonical": SCHEMA_R11, "contractVersion": 2, "sha256": sha_bytes(raw),
            "labelSource": source, "labelRule": rule,
            "labelFamily": document.get("labelFamily"),
            "independentReviews": document.get("independentReviews"),
            "selectedCheckpoint": document.get("selectedCheckpoint"),
            "selectedCheckpointSha256": document["selectedCheckpointSha256"],
            "head": head_report,
            "featureIdentity": identity["identity"], "featureIdentityHash": identity["hash"],
            "rendererSourceSha256": (identity["identity"] or {}).get("rendererSourceSha256"),
            "execution": execution, "qualification": qualification,
            "memory": memory_report, "corpus": corpus_report,
            "deadlineProtocol": deadline,
            "trainingCodeSha256": training_code,
            "experimental": True, "countsAsAdmitted": False}


def main(argv=None) -> int:
    import argparse
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--head", type=Path, required=True)
    parser.add_argument("--renderer-source", type=Path, default=None)
    parser.add_argument("--encoder-source", type=Path, default=None)
    parser.add_argument("--features-dir", type=Path, default=None)
    parser.add_argument("--corpus", type=Path, default=None)
    parser.add_argument("--memory-policy", default=None)
    parser.add_argument("--memory-selection", default=None)
    parser.add_argument("--memory-token-budget", type=int, default=None)
    parser.add_argument("--json-out", type=Path, default=None)
    args = parser.parse_args(argv)
    memory = None
    if args.memory_policy is not None:
        memory = {"policy": args.memory_policy, "selection": args.memory_selection,
                  "tokenBudget": args.memory_token_budget}
    try:
        report = validate(args.manifest, args.head, renderer_source=args.renderer_source,
                          encoder_source=args.encoder_source, features_dir=args.features_dir,
                          corpus=args.corpus, memory=memory)
    except Refusal as error:
        payload = {"ok": False, "refused": True, **error.as_dict()}
        print(json.dumps(payload, ensure_ascii=False), flush=True)
        if args.json_out:
            args.json_out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
        return 2
    payload = {"ok": True, **report}
    print(json.dumps(payload, ensure_ascii=False), flush=True)
    if args.json_out:
        args.json_out.write_text(json.dumps(payload, indent=2) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
