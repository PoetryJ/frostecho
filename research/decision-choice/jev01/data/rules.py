"""R: transparent keyword/rule baseline with abstention.

Reads ONLY the visible player text. `matched_rule` is returned for audit; a
refusal is `predictedId=None` and counts as not-covered, never as correct.
Developed on train only; no labels are read here.
"""
from __future__ import annotations

import re
from dataclasses import dataclass

PLAYER_FIRST = "PLAYER_FIRST"
NPC_FIRST = "NPC_FIRST"
NO_PRIORITY = "NO_PRIORITY_REQUEST"
NEEDS_CLARIFICATION = "NEEDS_CLARIFICATION"

# (ruleId, class, regex) evaluated top to bottom.
RULES: tuple[tuple[str, str, str], ...] = (
    # --- clarification: explicit order question / conflict / no subject ---
    ("clar-order-question", NEEDS_CLARIFICATION, r"(谁先|你先还是|还是我先|到底谁|你们谁|你俩谁|一个说|我该听谁)"),
    ("clar-conflict", NEEDS_CLARIFICATION, r"(但我也|可我也|不过我也|但你说|可你又说|又说|你想先吃.{0,6}我也想)"),
    ("clar-contradiction", NEEDS_CLARIFICATION, r"(别等我.{0,8}也别|不用等我.{0,10}也别|别先吃.{0,6}也别)"),
    ("clar-meta", NEEDS_CLARIFICATION, r"(顺序没说清|谁先没说)"),
    ("clar-unclear-order", NEEDS_CLARIFICATION, r"^(先吃(吧)?|先别吃|先别动)。?$"),
    ("clar-leave-some", NEEDS_CLARIFICATION, r"(留一点|留点)(?!给我|给我留)"),
    ("clar-which-one", NEEDS_CLARIFICATION, r"(这份给谁|是给谁的|这份留给他，那份|那份留着，这份)"),
    ("clar-still-valid", NEEDS_CLARIFICATION, r"(还算吗|还算数吗)"),
    # --- revocation / reported speech / no current request ---
    ("nf-revoke-and-you", NPC_FIRST, r"((不用|别)给我留.{0,12}你.{0,6}吃|(不用|别)给我留.{0,12}归你)"),
    ("np-cancel-only", NO_PRIORITY, r"(不用给我留了|别给我留了|不用留了|那个不用留了|取消了|就算了)"),
    ("np-reported", NO_PRIORITY, r"(他昨天说|他上次说|他刚才说|提过一嘴|提过一句|他提过|他上次说想吃)"),
    ("np-smalltalk", NO_PRIORITY, r"(天气|说到哪儿|继续刚才|吃过了吗|你今天吃了吗|有饭吗|还有多少|是谁做的|什么时候做的|放在桌上|有一份|我刚从宿舍|随便|都可以|看看再说|没想好|先不急|问问|随口一说|没有别的意思)"),
    # --- player first: first-person beneficiary / explicit order ---
    ("pf-hold", PLAYER_FIRST, r"(给我留着|留给我|先留给我|给我留|留一下|别先吃|先别吃|别先动|先别动|别动|等我回来|等我吃完再说|等我吃完)"),
    ("pf-me-first", PLAYER_FIRST, r"(我先吃|我先来|我先动筷子|让我先吃|让我先来|先让我|先给我吃|先给我|紧着我|我还没吃|我快饿死|我饿着|我想先吃|我先看看)"),
    # --- npc first ---
    ("nf-you-first", NPC_FIRST, r"(你先吃|你先动|你先来|你先拿着|你吃吧|你吃这份|你吃，|归你|先给你|你先还是)"),
    ("nf-dont-wait", NPC_FIRST, r"(别等我|不用等我|不用管我|别管我)"),
    ("nf-not-hungry", NPC_FIRST, r"(我还不饿|我不饿|我真不饿|我不急|我不着急|我晚点)"),
)

_COMPILED = tuple((rid, cls, re.compile(pat)) for rid, cls, pat in RULES)


@dataclass
class RuleResult:
    predictedId: str | None
    matchedRule: str | None
    normalized: str


def normalize(text: str) -> str:
    text = text.strip().replace(" ", "")
    return text


def predict(text: str) -> RuleResult:
    normalized = normalize(text)
    for rule_id, class_id, pattern in _COMPILED:
        if pattern.search(normalized):
            return RuleResult(class_id, rule_id, normalized)
    return RuleResult(None, None, normalized)


def coverage(cases: list[dict]) -> dict:
    covered = 0
    correct = 0
    per_class = {cls: {"n": 0, "covered": 0, "correct": 0} for cls in (PLAYER_FIRST, NPC_FIRST, NO_PRIORITY, NEEDS_CLARIFICATION)}
    for case in cases:
        result = predict(case["visibleInput"]["playerText"])
        bucket = per_class[case["labelId"]]
        bucket["n"] += 1
        if result.predictedId is not None:
            covered += 1
            bucket["covered"] += 1
            if result.predictedId == case["labelId"]:
                correct += 1
                bucket["correct"] += 1
    total = len(cases)
    return {
        "n": total,
        "covered": covered,
        "coverage": round(covered / total, 4) if total else None,
        "correctAmongCovered": correct,
        "accuracyAmongCovered": round(correct / covered, 4) if covered else None,
        "accuracyAll": round(correct / total, 4) if total else None,
        "perClass": per_class,
    }
