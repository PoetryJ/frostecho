#!/usr/bin/env python3
"""Build JEV-04 v2 cases from the frozen v1 anchors (read-only) per SCHEMA.md.

Key decisions:
 - v1 files are never modified; every v2 row records provenance.fromV1.
 - `narrative` is generated from `facts` by category templates, so a facts
   change (e.g. the A/B control pairs) necessarily changes the narration.
 - gQ07-A is an explicit cancellation mislabelled as leave_food in v1; the v2
   oracle is revised (decline/eat_self) and the revision is recorded.
 - Candidate sets are exactly K=4 with a fixed seven-action vocabulary.
 - Train/dev use the v1 sourceGroup split; a group never crosses the split.
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
DATA = HERE.parent
ANCHORS = DATA / "anchors"
OUT = HERE

ACTION_TEXT = {
    "leave_food": "按承诺给玩家留一份饭",
    "eat_self": "自己吃掉，不留饭",
    "decline": "明确拒绝/不执行留饭",
    "ask_clarify": "先向说话者澄清确认",
    "verify": "去核实信息来源",
    "address_npc": "按在场唯一候选收话人执行",
    "wait": "暂不行动，等待更多信息",
}
ACTION_PARAMS = {
    "leave_food": {"action": "reserve", "amount": 1, "forId": "player"},
    "eat_self": {"action": "eat", "amount": 1},
    "decline": {"action": "wait"},
    "ask_clarify": {"action": "wait"},
    "verify": {"action": "wait"},
    "address_npc": {"action": "wait"},
    "wait": {"action": "wait"},
}
CATEGORY_TASK = {
    "revocation": "promise_cancel",
    "quotation": "reference_resolution",
    "addressee": "reference_resolution",
    "asymmetry": "info_asymmetry",
}
CATEGORY_REQUIRES = {
    "revocation": ["retractionExists", "speakerAuthorized", "heardByActor"],
    "quotation": ["directStatementAuthorized", "quoteDepth", "channel"],
    "addressee": ["explicitAddressee", "presentOthers"],
    "asymmetry": ["knowsCancellation"],
}
# Oracle corrections for v1 cases whose supervision contradicts the scenario.
ORACLE_FIX = {
    "gQ07-A": {"acceptableSet": ["decline", "eat_self"],
               "rationale": "v1 将明确取消标成 leave_food，与叙述矛盾；"
                            "取消即不再留饭，拒绝/自己吃是合法集合",
               "change": "oracle fix: explicit cancellation must not leave food"},
    "gQ07-B": {"acceptableSet": ["ask_clarify"],
               "rationale": "来源无权：只能澄清，不能执行或拒绝既存承诺",
               "change": "narrative regenerated to state the unauthorised relay"},
}


def narrative_for(case: dict) -> str:
    facts = case["facts"]
    category = case["category"]
    if category == "revocation":
        channel = "当面" if facts.get("channel") == "face_to_face" else "经转述"
        authority = "有权" if facts.get("speakerAuthorized") else "无权"
        heard = "已获知" if facts.get("heardByActor") else "未获知"
        return (f"玩家此前请求留饭；随后{channel}出现取消表态，说话者{authority}。"
                f"该角色{heard}这次取消。")
    if category == "quotation":
        authorized = "直接且有权" if facts.get("directStatementAuthorized") else "非直接或无权"
        depth = int(facts.get("quoteDepth", 0))
        return (f"出现“不用留了”的表态：来源为{facts.get('channel')}，{authorized}，"
                f"转述层数 {depth}。"
                + ("" if authorized == "直接且有权" else "该表态不能当作玩家的有效指令。"))
    if category == "addressee":
        explicit = "有明确称呼" if facts.get("explicitAddressee") else "无明确称呼"
        others = int(facts.get("presentOthers", 0))
        names = "、".join(facts.get("presentNames", []))
        return f"玩家说“你先吃”。在场：{names}；其他在场人数 {others}；{explicit}。"
    if category == "asymmetry":
        knows = "已获知" if facts.get("knowsCancellation") else "未获知"
        return (f"玩家曾请求留饭，取消只告知了部分角色。该角色{knows}取消；"
                f"食物库存 {facts.get('foodStock')}。")
    raise ValueError(f"unknown category {category}")


def candidates_for(acceptable: list[str]) -> list[dict]:
    ordered = [action for action in ACTION_TEXT if action in acceptable]
    for action in ACTION_TEXT:
        if action not in ordered:
            ordered.append(action)
    chosen = ordered[:4]
    return [{"id": action, "text": ACTION_TEXT[action],
             "params": ACTION_PARAMS[action]} for action in chosen]


def facts_list(facts: dict) -> list[dict]:
    return [{"id": key, "kind": key, "content": facts[key]} for key in sorted(facts)]


def main() -> int:
    anchors = [json.loads(line) for line in
               (ANCHORS / "anchors.jsonl").read_text(encoding="utf-8").splitlines() if line]
    sessions = {}
    for name, session_id in (("review-session-1.jsonl", "v1-s1"),
                             ("review-session-2.jsonl", "v1-s2")):
        path = ANCHORS / name
        if not path.exists():
            continue
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            row = json.loads(line)
            sessions.setdefault(row.get("caseId"), []).append({
                "session": session_id,
                "labels": row.get("labels", []),
                "rule": row.get("rule", ""),
                "confidence": row.get("confidence", "unknown"),
            })
    split_v1 = json.loads((ANCHORS / "split.json").read_text(encoding="utf-8"))
    train_groups = set(split_v1.get("trainGroups", []))

    cases = []
    for anchor in anchors:
        case_id = anchor["caseId"]
        fix = ORACLE_FIX.get(case_id)
        acceptable = list(fix["acceptableSet"]) if fix else list(anchor["acceptableSet"])
        row = {
            "schema": "frostecho.jev04.case/2",
            "caseId": f"v2-{case_id}",
            "version": 2,
            "task": CATEGORY_TASK[anchor["category"]],
            "K": 4,
            "candidates": candidates_for(acceptable),
            "acceptableSet": acceptable,
            "polarity": "reject-all" if not acceptable else "acceptable",
            "narrative": {"text": narrative_for(anchor)},
            "facts": facts_list(anchor["facts"]),
            "oracle": {
                "rule": anchor["category"],
                "decision": acceptable[0],
                "requires": CATEGORY_REQUIRES[anchor["category"]],
                "rationale": (fix["rationale"] if fix else anchor["oracle"]["derivation"]),
            },
            "hiddenTruth": {},
            "familyId": anchor["sourceGroup"],
            "sourceGroup": anchor["sourceGroup"],
            "generatorSkeleton": f"v1-{anchor['category']}@rev1",
            "reviewLog": sessions.get(case_id, []),
            "provenance": {"fromV1": case_id,
                           "change": fix["change"] if fix else "mechanical v1->v2 migration"},
        }
        cases.append(row)

    cases.sort(key=lambda row: row["caseId"])
    (OUT / "cases.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in cases), encoding="utf-8")

    train = [row for row in cases if row["sourceGroup"] in train_groups]
    dev = [row for row in cases if row["sourceGroup"] not in train_groups]
    (OUT / "train.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in train), encoding="utf-8")
    (OUT / "dev.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in dev), encoding="utf-8")
    split = {
        "schema": "frostecho.jev04.split/2",
        "source": "v2/cases.jsonl",
        "casesSha256": hashlib.sha256((OUT / "cases.jsonl").read_bytes()).hexdigest(),
        "trainGroups": sorted({row["sourceGroup"] for row in train}),
        "devGroups": sorted({row["sourceGroup"] for row in dev}),
        "trainCases": len(train),
        "devCases": len(dev),
    }
    (OUT / "split.json").write_text(json.dumps(split, ensure_ascii=False, indent=2) + "\n",
                                    encoding="utf-8")

    disagreements = [json.loads(line) for line in
                     (ANCHORS / "review-disagreements.jsonl").read_text(
                         encoding="utf-8").splitlines() if line.strip()]
    adjudicated = []
    actions = Counter()
    for row in disagreements:
        oracle = set(row.get("oracle") or [])
        reviewed = set(row.get("reviewed") or [])
        case_id = row["caseId"]
        if reviewed and reviewed <= oracle:
            action, ruling = "keep", "review is a subset of the oracle set; oracle set stands"
        elif case_id in ORACLE_FIX:
            action, ruling = "revise", ORACLE_FIX[case_id]["rationale"]
        elif reviewed & oracle:
            action, ruling = "challenge", "partial overlap; H must adjudicate the disputed actions"
        else:
            action, ruling = "challenge", "disjoint labels; register as challenge before training"
        actions[action] += 1
        adjudicated.append({
            "caseId": case_id,
            "category": row.get("category"),
            "session": row.get("session"),
            "oracle": sorted(oracle),
            "reviewed": sorted(reviewed),
            "action": action,
            "ruling": ruling,
            "rulingBy": "D-proposal (H adjudication pending unless keep/revise is mechanical)",
        })
    (OUT / "adjudication.jsonl").write_text(
        "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in adjudicated),
        encoding="utf-8")

    gate = {
        "schema": "frostecho.jev04.data-gate-v2/1",
        "at": "2026-11-11T18:00:00+08:00",
        "status": "blocked",
        "mayTrainOnJev": False,
        "evidence": {
            "v1Cases": len(anchors),
            "v2Cases": len(cases),
            "repaired": len(ORACLE_FIX),
            "families": len({row["familyId"] for row in cases}),
            "sourceGroups": len({row["sourceGroup"] for row in cases}),
            "independentSkeletons": len({row["generatorSkeleton"] for row in cases}),
            "trainCases": len(train),
            "devCases": len(dev),
            "trainGroups": len(split["trainGroups"]),
            "devGroups": len(split["devGroups"]),
            "crossSplitGroups": 0,
            "adjudication": dict(actions),
            "doubleReviewedCases": sum(1 for row in cases if len(row["reviewLog"]) >= 2),
            "singleReviewCases": sum(1 for row in cases if len(row["reviewLog"]) == 1),
        },
        "reasons": [
            "semantic gate: only 4 generator skeletons cover 64 cases (v1 family structure)",
            "59 of 69 disagreements require H adjudication (challenge)",
            "quantity gate: train/dev below the 512/128 target; this is a qualified small set",
            "no independent calibration/select/cert/test split available yet",
        ],
    }
    (OUT / "gate-v2.json").write_text(json.dumps(gate, ensure_ascii=False, indent=2) + "\n",
                                      encoding="utf-8")
    print(json.dumps({"cases": len(cases), "train": len(train), "dev": len(dev),
                      "adjudication": dict(actions), "output": str(OUT)}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
