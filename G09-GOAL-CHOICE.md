# FrostEcho G09 目标选择交付（2026-11-04）

## 1. 基线与分支

- 基线 `20f8f0f`（G08 收口）；分支 `codex/g09-goal-choice`
- 顺序：`g09 pre-work` spent 按 begin 计费 → 冻结契约 → A 请求状态机/权威履约 → B 两阶段会话 → C 存档与 CLI → D 评测与只读核验 → fake 证据 → 实模

## 2. 先修的 G08 遗留

`spent` 改为按 **begin** 计费（finish 只表示完成）；有 begin 无 finish 的 episode 记 `totalTokens=null / usageUnknown=true`。回归：8begin/7finish → spent 8、unresolved 1、token 未知、verify 失败。既有 G08 证据重新只读核验仍通过（0/0/1）。

## 3. 冻结契约（src/negotiation/contracts.ts）

- `GoalChoiceId = feed_self | yield_once`；arm `self_only | choice`；饱食 40/60；goal 期限轮 1；整批上限 16 chat
- `strictGoalChoice`：唯一合法答复是单键对象 `{"goal": ...}`，且必须在 offer 内
- `fulfilmentVerdict`：feed_self → not_applicable；yield_once + 玩家吃到 → fulfilled；yield_once + NPC 先吃 → violated；其余 undetermined
- 冻结提示 `renderGoalChoicePrompt` / `goalChoiceLine`，所有调用方字节一致
- **禁止按饱食阈值强制礼让**：请求构造器签名没有 satiety；`yield_once` 不能是唯一选项；self_only 不得 offer yield

## 4. 四个 worker

| worker | 交付 |
|---|---|
| A | `requests.ts` 请求状态机（pending→accepted/rejected/expired，一次决策）；`goal-check.ts` 从命令账本重派生履约证据 + binding 一致性 |
| B | 会话内两阶段：首调用渲染 goal 提示、不提交命令；binding 进入后续动作提示；2 次调用不足则零花费停止；非法 goal 直接终止不重试；G09 会话存档带协议与 binding，恢复不再选择 |
| C | `<slot>.g09.json` 存档（arm/satiety/request/binding + 游戏检查点，槽位校验和）；恢复**零调用、不再选择**、envelope 与每个会话 binding 必须一致；`play-g09` CLI（--new/--load/--goal/--step/--player-eat/--status/--save） |
| D | 冻结矩阵 8 局；串行执行、首对结构门控、失败停余局；summary 为纯投影；只读核验重解析 goal、fresh Engine 重放命令、重算履约与两阶段成本 |

## 5. 门控（全绿）

| 门控 | 结果 |
|---|---|
| `tsc` | 干净 |
| 全量测试 | **439/439**（G08 基线 408 + G09 31，含 spent 回归） |
| golden | **12/12** |
| G09 fake 批 | 8/8、16/16 chat、verify ok |
| G08 live 只读 | exit 0（未变） |
| G07 旧批只读 | exit 1，`behaviorAndCost=ok configuration=mismatch`（既有差异） |

## 6. 正式实验（服务沿用 18872 原实例，仅 GET 预检）

8 局 × 2 阶段 = **16/16 chat**，串行、无重试、无追加批次；冻结请求 qwen3.8-27b / thinking=true / temp 0 / max_tokens 1024 / stream false / timeout 120000。

| 局 | goal | action | NPC 先吃 | 玩家吃到 | 判定 | goal tok | action tok |
|---|---|---|---|---|---|---|---|
| r1 s40 self_only | feed_self | eat | 是 | 否 | not_applicable | 339 | 504 |
| r1 s40 choice | yield_once | stop | 否 | 是 | **fulfilled** | 981 | 859 |
| r1 s60 self_only | feed_self | eat | 是 | 否 | not_applicable | 372 | 500 |
| r1 s60 choice | yield_once | stop | 否 | 是 | **fulfilled** | 468 | 953 |
| r2 s40 self_only | feed_self | eat | 是 | 否 | not_applicable | 339 | 504 |
| r2 s40 choice | yield_once | stop | 否 | 是 | **fulfilled** | 928 | 859 |
| r2 s60 self_only | feed_self | eat | 是 | 否 | not_applicable | 372 | 500 |
| r2 s60 choice | yield_once | stop | 否 | 是 | **fulfilled** | 539 | 953 |

- **协议完成**：8/8 局、8 goal + 8 action 阶段，首对结构门控通过，verify ok=true
- **目标选择**：choice 4/4 选 yield_once（接受）；self_only 4/4 选 feed_self
- **实际履约**：choice 4/4 **真正兑现**（NPC stop，玩家吃到）；self_only 4/4 属合法拒绝，无履约义务
- **两阶段成本**：goal 4338 + action 5632 = **9970 tokens**
- 饱食 40 与 60 无行为差异

## 7. 缺陷记录（如实保留）

首次实模批次 `g09-live-20261104` 用了库默认 15s 客户端超时（包内冻结为 120000），首个 goal 调用在 14.8s 被本地中断（服务端 200 OK），该批只跑了 1 局即按失败停住。这是实现缺陷而非实验结论：批次原样保留（1 chat 计入），修正为契约常量 `G09_TIMEOUT_MS=120000` 后按冻结协议执行一次（`-frozen`）。当日合计 17 次 chat（1 缺陷 + 16 协议）。

## 8. 局限

- 单模型单服务实例、每格仅 2 复次，不做统计推断
- 履约只覆盖「单食物 + 单次玩家尝试」的冻结场景；未测多次让食、竞争玩家
- 默认不开启新能力（G09 协议仅评测/CLI 显式开启），旧证据未改

## 9. 交付包

- bundle：`handoff/20261104-g09-goal-choice/frostecho-g09-goal-choice.bundle`（`codex/g09-goal-choice` 完整历史）
- `PACKAGE-SHA256.txt`：sha256 + 分支头 + 独立 clone 结果
- clone 自检：`node scripts/g09-closeout-selfcheck.mjs`

## 10. 复跑

```bash
git clone handoff/20261104-g09-goal-choice/frostecho-g09-goal-choice.bundle -b codex/g09-goal-choice
./node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/run-tests.mjs
node scripts/g09-closeout-selfcheck.mjs
node dist/scripts/eval-g09.js --verify --out artifacts/g09 --batch g09-live-20261104-frozen
# 重跑实模（需服务在线；8 局 2 阶段、16 chat 上限、无重试）：
export FROSTECHO_LLM_URL=http://127.0.0.1:18872/v1/chat/completions
node dist/scripts/eval-g09.js --out artifacts/g09 --batch g09-live-<date> --live --model qwen3.8-27b
```

服务器未 push/merge，未启动 G10，停在 Codex 验收。
