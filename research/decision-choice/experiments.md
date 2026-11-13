# 候选实验（全部未授权：authorizedCalls = 0）

> **2026-11-06 更正（见 `handoff/20261106-g11-verify-latency/CORRECTION.md`）**
> - 原“实验 2：输出约束”的 B 臂（允许 JSON 之后另起一行 `#` 说明）**已撤回**：
>   生产解析要求整个回答就是单个 JSON 对象（`src/negotiation/contracts.ts:140-160`），
>   允许尾随说明等于放宽合同，不是 token 层结构化解码。
> - 真正的格式约束应是**同一 prompt 上的 JSON schema / choice 解码**，属后续独立实验。
> - 优先级改为：先做 thinking 开关延迟先导（见 `latency/`），候选位置与结构约束暂缓。

## 优先级 1：thinking on/off 延迟先导（8 次，未授权）

已落地为可执行离线包，不再只是文字提案：

- 工具：`scripts/g11-latency-probe.ts`；输入与计划：`research/decision-choice/latency/`
  （`inputs/Y.json`、`inputs/N.json`、`plan.json`、`service-identity.json`）。
- 2 个**真实** action 输入（att-0002 `wait`、att-0003 `eat`）× on/off × 2 重复 = 8 次。
- 预注册顺序：`Y1 off→on`、`N1 on→off`、`Y2 on→off`、`N2 off→on`。
- 唯一自变量 `chat_template_kwargs.enable_thinking`；model/messages/temperature0/max_tokens1024/
  stream false/timeout 120000/默认 effort 全部逐字冻结，由 `buildPair()` 的差分断言守护。
- 因变量只限：格式合法率（严格解析）、动作、每请求 latency、prompt/completion/reasoning tokens、
  known/unknown usage。**性能与正确率需另行实测**；单步合法 ≠ 整局成功。
- 失败即停：仅首个传输错误/非 200/超时/严格动作解析失败即停，其余 `not_run`，无隐式重试。
- **缺 `usage` 不是即停条件**：该条记为 unknown，已知 usage 小计保留、`total=null`，计划继续执行。
- 门禁：`authorizedCalls = 0`、未带 `--authorized`、或运行时源码未提交 → `exit 2` + 0 请求。

## 优先级 2（暂缓）：候选呈现顺序对照

前置条件未满足，暂不执行：

1. 上下文必须由**真实入口**产生 `DecideInput`（`createApplicationController`），不能手工构造；
2. “已饱/不可接收位置”只能作为预检负例，不能混入常规选择样本；
3. 需先确认生产解析 `strictGoalChoice` 到目标绑定的完整链路（`check-order.ts` 已加 a5 检查）。

满足后仍为 4 上下文 × 2 顺序 × 1 rep = 8 次，`authorizedCalls = 0`。

## 优先级 3（暂缓）：结构化输出/JSON 约束

- 部署侧已装字段与后端（vLLM 0.32 `structured_outputs`、XGrammar 0.2.8，
  见 `handoff/20261106-g11-verify-latency/performance-review/REPORT.md:36-46`）。
- 但普通结构约束在 reasoning 结束后才生效，**不能当作限制长思考的手段**，
  必须与 thinking 开关分开做单因素实验。

## 共同硬边界（不变）

1. `authorizedCalls = 0`：本文档不发起调用。
2. 不占 G11 玩法额度（旧批 6/8 已停止，剩 2 次不补跑）；研究用独立账本。
3. 不重启服务、不改模型名、不改生产默认配置、不加载新权重、不装外部框架。
4. 失败即停，不重试、不补测、不“再跑一次看看”。
5. 结论只写格式合法率与延迟/用量；稳定性 ≠ 无偏；`wait`/配合不是唯一正确答案。
