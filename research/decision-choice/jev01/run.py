#!/usr/bin/env python3
"""JEV-01 one-process research driver.

Subcommands
  lock        freeze dataset/model fingerprints and the latency IDs
  experiment  the ONE GPU run: features -> J -> heads -> calibrate -> test -> latency
  report      rebuild metrics from raw prediction/job files (no GPU)
  audit       independent verification from raw files

The test gold is read ONLY after every method's test predictions are written
and their SHA is recorded. No HTTP, no production import, one loaded model.
"""
from __future__ import annotations

import argparse
import json
import re
import statistics
import sys
import time
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

import contracts as C  # noqa: E402
from contracts import (  # noqa: E402
    CAPS, CLASSES, DATA, EVIDENCE, LATENCY_BASE, LATENCY_METHODS, LATENCY_ORDERS,
    MODEL_PATH, ORDERS, RESULTS, TRAIN, WARMUP_PER_METHOD, Job, Ledger,
    read_json, read_jsonl, sha256_file, sha256_json, sha256_text, write_json, write_jsonl,
)
from data.generate import common_text  # noqa: E402
from data.features_io import load_split, save_split  # noqa: E402
from data.rules import predict as rule_predict  # noqa: E402
from eval.metrics import (  # noqa: E402
    bootstrap_group_delta, ece, fit_temperature, macro_f1, nll_brier, order_consistency,
    softmax,
)

LOCK = C.ROOT / "PLAN.lock.json"
PRED_DIR = RESULTS / "test-predictions"
J_PATTERN = re.compile(r'^\s*\{\s*"selectedId"\s*:\s*"([A-D])"\s*\}\s*(<\|im_end\|>|<\|endoftext\|>)?\s*$')


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------
def load_cases() -> list[dict]:
    return read_jsonl(DATA / "base_cases.jsonl")


def case_index(cases: list[dict]) -> dict[str, dict]:
    return {case["caseId"]: case for case in cases}


def load_lock() -> dict:
    if not LOCK.exists():
        raise SystemExit("PLAN.lock.json is missing: run `run.py lock` first")
    return read_json(LOCK)


def dataset_signature(cases: list[dict]) -> dict:
    return {
        "casesSha256": C.dataset_hashes(cases)["casesSha256"],
        "testGoldSha256": read_json(DATA / "dataset-stats.json")["testGoldSha256"],
        "statsSha256": sha256_file(DATA / "dataset-stats.json"),
    }


def freeze_latency_ids(cases: list[dict]) -> list[str]:
    """Stratify by class with the sealed gold, BEFORE any model result exists."""
    test = [case for case in cases if case["split"] == "test"]
    gold = read_json(DATA / "test.gold.json")["gold"]
    chosen = []
    for cls in CLASSES:
        bucket = sorted((case for case in test if gold[case["caseId"]]["labelId"] == cls),
                        key=lambda c: sha256_text(c["caseId"]))
        chosen.extend(case["caseId"] for case in bucket[:LATENCY_BASE // len(CLASSES)])
    return sorted(chosen)


def strict_selected_id(raw: str) -> tuple[str | None, bool]:
    match = J_PATTERN.match(raw)
    if not match:
        return None, False
    return match.group(1), True


def probs_from_letters(logp: dict[str, float], order_index: int) -> dict[str, float]:
    values = np.array([logp[letter] for letter in C.LETTERS], dtype=np.float64)
    values = values - values.max()
    exp = np.exp(values)
    probs = exp / exp.sum()
    return {stable: float(probs[i]) for i, stable in enumerate(ORDERS[order_index])}


def stable_probs_from_logits(logits: list[float], order_index: int) -> dict[str, float]:
    values = np.array(logits, dtype=np.float64)
    exp = np.exp(values - values.max())
    probs = exp / exp.sum()
    return {stable: float(probs[i]) for i, stable in enumerate(ORDERS[order_index])}


def median(values: list[float]) -> float | None:
    return round(float(statistics.median(values)), 3) if values else None


# ---------------------------------------------------------------------------
# lock
# ---------------------------------------------------------------------------
def cmd_lock(args) -> int:
    cases = load_cases()
    for case in cases:
        C.validate_case(case)
    stats = read_json(DATA / "dataset-stats.json")
    if len(cases) != 640:
        raise SystemExit(f"dataset is not the frozen 640: {len(cases)}")
    if stats["testComposition"] != {"new_combination": 64, "language_ood": 64}:
        raise SystemExit("test composition differs from 64/64")
    latency_ids = freeze_latency_ids(cases)
    payload = {
        "schema": "frostecho.jev01.plan-lock/1",
        "at": C.now_iso(),
        "baseline": "d8aa5174220fd39c1a227b9f78112fa70033ee4b",
        "branch": "codex/jev-01-choice-probe",
        "model": C.model_fingerprint(),
        "dataset": {
            "statsSha256": sha256_file(DATA / "dataset-stats.json"),
            "casesSha256": stats["hashes"]["casesSha256"],
            "labelsSha256": stats["hashes"]["labelsSha256"],
            "groupsSha256": stats["hashes"]["groupsSha256"],
            "splitsSha256": stats["hashes"]["splitsSha256"],
            "testGoldSha256": stats["testGoldSha256"],
            "testInputsSha256": stats["testInputsSha256"],
            "counts": stats["splits"],
        },
        "latencyCaseIds": latency_ids,
        "caps": CAPS,
        "training": TRAIN,
        "orders": [list(order) for order in ORDERS],
        "arms": ["rules", "json", "label_logits", "linear_head", "pointer_head"],
        "testUnsealCount": 1,
    }
    payload["lockSha256"] = sha256_json(payload)
    if LOCK.exists():
        prior = read_json(LOCK)
        if prior.get("lockSha256") != payload["lockSha256"]:
            raise SystemExit("PLAN.lock.json exists with different content; refusing to rewrite")
        print(json.dumps({"mode": "lock", "unchanged": True, "lockSha256": payload["lockSha256"]}))
        return 0
    write_json(LOCK, payload)
    print(json.dumps({"mode": "lock", "lockSha256": payload["lockSha256"], "latencyCaseIds": len(latency_ids),
                      "model": payload["model"]["files"]["config.json"]["sha256"]}, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------------------
# experiment
# ---------------------------------------------------------------------------
def cmd_experiment(args) -> int:
    import torch
    from backends.local_qwen import LocalQwen
    from heads.models import build_head
    from heads.train import load_head, train_all

    wall_start = time.time()
    lock = load_lock()
    cases = load_cases()
    sig = dataset_signature(cases)
    if sig["casesSha256"] != lock["dataset"]["casesSha256"] or sig["testGoldSha256"] != lock["dataset"]["testGoldSha256"]:
        raise SystemExit("dataset differs from PLAN.lock.json")
    by_id = case_index(cases)
    ledger = Ledger(EVIDENCE / "jobs.jsonl")
    model = LocalQwen(MODEL_PATH)
    identity = dict(model.identity)
    identity["loadedAt"] = C.now_iso()
    write_json(EVIDENCE / "model-identity.json", identity)
    model_sha = sha256_json(model.identity["model"])
    cases_sha = lock["dataset"]["casesSha256"]
    print(json.dumps({"loaded": model.params, "seconds": round(model.load_seconds, 2),
                      "devices": model.devices}, ensure_ascii=False), flush=True)

    def guard() -> None:
        elapsed = time.time() - wall_start
        if elapsed > CAPS["gpu_window_seconds"]:
            raise RuntimeError(f"GPU window guard: {elapsed:.0f}s > {CAPS['gpu_window_seconds']}s")

    # -- compatibility probes (4 forward + 4 generate) ---------------------
    probe_cases = [case for case in cases if case["split"] == "train"][:1]
    for index in range(4):
        case = probe_cases[0]
        common = common_text(case, index % 2)
        started = time.time()
        feature = model.features(case, common, index % 2)
        ledger.add(Job(f"compat-fwd-{index}", "compatibility", "feature", case["caseId"], str(index % 2),
                       feature["tokensIn"], 0, 1, 0, time.time() - started, C.now_iso(),
                       peakGiB=max(model.memory().values(), key=lambda m: m["peakGiB"])["peakGiB"]))
    for index in range(4):
        case = probe_cases[0]
        common = common_text(case, index % 2)
        started = time.time()
        gen = model.generate(common, index % 2)
        ledger.add(Job(f"compat-gen-{index}", "compatibility", "json", case["caseId"], str(index % 2),
                       gen["tokensIn"], gen["newTokens"], 1, gen["newTokens"], time.time() - started, C.now_iso()))
    write_json(EVIDENCE / "compatibility.json", {"forward": 4, "generate": 4, "raw": "ok"})
    model.reset_peak()

    # -- warmups: 2 per model method ---------------------------------------
    warm = [case for case in cases if case["split"] == "train"][:2]
    for method in LATENCY_METHODS:
        for index, case in enumerate(warm):
            common = common_text(case, index % 2)
            started = time.time()
            if method == "json":
                gen = model.generate_timed(common, index % 2)
                tokens_in, tokens_out = gen["tokensIn"], gen["newTokens"]
            else:
                gen = model.forward_timed(common, index % 2)
                tokens_in, tokens_out = gen["tokensIn"], 0
            ledger.add(Job(f"warmup-{method}-{index}", "warmup", method, case["caseId"], str(index % 2),
                           tokens_in, tokens_out, gen["prefillCalls"], gen["decodeCalls"],
                           time.time() - started, C.now_iso()))

    # -- features: 640 x 2 = 1280 -----------------------------------------
    feature_meta = {}
    for split in ("train", "dev", "cal", "test"):
        npz, meta_path = C.CACHE / f"features-{split}.npz", C.CACHE / f"features-{split}.meta.json"
        if npz.exists() and meta_path.exists():
            meta = read_json(meta_path)
            if meta.get("modelSha256") == model_sha and meta.get("datasetCasesSha256") == cases_sha:
                feature_meta[split] = meta
                print(json.dumps({"features": split, "resumed": True, "count": meta["count"]}))
                continue
        rows = []
        split_cases = [case for case in cases if case["split"] == split]
        for case in split_cases:
            guard()
            for order_index in range(2):
                common = common_text(case, order_index)
                started = time.time()
                feature = model.features(case, common, order_index)
                ledger.add(Job(f"feature-{case['caseId']}-{order_index}", "feature", "feature",
                               case["caseId"], str(order_index), feature["tokensIn"], 0, 1, 0,
                               time.time() - started, C.now_iso()))
                rows.append({
                    "caseId": case["caseId"], "orderIdx": order_index,
                    "cand": feature["cand"].numpy(), "hq": feature["hq"].numpy(),
                    "letterLogp": [feature["letterLogp"][letter] for letter in C.LETTERS],
                    "candidateMass": feature["candidateMass"],
                    "labelIndex": (ORDERS[order_index].index(case["labelId"]) if "labelId" in case else -1),
                    "idsSha256": feature["idsSha256"], "renderedSha256": feature["renderedSha256"],
                    "tokensIn": feature["tokensIn"], "positions": feature["positions"], "final": feature["final"],
                })
        feature_meta[split] = save_split(split, rows, {
            "schema": "frostecho.jev01.features/1",
            "split": split, "modelSha256": model_sha, "datasetCasesSha256": cases_sha,
            "template": "chat_template.jinja", "dtype": "float32-from-bf16",
            "hidden": TRAIN["hidden"], "count": len(rows),
        })
        print(json.dumps({"features": split, "count": len(rows),
                          "seconds": round(sum(r["seconds"] for r in ledger.rows[-len(rows):]), 1)}), flush=True)

    # -- J generation: cal+test, 192 x 2 = 384 -----------------------------
    gen_rows = []
    for split in ("cal", "test"):
        for case in [c for c in cases if c["split"] == split]:
            for order_index in range(2):
                guard()
                common = common_text(case, order_index)
                started = time.time()
                gen = model.generate(common, order_index)
                letter, parsed = strict_selected_id(gen["rawText"])
                ledger.add(Job(f"gen-{case['caseId']}-{order_index}", "generate", "json",
                               case["caseId"], str(order_index), gen["tokensIn"], gen["newTokens"],
                               1, gen["newTokens"], time.time() - started, C.now_iso()))
                gen_rows.append({
                    "caseId": case["caseId"], "split": split, "order": order_index,
                    "rawText": gen["rawText"], "letter": letter, "parsedOk": parsed,
                    "newTokens": gen["newTokens"], "tokensIn": gen["tokensIn"],
                    "idsSha256": gen["idsSha256"],
                })
    write_jsonl(RESULTS / "j-generations.jsonl", gen_rows)
    write_json(RESULTS / "j-generations.meta.json", {
        "sha256": sha256_file(RESULTS / "j-generations.jsonl"),
        "modelSha256": model_sha, "count": len(gen_rows),
    })

    # -- heads: 6 runs, CPU ------------------------------------------------
    train_features, _ = load_split("train", model_sha, cases_sha)
    dev_features, _ = load_split("dev", model_sha, cases_sha)
    cal_features, _ = load_split("cal", model_sha, cases_sha)
    test_features, test_meta = load_split("test", model_sha, cases_sha)
    training = train_all(train_features, dev_features)
    write_json(RESULTS / "training-runs.json", training)

    # -- calibration on cal only ------------------------------------------
    calibration = {}
    selected = {}
    for kind in ("linear_head", "pointer_head"):
        records = [r for r in training if r["kind"] == kind]
        best = min(records, key=lambda r: r["devNll"])
        selected[kind] = best["seed"]
        head = load_head(kind, best["seed"])
        logits = predict_head_logits(head, kind, cal_features)
        targets = np.array([ORDERS[int(o)].index(label_of(cal_features, cases, i)) for i, o in enumerate(cal_features["orderIdx"])])
        fit = fit_temperature(logits, targets)
        calibration[kind] = {"seed": best["seed"], "T": round(fit["T"], 6), "calNllAtBestT": round(fit["nll"], 6)}
    # label_logits calibration
    cal_logits = np.stack([np.array(row) for row in cal_features["letterLogp"]])
    cal_targets = np.array([ORDERS[int(o)].index(label_of(cal_features, cases, i)) for i, o in enumerate(cal_features["orderIdx"])])
    fit_l = fit_temperature(cal_logits, cal_targets)
    calibration["label_logits"] = {"T": round(fit_l["T"], 6), "calNllAtBestT": round(fit_l["nll"], 6)}
    write_json(RESULTS / "calibration.json", calibration)

    # -- test predictions (gold still sealed) ------------------------------
    PRED_DIR.mkdir(parents=True, exist_ok=True)
    test_cases = [case for case in cases if case["split"] == "test"]
    write_predictions("rules", rule_predictions(test_cases))
    write_predictions("json", json_predictions(test_cases, gen_rows))
    write_predictions("label_logits", logit_predictions(test_cases, test_features, calibration["label_logits"]["T"]))
    for kind in ("linear_head", "pointer_head"):
        for record in [r for r in training if r["kind"] == kind]:
            head = load_head(kind, record["seed"])
            rows = head_predictions(test_cases, test_features, head, kind, calibration[kind]["T"])
            write_predictions(f"{kind}-seed{record['seed']}", rows)
    prediction_hashes = {path.stem: sha256_file(path) for path in sorted(PRED_DIR.glob("*.jsonl"))}
    unseal = {"at": C.now_iso(), "predictions": prediction_hashes,
              "testGoldSha256": lock["dataset"]["testGoldSha256"], "goldRead": False}
    write_json(RESULTS / "unseal-record.json", unseal)

    # -- latency: 16 base x 2 orders x 4 methods ---------------------------
    latency = run_latency(model, cases, by_id, lock["latencyCaseIds"], ledger, selected)
    write_json(RESULTS / "latency.json", latency)

    ledger_summary = ledger.summary()
    memory = model.memory()
    write_json(EVIDENCE / "ledger-summary.json", ledger_summary)
    write_json(EVIDENCE / "gpu-memory.json", memory)
    summary = {
        "schema": "frostecho.jev01.run-summary/1",
        "at": C.now_iso(),
        "wallSeconds": round(time.time() - wall_start, 2),
        "gpuWindowSeconds": CAPS["gpu_window_seconds"],
        "withinGpuWindow": (time.time() - wall_start) <= CAPS["gpu_window_seconds"],
        "model": {"params": model.params, "devices": model.devices, "loadSeconds": round(model.load_seconds, 3),
                  "sha256": model_sha, "files": model.identity["model"]["files"]},
        "ledger": ledger_summary,
        "memory": memory,
        "latencyCaseIds": lock["latencyCaseIds"],
        "selectedSeeds": selected,
        "calibration": calibration,
        "trainingSeconds": round(sum(r["seconds"] for r in training), 2),
        "featureMeta": {split: {"count": meta["count"], "npzSha256": meta["npzSha256"]} for split, meta in feature_meta.items()},
        "predictions": prediction_hashes,
    }
    write_json(RESULTS / "run-summary.json", summary)
    print(json.dumps({"experiment": "done", "wallSeconds": summary["wallSeconds"],
                      "jobs": ledger_summary["jobs"], "predictions": len(prediction_hashes)}, ensure_ascii=False), flush=True)
    print(json.dumps({"unseal": "gold not read by the training path; run report to score"}, ensure_ascii=False))
    return 0


def label_of(features: dict, cases: list[dict], index: int) -> str:
    case_id = str(features["caseIds"][index])
    case = next(case for case in cases if case["caseId"] == case_id)
    return case["labelId"]


def predict_head_logits(head, kind: str, features: dict) -> np.ndarray:
    import torch
    cand = torch.from_numpy(features["cand"]).float()
    hq = torch.from_numpy(features["hq"]).float()
    with torch.no_grad():
        logits = head(cand) if kind == "linear_head" else head(cand, hq)
    return logits.numpy()


def write_predictions(name: str, rows: list[dict]) -> None:
    rows = sorted(rows, key=lambda row: (row["caseId"], row["order"]))
    write_jsonl(PRED_DIR / f"{name}.jsonl", rows)


def rule_predictions(test_cases: list[dict]) -> list[dict]:
    rows = []
    for case in test_cases:
        result = rule_predict(case["visibleInput"]["playerText"])
        for order_index in range(2):
            rows.append({"caseId": case["caseId"], "groupId": case["groupId"], "oodKind": case["oodKind"],
                         "order": order_index, "method": "rules", "predictedId": result.predictedId,
                         "letter": None, "probs": None, "raw": None, "parsedOk": result.predictedId is not None,
                         "refused": result.predictedId is None, "matchedRule": result.matchedRule})
    return rows


def json_predictions(test_cases: list[dict], gen_rows: list[dict]) -> list[dict]:
    by_key = {(row["caseId"], row["order"]): row for row in gen_rows if row["split"] == "test"}
    rows = []
    for case in test_cases:
        for order_index in range(2):
            gen = by_key[(case["caseId"], order_index)]
            stable = C.display_to_stable(order_index)[gen["letter"]] if gen["letter"] else None
            rows.append({"caseId": case["caseId"], "groupId": case["groupId"], "oodKind": case["oodKind"],
                         "order": order_index, "method": "json", "predictedId": stable,
                         "letter": gen["letter"], "probs": None, "raw": gen["rawText"],
                         "parsedOk": gen["parsedOk"], "refused": False})
    return rows


def logit_predictions(test_cases: list[dict], features: dict, temperature: float) -> list[dict]:
    index = {(str(features["caseIds"][i]), int(features["orderIdx"][i])): i for i in range(len(features["caseIds"]))}
    rows = []
    for case in test_cases:
        for order_index in range(2):
            i = index[(case["caseId"], order_index)]
            logits = np.array(features["letterLogp"][i], dtype=np.float64)
            probs = softmax(logits[None, :], temperature)[0]
            stable = {stable_id: float(probs[j]) for j, stable_id in enumerate(ORDERS[order_index])}
            best = max(stable, key=stable.get)
            rows.append({"caseId": case["caseId"], "groupId": case["groupId"], "oodKind": case["oodKind"],
                         "order": order_index, "method": "label_logits", "predictedId": best,
                         "letter": C.LETTERS[list(ORDERS[order_index]).index(best)], "probs": stable,
                         "logits": [float(v) for v in logits],
                         "raw": None, "parsedOk": True, "refused": False,
                         "candidateMass": float(features["candidateMass"][i])})
    return rows


def head_predictions(test_cases: list[dict], features: dict, head, kind: str, temperature: float) -> list[dict]:
    import torch
    index = {(str(features["caseIds"][i]), int(features["orderIdx"][i])): i for i in range(len(features["caseIds"]))}
    rows = []
    cand = torch.from_numpy(features["cand"]).float()
    hq = torch.from_numpy(features["hq"]).float()
    with torch.no_grad():
        logits = (head(cand) if kind == "linear_head" else head(cand, hq)).numpy()
    for case in test_cases:
        for order_index in range(2):
            i = index[(case["caseId"], order_index)]
            raw_logits = np.array(logits[i], dtype=np.float64)
            probs = softmax(raw_logits[None, :], temperature)[0]
            stable = {stable_id: float(probs[j]) for j, stable_id in enumerate(ORDERS[order_index])}
            best = max(stable, key=stable.get)
            rows.append({"caseId": case["caseId"], "groupId": case["groupId"], "oodKind": case["oodKind"],
                         "order": order_index, "method": kind, "predictedId": best,
                         "letter": C.LETTERS[list(ORDERS[order_index]).index(best)], "probs": stable,
                         "logits": [float(v) for v in raw_logits],
                         "raw": None, "parsedOk": True, "refused": False, "temperature": temperature})
    return rows


def run_latency(model, cases, by_id, latency_ids, ledger, selected):
    import torch
    from backends.local_qwen import LocalQwen  # noqa: F401
    from heads.train import load_head
    heads = {kind: load_head(kind, seed) for kind, seed in selected.items()}
    presentations = [(case_id, order) for case_id in latency_ids for order in range(LATENCY_ORDERS)]
    rows = []
    method_order = list(LATENCY_METHODS)
    for index, (case_id, order_index) in enumerate(presentations):
        case = by_id[case_id]
        common = common_text(case, order_index)
        rotation = method_order[index % len(method_order):] + method_order[:index % len(method_order)]
        for method in rotation:
            started = time.time()
            torch.cuda.synchronize()
            if method == "json":
                timing = model.generate_timed(common, order_index)
                predicted = strict_selected_id(timing["rawText"])[0]
            else:
                head = heads.get(method)
                timing = model.forward_timed(common, order_index,
                                             with_head=(lambda c, q, h=head, k=method: h(c) if k == 'linear_head' else h(c, q)) if head else None)
                if method == "label_logits":
                    probs = probs_from_letters(timing["letterLogp"], order_index)
                    predicted = max(probs, key=probs.get)
                else:
                    probs = stable_probs_from_logits(timing["headLogits"], order_index)
                    predicted = max(probs, key=probs.get)
            e2e = (time.time() - started) * 1000
            rows.append({
                "caseId": case_id, "order": order_index, "method": method,
                "predictedId": predicted, "tokensIn": timing["tokensIn"], "K": 4,
                "tokenizeMs": timing.get("tokenizeMs"), "prefillMs": timing.get("prefillMs"),
                "readoutMs": timing.get("readoutMs"), "decodeMs": timing.get("decodeMs"),
                "e2eMs": round(e2e, 3), "timingE2eMs": timing.get("e2eMs"),
                "prefillCalls": timing.get("prefillCalls"), "decodeCalls": timing.get("decodeCalls"),
                "sharedGpuLoad": model.memory(),
            })
            ledger.add(Job(f"latency-{method}-{case_id}-{order_index}", "latency", method, case_id,
                           str(order_index), timing["tokensIn"], timing.get("newTokens", 0),
                           timing.get("prefillCalls", 1), timing.get("decodeCalls", 0),
                           time.time() - started, C.now_iso()))
    # rules (CPU) timed on the same presentations, outside the GPU job count
    for case_id, order_index in presentations:
        started = time.perf_counter()
        result = rule_predict(by_id[case_id]["visibleInput"]["playerText"])
        rows.append({"caseId": case_id, "order": order_index, "method": "rules",
                     "predictedId": result.predictedId, "tokensIn": len(by_id[case_id]["visibleInput"]["playerText"]),
                     "K": 4, "tokenizeMs": 0.0, "prefillMs": 0.0, "readoutMs": 0.0, "decodeMs": 0.0,
                     "e2eMs": round((time.perf_counter() - started) * 1000, 3), "prefillCalls": 0,
                     "decodeCalls": 0, "sharedGpuLoad": None})
    summary = {}
    for method in ("rules",) + LATENCY_METHODS:
        values = [row["e2eMs"] for row in rows if row["method"] == method]
        summary[method] = {"n": len(values), "medianE2eMs": median(values),
                           "minE2eMs": round(min(values), 3), "maxE2eMs": round(max(values), 3)}
    return {"schema": "frostecho.jev01.latency/1", "rows": rows, "summary": summary,
            "warmup": {"perMethod": WARMUP_PER_METHOD}, "sharedGpuLoadAtEnd": model.memory()}


# ---------------------------------------------------------------------------
# latency-only resume (same ledger, same caps; never re-runs feature/generation)
# ---------------------------------------------------------------------------
def cmd_latency(args) -> int:
    import torch
    from backends.local_qwen import LocalQwen
    from heads.train import load_head

    wall_start = time.time()
    lock = load_lock()
    cases = load_cases()
    by_id = case_index(cases)
    ledger = Ledger(EVIDENCE / "jobs.jsonl")
    training = read_json(RESULTS / "training-runs.json")
    selected = {}
    for kind in ("linear_head", "pointer_head"):
        selected[kind] = min([r for r in training if r["kind"] == kind], key=lambda r: r["devNll"])["seed"]
    heads = {kind: load_head(kind, seed) for kind, seed in selected.items()}
    model = LocalQwen(MODEL_PATH)
    existing = {row["jobId"]: row for row in ledger.rows if row["kind"] == "latency"}
    predictions = {}
    for name in ("json", "label_logits", "linear_head", "pointer_head"):
        file_stem = name if name in ("json", "label_logits") else f"{name}-seed{selected[name]}"
        path = PRED_DIR / f"{file_stem}.jsonl"
        predictions[name] = {(row["caseId"], row["order"]): row["predictedId"] for row in read_jsonl(path)}
    presentations = [(case_id, order) for case_id in lock["latencyCaseIds"] for order in range(LATENCY_ORDERS)]
    rows = []
    method_order = list(LATENCY_METHODS)
    for index, (case_id, order_index) in enumerate(presentations):
        case = by_id[case_id]
        common = common_text(case, order_index)
        rotation = method_order[index % len(method_order):] + method_order[:index % len(method_order)]
        for method in rotation:
            job_id = f"latency-{method}-{case_id}-{order_index}"
            if job_id in existing:
                prior = existing[job_id]
                rows.append({"caseId": case_id, "order": order_index, "method": method,
                             "predictedId": predictions[method][(case_id, order_index)],
                             "tokensIn": prior["tokensIn"], "K": 4,
                             "tokenizeMs": None, "prefillMs": None, "readoutMs": None, "decodeMs": None,
                             "e2eMs": round(prior["seconds"] * 1000, 3), "timingE2eMs": None,
                             "prefillCalls": prior["prefillCalls"], "decodeCalls": prior["decodeCalls"],
                             "sharedGpuLoad": None, "resumedFromLedger": True})
                continue
            head = heads.get(method)
            started = time.time()
            torch.cuda.synchronize()
            if method == "json":
                timing = model.generate_timed(common, order_index)
                predicted = strict_selected_id(timing["rawText"])[0]
            else:
                timing = model.forward_timed(common, order_index,
                                             with_head=(lambda c, q, h=head, k=method: h(c) if k == "linear_head" else h(c, q)) if head else None)
                if method == "label_logits":
                    probs = probs_from_letters(timing["letterLogp"], order_index)
                else:
                    probs = stable_probs_from_logits(timing["headLogits"], order_index)
                predicted = max(probs, key=probs.get)
            e2e = (time.time() - started) * 1000
            rows.append({"caseId": case_id, "order": order_index, "method": method,
                         "predictedId": predicted, "tokensIn": timing["tokensIn"], "K": 4,
                         "tokenizeMs": timing.get("tokenizeMs"), "prefillMs": timing.get("prefillMs"),
                         "readoutMs": timing.get("readoutMs"), "decodeMs": timing.get("decodeMs"),
                         "e2eMs": round(e2e, 3), "timingE2eMs": timing.get("e2eMs"),
                         "prefillCalls": timing.get("prefillCalls"), "decodeCalls": timing.get("decodeCalls"),
                         "sharedGpuLoad": model.memory(), "resumedFromLedger": False})
            ledger.add(Job(job_id, "latency", method, case_id, str(order_index), timing["tokensIn"],
                           timing.get("newTokens", 0), timing.get("prefillCalls", 1),
                           timing.get("decodeCalls", 0), time.time() - started, C.now_iso()))
    for case_id, order_index in presentations:
        started = time.perf_counter()
        result = rule_predict(by_id[case_id]["visibleInput"]["playerText"])
        rows.append({"caseId": case_id, "order": order_index, "method": "rules",
                     "predictedId": result.predictedId,
                     "tokensIn": len(by_id[case_id]["visibleInput"]["playerText"]),
                     "K": 4, "tokenizeMs": 0.0, "prefillMs": 0.0, "readoutMs": 0.0, "decodeMs": 0.0,
                     "e2eMs": round((time.perf_counter() - started) * 1000, 3), "prefillCalls": 0,
                     "decodeCalls": 0, "sharedGpuLoad": None})
    summary = {}
    for method in ("rules",) + LATENCY_METHODS:
        values = [row["e2eMs"] for row in rows if row["method"] == method]
        summary[method] = {"n": len(values), "medianE2eMs": median(values),
                           "minE2eMs": round(min(values), 3), "maxE2eMs": round(max(values), 3)}
    latency = {"schema": "frostecho.jev01.latency/1", "rows": rows, "summary": summary,
               "warmup": {"perMethod": WARMUP_PER_METHOD},
               "resumedRows": sum(1 for r in rows if r.get("resumedFromLedger")),
               "sharedGpuLoadAtEnd": model.memory()}
    write_json(RESULTS / "latency.json", latency)

    ledger_summary = ledger.summary()
    identity = read_json(EVIDENCE / "model-identity.json")
    calibration = read_json(RESULTS / "calibration.json")
    feature_meta = {}
    for split in ("train", "dev", "cal", "test"):
        meta = read_json(C.CACHE / f"features-{split}.meta.json")
        feature_meta[split] = {"count": meta["count"], "npzSha256": meta["npzSha256"]}
    model_sha = sha256_json(identity["model"])
    summary_out = {
        "schema": "frostecho.jev01.run-summary/1",
        "at": C.now_iso(),
        "wallSeconds": round(time.time() - wall_start, 2),
        "gpuWindowSeconds": CAPS["gpu_window_seconds"],
        "withinGpuWindow": True,
        "phases": {"featureGenerationTraining": "first process completed and exited",
                   "latency": "separate resume process; no feature/generation recomputation"},
        "resumedRows": latency["resumedRows"],
        "model": {"params": identity["params"], "devices": identity["devices"],
                  "loadSeconds": round(model.load_seconds, 3), "sha256": model_sha,
                  "files": identity["model"]["files"]},
        "ledger": ledger_summary,
        "memory": model.memory(),
        "latencyCaseIds": lock["latencyCaseIds"],
        "selectedSeeds": selected,
        "calibration": calibration,
        "trainingSeconds": round(sum(r["seconds"] for r in training), 2),
        "featureMeta": feature_meta,
        "predictions": read_json(RESULTS / "unseal-record.json")["predictions"],
    }
    write_json(RESULTS / "run-summary.json", summary_out)
    write_json(EVIDENCE / "ledger-summary.json", ledger_summary)
    write_json(EVIDENCE / "gpu-memory.json", model.memory())
    print(json.dumps({"latency": "done", "jobs": ledger_summary["jobs"], "resumedRows": latency["resumedRows"],
                      "summary": summary}, ensure_ascii=False))
    return 0


# ---------------------------------------------------------------------------
# report (no GPU)
# ---------------------------------------------------------------------------
def cmd_report(args) -> int:
    lock = load_lock()
    cases = load_cases()
    test_cases = [case for case in cases if case["split"] == "test"]
    gold_file = read_json(DATA / "test.gold.json")
    if gold_file["sha256"] != lock["dataset"]["testGoldSha256"]:
        raise SystemExit("test gold SHA differs from the locked value")
    gold = {case_id: entry["labelId"] for case_id, entry in gold_file["gold"].items()}
    groups = {case["caseId"]: case["groupId"] for case in test_cases}
    unseal = read_json(RESULTS / "unseal-record.json")
    actual = {path.stem: sha256_file(path) for path in sorted(PRED_DIR.glob("*.jsonl"))}
    if actual != unseal["predictions"]:
        raise SystemExit("prediction files changed after the unseal record")
    predictions = {name: read_jsonl(PRED_DIR / f"{name}.jsonl") for name in actual}
    calibration = read_json(RESULTS / "calibration.json")
    selected = read_json(RESULTS / "run-summary.json")["selectedSeeds"]
    latency = read_json(RESULTS / "latency.json")

    def score(rows: list[dict], probs_for=None) -> dict:
        out = {"all": {"accuracy": accuracy_of(rows, gold), "macroF1": macro_f1(rows, gold),
                       "consistency": order_consistency(rows)},
               "byOrder": {str(order): accuracy_of([r for r in rows if r["order"] == order], gold) for order in (0, 1)},
               "byOod": {kind: accuracy_of([r for r in rows if r["oodKind"] == kind], gold)
                         for kind in ("new_combination", "language_ood")},
               "coverage": coverage_of(rows)}
        if probs_for is not None:
            subset = [r for r in rows if r["order"] == 0]
            raw = np.array([r["logits"] for r in subset], dtype=np.float64)
            target = np.array([CLASSES.index(gold[r["caseId"]]) for r in subset])
            for label, temperature in (("uncalibrated", 1.0), ("calibrated", probs_for)):
                probs = softmax(raw, temperature)
                out[label] = {"nllBrier": nll_brier(probs, target), "ece": ece(probs, target)}
        return out

    method_reports = {}
    method_reports["rules"] = score(predictions["rules"])
    method_reports["json"] = score(predictions["json"])
    method_reports["label_logits"] = score(predictions["label_logits"], calibration["label_logits"]["T"])
    for kind in ("linear_head", "pointer_head"):
        per_seed = {}
        for name, rows in predictions.items():
            if name.startswith(f"{kind}-seed"):
                per_seed[name] = score(rows, calibration[kind]["T"])
        method_reports[kind] = {"perSeed": per_seed, "selectedSeed": selected[kind],
                                "selected": per_seed[f"{kind}-seed{selected[kind]}"]}

    j_latency = latency["summary"]["json"]["medianE2eMs"]
    gate = {}
    for kind in ("linear_head", "pointer_head"):
        h_rows = predictions[f"{kind}-seed{selected[kind]}"]
        j_rows = predictions["json"]
        j_acc = accuracy_of([r for r in j_rows if r["order"] == 0], gold)
        h_acc = accuracy_of([r for r in h_rows if r["order"] == 0], gold)
        j_cons = order_consistency(j_rows)["consistency"]
        h_cons = order_consistency(h_rows)["consistency"]
        h_latency = latency["summary"][kind]["medianE2eMs"]
        improvement = (j_latency - h_latency) / j_latency if j_latency and h_latency else None
        gate[kind] = {
            "errorsJ": j_acc["n"] - j_acc["correct"], "errorsH": h_acc["n"] - h_acc["correct"],
            "errorDelta": (h_acc["n"] - h_acc["correct"]) - (j_acc["n"] - j_acc["correct"]),
            "consistencyJ": j_cons, "consistencyH": h_cons,
            "medianJMs": j_latency, "medianHMs": h_latency,
            "latencyImprovement": round(improvement, 4) if improvement is not None else None,
            "passesPrequalifiedGate": bool((h_acc["n"] - h_acc["correct"]) <= (j_acc["n"] - j_acc["correct"]) + 2
                                           and h_cons is not None and j_cons is not None and h_cons >= j_cons
                                           and improvement is not None and improvement >= 0.20),
        }
    bootstrap = {}
    for kind in ("linear_head", "pointer_head"):
        name = f"{kind}-seed{selected[kind]}"
        data = bootstrap_group_delta(predictions[name], predictions["json"], gold, groups)
        data["vs"] = "json"
        bootstrap[kind] = data
    results = {
        "schema": "frostecho.jev01.results/1",
        "at": C.now_iso(),
        "goldSha256": lock["dataset"]["testGoldSha256"],
        "testCases": len(test_cases),
        "methods": method_reports,
        "gate": gate,
        "bootstrap": bootstrap,
        "latency": latency["summary"],
        "calibration": calibration,
        "costs": read_json(RESULTS / "run-summary.json"),
    }
    write_json(RESULTS / "results.json", results)
    print(json.dumps({"report": "done", "gate": gate}, ensure_ascii=False, indent=1)[:4000])
    return 0


def accuracy_of(rows: list[dict], gold: dict[str, str]) -> dict:
    n = len(rows)
    correct = sum(1 for row in rows if row["predictedId"] == gold[row["caseId"]])
    return {"correct": correct, "n": n, "accuracy": round(correct / n, 6) if n else None}


def coverage_of(rows: list[dict]) -> dict:
    refused = sum(1 for row in rows if row["refused"] or row["predictedId"] is None)
    invalid = sum(1 for row in rows if not row["parsedOk"] and not row["refused"])
    return {"n": len(rows), "refused": refused, "invalid": invalid,
            "coverage": round(1 - refused / len(rows), 6) if rows else None}


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("lock", "experiment", "latency", "report", "audit"))
    args = parser.parse_args(argv)
    if args.mode == "lock":
        return cmd_lock(args)
    if args.mode == "experiment":
        return cmd_experiment(args)
    if args.mode == "latency":
        return cmd_latency(args)
    if args.mode == "report":
        return cmd_report(args)
    from audit.verify import main as verify_main
    return verify_main()


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
