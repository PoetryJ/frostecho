"""Pair DSL for the 96-pair behaviour set.

A pair is the statistical unit: its two members are a minimal contrast (flip) or
a semantics-preserving variation (invariant), not two independent samples.
`changed` records what the pair is allowed to vary; the gate in build.py refuses
anything else, and refuses a flip whose two members do not share the player text
verbatim.
"""
from __future__ import annotations

CAPABILITIES = {
    "F1": ("flip", "收话人/指代解析：候选收话人是否唯一决定先吃承载者"),
    "F2": ("flip", "当前安排/纯历史引用与明确采纳：同一句复述是否在当下被采纳"),
    "F3": ("flip", "否定与自我纠正：改口前的原话决定更正要落到谁先"),
    "F4": ("flip", "已明确事实/约定：谁先吃由事先说定的内容承载"),
    "I1": ("invariant", "同义表达：换一种说法，标签不变"),
    "I2": ("invariant", "无关人物/菜品/旁白变化：语义关系不变"),
}


def P(pair_id: str, capability: str, changed: str, rationale: str,
      cases: list[tuple[str, str, str]]) -> dict:
    relation, _ = CAPABILITIES[capability]
    if len(cases) != 2:
        raise SystemExit(f"{pair_id}: a pair has exactly two members")
    return {"pairId": pair_id, "capability": capability, "relation": relation,
            "changed": changed, "rationale": rationale,
            "members": [{"context": context, "playerText": text, "labelId": label}
                        for context, text, label in cases]}
