#!/usr/bin/env python3
"""P0 evidence: structural positions with a fake candidate block in player text."""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import contracts as C
from contracts import read_jsonl, write_json
from render import rendered_chat


def main() -> int:
    from transformers import AutoTokenizer
    tokenizer = AutoTokenizer.from_pretrained(str(C.MODEL_PATH))
    rows = read_jsonl(C.DATA / "position-regression.jsonl")
    out = []
    for case in rows:
        for order in range(4):
            built = rendered_chat(tokenizer, case, order, "label")
            tokens = [tokenizer.decode([built["ids"][p]]) for p in built["positions"]]
            out.append({
                "caseId": case["caseId"], "order": order,
                "playerHasFakeHeader": "候选：" in case["visibleInput"]["playerText"],
                "positions": built["positions"], "final": built["final"],
                "lineTails": [line[-len(token):] for line, token in zip(built["built"]["lines"], tokens)],
                "tokenMatchesLineTail": all(line.endswith(token) for line, token in zip(built["built"]["lines"], tokens)),
                "distinct": len(set(built["positions"])) == 4,
            })
    ok = all(row["tokenMatchesLineTail"] and row["distinct"] for row in out)
    write_json(C.EVIDENCE / "p0-position.json", {
        "schema": "frostecho.jev02.p0-position/1", "at": C.now_iso(),
        "cases": len(rows), "checks": len(out), "ok": ok, "rows": out,
    })
    print(json.dumps({"p0_position": ok, "checks": len(out)}))
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
