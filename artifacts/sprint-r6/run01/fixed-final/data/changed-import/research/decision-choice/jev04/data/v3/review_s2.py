#!/usr/bin/env python3
"""R3 (D): blind review session s2 — narrative-only procedure.

Reviews the rendered v3 item from the NARRATIVE TEXT and candidate texts
only; the facts table is ignored. Marks `insufficient-info` where the
narrative under-determines the answer. Never reads sealed labels, v2
acceptableSet, or session s1 output. Same honesty note as s1 applies.
"""
from __future__ import annotations

import json
import re
from pathlib import Path

HERE = Path(__file__).resolve().parent
SESSION = "s2-20261112"
PROCEDURE = "narrative-only@rev1"

TEXT_TO_ACTION = {
    "按在场唯一候选收话人执行": "address_npc",
    "按承诺给玩家留一份饭": "leave_food",
    "自己吃掉，不留饭": "eat_self",
    "明确拒绝/不执行留饭": "decline",
    "先向说话者澄清确认": "ask_clarify",
    "去核实信息来源": "verify",
    "暂不行动，等待更多信息": "wait",
}


def to_opaque(case: dict, actions: list[str]) -> list[str]:
    proposed = []
    for cand in case["candidates"]:
        action = TEXT_TO_ACTION.get(cand["text"])
        if action in actions:
            proposed.append(cand["id"])
    return proposed


def review(case: dict) -> tuple[list[str], str, str]:
    text = case["narrative"]["text"]
    if "你先吃" in text:
        # addressee narrative
        explicit = "有明确称呼" in text
        match = re.search(r"其他在场人数\s*(\d+)", text)
        if match is None:
            return [], "insufficient-info: 在场人数无法解析", "low"
        others = int(match.group(1))
        if explicit:
            return ["address_npc"], "narrative: 明确称呼可指向", "high"
        if others == 0:
            return ["wait"], "narrative: 无对象", "high"
        if others == 1:
            return ["address_npc"], "narrative: 唯一候选", "high"
        return ["ask_clarify"], "narrative: 多候选且无指向", "high"
    if "不用留了" in text:
        authorized = "非直接或无权" not in text
        depth = re.search(r"转述层数\s*(\d+)", text)
        layers = int(depth.group(1)) if depth else 0
        if authorized and layers == 0:
            return ["leave_food"], "narrative: 直接且有权，但陈述是取消语义，仅不再留饭", "medium"
        if layers >= 1:
            return ["ask_clarify", "verify"], "narrative: 转述不构成指令", "high"
        return ["ask_clarify"], "narrative: 来源无权", "high"
    if "取消表态" in text:
        authorized = "说话者有权" in text
        heard = "已获知" in text
        if authorized and heard:
            return ["decline", "eat_self"], "narrative: 有权且已获知，承诺失效", "high"
        if authorized and not heard:
            return ["ask_clarify", "leave_food"], "narrative: 未获知，保留旧知识并可澄清", "high"
        if not authorized and heard:
            return ["leave_food", "verify"], "narrative: 无权来源，需核实", "medium"
        return ["leave_food", "ask_clarify"], "narrative: 无权且未获知", "medium"
    if "取消只告知了部分角色" in text:
        knows = "已获知" in text
        if knows:
            return ["eat_self"], "narrative: 已获知撤销", "high"
        return ["leave_food"], "narrative: 未获知，保留留饭计划", "high"
    return [], "insufficient-info: 未识别的叙述模板", "low"


def main() -> int:
    cases = [json.loads(line) for line in
             (HERE / "cases.v3.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    out = []
    for case in cases:
        actions, note, confidence = review(case)
        out.append({
            "caseId": case["caseId"],
            "session": SESSION,
            "procedure": PROCEDURE,
            "proposedActions": actions,
            "proposedOpaque": to_opaque(case, actions),
            "note": note,
            "confidence": confidence,
        })
    path = HERE / f"review-{SESSION}.jsonl"
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in out),
                    encoding="utf-8")
    insufficient = sum(1 for row in out if row["note"].startswith("insufficient-info"))
    print(json.dumps({"session": SESSION, "reviewed": len(out),
                      "insufficientInfo": insufficient, "path": str(path)},
                     ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
