"""D: independent blind test construction (separate pool from A) + sealing."""
from __future__ import annotations

import sys
from collections import Counter
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import contracts as C
from contracts import CLASSES, sha256_json, write_json, write_jsonl
from data.patterns import CONTEXTS_TEST, FAKE_BLOCK_CASES, OBJECTS, TEST_PATTERNS

SHORT = {"PLAYER_FIRST": "PF", "NPC_FIRST": "NF", "NO_PRIORITY_REQUEST": "NP", "NEEDS_CLARIFICATION": "NC"}
PER_FAMILY = 8


def main() -> None:
    cases: list[dict] = []
    gold: dict[str, dict] = {}
    for cls in CLASSES:
        for pattern_index, pattern in enumerate(TEST_PATTERNS[cls]):
            family = f"test-{SHORT[cls]}-{pattern_index:02d}"
            ood = "new_combination" if pattern_index < 4 else "language_ood"
            contexts = [CONTEXTS_TEST[(pattern_index + k) % len(CONTEXTS_TEST)] for k in range(2)]
            made = 0
            for context_template in contexts:
                for obj in OBJECTS:
                    if made >= PER_FAMILY:
                        break
                    context = context_template.format(obj=obj)
                    text = pattern.format(obj=obj)
                    case_id = f"jev02-test-{SHORT[cls]}-{len(cases):04d}"
                    cases.append({
                        "caseId": case_id, "split": "test", "groupId": family,
                        "labelId": cls, "oodKind": ood,
                        "provenance": {"source": "synthetic_dialogue", "author": "coding-agent",
                                       "family": family, "patternIndex": pattern_index, "object": obj},
                        "visibleInput": {"context": context, "playerText": text},
                    })
                    gold[case_id] = {"labelId": cls, "family": family, "oodKind": ood}
                    made += 1
            if made != PER_FAMILY:
                raise RuntimeError(f"{family}: {made} cases")
    if len(cases) != 256:
        raise RuntimeError(len(cases))
    # Test inputs NEVER carry the label; gold lives in a separate sealed file.
    inputs = [{"caseId": case["caseId"], "groupId": case["groupId"],
               "visibleInput": case["visibleInput"]} for case in cases]
    write_jsonl(C.DATA / "test.inputs.jsonl", inputs)
    sealed = {"schema": "frostecho.jev02.gold/1", "at": C.now_iso(),
              "gold": gold, "sha256": sha256_json(gold)}
    write_json(C.DATA / "test.gold.json", sealed)
    write_jsonl(C.DATA / "position-regression.jsonl", [
        {"caseId": f"pos-{index}", "labelId": cls,
         "visibleInput": {"context": "厨房里有一份饭，玩家刚进门。", "playerText": text.format(obj="饭")}}
        for index, (cls, text) in enumerate(FAKE_BLOCK_CASES)
    ])
    fam = Counter(case["groupId"] for case in cases)
    stats = {
        "schema": "frostecho.jev02.test-stats/1",
        "at": C.now_iso(),
        "cases": len(cases), "families": len(fam), "perClass": dict(Counter(c["labelId"] for c in cases)),
        "perOod": dict(Counter(c["oodKind"] for c in cases)),
        "uniqueDialogues": len({sha256_json(c["visibleInput"]) for c in cases}),
        "uniquePlayerTexts": len({c["visibleInput"]["playerText"] for c in cases}),
        "familySizes": sorted(fam.values()),
        "testInputsSha256": sha256_json(inputs),
        "testGoldSha256": sealed["sha256"],
        "limitations": ["coding-agent synthetic_dialogue; no human labels",
                        "32 families = 8 per class; not an IID sample"],
    }
    write_json(C.DATA / "test-stats.json", stats)
    print(json.dumps({"cases": len(cases), "families": len(fam), "sha": sealed["sha256"][:16],
                      "perClass": stats["perClass"], "perOod": stats["perOod"]}))


if __name__ == "__main__":
    import json
    main()
