# STATUS — R5 保存检查点（2026-11-12）

**有限返工，按负责人要求暂停后续工作。** 产品源码 `498c00015e51dc6d48668e2603e2e1877aa8e399`；开发分支 `codex/sprint-1116`；保存标签 `r5-saved-20261112`；未合 main。

完整进度、原始实验、环境和恢复入口见 [检查点](checkpoints/20261112-r5/README.md)。本次独立复跑 737 核心 + 15 G11 = 752 项通过，eval-full 13/13，Python66/66；G11为打包旧证据。

已验证原R4终态/排队取消/幂等修复、晨会分工和保存恢复。保留四项未关闭：供仓任务未结清承诺；save等待中捕获集合外的新任务误取消；旧审查可重绑变更内容；风险证书计算/参数绑定不足。空间“四日”实际为102小时50分钟，连续/分段状态一致，初始food120的受控场景不证明生存平衡。

39题0eligible/29ambiguous/10inconsistent，正式训练门关闭；无真实27B训练、校准或风险保证。今晚未启动Grok、GPU或后续任务；后续安排等待负责人再次指示。以下保留历史状态，恢复时以上述R5检查点为准。

---

# STATUS — sprint R2（2026-11-11）

基线：`54214bda95bfae6ec77fdf08d07af4458c0ada39`；集成分支 `codex/sprint-1116`；执行包 `handoff/20261111-sprint-r2` SHA 29/29 OK。

## 本轮结果

- R：stdin job 队列与 save/EOF/quit barrier；cancel/超时撤销提交代次（同步提交段校验 generation+version+memory hash）；承诺实例 ID；回执单调（duplicate 回放 firstReceipt、同 ID 异内容显式冲突）；journal 证据恢复不升级 error→ok；legacy 持久执行 fail closed。
- P：`src/gameplay-v2/` 任务板（采集/供暖/留饭）、饥饿冲突、关系预登记差异（trust 0→gather-food，trust 1→leave-food）、96h 参考规则纵切；CLI 接 assign/cancel-task/task-status/game-step。
- D：`jev04/data/v2/` 64 例逐 ID 修订（gQ07 取消标签修正、narrative 由 facts 生成）、69 分歧裁决 keep26/revise4/challenge39、48/16 按 32 组隔离；gate-v2 blocked 且理由具体。
- M：`jev04/scorers/port.py` fail-closed 适配（K/NaN/Inf/身份漂移/未知 policy），fake 合法 artifact 接线；T27 身份预检新 runID（15 候选，无指定 Qwen3.5-27B）。
- H：eval-full 递归发现（acceptance-v2 被正式入口覆盖）；`scripts/r2-audit.mjs` 一次真实全量；32x30 更正为 scenarioDays=30（720h，第30日结算）。

## 证据

- `artifacts/sprint-r2/acceptance/summary.json`（build/unit/eval-full/python/data/world 共 7 项，全 pass）
- `artifacts/sprint-r2/world/matrix.json`（9 组 96h/720h，settleAtDay30=true）
- `research/decision-choice/jev04/data/v2/{cases,adjudication,split,gate-v2}`（64/69/48/16）
- `research/decision-choice/jev04/models/t27-identity-20261111-r2.json`
- R2 包复现器基线输出：`sprint-r2/repro-out/`（隔离 clone）

## 未完成 / 下一阻塞

1. 39 条 challenge 需 H 逐项裁决；v2 骨架仅 4 种，不能称独立泛化。
2. 真实 T27 未启动（无指定权重、数据门 blocked）；无真实 valid policy，校准仍 unavailable。
3. 原作：地图/碰撞/寻路、议会、危机、轮回、建造、UI 未实现（见 legacy-parity.md）。

---

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
