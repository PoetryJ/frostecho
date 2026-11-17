#!/usr/bin/env python3
"""One-off authoring fix: make every NEEDS_CLARIFICATION case a genuine
unresolved precedence question between people (addressee indefinite, or a
"who eats first" question left unanswered).

Timing/activity answers ("eat now or later", "rice first or laundry first") were
rejected as NEEDS_CLARIFICATION by the frozen contract: they express nothing
about precedence, so they do not belong in the scored set.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from r1config import read_jsonl, write_jsonl  # noqa: E402

FIX = {
    # cal-temperature
    "r1-calT-0016": ("室友问玩家和她谁先吃，玩家把调料倒进桶里。", None),
    "r1-calT-0024": ("店员问玩家和他谁先吃，玩家看着锅没回答。", None),
    "r1-calT-0032": ("同事问玩家和他谁先涮，玩家正在调小料。", None),
    "r1-calT-0040": ("同伴问玩家和他谁先吃，玩家翻着玉米。", "等汤开了再说吧。"),
    "r1-calT-0048": ("家属问玩家和他谁先吃，玩家盖着保温桶。", "我也说不准。"),
    "r1-calT-0064": ("对铺问玩家和他谁先吃，玩家靠着窗。", None),
    "r1-calT-0072": ("老义工问玩家和他谁先吃，玩家摆着碗筷。", None),
    "r1-calT-0080": ("船老大问玩家和他谁先吃，玩家看着还晃的锅。", None),
    "r1-calT-0088": ("寿星问玩家和她妹妹谁先吃，玩家举着手机。", None),
    "r1-calT-0096": ("同事问玩家和他谁先吃，玩家看着盒子。", "看谁更饿吧。"),
    "r1-calT-0104": ("老师问玩家和她谁先吃，玩家蹲下给孩子穿鞋。", "没定呢，等会儿再说。"),
    "r1-calT-0112": ("场务问玩家和他谁先吃，玩家看着路口。", None),
    "r1-calT-0120": ("研友问玩家和他谁先吃，玩家看着还合着的书。", None),
    "r1-calT-0128": ("妈妈问玩家和爸爸谁先吃，玩家看了眼挂钟。", None),
    # cal-policy
    "r1-calP-0008": ("同学问玩家和他谁先吃，玩家看着时间表。", None),
    "r1-calP-0016": ("同事问玩家和他谁先吃，玩家翻着交接本。", "还没想好。"),
    "r1-calP-0024": ("主人问玩家和她谁先喝，玩家搓着手。", None),
    "r1-calP-0032": ("熟客问玩家和他谁先吃，玩家手还放在键盘上。", None),
    "r1-calP-0040": ("表姐问玩家和她谁先吃，玩家放下筷子。", "等敬完酒再说。"),
    "r1-calP-0048": ("病人问玩家和他谁先吃，玩家盖回果篮。", "先放着吧，没定。"),
    "r1-calP-0056": ("邻居问玩家和她谁先吃，玩家看着盘子。", "还没拿定主意。"),
    "r1-calP-0064": ("朋友问玩家和他谁先吃，玩家看着路口。", "等他们到了再说。"),
    "r1-calP-0072": ("教练问玩家和他谁先吃，玩家摸着方向盘。", None),
    "r1-calP-0080": ("阿姨问玩家和她谁先吃，玩家看着钟。", "我还没拿定主意。"),
    "r1-calP-0088": ("小哥问玩家和他谁先吃，玩家看着门外。", "卸完再说。"),
    "r1-calP-0096": ("同学问玩家和他谁先吃，玩家看了眼书页。", "都行吧。"),
    "r1-calP-0104": ("老人问玩家和她谁先吃，玩家看着表。", "我也说不准。"),
    "r1-calP-0112": ("队友问玩家和他谁先吃，玩家系着护膝。", "还没想好。"),
    "r1-calP-0120": ("摊主问玩家和她谁先吃，玩家看着蒸笼。", None),
    "r1-calP-0128": ("家长问玩家和孩子谁先吃，玩家看着书房。", "没定呢，等会儿再说。"),
    # test
    "r1-test-0008": ("父亲问玩家和他谁先吃，玩家看着挂钟。", "还没想好。"),
    "r1-test-0016": ("妹妹问哥哥和她谁先吃，玩家拿着打火机。", None),
    "r1-test-0024": ("室友问玩家和他谁先吃，玩家系着鞋带。", None),
    "r1-test-0032": ("朋友问玩家和他谁先吃，玩家翻着菜单。", "先放着吧，没定。"),
    "r1-test-0040": ("店员问玩家和他谁先吃，玩家手里拿着身份证。", "你说呢？"),
    "r1-test-0048": ("伙伴问玩家和他谁先吃，玩家看着锅里的面。", None),
    "r1-test-0056": ("同伴问玩家和他谁先吃，玩家把纸袋折起来。", "看完再说吧。"),
    "r1-test-0064": ("老板问玩家和他谁先吃，玩家看着蒸笼。", "还没拿定主意。"),
    "r1-test-0072": ("同事问玩家和他谁先吃，玩家看着投屏。", None),
    "r1-test-0080": ("好友问玩家和她谁先吃，玩家翻着菜单。", "我也说不准。"),
    "r1-test-0088": ("对方问玩家和她谁先吃，玩家放下筷子。", "都行吧。"),
    "r1-test-0096": ("爷爷问玩家和他谁先吃，玩家看着门口。", "没定呢，等会儿再说。"),
    "r1-test-0104": ("表哥问玩家和他谁先吃，玩家看着舞台。", "等仪式完吧。"),
    "r1-test-0112": ("病人问玩家和他谁先吃，玩家看着还热的饭盒。", "还没想好。"),
    "r1-test-0120": ("战友问玩家和他谁先吃，玩家看着背包。", "到营地再说吧。"),
    "r1-test-0128": ("化妆师问玩家和她谁先吃，玩家看着通告。", "先放着吧，没定。"),
    "r1-test-0136": ("店主问玩家和他谁先吃，玩家看着烘干箱。", "等猫吹完吧。"),
    "r1-test-0144": ("舞台监督问玩家和他谁先吃，玩家看着化妆镜。", "谢幕再说吧。"),
    "r1-test-0156": ("流浪者问玩家和他谁先吃，玩家看着饭盒。", "我也说不准。"),
    "r1-test-0164": ("司机问玩家和他谁先吃，玩家看着窗外的路牌。", "到家再说。"),
    "r1-test-0172": ("老板问玩家和他谁先吃，玩家看着楼梯。", "等他们起来吧。"),
    "r1-test-0180": ("阿姨问玩家和她谁先吃，玩家看着餐盘。", "都行吧。"),
    "r1-test-0188": ("母亲问玩家和她谁先吃，玩家看着门口。", "等爸回来吧。"),
    "r1-test-0196": ("姑姑问玩家和她谁先吃，玩家看着桌上的菜。", "还没拿定主意。"),
    "r1-test-0204": ("母亲问玩家和她谁先吃，玩家摸着笔。", "还没想好。"),
    "r1-test-0212": ("老居士问玩家和他谁先吃，玩家摆着碗筷。", "按规矩来，我跟着。"),
    "r1-test-0220": ("乘务员问玩家和他谁先吃，玩家看着餐车。", "还没想好。"),
    "r1-test-0228": ("同事问玩家和他谁先热，玩家看着时间。", "没定呢，等会儿再说。"),
    "r1-test-0236": ("同伴问玩家和他谁先吃，玩家看着门口。", "等他们来吧。"),
    "r1-test-0244": ("业主问玩家和他谁先吃，玩家看着工具箱。", "修完再说吧。"),
    "r1-test-0252": ("对方问玩家和她谁先吃，玩家放下牙签。", "都行，随你。"),
    "r1-test-0260": ("搭档问玩家和他谁先吃，玩家看着垫子。", "拉伸完再说。"),
}

REASON = {
    "regression": "玩家在明确'谁先吃'的提问下仍未指定任何人，优先权未定。",
}


def main() -> int:
    applied = 0
    for path in sorted(HERE.glob("*.part*.jsonl")):
        rows = read_jsonl(path)
        changed = False
        for row in rows:
            fix = FIX.get(row["caseId"])
            if not fix:
                continue
            context, text = fix
            if row["labelId"] != "NEEDS_CLARIFICATION":
                raise SystemExit(f"{row['caseId']} is not NC; refusing to rewrite it")
            row["context"] = context
            if text:
                row["playerText"] = text
            row["reason"] = REASON["regression"]
            row["provenance"]["rule"] = "R1/R8"
            changed = True
            applied += 1
        if changed:
            write_jsonl(path, rows)
    print(json.dumps({"applied": applied, "expected": len(FIX)}, ensure_ascii=False))
    return 0 if applied == len(FIX) else 1


if __name__ == "__main__":
    raise SystemExit(main())
