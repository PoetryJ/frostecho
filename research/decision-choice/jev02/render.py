"""Structural prompt rendering: positions come from the renderer's own block.

The player text is placed in the context slot and is NEVER searched for
"候选：" or letters. Candidate lines are appended by this module and their
character ranges are known by construction; token positions come from the
tokenizer's offset map over that range.
"""
from __future__ import annotations

import contracts as C
from contracts import LETTER_LABEL, LETTERS, ORDERS

QUESTION = "玩家现在把优先权交给谁？只按这句话和上下文判断。"
HEADER = "候选："
J_TAIL = '\n只输出一个 JSON 对象：{"selectedId":"A"}（A-D 是上面的显示标签）'


def build(case: dict, order_index: int, arm: str = "label") -> dict:
    order = ORDERS[order_index]
    lines = [f"{letter}. {LETTER_LABEL[stable]}" for letter, stable in zip(LETTERS, order)]
    block = HEADER + "\n" + "\n".join(lines)
    context = case["visibleInput"]["context"]
    player = case["visibleInput"]["playerText"]
    content = f"context: {context}\nplayer: {player}\n{QUESTION}\n{block}"
    if arm == "json":
        content += J_TAIL
    content_start = content.index(f"context: {context}")
    block_start = content_start + len(f"context: {context}\nplayer: {player}\n{QUESTION}\n{HEADER}\n")
    candidate_ranges = []
    cursor = block_start
    for line in lines:
        candidate_ranges.append((cursor, cursor + len(line)))
        cursor += len(line) + 1
    return {"content": content, "lines": lines, "order": order,
            "contentStart": content_start, "blockStart": block_start,
            "candidateRanges": candidate_ranges, "linesText": lines}


def rendered_chat(tokenizer, case: dict, order_index: int, arm: str = "label") -> dict:
    built = build(case, order_index, arm)
    text = tokenizer.apply_chat_template(
        [{"role": "user", "content": built["content"]}],
        tokenize=False, add_generation_prompt=True, enable_thinking=False,
    )
    # One search for the WHOLE assembled content (never for player text or a header).
    start = text.find(built["content"])
    if start < 0 or text.find(built["content"], start + 1) >= 0:
        raise ValueError("the assembled content is not present exactly once in the rendered chat")
    encoded = tokenizer(text, add_special_tokens=False, return_offsets_mapping=True)
    ids = encoded["input_ids"]
    offsets = encoded["offset_mapping"]
    positions = []
    for begin, end in built["candidateRanges"]:
        absolute_end = start + end
        position = None
        for index, (token_start, token_end) in enumerate(offsets):
            if token_start <= absolute_end - 1 < token_end:
                position = index
                break
        if position is None or position >= len(ids) - 1:
            raise ValueError("a candidate line has no token position")
        positions.append(position)
    if len(set(positions)) != len(ORDERS[0]):
        raise ValueError("candidate positions are not distinct")
    return {"rendered": text, "ids": ids, "positions": positions,
            "final": len(ids) - 1, "content": built["content"],
            "contentStart": start, "built": built}
