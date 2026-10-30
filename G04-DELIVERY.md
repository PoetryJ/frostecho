# G04 交付：条件等待与唤醒（含 G03-R1 收尾）

- 分支：`codex/g04-reactive-npcs`，基线 `30d7fab`，当前 `aba44ba`
- 执行包：`handoff/20261030-g04-reactive-npcs`
- 结论：G03-R1 三处缺陷已修并实测；G04 对照批 fixture 12/12、live 12/12，均为参考 30 次调用
- 全量测试：169 通过 / 0 失败（含真实子进程 CLI 与集成套件）

## 1. 一站结论

| 批次 | 代码 | 模式 | 有效超时 | 结果 | chat 请求 | 硬限 |
| --- | --- | --- | --- | --- | --- | --- |
| `g03-live-20261030-r3` | `11458a1` | 参考实现 | 15s（旧默认，已过时） | 12/12 pass | 44 | 120 |
| `g03-live-20261030-r4` | `320f6ef` | live | 30s | **中断（保留）** | 2 | 120 |
| `g03-live-20261030-r5` | `320f6ef` | live | 30s | **中断（保留）** | 2 | 120 |
| `g03-live-20261030-r6` | `320f6ef` | live | 120s（env 覆盖，已记录） | 12/12 pass | 44 | 120 |
| `g04-fixture-20261030-r2` | `aba44ba` | fixture | 30s | 12/12 pass | 0（零 HTTP） | — |
| `g04-live-20261030-r2` | `aba44ba` | live | 120s（env 覆盖，已记录） | 12/12 pass | 30 | 80 |

r4/r5 的失败原因相同且已定位：`m1-ac-on` 的第二个决策（`npc_c` 首轮）在 30003ms 触发超时。同一请求体在 r3 只要 13.4s，服务端随后基准延迟升到约 10s（64 token 探测），属端点容量回落，不是解析或预算缺陷。r6 用 `FROSTECHO_LIVE_TIMEOUT_MS=120000` 跑通，`batch.json.timeoutMs=120000`，代码默认仍为 30s。

## 2. G03-R1：三处修复与实际证据

1. **逐局 thinking 真进了请求体**：`makeProvider(actorId, thinking)` 直接绑定布尔，live 组装 `enableThinking`。`r6` 的 44 个请求体里 `chat_template_kwargs.enable_thinking` 与标签逐条一致：on 22 条全 `true`，off 22 条全 `false`；`model`/`temperature`/`max_tokens`/`stream` 唯一。`record.ts` 的交叉校验会把这些不一致判成 `configuration_fail`。
2. **批次元数据翻转不再丢字段**：`meta` 一次成型，之后只覆盖 `status`。`r6/batch.json` 同时有 `version{commit,dirty,sourceFingerprint,promptFingerprint,node}`、`health`、`timeoutMs`、`thinkingPlan`、`plannedEpisodes`。`r6` 的 `dirty=true` 记录的是当时 README 未提交这一事实，不是伪造的干净树。
3. **单条 finalize + 真实退出码**：quit/EOF/中断走同一个 `finalize`，只落盘一次；缺配置 2、HTTP/超时 1、正常 0。子进程测试 `tests/g03-cli.test.ts` 覆盖。
4. 旧证据未改动：`g03-live-20261030-r2` 里 22 条标 off 实为 `true` 的请求保持原样，只作为历史记录，不作为 R1 通过依据。

## 3. G04：等待与唤醒

- 语义：`stop` 只表示本轮条件不满足；`event` 策略下“厨房、此处无食物、自己没饱”的停止进入 `waiting`，补货或玩家输入只让它重新检查局部观察，不直接触发模型请求。`legacy` 与 G03 完全一致。
- 唤醒新建 session/cycle，旧 cycle 不回收；预算每 session 5、每 actor 整局 10，跨 cycle 累计不清零；全局至多一个请求在途。
- 世界输入：`world` 是唯一能 `restock` 的 actor（1..10 整数、合法地点、不溢出），NPC 提交得 `FORBIDDEN_ACTION`，world 不能 move/eat；新增 `FoodRestocked{location,amount,before,after}` 事件，补货不改 hunger、不调模型。
- 并发：补货落在 stop 决策在途时，只标记“需要复查”，在途请求不会被取消也不会重发，其结果落地后才重新判定。

对照结果（`g04-live-20261030-r2`）：

| 场景 | legacy | event | 判据 |
| --- | --- | --- | --- |
| N1 空厨房 | 2 次，双方 40，厨房留 2 | 4 次，双方 70，厨房 0 | 停止不等于局终，唤醒只发生在 notify 后 |
| N2 补宿舍 | 2 次 | 2 次 | 100 次通知/泵，新增调用 0 |
| N3 在途补货 | 2 次，仅后到者吃 | 3 次，两个都吃 | 在途 stop 结果不丢 |

live 批 30 次请求（prompt 8100 / completion 2950，累计时延 334.7s），每个请求体 `enable_thinking=true`、`model=qwen3.8-27b`、`temperature=0`、`stream=false`；`--verify` 只读复核 12/12，`dirty=false`，`commit=aba44ba`。fixture 批同样 12/12、30 次调用，且全部 `transport=null`（零 HTTP）。

`scenarioPass=true` 只表示“符合对照预期”。N1-legacy 的预期就是双方停在 40，不能读成 NPC 达标。

## 4. 复核与复跑

```bash
export FROSTECHO_LLM_URL=http://127.0.0.1:18872/v1/chat/completions
export FROSTECHO_LLM_MODEL=qwen3.8-27b

node dist/scripts/eval-g03.js --verify artifacts/g03/g03-live-20261030-r6
node dist/scripts/eval-g04.js --verify --batch g04-live-20261030-r2
node dist/scripts/eval-g04.js --verify --batch g04-fixture-20261030-r2

# 复跑（必须新批名；30s 默认，端点慢时用 env 提高并如实记录）
FROSTECHO_LIVE_TIMEOUT_MS=120000 node dist/scripts/eval-g03.js --live --batch <新批名>
FROSTECHO_LIVE_TIMEOUT_MS=120000 node dist/scripts/eval-g04.js --live --batch <新批名>
```

`--verify` 不改证据、不发请求，逐项重算命令重放、事件/终态、turn 账本、双预算、transition 账本、请求体交叉校验与场景判定；批目录缺失、`batch.json` 缺失或计划局缺盘都判 1，不会“空批 ok”。

## 5. 未宣称

- 没有做过 token/时延收益对比，也没有证明唤醒策略在更大 NPC 数量下仍成立。
- G04 只有 3 个场景、12 局，样本量不支持统计结论。
- `g04-fixture-20261030-final` 是 15s 默认时的中间批，已被 `r2` 取代，保留仅为时间线完整。
