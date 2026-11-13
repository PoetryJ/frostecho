"""Compact authoring DSL for the 768 scored cases.

A group is one scene with eight cases (two per class). `base` states place, who
is present and the state of the food; each case adds the local clause that makes
the addressee/offer precise. Contexts and player lines are written per case; the
label is carried by the move code, and `build.py` refuses a group whose move mix
is not exactly two per class.
"""
from __future__ import annotations

MOVE_RULE = {
    "PF1": ("PLAYER_FIRST", "R4a", "唯一收话人下明说玩家自己先吃"),
    "PF2": ("PLAYER_FIRST", "R4a", "接受对方让先，自称先动"),
    "PF3": ("PLAYER_FIRST", "R4a", "带条件的自称先吃，方向唯一"),
    "PF4": ("PLAYER_FIRST", "R4a", "先转述对方让先、再表明自己先"),
    "NF1": ("NPC_FIRST", "R4b", "明说把先吃让给唯一NPC"),
    "NF2": ("NPC_FIRST", "R7", "省略主语但收话人唯一，让先"),
    "NF3": ("NPC_FIRST", "R5", "给自己留一份同时让对方先吃"),
    "NF4": ("NPC_FIRST", "R7", "带理由让唯一NPC先吃，无凭空规矩"),
    "NO1": ("NO_PRIORITY_REQUEST", "R2", "只评论食物/服务/位置，无先后安排"),
    "NO2": ("NO_PRIORITY_REQUEST", "R5", "只分份/留饭/打包，无先后安排"),
    "NO3": ("NO_PRIORITY_REQUEST", "R6", "只复述过去怎么吃，无当前安排"),
    "NO4": ("NO_PRIORITY_REQUEST", "R10", "多人在场但整句无先后词"),
    "NC1": ("NEEDS_CLARIFICATION", "R8", "出现先后词但两个以上候选收话人无线索"),
    "NC2": ("NEEDS_CLARIFICATION", "R8", "被问先后后把方向留空"),
    "NC3": ("NEEDS_CLARIFICATION", "R6", "只转述他人意见，无本人请求"),
    "NC4": ("NEEDS_CLARIFICATION", "R8", "先后请求成立但必要条件/指代不唯一"),
}


def G(gid: str, scene: str, base: str, cases: list[tuple[str, str, str]]) -> dict:
    return {"gid": gid, "scene": scene, "base": base, "cases": cases}


TRAIN_MOVES = ("PF1", "PF2", "NF1", "NF2", "NO1", "NO2", "NC1", "NC2")
