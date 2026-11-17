"""JEV-01 shared contracts: paths, classes, splits, caps, fingerprints, IO.

One source of truth for the five arms and the job ledger. Nothing here touches
production code; this package is a read-only research shadow.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
CACHE = ROOT / "cache"
RUNS = ROOT / "runs"
AUDIT = ROOT / "audit"
RESULTS = ROOT / "results"
EVIDENCE = ROOT / "evidence"
for _d in (DATA, CACHE, RUNS, AUDIT, RESULTS, EVIDENCE):
    _d.mkdir(parents=True, exist_ok=True)

MODEL_PATH = Path("/data2/model_weights/Qwen3.8-27B")
PLAN_SOURCE = Path("/data3/DATA/project/project_meishijiang/FrostEcho/handoff/20261109-jev-01-plan/PLAN.json")

# ---------------------------------------------------------------------------
# semantics
# ---------------------------------------------------------------------------
CLASSES = (
    "PLAYER_FIRST",
    "NPC_FIRST",
    "NO_PRIORITY_REQUEST",
    "NEEDS_CLARIFICATION",
)
CLASS_SET = frozenset(CLASSES)
LETTERS = ("A", "B", "C", "D")

# Two pre-registered display orders over stable semantic ids.
ORDERS = (
    ("PLAYER_FIRST", "NPC_FIRST", "NO_PRIORITY_REQUEST", "NEEDS_CLARIFICATION"),
    ("NEEDS_CLARIFICATION", "NO_PRIORITY_REQUEST", "NPC_FIRST", "PLAYER_FIRST"),
)
ORDER_NAMES = ("original", "reversed")

CANDIDATE_TEXT = {
    "PLAYER_FIRST": "玩家先吃（请求把这份食物留给玩家）",
    "NPC_FIRST": "NPC 先吃（请求 NPC 自己先吃）",
    "NO_PRIORITY_REQUEST": "没有当前的优先顺序请求",
    "NEEDS_CLARIFICATION": "有当前请求，但优先顺序无法判定",
}

TASK = "priority_request"

# ---------------------------------------------------------------------------
# frozen experiment caps (PLAN.json / 10-CONTRACT.txt)
# ---------------------------------------------------------------------------
CAPS = {
    "feature_jobs": 1280,
    "json_cal_test_jobs": 384,
    "latency_jobs": 128,
    "warmup_jobs": 8,
    "compatibility_jobs": 8,
    "total_model_jobs": 1808,
    "generation_jobs_max": 422,
    "forward_jobs_max": 1386,
    "gpu_window_seconds": 4 * 3600,
}
TRAIN = {
    "seeds": (17, 29, 43),
    "runs_max": 6,
    "epochs_max": 30,
    "batch_size": 32,
    "lr": 1e-3,
    "weight_decay": 0.01,
    "grad_clip": 1.0,
    "patience": 5,
    "rank": 128,
    "hidden": 5120,
}
SPLIT_SIZES = {"train": 384, "dev": 64, "cal": 64, "test": 128}
PER_CLASS = {"train": 96, "dev": 16, "cal": 16, "test": 32}
TEST_COMPOSITION = {"new_combination": 64, "language_ood": 64}
MAX_NEW_TOKENS = 64
LATENCY_BASE = 16
LATENCY_ORDERS = 2
LATENCY_METHODS = ("json", "label_logits", "linear_head", "pointer_head")
WARMUP_PER_METHOD = 2


# ---------------------------------------------------------------------------
# hashing / canonical IO
# ---------------------------------------------------------------------------
def canonical(value) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_bytes(raw: bytes) -> str:
    return hashlib.sha256(raw).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def sha256_json(value) -> str:
    return sha256_text(canonical(value))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def write_json(path: Path, value) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def read_json(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def write_jsonl(path: Path, rows) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as handle:
        for row in rows:
            handle.write(canonical(row) + "\n")
    os.replace(tmp, path)


def read_jsonl(path: Path):
    with open(path, encoding="utf-8") as handle:
        return [json.loads(line) for line in handle if line.strip()]


# ---------------------------------------------------------------------------
# model / template identity
# ---------------------------------------------------------------------------
def model_fingerprint() -> dict:
    files = {}
    for name in ("config.json", "tokenizer_config.json", "chat_template.jinja",
                 "model.safetensors.index.json", "generation_config.json"):
        path = MODEL_PATH / name
        files[name] = {"sha256": sha256_file(path), "bytes": path.stat().st_size}
    index = read_json(MODEL_PATH / "model.safetensors.index.json")
    return {
        "path": str(MODEL_PATH),
        "files": files,
        "totalSize": index["metadata"]["total_size"],
        "tensorCount": len(index["weight_map"]),
    }


def runtime_fingerprint() -> dict:
    import torch
    import transformers
    try:
        import accelerate
        acc = accelerate.__version__
    except Exception:  # pragma: no cover - documented fallback
        acc = None
    return {
        "python": sys.version.split()[0],
        "platform": platform.platform(),
        "torch": torch.__version__,
        "transformers": transformers.__version__,
        "accelerate": acc,
        "cuda": torch.version.cuda,
        "gpu_count": torch.cuda.device_count(),
        "gpu_names": [torch.cuda.get_device_name(i) for i in range(torch.cuda.device_count())],
    }


# ---------------------------------------------------------------------------
# job ledger
# ---------------------------------------------------------------------------
@dataclass
class Job:
    jobId: str
    kind: str  # feature | generate | latency | warmup | compatibility
    arm: str  # feature generator | json | label_logits | linear_head | pointer_head
    caseId: str
    order: str | None
    tokensIn: int
    tokensOut: int
    prefillCalls: int
    decodeCalls: int
    seconds: float
    startedAt: str
    peakGiB: float | None = None
    ok: bool = True
    error: str | None = None
    extra: dict = field(default_factory=dict)


class Ledger:
    """Append-only job ledger with hard caps; a cap breach stops the run."""

    def __init__(self, path: Path, caps: dict = CAPS):
        self.path = path
        self.caps = dict(caps)
        self.rows: list[dict] = []
        if path.exists():
            self.rows = read_jsonl(path)

    def counts(self) -> dict:
        out = {"total": len(self.rows)}
        for row in self.rows:
            out[row["kind"]] = out.get(row["kind"], 0) + 1
            out[f"arm:{row['arm']}"] = out.get(f"arm:{row['arm']}", 0) + 1
        return out

    def violations(self) -> list[str]:
        counts = self.counts()
        issues = []
        if counts["total"] > self.caps["total_model_jobs"]:
            issues.append(f"total jobs {counts['total']} > {self.caps['total_model_jobs']}")
        if counts.get("feature", 0) > self.caps["feature_jobs"]:
            issues.append("feature jobs exceed cap")
        if counts.get("generate", 0) > self.caps["json_cal_test_jobs"]:
            issues.append("generation jobs exceed cap")
        if counts.get("latency", 0) > self.caps["latency_jobs"]:
            issues.append("latency jobs exceed cap")
        if counts.get("warmup", 0) > self.caps["warmup_jobs"]:
            issues.append("warmup jobs exceed cap")
        if counts.get("compatibility", 0) > self.caps["compatibility_jobs"]:
            issues.append("compatibility jobs exceed cap")
        generation = sum(1 for row in self.rows if row["kind"] in ("generate", "latency", "warmup") and row["arm"] == "json")
        if generation > self.caps["generation_jobs_max"]:
            issues.append(f"generation jobs {generation} > {self.caps['generation_jobs_max']}")
        return issues

    def add(self, job: Job) -> dict:
        row = {
            "jobId": job.jobId, "kind": job.kind, "arm": job.arm, "caseId": job.caseId,
            "order": job.order, "tokensIn": job.tokensIn, "tokensOut": job.tokensOut,
            "prefillCalls": job.prefillCalls, "decodeCalls": job.decodeCalls,
            "seconds": round(job.seconds, 4), "startedAt": job.startedAt,
            "peakGiB": job.peakGiB, "ok": job.ok, "error": job.error, **job.extra,
        }
        self.rows.append(row)
        issues = self.violations()
        if issues:
            self.rows.pop()
            raise RuntimeError("job budget exceeded: " + "; ".join(issues))
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write(canonical(row) + "\n")
        return row

    def summary(self) -> dict:
        rows = self.rows
        by_kind: dict[str, int] = {}
        by_arm: dict[str, int] = {}
        tokens_in = tokens_out = 0
        prefill = decode = 0
        seconds = 0.0
        for row in rows:
            by_kind[row["kind"]] = by_kind.get(row["kind"], 0) + 1
            by_arm[row["arm"]] = by_arm.get(row["arm"], 0) + 1
            tokens_in += row["tokensIn"] or 0
            tokens_out += row["tokensOut"] or 0
            prefill += row["prefillCalls"] or 0
            decode += row["decodeCalls"] or 0
            seconds += row["seconds"] or 0.0
        return {
            "jobs": len(rows), "byKind": by_kind, "byArm": by_arm,
            "tokensIn": tokens_in, "tokensOut": tokens_out,
            "prefillCalls": prefill, "decodeCalls": decode,
            "modelSeconds": round(seconds, 3),
        }


# ---------------------------------------------------------------------------
# split / dataset helpers
# ---------------------------------------------------------------------------
def letters_for(order_index: int) -> dict[str, str]:
    """stable id -> displayed letter for a given order."""
    return {stable: LETTERS[i] for i, stable in enumerate(ORDERS[order_index])}


def display_to_stable(order_index: int) -> dict[str, str]:
    return {LETTERS[i]: stable for i, stable in enumerate(ORDERS[order_index])}


def case_sort_key(case: dict) -> str:
    return case["caseId"]


def validate_case(case: dict) -> None:
    """Duplicate/empty candidate IDs and unstable labels are rejected, never scored."""
    ids = [candidate.get("id") for candidate in case.get("candidates", [])]
    if len(ids) != 4 or len(set(ids)) != 4 or set(ids) != CLASS_SET:
        raise ValueError(f"{case.get('caseId')}: candidates must be the four stable IDs once each")
    if any(not candidate.get("text") for candidate in case["candidates"]):
        raise ValueError(f"{case.get('caseId')}: empty candidate description")
    if "labelId" in case and case["labelId"] not in CLASS_SET:
        raise ValueError(f"{case.get('caseId')}: unknown label")
    if case.get("split") not in ("train", "dev", "cal", "test"):
        raise ValueError(f"{case.get('caseId')}: unknown split")
    for token in ("request.kind", "selectedGoal", "activeGoal", "labelId"):
        if token in json.dumps(case.get("visibleInput", {}), ensure_ascii=False):
            raise ValueError(f"{case.get('caseId')}: forbidden token {token} in visible input")


def dataset_hashes(cases: list[dict]) -> dict:
    ids = [c["caseId"] for c in cases]
    labels = {c["caseId"]: c.get("labelId") for c in cases}
    groups = {c["caseId"]: c["groupId"] for c in cases}
    splits = {c["caseId"]: c["split"] for c in cases}
    return {
        "casesSha256": sha256_json(sorted(ids)),
        "labelsSha256": sha256_json(labels),
        "groupsSha256": sha256_json(groups),
        "splitsSha256": sha256_json(splits),
        "caseCount": len(cases),
    }


def now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S%z")
