# FrostEcho G05-live 交付说明（12 轨迹 live 全过）

## 1. 版本

- 实现：`5e6ea93`（基线 `74d6d75`，分支 `codex/g05-live`）；NPC 规则冻结未改（golden 12/12 复跑通过）
- 正式 live 批：`artifacts/g05/g05-live-20261102-r1` — **12/12 轨迹通过、恰好 20 请求、exit 0**，只读 verify ok

## 2. 架构（主 agent 冻结 `src/needs/live-contracts.ts`；eval.ts 集成独占）

- **A 逐请求预算**（`live-budget.ts`）：`ChatBudgetGate.reserve()` 同步原子、不退款；budgeted HTTP provider 顺序为 reserve → 账本 begin（写盘失败即停，额度保守已占）→ HTTP → 账本 finish；denial 单独分类（无请求、无命令）；session5/actor10 照常先行生效
- **B 独占批次**（`batch-store.ts`）：mkdir 原子独占，重名 exit 2 不动旧字节；plan.json 先落盘全部 12 计划轨迹（初始 not_run）+ 生效配置 + 源版本；attempts/ 账本（begin/finish/blocked 三类文件）；plan-status 追加式状态轨迹；每局结束立即写 episodes（write-once）
- **C live 判定与全量成本**（`metrics.ts` + scenarios/record）：usage 按请求逐次累加；缺失 usage 计入 usageUnknownCount 并使 totalTokens=null；decisionAttempts（episodes 记录）、httpAttempts（账本）、budgetBlocked（denial 记录）三数分开，绝不以 mode/providerCalls 估算 HTTP；live 判定对参考调用数不为零的 checkpoint 放开精确次数、零调用 checkpoint（初始检查/T2/one-shot/等待段）保持严格为零
- **D 独立护栏**（`tests/g05-live-guard.test.ts`）：spawn 真子进程打假 HTTP —— cap1 恰 1 POST + 预算停止非零退出；HTTP500/timeout 完整落盘非零退出；usage 缺失模式；重名 exit 2；ca-only live 拒绝；verify 只读
- `eval-g05` 退出码：0 全过 / 1 失败或预算传输停止 / 2 配置缺失·参数错误·批名已存在；summary（`frostecho.g05.summary/3`）从磁盘重建；verify 将 transports 与账本交叉核对

## 3. 正式 live 批结果（2026-11-02，qwen3.8-27b @127.0.0.1:18872）

- preflight：`GET /v1/models` ok（25ms，preflight 请求独立于 60-chat 预算）
- 预算：limit=60 **spent=20 blocked=0**；ac 六条全过后自动进入 ca（门控未触发）
- 成本：requests=20 unresolved=0 **knownTokens=7530** usageUnknown=0 totalTokens=7530 latencySum≈122s（单请求 timeout 120s 显式生效）
- 零调用轨迹（8 条）实际执行 run/pump（events/commands/restCycles 落盘）；模型轨迹 t1=4、t3=6 决策，checkpoint 终态与参考一致（t3: 40/40/40 → 30/30/30 → 90/30/90），replayMatches=true
- 失败重试：无（无隐式重试；未发生失败）

## 4. 验收证据

- 全量测试 **242/242**（新增 budget/store/metrics/live-judge/live-guard 28 项）
- golden-g05.cjs **12/12**（NPC 规则冻结复验）；G05-R1 fixture 批与 G04 fixture 批 verify 复验通过
- 中断可重建：begin 无 finish 计 unresolved（额度保守已占）；summary 任何时候可从磁盘重建（guard 测试覆盖）

## 5. 未证明 / 边界

- 多于两次的行为差异（模型在 T1 绕路等合法额外决策在 C 层测试用脚本模型覆盖，真实模型本次未触发额外决策）
- 服务器未 push：由 Codex 从 bundle 本机验收发布；未进入 G06
