#!/usr/bin/env python3
"""JEV-02 driver: lock -> features -> J -> train -> calibrate -> predictions -> latency."""
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

import contracts as C
from contracts import (CAPS, CLASSES, DATA, EVIDENCE, MODEL_PATH, ORDERS, RESULTS, RUNS, TRAIN,
                       read_json, read_jsonl, sha256_file, sha256_json, sha256_text, write_json, write_jsonl)
from data.features_io import load_split
from data.rules import predict as rule_predict
from eval.metrics import ece, macro_f1, nll_brier, order_consistency, softmax

LOCK = C.ROOT / "PLAN.lock.json"
PRED = RESULTS / "test-predictions"
J_PATTERN = re.compile(r'^\s*\{\s*"selectedId"\s*:\s*"([A-D])"\s*\}\s*(<\|im_end\|>)?\s*$')
METHODS = ("rules", "json", "label_logits", "old_h0", "M1", "M2")
LATENCY_METHODS = ("json", "label_logits", "old_h0", "M1", "M2")
WARMUP_PER_METHOD = 2


def load_cases(split: str) -> list[dict]:
    if split == "test":
        # Inputs only: the label-bearing file is never opened by the model path.
        return read_jsonl(DATA / "test.inputs.jsonl")
    return read_jsonl(DATA / f"{split}.jsonl")




def reserve_new(ledger, job_id: str, kind: str, arm: str, meta: dict | None = None):
    """Resume-safe: an already reserved job is never charged twice."""
    if job_id in ledger.reserved:
        return None
    return ledger.reserve(job_id, kind, arm, meta)

def lock() -> int:
    stats = read_json(DATA / "train-stats.json")
    test_stats = read_json(DATA / "test-stats.json")
    gold = read_json(DATA / "test.gold.json")
    test_cases = read_jsonl(DATA / "test.inputs.jsonl")
    by_class = {cls: sorted((row["caseId"] for row in test_cases
                             if gold["gold"][row["caseId"]]["labelId"] == cls), key=sha256_text) for cls in CLASSES}
    latency_ids = [case for cls in CLASSES for case in by_class[cls][:2]]
    payload = {
        "schema": "frostecho.jev02.plan-lock/1",
        "at": C.now_iso(),
        "baseline": "5c1e033",
        "branch": "codex/jev-02-overnight",
        "model": C.model_fingerprint(),
        "data": {"trainStatsSha": sha256_file(DATA / "train-stats.json"),
                 "testStatsSha": sha256_file(DATA / "test-stats.json"),
                 "testGoldSha256": gold["sha256"], "testInputsSha256": test_stats["testInputsSha256"],
                 "hashes": stats["hashes"], "splits": stats["splits"]},
        "latencyCaseIds": latency_ids,
        "caps": CAPS, "training": TRAIN,
        "orders": [list(order) for order in ORDERS],
        "arms": list(METHODS),
    }
    payload["lockSha256"] = sha256_json(payload)
    write_json(LOCK, payload)
    print(json.dumps({"lock": payload["lockSha256"][:16], "latency": len(latency_ids),
                      "data": stats["splits"], "gold": gold["sha256"][:16]}))
    return 0


def features_all(model, ledger, model_sha, hashes) -> dict:
    C.CACHE.mkdir(parents=True, exist_ok=True)
    meta = {}
    for split in ("train", "dev", "cal", "test"):
        cases = load_cases(split)
        npz = C.CACHE / f"features-{split}.npz"
        meta_path = C.CACHE / f"features-{split}.meta.json"
        if npz.exists() and meta_path.exists():
            meta[split] = read_json(meta_path)
            continue
        rows = []
        for case in cases:
            for order in range(4):
                job = ledger.reserve(f"feature-{case['caseId']}-{order}", "feature", "shared", {"split": split})
                ledger.begin(job)
                started = time.time()
                try:
                    feature = model.features(case, order)
                except Exception as error:
                    ledger.fail(job, str(error), seconds=time.time() - started)
                    raise
                ledger.finish(job, prefill=1, decode=0, tokens_in=feature["tokensIn"], tokens_out=0,
                              seconds=time.time() - started)
                rows.append({
                    "caseId": case["caseId"], "orderIdx": order,
                    "cand": feature["cand"].numpy(), "hq": feature["hq"].numpy(),
                    "letterLogp": feature["letterLogp"], "candidateMass": feature["candidateMass"],
                    "labelIndex": (ORDERS[order].index(case["labelId"]) if "labelId" in case else -1),
                    "idsSha256": feature["idsSha256"], "renderedSha256": feature["renderedSha256"],
                    "tokensIn": feature["tokensIn"], "positions": feature["positions"], "final": feature["final"],
                })
        meta[split] = save_split(split, rows, {"split": split, "modelSha256": model_sha,
                                               "datasetCasesSha256": hashes[split]})
        print(json.dumps({"features": split, "rows": len(rows)}), flush=True)
    return meta


def save_split(split, rows, meta):
    import numpy as np
    from data.features_io import save_split as save
    return save(split, rows, meta)


def gen_j(model, ledger, cases):
    rows = []
    for case in cases:
        for order in range(4):
            job = ledger.reserve(f"gen-{case['caseId']}-{order}", "generation", "json")
            ledger.begin(job)
            started = time.time()
            try:
                gen = model.generate_timed(case, order)
            except Exception as error:
                ledger.fail(job, str(error), seconds=time.time() - started)
                raise
            ledger.finish(job, prefill=1, decode=gen["newTokens"], tokens_in=gen["tokensIn"],
                          tokens_out=gen["newTokens"], seconds=time.time() - started)
            match = J_PATTERN.match(gen["rawText"])
            rows.append({"caseId": case["caseId"], "order": order, "rawText": gen["rawText"],
                         "letter": match.group(1) if match else None, "parsedOk": bool(match)})
    write_jsonl(RESULTS / "j-generations.jsonl", rows)
    return rows


def train_heads(train: "Grouped", dev: "Grouped") -> list[dict]:
    from heads.train import train_run
    records = []
    for variant in ("M1", "M2"):
        for seed in TRAIN["seeds"]:
            out = train_run(variant, seed, train, dev)
            records.append(out["record"])
            torch_save_heads = out  # keep the in-memory best for calibration
            print(json.dumps({"train": variant, "seed": seed, "bestEpoch": out["record"]["bestEpoch"],
                              "devNll": out["record"]["devNll"]}), flush=True)
    write_json(RESULTS / "training-runs.json", records)
    return records


def predict_logits(head, features, order_index, rows_subset):
    import torch
    cand = torch.from_numpy(features["cand"]).float()
    hq = torch.from_numpy(features["hq"]).float()
    with torch.no_grad():
        logits = head(cand).numpy()
    return logits


def main(argv):
    parser = argparse.ArgumentParser()
    parser.add_argument("mode", choices=("lock", "experiment", "report", "audit"))
    args = parser.parse_args(argv)
    if args.mode == "lock":
        return lock()
    if args.mode == "audit":
        from audit.verify import main as verify
        return verify()
    if args.mode == "report":
        return report()
    return experiment()


def experiment() -> int:
    import torch
    from backends.local_qwen import LocalQwen
    from heads.train import Grouped, evaluate, load_head, train_run

    wall = time.time()
    lock_data = read_json(LOCK)
    from ledger import Ledger
    ledger = Ledger(EVIDENCE / "jobs.jsonl")
    model = LocalQwen()
    write_json(EVIDENCE / "model-identity.json", {**model.identity, "at": C.now_iso()})
    model_sha = sha256_json(model.identity["model"])
    cases_sha = lock_data["data"]["hashes"]
    print(json.dumps({"loaded": model.params, "seconds": model.load_seconds}), flush=True)

    # compatibility + warmup (all charged)
    probe = load_cases("train")[0]
    for index in range(4):
        job = reserve_new(ledger, f"compat-fwd-{index}", "feature", "compat")
        if job is None:
            continue
        ledger.begin(job); started = time.time()
        feature = model.features(probe, index)
        ledger.finish(job, prefill=1, decode=0, tokens_in=feature["tokensIn"], tokens_out=0, seconds=time.time() - started)
    for index in range(2):
        for arm, fn in (("json", model.generate_timed), ("label_logits", model.forward_timed)):
            job = reserve_new(ledger, f"warmup-{arm}-{index}", "generation" if arm == "json" else "feature", arm)
            if job is None:
                continue
            ledger.begin(job); started = time.time()
            out = fn(probe, index) if arm == "json" else fn(probe, index)
            ledger.finish(job, prefill=1, decode=out.get("newTokens", 0), tokens_in=out["tokensIn"], tokens_out=out.get("newTokens", 0), seconds=time.time() - started)

    hashes = {**lock_data["data"]["hashes"], "test": lock_data["data"]["testInputsSha256"]}
    feature_meta = features_all(model, ledger, model_sha, hashes)
    if (RESULTS / "j-generations.jsonl").exists():
        j_rows = read_jsonl(RESULTS / "j-generations.jsonl")
        if len(j_rows) != 4 * len(load_cases("test")):
            raise RuntimeError("existing J generations are incomplete; refusing a silent re-spend")
        print(json.dumps({"gen": "resumed", "rows": len(j_rows)}), flush=True)
    else:
        j_rows = gen_j(model, ledger, load_cases("test"))
    write_json(RESULTS / "j-meta.json", {"sha256": sha256_file(RESULTS / "j-generations.jsonl"), "count": len(j_rows)})

    train = Grouped("train", model_sha, hashes["train"])
    dev = Grouped("dev", model_sha, hashes["dev"])
    cal = Grouped("cal", model_sha, hashes["cal"])
    test = Grouped("test", model_sha, hashes["test"])
    records = train_heads(train, dev)

    # calibration: pick seed by dev NLL; T on cal-temp; policy threshold on cal-policy
    cal_cases = {row["caseId"]: row for row in load_cases("cal")}
    gold = read_json(DATA / "test.gold.json")["gold"]
    cal_inputs = {row["caseId"]: row for row in read_jsonl(DATA / "cal.jsonl")}
    config = {}
    for variant in ("M1", "M2"):
        runs = [r for r in records if r["variant"] == variant]
        best = min(runs, key=lambda r: r["devNll"])
        head, _ = load_head(Path(best["bestPath"]), device="cuda:0")
        c_temp = [i for i, cid in enumerate(cal.cases) if cal_inputs[cid].get("calRole") == "temperature"]
        c_pol = [i for i, cid in enumerate(cal.cases) if cal_inputs[cid].get("calRole") == "policy"]
        temp_logits = _cal_logits(head, cal, c_temp)
        temp_targets = _cal_targets(cal, c_temp)
        from eval.metrics import fit_temperature
        fit = fit_temperature(temp_logits, temp_targets)
        pol_logits = _cal_logits(head, cal, c_pol)
        pol_targets = _cal_targets(cal, c_pol)
        threshold = choose_threshold(pol_logits, pol_targets, fit["T"])
        config[variant] = {"seed": best["seed"], "T": round(fit["T"], 6),
                           "calTempNll": round(fit["nll"], 6), "abstainThreshold": threshold}
    write_json(RESULTS / "calibration.json", config)

    # write test predictions (gold sealed in the file but not read until hashed)
    j_by = {(row["caseId"], row["order"]): row for row in j_rows}
    test_cases = load_cases("test")
    write_predictions("rules", rule_predictions(test_cases))
    write_predictions("json", json_predictions(test_cases, j_by))
    write_predictions("label_logits", logit_predictions(test_cases, "test"))
    old_path = C.ROOT / "runs" / "old-h0-seed17" / "head.pt"
    old_head, _ = load_head(old_path, device="cuda:0")
    write_predictions("old_h0", head_predictions(test_cases, old_head, "old_h0"))
    for variant in ("M1", "M2"):
        head, _ = load_head(Path([r for r in records if r["variant"] == variant and r["seed"] == config[variant]["seed"]][0]["bestPath"]), device="cuda:0")
        write_predictions(variant, head_predictions(test_cases, head, variant, config[variant]["T"]))
    hashes = {path.stem: sha256_file(path) for path in sorted(PRED.glob("*.jsonl"))}
    write_json(RESULTS / "unseal-record.json", {"at": C.now_iso(), "predictions": hashes,
                                                "goldSha256": lock_data["data"]["testGoldSha256"], "goldRead": False})
    latency = latency_run(model, ledger, lock_data, config, old_head)
    write_json(RESULTS / "run-summary.json", {
        "schema": "frostecho.jev02.run-summary/1", "at": C.now_iso(),
        "wallSeconds": round(time.time() - wall, 2),
        "model": {"params": model.params, "devices": model.devices, "loadSeconds": model.load_seconds,
                  "sha256": model_sha, "files": model.identity["model"]["files"]},
        "ledger": ledger.summary(), "memory": model.memory(),
        "featureMeta": {k: {"count": v["count"], "npzSha256": v["npzSha256"]} for k, v in feature_meta.items()},
        "trainingSeconds": round(sum(r["seconds"] for r in records), 2),
        "calibration": config, "predictions": hashes,
    })
    print(json.dumps({"experiment": "done", "ledger": ledger.summary()["reserved"]}), flush=True)
    return 0


def _cal_logits(head, cal, indices):
    import torch
    cand = torch.from_numpy(cal.cand).float().cuda()
    hq = torch.from_numpy(cal.hq).float().cuda()
    with torch.no_grad():
        logits = head(cand).cpu().numpy()
    # rows: 4 per case; take the original permutation (order 0) per case
    out = []
    for case_index in indices:
        rows = cal.rows[case_index]
        row = [r for r in rows if int(cal.orders[r]) == 0][0]
        out.append(logits[row])
    return np.array(out)


def _cal_targets(cal, indices):
    return np.array([cal.labelIndex[cal.rows[i][0]] for i in indices])


def choose_threshold(logits, targets, temperature):
    probs = softmax(logits, temperature)
    pred = probs.argmax(axis=1)
    confident = probs.max(axis=1)
    best = None
    for threshold in np.linspace(0.5, 0.99, 50):
        accepted = confident >= threshold
        n = int(accepted.sum())
        if n < 50:
            continue
        errors = int((pred[accepted] != targets[accepted]).sum())
        rate = errors / n
        if rate <= 0.05 and (best is None or n > best["accepted"]):
            best = {"threshold": round(float(threshold), 4), "accepted": n, "errors": errors, "errorRate": round(rate, 4)}
    return best


def rule_predictions(cases):
    rows = []
    for case in cases:
        result = rule_predict(case["visibleInput"]["playerText"])
        for order in range(4):
            rows.append({"caseId": case["caseId"], "groupId": case["groupId"], "order": order,
                         "method": "rules", "predictedId": result.predictedId, "probs": None,
                         "refused": result.predictedId is None, "parsedOk": result.predictedId is not None})
    return rows


def json_predictions(cases, by_key):
    rows = []
    for case in cases:
        for order in range(4):
            gen = by_key[(case["caseId"], order)]
            stable = C.display_to_stable(order)[gen["letter"]] if gen["letter"] else None
            rows.append({"caseId": case["caseId"], "groupId": case["groupId"], "order": order,
                         "method": "json", "predictedId": stable, "probs": None,
                         "refused": False, "parsedOk": gen["parsedOk"], "raw": gen["rawText"]})
    return rows


def logit_predictions(cases, split):
    hashes = {**read_json(LOCK)["data"]["hashes"], "test": read_json(LOCK)["data"]["testInputsSha256"]}
    features, _ = load_split(split, sha256_json(read_json(LOCK)["model"]), hashes[split])
    rows = []
    for case in cases:
        indices = [i for i, cid in enumerate(features["caseIds"]) if str(cid) == case["caseId"]]
        for order in range(4):
            i = [k for k in indices if int(features["orderIdx"][k]) == order][0]
            logits = np.array(features["letterLogp"][i], dtype=np.float64)
            probs = softmax(logits[None, :], 1.0)[0]
            best = max(range(4), key=lambda k: probs[k])
            rows.append({"caseId": case["caseId"], "groupId": case["groupId"], "order": order,
                         "method": "label_logits", "predictedId": ORDERS[order][best],
                         "probs": {ORDERS[order][k]: float(probs[k]) for k in range(4)},
                         "logits": [float(v) for v in logits], "refused": False, "parsedOk": True})
    return rows


def head_predictions(cases, head, method, temperature=1.0):
    import torch
    hashes = {**read_json(LOCK)["data"]["hashes"], "test": read_json(LOCK)["data"]["testInputsSha256"]}
    features, _ = load_split("test", sha256_json(read_json(LOCK)["model"]), hashes["test"])
    cand = torch.from_numpy(features["cand"]).float().cuda()
    hq = torch.from_numpy(features["hq"]).float().cuda()
    with torch.no_grad():
        logits = head(cand).cpu().numpy()
    index = {(str(features["caseIds"][i]), int(features["orderIdx"][i])): i for i in range(len(features["caseIds"]))}
    rows = []
    for case in cases:
        for order in range(4):
            raw = logits[index[(case["caseId"], order)]]
            probs = softmax(raw[None, :], temperature)[0]
            best = int(probs.argmax())
            rows.append({"caseId": case["caseId"], "groupId": case["groupId"], "order": order,
                         "method": method, "predictedId": ORDERS[order][best],
                         "probs": {ORDERS[order][k]: float(probs[k]) for k in range(4)},
                         "logits": [float(v) for v in raw], "refused": False, "parsedOk": True})
    return rows


def write_predictions(method, rows):
    PRED.mkdir(parents=True, exist_ok=True)
    write_jsonl(PRED / f"{method}.jsonl", sorted(rows, key=lambda r: (r["caseId"], r["order"])))


def latency_run(model, ledger, lock_data, config, old_head):
    import torch
    from heads.train import load_head
    heads = {"old_h0": old_head}
    for variant in ("M1", "M2"):
        run = [r for r in read_json(RESULTS / "training-runs.json")
               if r["variant"] == variant and r["seed"] == config[variant]["seed"]][0]
        heads[variant], _ = load_head(Path(run["bestPath"]), device="cuda:0")
    cases = {row["caseId"]: row for row in load_cases("test")}
    predictions = {}
    for name in ("json", "label_logits", "old_h0", "M1", "M2"):
        predictions[name] = {(row["caseId"], row["order"]): row["predictedId"]
                             for row in read_jsonl(PRED / f"{name}.jsonl")}
    finished = ledger.finished
    rows = []
    presentations = [(cid, order) for cid in lock_data["latencyCaseIds"] for order in range(4)]
    for index, (case_id, order) in enumerate(presentations):
        case = cases[case_id]
        methods = LATENCY_METHODS[index % len(LATENCY_METHODS):] + LATENCY_METHODS[:index % len(LATENCY_METHODS)]
        for method in methods:
            job_id = f"latency-{method}-{case_id}-{order}"
            if job_id in ledger.reserved:
                prior = finished.get(job_id)
                if prior is None:
                    rows.append({"caseId": case_id, "order": order, "method": method,
                                 "predictedId": predictions[method].get((case_id, order)),
                                 "e2eMs": None, "missing": True, "reason": "charged but unfinished (kept, not retried)"})
                else:
                    rows.append({"caseId": case_id, "order": order, "method": method,
                                 "predictedId": predictions[method].get((case_id, order)),
                                 "tokensIn": prior["tokensIn"], "tokenizeMs": None, "prefillMs": None,
                                 "readoutMs": None, "decodeMs": None,
                                 "e2eMs": round(prior["seconds"] * 1000, 3), "resumedFromLedger": True})
                continue
            job = ledger.reserve(job_id, "latency", method)
            ledger.begin(job); started = time.time()
            try:
                if method == "json":
                    out = model.generate_timed(case, order)
                else:
                    out = model.forward_timed(case, order, heads.get(method))
            except Exception as error:
                ledger.fail(job, str(error), seconds=time.time() - started)
                raise
            ledger.finish(job, prefill=out.get("prefillCalls", 1), decode=out.get("decodeCalls", 0),
                          tokens_in=out["tokensIn"], tokens_out=out.get("newTokens", 0),
                          seconds=time.time() - started)
            rows.append({"caseId": case_id, "order": order, "method": method, **out,
                         "e2eMs": round((time.time() - started) * 1000, 3)})
    summary = {}
    for method in LATENCY_METHODS:
        values = [row["e2eMs"] for row in rows if row["method"] == method and row.get("e2eMs") is not None]
        summary[method] = {"n": len(values),
                           "missing": sum(1 for row in rows if row["method"] == method and row.get("e2eMs") is None),
                           "medianE2eMs": round(float(statistics.median(values)), 3) if values else None,
                           "min": round(min(values), 3) if values else None,
                           "max": round(max(values), 3) if values else None}
    write_json(RESULTS / "latency.json", {"rows": rows, "summary": summary})
    return {"summary": summary}


def report() -> int:
    lock_data = read_json(LOCK)
    gold = {k: v["labelId"] for k, v in read_json(DATA / "test.gold.json")["gold"].items() if not v.get("excluded")}
    cases = {row["caseId"]: row for row in load_cases("test")}
    inputs = read_jsonl(DATA / "test.inputs.jsonl")
    groups = {row["caseId"]: row["groupId"] for row in inputs}
    preds = {path.stem: read_jsonl(path) for path in sorted(PRED.glob("*.jsonl"))}
    hashes = {path.stem: sha256_file(path) for path in sorted(PRED.glob("*.jsonl"))}
    assert hashes == read_json(RESULTS / "unseal-record.json")["predictions"]
    methods = {}
    for name, rows in preds.items():
        rows = [r for r in rows if r["caseId"] in gold]
        methods[name] = score_method(rows, gold)
    calibration = read_json(RESULTS / "calibration.json")
    for variant in ("M1", "M2"):
        threshold = (calibration.get(variant) or {}).get("abstainThreshold")
        rows = [r for r in preds[variant] if r["caseId"] in gold and r["order"] == 0]
        if threshold and rows:
            accepted = [r for r in rows if max(r["probs"].values()) >= threshold["threshold"]]
            errors = sum(1 for r in accepted if r["predictedId"] != gold[r["caseId"]])
            per_class = {}
            for cls in CLASSES:
                bucket = [r for r in accepted if gold[r["caseId"]] == cls]
                wrong = sum(1 for r in bucket if r["predictedId"] != cls)
                per_class[cls] = {"accepted": len(bucket), "errors": wrong,
                                  "coverage": round(len(bucket) / max(1, sum(1 for r in rows if gold[r["caseId"]] == cls)), 4)}
            methods[variant]["abstention"] = {"threshold": threshold["threshold"], "accepted": len(accepted),
                                              "errors": errors, "coverage": round(len(accepted) / len(rows), 4),
                                              "errorRate": round(errors / len(accepted), 4) if accepted else None,
                                              "perClass": per_class}
    write_json(RESULTS / "results.json", {
        "schema": "frostecho.jev02.results/1", "at": C.now_iso(),
        "methods": methods, "calibration": read_json(RESULTS / "calibration.json"),
        "latency": read_json(RESULTS / "latency.json")["summary"],
        "costs": read_json(RESULTS / "run-summary.json")["ledger"],
        "test": {"cases": len(gold), "families": len(set(groups.values()))},
    })
    print(json.dumps({k: {"order0": v["order0"]["accuracy"], "combined": v["combined"]["accuracy"]}
                      for k, v in methods.items()}, ensure_ascii=False, indent=1))
    return 0


def score_method(rows, gold):
    def acc(subset):
        n = len(subset); c = sum(1 for r in subset if r["predictedId"] == gold[r["caseId"]])
        return {"correct": c, "n": n, "accuracy": round(c / n, 6) if n else None}

    per_order = {str(order): acc([r for r in rows if r["order"] == order]) for order in range(4)}
    combined = acc(rows)
    f1 = macro_f1(rows, gold)
    consistency = order_consistency(rows)
    out = {"order0": per_order["0"], "perOrder": per_order, "combined": combined,
           "macroF1": f1, "consistency": consistency,
           "refused": sum(1 for r in rows if r["predictedId"] is None),
           "nllBrier": None, "ece": None}
    if rows and rows[0].get("probs") is not None:
        subset = [r for r in rows if r["order"] == 0]
        probs = np.array([[r["probs"].get(cls, 0.0) for cls in CLASSES] for r in subset])
        target = np.array([CLASSES.index(gold[r["caseId"]]) for r in subset])
        out["nllBrier"] = nll_brier(probs, target)
        out["ece"] = ece(probs, target)
    return out


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
