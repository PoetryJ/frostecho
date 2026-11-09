# STATUS — research/decision-choice（2026-11-06 更正版）

零调用声明：**`authorizedCalls = 0`**（本目录的冻结计划）。本目录未发出任何模型请求、未构造 provider、未加载权重、
未安装依赖、未改生产默认配置、未重启服务。`proposedCalls = 8`（thinking on/off 延迟先导，
已落成可执行离线包）。候选位置/结构约束两个旧提案**暂缓**。

## 2026-11-09 先导状态（owner 已授权，仍为 0 POST）

- 负责人授权本先导最多 8 次真实 POST（`handoff/20261106-g11-latency-pilot/AUTHORIZATION.json`）；
  旧 W1/W2 批剩 2 次不可用。
- `minimal-fix.patch` 已套用并提交在 `codex/g11-latency-pilot`；离线门控见
  `handoff/20261106-g11-latency-pilot/B-ACCEPTANCE.md`。
- 预检 `GET http://127.0.0.1:18872/health` = **connection refused**；`/v1/models` 无响应，
  无 vLLM 进程。按协议**不重启服务、不换端点**，停止在 `offline_ready`。
- 因此本批真实 POST **0/8**，账本未创建，`artifacts/g11-latency/g11-latency-20261106-r1`
  未创建（避免留下半成品目录）。

## 本轮更正（见 `handoff/20261106-g11-verify-latency/CORRECTION.md`）

1. 成本：已知 **2397**（231+777+504+654+231）+ **1 次未知**（att-0006），总量 **null**；2166 只是 W1 小计。
2. 源码身份：实跑发生在未提交工作区（`run-start.codeHead=44a1b69` vs 交付 `44e8053`），
   **运行字节的精确归属未证明**；不回写旧记录、不补跑。
3. 撤回“JSON 后允许 `#` 说明”的格式约束设计（与整段严格解析冲突；真约束是 schema/choice 解码，另案）。
4. 阈值更正：`GOAL_HUNGER_AT_LEAST = 70` 是目标阈值；90 是观测终态，`ctx-*hunger90` 降级为边界样本。
5. 候选上下文必须由**真实入口**产生 `DecideInput`；人工观察只能作预检负例。

## 已交付并可复跑的部分

| 项目 | 位置 | 状态 |
| --- | --- | --- |
| 顺序自检（20 项） | `research/decision-choice/check-order.ts` | 20/20 通过；含生产解析 `strictGoalChoice` 的接受/拒绝集 |
| 延迟先导工具 | `scripts/g11-latency-probe.ts` | `plan/run/summarize`；默认离线；未授权 `exit 2` + 0 请求；已套用补丁（run 前冻结 schema/body/hash/matrix/预算） |
| 两个真实输入 | `latency/inputs/{Y,N}.json` | att-0002 / att-0003 的真实 `requestBody`，含源文件 sha256 |
| 冻结计划 | `latency/plan.json` | `proposedCalls=8`、`authorizedCalls=0`、预注册顺序 Y1 off→on、N1 on→off、Y2 on→off、N2 off→on |
| 服务/模板身份 | `latency/service-identity.json` | 静态核实（vLLM 0.32、XGrammar 0.2.8、config/tokenizer/template 哈希） |

## 实际执行的命令与真实输出

```bash
node_modules/.bin/tsc research/decision-choice/check-order.ts --outDir /tmp/dd --rootDir . \
  --target ES2022 --module commonjs --strict --esModuleInterop --skipLibCheck   # TSC_EXIT=0
node /tmp/dd/research/decision-choice/check-order.js
# summary: 20 check(s) passed, 0 failed
# authorizedCalls=0 proposedCalls=8 — no POST, no provider, no socket
```

延迟工具只用随机端口 fake 与离线 fixture 验证（见 `tests/g11-verify-latency.test.ts`），
**没有对 18872 发过任何请求**。

## 未证明项

1. thinking 关闭后的**决策质量与端到端延迟**：未测（本批 0/8；预检时服务连接被拒，未创建账本）。
2. 服务是否把 shared GPU / 长思考当作唯一根因：**未证明**；日志只能说明执行期持续解码。
3. att-0006 的真实 token 数：未知，且不可补估。
4. 结构化输出（JSON schema / choice）在本模型上的端到端可用性：未实测。
5. `temperature=0` 不保证所有推理服务逐字确定，因此“可复现”只针对渲染字节成立。

## 下一步建议

1. 负责人批准后，用 `g11-latency-probe` 跑 8 次先导（真实、独立账本、失败即停），
   运行前必须提交代码并让 `git status -- src scripts` 干净。
2. 先导若显示 off 显著降低 completion/reasoning token 而动作质量不降，再讨论是否改默认；
   不要连续换参数试到“好结果”。
3. 候选顺序对照与结构化输出各自另案，均需先补真实入口上下文。
