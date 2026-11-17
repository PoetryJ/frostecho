# JEV-04 数据 v2 审查（R2）

基线：v1 锚点 64 例（`../anchors/`，未改）。v2 全部落在本目录。

## 变更

| 项 | 内容 |
|---|---|
| 迁移 | 64/64 例逐 ID 映射，`provenance.fromV1` 指回旧 caseId |
| 语义修正 | gQ07-A：v1 把“明确取消”标成 leave_food，v2 改为 decline/eat_self；gQ07-B 叙述改为“非直接或无权”，与 facts 一致 |
| 叙述一致性 | 所有 narrative 由 facts 经分类模板生成（`build_cases.py::narrative_for`），A/B 控制对的决定性事实必然反映到文本 |
| 候选 | 每例 K=4，固定七动作词表，id/text/params 齐全；acceptableSet ⊆ 候选 |
| oracle | 可复算 rule + requires（引用 facts id）+ rationale；decision 在候选内 |
| 裁决 | 69 条 v1 分歧逐条：keep 26（review 是 oracle 子集）、revise 4（gQ07 语义修正）、challenge 39（需 H 逐项裁决，不得直接进训练） |
| 拆分 | 沿 v1 sourceGroup：24 组 train / 8 组 dev，同组不跨 split；train 48 / dev 16 |
| 家族 | 32 个 sourceGroup；`generatorSkeleton` 仅 4 种（每类一个）——这是真实独立性边界 |

## 门状态

`gate-v2.json`: `status=blocked`, `mayTrainOnJev=false`。原因：
1. 语义骨架仅 4 种，64 例共享骨架；不能把同骨架改写当独立泛化。
2. 39 条 challenge 未裁决，未重新盲审的修订例不得进训练。
3. 数量 48/16，低于 512/128 目标；本轮按“语义合格小集”推进，不复制扩量。
4. 缺独立 cal/select/cert/test 数据，不能发校准证书。

## 覆盖与限制

- 双审覆盖：64 例均有 v1 两会话记录（s1 缺 gY08-B、重复 gR01-B，原始缺行保留）；本轮无新独立会话，故不标新双审。
- hiddenTruth 为空：v1 未定义隐藏真值，v2 不臆造。
- 动作可执行性：7 动作中 decline/ask_clarify/verify/address_npc 在 v2 里为决策候选（params.action=wait），
  与四日世界命令的映射由 gameplay/planning 层负责，不在数据层伪造执行。
