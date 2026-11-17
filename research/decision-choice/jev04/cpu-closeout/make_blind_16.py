#!/usr/bin/env python3
"""Fill the 16 missing per-ID blind labels for the JEV-03R1 behavior set.

Provenance is recorded honestly: these are single-session contract-based
labels by the sprint integrator, NOT an independent second annotator. They are
written next to the corrections so a reviewer can see exactly what was added;
the frozen gold in cases.jsonl is not modified. Every row must agree with the
frozen gold, otherwise the script exits non-zero (that would be a semantic
disagreement, not a formatting gap).
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]
CASES = ROOT / "research/decision-choice/jev03/behavior/cases.jsonl"
OUT = HERE / "corrections/missing-blind-16.jsonl"

# caseId -> (rule, label, reason)
LABELS = {
    "b-0010": ("R3/NO1", "NO_PRIORITY_REQUEST", "只评价豆腐质地，没有任何当前先后安排。"),
    "b-0013": ("R4/NF1", "NPC_FIRST", "前台只有护士一人，收话人唯一；'你先吃'把先吃让给护士，玩家自陈端汤。"),
    "b-0015": ("R4/NF1", "NPC_FIRST", "只有老板娘在场，收话人唯一；'你先动筷'=让 NPC 先，玩家自陈这碗太烫。"),
    "b-0019": ("R3/NO1", "NO_PRIORITY_REQUEST", "只陈述屋里冷，无先后请求。"),
    "b-0023": ("R3/NO1", "NO_PRIORITY_REQUEST", "只评价豆腐滑，无先后请求。"),
    "b-0025": ("R8/R10", "NEEDS_CLARIFICATION", "两个店员都在柜台后，'你先动筷'收话人不唯一，句中没有分配谁先。"),
    "b-0039": ("R4/F4", "NPC_FIRST", "已有约定'值班的先吃，玩家留到最后'，值班者=NPC。"),
    "b-0055": ("R4/NF1", "NPC_FIRST", "宿舍只有室友与玩家，收话人唯一；玩家让室友先吃。"),
    "b-0083": ("R4/NF1", "NPC_FIRST", "角落里只有摊主与玩家，收话人唯一；玩家让摊主先吃。"),
    "b-0094": ("R8/R10", "NEEDS_CLARIFICATION", "班长和接班同事都在休息室，'你先吃'收话人不唯一。"),
    "b-0102": ("R4/NF1", "NPC_FIRST", "厨房只有玩家与室友，收话人唯一；玩家让室友先吃。"),
    "b-0112": ("R4/F4", "NPC_FIRST", "约定'师傅先吃，学徒收尾'；对面是师傅，玩家是学徒。"),
    "b-0130": ("R4/NF1", "NPC_FIRST", "琴房只有老板与玩家，收话人唯一；玩家让老板先吃。"),
    "b-0138": ("R4/R8", "NPC_FIRST", "玩家先说'我先动筷'后立即摇头说'我讲反了'，自我更正后让给唯一在场的老同学。"),
    "b-0150": ("R4/PF2", "PLAYER_FIRST", "对方已明确让玩家先吃，玩家应下并先拿起筷子。"),
    "b-0167": ("R8/R10", "NEEDS_CLARIFICATION", "门卫与安全员都在门房，'你先吃'收话人不唯一。"),
}


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main() -> int:
    cases = {}
    with CASES.open(encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                case = json.loads(line)
                cases[case["caseId"]] = case
    missing = [cid for cid in LABELS if cid not in cases]
    if missing:
        raise SystemExit(f"unknown caseIds: {missing}")
    rows = []
    for case_id in sorted(LABELS, key=lambda value: int(value.split("-")[1])):
        rule, label, reason = LABELS[case_id]
        case = cases[case_id]
        rows.append({
            "schema": "frostecho.jev04.blind-label/1",
            "caseId": case_id,
            "pairId": case["pairId"],
            "capability": case["capability"],
            "labelId": label,
            "rule": rule,
            "reason": reason,
            "evidenceSha256": sha256_text(f"{case['context']}\n{case['playerText']}"),
            "provenance": {
                "session": "sprint-1116 integrator (single session)",
                "independentSecondAnnotator": False,
                "reviewer": None,
                "note": "contract-derived, added for ID-level auditability; not a double-blind claim",
            },
            "agreesWithFrozenGold": label == case["labelId"],
        })
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with OUT.open("w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n")
    disagree = [row["caseId"] for row in rows if not row["agreesWithFrozenGold"]]
    print(f"wrote {OUT} ({len(rows)} rows)")
    print("disagreements:", disagree)
    return 1 if disagree else 0


if __name__ == "__main__":
    raise SystemExit(main())
