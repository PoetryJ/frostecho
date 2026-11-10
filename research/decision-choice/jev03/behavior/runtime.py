"""Runtime plumbing: one effective plan, one explicit device boundary, one cache.

Three things live here because they all have to be decided *before* a model is
loaded or a job is charged:

1. `Plan`     - the campaign's single source of caps and job名单. Unknown or
                conflicting keys are refused, and the caps can never fall back to
                an older package's global default.
2. `Device`   - the device is named by the caller and validated against what is
                actually available; production refuses a CPU fallback silently.
3. `CacheBinding` - a feature cache is bound to the exact input list, per-row
                token/render hashes, model/renderer identity, head shas and the
                cache bytes. "Same row count" is not a binding.

Warmup goes through the same JobStore and cost channel as the real batch; the
tokens/decode it reports come from the model return, and become `unknown` rather
than 0 when the backend cannot measure them.
"""
from __future__ import annotations

import json
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
sys.path.insert(0, str(ROOT / "heads"))

import j3config as R3  # noqa: E402
from store import JobStore, canonical, sha256_text  # noqa: E402

PLAN_KEYS = {"campaign", "modelOps", "generationOps", "features", "generations",
             "warmupForward", "warmupGenerate", "windowSeconds", "protocolSha",
             "heads", "renderer", "backbone"}
REQUIRED_OVERRIDES = ("model_jobs", "generation_jobs", "window_seconds")


class PlanError(RuntimeError):
    pass


class DeviceError(RuntimeError):
    pass


@dataclass(frozen=True)
class Device:
    name: str

    def torch_device(self):
        import torch

        device = torch.device(self.name)
        if device.type == "cuda":
            if not torch.cuda.is_available():
                raise DeviceError("cuda requested but no visible CUDA device")
            if device.index is not None and device.index >= torch.cuda.device_count():
                raise DeviceError(f"cuda:{device.index} requested but only "
                                  f"{torch.cuda.device_count()} devices are visible")
        elif device.type != "cpu":
            raise DeviceError(f"unsupported device {self.name!r}")
        return device

    def assert_matches(self, tensor) -> None:
        """Production check: a payload must arrive on the device we asked for."""
        expected = self.torch_device().type
        actual = getattr(tensor, "device", None)
        if actual is None or actual.type != expected:
            raise DeviceError(f"tensor on {actual} but device boundary is {expected}")


class Plan:
    """Validated, explicit plan. No inherited caps, no unknown keys."""

    def __init__(self, payload: dict, caps: dict):
        unknown = set(payload) - PLAN_KEYS
        if unknown:
            raise PlanError(f"unknown plan keys {sorted(unknown)}")
        missing = {"campaign", "modelOps", "generationOps", "protocolSha"} - set(payload)
        if missing:
            raise PlanError(f"missing plan keys {sorted(missing)}")
        self.payload = dict(payload)
        self.caps = dict(caps)
        if set(self.caps) - set(REQUIRED_OVERRIDES):
            raise PlanError(f"unexpected cap keys {sorted(set(self.caps) - set(REQUIRED_OVERRIDES))}")
        for key in REQUIRED_OVERRIDES:
            if key not in self.caps:
                raise PlanError(f"cap {key} must be given explicitly, never inherited")
        expected = (self.payload["modelOps"] + self.payload["generations"]
                    + self.payload.get("warmupForward", 0) + self.payload.get("warmupGenerate", 0))
        if expected != self.caps["model_jobs"]:
            raise PlanError(f"plan totals {expected} do not match model_jobs "
                            f"{self.caps['model_jobs']}")
        generation = self.payload["generations"] + self.payload.get("warmupGenerate", 0)
        if generation != self.caps["generation_jobs"]:
            raise PlanError(f"plan generations {generation} do not match "
                            f"generation_jobs {self.caps['generation_jobs']}")
        if self.caps["window_seconds"] != self.payload.get("windowSeconds",
                                                           self.caps["window_seconds"]):
            raise PlanError("windowSeconds disagrees between plan and caps")

    @classmethod
    def load(cls, path: Path, caps: dict) -> "Plan":
        payload = R3.read_json(Path(path))
        return cls(payload, caps)


def input_list_sha(cases: list[dict]) -> str:
    return sha256_text(canonical([{key: case[key] for key in ("caseId", "order", "context",
                                                             "playerText", "protocol")}
                                  for case in cases]))


class CacheBinding:
    """Everything a cache must be bound to before it may be reused."""

    KEYS = ("schema", "split", "rows", "inputListSha", "caseIds", "orderIds", "tokenHashes",
            "renderHashes", "modelIdentity", "rendererSha", "rendererIdentity", "headShas",
            "cacheSha", "protocol")

    def __init__(self, payload: dict):
        missing = [key for key in self.KEYS if key not in payload]
        if missing:
            raise RuntimeError(f"cache binding is missing {missing}")
        self.payload = payload

    @classmethod
    def build(cls, split: str, cases: list[dict], token_hashes: list[str],
              render_hashes: list[str], cache_path: Path, head_shas: dict) -> "CacheBinding":
        return cls({
            "schema": "frostecho.jev03r1.cache/1", "split": split, "rows": len(cases),
            "inputListSha": input_list_sha(cases),
            "caseIds": [case["caseId"] for case in cases],
            "orderIds": [int(case["order"]) for case in cases],
            "tokenHashes": list(token_hashes), "renderHashes": list(render_hashes),
            "modelIdentity": R3.identity(), "rendererSha": R3.sha256_file(
                R3.JEV02 / "render.py"),
            "rendererIdentity": R3.prompt_identity(), "headShas": dict(head_shas),
            "cacheSha": R3.sha256_file(cache_path),
            "protocol": R3.feature_identity_hash(),
        })

    def verify(self, split: str, cases: list[dict], cache_path: Path,
               head_shas: dict) -> None:
        problems = []
        if self.payload["split"] != split:
            problems.append("split")
        if self.payload["rows"] != len(cases):
            problems.append("rows")
        if self.payload["inputListSha"] != input_list_sha(cases):
            problems.append("inputListSha")
        if self.payload["caseIds"] != [case["caseId"] for case in cases]:
            problems.append("caseIds")
        if self.payload["orderIds"] != [int(case["order"]) for case in cases]:
            problems.append("orderIds")
        if self.payload["cacheSha"] != R3.sha256_file(cache_path):
            problems.append("cacheSha")
        if self.payload["headShas"] != dict(head_shas):
            problems.append("headShas")
        if self.payload["rendererIdentity"] != R3.prompt_identity():
            problems.append("rendererIdentity")
        if self.payload["protocol"] != R3.feature_identity_hash():
            problems.append("protocol")
        if problems:
            raise RuntimeError(f"cache binding rejected: {problems}")


def measured_cost(payload: dict) -> dict:
    """Cost taken from the model return; never invented."""
    keys = ("tokensIn", "tokensOut", "decodeCalls", "prefillCalls")
    if not all(key in payload for key in keys):
        return {"source": "unknown", "modelCalls": 1}
    return {"source": "measured", "modelCalls": 1,
            "tokensIn": int(payload["tokensIn"]), "tokensOut": int(payload["tokensOut"]),
            "decodeCalls": int(payload["decodeCalls"]),
            "prefillCalls": int(payload["prefillCalls"])}


def run_job(store: JobStore, job_key: dict, call, payload_fn) -> tuple[dict, dict]:
    """Execute one job with the store's state machine. Returns (result, recovered)."""
    job_id = store.job_id(job_key)
    entry = store._index.get(job_id, {})
    if "finish" in entry and store.result_path(job_id).exists():
        return store.read_result(job_id), {"reused": True, "modelCalls": 0}
    if "reserve" in entry and "begin" not in entry:
        raise RuntimeError(f"job {job_id} is reserved but never began; refusing to re-run")
    store.reserve(job_key)
    store.begin(job_id)
    raw = call()
    payload = payload_fn(raw)
    digest = store.commit_result(job_id, payload)
    store.finish(job_id, digest, measured_cost(payload))
    return payload, {"reused": False, "modelCalls": 1}


def load_features(path: Path) -> dict:
    data = np.load(path)
    return {"cand": data["cand"], "hq": data["hq"]}
