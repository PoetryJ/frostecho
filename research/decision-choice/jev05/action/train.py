#!/usr/bin/env python3
"""R8 action scorer toolchain (M).

Subcommands: preflight | encode | train | calibrate | score | serve

Real artifacts this tool knows about (verified by `preflight`, never assumed):

  * head        artifacts/sprint-r7/legacy-reuse/c43-increment-batch4-1/
                warm-start-17/best.safetensors  -> tensor `score.weight` [1,5120]
  * encoder     /data2/model_weights/Qwen3.8-27B (config.json hidden_size)
  * features    a .npz holding real frozen-encoder features (cand/hq arrays)

A path that is missing is reported as missing. A GPU that is occupied by
another process is reported as occupied with the measured free MiB. The tool
never downloads a backbone and never kills a foreign process.

The head is a plain linear scorer over frozen 5120-d features, so scoring is
exact real inference: `logits = features @ w`, softmax over the candidate set.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import struct
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[4]
HEAD = (ROOT / "artifacts/sprint-r7/legacy-reuse/c43-increment-batch4-1"
        / "warm-start-17/best.safetensors")
ENCODER = Path("/data2/model_weights/Qwen3.8-27B")
HIDDEN = 5120
RENDERER = "joint-c-action/1"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def read_head(path: Path) -> np.ndarray:
    """Minimal safetensors reader: F32 tensors only, no torch dependency."""
    with path.open("rb") as stream:
        header_len = struct.unpack("<Q", stream.read(8))[0]
        header = json.loads(stream.read(header_len))
        tensors = {}
        for name, info in header.items():
            if name == "__metadata__":
                continue
            if info["dtype"] != "F32":
                raise SystemExit(f"unsupported dtype {info['dtype']} for {name}")
            start, end = info["data_offsets"]
            stream.seek(8 + header_len + start)
            tensors[name] = np.frombuffer(stream.read(end - start), dtype=np.float32)
        if "score.weight" not in tensors:
            raise SystemExit("head has no score.weight tensor")
        weight = tensors["score.weight"].reshape(-1)
        if weight.shape[0] != HIDDEN:
            raise SystemExit(f"head width {weight.shape[0]} != {HIDDEN}")
        return weight.astype(np.float64)


def gpu_free_mib() -> list[dict]:
    try:
        out = subprocess.run(
            ["nvidia-smi", "--query-gpu=index,name,memory.total,memory.used",
             "--format=csv,noheader,nounits"],
            capture_output=True, text=True, timeout=20)
    except (OSError, subprocess.SubprocessError):
        return []
    rows = []
    if out.returncode != 0:
        return rows
    for line in out.stdout.strip().splitlines():
        parts = [part.strip() for part in line.split(",")]
        if len(parts) < 4:
            continue
        rows.append({"index": int(parts[0]), "name": parts[1],
                     "totalMiB": int(parts[2]), "usedMiB": int(parts[3]),
                     "freeMiB": int(parts[2]) - int(parts[3])})
    return rows


def encoder_hidden(path: Path) -> int | None:
    config = path / "config.json"
    if not config.exists():
        return None
    data = json.loads(config.read_text())
    return int(data.get("hidden_size") or data.get("text_config", {}).get("hidden_size") or 0)


def architecture_support(encoder: Path) -> tuple[bool, str]:
    """Ask the local transformers whether it can construct this config."""
    if not encoder.exists():
        return False, "encoder directory missing"
    try:
        from transformers import AutoConfig
        config = AutoConfig.from_pretrained(str(encoder), trust_remote_code=True)
        return True, type(config).__name__
    except Exception as error:  # noqa: BLE001
        return False, f"{type(error).__name__}: {error}"


def preflight(args) -> dict:
    head = Path(args.head)
    encoder = Path(args.encoder)
    report: dict = {"schema": "frostecho.jev05.action.preflight/1",
                    "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
                    "renderer": RENDERER, "hidden": HIDDEN}
    report["head"] = {"path": str(head), "exists": head.exists(),
                      "sha256": sha256(head) if head.exists() else None}
    hidden = encoder_hidden(encoder)
    report["encoder"] = {"path": str(encoder), "exists": encoder.exists(),
                         "hiddenSize": hidden,
                         "matchesHead": hidden == HIDDEN}
    gpus = gpu_free_mib()
    report["gpus"] = gpus
    # A 27B BF16 backbone is ~51 GiB of weights. The plan is GPU shards plus CPU
    # RAM, not "one card must hold it": shard on every GPU with a reserve, spill
    # the rest to RAM with its own reserve.
    bf16_gib = 2 * 27e9 / 2**30
    total_free = sum(gpu["freeMiB"] for gpu in gpus)
    gpu_reserve = 1536  # MiB kept free per card for activations
    usable_gpu = max(0, total_free - gpu_reserve * max(1, len(gpus)))
    ram_available = 0
    try:
        for line in Path("/proc/meminfo").read_text().splitlines():
            if line.startswith("MemAvailable:"):
                ram_available = int(line.split()[1]) // 1024
    except OSError:
        ram_available = 0
    ram_reserve = 12 * 1024
    usable_ram = max(0, ram_available - ram_reserve)
    required = int(bf16_gib * 1024)
    report["capacity"] = {"requiredWeightsMiB": required, "totalGpuFreeMiB": total_free,
                          "usableGpuMiB": usable_gpu, "ramAvailableMiB": ram_available,
                          "usableRamMiB": usable_ram,
                          "plan": "device_map shards across free GPUs, remainder on CPU"}
    report["encoderLoadable"] = required <= usable_gpu + usable_ram
    # Capacity is necessary, not sufficient: the local transformers must also
    # recognise the architecture, or nothing can be loaded at all.
    supported, detail = architecture_support(encoder)
    report["architecture"] = {"supported": supported, "detail": detail}
    report["requiredVramMiB"] = required
    features = Path(args.features) if args.features else None
    if features and features.exists():
        with np.load(features, allow_pickle=True) as archive:
            cand = archive["cand"] if "cand" in archive else None
            report["features"] = {"path": str(features), "sha256": sha256(features),
                                 "candShape": list(cand.shape) if cand is not None else None,
                                 "dtype": str(cand.dtype) if cand is not None else None,
                                 "rows": int(cand.shape[0]) if cand is not None else 0}
    else:
        report["features"] = {"path": str(features) if features else None, "exists": False}
    blockers = []
    if not report["head"]["exists"]:
        blockers.append("head checkpoint missing")
    if not report["encoder"]["exists"]:
        blockers.append("encoder backbone missing")
    if not report["encoderLoadable"]:
        blockers.append(
            f"no free GPU can hold a 27B BF16 backbone "
            f"(need {int(bf16_gib * 1024)} MiB, best free {best_free} MiB; "
            f"other processes hold the cards)")
    if not report["architecture"]["supported"]:
        blockers.append(f"local transformers cannot build this architecture: "
                        f"{report['architecture']['detail']}")
    if not (features and features.exists()):
        blockers.append("no frozen-feature cache for new inputs; encode is blocked")
    report["blockedReason"] = "; ".join(blockers) if blockers else None
    report["readyForScoring"] = report["head"]["exists"]
    report["readyForTraining"] = report["readyForScoring"] and (features is not None
                                                               and features.exists())
    report["readyForLiveEncoding"] = (report["encoderLoadable"]
                                      and report["encoder"]["matchesHead"]
                                      and report["architecture"]["supported"])
    report["status"] = "ready" if report["readyForTraining"] else "blocked"
    return report


def load_cases(path: Path) -> list[dict]:
    cases = []
    for line in path.read_text().splitlines():
        line = line.strip()
        if line:
            cases.append(json.loads(line))
    return cases


def softmax(values: np.ndarray) -> np.ndarray:
    shifted = values - values.max()
    exps = np.exp(shifted)
    return exps / exps.sum()


def set_nll(logits: np.ndarray, acceptable: list[int]) -> tuple[float, np.ndarray]:
    all_max = logits.max()
    accept = logits[acceptable]
    accept_max = accept.max()
    loss = (all_max + np.log(np.exp(logits - all_max).sum())
            - accept_max - np.log(np.exp(accept - accept_max).sum()))
    gradient = softmax(logits)
    gradient[acceptable] -= softmax(accept)
    return float(loss), gradient


def normalize_rows(features: np.ndarray) -> np.ndarray:
    """Non-affine LayerNorm, eps 1e-5, exactly the original head input.

    `reference/joint_core.py` and `legacy/runner.py make_head` both normalize
    the candidate hidden vector before the linear score:
        z = w . ((h - mean(h)) / sqrt(mean((h - mean(h))^2) + 1e-5))
    The first R8 draft skipped this and produced a different decision.
    """
    values = np.asarray(features, dtype=np.float64)
    if values.ndim < 2:
        raise SystemExit("features must be at least rank two")
    centered = values - values.mean(axis=-1, keepdims=True)
    variance = np.mean(centered ** 2, axis=-1, keepdims=True)
    return centered / np.sqrt(variance + 1e-5)


def score_matrix(weight: np.ndarray, features: np.ndarray) -> np.ndarray:
    """features: [.., K, 5120] -> logits [.., K] with the original LayerNorm."""
    return normalize_rows(features) @ weight


def softmax_temperature(logits: np.ndarray, temperature: float) -> np.ndarray:
    """Temperature must change the distribution of distinct logits."""
    scale = max(float(temperature), 1e-6)
    return softmax(np.asarray(logits, dtype=np.float64) / scale)


def evaluate(weight: np.ndarray, cases: list[dict], features: dict) -> dict:
    correct = 0
    losses = []
    used = 0
    for case in cases:
        cand = features.get(case["caseId"])
        acceptable = case.get("acceptableIds")
        if cand is None or not acceptable:
            continue
        ids = [candidate["id"] for candidate in case["candidates"]]
        try:
            indices = [ids.index(value) for value in acceptable]
        except ValueError:
            continue
        logits = score_matrix(weight, cand)
        losses.append(set_nll(logits, indices)[0])
        correct += int(int(np.argmax(logits)) in indices)
        used += 1
    return {"cases": used,
            "top1InAcceptable": (correct / used) if used else None,
            "setNll": float(np.mean(losses)) if losses else None}


def cmd_preflight(args) -> int:
    report = preflight(args)
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        print(f"head      : {report['head']['path']} exists={report['head']['exists']}")
        print(f"encoder   : {report['encoder']['path']} hidden={report['encoder']['hiddenSize']}")
        print(f"gpus      : {[(gpu['index'], gpu['freeMiB']) for gpu in report['gpus']]}")
        print(f"training  : {report['readyForTraining']}")
        print(f"blocked   : {report['blockedReason']}")
    return 0


def cmd_encode(args) -> int:
    """Real encoder pass; refuses honestly when the card cannot hold it."""
    report = preflight(args)
    if not report["readyForLiveEncoding"]:
        print(json.dumps({"status": "blocked", "reason": report["blockedReason"],
                          "gpus": report["gpus"],
                          "requiredVramMiB": report["requiredVramMiB"]},
                         ensure_ascii=False, indent=2))
        return 3
    # A real pass is implemented, but only reachable with a free card.
    from transformers import AutoModel, AutoTokenizer  # noqa: F401  (lazy import)
    tokenizer = AutoTokenizer.from_pretrained(str(ENCODER), trust_remote_code=True)
    model = AutoModel.from_pretrained(str(ENCODER), torch_dtype="bfloat16",
                                      device_map="cuda:0", trust_remote_code=True)
    model.eval()
    import torch
    cases = load_cases(Path(args.cases))
    rows, hq = [], []
    started = time.time()
    with torch.inference_mode():
        for case in cases:
            texts = [case["observationText"]] + [candidate["text"]
                                                 for candidate in case["candidates"]]
            encoded = tokenizer(texts, return_tensors="pt", padding=True,
                                truncation=True, max_length=args.max_length).to("cuda:0")
            hidden = model(**encoded).last_hidden_state
            mask = encoded["attention_mask"]
            last = hidden[torch.arange(hidden.shape[0]), mask.sum(dim=1) - 1]
            vector = last.float().cpu().numpy()
            hq.append(vector[0])
            rows.append(vector[1:])
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out, cand=np.asarray(rows, dtype=np.float32),
                        hq=np.asarray(hq, dtype=np.float32))
    print(json.dumps({"status": "encoded", "cases": len(cases),
                      "seconds": round(time.time() - started, 2),
                      "out": str(out), "sha256": sha256(out)}, ensure_ascii=False))
    return 0


def features_for(cases: list[dict], archive_path: Path,
                 order: int = 0) -> dict[str, np.ndarray]:
    """Bind each case to its feature row through the cache's caseIds list."""
    binding = archive_path.with_name("cache-binding.json")
    with np.load(archive_path, allow_pickle=True) as archive:
        cand = archive["cand"]
    if not binding.exists():
        raise SystemExit(f"missing cache binding next to {archive_path}")
    case_ids = json.loads(binding.read_text())["caseIds"]
    per_case: dict[str, list[int]] = {}
    for index, case_id in enumerate(case_ids):
        per_case.setdefault(case_id, []).append(index)
    bound = {}
    for case in cases:
        rows = per_case.get(case["caseId"])
        if not rows:
            continue
        row = rows[order] if order < len(rows) else rows[0]
        bound[case["caseId"]] = cand[row]
    return bound


def cmd_train(args) -> int:
    """Torch autograd on the real head, non-affine LayerNorm inside the graph.

    Only rows whose split is `train` reach the optimiser; `dev` picks the
    checkpoint. The old version fed every split to training and selected on
    training loss, which is why its numbers were not an experiment.
    """
    import torch

    cases = load_cases(Path(args.cases))
    features = features_for(cases, Path(args.features), args.order)
    base = read_head(Path(args.head))

    def labelled(case):
        return features.get(case.get("caseId")) is not None and case.get("acceptableIds")

    train_rows = [c for c in cases if labelled(c) and (c.get("split") in (None, "train"))]
    dev_rows = [c for c in cases if labelled(c) and c.get("split") == "dev"]
    if not train_rows:
        print(json.dumps({"status": "blocked", "reason": "no train row with bound features"}))
        return 3

    def indices_for(case):
        ids = [candidate["id"] for candidate in case["candidates"]]
        return [ids.index(value) for value in case["acceptableIds"]]

    def loss_of(weight, case):
        hidden = torch.from_numpy(
            np.asarray(features[case["caseId"]], dtype=np.float32)).to(torch.float64)
        centered = hidden - hidden.mean(dim=-1, keepdim=True)
        variance = (centered ** 2).mean(dim=-1, keepdim=True)
        normalised = centered / torch.sqrt(variance + 1e-5)
        logits = normalised @ weight
        acceptable = torch.tensor(indices_for(case), dtype=torch.long)
        return (torch.logsumexp(logits, dim=0)
                - torch.logsumexp(logits[acceptable], dim=0))

    def evaluate(weight, rows):
        if not rows:
            return {"cases": 0, "meanLoss": None, "top1InAcceptable": None}
        total, correct = 0.0, 0
        with torch.no_grad():
            for case in rows:
                hidden = torch.from_numpy(
                    np.asarray(features[case["caseId"]], dtype=np.float32)).to(torch.float64)
                centered = hidden - hidden.mean(dim=-1, keepdim=True)
                variance = (centered ** 2).mean(dim=-1, keepdim=True)
                logits = (centered / torch.sqrt(variance + 1e-5)) @ weight
                total += float(loss_of(weight, case))
                correct += int(int(torch.argmax(logits)) in indices_for(case))
        return {"cases": len(rows), "meanLoss": round(total / len(rows), 6),
                "top1InAcceptable": correct / len(rows)}

    torch.manual_seed(args.seed)
    initial = (torch.from_numpy(base.astype(np.float32)).to(torch.float64)
               if args.init == "warm"
               else torch.randn(base.shape[0], dtype=torch.float64) * 0.02)
    weight = torch.nn.Parameter(initial.clone())
    optimiser = torch.optim.Adam([weight], lr=args.lr)
    best = {"epoch": 0, "weight": weight.detach().clone(),
            "dev": evaluate(weight.detach(), dev_rows)}
    curve = []
    for epoch in range(args.epochs):
        order = np.random.default_rng(args.seed + epoch).permutation(len(train_rows))
        total = 0.0
        for index in order:
            case = train_rows[int(index)]
            optimiser.zero_grad()
            loss = loss_of(weight, case)
            loss.backward()
            optimiser.step()
            total += float(loss)
        entry = {"epoch": epoch + 1, "trainLoss": round(total / len(train_rows), 6),
                 "dev": evaluate(weight.detach(), dev_rows)}
        curve.append(entry)
        dev_loss = entry["dev"]["meanLoss"]
        current = best["dev"]["meanLoss"]
        if dev_loss is not None and (current is None or dev_loss < current):
            best = {"epoch": epoch + 1, "weight": weight.detach().clone(), "dev": entry["dev"]}
    result = {"schema": "frostecho.jev05.action.train/2", "init": args.init,
              "cases": len(train_rows),
              "seed": args.seed, "epochs": args.epochs, "lr": args.lr,
              "trainCases": len(train_rows), "devCases": len(dev_rows),
              "selectedEpoch": best["epoch"], "dev": best["dev"],
              "curve": curve, "headInSha256": sha256(Path(args.head)),
              "renderer": RENDERER, "featureCacheSha256": sha256(Path(args.features)),
              "normalisation": "non-affine LayerNorm eps=1e-5 inside autograd",
              "note": "only train rows reached the optimiser; dev selected the checkpoint"}
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    np.save(out / f"weight-{args.init}-{args.seed}.npy",
            best["weight"].numpy().astype(np.float32))
    (out / f"result-{args.init}-{args.seed}.json").write_text(
        json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({key: result[key] for key in
                      ("init", "seed", "cases", "trainCases", "devCases",
                       "selectedEpoch", "dev")}, ensure_ascii=False))
    return 0


def cmd_score(args) -> int:
    weight = read_head(Path(args.head))
    cases = load_cases(Path(args.cases))
    features = features_for(cases, Path(args.features), args.order)
    rows = []
    for case in cases:
        cand = features.get(case["caseId"])
        if cand is None:
            continue
        logits = score_matrix(weight, cand)
        probabilities = softmax(logits)
        ids = [candidate["id"] for candidate in case["candidates"]]
        selected = ids[int(np.argmax(logits))]
        acceptable = case.get("acceptableIds") or []
        rows.append({"caseId": case["caseId"], "candidateSetHash": case.get("candidateSetHash"),
                     "selectedId": selected,
                     "logits": [round(float(value), 6) for value in logits],
                     "probabilities": [round(float(value), 6) for value in probabilities],
                     "acceptableIds": acceptable,
                     "top1Acceptable": (selected in acceptable) if acceptable else None,
                     "headSha256": sha256(Path(args.head)),
                     "renderer": RENDERER})
    labelled = [row for row in rows if row["top1Acceptable"] is not None]
    histogram: dict[str, int] = {}
    for row in rows:
        histogram[row["selectedId"]] = histogram.get(row["selectedId"], 0) + 1
    result = {"schema": "frostecho.jev05.action.score/1", "cases": len(rows),
              "labelledCases": len(labelled),
              "top1InAcceptable": ((sum(1 for row in labelled if row["top1Acceptable"])
                                    / len(labelled)) if labelled else None),
              "argmaxHistogram": histogram,
              "certifiesActions": False,
              "scope": "real head inference over real frozen features; unlabelled "
                       "presentations prove the path runs, not action accuracy",
              "rows": rows}
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps({"status": "scored", "cases": result["cases"],
                      "top1InAcceptable": result["top1InAcceptable"],
                      "out": str(out), "sha256": sha256(out)}, ensure_ascii=False))
    return 0


def cmd_calibrate(args) -> int:
    weight = read_head(Path(args.head))
    cases = load_cases(Path(args.cases))
    features = features_for(cases, Path(args.features), args.order)
    temperatures = [0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0, 5.0]
    best = None
    for temperature in temperatures:
        nlls = []
        for case in cases:
            cand = features.get(case["caseId"])
            if cand is None or not case.get("acceptableIds"):
                continue
            ids = [candidate["id"] for candidate in case["candidates"]]
            acceptable = [ids.index(value) for value in case["acceptableIds"]]
            logits = score_matrix(weight, cand) / temperature
            nlls.append(set_nll(logits, acceptable)[0])
        if not nlls:
            continue
        value = float(np.mean(nlls))
        if best is None or value < best["nll"]:
            best = {"temperature": temperature, "nll": round(value, 6),
                    "cases": len(nlls)}
    if best is None:
        print(json.dumps({"status": "blocked", "reason": "no labelled case with features"}))
        return 3
    result = {"schema": "frostecho.jev05.action.calibration/1", **best,
              "headSha256": sha256(Path(args.head)), "renderer": RENDERER,
              "featureCacheSha256": sha256(Path(args.features))}
    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(result, ensure_ascii=False, indent=2))
    print(json.dumps(result, ensure_ascii=False))
    return 0


def cmd_serve(args) -> int:
    """Line protocol: one ChoiceRequest in, one result out. Never invents ids."""
    weight = read_head(Path(args.head))
    feature_map = json.loads(Path(args.feature_map).read_text())
    certificate = args.data_certificate
    certified = False
    if certificate and Path(certificate).exists():
        try:
            document = json.loads(Path(certificate).read_text(encoding="utf-8"))
            certified = (document.get("schema") == "frostecho.jev.certificate/1"
                         and isinstance(document.get("samples"), int)
                         and document.get("samples", 0) > 0
                         and document.get("perSampleRecomputeSha256") not in (None, "", "0" * 64)
                         and document.get("headSha256") == sha256(Path(args.head)))
        except (OSError, ValueError):
            certified = False
    admitted = args.mode == "jev-admitted" and certified
    identity = {"mode": args.mode, "scorerId": "jev-joint-c/1",
                "checkpointSha256": sha256(Path(args.head)),
                "encoderId": str(ENCODER), "rendererId": RENDERER,
                "memoryPolicyId": args.memory_policy,
                "dataCertificateSha256": certificate if certified else None,
                "experimental": not admitted,
                # A mode flag can never mint an admission: a certificate decides.
                "countsAsAdmitted": admitted}
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        started = time.time()
        request = json.loads(line)
        candidates = request.get("candidates") or []
        matrix = []
        missing = []
        for candidate in candidates:
            key = candidate.get("parameters", {}).get("featureKey")
            row = feature_map.get(key) if key else None
            if row is None:
                missing.append(candidate.get("id"))
            else:
                matrix.append(row)
        if not candidates or missing:
            print(json.dumps({"requestId": request.get("requestId"),
                              "candidateSetHash": request.get("candidateSetHash"),
                              "error": "no_features_for_candidates",
                              "missing": missing}, ensure_ascii=False), flush=True)
            continue
        logits = score_matrix(weight, np.asarray(matrix, dtype=np.float32))
        probabilities = softmax_temperature(logits, args.temperature)
        order = np.argsort(-probabilities)
        print(json.dumps({
            "requestId": request["requestId"],
            "candidateSetHash": request["candidateSetHash"],
            "scores": [{"candidateId": candidate["id"],
                        "logit": round(float(logits[index]), 6),
                        "probability": round(float(probabilities[index]), 6)}
                       for index, candidate in enumerate(candidates)],
            "selectedId": candidates[int(order[0])]["id"],
            "disposition": "accept",
            "reason": (f"joint-c argmax at T={args.temperature}"
                       if admitted else
                       f"experimental (T={args.temperature}); "
                       f"admission refused: {'no certificate' if not certified else 'mode not admitted'}"),
            "admission": {"requested": args.mode, "granted": admitted,
                          "reason": None if admitted else (
                              "no data certificate" if not certified
                              else "mode is not admitted")},
            "identity": identity,
            "latencyMs": round((time.time() - started) * 1000, 3),
        }, ensure_ascii=False), flush=True)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="R8 action scorer: preflight/encode/train/calibrate/score/serve")
    parser.add_argument("--head", default=str(HEAD))
    parser.add_argument("--encoder", default=str(ENCODER))
    parser.add_argument("--features", default=None)
    parser.add_argument("--cases", default=None)
    parser.add_argument("--json", action="store_true")
    sub = parser.add_subparsers(dest="command", required=True)
    pre = sub.add_parser("preflight")
    pre.add_argument("--json", action="store_true")
    pre.set_defaults(func=cmd_preflight)
    enc = sub.add_parser("encode")
    enc.add_argument("--out", required=True)
    enc.add_argument("--max-length", type=int, default=1024)
    enc.set_defaults(func=cmd_encode)
    train = sub.add_parser("train")
    train.add_argument("--out", required=True)
    train.add_argument("--init", choices=["warm", "random"], default="warm")
    train.add_argument("--seed", type=int, default=17)
    train.add_argument("--epochs", type=int, default=40)
    train.add_argument("--lr", type=float, default=0.05)
    train.add_argument("--order", type=int, default=0)
    train.set_defaults(func=cmd_train)
    cal = sub.add_parser("calibrate")
    cal.add_argument("--out", required=True)
    cal.add_argument("--order", type=int, default=0)
    cal.set_defaults(func=cmd_calibrate)
    score = sub.add_parser("score")
    score.add_argument("--out", required=True)
    score.add_argument("--order", type=int, default=0)
    score.set_defaults(func=cmd_score)
    serve = sub.add_parser("serve")
    serve.add_argument("--feature-map", required=True)
    serve.add_argument("--mode", choices=["jev-experimental", "jev-admitted"],
                       default="jev-experimental")
    serve.add_argument("--temperature", type=float, default=1.0)
    serve.add_argument("--memory-policy", default="conditional-experience")
    serve.add_argument("--data-certificate", default=None)
    serve.set_defaults(func=cmd_serve)
    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    if getattr(args, "cases", None) is None and args.command in ("train", "calibrate",
                                                                   "score"):
        parser.error(f"{args.command} requires --cases")
    if getattr(args, "features", None) is None and args.command in ("train", "calibrate",
                                                                      "score"):
        parser.error(f"{args.command} requires --features")
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
