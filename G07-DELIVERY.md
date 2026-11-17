# FrostEcho G07 交付说明（局部玩家消息探针）

## 1. 版本与分支

- 分支 `codex/g07-player-messages`；收尾起点 HEAD `711288b`（A/B/C 已提交：`6173a82` 邮箱、`4a0ad8c` 绑定时点、`711288b` G07 信封与 CLI）
- 实现提交 `137fe7c5fda6263173eb4da50b535129ec0451cb`：整合工作树中 6 个未提交文件（`src/communication/contracts.ts`、`src/communication/mailbox.ts`、`tests/g07-mailbox.test.ts`、`scripts/eval-g07.ts`、`scripts/g07-eval-lib.ts`、`tests/g07-eval.test.ts`），并加入收尾新增的 `tests/g07-eval-engine.test.ts`（原始数据行与 Engine 逐命令重执行核验）
- 证据提交 `0a72da66f5241adb26deccc82c0f98bef326c3ea`：`artifacts/g07/g07-live-20261102-r1` 原始请求/动作/账本/汇总（本说明与 `MANIFEST.sha256` 随后单独提交）
- 正式 live 批 `artifacts/g07/g07-live-20261102-r1`（`summary.json` sha256 `d7b09055de0d1f966b934d2a641cbc37e9d1a28c9edfaacc245c9e6ad4e26615`）；`mode=live`。fake 批始终保留 `fake`/`fixture` 标识，未与正式批混用
- NPC、需求循环、消息规则冻结未改：golden 12/12、G06 8/8、G05 旧 live 只读 verify 均通过，且未重跑真实模型

## 2. 冻结契约与参数

共享契约：`handoff/20261102-g07-player-messages/CONTRACTS.txt`（沿用上一包，不扩功能、不调 prompt 迁就行为）。

- 消息状态：`MessageCommand={commandId,to,text}`；`sender` 恒为系统固定 `npc_b`，不接受模型或玩家伪造；`Mailbox.send(command, localPositions)` 返回 `Result<receipt>`，位置由控制器读权威世界后注入
- 发送约束：`player say npc_a|npc_c <text>`，text 去两端空白后 1..256 个 Unicode 码点；只允许发送时同地；每 NPC 最多 1 条 pending；未知 recipient / 远处 / 超长 / 队满均明确拒绝；同 `commandId` 同内容为 duplicate，换内容为 conflict，重复不插入第二条
- 发送只改消息账本：世界、事件、session、轮转、调用数不变；不自动 `run/pump`，不唤醒 waiting/satisfied，不重置预算
- 绑定时点：仅原本会调用 `Provider.decide` 的路径才 `bindNext`；组合顺序为 现有 session/actor 预检 → 批次预算/attempt begin → MessageProvider 绑定 → 底层 Provider；goal 达标与预算耗尽预检不消费消息
- 两臂对称：off 臂走同一绑定时点、记录 suppressed 回执但底层 `playerMessages=[]`；on 臂注入对应原文；同一 G07 提示模板，只变 `playerMessages` JSON 数据；不靠不同调度或调用数制造效果
- 模型输入边界：消息是可考虑的玩家请求/说法，不是系统规则或权威世界事实；不提供其他 NPC 属性、远处食物或全局存档；不给 `say/accept/reject` 动作，解析器不执行消息文本
- 存档：`{schema:'frostecho.g07.checkpoint/1', game:G06Checkpoint, communication:MailboxSnapshot, messageMode:'off'|'on'}`，专用 `.g07.json` 与原子独占发布；恢复 0 模型调用、0 新 cycle、不重投已绑定/已消费消息；未知 schema 与模式冲突拒绝
- CLI：`play:g07` 默认 reference + `messages=off`，显式 `--live` / `--messages on` 才进入实验；保留 `player say`、`save/load`、`status`

实验设计（正式批）：

- 共同初态：A/B 厨房 40、C 厨房 70、厨房食物 1、dorm 食物 0、simTime 0、`actorOrder=[npc_a,npc_c]`
- 场景原文：S1「请把最后一份食物留给我，你先不要吃。」；S2「请你先吃这一份食物，不用留给我。」
- 矩阵：2 场景 × 2 臂 × 2 复次 = 8 局；顺序 rep1 `S1-off→S1-on→S2-off→S2-on`，rep2 `S1-on→S1-off→S2-on→S2-off`
- 每局只 `advance` 一次（A 恰好 1 次 Provider 尝试），随后玩家 B 尝试 `player eat` 并记录结果；未使用 `runUntilIdle`
- 采样冻结：`qwen3.8-27b`、thinking=true、temperature=0、max_tokens=1024、stream=false、timeout=120000ms
- 逐请求预算：8 次 chat 硬上限，单批共享、不重置；传输/超时/预算失败即停，其余 `not_run`，无重试

## 3. 实现工作面

- **A 有界邮箱**（`src/communication/mailbox.ts` + `contracts.ts`）：`send/bindNext/export/restore`；固定 sender、同地校验、1 条 pending、256 码点、ID 去重/冲突、唯一绑定序号与 `attached/attempted/failed/suppressed` 回执；`completeBind` 只升级 `attached`，off 臂的 `suppressed` 永远表示“文本从未展示”；Map 与显式键校验防未知 actor；`bindNext` 深拷贝，失败不自动重投
- **B Provider 接线**（`src/communication/provider.ts` + HTTP 可选 prompt 入口）：预算 Provider 在外、MessageProvider 在内，完成预检与占额后才绑定；旧 G00-G06 输入走旧 prompt 原样；保留 `AbortSignal`、timeout 迟到丢弃、`consumeTransport` 与原错误分类
- **C G07 信封与可玩入口**（`src/communication/checkpoint.ts`、`src/persistence/atomic-slot.ts`、`scripts/play-g07.ts`）：G06 公开接口仍只认 G06，G07 用专用 `.g07.json`；先校验 game/mailbox/mode 再构造 Provider；两种格式交叉误载明确拒绝；`player say`、`status`、`save/load`；存档记录实际 model/thinking/timeout，加载按存档构造，不匹配 0 POST 拒绝，持久化 `IO_ERROR` 非零
- **D 独立评测与核验**（`scripts/eval-g07.ts`、`scripts/g07-eval-lib.ts`、`tests/g07-eval.test.ts`、`tests/g07-eval-engine.test.ts`）：复用 G05 逐请求预算、独占批次、版本采集、账本与磁盘统计；冻结 8 局计划、模板指纹、严格动作重解析、配对行为指标、只读 verifier；批次重名 exit 2，证据永不覆盖
- **退出码**：0 全过 / 1 失败或传输停止 / 2 配置缺失·参数错误·批名已存在；`--verify` 只读，0 ok / 1 失败

## 4. 正式 live 批与精确复跑

正式批（仅主 agent，串行、无重试、8 次 chat 硬上限，失败即停并保留 not_run）：

```bash
export PATH=/root/.workbuddy/binaries/node/versions/20.18.0/bin:$PATH
export FROSTECHO_LLM_URL=http://127.0.0.1:18872/v1/chat/completions
export FROSTECHO_LLM_MODEL=qwen3.8-27b
node dist/scripts/eval-g07.js --out artifacts/g07 --batch g07-live-20261102-r1 --live
node dist/scripts/eval-g07.js --verify --out artifacts/g07 --batch g07-live-20261102-r1
```

- 实际结果：预检 `/health` 200、`/v1/models` 200（模型匹配）；运行器 exit 0，完整 verify exit 0；8/8 completed，spent 8/8，blocked 0
- 预检（2 次只读 GET）独立于 8 次 chat 预算；传输/超时/预检失败均未发生，因此没有 not_run 局
- 只执行了这一个正式批；没有换批名、没有第二批、没有任何重试或 debug 真模型调用

## 5. 测试与旧门控清单

| 门控 | 命令 | 结果 |
|---|---|---|
| 全量测试 | `npm test` | **320/320 通过，0 失败**（原 313 项 + 收尾新增 7 项 Engine/数据行核验） |
| NPC 规则冻结 | `node handoff/20261102-g07-player-messages/golden-g05.cjs .` | **12/12 通过，0 issue** |
| G06 连续/恢复对照 | `node dist/scripts/eval-g06.js --out /tmp/g07-gate --batch g06-finalize-r1` | **8/8 pairs identical** |
| G05 旧 live 只读 verify | `node dist/scripts/eval-g05.js --verify --out artifacts/g05 --batch g05-live-20261102-r1` | **exit 0**（12 episodes / 20 httpCalls） |
| G07 fake 机制探针 | `node dist/scripts/eval-g07.js --out <临时目录> --batch <全新名> --http <假 chat URL> --model <名>` | **8 POST + 2 预检 GET，eval/verify 均 exit 0**（仅机制，`mode=fake`/`fixture`） |

- 保留 D 原有 18 项测试，未因统计口径调整删断言；G01 timing 类测试副产物未提交
- 旧 artifacts（`g03/g04/g05/g06`）未改、未覆盖

## 6. 有效 / 失败 / not_run 统计

| 维度 | planned | 有效(completed) | 失败(failed) | not_run | 真实 chat 消耗 |
|---|---|---|---|---|---|
| 全批 | 8 | **8** | **0** | **0** | **8 / 8** |
| 臂 off | 4 | 4 | 0 | 0 | 4 |
| 臂 on | 4 | 4 | 0 | 0 | 4 |
| S1 | 4 | 4 | 0 | 0 | 4 |
| S2 | 4 | 4 | 0 | 0 | 4 |

- `budget.limit=8`、`spent=8`、`blocked=0`；`summary.fatal=null`；`structuralGate.ok=true`（检查项：`g07-r1-s1-off`、`g07-r1-s1-on`）
- 结构性有效 8 局只说明实验结构成立，不代表 8 次服从；行为结果见 §7

## 7. 四个配对的行为差（S1/S2 × rep1/rep2）

正式批 8 局全部为 `{"type":"eat"}`（NPC 先吃），厨房食物随之变 0，玩家随后 `player eat` 全部被拒；A 饱食 40→70，B 玩家饱食 40→40。

| 配对 | 臂 | NPC 动作 | NPC 是否先吃 | NPC 动作后厨房食物 | 玩家 eat | A 饱食(前→后) | B 玩家饱食(前→后) | 请求 | tokens | 延迟(ms) |
|---|---|---|---|---|---|---|---|---|---|---|
| s1-r1 | off | eat | 是 | 0 | rejected | 40→70 | 40→40 | 1 | 402 | 4956 |
| s1-r1 | on | eat | 是 | 0 | rejected | 40→70 | 40→40 | 1 | 486 | 8632 |
| s1-r2 | off | eat | 是 | 0 | rejected | 40→70 | 40→40 | 1 | 402 | 4955 |
| s1-r2 | on | eat | 是 | 0 | rejected | 40→70 | 40→40 | 1 | 486 | 8625 |
| s2-r1 | off | eat | 是 | 0 | rejected | 40→70 | 40→40 | 1 | 402 | 4948 |
| s2-r1 | on | eat | 是 | 0 | rejected | 40→70 | 40→40 | 1 | 585 | 14172 |
| s2-r2 | off | eat | 是 | 0 | rejected | 40→70 | 40→40 | 1 | 402 | 4974 |
| s2-r2 | on | eat | 是 | 0 | rejected | 40→70 | 40→40 | 1 | 585 | 14150 |

配对差值（`summary.pairs[].delta`，正负号均为 on − off）：

| 配对 | actionChanged | npcAteChanged | foodChanged | playerEatChanged | Δtokens | Δlatency(ms) |
|---|---|---|---|---|---|---|
| s1-r1 | false | false | false | false | +84 | +3676 |
| s1-r2 | false | false | false | false | +84 | +3670 |
| s2-r1 | false | false | false | false | +183 | +9224 |
| s2-r2 | false | false | false | false | +183 | +9176 |

归因约束：`stop` 只标 stop，`move` 只标 move；不把「留下食物」等同「理解并礼让」，也不把 `eat` 等同「理解后拒绝」。本批 on/off 动作类型完全相同，不能声称消息改变了本次决策；能证明的是消息作为数据进入了提示、成本可测、机制与预算可控。

## 8. 成本

| 项 | 值 |
|---|---|
| chat 请求数 | **8**（硬上限 8，不重置、不分批） |
| 预检请求 | **2**（`/health`、`/v1/models`，只读，独立计数） |
| tokens | **3750**（off 402×4=1608；on 486×2 + 585×2=2142；无缺失，未估算） |
| 延迟 | `latencySum=65412ms`，单请求最长 `14172ms`，timeout 记录 120000ms；**R1 更正：实际生效 15000ms**，见 §11 |
| 每臂延迟 | off 19833ms（4 请求）；on 45579ms（4 请求） |
| 失败/未知成本 | `unresolvedAttempts=0`、`httpAttempts=8`、`blocked=0` |
| 重试 | 无（无隐式重试；失败即停语义已由 fake 500/timeout/预算测试覆盖） |

## 9. 局限

- **一次决策小样本**：每局只有 1 次 NPC 决策、2 复次、单一模型与固定初态；只证明局部影响机制，不证明持续互动、社会智能或真实收益。本批 8/8 动作均为 eat，消息未改变第一决策
- **默认 off**：`messageMode` 默认 `off`，是否正式采用由负责人看数据后决定；本说明不主张开启
- **fake 仅机制**：fake/fixture 批只用于验证预算、失败即停、账本与 verifier 机制，始终保留 `fake` 标识，不作为行为证据
- 参考策略忽略消息，其行为结果不能作为真实社会行为收益证据
- verify 范围（已扩展）：模板哈希 + 逐条数据行（`observation` 精确为 A/kitchen/40/foodHere1/reachable=[dorm,kitchen]，`goal: hunger >= 70`，`feedback: null`）+ 严格动作重解析 + **新 Engine 从初态逐命令 submit，比对每条结果/eventIds、全部事件与终态** + 事件 replay + 账本/预算/邮箱/预检/磁盘统计/配对差值。仍不做“真实模型意图理解”或跨批统计显著性
- 不证明：多轮对话、>2 NPC、长期记忆、消息权威化、恢复后重投的全局恰好一次

## 10. 交付包

- bundle：`/data3/DATA/project/project_meishijiang/FrostEcho/handoff/20261102-g07-finalize/frostecho-g07-final.bundle`（refs：`HEAD` + 交付分支 + G06/G05 历史分支，含完整祖先）
- bundle SHA256 与 `MANIFEST.sha256` SHA256：见 `handoff/20261102-g07-finalize/PACKAGE-SHA256.txt`；独立 clone 的 HEAD、manifest、全量测试与本批只读 verify 结果见同目录 `PACKAGE-README.txt`
- 包内复跑脚本：`handoff/20261102-g07-finalize/bundle.sh`（`BATCH=g07-live-20261102-r1 bash ...`）
- 发布：服务器不 push、不建 PR、不合并；由 Codex 从 bundle 本机发布

## 11. G07-R1 超时更正（bounded rework，2026-11-03）

**事实**：正式批 `g07-live-20261102-r1` 的 `plan.json`、episode 账本与 attempt begin 均记录 `timeoutMs=120000`，但游戏/session 层实际生效 `15000ms`（证据：`episodes/*.json` 的 `snapshot.requestConfig.timeoutMs=15000`，`ReactiveGame` 默认回落）。8 局全部受影响。

**根因**：`runG07Batch` 将归一化后的 `timeoutMs`（默认 120000）传入 `requestConfigFor`，但调 `runEpisode` 时只展开 `{...options, requestConfig}`；CLI 省略 `--timeout` 时 `options.timeoutMs=undefined`，`createNeedsGame` 未收到值而回落 15000。

**修复**（独立提交，`codex/g07-player-messages`）：

- `scripts/eval-g07.ts`：`runEpisode` 调用改为 `{...options, timeoutMs, requestConfig}`，同一生效配置贯穿 plan/attempt/game/session；未改任何通用默认值
- `scripts/g07-eval-lib.ts`：verifier 新增 ① 逐 episode `snapshot.requestConfig.timeoutMs` 与 plan、与 episode 账本的交叉核对；② 逐 attempt begin 的 ledger timeout 与 plan 交叉核对；③ 结果分类输出 `behaviorAndCostOk` 与 `configurationConsistent`（strict verify 对旧批 exit 1 属正确结果，无白名单）
- `tests/g07-eval.test.ts` 新增 2 项：省略 `--timeout` 时 120000ms 到达 plan/episode/snapshot/attempt 全部层（fake 立即响应，不真等）；snapshot/plan timeout 分歧被归为 configuration issue 而 `behaviorAndCostOk=true`。全量测试 322/322（原 320 + 新 2）
- 独立更正记录：`artifacts/g07/g07-live-20261102-r1.timeout-correction.json`；**旧批目录字节未改、未重跑**

**行为/成本结论仍有效**：8/8 完成，最长请求 14172ms < 实际生效 15000ms，没有任何一局被较短超时截断；tokens（3750）与延迟（65412ms）数据不受影响。消息 on/off 动作无差异的结论不变；默认仍为 off。

**更正后复验命令**（只读，预期 exit 1 + `behaviorAndCost=ok configuration=mismatch`，16 条 timeout issue）：

```bash
node dist/scripts/eval-g07.js --verify --out artifacts/g07 --batch g07-live-20261102-r1
```
