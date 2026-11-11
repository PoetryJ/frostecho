#!/usr/bin/env python3
"""B: real-model preflight. Never allocates a GPU when the gate is closed.

Exit codes: 0 = ready to train, 2 = blocked with a concrete reason.
This is deliberately a *failure record* when the weights or data are absent;
it does not substitute a synthetic feature fixture for the real arm.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[4]
GATE = ROOT / "research/decision-choice/jev04/data/gate.json"
OUT = ROOT / "artifacts/sprint-r1/models"
SEARCH_ROOTS = [Path(os.environ.get("FROSTECHO_MODEL_ROOT", "/data3/DATA/models")),
                Path(os.environ.get("HF_HOME", "/root/.cache/huggingface"))]
ARM_NAMES = ["Qwen3.5-27B", "Qwen3.5-4B", "Qwen3.5-27B-Instruct", "Qwen3.5-4B-Instruct"]


def find_models() -> list[dict]:
    found = []
    for root in SEARCH_ROOTS:
        if not root.exists():
            continue
        candidates = list(root.glob("*/config.json")) + list(root.glob("hub/models--Qwen*/snapshots/*/config.json"))
        for entry in candidates:
            text = str(entry)
            if any(name.lower() in text.lower() for name in ("qwen3.5", "qwen3_5")):
                found.append({"path": text,
                              "sizeBytes": sum(p.stat().st_size for p in entry.parent.glob("*.safetensors"))})
    return found


def main() -> int:
    report: dict = {"schema": "frostecho.jev04.t27-probe/1",
                    "base": "844bab54cacff1ea4fe9b413565d5e57f8bb3ffe",
                    "mode": "preflight-only; no weights loaded, no GPU allocation"}
    gate = json.loads(GATE.read_text(encoding="utf-8"))
    report["dataGate"] = {"status": gate["status"], "mayTrainOnJev": gate["mayTrainOnJev"],
                          "targetCases": gate["evidence"]["targetCases"],
                          "existingBehaviorCases": gate["evidence"]["existingBehaviorCases"],
                          "publicAnchors": gate["evidence"].get("publicAnchors", 0)}
    report["searchRoots"] = [str(path) for path in SEARCH_ROOTS]
    report["foundQwen35"] = find_models()
    try:
        import torch
        import transformers
        report["runtime"] = {"torch": torch.__version__, "transformers": transformers.__version__,
                             "cudaAvailable": torch.cuda.is_available(),
                             "deviceCount": torch.cuda.device_count()}
        if torch.cuda.is_available():
            report["runtime"]["gpuMiB"] = [torch.cuda.get_device_properties(index).total_memory // (1024 * 1024)
                                           for index in range(torch.cuda.device_count())]
    except Exception as error:  # pragma: no cover - environment failure is the record
        report["runtime"] = {"error": f"{type(error).__name__}: {error}"}

    reasons = []
    if not gate["mayTrainOnJev"]:
        reasons.append(f"data gate blocked: {gate['evidence']['publicAnchors']}/{gate['evidence']['targetCases']} anchors")
    if not report["foundQwen35"]:
        reasons.append("no Qwen3.5 weights under searched roots: " + ", ".join(str(p) for p in SEARCH_ROOTS))
    report["reasons"] = reasons
    report["status"] = "ready" if not reasons else "blocked"

    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / "t27-probe.json"
    path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False, indent=2))
    print(f"wrote {path}", file=sys.stderr)
    return 0 if not reasons else 2


if __name__ == "__main__":
    raise SystemExit(main())
