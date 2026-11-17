# G11 交付：等待结束后继续生活（临时目标结束 → 恢复原需求）

基线 `6779a55` · 分支 `codex/g11-needs-resume` · 本轮**真实模型调用 0**、未访问 18872、未重启共享服务、未消耗 G10 剩余额度、未补跑 G10。
全部演示/测试均为脚本 Provider（fixture/reference），明确标注离线，不是实模能力证据。

## 一句话机制

到期的 timed_wait 先刷新权威请求：协商 yield 已 `fulfilled/expired/violated` 时**零调用结算旧 session**（保留目标、binding、请求终态与历史），再由 `recurring` 策略决定是否**开一个新的普通 feed_self cycle** 继续未完成的饱食需求；旧请求永不重问、永不改判。

## 三条轨迹（一次启动即可复现）

```
node scripts/g11-demo.mjs          # 三轨迹 + 两个跨进程恢复点，全部断言通过才 exit 0
```

| 轨迹 | 命令脚本（play:g10 输入） | 预期 |
|---|---|---|
| W0 | `--fixture w0 --hunger 50`；`run 1`（wait）`run 1`（idle）`world time 1` `run 1`（eat） | 2 次决策、**同 cycle**、A40→70、food0、B30 |
| W1 | `--fixture w1 --goals negotiated --hunger 40`；`request npc_a yield_once` `run 1`(goal) `run 1`(wait) `run 1`(idle) `player eat` `world time 1` `world restock kitchen 2` `run 2` | 共 4 次；旧请求 `fulfilled`；新普通 cycle 两次 eat：A30→60→90、food0 |
| W2 | 同 W1 但不 `player eat`，`world restock kitchen 1` | 共 4 次；旧请求 `expired`（永不翻案）；A30→60→90、food0 |

连续路参考决策总数 **10**（2+4+4）。

手工逐条输入（与脚本等价）：
```
npm run play:g10 -- --fixture w1 --goals negotiated --hunger 40 --root /tmp/g11 --slot w1
request npc_a yield_once / run 1 / run 1 / run 1 / player eat / world time 1 / world restock kitchen 2 / run 2 / status
```
`status` 同时给出：旧请求 `accepted/fulfilled|expired`、当前选定目标与饱食目标（分开）、cycle、wait 截止、本局累计调用。

## 跨进程恢复

两个冻结切点，均“保存 → 退出 → 新进程 load → 继续”，与连续路语义一致（运行路径/耗时/保存时间除外）：

```
--load <root>/cut.g09.json ...     # cut 由输入 "save cut" 产生
```
- 切点 A：wait 之后、玩家吃之前（W1）。
- 切点 B：`world time 1` 之后（旧目标已结算、接续 cycle 已开、还没发生下一次模型调用）（W2）。

load 本身 **0 调用、0 世界提交、0 请求重投**；恢复后同一输入序列得到相同世界/事件/命令/processed、cycle/轮转、目标/反馈/期限、请求终态与累计预算。`scripts/g11-demo.mjs` 与 `tests/g11-needs-resume.test.ts` 都断言这一点。

## 已证明 / 未证明

**已证明（离线、确定性）**
- 旧 targets 结算后不再产生旧 yield 请求：包内 `wake-probe` 修复前第 3 次调用携带 `activeGoal=yield_once`，修复后同一探针第 3 次为**无 activeGoal 的普通调用**（`handoff/20261105-g11-needs-resume/closeout/wake-probe-compare.txt`）。
- W0 同 cycle 续跑、W1 fulfilled 与 W2 expired 接续、A60→50 仍接续、one-shot/closed/预算/违约不复活、重复 reconcile 只开一个 cycle、恢复等价。
- 边界：结算与时间推进零调用；`>=70` 的“权威饱食预检”为**防御分支**——时间只会降低饱食，唯一上升途径是 NPC 先吃（即违约，不接续），故该分支在冻结世界输入下不可达，未用伪造状态强行覆盖。
- 提示一致性：删除“离开厨房即违约”的不实分句，`ACTIVE_GOAL_PROMPT_VERSION` 升为 `g11-needs-resume/1`；世界判定未改（move 仍合法）。
- 派生修正：`mapExchangeFailure` 补 `provider_error`（网络拒绝不再派生 invalid_run），timeout/empty_output/truncated 区分保留。

**未证明**
- 真实模型的 wait 后续、长期合作、完整原作玩法、Windows 真实终端 Ctrl+C、稳定低延迟。
- 离线通过不代表真实模型会“醒来继续吃”。

## 门控（全部离线）

编译通过；全量 **512/512**；合同 16/0；golden 12/0；旧三 fixture（cooperate/decline/violate）exit 0；旧 loopback 批 `ok=true`、旧 G08 批 `ok=true`；两个不完整 G10 实模批仍按真实差异 `exit 1`；`artifacts/{g10-r1,g08-closeout,g10-live,g10-action-contract}` 全部文件哈希不变（`handoff/20261105-g11-needs-resume/closeout/old-evidence.log`）。
