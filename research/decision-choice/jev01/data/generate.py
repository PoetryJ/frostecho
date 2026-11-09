"""JEV-01 semantic shadow dataset.

Bounded synthetic/annotated pilot, not 640 real players. Splits are assigned
per FAMILY before any variant is generated: one family never crosses splits.
Each family has hand-written semantic templates with two slots; variants are
surface combinations, not independent natural samples.
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from contracts import (  # noqa: E402
    CLASSES, CANDIDATE_TEXT, DATA, LETTERS, ORDERS, PER_CLASS, SPLIT_SIZES,
    TASK, dataset_hashes, sha256_json, sha256_text, write_json, write_jsonl,
)

SEED = 20261109
FOODS = ("这份饭", "这盘菜", "厨房里的食物", "你面前的饭", "这碗饭", "桌上的菜")
POLITE = ("", "请", "麻烦你")

CONTEXTS = (
    "厨房里有 1 份食物，玩家和 npc_a 都在厨房；本轮还没有任何让食约定。",
    "玩家刚从宿舍走到厨房，npc_a 在厨房，台面上有 2 份食物。",
    "厨房只剩 1 份食物，npc_a 正在做饭，玩家在旁边等着。",
    "这一轮用餐时间到了，npc_a 还没吃，玩家也还没吃。",
    "玩家站在厨房门口，npc_a 已经把饭端上桌，两人都还没动筷子。",
    "npc_a 在厨房收拾，玩家刚进门，台面上只有一份饭。",
    "玩家已经坐下，npc_a 站在灶台边，饭还热着。",
    "宿舍离厨房有一段路，玩家刚到，npc_a 已经把碗摆好。",
    "本轮食物刚出锅，玩家和 npc_a 同时伸手去拿。",
)

# family: (split, oodKind, templates)
FAMILIES: dict[str, tuple[str, str | None, tuple[str, ...]]] = {
    # ---------------- PLAYER_FIRST ----------------
    "PF01": ("train", None, ("这份{food}先给我留着，别吃。", "先别动{food}，等我回来。")),
    "PF02": ("train", None, ("{polite}让我先吃这份{food}。", "{polite}我先吃，{food}留给我。")),
    "PF03": ("train", None, ("{food}是给我的，你先别吃。", "这份{food}归我，你先别动。")),
    "PF04": ("train", None, ("能不能先让我吃{food}？", "可以让我先吃吗？{food}先别动。")),
    "PF05": ("train", None, ("这顿我先来，{food}别动。", "这一轮我先吃，你别先动筷子。")),
    "PF06": ("train", None, ("你先别吃，等我吃完再说。", "先等我吃完，{food}留着。")),
    "PF07": ("train", None, ("把{food}留给我，我马上吃。", "{polite}把{food}留一下，我这就吃。")),
    "PF08": ("train", None, ("{polite}让我先吃，行吗？", "我想先吃这份{food}，可以吗？")),
    "PF09": ("train", None, ("先给我吃，别先动筷子。", "这份{food}先紧着我吃。")),
    "PF10": ("dev", None, ("{food}先留给我，你等会儿再吃。", "先别吃这份{food}，我还没吃。")),
    "PF11": ("dev", None, ("我饿着，{food}先给我。", "{polite}先让我吃，我快饿死了。")),
    "PF12": ("cal", None, ("这份{food}我先吃，你别抢。", "{polite}我先动筷子，{food}别动。")),
    "PF13": ("cal", None, ("{food}给我留着，别先吃。", "先留这份{food}给我，我一会儿吃。")),
    "PF14": ("test", "new_combination", ("这轮我先吃，{food}别动。", "{polite}让我先来这份{food}。")),
    "PF15": ("test", "language_ood", ("不是让你先吃，是让我先吃这份{food}。", "我说的是我先吃，{food}别动。")),
    # ---------------- NPC_FIRST ----------------
    "NF01": ("train", None, ("你先吃吧，别等我。", "{polite}你先吃，我不急。")),
    "NF02": ("train", None, ("这份{food}你吃，我待会儿再说。", "{food}归你，你先吃。")),
    "NF03": ("train", None, ("别给我留了，你先吃。", "不用给我留，{food}你吃。")),
    "NF04": ("train", None, ("你先动筷子，我晚点。", "{polite}你先来，我等你吃完。")),
    "NF05": ("train", None, ("我还不饿，你先吃这份{food}。", "我不饿，{food}你先吃。")),
    "NF06": ("train", None, ("你先吃，不用管我。", "你先吃你的，别管我。")),
    "NF07": ("train", None, ("这顿你先来，{food}归你。", "这一轮你先吃，{food}你拿着。")),
    "NF08": ("train", None, ("{polite}你先吃，我一会儿自己弄。", "你先吃这份{food}，我自己再弄。")),
    "NF09": ("train", None, ("你先吃吧，我等你吃完再吃。", "{food}先给你，你吃。")),
    "NF10": ("dev", None, ("别等我，你先吃这份{food}。", "你先吃，{food}不用留给我。")),
    "NF11": ("dev", None, ("你先吃，我真不饿。", "{polite}你先动筷子，我看看就行。")),
    "NF12": ("cal", None, ("{food}你先吃，我不着急。", "你先吃这份{food}，我等下一轮。")),
    "NF13": ("cal", None, ("你先吃，别客气。", "{polite}你先来，{food}管够。")),
    "NF14": ("test", "new_combination", ("这轮你先吃，{food}归你。", "{polite}你先动筷子，我不急。")),
    "NF15": ("test", "language_ood", ("不是我先吃，是你先吃这份{food}。", "我说你吃，{food}别留给我。")),
    # ---------------- NO_PRIORITY_REQUEST ----------------
    "NP01": ("train", None, ("厨房里今天有饭吗？", "{food}还有多少？")),
    "NP02": ("train", None, ("今天天气不错。", "我刚从宿舍过来。")),
    "NP03": ("train", None, ("刚才说到哪儿了？", "我们继续刚才的话题吧。")),
    "NP04": ("train", None, ("他昨天说他想先吃。", "{food}他上次说想吃。")),
    "NP05": ("train", None, ("我把之前那个请求取消了。", "之前说的事就算了。")),
    "NP06": ("train", None, ("随便，都行。", "我都可以。")),
    "NP07": ("train", None, ("你吃过了吗？", "你今天吃了吗？")),
    "NP08": ("train", None, ("我先看看再说。", "我还没想好。")),
    "NP09": ("train", None, ("{food}放在桌上了。", "厨房里有一份{food}。")),
    "NP10": ("dev", None, ("不用给我留了。", "之前那个不用留了。")),
    "NP11": ("dev", None, ("我一会儿再决定。", "先不急。")),
    "NP12": ("cal", None, ("我只是问问，没有别的意思。", "我就随口一说。")),
    "NP13": ("cal", None, ("{food}是谁做的？", "这饭什么时候做的？")),
    "NP14": ("test", "new_combination", ("他刚才说不用留了。", "{food}的事他提过一句。")),
    "NP15": ("test", "language_ood", ("要说顺序，他昨天提过一嘴，今天没再说。", "{food}的事是昨天的说法，今天没提。")),
    # ---------------- NEEDS_CLARIFICATION ----------------
    "NC01": ("train", None, ("先吃吧。", "先吃。")),
    "NC02": ("train", None, ("留一点，别都吃了。", "{polite}留一点。")),
    "NC03": ("train", None, ("你先还是我先？", "我们谁先吃？")),
    "NC04": ("train", None, ("他说你先吃，但我也想先吃。", "你想先吃，我也想先吃。")),
    "NC05": ("train", None, ("别等我，但也别先吃。", "不用等我，不过也别先动。")),
    "NC06": ("train", None, ("那份留着，这份你先吃。", "这份留给他，那份你吃。")),
    "NC07": ("train", None, ("刚才说的还算吗？", "之前说的那个顺序还算数吗？")),
    "NC08": ("train", None, ("你俩谁先吃？", "你们谁先？")),
    "NC09": ("train", None, ("先别吃。", "先别动。")),
    "NC10": ("dev", None, ("给我留点，你先吃。", "{food}留点，你先来。")),
    "NC11": ("dev", None, ("他说让我先吃，你说你先吃，到底谁先？", "一个说你先，一个说我先。")),
    "NC12": ("cal", None, ("这份给谁？", "{food}是给谁的？")),
    "NC13": ("cal", None, ("你先吃还是他先吃？", "你们俩谁先？")),
    "NC14": ("test", "new_combination", ("不是不让你吃，是顺序没说清。", "吃可以，谁先没说。")),
    "NC15": ("test", "language_ood", ("他说“你先吃”，可你又说“他先吃”，我该听谁的？", "一个说你先，一个说他先，{food}到底谁先？")),
}

FAMILY_CLASS = {fid: fid[:2] for fid in FAMILIES}
CLASS_OF_PREFIX = {"PF": "PLAYER_FIRST", "NF": "NPC_FIRST", "NP": "NO_PRIORITY_REQUEST", "NC": "NEEDS_CLARIFICATION"}


def common_text(case: dict, order_index: int) -> str:
    lines = [
        "任务：只判断玩家当前这句话请求“谁先吃”，不要判断 NPC 是否答应。",
        f"可见上下文：{case['visibleInput']['context']}",
        f"玩家原文：「{case['visibleInput']['playerText']}」",
        "候选：",
    ]
    for letter, stable in zip(LETTERS, ORDERS[order_index]):
        lines.append(f"{letter}. {CANDIDATE_TEXT[stable]}")
    return "\n".join(lines)


def build_cases() -> list[dict]:
    rng = random.Random(SEED)
    rows: list[dict] = []
    for prefix, class_id in CLASS_OF_PREFIX.items():
        families = [fid for fid in FAMILIES if fid.startswith(prefix)]
        for split in ("train", "dev", "cal", "test"):
            split_families = [fid for fid in families if FAMILIES[fid][0] == split]
            target = PER_CLASS[split]
            per_family = target // len(split_families)
            extra = target - per_family * len(split_families)
            index = 0
            for fam_index, fid in enumerate(split_families):
                count = per_family + (1 if fam_index < extra else 0)
                _, ood_kind, templates = FAMILIES[fid]
                made = 0
                attempt = 0
                seen: set[tuple[str, str]] = set()
                while made < count:
                    template = templates[(made + attempt) % len(templates)]
                    food = FOODS[(made * 3 + attempt + fam_index) % len(FOODS)]
                    polite = POLITE[(made + attempt * 2) % len(POLITE)]
                    context = CONTEXTS[(made + attempt + fam_index) % len(CONTEXTS)]
                    text = template.replace("{food}", food).replace("{polite}", polite).strip()
                    key = (context, text)
                    attempt += 1
                    if key in seen:
                        if attempt > 400:
                            raise RuntimeError(f"cannot fill {fid} without duplicates")
                        continue
                    seen.add(key)
                    index += 1
                    case_id = f"jev01-{split}-{prefix}-{index:03d}"
                    rows.append({
                        "caseId": case_id,
                        "groupId": fid,
                        "provenance": {
                            "kind": "synthetic_template",
                            "family": fid,
                            "templateIndex": templates.index(template),
                            "seed": SEED,
                            "captureRef": "capture/summary.json",
                        },
                        "split": split,
                        "oodKind": ood_kind,
                        "task": TASK,
                        "visibleInput": {"context": context, "playerText": text},
                        "question": "玩家当前这句话请求谁先吃？",
                        "candidates": [{"id": stable, "text": CANDIDATE_TEXT[stable]} for stable in ORDERS[0]],
                        "labelId": class_id,
                    })
                    made += 1
    rows.sort(key=lambda row: row["caseId"])
    return rows


def main() -> int:
    cases = build_cases()
    by_split: dict[str, list[dict]] = {}
    for case in cases:
        by_split.setdefault(case["split"], []).append(case)
    for split, expected in SPLIT_SIZES.items():
        if len(by_split[split]) != expected:
            raise SystemExit(f"split {split}: {len(by_split[split])} != {expected}")
        labels = {}
        for case in by_split[split]:
            labels[case["labelId"]] = labels.get(case["labelId"], 0) + 1
        if sorted(labels.values()) != [expected // 4] * 4:
            raise SystemExit(f"split {split} is not class-balanced: {labels}")

    # Family integrity: a family belongs to exactly one split.
    fam_split: dict[str, str] = {}
    for case in cases:
        prior = fam_split.setdefault(case["groupId"], case["split"])
        if prior != case["split"]:
            raise SystemExit(f"family {case['groupId']} crosses splits")

    # Public cases: test labels are withheld.
    public = []
    for case in cases:
        row = dict(case)
        if case["split"] == "test":
            row.pop("labelId", None)
        public.append(row)
    write_jsonl(DATA / "base_cases.jsonl", public)

    test = [case for case in cases if case["split"] == "test"]
    write_jsonl(DATA / "test.inputs.jsonl", [
        {k: v for k, v in case.items() if k != "labelId"} for case in test
    ])
    gold = {case["caseId"]: {"labelId": case["labelId"], "oodKind": case["oodKind"], "groupId": case["groupId"]} for case in test}
    gold_payload = {
        "schema": "frostecho.jev01.test-gold/1",
        "sealedAt": "2026-11-09T00:00:00+08:00",
        "gold": gold,
        "sha256": sha256_json(gold),
    }
    write_json(DATA / "test.gold.json", gold_payload)

    stats = {
        "schema": "frostecho.jev01.dataset-stats/1",
        "seed": SEED,
        "ordersPerCase": 2,
        "splits": {split: len(rows) for split, rows in sorted(by_split.items())},
        "perClass": {split: {cls: sum(1 for c in rows if c["labelId"] == cls) for cls in CLASSES} for split, rows in sorted(by_split.items())},
        "families": {split: sorted({c["groupId"] for c in rows}) for split, rows in sorted(by_split.items())},
        "familyCounts": {split: len({c["groupId"] for c in rows}) for split, rows in sorted(by_split.items())},
        "testComposition": {
            kind: sum(1 for c in test if c["oodKind"] == kind) for kind in ("new_combination", "language_ood")
        },
        "hashes": dataset_hashes(cases),
        "testGoldSha256": gold_payload["sha256"],
        "testInputsSha256": sha256_text((DATA / "test.inputs.jsonl").read_text(encoding="utf-8")),
        "limitations": [
            "bounded synthetic/annotated pilot, not 640 real players or an independent natural distribution",
            "families are template families; variants are surface combinations, not independent samples",
            "the only natural-language entry available is the fixed G09 S1 request text",
        ],
    }
    write_json(DATA / "dataset-stats.json", stats)
    print(json.dumps(stats, ensure_ascii=False, indent=1))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
