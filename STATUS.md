# STATUS — sprint R1（2026-11-11）

基线：`844bab54cacff1ea4fe9b413565d5e57f8bb3ffe`；集成分支 `codex/sprint-1116`。
执行包：`handoff/20261111-sprint-r1` SHA256SUMS 26/26 OK（含 evidence/repros）。

## 先复现，再修复（官方 repros，隔离 clone）

| 复现器 | 基线结果 | 修复后 |
| --- | --- | --- |
| memory-blackbox | 5/5 fail | 5/5 pass |
| choice-probe | 身份/缓存/检索/恢复/外部 selectedId 全反例 | 全部符合契约 |
| cost-probe | 实际 run_job finish=unknown | measured，194940/5432 一致 |
| world-audit | 80h/600h，快照别名污染 | 96h/720h，purity=false changed |
| world-fault | 8 拒绝仍写 8 kept | 拒绝 0 兑现 |
| acceptance-classification | 注入失败仍 exit0/blocked | 判 FAIL 且 exit≠0 |

## 本轮修复

- F：`applyCommand` 深拷贝；NaN/Infinity/非法地图拒绝；24h 日历（4日=96h，30日=720h）；`submitCommand` 返回 commandId/applied/rejected/duplicate/eventIds/postStateVersion。
- D：来源权限看 envelope 而非 payload 声明；`promise_kept` 必须绑定 applied command+beneficiary+event；查询/toJSON 深拷贝；旧 revision 不取消新计划。
- C：请求 digest 覆盖 actor/question/observation/goals/relations/memory/candidates/模型身份；同 ID 异内容开新请求；实时结果重校验；检索 error/incomplete 0 执行；执行分 scored/submit_pending/applied/rejected/unknown，恢复按 commandId 查询；校准 artifact 实载+身份/T/tau。
- E：候选参数可直接映射为 F 命令；公平调度、单 actor 在途唯一、超时/取消/迟到拒绝。
- G：真实 stdin CLI（promise/cancel/tell/step/advance/save/restore），走 `runChoice→submitCommand→事件→记忆`；关系变化仅由确认履约驱动。
- H：验收只按“确切 testId + 失败签名”分类；G11 证据包内置并 SHA 校验后方可解压；去掉跟踪的 node_modules symlink 与 __pycache__。

## 证据

- `artifacts/sprint-r1/acceptance/summary.json`（13 项）
- `artifacts/sprint-r1/world/{matrix,snapshot-purity,runtime-guards}.json`（9 组 96h/720h）
- `artifacts/sprint-r1/play/session.json`（真实玩家轨迹）
- `research/decision-choice/jev04/data/anchors/`（64 锚点、两会话原文、分歧、48/16 split）
- `artifacts/sprint-r1/models/t27-probe.json`（exit=2 的具体阻塞）

## 并行与实际身份

本轮启动 3 个真实独立只读会话：2 个 64 锚点盲审 + 1 个旧 16 标/5 更正复核；
实现由主 agent 在集成分支完成，不声称 8 路独立写码。GPU 当前空闲但无 Qwen3.5 权重。

## 未完成 / 下一阻塞

1. 数据：train/dev=48/16，未达 512/128；s1 缺 gY08-B、重复 gR01-B；分歧待 H 预注册 challenge。
2. B：真实 T27 未启动（无权重、门未过）；仅 `t27-probe.json` 失败记录，无 fixture 冒充。
3. 原作：8 地图/移动碰撞、议会、危机/救援、结局/轮回、UI/音效/i18n 仍未实现（见 `legacy-parity.md`）。
4. 未跑真实 GPU 实模吞吐；96h/720h 为 fixture 调度证据，不称实模长程。
