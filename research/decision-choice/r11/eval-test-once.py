#!/usr/bin/env python3
"""Evaluate the selected head on the held-out test split, exactly once.

  python eval-test-once.py --family base|fulfillment --corpus <corpus.jsonl> \
      --features-dir <enc> --output-dir <train dir> \
      [--renderer-source src/r7/jev/render.ts]

The manifest is re-validated by the shared /2 contract before any feature is
read, so a tampered corpus/head/feature/renderer/memory binding refuses here
too.  A second run refuses (exit 2) unless `--exploratory --reason` is given,
which writes a separately named file that is not the one-shot test result.
"""
from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import sys
import time
from pathlib import Path

import numpy as np

HIDDEN = 5120
EPS = 1e-5
R11 = Path(__file__).resolve().parent
sys.path.insert(0, str(R11))
import manifest_contract  # noqa: E402


def sha(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def normalise(values):
    import torch
    centered = values - values.mean(dim=-1, keepdim=True)
    return centered / torch.sqrt((centered ** 2).mean(dim=-1, keepdim=True) + EPS)


def metrics(state, rows, features):
    import torch
    labelled = [row for row in rows if row["acceptable"]]
    empty = [row for row in rows if not row["acceptable"]]
    result = {"cases": len(rows), "labelledCases": len(labelled),
              "emptySetCases": len(empty), "setNll": None,
              "top1InAcceptable": None, "meanAcceptableProbability": None,
              "discriminativeCases": 0, "discriminativeSetNll": None,
              "discriminativeTop1": None,
              "emptySet": {"top1ProbabilityMean": None, "abstainedAtUniform": None},
              "predictions": []}
    if labelled:
        total = correct = disc_total = disc_count = disc_correct = 0
        probability_total = 0.0
        with torch.no_grad():
            for row in labelled:
                values = torch.from_numpy(features[row["caseId"]].astype(np.float32)).to(torch.float64)
                ids = row["candidates"]
                allowed = [ids.index(value) for value in row["acceptable"]]
                logits = normalise(values) @ state
                loss = float(torch.logsumexp(logits, dim=0) - torch.logsumexp(logits[allowed], dim=0))
                probabilities = torch.softmax(logits, dim=0)
                probability_total += float(probabilities[allowed].sum())
                top = int(torch.argmax(logits))
                total += loss
                correct += int(top in allowed)
                if len(allowed) < len(ids):
                    disc_count += 1
                    disc_total += loss
                    disc_correct += int(top in allowed)
                result["predictions"].append({
                    "caseId": row["caseId"], "episode": row["episode"], "story": row.get("story"),
                    "candidateIds": ids, "acceptableIds": row["acceptable"],
                    "logits": [float(value) for value in logits],
                    "selectedId": ids[top], "inAcceptableSet": bool(top in allowed),
                    "discriminative": len(allowed) < len(ids)})
        result.update({"setNll": total / len(labelled),
                       "top1InAcceptable": correct / len(labelled),
                       "meanAcceptableProbability": probability_total / len(labelled),
                       "discriminativeCases": disc_count,
                       "discriminativeSetNll": disc_total / disc_count if disc_count else None,
                       "discriminativeTop1": disc_correct / disc_count if disc_count else None})
    if empty:
        with torch.no_grad():
            top_probabilities, abstain = [], 0
            for row in empty:
                values = torch.from_numpy(features[row["caseId"]].astype(np.float32)).to(torch.float64)
                logits = normalise(values) @ state
                probabilities = torch.softmax(logits, dim=0)
                top_probabilities.append(float(probabilities.max()))
                abstain += int(float(probabilities.max()) < 1.0 / len(row["candidates"]))
        result["emptySet"] = {"top1ProbabilityMean": float(np.mean(top_probabilities)),
                              "abstainedAtUniform": abstain / len(empty)}
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--family", required=True, choices=("base", "fulfillment"))
    parser.add_argument("--corpus", type=Path, required=True)
    parser.add_argument("--features-dir", type=Path, required=True)
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--renderer-source", type=Path, default=Path("src/r7/jev/render.ts"))
    parser.add_argument("--encoder-source", type=Path, default=None)
    parser.add_argument("--exploratory", action="store_true")
    parser.add_argument("--reason", default="")
    args = parser.parse_args()
    out = args.output_dir
    manifest_path = out / "training-manifest.json"
    if not manifest_path.exists():
        print("no training manifest in the output dir", file=sys.stderr)
        raise SystemExit(2)
    manifest_document = json.loads(manifest_path.read_text())
    selected = manifest_document["selectedCheckpoint"]
    head_path = out / selected
    encoder_source = args.encoder_source or (
        Path(__file__).resolve().parent.parent / "jev05/action/joint_encoder.py")
    try:
        report = manifest_contract.validate(
            manifest_path, head_path, renderer_source=args.renderer_source,
            encoder_source=Path(encoder_source).resolve(), features_dir=args.features_dir,
            corpus=args.corpus)
    except manifest_contract.Refusal as error:
        print(json.dumps({"refused": True, **error.as_dict()}), file=sys.stderr)
        return 2
    if report.get("labelFamily") not in (None, args.family):
        print(json.dumps({"refused": True, "code": "family-mismatch",
                          "detail": f"manifest family {report.get('labelFamily')} != {args.family}"}),
              file=sys.stderr)
        return 2
    first = out / "test-eval.json"
    exploratory = out / f"test-eval-exploratory-{time.strftime('%Y%m%dT%H%M%S')}.json"
    if first.exists() and not args.exploratory:
        payload = {"refused": True, "code": "test-already-evaluated",
                   "detail": "the test split was already evaluated once in this directory; "
                             "re-select on new episodes instead of retrying"}
        (out / "test-eval-refused.json").write_text(json.dumps(payload, indent=2) + "\n")
        print(json.dumps(payload), file=sys.stderr)
        raise SystemExit(2)
    if args.exploratory and not args.reason.strip():
        print("--exploratory requires --reason", file=sys.stderr)
        raise SystemExit(2)

    corpus = [json.loads(line) for line in args.corpus.read_text().splitlines() if line.strip()]
    rows = [{"caseId": row["caseId"], "split": row["split"],
             "episode": row.get("sourceEpisodeId"), "story": row.get("story"),
             "acceptable": row.get("acceptableIds") or [],
             "candidates": [candidate["id"]
                            for candidate in row.get("envelope", row)["request"]["candidates"]]}
            for row in corpus]
    test_rows = [row for row in rows if row["split"] == "test"]
    if not test_rows:
        print("test split is empty", file=sys.stderr)
        return 2
    with np.load(args.features_dir / "features.npz", allow_pickle=False) as archive:
        vectors, offsets = archive["cand"], archive["rowOffsets"]
        case_ids = archive["caseIds"].tolist()
    index = {case_id: position for position, case_id in enumerate(case_ids)}
    features = {}
    for row in test_rows:
        position = index.get(row["caseId"])
        if position is None:
            print(f"{row['caseId']} absent from the feature cache", file=sys.stderr)
            return 2
        begin, end = int(offsets[position]), int(offsets[position + 1])
        features[row["caseId"]] = np.asarray(vectors[begin:end], dtype=np.float32)

    import torch
    from safetensors.numpy import load_file
    if sha(head_path) != report["selectedCheckpointSha256"]:
        print("selected checkpoint SHA does not match the training manifest", file=sys.stderr)
        return 2
    weight = torch.from_numpy(load_file(str(head_path))["score.weight"]
                              .reshape(-1).astype(np.float64))
    result = metrics(weight, test_rows, features)
    document = {
        "schema": "frostecho.r11c.test-eval/1",
        "family": args.family,
        "firstAndOnlyRun": not first.exists(),
        "exploratory": bool(args.exploratory),
        "exploratoryReason": args.reason if args.exploratory else None,
        "evaluatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "outputDir": str(out),
        "manifestSha256": sha(manifest_path),
        "selectedCheckpoint": selected,
        "selectedCheckpointSha256": report["selectedCheckpointSha256"],
        "corpusSha256": sha(args.corpus),
        "cacheSha256": sha(args.features_dir / "features.npz"),
        "featureIdentityHash": report["featureIdentityHash"],
        "rendererSourceSha256": sha(args.renderer_source),
        "counts": {"test": len(test_rows),
                   "labelled": result["labelledCases"],
                   "empty": result["emptySetCases"],
                   "discriminative": result["discriminativeCases"]},
        "metrics": {key: value for key, value in result.items() if key != "predictions"},
        "epochs": manifest_document.get("epochs"),
        "selection": manifest_document.get("selection"),
        "limitations": manifest_document.get("limitations"),
        "baseline": manifest_document.get("baseline"),
    }
    target = exploratory if args.exploratory else first
    target.write_text(json.dumps(document, indent=2) + "\n")
    (out / "test-predictions.jsonl").write_text(
        "\n".join(json.dumps(entry) for entry in result["predictions"]) + "\n")
    print(json.dumps({"firstAndOnlyRun": document["firstAndOnlyRun"],
                      "counts": document["counts"], "metrics": document["metrics"]},
                     indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
