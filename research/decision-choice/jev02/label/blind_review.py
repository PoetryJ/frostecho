"""B: second, independent blind labeling pass over test INPUTS ONLY.

It never opens test.gold.json. The output is written before any comparison.
This is a process-separated script, not an independent human reviewer.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import contracts as C
from contracts import CLASSES, read_jsonl, sha256_json, write_json

NC, NP, NF, PF = "NEEDS_CLARIFICATION", "NO_PRIORITY_REQUEST", "NPC_FIRST", "PLAYER_FIRST"
RULES = (
    ("clar-conflict", NC, r"(给我留.{0,6}你先|你先吃.{0,6}我也|你想先.{0,6}我也想|他说你先，我说我先|上一轮让我先|又变|改口)"),
    ("clar-question", NC, r"(谁先|还是|指的是谁|说的是谁|还算吗|谁先都行|看着办|你们商量|这份.{0,4}那份|留一点|先吃吧|先吃。|留点吧)"),
    ("np-reported", NP, r"(他(昨天|上次|刚才|今天)?说|他提过|他上次说|提过一嘴)"),
    ("nf-revoke-you", NF, r"((不用|别)给我留.{0,10}你.{0,4}吃)"),
    ("np-revoke", NP, r"(不用给我留了|那个不用留了|不用留了|算了)"),
    ("np-statement", NP, r"(放在|还热着|是刚做的|有饭吗|是谁做的|刚从宿舍|收拾完|回头再说|看看|提过)"),
    ("pf-correction", PF, r"不是你先.{0,4}(是)?我"),
    ("nf-correction", NF, r"不是我先.{0,4}(是)?你"),
    ("pf-object", PF, r"((这|那|这碗|这份|这盘)?[饭面汤菜].{0,4}(给|归)我|留给我|给我留着|我还没吃|我要吃|别端走|别碰)"),
    ("pf-first", PF, r"(我(先|还没|今天必须)|让我先|我先来|我先吃|别管顺序，我先|等我吃完)"),
    ("nf-first", NF, r"(你先(吃|动|来|看)?|你吃|归你|留给你|你先把|你看着)"),
    ("nf-dontwait", NF, r"(别等我|别管我|不用给我留|我不饿|不抢|我等你|我今天不吃了|我一会儿再说|我不急)"),
    ("pf-hold", PF, r"(给我留着|别先动|别先吃|等我回来|给我)"),
)
COMPILED = tuple((rid, cls, re.compile(pattern)) for rid, cls, pattern in RULES)


def blind_label(text: str) -> tuple[str | None, str | None]:
    normalized = text.replace(" ", "").strip()
    for rule_id, cls, pattern in COMPILED:
        if pattern.search(normalized):
            return cls, rule_id
    return None, None


def main() -> None:
    inputs = read_jsonl(C.DATA / "test.inputs.jsonl")
    rows = []
    for row in inputs:
        label, rule = blind_label(row["visibleInput"]["playerText"])
        rows.append({"caseId": row["caseId"], "blindLabel": label, "rule": rule,
                     "playerText": row["visibleInput"]["playerText"]})
    out = {"schema": "frostecho.jev02.blind-labels/1", "at": C.now_iso(),
           "labeler": "coding-agent heuristic (process-separated from D)",
           "independence": "not a human reviewer; same operator, different pass; gold was never read",
           "reviewed": len(rows), "unlabelled": sum(1 for row in rows if row["blindLabel"] is None),
           "labelsSha256": sha256_json(rows), "rows": rows}
    write_json(C.DATA / "blind-labels.json", out)
    print({"reviewed": len(rows), "unlabelled": out["unlabelled"], "sha": out["labelsSha256"][:16]})


if __name__ == "__main__":
    main()
