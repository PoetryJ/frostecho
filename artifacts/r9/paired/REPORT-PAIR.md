# R9 四日对照：reference 规则 vs 真实 JEV（random-43）

同 seed `live-pair-r9`、同 profile gospel-5.8.19、同 `--full-map`、同初态。

| 指标 | reference | JEV(random-43) |
|---|---|---|
| 结局 | perfect / 8 存活 | perfect / 8 存活 |
| elapsed | 4920 | 4920 |
| 决策 / 已执行 / 拒绝 | 344 / 88 / 0 | 360 / 128 / 0 |
| 完成任务 | 36 / 44 | 35 / 40 |
| 工时记录 | 276 | 232 |
| 最终食物 | 537 | 649 |
| 最终木柴 | 31.0 | 0 |
| 最终电力 | 0 | 0 |
| 最终药品 | 3 | 3 |
| world version | 1624 | 627 |

JEV 真实模型调用 320 次，延迟 median 9.45s / p95 9.71s / max 76.4s（首次加载）。
按 9.45s × 320 ≈ 50.4 分钟单卡占用 ≈ 0.84 GPU·时。

## 结论
- 存活与结局：**平局**（都 perfect/8/4920）。
- 经济路径不同：JEV 采集更多食物（649 vs 537）但木柴清零（0 vs 31），说明新头偏好食物采集，且反复选同一动作（npc_01 同一 gather 20 次），没有表现出资源多样性。
- 无拒绝、无服务失败：两臂 0 拒绝；JEV 无回退到规则（320 次调用全部来自真实服务）。
- 不宣称优于 reference：存活平局、任务数略低、资源结构更单一。

## 复跑
见 REPORT-C.md 与 scripts/r8/playthrough.js（--mode reference / --mode jev-experimental --scorer-command-json）。
