#!/usr/bin/env python3
"""R11 C line: train one family of small heads on frozen joint-c-action/2 features.

  python train-heads.py --family base|fulfillment --corpus <corpus.jsonl> \
      --features-dir <enc> --training-manifest <enc/metadata.json> \
      --head <base.safetensors> --output-dir <newDir> [--renderer-source src/r7/jev/render.ts]

Four heads per family: warm/random x seed 17/43.  The recipe is frozen: the same
/2 states, candidates, features, split and budget for both families; only the
label column differs (the R10 executable/survival rule vs the pre-registered
common-deadline fulfilment rule).  The head is `LayerNorm(5120, affine=False,
eps=1e-5) -> Linear(5120,1)`, exactly what `serve_joint.py` applies.

Selection reads dev only, on unrounded set-NLL; the test split is not opened
here (see eval-test-once.py).  Empty acceptable sets never enter the loss and
are reported separately as abstention targets.

The emitted `training-manifest.json` is `frostecho.action-training-manifest/2`
and binds: head SHA, feature identity/hash, renderer source, encoder source,
memory policy, corpus bytes/splits, encoding qualification bytes, the deadline
protocol, the review count and the backbone-free training claim.
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

HIDDEN = 5120
EPS = 1e-5
INITS = ("warm", "random")
SEEDS = (17, 43)


def sha(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def stable_sha(value) -> str:
    canonical = json.dumps(json.loads(json.dumps(value, ensure_ascii=False)),
                           ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


class Refusal(Exception):
    pass


def refuse(code: str, detail: str, out_dir: Path | None):
    payload = {"schema": "frostecho.r11c.train-refusal/1", "refused": True,
               "code": code, "detail": detail}
    if out_dir is not None:
        try:
            out_dir.mkdir(parents=True, exist_ok=True)
            (out_dir / "refusal.json").write_text(json.dumps(payload, indent=2) + "\n")
        except OSError:
            pass
    print(json.dumps(payload, ensure_ascii=False), file=sys.stderr)
    raise SystemExit(2)


def load_cache_manifest(path: Path, features: Path, renderer_source: Path,
                        encoder_source: Path, out: Path) -> dict:
    if not path.exists():
        refuse("manifest-missing", f"no training manifest at {path}", out)
    document = json.loads(path.read_text())
    if document.get("schema") != "frostecho.joint-corpus-cache/1":
        refuse("manifest-schema", f"unexpected schema {document.get('schema')}", out)
    if document.get("status") != "complete" or document.get("realEncoder") is not True:
        refuse("manifest-incomplete", "cache is not a completed real-encoder run", out)
    if int(document.get("encoderForwardCalls") or 0) <= 0:
        refuse("manifest-no-forwards", "encoderForwardCalls <= 0", out)
    identity = document.get("featureIdentity")
    if not isinstance(identity, dict) or stable_sha(identity) != document.get("featureIdentityHash"):
        refuse("feature-identity-hash", "featureIdentityHash does not hash featureIdentity", out)
    live_renderer = sha(renderer_source)
    if identity.get("rendererSourceSha256") != live_renderer:
        refuse("renderer-identity-mismatch",
               "cache renderer differs from the live renderer; re-encode instead of relabelling", out)
    if identity.get("encoderSourceSha256") != sha(encoder_source):
        refuse("encoder-identity-mismatch",
               "cache encoder source differs from the live encoder", out)
    if identity.get("dimension") != HIDDEN or identity.get("padMultiple") != 8:
        refuse("feature-identity", "cache is not [*,5120] with padMultiple 8", out)
    for name, key in (("features.npz", "cacheSha256"), ("records.jsonl", "recordsSha256")):
        if not (features / name).exists() or sha(features / name) != document.get(key):
            refuse("cache-sha" if name == "features.npz" else "records-sha",
                   f"{name} does not match the cache manifest", out)
    execution = document.get("execution") or {}
    if execution.get("batchSize") != 1 or execution.get("padMultiple") != 8:
        refuse("encoding-execution", "online serving needs the batch1/pad8 qualification", out)
    entry = document.get("qualification") or {}
    qualification = features / str(entry.get("path", ""))
    features_file = features / "qualification-features.npz"
    if (not qualification.exists() or sha(qualification) != entry.get("sha256")
            or not features_file.exists() or sha(features_file) != entry.get("featuresSha256")):
        refuse("encoding-qualification", "qualification bytes missing or changed", out)
    sealed = json.loads(qualification.read_text())
    if sealed.get("ok") is not True:
        refuse("encoding-qualification", "qualification.json did not pass", out)
    if sealed.get("featureIdentityHash") != document.get("featureIdentityHash"):
        refuse("encoding-qualification", "qualification identity differs from the cache", out)
    return document


def load_corpus(path: Path, cache: dict, records_path: Path, family: str,
                renderer_sha: str, out: Path) -> list[dict]:
    rows = [json.loads(line) for line in path.read_text().splitlines() if line.strip()]
    if not rows:
        refuse("corpus-empty", "no corpus rows", out)
    records = {json.loads(line)["caseId"]: json.loads(line)
               for line in records_path.read_text().splitlines() if line.strip()}
    seen, owners, texts, episodes = set(), {}, {}, set()
    out_rows = []
    for row in rows:
        case_id, split = row.get("caseId"), row.get("split")
        if not isinstance(case_id, str) or case_id in seen:
            refuse("corpus-caseId", f"bad or duplicate caseId {case_id}", out)
        seen.add(case_id)
        if split not in ("train", "dev", "test"):
            refuse("corpus-split", f"{case_id} has split {split}", out)
        envelope = row.get("envelope", row)
        if envelope.get("rendererSourceSha256") != renderer_sha:
            refuse("corpus-renderer", f"{case_id} was rendered by a different renderer", out)
        record = records.get(case_id)
        if record is None:
            refuse("corpus-not-encoded", f"{case_id} has no cache record", out)
        if hashlib.sha256(envelope["requestJson"].encode()).hexdigest() != record["inputSha256"]:
            refuse("corpus-input-bytes", f"{case_id} request bytes differ from the cache", out)
        candidates = [candidate["id"] for candidate in envelope["request"]["candidates"]]
        if record["candidateIds"] != candidates:
            refuse("corpus-candidates", f"{case_id} candidate order differs from the cache", out)
        acceptable = row.get("acceptableIds") or []
        if any(value not in candidates for value in acceptable):
            refuse("corpus-labels", f"{case_id} acceptableIds are not actual candidates", out)
        episode = row.get("sourceEpisodeId") or row.get("sourceFamily") or row.get("episode")
        if not episode:
            refuse("corpus-episode", f"{case_id} has no source episode", out)
        if owners.setdefault(episode, split) != split:
            refuse("split-episode-leak", f"episode {episode} crosses partitions", out)
        text = envelope.get("renderedTextSha256")
        if texts.setdefault(text, split) != split:
            refuse("split-text-leak", f"{case_id} visible text crosses partitions", out)
        episodes.add(episode)
        if family == "fulfillment" and not row.get("fulfillmentDefined", False):
            continue
        out_rows.append({"caseId": case_id, "split": split, "episode": episode,
                         "acceptable": acceptable, "candidates": candidates,
                         "inputSha256": record["inputSha256"],
                         "labelStatus": row.get("labelStatus"),
                         "labelRule": row.get("labelRule"),
                         "deadline": row.get("deadline"),
                         "story": row.get("story"),
                         "accessState": row.get("accessState")})
    if not out_rows:
        refuse("corpus-empty-family", f"family {family} has no rows", out)
    for split in ("train", "dev", "test"):
        if not any(row["split"] == split for row in out_rows):
            refuse("split-empty", f"split {split} is empty for family {family}", out)
    return out_rows


def load_features(features_dir: Path, rows: list[dict], cache: dict, out: Path) -> dict:
    records = {json.loads(line)["caseId"]: json.loads(line)
               for line in (features_dir / "records.jsonl").read_text().splitlines() if line.strip()}
    with np.load(features_dir / "features.npz", allow_pickle=False) as archive:
        vectors, offsets = archive["cand"], archive["rowOffsets"]
        case_ids = archive["caseIds"].tolist()
    index = {case_id: position for position, case_id in enumerate(case_ids)}
    features = {}
    for row in rows:
        position = index.get(row["caseId"])
        if position is None:
            refuse("cache-missing-case", f"{row['caseId']} absent from the cache", out)
        begin, end = int(offsets[position]), int(offsets[position + 1])
        values = np.asarray(vectors[begin:end], dtype=np.float32)
        if values.shape != (len(row["candidates"]), HIDDEN) or not np.isfinite(values).all():
            refuse("cache-shape", f"{row['caseId']} features are not [{len(row['candidates'])},{HIDDEN}]", out)
        if records[row["caseId"]]["candidateIds"] != row["candidates"]:
            refuse("cache-candidates", f"{row['caseId']} cache order mismatch", out)
        features[row["caseId"]] = values
    return features


def normalise(values):
    import torch
    centered = values - values.mean(dim=-1, keepdim=True)
    return centered / torch.sqrt((centered ** 2).mean(dim=-1, keepdim=True) + EPS)


def set_nll(logits, acceptable):
    import torch
    mask = torch.full_like(logits, float("-inf"))
    mask[acceptable] = logits[acceptable]
    return torch.logsumexp(logits, dim=0) - torch.logsumexp(mask, dim=0)


def read_head(path: Path):
    from safetensors.numpy import load_file
    tensors = load_file(str(path))
    if set(tensors) != {"score.weight"} or tensors["score.weight"].shape != (1, HIDDEN):
        raise SystemExit("base head must be exactly one bias-free score.weight[1,5120]")
    weights = tensors["score.weight"].reshape(-1).astype(np.float32)
    if not np.isfinite(weights).all():
        raise SystemExit("base head contains nonfinite values")
    return weights


def save_head(path: Path, weight):
    from safetensors.numpy import save_file
    save_file({"score.weight": weight.reshape(1, HIDDEN).astype(np.float32)}, str(path))


def evaluate(state, rows, features):
    """Set loss/top1 and the acceptable-set probability, empty sets apart."""
    import torch
    labelled = [row for row in rows if row["acceptable"]]
    empty = [row for row in rows if not row["acceptable"]]
    result = {"cases": len(rows), "labelledCases": len(labelled),
              "emptySetCases": len(empty), "discriminativeCases": 0,
              "setNll": None, "top1InAcceptable": None, "meanAcceptableProbability": None,
              "discriminativeSetNll": None, "discriminativeTop1": None,
              "emptySet": {"top1ProbabilityMean": None, "abstainedAtUniform": None}}
    if not labelled:
        return result
    total = correct = disc_total = disc_count = disc_correct = 0
    prob_total = 0.0
    with torch.no_grad():
        for row in labelled:
            values = torch.from_numpy(features[row["caseId"]].astype(np.float32)).to(torch.float64)
            ids = row["candidates"]
            acceptable = [ids.index(value) for value in row["acceptable"]]
            logits = normalise(values) @ state
            loss = float(set_nll(logits, acceptable))
            probabilities = torch.softmax(logits, dim=0)
            prob_total += float(probabilities[acceptable].sum())
            hit = int(torch.argmax(logits)) in acceptable
            total += loss
            correct += hit
            if len(acceptable) < len(ids):
                disc_count += 1
                disc_total += loss
                disc_correct += hit
    result.update({
        "setNll": total / len(labelled),
        "top1InAcceptable": correct / len(labelled),
        "meanAcceptableProbability": prob_total / len(labelled),
        "discriminativeCases": disc_count,
        "discriminativeSetNll": disc_total / disc_count if disc_count else None,
        "discriminativeTop1": disc_correct / disc_count if disc_count else None,
    })
    if empty:
        with torch.no_grad():
            top = []
            abstain = 0
            for row in empty:
                values = torch.from_numpy(features[row["caseId"]].astype(np.float32)).to(torch.float64)
                logits = normalise(values) @ state
                probabilities = torch.softmax(logits, dim=0)
                top.append(float(probabilities.max()))
                abstain += int(float(probabilities.max()) < 1.0 / len(row["candidates"]))
        result["emptySet"] = {"top1ProbabilityMean": float(np.mean(top)),
                              "abstainedAtUniform": abstain / len(empty)}
    return result


def train_one(init, seed, args, rows, features, base):
    import torch
    torch.manual_seed(seed)
    torch.set_num_threads(min(8, torch.get_num_threads()))
    if init == "warm":
        start = torch.from_numpy(base.astype(np.float32)).to(torch.float64)
    else:
        generator = torch.Generator().manual_seed(seed)
        start = torch.randn(HIDDEN, dtype=torch.float64, generator=generator) * 0.02
    weight = torch.nn.Parameter(start.clone())
    optimiser = torch.optim.AdamW([weight], lr=args.lr, weight_decay=args.weight_decay)
    train_rows = [row for row in rows if row["split"] == "train" and row["acceptable"]]
    dev_rows = [row for row in rows if row["split"] == "dev"]
    best = {"epoch": 0, "weight": weight.detach().clone(),
            "dev": evaluate(weight.detach(), dev_rows, features)}
    curve = []
    for epoch in range(args.epochs):
        order = np.random.default_rng(seed + epoch).permutation(len(train_rows))
        running, batches = 0.0, 0
        for start_index in range(0, len(order), args.batch_size):
            batch = [train_rows[int(index)] for index in order[start_index:start_index + args.batch_size]]
            optimiser.zero_grad(set_to_none=True)
            losses = []
            for row in batch:
                values = torch.from_numpy(features[row["caseId"]].astype(np.float32)).to(torch.float64)
                ids = row["candidates"]
                logits = normalise(values) @ weight
                losses.append(set_nll(logits, [ids.index(value) for value in row["acceptable"]]))
            loss = torch.stack(losses).mean()
            loss.backward()
            optimiser.step()
            running += float(loss.detach())
            batches += 1
        dev = evaluate(weight.detach(), dev_rows, features)
        curve.append({"epoch": epoch + 1, "trainLoss": running / max(1, batches), "dev": dev})
        if dev["setNll"] is not None and (best["dev"]["setNll"] is None
                                          or dev["setNll"] < best["dev"]["setNll"]):
            best = {"epoch": epoch + 1, "weight": weight.detach().clone(), "dev": dev}
    return best, curve


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--family", required=True, choices=("base", "fulfillment"))
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--features-dir", type=Path, required=True)
    parser.add_argument("--training-manifest", type=Path, required=True)
    parser.add_argument("--head", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--renderer-source", type=Path, default=Path("src/r7/jev/render.ts"))
    parser.add_argument("--encoder-source", type=Path, default=None)
    parser.add_argument("--memory-policy", default="conditional-experience")
    parser.add_argument("--memory-selection", default="obligation-first")
    parser.add_argument("--memory-token-budget", type=int, default=640)
    parser.add_argument("--independent-reviews", type=int, default=0)
    parser.add_argument("--epochs", type=int, default=40)
    parser.add_argument("--lr", type=float, default=1e-3)
    parser.add_argument("--weight-decay", type=float, default=0.01)
    parser.add_argument("--batch-size", type=int, default=16)
    args = parser.parse_args()
    out = args.output_dir
    if out.exists():
        refuse("output-exists", f"{out} already exists; choose a new experiment dir", None)
    encoder_source = args.encoder_source or (
        Path(__file__).resolve().parent.parent / "jev05/action/joint_encoder.py")
    encoder_source = Path(encoder_source).resolve()
    if not encoder_source.exists():
        refuse("encoder-source", f"no encoder at {encoder_source}", out)
    cache = load_cache_manifest(args.training_manifest, args.features_dir,
                                args.renderer_source, encoder_source, out)
    if sha(args.training_manifest) != sha(args.features_dir / "metadata.json"):
        refuse("manifest-not-from-cache", "the manifest is not this cache's metadata.json", out)
    renderer_sha = sha(args.renderer_source)
    rows = load_corpus(args.corpus, cache, args.features_dir / "records.jsonl",
                       args.family, renderer_sha, out)
    features = load_features(args.features_dir, rows, cache, out)
    base = read_head(args.head)
    out.mkdir(parents=True)

    import torch
    started = time.monotonic()
    counts = {split: len([row for row in rows if row["split"] == split])
              for split in ("train", "dev", "test")}
    labelled = {split: len([row for row in rows if row["split"] == split and row["acceptable"]])
                for split in ("train", "dev", "test")}
    empty = {split: len([row for row in rows if row["split"] == split and not row["acceptable"]])
             for split in ("train", "dev", "test")}
    discriminative = {split: len([row for row in rows if row["split"] == split
                                  and row["acceptable"]
                                  and len(row["acceptable"]) < len(row["candidates"])])
                      for split in ("train", "dev", "test")}
    baseline = {"weight": "initial head", "headSha256": sha(args.head),
                "dev": evaluate(torch.from_numpy(base.astype(np.float64)),
                                [row for row in rows if row["split"] == "dev"], features)}
    results = []
    for init in INITS:
        for seed in SEEDS:
            best, curve = train_one(init, seed, args, rows, features, base)
            path = out / f"{init}-{seed}.safetensors"
            save_head(path, best["weight"].numpy().astype(np.float32))
            from safetensors.numpy import load_file
            reloaded = torch.from_numpy(load_file(str(path))["score.weight"]
                                        .reshape(-1).astype(np.float64))
            with torch.no_grad():
                reference_case = torch.from_numpy(
                    features[rows[0]["caseId"]].astype(np.float32)).to(torch.float64)
                restore_delta = float((normalise(reference_case) @ best["weight"]
                                       - normalise(reference_case) @ reloaded).abs().max())
            entry = {"init": init, "seed": seed, "selectedEpoch": best["epoch"],
                     "dev": best["dev"], "checkpoint": path.name,
                     "checkpointSha256": sha(path), "restoreMaxAbsDelta": restore_delta,
                     "train": evaluate(best["weight"], [row for row in rows
                                                        if row["split"] == "train"], features),
                     "curve": curve}
            results.append(entry)
            (out / f"{init}-{seed}.json").write_text(json.dumps(entry, indent=2) + "\n")
            print(json.dumps({"trained": path.name, "selectedEpoch": best["epoch"],
                              "devSetNll": best["dev"]["setNll"]}), flush=True)
    chosen = min(results, key=lambda entry: (entry["dev"]["setNll"],
                                             entry["selectedEpoch"],
                                             0 if entry["init"] == "warm" else 1,
                                             entry["seed"]))
    decisions = {
        "schema": "frostecho.r11c.dev-decision/1", "family": args.family,
        "selectionRule": "lowest unrounded dev set-NLL; tie-break earliest epoch, "
                         "then warm, then smaller seed; test never read",
        "candidates": [{"checkpoint": entry["checkpoint"], "init": entry["init"],
                        "seed": entry["seed"], "selectedEpoch": entry["selectedEpoch"],
                        "dev": entry["dev"]} for entry in results],
        "chosen": chosen["checkpoint"], "chosenDev": chosen["dev"],
        "baselineDev": baseline["dev"], "counts": counts, "labelledCounts": labelled,
        "emptySetCounts": empty, "discriminativeCounts": discriminative,
        "testTouched": False,
    }
    (out / "dev-decisions.json").write_text(json.dumps(decisions, indent=2) + "\n")

    deadlines = {(row.get("deadline") or {}).get("horizonMinutes") for row in rows}
    if len(deadlines) != 1 or not isinstance(next(iter(deadlines)), int):
        refuse("deadline-protocol", "corpus rows do not share one frozen horizon", out)
    horizon = next(iter(deadlines))
    qualification = cache["qualification"]
    artifact = {
        "schema": "frostecho.action-training-manifest/2",
        "experimental": True, "researchTrainReady": False, "mayTrainOnJev": False,
        "countsAsAdmitted": False, "calibrated": False,
        "labelSource": "same-snapshot-branch-rollout",
        "labelRule": rows[0]["labelRule"],
        "labelFamily": args.family,
        "independentReviews": int(args.independent_reviews),
        "device": "cpu", "torchVersion": torch.__version__,
        "corpusSha256": sha(args.corpus),
        "corpusSplits": counts,
        "cacheSha256": cache["cacheSha256"], "recordsSha256": cache["recordsSha256"],
        "featureIdentityHash": cache["featureIdentityHash"],
        "featureIdentity": cache["featureIdentity"],
        "encodingExecution": cache["execution"],
        "encodingQualification": {**qualification, "ok": True,
                                  "featureIdentityHash": cache["featureIdentityHash"]},
        "memory": {"policy": args.memory_policy, "selection": args.memory_selection,
                   "tokenBudget": args.memory_token_budget, "renderer": "joint-c-action/2"},
        "deadlineProtocol": {"continuationPolicy": "reference-rule/1",
                             "horizonMinutes": horizon if isinstance(horizon, int) else None,
                             "absolute": True, "pendingIsNotFailure": True},
        "splitUnit": "sourceEpisodeId",
        "rendererSourceSha256": renderer_sha,
        "encoderSourceSha256": sha(encoder_source),
        "trainingCodeSha256": sha(Path(__file__)),
        "initialHeadSha256": sha(args.head),
        "selectedCheckpoint": chosen["checkpoint"],
        "selectedCheckpointSha256": chosen["checkpointSha256"],
        "selection": "lowest unrounded dev set-NLL, never test",
        "counts": counts, "labelledCounts": labelled, "emptySetCounts": empty,
        "discriminativeCounts": discriminative,
        "baseline": baseline,
        "selectedMetrics": {"init": chosen["init"], "seed": chosen["seed"],
                            "selectedEpoch": chosen["selectedEpoch"],
                            "dev": chosen["dev"], "train": chosen["train"]},
        "fourHeads": [{"init": entry["init"], "seed": entry["seed"],
                       "checkpoint": entry["checkpoint"],
                       "checkpointSha256": entry["checkpointSha256"],
                       "selectedEpoch": entry["selectedEpoch"], "dev": entry["dev"]}
                      for entry in results],
        "backboneGradients": 0, "backboneLoadedByTrainer": False,
        "epochs": args.epochs, "batchSize": args.batch_size, "learningRate": args.lr,
        "weightDecay": args.weight_decay,
        "normalisation": "non-affine LayerNorm eps=1e-5 (serve_joint.normalized)",
        "setLoss": "logsumexp(z_all)-logsumexp(z_A); empty A is excluded and counted",
        "seconds": time.monotonic() - started,
        "limitations": [
            "Weak branch labels from one fixed rule controller; not human preference.",
            "All-acceptable cases carry zero gradient; see counts/discriminativeCounts.",
            "Independent blind reviews are reported separately and do not admit execution."],
    }
    (out / "training-manifest.json").write_text(json.dumps(artifact, indent=2) + "\n")
    print(json.dumps({"status": "trained", "family": args.family,
                      "chosen": chosen["checkpoint"], "dev": chosen["dev"],
                      "seconds": artifact["seconds"]}, indent=2))


if __name__ == "__main__":
    main()
