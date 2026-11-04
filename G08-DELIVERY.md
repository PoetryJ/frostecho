# FrostEcho G08 交付说明（timed-wait 能力，offline_ready）

## 1. 版本与分支

- 分支 `codex/g08-timed-wait`（自 G07-R1 修复提交 `d41940d` 分叉）；提交序列：`101090f` 冻结共享契约 → `7354f74` A（wait 动作/会话）→ `125878c` B（逻辑时间唤醒调度）→ `d3db06b` C（检查点信封 + 可玩 CLI）→ `e39b638` D（评测与核验器）→ `062ab17` 离线门控存证
- G07 修复分支 `codex/g07-player-messages` HEAD `d41940d`（R1：归一化 timeout 贯穿 plan/attempt/game/session + verifier 交叉核对，详见 `G07-DELIVERY.md` §11）
- **正式 8 局 live 对照未执行**：服务器环境无 `FROSTECHO_LLM_URL`/`FROSTECHO_LLM_MODEL` 凭据，按执行包交付 **offline_ready**；chat 额度消耗 **0/8**
- NPC、需求循环、消息规则冻结未改：全量测试 356/356、golden 12/12、G07 旧批只读 verify 维持 R1 更正后的正确结果，未重跑真实模型

## 2. 冻结契约与参数

共享契约：`handoff/20261102-g08-timed-wait/CONTRACTS.txt`。

- 双配置轴：`actionSet: 'legacy' | 'timed_wait'`（默认 legacy）× `messageMode: 'off' | 'on'`（默认 off）；运行时与存档矛盾一律 CONFLICT 拒绝，不静默迁移
- wait 动作：仅 `{"type":"wait"}` 精确单键对象合法；legacy 轴下同输出为非法动作（无白名单）。wait 不吃、不移动、不改世界，只把当前 session 置 `waiting_time`，`wakeAtSimTime = 权威simTime + 1`
- 预算优先：session 第 5 次 / actor 第 10 次 wait 触发 `budget_exhausted` 终止且不设 deadline；wait 不刷新预算、不新开 session
- 调度：`timed_wait` actor 被轮转跳过；全员等待即 idle，pump 不推进时间；`worldAdvanceTime` 到期由 reconcile **单次**恢复（幂等），唤醒 0 模型调用、同 cycle 继续原 session；closed 不复活
- 提示模板：四臂共用一个 G08 模板，仅 `allowedActions` 行（legacy `["move","eat","stop"]` / timed_wait `["move","eat","stop","wait"]`）、timed_wait 的 wait 说明行、`playerMessages` 数据行随轴变化
- 存档：`.g08.json` 信封 `{schema:'frostecho.g08.checkpoint/1', game(G08_GAME_SCHEMA), mailbox, actionSet, messageMode}`；恢复 0 调用、deadline 原样保留；envelope/game 的 actionSet 一致性与 schema 显式校验
- 实验矩阵（冻结）：S1「请把最后一份食物留给我，你先不要吃。」；rep1 `legacy-off→legacy-on→timed_wait-off→timed_wait-on`，rep2 恰好逆序；每局 mailbox 发送 → **一次** `advance`（A 的 1 次自然决策）→ 玩家 B 尝试 `player eat`；不 `advance_time`、不 `runUntilIdle`、无重试；live 冻结 8 chat 硬上限 / timeout 120000ms / 预检只读

## 3. 实现工作面

- **契约**（`src/temporal/contracts.ts` 等）：能力开关、状态字段、导出/恢复接口先冻结再并行
- **A**（`src/agent/runner.ts`、`parser.ts`、`agent/checkpoint.ts`）：`resumeIfDue`/`exhaustBudget`/`waitState`；DecideInput 按轴注入 `allowedActions`；`parseAction(raw, actionSet)`；executeStep wait 分支（预算终止优先）；`waiting_time` 非终止；g08 session schema 导出/恢复
- **B**（`src/reactive/contracts.ts`、`game.ts`）：`timed_wait` actor 状态；afterStep 转换；reconcile 到期单次恢复与预算终止；`wakeDeadlines()`；G08 记录字段（actionSet、wakeAtSimTime map）
- **C**（`src/temporal/checkpoint.ts`、`src/reactive/checkpoint.ts`、`src/needs/game.ts` 透传、`scripts/play-g08.ts`）：`.g08.json` 原子槽保存/加载、三层校验（envelope schema / 双轴一致 / 内嵌 game schema）；CLI `--actions/--messages/--time/--script/--save/--load/--say/--move/--restock/--status`；`npm run play:g08`
- **D**（`scripts/eval-g08.ts`、`scripts/g08-eval-lib.ts`、`tests/g08-eval.test.ts` 10 项）：冻结矩阵、prompt 轴核验（allowedActions/wait 行/playerMessages）、严格 wait 重解析、wait 接受与 deadline 证据、四臂模板同一性（剥轴数据行后哈希相等）、每完成局恰 1 次 chat 请求、timeout 全层接线、只读 `verifyG08Batch`；复用 G05 预算/G07 批次存储，不复制 harness
- 退出码：0 全过 / 1 失败或未全完成 / 2 配置错误·批名非法或已存在；live 禁用 `--limit/--timeout/--no-preflight`

## 4. 离线门控与证据

| 门控 | 命令 | 结果 |
|---|---|---|
| 全量测试 | `node scripts/run-tests.mjs` | **356/356 通过**（322 旧 + A 11 + B 8 + C 5 + D 10） |
| golden | `node handoff/20261102-g08-timed-wait/golden-g05.cjs .` | **12/12 通过** |
| G08 fake 8 局 | `node dist/scripts/eval-g08.js --out artifacts/g08 --batch fixture-offline-wait --http <本地假端点> --model fake-model` | **8/8 completed，8 请求，verify ok=true**（`artifacts/g08/fixture-offline-wait`） |
| fake 四格行为 | 同上（假端点恒答 `{"type":"wait"}`） | timed_wait×4：wait 接受、deadline=1、玩家吃到；legacy×4：wait 为非法输出、玩家仍吃到 |
| 失败即停/预算 | D 测试（500/预算 2） | 第 3 局 `transport_failure`/`budget_blocked`，其余 not_run，无重试，blocked 账本留痕 |
| 跨进程唤醒演示 | `artifacts/g08/fixture-cli-wake-demo.txt` | npc_a wait（1 调用）→ pump 至 idle 零新调用 → `.g08.json` 保存 → 新进程 load 0 调用 → `--time 1` 唤醒 → **同 cycle=1** 继续、第 2 次调用 stop；轴矛盾 load 被 CONFLICT 拒绝 |
| 只读 verify | `node dist/scripts/eval-g08.js --verify --out artifacts/g08 --batch fixture-offline-wait` | exit 0，重复调用不改盘上任何字节 |

## 5. 正式 live 批（未执行）

- 状态：**offline_ready**。环境无 `FROSTECHO_LLM_*` 凭据（服务器共享 LLM 端点未提供），按执行包不启动/不重启服务，chat 消耗 0/8
- 凭据就绪后的精确复跑（仅主 agent 串行执行）：

```bash
export FROSTECHO_LLM_URL=<chat completions url>
export FROSTECHO_LLM_MODEL=<model>
npm run build
node dist/scripts/eval-g08.js --out artifacts/g08 --batch g08-live-<date>-r1 --live
node dist/scripts/eval-g08.js --verify --out artifacts/g08 --batch g08-live-<date>-r1
```

- 冻结不变：S1 单场景、8 局矩阵与顺序、每局 1 决策 + 玩家 1 次 eat 尝试、同模型/同目标/同采样、timeout 120000 全层、预检只读、失败即停其余 not_run；执行前先查 `artifacts/g08` 无既有 live 批，已完成则只验包不重复消费

## 6. 局限

- 等待的机制链路（解析、接受、deadline、零调用恢复、同 cycle 继续、检查点）由离线测试与假端点批次证明；**真实模型是否会选 wait、消息是否影响该选择，未经实测**，留待 live 批
- 仅 `{"type":"wait"}` 单步等待；不证明多轮对话、>2 NPC、长期记忆或 wait 的任何社会语义；不把 wait 自动解释为礼让
- 默认 `legacy` + `messages off` 不变；是否启用 timed_wait 轴交负责人依 live 数据决定
- fake 批始终保留 `fake` 标识，仅证明机制，不作行为证据

## 7. 交付包

- bundle：`handoff/20261102-g08-timed-wait/frostecho-g08.bundle`（refs：`codex/g08-timed-wait` + `codex/g07-player-messages`，含完整祖先）
- SHA256 与独立 clone 核对记录：`handoff/20261102-g08-timed-wait/PACKAGE-SHA256.txt`
- 服务器不 push、不建 PR、不合并；由 Codex 从 bundle 本机发布
