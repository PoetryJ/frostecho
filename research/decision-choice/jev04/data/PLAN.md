# JEV-04 数据计划与门控（A）

## 目标矩阵（未完成）

| split | cases | 用途 |
| --- | --- | --- |
| train | 2048 | 训练 |
| dev | 256 | epoch/seed/路线选择 |
| calT | 256 | 温度拟合 |
| select | 512 | tau/策略选择 |
| cert | 512 | 独立风险证书 |
| test | 512 | 最终评估（不调参） |

分组规则：先按源规则 → 语义骨架 → 改写家族分组，再分 split；同一 pair、改写和模板必须同组；
场景换名不算独立样本。至少 4 个实际作者/复核会话，逐 caseId 保留原始意见与分歧。

## 当前状态：**门控未通过（blocked）**

| 项 | 状态 | 证据 |
| --- | --- | --- |
| 五条硬 gold 错更正 | 已派生（只读） | `research/decision-choice/jev04/cpu-closeout/corrections/gold-corrections.json` |
| 16 条缺标补齐 | 已补，但非独立双标 | `corrections/missing-blind-16.jsonl`（provenance 标注 single session） |
| 单序 pair / 四序 stress 分口径 | 已完成 | `recomputed.json` |
| 64 个公开锚点 | 未完成 | 无文件 |
| 4096 主 case | 未完成 | 现有 behavior 192 例、jev03 test 256 例，不可扩名充数 |
| 成功/不变对照集 | 计划已列，未作者化 | `controls-plan.json` |
| 结构化 source facts + oracle | 未完成 | 仅有文本级 evidence hash |

## 结论

- 禁止在门控通过前把 B 的训练说成“JEV 数据训练”；B 本轮只能跑 fixture。
- 旧 JEV-01/02/03/03R1 的 gold、预测、账本、checkpoint 一律不修改。
- 下一步（A）：64 锚点 → 独立复核 16 标 + 5 更正 → 结构化承载者/先后 facts 与 oracle 复算 →
  4 会话作者化 4096；每次修订开新版本，不暗改冻结集。
