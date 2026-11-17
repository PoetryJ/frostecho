# 锚点盲审规则（审查者只看本文件与 anchors-blind.jsonl）

动作词表（只能从中选，可多选）：
`leave_food` 留饭给玩家；`eat_self` 自己先吃；`ask_clarify` 向玩家澄清；
`verify` 核实消息来源；`decline` 明确拒绝；`address_npc` 对唯一确定的 NPC 说话；`wait` 等待。

判定顺序：
1. **可见性**：只看 facts 标明该角色已获知/在场的信息。未获知的变化不得当作已知。
2. **来源权限**：只有承诺双方（promisor/promisee）可以撤销；第三方转述、引述、推断不改变有效承诺。
3. **引述层级**：`quoteDepth >= 1` 是转述，不构成新的有效指令；`quoteDepth = 0` 且 `directStatementAuthorized` 才是直接表态。
4. **收话人唯一性**：`explicitAddressee` 或 `presentOthers = 1` 才可唯一指向；`presentOthers >= 2` 且未点名 → 澄清；无人 → 等待。
5. **知识不对称**：`knowsCancellation = true` 时不得执行过时承诺；未获知时保留旧知识（可以留饭/澄清），并明确这不是"记忆错误"。
6. **库存**：`foodStock = 0` 时不能承诺实际留饭，应澄清或求援。

`control` 提示（仅审查者可读）：成功=合理动作应改变；不变=两个成员应给同一集合；
应改变/不应改变=该事实变化是否改变决策。不要为了让两个成员不同而编造动作。

输出格式：每行一个 JSON：
`{"caseId":"...","labels":["..."],"rule":"...","confidence":"high|medium|low"}`
必须覆盖全部 64 个 caseId；不得读取 `anchors.jsonl`、`make_anchors.py` 或其他含标准答案的文件。
