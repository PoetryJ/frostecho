"""Compute ledger: reserve -> begin -> finish/fail.

The cap is checked at RESERVE, before any forward/generation. A reservation is
charged even if it never finishes (started, failed, or the process dies), so a
`head` exception after a successful forward cannot hide work. Events are an
append-only JSONL log; the summary is reconstructed from it.
"""
from __future__ import annotations

import json
from pathlib import Path

from contracts import CAPS, now_iso


class BudgetExceeded(RuntimeError):
    pass


class Ledger:
    def __init__(self, path: Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.events: list[dict] = []
        self.reserved: dict[str, dict] = {}
        if self.path.exists():
            for line in self.path.read_text(encoding="utf-8").splitlines():
                if not line.strip():
                    continue
                event = json.loads(line)
                self.events.append(event)
                if event["event"] == "reserve":
                    self.reserved[event["jobId"]] = event
        self._recount()

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

    # ------------------------------------------------------------------
    def reserve(self, job_id: str, kind: str, arm: str, meta: dict | None = None) -> dict:
        if job_id in self.reserved:
            raise BudgetExceeded(f"duplicate jobId {job_id}: a charged task is never silently reused")
        jobs = len(self.reserved) + 1
        if jobs > CAPS["model_jobs"]:
            raise BudgetExceeded(f"model jobs {jobs} > {CAPS['model_jobs']} (checked before compute)")
        generation = sum(1 for row in self.reserved.values() if row["kind"] == "generation")
        if kind == "generation" and generation + 1 > CAPS["generation_jobs"]:
            raise BudgetExceeded(f"generation jobs {generation + 1} > {CAPS['generation_jobs']} (before compute)")
        forward = sum(1 for row in self.reserved.values() if row["kind"] in ("feature", "latency", "forward"))
        if kind in ("feature", "latency", "forward") and forward + 1 > CAPS["forward_jobs"]:
            raise BudgetExceeded(f"forward jobs {forward + 1} > {CAPS['forward_jobs']} (before compute)")
        event = {"event": "reserve", "jobId": job_id, "kind": kind, "arm": arm,
                 "at": now_iso(), "meta": meta or {}}
        self._append(event)
        self.reserved[job_id] = event
        return {"jobId": job_id, "kind": kind}

    def begin(self, reservation: dict) -> None:
        self._append({"event": "begin", "jobId": reservation["jobId"], "at": now_iso()})

    def finish(self, reservation: dict, *, prefill: int, decode: int, tokens_in: int,
               tokens_out: int, seconds: float, extra: dict | None = None) -> None:
        if tokens_out > CAPS["max_new_tokens"]:
            raise BudgetExceeded(f"{reservation['jobId']}: {tokens_out} new tokens > {CAPS['max_new_tokens']}")
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
        by_kind: dict[str, int] = {}
        by_arm: dict[str, int] = {}
        for row in self.reserved.values():
            by_kind[row["kind"]] = by_kind.get(row["kind"], 0) + 1
            by_arm[row["arm"]] = by_arm.get(row["arm"], 0) + 1
        finished = list(self.finished.values())
        unfinished = [job_id for job_id in self.reserved if job_id not in self.finished]
        return {
            "reserved": len(self.reserved),
            "finished": len(finished),
            "failed": len(self.failed),
            "unfinished": len(unfinished),
            "unfinishedIds": unfinished[:50],
            "byKind": by_kind,
            "byArm": by_arm,
            "prefill": sum(row["prefill"] for row in finished) + sum(row["prefill"] for row in self.failed.values()),
            "decode": sum(row["decode"] for row in finished) + sum(row["decode"] for row in self.failed.values()),
            "tokensIn": sum(row["tokensIn"] for row in finished) + sum(row["tokensIn"] for row in self.failed.values()),
            "tokensOut": sum(row["tokensOut"] for row in finished) + sum(row["tokensOut"] for row in self.failed.values()),
            "modelSeconds": round(sum(row["seconds"] for row in finished) + sum(row["seconds"] for row in self.failed.values()), 3),
            "caps": CAPS,
        }
