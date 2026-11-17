# 旧批更正附录 — g10-live-20261105-r1

2026-11-05 · 本文件与 `CORRECTION.json` 为**新增**文件；原 19 个批文件字节未变（哈希见 CORRECTION.json）。

## 重新派生口径

协议完成不再读取记录自报的 `outcome/parseOk`，而从原始 HTTP、严格解析、会话命令账本重算：

| 项目 | 原 summary | 更正后（派生） |
|---|---|---|
| 协议完成 | 2 | **1**（仅第1局两阶段均合法） |
| 协议失败 | 0 | **1**（第2局 action 截断） |
| 未运行 | 6 | 6 |
| goal 解析失败 | 1（误判） | 0（feed_self 合法解析、无 binding 是设计结果） |

## 世界事实（保留，不并入协议成功）

第2局玩家确实吃到、请求 outcome=fulfilled —— 该世界事实保留在 `fulfilment.world`（fulfilled=1）；但其 action 相 HTTP 200、`finish_reason=length`、最终 content 为空，被判 `output_truncated`、不进入有效行为对照。

## 成本

4 次已发送请求 usage 全部已知：goal 474 + action 2021 = **2495**；未发送的 12 个阶段为 `not_run`（成本 0，**不是** unknown）；总请求耗时 189917ms。

## 不改原件

`summary.json` 等原文件原样保留；新核验器对该批仍报不一致并 **exit 1**（旧错误不被豁免）。
