"""JobStore: one small interface for both forward and generate jobs.

The result file is the source of truth. The append-only ledger records the state
machine (reserve -> begin -> finish) and never carries the payload, so a crash
between "model returned" and "state recorded" can always be reconstructed from
disk. Concretely:

  reserve   charge the job under a logical key (campaign, input, order, operation, protocol)
  begin     persisted before the model call
  commit    write the payload to a temp file, fsync, atomically rename, record its hash
  finish    reference the committed payload hash plus the measured cost

`recover` classifies every reserved job as finished / resumable (begin+payload,
no finish) / unresolved (begin, no payload) / corrupt (finish, no payload). Only
`resumable` may be closed without a model call; `unresolved` keeps its charge and
is never retried automatically. This is at-least-once at the record level; it is
not a claim that physical inference is exactly-once.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "jev02r1"))

import j3config as R3  # noqa: E402

PLAN_CAPS = {
    "model_jobs": 1552,
    "generation_jobs": 776,
    "window_seconds": 2 * 3600,
    "per_gpu_gib": 24,
}


class JobError(RuntimeError):
    pass


class BudgetExceeded(JobError):
    pass


def canonical(payload) -> str:
    return json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def sha256_text(text: str) -> str:
    import hashlib

    return hashlib.sha256(text.encode("utf-8")).hexdigest()


class JobStore:
    def __init__(self, root: Path, campaign: str, protocol_sha: str,
                 caps: dict | None = None, clock=time.time):
        self.root = Path(root)
        self.campaign = campaign
        self.protocol_sha = protocol_sha
        self.caps = dict(caps or PLAN_CAPS)
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "results").mkdir(parents=True, exist_ok=True)
        self.ledger_path = self.root / "jobs.jsonl"
        self.clock = clock
        self.events: list[dict] = []
        if self.ledger_path.exists():
            for line in self.ledger_path.read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if line:
                    self.events.append(json.loads(line))
        self._index: dict[str, dict] = {}
        for event in self.events:
            entry = self._index.setdefault(event["jobId"], {"events": []})
            entry["events"].append(event)
            entry[event["event"]] = event
        self.started = min((event["epoch"] for event in self.events
                            if event["event"] == "reserve"), default=None)

    # ---------------------------------------------------------------- identity
    def key(self, input_sha: str, order: int, operation: str) -> dict:
        if operation not in ("forward", "generate"):
            raise JobError(f"unknown operation {operation!r}")
        return {"campaignId": self.campaign, "inputSha": input_sha, "order": int(order),
                "operation": operation, "protocolSha": self.protocol_sha}

    def job_id(self, job_key: dict) -> str:
        return sha256_text(canonical(job_key))[:32]

    def result_path(self, job_id: str) -> Path:
        return self.root / "results" / f"{job_id}.json"

    # ------------------------------------------------------------------ events
    def _append(self, event: dict) -> None:
        event["epoch"] = self.clock()
        self.events.append(event)
        entry = self._index.setdefault(event["jobId"], {"events": []})
        entry["events"].append(event)
        entry[event["event"]] = event
        line = canonical(event) + "\n"
        with open(self.ledger_path, "a", encoding="utf-8") as handle:
            handle.write(line)
            handle.flush()
            os.fsync(handle.fileno())

    def counts(self) -> dict:
        reserved = {job: entry for job, entry in self._index.items() if "reserve" in entry}
        generation = sum(1 for entry in reserved.values()
                         if entry["reserve"]["jobKey"]["operation"] == "generate")
        return {"modelJobs": len(reserved), "generationJobs": generation}

    def _check_budget(self, operation: str) -> None:
        counts = self.counts()
        if counts["modelJobs"] + 1 > self.caps["model_jobs"]:
            raise BudgetExceeded(f"model jobs {counts['modelJobs'] + 1} > {self.caps['model_jobs']}")
        if operation == "generate" and counts["generationJobs"] + 1 > self.caps["generation_jobs"]:
            raise BudgetExceeded(
                f"generation jobs {counts['generationJobs'] + 1} > {self.caps['generation_jobs']}")
        if self.started is not None and self.clock() - self.started > self.caps["window_seconds"]:
            raise BudgetExceeded("GPU window exceeded")

    # ------------------------------------------------------------------ public
    def reserve(self, job_key: dict) -> str:
        job_id = self.job_id(job_key)
        entry = self._index.get(job_id)
        if entry and "reserve" in entry:
            if entry["reserve"]["jobKey"] != job_key:
                raise JobError(f"job {job_id} already reserved under a different key")
            raise JobError(f"job {job_id} already reserved: a charged task is never re-authorised")
        self._check_budget(job_key["operation"])
        self._append({"event": "reserve", "jobId": job_id, "jobKey": job_key,
                      "at": R3.now_iso()})
        return job_id

    def begin(self, job_id: str) -> None:
        entry = self._index.get(job_id)
        if not entry or "reserve" not in entry:
            raise JobError(f"job {job_id} was not reserved")
        if "begin" in entry:
            raise JobError(f"job {job_id} already began")
        self._append({"event": "begin", "jobId": job_id, "at": R3.now_iso()})

    def commit_result(self, job_id: str, payload: dict) -> str:
        entry = self._index.get(job_id)
        if not entry or "begin" not in entry:
            raise JobError(f"job {job_id} has no begin record")
        text = canonical(payload)
        digest = sha256_text(text)
        path = self.result_path(job_id)
        tmp = path.with_suffix(".tmp")
        with open(tmp, "w", encoding="utf-8") as handle:
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(tmp, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
        self._append({"event": "result", "jobId": job_id, "payloadSha": digest,
                      "bytes": len(text.encode("utf-8")), "at": R3.now_iso()})
        return digest

    def finish(self, job_id: str, payload_sha: str, cost: dict) -> None:
        entry = self._index.get(job_id)
        if not entry or "result" not in entry:
            raise JobError(f"job {job_id} cannot finish before its result is committed")
        if entry["result"]["payloadSha"] != payload_sha:
            raise JobError(f"job {job_id} finish references a different payload")
        if "finish" in entry:
            raise JobError(f"job {job_id} already finished")
        self._append({"event": "finish", "jobId": job_id, "payloadSha": payload_sha,
                      "cost": cost, "at": R3.now_iso()})

    def read_result(self, job_id: str) -> dict:
        path = self.result_path(job_id)
        if not path.exists():
            raise JobError(f"job {job_id} has no result file")
        return json.loads(path.read_text(encoding="utf-8"))

    # ----------------------------------------------------------------- recovery
    def recover(self) -> dict:
        buckets = {"finished": [], "resumable": [], "unresolved": [], "corrupt": []}
        for job_id, entry in self._index.items():
            has_result = self.result_path(job_id).exists()
            if "finish" in entry:
                payload_ok = has_result and sha256_text(
                    canonical(self.read_result(job_id))) == entry["finish"]["payloadSha"]
                buckets["finished" if payload_ok else "corrupt"].append(job_id)
            elif has_result and "begin" in entry:
                buckets["resumable"].append(job_id)
            elif "begin" in entry:
                buckets["unresolved"].append(job_id)
            else:
                buckets["unresolved"].append(job_id)
        return buckets

    def close_resumable(self) -> list[str]:
        """Close begin+payload jobs with zero model calls. Never touches unresolved."""
        closed = []
        for job_id in self.recover()["resumable"]:
            payload = self.read_result(job_id)
            digest = sha256_text(canonical(payload))
            from runtime import measured_cost  # local import avoids a cycle
            cost = measured_cost(payload)
            if cost.get("source") == "invalid":
                raise RuntimeError(f"invalid measuredCost on resume: {cost.get('reason')}")
            self._append({"event": "result", "jobId": job_id, "payloadSha": digest,
                          "bytes": len(canonical(payload).encode("utf-8")),
                          "at": R3.now_iso(), "recovered": True})
            self._append({"event": "finish", "jobId": job_id, "payloadSha": digest,
                          "cost": cost, "at": R3.now_iso(), "recovered": True})
            closed.append(job_id)
        return closed

    def summary(self) -> dict:
        """Everything here is derived from disk, never from in-memory counters."""
        state: dict[str, dict] = {}
        if self.ledger_path.exists():
            for line in self.ledger_path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                event = json.loads(line)
                state.setdefault(event["jobId"], {"events": []})[event["event"]] = event
        operations: dict[str, int] = {}
        tokens_in = tokens_out = decode = prefill = 0
        measured = unknown = 0
        for job_id, entry in state.items():
            operation = entry["reserve"]["jobKey"]["operation"] if "reserve" in entry else "unknown"
            operations[operation] = operations.get(operation, 0) + 1
            if "finish" in entry:
                cost = entry["finish"].get("cost") or {}
                if cost.get("source") == "measured":
                    measured += 1
                    tokens_in += int(cost.get("tokensIn") or 0)
                    tokens_out += int(cost.get("tokensOut") or 0)
                    decode += int(cost.get("decodeCalls") or 0)
                    prefill += int(cost.get("prefillCalls") or 0)
                else:
                    unknown += 1
        reserved = sum(1 for entry in state.values() if "reserve" in entry)
        finished = sum(1 for entry in state.values() if "finish" in entry)
        with_result = sum(1 for job_id in state if self.result_path(job_id).exists())
        return {"schema": "frostecho.jev03r1.jobstore-summary/1",
                "campaign": self.campaign, "caps": self.caps,
                "reserved": reserved, "finished": finished, "results": with_result,
                "operations": operations,
                "generationJobs": operations.get("generate", 0),
                "measuredFinish": measured, "unknownCostFinish": unknown,
                "tokensIn": tokens_in, "tokensOut": tokens_out,
                "decodeCalls": decode, "prefillCalls": prefill,
                "complete": reserved == finished == with_result,
                "windowSeconds": round(self.clock() - self.started, 3) if self.started else 0.0}
