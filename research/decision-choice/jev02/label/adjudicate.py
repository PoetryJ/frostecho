"""Main-agent adjudication of the 30 blind/author disagreements.

Rubric (written before any model prediction):
  correction with explicit second person -> that person first;
  "don't leave it for me, you eat" -> NPC first;
  availability question with no ordering request -> no priority;
  a third-party beneficiary plus a second-person eater -> still ambiguous.

Any item the rubric cannot settle becomes an unscored challenge item.
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import contracts as C
from contracts import read_json, read_jsonl, sha256_json, write_json

PF, NF, NP, NC = "PLAYER_FIRST", "NPC_FIRST", "NO_PRIORITY_REQUEST", "NEEDS_CLARIFICATION"


def rubric(text: str) -> tuple[str | None, str]:
    t = text.replace(" ", "")
    if re.search(r"不是我先.{0,4}(是)?你", t):
        return NF, "explicit correction names the NPC as first"
    if re.search(r"不是你先.{0,4}(是)?我", t):
        return PF, "explicit correction names the player as first"
    if re.search(r"(别|不用)留给我.{0,8}你(先)?吃", t):
        return NF, "revocation of the player's share plus an explicit NPC order"
    if re.search(r"有(饭|面|汤|菜)吗", t) and not re.search(r"(先|留|给|归)", t):
        return NP, "availability question only, no ordering request"
    if re.search(r"给他留点.{0,8}你也吃", t):
        return NC, "third-party share plus a second-person eater; order undecidable"
    return None, "rubric cannot settle this item"


def main() -> None:
    gold = read_json(C.DATA / "test.gold.json")
    blind = read_json(C.DATA / "blind-labels.json")["rows"]
    inputs = {row["caseId"]: row for row in read_jsonl(C.DATA / "test.inputs.jsonl")}
    blind_by_id = {row["caseId"]: row for row in blind}
    disagreements = []
    final = dict(gold["gold"])
    for case_id, entry in gold["gold"].items():
        b = blind_by_id[case_id]
        if b["blindLabel"] == entry["labelId"]:
            continue
        decision, why = rubric(b["playerText"])
        disagreements.append({
            "caseId": case_id, "family": entry["family"], "authorLabel": entry["labelId"],
            "blindLabel": b["blindLabel"], "blindRule": b["rule"], "playerText": b["playerText"],
            "adjudicated": decision, "challenge": decision is None, "rationale": why,
        })
        if decision is not None and decision != entry["labelId"]:
            disagreements[-1]["challenge"] = True
            disagreements[-1]["rationale"] = why + "; adjudication contradicts the authored label"
    challenged = {row["caseId"] for row in disagreements if row["challenge"]}
    for case_id in challenged:
        final[case_id]["excluded"] = True
    payload = {
        "schema": "frostecho.jev02.gold-adjudicated/1",
        "at": C.now_iso(),
        "baseGoldSha256": gold["sha256"],
        "disagreements": len(disagreements),
        "challenged": len(challenged),
        "challengedIds": sorted(challenged),
        "gold": final,
    }
    payload["sha256"] = sha256_json(final)
    write_json(C.DATA / "test.gold.json", payload)
    write_json(C.LABEL / "disagreements.json", {
        "schema": "frostecho.jev02.disagreements/1", "at": C.now_iso(),
        "blindSha256": read_json(C.DATA / "blind-labels.json")["labelsSha256"],
        "rows": disagreements,
    })
    print({"disagreements": len(disagreements), "challenged": len(challenged),
           "goldSha256": payload["sha256"][:16]})


if __name__ == "__main__":
    main()
