# STATUS — research/decision-choice

零调用声明：`authorizedCalls = 0`。本目录未发出任何 HTTP 请求、未构造 provider、未加载权重、
未安装依赖、未改 `src/**`、`scripts/**`、`tests/**`、`artifacts/**`、`handoff/**` 任何已有文件，
未改 `tsconfig.json`，未重启服务。`proposedCalls = 8`（位置对照）+ `8`（格式约束），**均未授权**。

## 已核实（只读、静态）

- 服务事实仅引用执行包记录（`handoff/20261106-g11-live-resume/SERVICE-STATUS.txt:2-10`）：
  2026-11-06 15:44:10 +08:00 一次启动成功；`GET /health` 200；`GET /v1/models` 200 且含 `qwen3.8-27b`；
  API PID 288413，TP workers 288974-288977；TP4、`gpu-memory-utilization=0.25`、`max-num-seqs=1`；
  真实 POST=0，玩法额度 0/8。**本轮未重新探测该端口。**
- prompt 唯一模板：`src/negotiation/contracts.ts:222-231`；唯一渲染入口：`src/agent/providers/http.ts:92-101`。
- 候选集：`G09_ALLOWED_GOALS.choice = ['feed_self','yield_once']`（`src/negotiation/contracts.ts:55-58`）。
- 生产 goal 请求体不含任何结构化输出字段（`model/temperature/max_tokens/stream/chat_template_kwargs/messages`），
  即"输出约束"目前完全靠自然语言那一行实现。

## 实际执行的命令与真实输出

```bash
node_modules/.bin/tsc research/decision-choice/check-order.ts \
  --outDir /tmp/dd --rootDir . --target ES2022 --module commonjs \
  --strict --esModuleInterop --skipLibCheck      # TSC_EXIT=0
node /tmp/dd/research/decision-choice/check-order.js
```

真实输出（节选，完整 16 项全 PASS）：

```
ctx-kitchen-food-hunger40: forward sha256 bb330c0ba1bf25de  reverse sha256 0d1518d4f54fc06f
counterbalance: forward-first=2, reverse-first=2, reps=1, total=8
summary: 16 check(s) passed, 0 failed
authorizedCalls=0 proposedCalls=8 — no POST, no provider, no socket
```

`RUN_EXIT=0`。16 = 4 个上下文 × (a1 映射不变 / a2 不泄漏 / a3 可复现 / a4 确为逆序且其余行相同)。

## 未证明项

1. 该 vLLM 是否支持有限候选 / JSON 约束输出：**未核实**（禁止 POST，未探测 18872）。
2. 模型是否存在位置偏置：**未测**（需要 8 次真实调用，未授权）。
3. 当前格式合法率的基线：**未知**（模板从不展示应答键 `"goal"` 的示例）。
4. 标签与位置在本合同下不可完全分离（见 `candidates.md` 末节）。
5. `check-order.ts` 未纳入 `tsconfig.json` 的 `include`，因此**不在**项目常规构建里；
   若要让 CI 守护它，需要另行批准修改 `tsconfig.json`。

## 下一步建议

1. 主 agent 先确认 `check-order.ts` 仍绿（零成本），再单独申请 8 次位置对照调用，独立账本、失败即停。
2. 格式约束实验另批另账，不要与位置对照混在一次调用里。
3. 任何研究结论只写"格式合法率"与"位置稳定性"；性能/正确率标注"需后来实测"。
