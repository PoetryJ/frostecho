"""R1 compute ledger.

Differences from JEV-02 (both are acceptance findings):
1. The generation cap is keyed on `operation`, not on a display `kind`, so a JSON
   latency/demo job can never be filed as `latency` to escape the generate cap.
2. prefill/decode are counted at the real model-call boundary by the caller
   (`decode` = number of incremental decode forwards, not output tokens).
3. The GPU window is enforced from the first reservation, and a failed or
   abandoned reservation stays charged.
"""
from __future__ import annotations

import json
import time
from pathlib import Path

from r1config import CAPS, now_iso

OPERATIONS = ("forward", "generate")


class BudgetExceeded(RuntimeError):
    pass


class Ledger:
    def __init__(self, path: Path, caps: dict | None = None, clock=time.time):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.caps = dict(caps or CAPS)
        self.clock = clock
        self.events: list[dict] = []
        self.reserved: dict[str, dict] = {}
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                if line.strip():
                    event = json.loads(line)
                    self.events.append(event)
                    if event["event"] == "reserve":
                        self.reserved[event["jobId"]] = event
        self.started = min((event["epoch"] for event in self.events if event["event"] == "reserve"),
                           default=None)
        self._recount()

    # ------------------------------------------------------------------
    def _append(self, event: dict) -> None:
        self.events.append(event)
        with open(self.path, "a", encoding="utf-8") as handle:
            handle.write(json.dumps(event, ensure_ascii=False) + "\n")

    def _recount(self) -> None:
        self.finished: dict[str, dict] = {}
        self.failed: dict[str, dict] = {}
        for event in self.events:
            if event["event"] == "finish":
                self.finished[event["jobId"]] = event
            elif event["event"] == "fail":
                self.failed[event["jobId"]] = event

    def counts(self) -> dict:
        generation = sum(1 for row in self.reserved.values() if row["operation"] == "generate")
        forward = sum(1 for row in self.reserved.values() if row["operation"] == "forward")
        return {"modelJobs": len(self.reserved), "generationJobs": generation, "forwardJobs": forward}

    def reserve(self, job_id: str, operation: str, arm: str, meta: dict | None = None) -> dict:
        if operation not in OPERATIONS:
            raise ValueError(f"operation must be one of {OPERATIONS}, got {operation!r}")
        if job_id in self.reserved:
            raise BudgetExceeded(f"duplicate jobId {job_id}: a charged task is never silently reused")
        counts = self.counts()
        if counts["modelJobs"] + 1 > self.caps["model_jobs"]:
            raise BudgetExceeded(f"model jobs {counts['modelJobs'] + 1} > {self.caps['model_jobs']}")
        if operation == "generate" and counts["generationJobs"] + 1 > self.caps["generation_jobs"]:
            raise BudgetExceeded(
                f"generation jobs {counts['generationJobs'] + 1} > {self.caps['generation_jobs']}")
        now = self.clock()
        started = self.started if self.started is not None else now
        if now - started > self.caps["window_seconds"]:
            raise BudgetExceeded(
                f"GPU window {(now - started) / 3600:.2f}h > {self.caps['window_seconds'] / 3600:.2f}h")
        event = {"event": "reserve", "jobId": job_id, "operation": operation, "arm": arm,
                 "at": now_iso(), "epoch": now, "meta": meta or {}}
        if self.started is None:
            self.started = now
        self._append(event)
        self.reserved[job_id] = event
        return {"jobId": job_id, "operation": operation}

    def begin(self, reservation: dict) -> None:
        self._append({"event": "begin", "jobId": reservation["jobId"], "at": now_iso()})

    def finish(self, reservation: dict, *, prefill: int, decode: int, tokens_in: int,
               tokens_out: int, seconds: float, extra: dict | None = None) -> None:
        if tokens_out > self.caps["max_new_tokens"]:
            raise BudgetExceeded(
                f"{reservation['jobId']}: {tokens_out} new tokens > {self.caps['max_new_tokens']}")
        if decode > self.caps["max_new_tokens"]:
            raise BudgetExceeded(
                f"{reservation['jobId']}: {decode} decode calls > {self.caps['max_new_tokens']}")
        self._append({"event": "finish", "jobId": reservation["jobId"], "at": now_iso(),
                      "prefill": int(prefill), "decode": int(decode), "tokensIn": int(tokens_in),
                      "tokensOut": int(tokens_out), "seconds": float(seconds), "extra": extra or {}})
        self._recount()

    def fail(self, reservation: dict, error: str, *, prefill: int = 0, decode: int = 0,
             tokens_in: int = 0, tokens_out: int = 0, seconds: float = 0.0) -> None:
        self._append({"event": "fail", "jobId": reservation["jobId"], "at": now_iso(),
                      "error": str(error)[:400], "prefill": int(prefill), "decode": int(decode),
                      "tokensIn": int(tokens_in), "tokensOut": int(tokens_out),
                      "seconds": float(seconds)})
        self._recount()

    # ------------------------------------------------------------------
    def summary(self) -> dict:
        counts = self.counts()
        by_arm: dict[str, int] = {}
        by_operation: dict[str, int] = {}
        for row in self.reserved.values():
            by_arm[row["arm"]] = by_arm.get(row["arm"], 0) + 1
            by_operation[row["operation"]] = by_operation.get(row["operation"], 0) + 1
        done = list(self.finished.values()) + list(self.failed.values())
        unfinished = [job_id for job_id in self.reserved if job_id not in self.finished]
        return {
            "reserved": len(self.reserved),
            "finished": len(self.finished),
            "failed": len(self.failed),
            "unfinished": len(unfinished),
            "unfinishedIds": unfinished[:50],
            "byOperation": by_operation,
            "byArm": by_arm,
            **counts,
            "prefillCalls": sum(row["prefill"] for row in done),
            "decodeCalls": sum(row["decode"] for row in done),
            "tokensIn": sum(row["tokensIn"] for row in done),
            "tokensOut": sum(row["tokensOut"] for row in done),
            "modelSeconds": round(sum(row["seconds"] for row in done), 3),
            "windowSeconds": round((max((row["epoch"] for row in self.reserved.values()), default=0)
                                    - (self.started or 0)), 3),
            "caps": self.caps,
        }
