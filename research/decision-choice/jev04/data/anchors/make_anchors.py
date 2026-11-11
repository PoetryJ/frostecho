#!/usr/bin/env python3
"""64 public anchors: 32 source groups x 2 counterfactual members.

Each group changes one fact that the frozen rule uses; nothing is duplicated by
renaming a scene. Labels come from `oracle()` below and are recomputed at write
time. The blind file deliberately omits labels, oracle and control so two
independent review sessions can label from facts alone.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

HERE = Path(__file__).resolve().parent
ACTIONS = ["leave_food", "eat_self", "ask_clarify", "verify", "decline", "address_npc", "wait"]


def oracle(category: str, facts: dict) -> list[str]:
    if category == "revocation":
        if facts["retractionExists"] and facts["speakerAuthorized"] and facts["heardByActor"]:
            return ["eat_self", "decline"]
        if facts["retractionExists"] and not facts["heardByActor"]:
            return ["leave_food", "ask_clarify"]
        if facts["retractionExists"] and not facts["speakerAuthorized"]:
            return ["verify", "leave_food"]
        return ["leave_food"]
    if category == "quotation":
        if facts["quoteDepth"] >= 1:
            return ["verify", "ask_clarify"]
        return ["leave_food"] if facts["directStatementAuthorized"] else ["ask_clarify"]
    if category == "addressee":
        if facts["explicitAddressee"] or facts["presentOthers"] == 1:
            return ["address_npc"]
        if facts["presentOthers"] >= 2:
            return ["ask_clarify"]
        return ["wait"]
    if category == "asymmetry":
        if facts["knowsCancellation"]:
            return ["eat_self"]
        if facts["foodStock"] == 0:
            return ["ask_clarify"]
        return ["leave_food"]
    raise ValueError(category)


def derivation(category: str, facts: dict) -> str:
    if category == "revocation":
        if facts["retractionExists"] and facts["speakerAuthorized"] and facts["heardByActor"]:
            return "撤销由有权说话者发出且该角色已获知 -> 承诺失效，不再留饭"
        if facts["retractionExists"] and not facts["heardByActor"]:
            return "撤销存在但该角色未获知 -> 保持自己的旧知识，同时可澄清"
        if facts["retractionExists"] and not facts["speakerAuthorized"]:
            return "第三方无权撤销 -> 只能核实，不能直接改承诺"
        return "承诺有效且未撤销 -> 留饭"
    if category == "quotation":
        if facts["quoteDepth"] >= 1:
            return "引述/转述不构成新的有效指令 -> 核实或澄清"
        return "直接且有权表态 -> 按表态执行" if facts["directStatementAuthorized"] else "来源无权 -> 澄清"
    if category == "addressee":
        if facts["explicitAddressee"]:
            return "显式指定收话人 -> 只对指定者行动"
        if facts["presentOthers"] == 1:
            return "在场只有一名候选收话人 -> 可唯一指向"
        if facts["presentOthers"] >= 2:
            return "多名候选且无先后/指向 -> 澄清"
        return "无对象 -> 等待"
    if category == "asymmetry":
        if facts["knowsCancellation"]:
            return "该角色已获知撤销 -> 不执行过时承诺"
        if facts["foodStock"] == 0:
            return "库存不足且未获知撤销 -> 澄清/求援"
        return "未获知撤销 -> 保留旧知识下的留饭计划"
    raise ValueError(category)


# 32 groups: id, category, text, base facts, toggled fact (None => invariant pair)
GROUPS = [
    # --- revocation: 8 groups ---
    ("gR01", "revocation", "饭前玩家对阿澈说“给我留一份”，随后在灶房当面说“不用留了”。",
     {"retractionExists": True, "speakerAuthorized": True, "heardByActor": True}, None, "success"),
    ("gR02", "revocation", "玩家在仓库对阿岚说“留饭”，取消的话只在宿舍对别人说了。",
     {"retractionExists": True, "speakerAuthorized": True, "heardByActor": False}, None, "should_not_change"),
    ("gR03", "revocation", "玩家托小北给阿禾带话“取消留饭”，小北并不在场。",
     {"retractionExists": True, "speakerAuthorized": False, "heardByActor": True}, None, "should_not_change"),
    ("gR04", "revocation", "玩家当面对阿澈说“留一份”，阿澈应下；当晚没有取消。",
     {"retractionExists": False, "speakerAuthorized": False, "heardByActor": False}, None, "success"),
    ("gR05", "revocation", "阿岚听见玩家对阿澈说“留饭”；随后玩家只对阿澈说“不用了”。",
     {"retractionExists": True, "speakerAuthorized": True, "heardByActor": False}, None, "invariant"),
    ("gR06", "revocation", "玩家在门房向阿禾取消，阿禾把话转述给阿澈，阿澈未亲耳听到。",
     {"retractionExists": True, "speakerAuthorized": True, "heardByActor": False}, None, "should_not_change"),
    ("gR07", "revocation", "玩家向阿澈取消留饭，阿澈点头；玩家随后离开。",
     {"retractionExists": True, "speakerAuthorized": True, "heardByActor": True}, None, "success"),
    ("gR08", "revocation", "玩家对阿岚说“留饭”，阿岚听到远处有人议论“取消了”，但没有确认说话者。",
     {"retractionExists": True, "speakerAuthorized": False, "heardByActor": True}, None, "should_not_change"),
    # --- quotation: 8 groups ---
    ("gQ01", "quotation", "玩家说：“阿澈刚才说他会给我留饭。”阿澈本人不在场。",
     {"quoteDepth": 1, "directStatementAuthorized": False}, None, "should_not_change"),
    ("gQ02", "quotation", "阿岚转述：“玩家说今天不用留饭。”这是阿岚第二次转述别人的话。",
     {"quoteDepth": 2, "directStatementAuthorized": False}, None, "invariant"),
    ("gQ03", "quotation", "玩家当面对阿澈说：“今天给我留一份。”",
     {"quoteDepth": 0, "directStatementAuthorized": True}, None, "success"),
    ("gQ04", "quotation", "玩家说：“听说有人替我取消了。”但没有说明是谁、对谁说。",
     {"quoteDepth": 1, "directStatementAuthorized": False}, None, "should_not_change"),
    ("gQ05", "quotation", "阿禾复述玩家昨天的原话“给我留饭”，今天玩家并未再说。",
     {"quoteDepth": 1, "directStatementAuthorized": False}, None, "invariant"),
    ("gQ06", "quotation", "维修工转述“上面说不用留了”，阿澈无法核实维修工的身份。",
     {"quoteDepth": 1, "directStatementAuthorized": False}, None, "should_not_change"),
    ("gQ07", "quotation", "玩家直接对阿岚说：“不用留了，我今晚不回来。”",
     {"quoteDepth": 0, "directStatementAuthorized": True}, None, "success"),
    ("gQ08", "quotation", "阿岚引用玩家前天的话“留一份”，但玩家今天已当面改口。",
     {"quoteDepth": 1, "directStatementAuthorized": False}, None, "should_not_change"),
    # --- addressee: 8 groups ---
    ("gA01", "addressee", "厨房里只有阿澈一人，玩家说“你先吃”。",
     {"explicitAddressee": False, "presentOthers": 1}, None, "success"),
    ("gA02", "addressee", "厨房里有阿澈和阿岚，玩家说“你先吃”，没有点名。",
     {"explicitAddressee": False, "presentOthers": 2}, None, "success"),
    ("gA03", "addressee", "玩家点名：“阿岚，你先吃。”厨房里还有阿澈。",
     {"explicitAddressee": True, "presentOthers": 2}, None, "success"),
    ("gA04", "addressee", "玩家面对空房间说“你先吃”。",
     {"explicitAddressee": False, "presentOthers": 0}, None, "invariant"),
    ("gA05", "addressee", "玩家对两名学徒说“留一份”，未说明留给谁。",
     {"explicitAddressee": False, "presentOthers": 2}, None, "should_change"),
    ("gA06", "addressee", "玩家对阿禾说“这份给阿澈”，阿禾只是代收。",
     {"explicitAddressee": True, "presentOthers": 3}, None, "success"),
    ("gA07", "addressee", "宿舍里三人都在，玩家说“你们先吃”，没有先后安排。",
     {"explicitAddressee": False, "presentOthers": 2}, None, "should_not_change"),
    ("gA08", "addressee", "只有阿岚在，玩家说“这份留到晚上”。",
     {"explicitAddressee": False, "presentOthers": 1}, None, "success"),
    # --- asymmetry: 8 groups ---
    ("gY01", "asymmetry", "玩家曾让阿澈留饭；后来只当面告诉阿澈取消。",
     {"knowsCancellation": True, "foodStock": 3}, None, "success"),
    ("gY02", "asymmetry", "玩家曾让阿岚留饭；取消的话只告诉了阿澈，阿岚未听到。",
     {"knowsCancellation": False, "foodStock": 3}, None, "should_not_change"),
    ("gY03", "asymmetry", "阿禾未获知取消，但仓库已经没有食物。",
     {"knowsCancellation": False, "foodStock": 0}, None, "success"),
    ("gY04", "asymmetry", "阿澈已获知取消，但仍有充足食物。",
     {"knowsCancellation": True, "foodStock": 5}, None, "success"),
    ("gY05", "asymmetry", "阿岚未获知取消，食物只够一份。",
     {"knowsCancellation": False, "foodStock": 1}, None, "should_not_change"),
    ("gY06", "asymmetry", "玩家当着阿禾与阿澈的面取消，阿禾听清了。",
     {"knowsCancellation": True, "foodStock": 2}, None, "success"),
    ("gY07", "asymmetry", "玩家委托第三方转告阿岚取消，第三方没有转达。",
     {"knowsCancellation": False, "foodStock": 4}, None, "invariant"),
    ("gY08", "asymmetry", "阿澈听到取消，但误以为是别人家的安排，未确认对象。",
     {"knowsCancellation": False, "foodStock": 2}, None, "should_not_change"),
]

TOGGLES = {
    "gR01": ("heardByActor", False), "gR02": ("heardByActor", True),
    "gR03": ("speakerAuthorized", True), "gR04": ("retractionExists", True),
    "gR05": ("heardByActor", True), "gR06": ("heardByActor", True),
    "gR07": ("heardByActor", False), "gR08": ("speakerAuthorized", True),
    "gQ01": ("quoteDepth", 0), "gQ02": ("quoteDepth", 0),
    "gQ03": ("directStatementAuthorized", False), "gQ04": ("quoteDepth", 0),
    "gQ05": ("quoteDepth", 2), "gQ06": ("quoteDepth", 0),
    "gQ07": ("directStatementAuthorized", False), "gQ08": ("quoteDepth", 0),
    "gA01": ("presentOthers", 0), "gA02": ("presentOthers", 1),
    "gA03": ("explicitAddressee", False), "gA04": ("presentOthers", 1),
    "gA05": ("presentOthers", 1), "gA06": ("explicitAddressee", False),
    "gA07": ("presentOthers", 1), "gA08": ("presentOthers", 2),
    "gY01": ("knowsCancellation", False), "gY02": ("knowsCancellation", True),
    "gY03": ("foodStock", 3), "gY04": ("foodStock", 0),
    "gY05": ("foodStock", 0), "gY06": ("knowsCancellation", False),
    "gY07": ("knowsCancellation", True), "gY08": ("knowsCancellation", True),
}

CONTROL = {
    "gR01": ("should_change", "should_not_change"), "gR02": ("should_not_change", "should_change"),
    "gR03": ("should_not_change", "should_change"), "gR04": ("success", "success"),
    "gR05": ("should_not_change", "should_change"), "gR06": ("should_not_change", "should_change"),
    "gR07": ("success", "should_not_change"), "gR08": ("should_not_change", "should_change"),
}


def sha(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def main() -> int:
    full, blind = [], []
    for group_id, category, text, base, toggle, control in GROUPS:
        key, alt = TOGGLES[group_id]
        variants = [("A", dict(base)), ("B", dict(base, **{key: alt}))]
        if group_id in CONTROL:
            controls = CONTROL[group_id]
        else:
            controls = (control, "invariant" if oracle(category, variants[0][1]) == oracle(category, variants[1][1])
                        else {"revocation": "should_change", "quotation": "should_change",
                              "addressee": "should_change", "asymmetry": "should_change"}[category])
        for member, facts in variants:
            ordinal = int(group_id[2:]) + 10 * ["revocation", "quotation", "addressee", "asymmetry"].index(category)
            facts = dict(facts)
            facts["promiseId"] = f"p-{group_id}"
            facts["hoursSincePromise"] = ordinal
            facts["stockPortions"] = (ordinal % 6) + 1
            facts["presentNames"] = ["阿澈", "阿岚", "阿禾", "小北"][:1 + (ordinal % 4)]
            facts["channel"] = ["face_to_face", "relay", "written_note"][ordinal % 3]
            case_id = f"{group_id}-{member}"
            acceptable = oracle(category, facts)
            full.append({
                "schema": "frostecho.jev04.anchor/1",
                "caseId": case_id,
                "sourceGroup": group_id,
                "category": category,
                "member": member,
                "canonical": member == "A",
                "scenario": text,
                "facts": facts,
                "question": "在该角色可见信息下，哪些动作是合理的？",
                "acceptableSet": acceptable,
                "oracle": {"rule": category, "derivation": derivation(category, facts)},
                "control": controls[0] if member == "A" else controls[1],
                "evidenceSha256": sha(json.dumps(facts, sort_keys=True, ensure_ascii=False)),
            })
            blind.append({
                "caseId": case_id,
                "sourceGroup": group_id,
                "category": category,
                "scenario": text,
                "facts": facts,
                "question": "在该角色可见信息下，哪些动作是合理的？",
                "vocabulary": ACTIONS,
            })
    (HERE / "anchors.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in full),
        encoding="utf-8")
    (HERE / "anchors-blind.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False, sort_keys=True) + "\n" for row in blind),
        encoding="utf-8")
    groups = {row["sourceGroup"] for row in full}
    print(f"wrote {len(full)} anchors in {len(groups)} source groups; blind={len(blind)}")
    print("invariant groups:", sum(1 for row in full if row["control"] in ("invariant", "should_not_change")))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
