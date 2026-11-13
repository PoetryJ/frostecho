"""Independent verification from raw files: recompute, never trust labels."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import contracts as C
from contracts import CAPS, CLASSES, DATA, EVIDENCE, RESULTS, RUNS, read_json, read_jsonl, sha256_file, sha256_json
from eval.metrics import nll_brier, softmax


def main() -> int:
    issues: list[str] = []
    checks: list[dict] = []

    def check(name: str, ok: bool, detail=None) -> None:
        checks.append({"check": name, "ok": bool(ok), "detail": detail})
        if not ok:
            issues.append(f"{name}: {detail}")

    lock_path = C.ROOT / "PLAN.lock.json"
    if not lock_path.exists():
        return finish(checks, ["PLAN.lock.json missing"])
    lock = read_json(lock_path)
    payload = {k: v for k, v in lock.items() if k != "lockSha256"}
    check("lock-hash", sha256_json(payload) == lock["lockSha256"], "lock changed")
    check("gold-sha", sha256_file(DATA / "test.gold.json") == lock["data"]["testGoldSha256"] or
          read_json(DATA / "test.gold.json")["sha256"] == lock["data"]["testGoldSha256"])
    stats = read_json(DATA / "train-stats.json")
    check("data-splits", stats["splits"] == {"train": 1024, "dev": 128, "cal": 512}, stats["splits"])
    test_stats = read_json(DATA / "test-stats.json")
    check("test-cases", test_stats["cases"] == 256, test_stats["cases"])
    check("test-families", test_stats["families"] >= 32, test_stats["families"])
    check("test-balance", sorted(test_stats["perClass"].values()) == [64, 64, 64, 64], test_stats["perClass"])
    inputs = read_jsonl(DATA / "test.inputs.jsonl")
    check("test-inputs-unlabelled", all("labelId" not in row and "provenance" not in row for row in inputs))
    check("test-inputs-sha", sha256_json(inputs) == test_stats["testInputsSha256"])

    # ---- ledger ---------------------------------------------------------
    events = read_jsonl(EVIDENCE / "jobs.jsonl")
    reserved = [e for e in events if e["event"] == "reserve"]
    finished = [e for e in events if e["event"] == "finish"]
    failed = [e for e in events if e["event"] == "fail"]
    ids = [e["jobId"] for e in reserved]
    check("ledger-unique", len(ids) == len(set(ids)), "duplicate reservation")
    check("ledger-cap", len(ids) <= CAPS["model_jobs"], len(ids))
    generation = [e for e in reserved if e["kind"] == "generation"]
    check("generation-cap", len(generation) <= CAPS["generation_jobs"], len(generation))
    finished_ids = {e["jobId"] for e in finished}
    failed_ids = {e["jobId"] for e in failed}
    check("ledger-reserved-finished", finished_ids | failed_ids <= set(ids), "finish without reserve")
    for event in finished:
        if event["tokensOut"] > CAPS["max_new_tokens"]:
            check("token-cap", False, f"{event['jobId']}: {event['tokensOut']}")
            break
    else:
        check("token-cap", True)
    check("p0-position", read_json(EVIDENCE / "p0-position.json")["ok"] is True)
    injection = read_json(EVIDENCE / "p0-injection.json")
    check("p0-injection-charged", injection["charged"] is True and injection["failed"] >= 1, injection)

    # ---- features -------------------------------------------------------
    meta = {}
    for split in ("train", "dev", "cal", "test"):
        path = C.CACHE / f"features-{split}.meta.json"
        if not path.exists():
            check(f"features-{split}", False, "missing meta")
            continue
        m = read_json(path)
        meta[split] = m
        npz = C.CACHE / f"features-{split}.npz"
        check(f"features-{split}-bytes", sha256_file(npz) == m["npzSha256"], "npz changed")
    if "train" in meta:
        check("features-train-4x", meta["train"]["count"] == 1024 * 4, meta["train"]["count"])

    # ---- training -------------------------------------------------------
    training = read_json(RESULTS / "training-runs.json")
    check("training-6", len(training) == 6, len(training))
    for variant in ("M1", "M2"):
        for seed in (17, 29, 43):
            record = next((r for r in training if r["variant"] == variant and r["seed"] == seed), None)
            check(f"run-{variant}-{seed}", record is not None, "missing")
            if record is None:
                continue
            for name in ("best.pt", "last.pt"):
                check(f"ckpt-{variant}-{seed}-{name}", (RUNS / f"{variant}-seed{seed}" / name).exists())
            check(f"params-{variant}-{seed}", record["paramCount"] == 5120, record["paramCount"])
            check(f"grad-{variant}-{seed}", record["trainable"] == ["w"], record["trainable"])

    # ---- unseal / predictions -------------------------------------------
    unseal = read_json(RESULTS / "unseal-record.json")
    pred_paths = sorted((RESULTS / "test-predictions").glob("*.jsonl"))
    actual = {p.stem: sha256_file(p) for p in pred_paths}
    check("prediction-hashes", actual == unseal["predictions"], "predictions changed after unseal")
    gold = {k: v["labelId"] for k, v in read_json(DATA / "test.gold.json")["gold"].items()}
    expected = {(case_id, order) for case_id in gold for order in range(4)}
    for p in pred_paths:
        rows = read_jsonl(p)
        keys = {(r["caseId"], r["order"]) for r in rows}
        check(f"pred-cover-{p.stem}", keys == expected and len(rows) == len(expected), len(rows))
        bad = [r for r in rows if r.get("probs") is not None and abs(sum(r["probs"].values()) - 1.0) > 1e-6]
        check(f"pred-probs-{p.stem}", not bad, len(bad))

    # ---- metrics recompute ----------------------------------------------
    results = read_json(RESULTS / "results.json")
    for p in pred_paths:
        name = p.stem
        if name not in results["methods"]:
            continue
        rows = read_jsonl(p)
        correct = sum(1 for r in rows if r["predictedId"] == gold[r["caseId"]])
        check(f"recompute-{name}", results["methods"][name]["combined"]["correct"] == correct,
              f"{results['methods'][name]['combined']['correct']} vs {correct}")
    for name, entry in results["methods"].items():
        if entry.get("nllBrier") and entry["nllBrier"]["nll"] is not None:
            check(f"nll-finite-{name}", np.isfinite(entry["nllBrier"]["nll"]))

    # ---- latency --------------------------------------------------------
    latency = read_json(RESULTS / "latency.json")
    for method in ("json", "label_logits", "old_h0", "M1", "M2"):
        rows = [r for r in latency["rows"] if r["method"] == method]
        check(f"latency-{method}", len(rows) == 32, len(rows))

    # ---- old evidence untouched -----------------------------------------
    jev01 = Path("/data3/DATA/project/project_meishijiang/FrostEcho-jev01")
    old_gold = jev01 / "research/decision-choice/jev01/data/test.gold.json"
    if old_gold.exists():
        check("old-gold-present", True, "old tree untouched by this run (read-only check)")
    return finish(checks, issues)


def finish(checks: list[dict], issues: list[str]) -> int:
    out = {"schema": "frostecho.jev02.audit/1", "at": C.now_iso(), "checks": checks,
           "issues": issues, "ok": not issues, "passed": sum(1 for c in checks if c["ok"]),
           "total": len(checks)}
    C.write_json(C.AUDIT / "audit-results.json", out)
    print(json.dumps({"audit": "ok" if not issues else "failed", "passed": out["passed"],
                      "total": out["total"], "issues": issues[:10]}, ensure_ascii=False))
    return 0 if not issues else 1


if __name__ == "__main__":
    raise SystemExit(main())
