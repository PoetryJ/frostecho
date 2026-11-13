#!/usr/bin/env python3
"""R3 (D): blind review session s1 — rule-table procedure.

Reviews the RENDERED v3 item (narrative + shuffled candidates + facts table)
and proposes acceptable candidate ids from a pre-registered rule table
distilled from the domain spec (v1 anchors oracle derivations). It never
reads the sealed label file, v2 acceptableSet, or session s2 output.

Honesty note (also in REVIEW-NOTES-v3.md): s1 and s2 were both authored and
executed by the same operator (the sprint agent) as two pre-registered,
separately-run procedures. Independence is procedural, not human.
"""
from __future__ import annotations

import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
SESSION = "s1-20261112"
PROCEDURE = "rule-table@rev1"

RULES = {
    "addressee": {
        # (explicitAddressee, presentOthers) -> actions
        (True, 2): ["address_npc"], (True, 3): ["address_npc"],
        (False, 0): ["wait"],
        (False, 1): ["address_npc"],
        (False, 2): ["ask_clarify"], (False, 3): ["ask_clarify"],
    },
    "quotation": {
        # (directStatementAuthorized, quoteDepth>=1) -> actions
        (True, False): ["leave_food"],
        (False, False): ["ask_clarify"],
        (False, True): ["ask_clarify", "verify"],
    },
    "revocation": {
        # (speakerAuthorized, heardByActor) -> actions
        (True, True): ["decline", "eat_self"],
        (True, False): ["ask_clarify", "leave_food"],
        (False, True): ["leave_food", "verify"],
        (False, False): ["leave_food", "ask_clarify"],
    },
    "asymmetry": {
        (True,): ["eat_self"],
        (False,): ["leave_food"],
    },
}


def facts_map(case: dict) -> dict:
    return {fact["id"]: fact["content"] for fact in case["facts"]}


def category_of(case: dict) -> str:
    skeleton = case.get("generatorSkeleton") or ""
    if "addressee" in skeleton:
        return "addressee"
    if "quotation" in skeleton:
        return "quotation"
    if "revocation" in skeleton:
        return "revocation"
    return "asymmetry"


def propose(case: dict) -> tuple[list[str], str]:
    category = category_of(case)
    facts = facts_map(case)
    if category == "addressee":
        key = (bool(facts.get("explicitAddressee")), int(facts.get("presentOthers", 0)))
        # explicit addressee wins regardless of how many others are present
        if key[0]:
            key = (True, 2)
        actions = RULES["addressee"].get(key)
        note = f"addressee rule: explicit={key[0]} others={key[1]}"
    elif category == "quotation":
        key = (bool(facts.get("directStatementAuthorized")),
               int(facts.get("quoteDepth", 0)) >= 1)
        actions = RULES["quotation"].get(key)
        note = f"quotation rule: authorized={key[0]} depth>=1={key[1]}"
    elif category == "revocation":
        key = (bool(facts.get("speakerAuthorized")), bool(facts.get("heardByActor")))
        actions = RULES["revocation"].get(key)
        note = f"revocation rule: authorized={key[0]} heard={key[1]}"
    else:
        key = (bool(facts.get("knowsCancellation")),)
        actions = RULES["asymmetry"].get(key)
        note = f"asymmetry rule: knows={key[0]}"
    return list(actions or []), note


def main() -> int:
    cases = [json.loads(line) for line in
             (HERE / "cases.v3.jsonl").read_text(encoding="utf-8").splitlines() if line.strip()]
    out = []
    for case in cases:
        actions, note = propose(case)
        # Map actions to opaque ids via the canonical v2 action-text table.
        proposed = [cand["id"] for cand in case["candidates"]
                    if TEXT_TO_ACTION.get(cand["text"]) in actions]
        out.append({
            "caseId": case["caseId"],
            "session": SESSION,
            "procedure": PROCEDURE,
            "proposedActions": actions,
            "proposedOpaque": proposed,
            "note": note,
            "confidence": "rule-applied",
        })
    path = HERE / f"review-{SESSION}.jsonl"
    path.write_text("".join(json.dumps(row, ensure_ascii=False) + "\n" for row in out),
                    encoding="utf-8")
    print(json.dumps({"session": SESSION, "reviewed": len(out),
                      "path": str(path)}, ensure_ascii=False))
    return 0


TEXT_TO_ACTION = {
    "按在场唯一候选收话人执行": "address_npc",
    "按承诺给玩家留一份饭": "leave_food",
    "自己吃掉，不留饭": "eat_self",
    "明确拒绝/不执行留饭": "decline",
    "先向说话者澄清确认": "ask_clarify",
    "去核实信息来源": "verify",
    "暂不行动，等待更多信息": "wait",
}


if __name__ == "__main__":
    raise SystemExit(main())
