"""D: independent verification from raw files. Recompute, never trust labels."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import contracts as C  # noqa: E402
from contracts import CLASSES, DATA, EVIDENCE, ORDERS, RESULTS, RUNS, read_json, read_jsonl, sha256_file, sha256_json  # noqa: E402
from eval.metrics import ece, macro_f1, nll_brier, order_consistency, softmax  # noqa: E402
from heads.train import state_hash  # noqa: E402


def main() -> int:
    issues: list[str] = []
    checks: list[dict] = []

    def check(name: str, ok: bool, detail=None) -> None:
        checks.append({"check": name, "ok": bool(ok), "detail": detail})
        if not ok:
            issues.append(f"{name}: {detail}")

    lock_path = C.ROOT / "PLAN.lock.json"
    check("lock-exists", lock_path.exists())
    if not lock_path.exists():
        return finish(checks, issues)
    lock = read_json(lock_path)
    payload = {k: v for k, v in lock.items() if k != "lockSha256"}
    check("lock-hash", sha256_json(payload) == lock["lockSha256"], "lock content changed")

    cases = read_jsonl(DATA / "base_cases.jsonl")
    stats = read_json(DATA / "dataset-stats.json")
    check("dataset-cases", len(cases) == 640, len(cases))
    check("dataset-hash", stats["hashes"]["casesSha256"] == lock["dataset"]["casesSha256"])
    check("dataset-gold-sha", stats["testGoldSha256"] == lock["dataset"]["testGoldSha256"])
    check("test-inputs-sha", C.sha256_file(DATA / "test.inputs.jsonl") == lock["dataset"]["testInputsSha256"])

    fam_split: dict[str, str] = {}
    for case in cases:
        prior = fam_split.setdefault(case["groupId"], case["split"])
        if prior != case["split"]:
            issues.append(f"group {case['groupId']} crosses splits")
    check("group-split", not any("crosses splits" in issue for issue in issues))

    forbidden = ("request.kind", "selectedGoal", "activeGoal", "labelId")
    bad_inputs = [case["caseId"] for case in cases
                  if any(token in json.dumps(case["visibleInput"], ensure_ascii=False) for token in forbidden)]
    check("no-leak-in-visible-input", not bad_inputs, bad_inputs[:5])
    test_inputs = read_jsonl(DATA / "test.inputs.jsonl")
    check("test-inputs-unlabelled", all("labelId" not in row for row in test_inputs), "test input carries a label")

    gold_file = read_json(DATA / "test.gold.json")
    check("gold-sha", gold_file["sha256"] == sha256_json(gold_file["gold"]))
    gold = {case_id: entry["labelId"] for case_id, entry in gold_file["gold"].items()}
    check("gold-count", len(gold) == 128, len(gold))

    # ---- jobs -----------------------------------------------------------
    jobs = read_jsonl(EVIDENCE / "jobs.jsonl")
    kinds: dict[str, int] = {}
    for row in jobs:
        kinds[row["kind"]] = kinds.get(row["kind"], 0) + 1
    check("job-total", len(jobs) == 1808, len(jobs))
    check("job-features", kinds.get("feature") == 1280, kinds.get("feature"))
    check("job-generate", kinds.get("generate") == 384, kinds.get("generate"))
    check("job-latency", kinds.get("latency") == 128, kinds.get("latency"))
    check("job-warmup", kinds.get("warmup") == 8, kinds.get("warmup"))
    check("job-compat", kinds.get("compatibility") == 8, kinds.get("compatibility"))
    check("job-unique", len({row["jobId"] for row in jobs}) == len(jobs), "duplicate jobId")
    check("job-positive-time", all(row["seconds"] >= 0 for row in jobs))

    # ---- unseal / predictions -------------------------------------------
    unseal = read_json(RESULTS / "unseal-record.json")
    pred_paths = sorted((RESULTS / "test-predictions").glob("*.jsonl"))
    actual = {path.stem: sha256_file(path) for path in pred_paths}
    check("prediction-hashes", actual == unseal["predictions"], "predictions changed after unseal record")
    check("prediction-count", len(pred_paths) == 9, len(pred_paths))
    expected = {(case["caseId"], order) for case in cases if case["split"] == "test" for order in (0, 1)}
    for path in pred_paths:
        rows = read_jsonl(path)
        keys = {(row["caseId"], row["order"]) for row in rows}
        check(f"prediction-cover-{path.stem}", keys == expected and len(rows) == 256, f"{len(rows)} rows")
        bad = [row for row in rows if row.get("probs") is not None
               and (abs(sum(row["probs"].values()) - 1.0) > 1e-6 or any(not np.isfinite(v) for v in row["probs"].values()))]
        check(f"prediction-probs-{path.stem}", not bad, f"{len(bad)} bad probability rows")

    # ---- training --------------------------------------------------------
    training = read_json(RESULTS / "training-runs.json")
    check("training-runs", len(training) == 6, len(training))
    for kind, expected_params in (("linear_head", 5120), ("pointer_head", 1310848)):
        records = [r for r in training if r["kind"] == kind]
        check(f"training-seeds-{kind}", sorted(r["seed"] for r in records) == [17, 29, 43])
        for record in records:
            path = RUNS / f"{kind}-seed{record['seed']}" / "head.pt"
            check(f"weights-exist-{kind}-{record['seed']}", path.exists())
            if path.exists():
                import torch
                payload = torch.load(path, map_location="cpu", weights_only=False)
                check(f"weights-hash-{kind}-{record['seed']}", state_hash(payload["state"]) == record["weightSha256"])
            check(f"params-{kind}-{record['seed']}", record["paramCount"] == expected_params, record["paramCount"])
            check(f"trainable-{kind}-{record['seed']}",
                  record["trainable"] == (["w"] if kind == "linear_head" else ["wq", "wc", "v"]), record["trainable"])

    # ---- metrics recomputation ------------------------------------------
    results = read_json(RESULTS / "results.json")
    preds = {path.stem: read_jsonl(path) for path in pred_paths}
    for name, rows in preds.items():
        correct = sum(1 for row in rows if row["predictedId"] == gold[row["caseId"]])
        if name in results["methods"]:
            reported = results["methods"][name]["all"]["accuracy"]["correct"]
            check(f"recompute-accuracy-{name}", reported == correct, f"reported {reported} vs {correct}")
    for kind in ("linear_head", "pointer_head"):
        seed = results["methods"][kind]["selectedSeed"]
        name = f"{kind}-seed{seed}"
        subset = [row for row in preds[name] if row["order"] == 0]
        raw = np.array([row["logits"] for row in subset])
        target = np.array([CLASSES.index(gold[row["caseId"]]) for row in subset])
        calibration = results["calibration"][kind]["T"]
        for label, temperature in (("uncalibrated", 1.0), ("calibrated", calibration)):
            probs = softmax(raw, temperature)
            expect = nll_brier(probs, target)
            got = results["methods"][kind]["selected"][label]["nllBrier"]
            check(f"recompute-nll-{kind}-{label}", abs(expect["nll"] - got["nll"]) < 1e-6, f"{expect['nll']} vs {got['nll']}")

    # ---- latency ---------------------------------------------------------
    latency = read_json(RESULTS / "latency.json")
    gpu_rows = [row for row in latency["rows"] if row["method"] != "rules"]
    check("latency-gpu-rows", len(gpu_rows) == 128, len(gpu_rows))
    for method in ("json", "label_logits", "linear_head", "pointer_head"):
        rows = [row for row in gpu_rows if row["method"] == method]
        check(f"latency-{method}-32", len(rows) == 32, len(rows))
        check(f"latency-{method}-positive", all(row["e2eMs"] >= 0 for row in rows))

    # ---- fingerprints ----------------------------------------------------
    identity = read_json(EVIDENCE / "model-identity.json")
    check("model-config-sha", identity["model"]["files"]["config.json"]["sha256"] == lock["model"]["files"]["config.json"]["sha256"])
    for split in ("train", "dev", "cal", "test"):
        meta_path = C.CACHE / f"features-{split}.meta.json"
        if not meta_path.exists():
            issues.append(f"missing feature meta {split}")
            continue
        meta = read_json(meta_path)
        npz = C.CACHE / f"features-{split}.npz"
        check(f"feature-bytes-{split}", sha256_file(npz) == meta["npzSha256"], "feature npz changed")
        check(f"feature-model-{split}", meta["modelSha256"] == sha256_json(lock["model"]))

    return finish(checks, issues)


def finish(checks: list[dict], issues: list[str]) -> int:
    out = {"schema": "frostecho.jev01.audit/1", "at": C.now_iso(),
           "checks": checks, "issues": issues, "ok": not issues,
           "passed": sum(1 for check in checks if check["ok"]), "total": len(checks)}
    C.write_json(C.AUDIT / "audit-results.json", out)
    print(json.dumps({"audit": "ok" if not issues else "failed", "passed": out["passed"],
                      "total": out["total"], "issues": issues[:12]}, ensure_ascii=False, indent=1))
    return 0 if not issues else 1


if __name__ == "__main__":
    raise SystemExit(main())
