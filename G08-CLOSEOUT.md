# FrostEcho G08 收口交付（2026-11-03）

## 1. 基线与分支

- 基线 `10be66e`（G08-R1）；分支 `codex/g08-closeout`
- 提交：`b5c80df` A（世界因果链）→ `44081bc` B（账本派生）→ `af825dd` C（CLI 存档配置/失败证据）→ `f6c6c61` D（独立黑盒）→ `8285dd4` 主整合（派生→写 summary→只读核验）→ `b56bd0d` 新 fake 证据 → `d11f60d` 实模 8 局
- 等待状态机与上一轮通过的核心不再改动；本轮只补原验收未落实的四项（V1/V2/C1/C2）

## 2. 关闭的原验收缺口

| 编号 | 原问题 | 本轮 |
|---|---|---|
| V1 | 只重放事件，未重跑 Engine，命令与 raw 决策无因果绑定 | `auditWorldEpisode`：fresh Engine 逐命令 submit 比对 seq/状态/eventIds/事件/终态；命令必须**就是** raw 解析出的动作（eat/move 1 条且 payload 一致，stop/wait 0 条，wait 需 actor 暂停且 deadline=simTime+1）；behavior 由重执行派生并与记录交叉核对 |
| V2 | summary 只查 schema，999 也能过 | `deriveLedgerCosts` 从原始账本重算请求/预算/usage/latency/四格/四配对/unknown，`compareSummary` 逐字段比对；缺 summary 完整 verify 必失败；prefix 只验前 2 局 |
| C1 | 存档 thinking=false 被忽略 | `--load` 校验后以 `saved.effectiveConfig` 为唯一配置：provider `enable_thinking=config.thinking`，timeout 沿存档，后续 save 同源 |
| C2 | 失败证据只有通用标签 | `run-failure/2`：权威 game 状态与完整 record、逐 turn 会话错误、真实 HTTP 状态与限长正文、有效配置与动作上下文；原槽字节不动 |

## 3. 门控（全部通过）

| 门控 | 结果 |
|---|---|
| `node scripts/run-tests.mjs` | **408/408** |
| `tsc -p tsconfig.json` | 干净 |
| golden | **12/12** |
| state 探针（R1 包） | 全绿（缺 simTime 拒绝、三类恢复冲突、actor10 即时结算） |
| cli 探针（R1 包） | 全绿（存档 model、模式/模型冲突 exit2 零请求、500 exit1、调用数一致） |
| eval 审计探针（R1 包） | **8/8** |
| verifier 探针（本包） | **3/3**（合法通过；命令篡改拒绝；summary 999 拒绝） |
| runtime 探针（本包） | 全绿（thinking=false 真实生效；500 原始 cause 与失败状态留存） |
| G07 旧批只读 | exit 1，`behaviorAndCost=ok configuration=mismatch`（既有差异，不白改） |

## 4. 服务恢复与实模结果

- 按 `SERVICE.txt` 用 `/data/frostecho-runtime/server.json` **一次性**启动（TP4、每卡 0.25、max-model-len 8192、max-num-seqs 1），pid 716425，启动记录 `/data/frostecho-runtime/closeout-launch.json`
- 只读预检：`/health` 200、`/v1/models` 200 含 `qwen3.8-27b`；**未发额外 smoke chat**
- 实模 8 局（`artifacts/g08-closeout/g08-closeout-live-20261103`）：**8/8 chat，全部完成，verify ok=true，exit 0**

| 格子 | 动作 | npcAte | playerAte | tokens（两复次） | on−off 差值 |
|---|---|---|---|---|---|
| legacy-off | eat | 是 | 否 | 544 / 544 | — |
| legacy-on | eat | 是 | 否 | 814 / 814 | **+270** |
| timed_wait-off | eat | 是 | 否 | 507 / 507 | — |
| timed_wait-on | eat | 是 | 否 | 803 / 803 | **+296** |

**如实结论**：四格全部 `eat`，模型从未选择 `wait`；S1「把最后一份食物留给我」未被遵守。消息只改变成本（每配对 +270/+296 tokens），不改变决策。总量 5336 tokens，usage 全部已知，0 blocked、0 unresolved。

## 5. 局限

- 实模从未触发 wait 路径，因此「实模等待后续」仍未证明；等待机制由 fake/state 证据支持
- 服务恢复为单次启动，未做长稳压测；其余 GPU 进程未动，计算利用率仍与他人共享
- 旧 G08-R1 材料（`artifacts/g08-r1`）的 summary 无 `costs` 块，属兼容边界：仍按旧字段严格比对，不回写

## 6. 交付包

- bundle：`handoff/20261103-g08-closeout/frostecho-g08-closeout.bundle`（`codex/g08-closeout` + `codex/g07-player-messages` 完整历史）
- SHA256 与独立 clone 核对：`handoff/20261103-g08-closeout/PACKAGE-SHA256.txt`
- clone 内自检：`node scripts/g08-closeout-selfcheck.mjs`（构建 + 全测 + 三批只读核验 + 证据不变性）
- `handoff/` 按仓库约定不入库；探针/golden 位置与命令见 `PACKAGE-SHA256.txt`

## 7. 复跑命令

```bash
git clone handoff/20261103-g08-closeout/frostecho-g08-closeout.bundle -b codex/g08-closeout
./node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/run-tests.mjs
node scripts/g08-closeout-selfcheck.mjs
node dist/scripts/eval-g08.js --verify --out artifacts/g08-closeout --batch g08-closeout-live-20261103
# 重新跑实模（需服务在线，8 次上限、无重试）：
export FROSTECHO_LLM_URL=http://127.0.0.1:18872/v1/chat/completions
export FROSTECHO_LLM_MODEL=qwen3.8-27b
node dist/scripts/eval-g08.js --out artifacts/g08-closeout --batch g08-closeout-live-<date> --live
```

服务器未 push/merge，未启动 G09，停在 Codex 验收。
