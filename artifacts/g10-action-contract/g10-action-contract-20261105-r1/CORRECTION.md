# 新批更正附录 — g10-action-contract-20261105-r1

本文件与 `CORRECTION.json` 为**新增**文件；原批文件字节未变（哈希见 CORRECTION.json）。批内记录不重写。

## 事实

- 第7局 `g09-r2-s40-choice` 的 action 相：HTTP 状态 null、error=aborted、无响应体、无 usage、耗时 119029ms → 冻结 120s 上限触发的中止。运行器把它记成了 `empty_output`，这是分类缺陷，真实分类应为 **timeout**。
- 该缺陷已在后续提交修复（无状态且无响应体 → timeout），并以只读复验暴露差异，不修改原记录。

## 派生口径

| 项目 | 值 |
|---|---|
| 协议 | 6 完成 / 1 失败（timeout）/ 1 未运行 |
| 花费 | 14/16（失败计入额度） |
| goal tokens | 1697（7 次已发送且已知） |
| action tokens | 已知小计 4734（6 次成功）；中止那 1 次无 usage → unknown |
| 总量 | null（存在 1 个实际尝试未知）；known 小计 6431 |
| 未发送阶段 | 1 局 × 2 = 2 个 not_run 阶段（成本 0，非 unknown） |

## 世界事实

3 个 choice 局（r1-s40、r1-s60、r2-s60）模型选 yield_once、动作 wait、玩家实际吃到 → fulfilled；self_only 局均 feed_self + eat（NPC 先吃）。第7局请求处于 pending，世界结果 undetermined，不进入有效对照。
