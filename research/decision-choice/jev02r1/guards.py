"""Behavioural gold sealing.

JEV-02 wrote `goldRead: false` while run.py had already loaded test.gold.json.
This module replaces a boolean self-report with an enforced, observable block:
while `GoldSeal` is active, any attempt to open a sealed path raises
`GoldBlocked` and is counted. The counter is written to evidence, so a reviewer
can distinguish "never tried" from "tried and was refused".
"""
from __future__ import annotations

import builtins
import io
import os
import threading
from pathlib import Path


class GoldBlocked(PermissionError):
    pass


class GoldSeal:
    def __init__(self, paths: list[Path]):
        self.sealed = {os.path.realpath(os.fspath(path)) for path in paths}
        self.attempts: list[str] = []
        self._lock = threading.Lock()
        self._patched: list[tuple[object, str, object]] = []

    def _matches(self, path) -> bool:
        try:
            candidate = os.path.realpath(os.fspath(path))
        except TypeError:
            return False
        return candidate in self.sealed

    def _check(self, path) -> None:
        if self._matches(path):
            with self._lock:
                self.attempts.append(os.fspath(path))
            raise GoldBlocked(f"sealed during prediction: {path}")

    def _patch(self, target, name: str):
        original = getattr(target, name)

        def wrapper(path, *args, **kwargs):
            self._check(path)
            return original(path, *args, **kwargs)

        self._patched.append((target, name, original))
        setattr(target, name, wrapper)

    def __enter__(self) -> "GoldSeal":
        self._patch(builtins, "open")
        self._patch(io, "open")
        self._patch(os, "open")
        self._patch(Path, "open")
        self._patch(Path, "read_text")
        self._patch(Path, "read_bytes")
        return self

    def __exit__(self, *exc) -> None:
        for target, name, original in reversed(self._patched):
            setattr(target, name, original)
        self._patched.clear()
        return None

    def report(self) -> dict:
        return {"sealedPaths": sorted(os.path.basename(path) for path in self.sealed),
                "blockedAttempts": len(self.attempts),
                "blockedPaths": self.attempts[:20],
                "enforced": "builtins.open/io.open/os.open/Path.open/read_text/read_bytes"}
