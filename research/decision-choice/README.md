# 候选顺序与输出约束：零调用研究提纲（G11-live 接续 · worker D）

- `authorizedCalls = 0`：本目录不发起任何模型调用、不占用 8 次玩法额度、不重启服务。
- `proposedCalls = 8`（位置对照）与 `8`（格式约束，另批另账），均**未授权**，需主 agent 另行申请。
- 研究只产出：可复现的上下文、可运行的本地自检、以及**待实测的假设**。这里没有任何"已实测结论"。

## 三段式：经典问题 → 可借鉴原理 → 本项目接口/收益/代价

### 1. 多项选择的呈现顺序会改变选择（位置偏置）

**经典问题**：在让模型"从 N 个选项里选一个"时，把同样的选项换个顺序，答案的分布会变。
这在人类问卷里是老问题（选项顺序效应），在 LLM 上被反复观察到，通常表现为偏向首项或末项。
具体到本项目：goal 阶段是一个**二元**选择（`feed_self` / `yield_once`），而候选是以
`candidateGoals: ["feed_self","yield_once"]` 这样一行 JSON 数组渲染的
（`src/negotiation/contracts.ts:222-231` 的唯一模板；`src/agent/providers/http.ts:92-101` 的唯一渲染入口）。
数组顺序就是呈现顺序，所以这个变量在本合同下**天然存在且完全由宿主控制**。

**可借鉴原理**：顺序效应是**呈现偏差**，不是任务难度差异。检验它只需要"同样的内容、两种顺序"。
因此顺序交换是对照实验的最小设计（paired order swap / counterbalanced presentation）。
**不照搬**外部 agent 工程的结论：它们的环境、提示词、评分方式都不同，本项目的候选只有两个、
且 ID 本身是语义标签（见下面的固有限制），外部数值不能迁移。

**收益假设**：如果模型的选择在正/反序下不同，那么上一轮/本轮的任何单次 goal 结果都带有
"顺序运气"，需要把顺序当作**已记录的实验因子**，而不是默认中性。
**代价**：每个上下文要两倍调用；且在本合同下**标签与位置不可完全分离**
（`feed_self` 这个词本身永远可见，只是位置变），所以只能报告"是否随顺序改变"，不能声称
"位置效应大小为 X"。这条限制必须随结论一起写。

### 2. 稳定性 ≠ 无偏

**经典问题**：确定性解码（`temperature=0`）下重复同一 prompt 必然得到同样答案，
于是"重复 10 次都一样"经常被误读为"模型没有偏置"。
**可借鉴原理**：稳定性只说明给定输入下输出函数是确定的，而**输入的顺序**本身是输入的一部分。
换顺序 = 换输入，因此"稳定"与"顺序不改变结论"是两件独立的事。
本项目的 fake/确定性 provider 能证明**管线稳定**（`tests/g11-live-closeout.test.ts` 已覆盖），
但**不能**外推为真实模型无位置偏置。
**收益**：把"稳定性测试"和"无偏测试"分开写，避免用前者冒充后者。
**代价**：真的要检验偏置就必须花真实调用。

### 3. `yield` 不是唯一正确答案

请求文本是玩家单方面的请求（`G09_REQUEST_TEXT`，`src/negotiation/contracts.ts:51`）。
NpcState 的 hunger 与 kitchen 食物都是公开观察，两个候选都是**合法且可解释**的：
`feed_self`（先满足自己）与 `yield_once`（让出食物）。因此本研究的因变量**不能**是
"是否选择了 yield"，否则等于把正确答案写死。本研究只允许两个因变量：

1. **格式合法率**（是否只回一个合法 JSON 对象）；
2. **位置稳定性**（同一上下文正/反序下答案是否改变、若改变偏向哪一侧）。

**性能、正确率、任务成功率一律不在本研究的可测范围内**（需后来另立实验）。

## 本目录内容

| 文件 | 作用 |
| --- | --- |
| `candidates.md` | 4 个可从旧合同重现的 goal 上下文 + 正/反序候选 + 合法性依据 |
| `experiments.md` | 两个互相独立的候选实验（位置对照、格式约束） |
| `check-order.ts` | 零调用自检：交换顺序不改变 ID→目标映射、不泄漏、可复现、确为逆序 |
| `STATUS.md` | 零调用声明、已核实事实、实际执行的命令与真实输出、未证明项 |

## 运行自检（不写 dist、不碰 artifacts）

`tsconfig.json` 的 `include` 只含 `src`/`tests`/`scripts/*.ts`，所以 `research/` 需要显式编译到临时目录：

```bash
node_modules/.bin/tsc research/decision-choice/check-order.ts \
  --outDir /tmp/dd --rootDir . --target ES2022 --module commonjs \
  --strict --esModuleInterop --skipLibCheck
node /tmp/dd/research/decision-choice/check-order.js
```

预期：`summary: 16 check(s) passed, 0 failed`，退出码 0，且打印
`authorizedCalls=0 proposedCalls=8 — no POST, no provider, no socket`。
