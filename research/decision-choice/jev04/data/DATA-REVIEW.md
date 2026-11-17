# R1 数据与锚点审查（A/H）

## 1. 64 锚点（32 源组 × 2）

- 文件：`anchors/anchors.jsonl`；盲审输入：`anchors/anchors-blind.jsonl`。
- 4 类 × 16 例：revocation / quotation / addressee / asymmetry。
- 每例有 caseId、sourceGroup、结构化 facts、可选动作集、oracle 推导、control、evidence SHA。
- 事实唯一性：64/64 组 facts 不同；32 个源组，未用改名扩量。
- 控制类型：success 14、should_change 29、should_not_change 15、invariant 6。

## 2. 两个独立盲审会话（只读 blind + 规则，不看 oracle）

| 会话 | 行数 | 唯一 ID | 重复 | 缺行 | 可比较 | 集合完全一致 | 允许子集 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| s1 | 64 | 63 | gR01-B | gY08-B | 63 | 33 (52.4%) | 44 (69.8%) |
| s2 | 64 | 64 | 0 | 0 | 64 | 25 (39.1%) | 40 (62.5%) |

- 原始输出：`anchors/review-session-1.jsonl`、`review-session-2.jsonl`；未做“清理后重算”。
- 会话间完全一致率与逐类分解：`anchors/review-agreement.json`。
- 全部分歧：`anchors/review-disagreements.jsonl`（H 持有，未按模型输出改题）。
- **已知缺陷**：s1 有 1 个重复 ID、缺 gY08-B；该 ID 必须重标后才能称完整覆盖。

## 3. 旧 16 缺标 + 5 条更正复核

- 独立复核会话逐 ID 输出：`anchors/old-labels-review.jsonl`。
- 结果：16/16 同意，5/5 更正同意；旧 gold/预测/账本未改。

## 4. 首批 train/dev（较小合格组）

- `anchors/split.json`：24 源组 → train 48 例；8 源组 → dev 16 例；每类 6/2。
- 组不交叉（overlap=[]），同一 pair/模板不跨 split；三臂共用 caseId 掩码。
- 这不是 512/128 目标，也未声称等价；只作为较小合格组登记。

## 5. 门控结论（仍未通过）

`data/gate.json`：`mayTrainOnJev=false`。
原因：
1. train/dev=48/16，低于 512/128 推进目标；
2. s1 缺行/重复，覆盖不完整；
3. 两会话与 oracle 存在分歧，未完成 challenge 预注册；
4. 无 cal/select/cert/test 独立分组；
5. 本地无 Qwen3.5-27B/4B 权重。

未使用任何模型输出挑选锚点或修改标签。
