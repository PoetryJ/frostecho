# FrostEcho G06 交付说明（存档续玩）

## 1. 版本与分支

- 基线 `a94252a`，分支 `codex/g06-checkpoint`
- NPC 规则冻结未改：golden **12/12** 复跑通过；G05 live 批只读 verify 仍 ok（12 episodes / 20 httpCalls），未重跑、未调用模型
- 真实模型调用预算 **0**：G06 全程 reference provider + 本地假 HTTP 服务

## 2. 冻结共享接口

`src/persistence/contracts.ts`（主 agent 先落盘）：`Result<T>`、`SAVE_BUSY/SCHEMA_MISMATCH/INVALID_CHECKPOINT/MODE_CONFLICT/EXISTS/IO_ERROR/CHECKSUM_MISMATCH`、`SessionCheckpoint`（`frostecho.g06.session/1`）、`GameCheckpoint`（`frostecho.g06.checkpoint/1`）、`SessionRestoreRuntime`、`GameRestoreRuntime`、槽名规则 `^[a-z0-9][a-z0-9-]{0,63}$`。

## 3. 四个工作面的实现

- **A 会话检查点**（`src/agent/checkpoint.ts` + runner/contracts 最小扩展）：导出仅在决策边界（`deciding` → `SAVE_BUSY`），自定义 `commandIdFor` 未声明方案即拒绝（不猜）；恢复先做结构/范围/因果一致性校验，再由数据回填 round/feedback/steps/providerCalls/timeout/status/initialState/eventsBefore，运行期只注入 world/provider/时钟/定时器；**校验注入的 commandIdFor 与存档公式一致**（`${episodeId}:npc:${actorId}:${cycle}:${round}` vs 默认 `${runId}:${round}`），不一致即拒绝
- **B 世界/NPC 生命周期/调度恢复**（`src/reactive/checkpoint.ts` + `game.ts` 静态恢复路径）：保存 `Engine.save()` 全账本（含 processed 去重索引）、每 actor 生命周期状态、全部 cycle+turns、每 cycle 的 session、轮转 cursor、player/world 序号、calls、idlePumps、closed/interrupted/budget；恢复走 `restoreFromCheckpoint` 而非构造器，**不开新 cycle、不调用模型、不重放命令**；已 closed 的存档恢复后仍是 closed；在途 `busy` 导入为 `SAVE_BUSY`
- **C 原子存档文件与 CLI**（`src/persistence/file-store.ts` + `scripts/play-g06.ts`）：唯一临时文件 + fsync + `link()` 独占发布，**同名永不覆盖**（含并发）；sha256 校验，空/半写/篡改/旧版本快照全部拒绝；`play:g06` 保留 step/run/status/world advance/world restock/quit，接通 `player move dorm|kitchen`、`player eat`，新增 `save <slot>`（打印路径、simTime、NPC 状态）；`--load` 恢复，模式冲突 exit 2
- **D 独立验证**（`scripts/eval-g06.ts` + `tests/g06-crossprocess.test.ts` + `tests/g06-interrupt.test.ts` + `tests/g06-budget-driver.ts`）：恢复分支**保存文件 → 退出进程 → 新 node 进程 load 后继续**；真实 SIGKILL 中断、预算边界跨进程

## 4. 主 agent 修正：unresolved 的 token 总量

`src/needs/metrics.ts`：有 begin 无 finish 的请求此前被当成 0 tokens，现在计入 `unresolvedAttempts` 并使 `totalTokens = null`（`knownTokenSum` 保留已完成部分）。旧测试把 unresolved 锁成 0 的错误断言已更新为三个探针：0 已知 + 1 未完成 → `null`；11 已知 + 1 未完成 → `null` 且 `knownTokenSum=11`；纯空账本 → 0。

## 5. 8 组"连续运行 / 跨进程恢复"对照（`artifacts/g06/g06-r1`）

| 组 | save 点 | 恢复后 | 结果 |
|---|---|---|---|
| R1 ac/ca | 一个 NPC 回合后（food 2→1） | 另一 NPC 接着吃 | 8/8 一致，终态 A/C=70 food=0 |
| R2 ac/ca | 双双 waiting | 100 次 pump 零调用零新 cycle → restock 2 → 吃到 70 | 一致（save=2 final=4，pump 无消耗） |
| R3 ac/ca | 达标预检+衰减到 50 | pump 零调用 → advance 到 40 才开新 cycle → 吃到 70 | 一致（save=0 final=2） |
| R4 ac/ca | 同 R1 | 玩家先吃光最后一份 → 另一 NPC 空厨房 waiting | 一致；恢复侧 NPC 仍 kitchen hunger=40，玩家 70，无凭空吃饭 |

比较范围：**整个 checkpoint** —— Engine（state/events/log/processed 去重索引）、NPC 状态与 cycle/round/feedback、每 cycle 会话 steps/round/status/providerCalls、轮转 cursor、player/world 序号、totalCalls、closed/interrupted、预算；仅排除 wall-clock timing。`diff.json` 逐组为空数组。

## 6. 预算与中断

- 跨进程预算边界：save 时 providerCalls=4 → 新进程恢复后**恰好一次**调用到达 5 → `budget_exhausted` → 再 advance 零调用；已耗尽存档恢复后调用数 **0**，每局总量 4+1=5 不被重置
- 真实子进程中断：假 HTTP 挂起 → `att-0001.begin.json` 落盘后 SIGKILL → `unresolvedAttempts=1`、`httpAttempts=0`、`totalTokens=null`；中断前完成 episode 记录完整；对崩溃批 verify **exit 1**（绝不判成功）
- 同名存档：并发/重复保存 1 成功 1 `EXISTS`，旧字节不变；半写/空/篡改/旧版本均拒绝

## 7. 可玩演示与复跑

- 演示：`artifacts/g06-demo/`（`transcript-save.txt` 新局+保存+退出；`transcript-resume.txt` 新进程恢复 → 玩家命令序号从存档继续 → 二次保存成功）
- 复跑：
  ```bash
  npm run build && npm test
  npm run play:g06                       # 交互：step / world advance 2 / save demo / quit
  npm run play:g06 -- --load artifacts/g06-play/slots/demo.g06.json
  npm run eval:g06 -- --out artifacts/g06 --batch g06-r1
  node handoff/20261102-g05-r1-contract/golden-g05.cjs .
  ```

## 8. 测试

全量 **269/269**；新增：A 8 项、B 9 项、C 6 项、D 4 项（8 组矩阵 + 2 预算边界 + SIGKILL 中断）。

## 9. 未证明 / 边界

- R2 的"原 cycle 继续"按**冻结的唤醒规则**解释为 cycle 序列接续（waiting 唤醒开 cycle 2，编号/预算不重置），未改动世界规则迁就措辞
- 真实模型断点续玩未测（预算 0）；live 存档的恢复路径与引用一致，仅 provider 不同
- 未 push，由 Codex 本机发布；未进入 G07
