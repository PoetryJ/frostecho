#!/usr/bin/env python3
"""Generate the read-only derived gold corrections for JEV-03R1.

Does not modify any JEV-03 gold, prediction, score, ledger or checkpoint.
Each correction is derived from the frozen semantic contract by an explicit,
machine-checkable rule, and carries the original case text plus a content hash
so a reviewer can verify that the quoted evidence is exact.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]  # repo root
CASES = ROOT / "research/decision-choice/jev03/behavior/cases.jsonl"

# (caseId, pairId, oldGold, newGold, rule, derivation)
CORRECTIONS = [
    (
        "b-0186", "pF4-13", "NPC_FIRST", "PLAYER_FIRST", "F4.carrier:A",
        "约定承载者='陪着客人说话的人'=对面(NPC)，承载者后吃 => 玩家先吃。"
        "旧标把'后吃'错误地赋给玩家，承载者反向。",
    ),
    (
        "b-0149", "pF4-13", "PLAYER_FIRST", "NPC_FIRST", "F4.carrier:B",
        "约定承载者='只是路过帮忙的人'=玩家，承载者后吃 => NPC 先吃。"
        "旧标把'后吃'错误地赋给 NPC，承载者反向。",
    ),
    (
        "b-0056", "pF4-14", "NPC_FIRST", "PLAYER_FIRST", "F4.predicate:no-work",
        "约定='手上没活的人先吃'；对面有活、玩家闲着 => 玩家先吃。"
        "旧标把'先吃'赋给有活的一方，谓词反向。",
    ),
    (
        "b-0155", "pF4-14", "PLAYER_FIRST", "NPC_FIRST", "F4.predicate:has-work",
        "约定='手上有活的人先吃'；对面有活、玩家闲着 => NPC 先吃。"
        "旧标把'先吃'赋给闲着的一方，谓词反向。",
    ),
    (
        "b-0006", "pI1-14", "NEEDS_CLARIFICATION", "NPC_FIRST", "I1.unique-addressee",
        "值班室只有楼管(NPC)与玩家，收话人唯一；'你先吃吧，我查完这页名单再吃'"
        "= 让 NPC 先吃、说者自陈延后 => NPC_FIRST。缺少多人/指代歧义，不构成 NC。",
    ),
]


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def load_cases() -> dict:
    cases = {}
    with CASES.open(encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if line:
                case = json.loads(line)
                cases[case["caseId"]] = case
    return cases


def main() -> int:
    cases = load_cases()
    entries = []
    for case_id, pair_id, old, new, rule, derivation in CORRECTIONS:
        case = cases[case_id]
        if case["pairId"] != pair_id:
            raise SystemExit(f"pair mismatch for {case_id}: {case['pairId']} != {pair_id}")
        if case["labelId"] != old:
            raise SystemExit(f"old gold mismatch for {case_id}: {case['labelId']} != {old}")
        evidence_text = f"{case['context']}\n{case['playerText']}"
        entries.append({
            "schema": "frostecho.jev04.gold-correction/1",
            "caseId": case_id,
            "pairId": pair_id,
            "member": case["member"],
            "relation": case["relation"],
            "capability": case["capability"],
            "oldGold": old,
            "correctedGold": new,
            "rule": rule,
            "derivation": derivation,
            "evidence": {
                "context": case["context"],
                "playerText": case["playerText"],
                "evidenceSha256": sha256_text(evidence_text),
            },
            "effect": "sensitivity-only; JEV-03 gold/predictions/ledger are not modified",
        })
    out = {
        "schema": "frostecho.jev04.gold-corrections/1",
        "source": "research/decision-choice/jev03/behavior/cases.jsonl",
        "sourceCases": len(cases),
        "count": len(entries),
        "note": "Only derived corrections. Old JEV-01/02/03/03R1 gold and results stay byte-identical.",
        "corrections": entries,
    }
    path = HERE / "corrections" / "gold-corrections.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {path} ({len(entries)} corrections)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
