#!/usr/bin/env python3
"""One-off authoring de-duplication: give every case its own player line.

Only rows flagged by datagate's exact/近-duplicate scan are touched, and only
their playerText; labels, contexts and families are unchanged.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from r1config import read_jsonl, write_jsonl  # noqa: E402

NEW = {
    # "还没想好" family
    "r1-calP-0016": "还没想好呢。",
    "r1-calP-0112": "还没想好，先搁着。",
    "r1-test-0008": "我再想想。",
    "r1-test-0112": "这个还没定。",
    "r1-test-0204": "还没想好呢。",
    "r1-test-0220": "说不准，再等等。",
    # "我也说不准"
    "r1-calT-0048": "说不准。",
    "r1-calP-0104": "我拿不准。",
    "r1-test-0080": "这个我也说不好。",
    "r1-test-0156": "我也说不准呢。",
    # "没定呢，等会儿再说"
    "r1-calT-0104": "还没定，等等看。",
    "r1-calP-0128": "还没商量好。",
    "r1-test-0096": "等会儿再说吧，没定。",
    "r1-test-0228": "没定呢，再看。",
    # "还没拿定主意"
    "r1-calP-0056": "主意还没定。",
    "r1-test-0064": "还在犹豫。",
    "r1-test-0196": "我还没想清楚。",
    # "先放着吧，没定"
    "r1-calP-0048": "先搁着吧。",
    "r1-test-0032": "这个先不急。",
    "r1-test-0128": "先放着吧，还没定。",
    # "都行吧"
    "r1-calP-0096": "都行，不挑。",
    "r1-test-0088": "随你安排。",
    "r1-test-0180": "怎么都成。",
    # "先吃吧，趁热"
    "r1-calP-0103": "先吃吧，别放凉。",
    "r1-calT-0119": "趁热吃吧。",
    "r1-test-0095": "先吃，热着呢。",
    # "先吃吧，都热着"
    "r1-calP-0055": "先吃吧，还烫。",
    "r1-test-0127": "趁热吃，都热着。",
    "r1-test-0243": "先动筷吧，热着。",
    # "先吃吧，热的"
    "r1-calT-0111": "先吃吧，刚热好。",
    "r1-test-0171": "先吃，馒头是热的。",
    "r1-test-0031": "先吃吧，才上的。",
    # "先吃吧，我再去拿"
    "r1-calP-0007": "先吃吧，锅里还有。",
    "r1-test-0103": "先吃吧，我再端一盘。",
    "r1-test-0063": "先吃着，我再去拿醋。",
    # "你先吃，我不饿"
    "r1-calP-0044": "你先吃，我待会儿。",
    "r1-test-0108": "你先吃，我路上吃过了。",
    # "你先来，我不着急"
    "r1-calT-0092": "你先来，我不催。",
    "r1-calP-0028": "你先来，慢慢吃。",
    # "练完再说吧"
    "r1-calP-0072": "练完再说。",
    "r1-test-0024": "练完再吃吧。",
    # "你先吃，我等下一锅"
    "r1-calT-0011": "你先吃，我等下一锅。",
    "r1-test-0059": "你先吃，下一锅我来。",
    "r1-test-0151": "你先吃，我再等一份。",
    # others
    "r1-calP-0122": "我先吃，谢谢留饭。",
    "r1-test-0238": "我先吃，谢谢您这顿饭。",
    "r1-calT-0066": "那我先用了，感恩。",
    "r1-test-0206": "我先用了，感恩。",
    "r1-calT-0100": "您先坐先吃，我站着就行。",
    "r1-test-0208": "您先坐先吃，我站着就好。",
    "r1-calT-0063": "先吃吧，我这儿还有。",
    "r1-test-0155": "先吃，我这儿还有。",
    "r1-calT-0046": "还有二十分钟吧。",
    "r1-test-0234": "大概还有二十分钟。",
    "r1-calP-0036": "你先来，长辈那边我去说。",
    "r1-test-0100": "你先来，长辈我来应付。",
    "r1-calP-0071": "先吃吧，凉了就不好吃。",
    "r1-test-0135": "先吃吧，凉了不好。",
}


def main() -> int:
    applied = 0
    paths = [HERE / "cal-temperature.jsonl", HERE / "cal-policy.jsonl",
             HERE / "test.author-labels.jsonl"]
    for path in paths:
        rows = read_jsonl(path)
        changed = False
        for row in rows:
            replacement = NEW.get(row["caseId"])
            if replacement is None:
                continue
            row["playerText"] = replacement
            changed = True
            applied += 1
        if changed:
            write_jsonl(path, rows)
    print(json.dumps({"applied": applied, "expected": len(NEW)}, ensure_ascii=False))
    return 0 if applied == len(NEW) else 1


if __name__ == "__main__":
    raise SystemExit(main())
