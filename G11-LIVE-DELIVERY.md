# G11-live 收口交付：终态/预算/显示三修 + 薄驱动 + 实模批次（本轮结果 offline_ready）

基线 `f87b8c3` · 分支 `codex/g11-live-closeout` · 运行源码提交 `47b7563`
本轮真实模型调用 **0 / 8**（服务不可达，offline_ready，未重启共享服务），未 push/merge。

## 三处限定修复（离线已证）

1. **终态覆盖**：`GoalSettlementState` 增加 `failed`/`cancelled`（`src/agent/contracts.ts`）；`settleEndedGoal`/`settleAtWake` 对二者零调用结算（`src/agent/runner.ts`），自动接续资格仍仅 fulfilled/expired（游戏侧判定不变）。反例：yield→wait→玩家移宿舍→eat失败→time1 后 Provider 总数仍 2、无新 cycle、旧 request 终态不改；cancelled（quit）同为零旧调用。
2. **预算接线**：`externalBudget` 现注入两条真实入口——fresh `createG10Runtime` 与 `loadG10Runtime`/`restoreNeedsGame`（`src/application/adapters.ts`、`src/persistence/contracts.ts`、`src/reactive/checkpoint.ts`）；每次判定实时读取权威持久账本，读失败 fail-closed；reserve 仍是并发硬限。limit2 耗尽后 fresh 与恢复路均 0 新 cycle / 0 Provider / 0 POST。
3. **当前目标显示**：`AppNpcView.selectedGoalBasis`（`session_binding` / `goal_choice_pending` / `ordinary_hunger_need`，`src/application/contracts.ts`、`session.ts`、`presenter.ts`）。普通 cycle 显示“饱食需求（普通cycle；未重新选择目标）”，绝不从历史 request 倒灌 yield 标签；旧请求仍在独立行显示 fulfilled/expired/failed/cancelled。

## 驱动与命令（复用既有 application/存档/账本，无第二套计费器）

```bash
# 0) 编译
npm run build

# 1) 一次性计划：记录源码HEAD/提示版本/有效配置/授权与8次硬限（已存在即拒绝，0 POST）
FROSTECHO_COMMIT=$(git rev-parse --short HEAD) \
node dist/scripts/g11-live.js prepare \
  --batch artifacts/g11-live/g11-live-20261105-r1 \
  --campaign artifacts/g11-live/campaign-approved8 \
  --http http://127.0.0.1:18872/v1/chat/completions --model qwen3.8-27b --limit 8

# 2) 编排：单次 GET precheck → 串行 W1/W2 prefix+suffix 子进程（每个真实进程一次 application 生命周期）
node dist/scripts/g11-live.js run --batch artifacts/g11-live/g11-live-20261105-r1 \
  --campaign artifacts/g11-live/campaign-approved8 \
  --http http://127.0.0.1:18872/v1/chat/completions --model qwen3.8-27b

# 3) 只读核验（wire↔账本逐条、唯一attemptId成本、lineage/parentSlot、槽hash、场景共享额度）
node dist/scripts/g11-live.js verify --batch artifacts/g11-live/g11-live-20261105-r1 \
  --campaign artifacts/g11-live/campaign-approved8 --http x --model x

# 4) 离线三轨迹演示（脚本Provider，零模型调用）
node scripts/g11-demo.mjs
```

- `prefix`：`request npc_a yield_once` → step(goal) → 仅选 yield_once 且 accepted 才 step(action) → 仅真实合法 wait（wake=1）才 `save <scene>-wait` → `quit`/finalize（退出分支的 pending→cancelled 原样保留在 prefix run 记录）。
- `suffix`：新 Node 进程只 load `-wait.g09.json`；先验证 0 调用/0 提交、旧请求 pending、wait截止/目标/预算一致；每步前读场景基线差额（prefix 起点持久化于 `scene-base.json`，prefix+suffix 共享每场景 4 次），step 后读权威 view 再决定下一步。W1: eat→time1→restock2→最多2步；W2: time1→restock1→最多2步。旧请求终态、A30→60→90、food0 每步断言。
- 退出码：0=两条路径真实触发且达权威结果；1=未触发/未达成/技术失败（分别记原因）；2=配置/同名错误且0 POST；3=offline_ready（仅1次GET）。

## 本轮实模结果（2026-11-06）

- 预检：`GET /health` → Connection refused（18872 无监听）；`GET /v1/models`（run 内建）→ fetch failed。按 LIVE.md **不重启服务**，留证 `offline-ready.json`（schema `frostecho.g11-live.offline-ready/1`）。
- `run` 退出码 **3**，POST **0/8**，无 campaign 账本生成（0 attempt、0 token、成本 unknown 不适用、延迟无）。
- 结论：无法在服务不可达时以 0 证据冒充实模；批次保持一次性路径，未删除、未换目录刷新额度。服务恢复后**同一命令**即可执行，授权不变（8 次、每场景 4 次）。

## 离线门控（全部在本提交上执行）

| 门控 | 结果 |
|---|---|
| 编译 `tsc` | 通过 |
| 全量 `node scripts/run-tests.mjs` | **524/524**，0 fail，0 skip（含合同/golden/旧三fixture cooperate/decline/violate/G08兼容loopback） |
| `scripts/g11-demo.mjs` | 5/5 轨迹含两个跨进程恢复点全过，`exit 0` |
| `scripts/g08-closeout-selfcheck.mjs` | 全绿 |
| `scripts/g09-closeout-selfcheck.mjs` | **exit 1**：`verify fixture-g09-fake`/`g09-live-20261104-frozen` exit2 expected0 —— **预置问题**：该脚本未随 `eval-g09 --verify` 新增的 `--campaign` 必填参数更新；在基线 `f87b8c3` 干净 worktree 上复现同一失败（`closeout/g09-selfcheck-baseline-f87b8c3.log`）；G08 批仍 `exit 0`；`eval-g09 --verify` 对自洽批次 `fixture-g09r1-fake` 仍 `ok=true complete=true evidenceOk=true`。本轮未改该脚本（超出限定范围），如实报告。 |
| `tests/g11-budget-wiring.test.ts`（B接线黑盒） | 3/3 |
| `tests/g11-live-closeout.test.ts`（D独立黑盒） | 9/9：终态/显示/8POST全链路/耗尽门控/feed_self/HTTP500/同名拒绝/verify篡改(attemptId、累计成本、parentSlot、槽改写、usage=null诚实) |

## 已知/未知

- 已知：三修复与驱动离线语义如上；实模 `yield+wait` 后的真实恢复行为**未证**（服务不可达，0 POST）。
- 未知：真实模型本轮是否选择 yield+wait；长期合作、真实终端 Ctrl+C、稳定低延迟均不外推。
- 预置偏差：g09 自检脚本参数过时（见上），非本轮引入，未修。

## 未做

- 未 push/merge；未改 prompt/采样/期限/世界规则；未重试/补批/重启服务；未改旧证据字节（`artifacts/{g09,g09-r1,g10-*,g08-closeout,g01}`）。
