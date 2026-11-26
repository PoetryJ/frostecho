# R11 盲审 F — A 轮封存报告

状态：**已封存，等待 O 投放 packet-B**。本报告写入后 `review-A.jsonl` 即设为只读。

## 1. 输入核验（快照一致性）

| 项 | 值 |
|---|---|
| packageId | `ba1ca15c0cc005543f10cb5429a44272b5991a5115c133ccee95421953bd6386` |
| salt | `947eafc47dd2ec863876c0396193c3067b8fc350f53c69439d903497b8d59395` |
| packet-A.jsonl sha256 | `f661c262d57ea951952cdee566646a17d4a148bd7c42b679bb15f1aa5ff8d2c8` |
| 清单声明 sha256 | `f661c262d57ea951952cdee566646a17d4a148bd7c42b679bb15f1aa5ff8d2c8`（一致） |
| review-template-A sha256 | `606e4dfc5af1a751f06dd57ea67c9b5770d6de920ecc7dbaa4a4e3af8299059d`（一致） |
| 用例数 | 48（与 package.json `counts.cases=48` 一致，行序与模板一一对应） |

## 2. 方法与判定口径

仅使用 `packet-A.jsonl` 内当事人可见字段：时间/天气/公共资源/炉火/自身六维/仓库认知/记忆（authority 全部为 `engine`，无传闻）/`目标`/`可选行动`。未读仓库、未读 C/D/E/H、未读 `key.json`、未读 `in/G`、未开子 agent。

判定优先级（事前视角，不含 B 轮结果）：

1. **在办承诺 > 一切**：`目标.status=active` 且候选带有同一 `commitmentId` 的桥接动作（`bridgeStep=to-warehouse` / `deliver`）时选该动作；前提（alive、revision 未变、carrying meals≥1）逐条核对。
2. **急性亏空修复**：体力 < 50 或健康 < 85 → 休息（仅宿舍可得），或在村中先移动回 dorm-a。
3. **资源安全**：木柴 < 20 且无急性亏空 → 采柴（食物 128 不缺，木柴是雪天紧约束）。
4. **信息缺口**：仓库未核实且身上有已接受的 supply-warehouse 承诺（截止 720）→ 核实存粮。
5. **无缺口** → 原地等待（最省，避免无收益消耗）。

决策状态分布（见 `provenance-A.jsonl.decisionStatus`）：

| 状态 | 数量 | 含义 |
|---|---|---|
| `obligation_active` | 11 | 有 active 目标且有绑定桥接候选，直接履行 |
| `obligation_active_late` | 2 | 同上但已过 deadline=720（t=780），仍选补交付 |
| `no_visible_obligation_gap` | 6 | 记忆里有已接受承诺但无 `目标` 行，选核实存粮 |
| `no_active_obligation_survival` | 29 | 目标 fulfilled/无目标，按生存优先级选 |

`abstain`：48 例全为 `false`。**没有"没有合适候选"的用例**——每个状态至少有一个可辩护动作；证据不足仅出现在"承诺台账是否已结清"这一层（见 §3），不影响动作选择。

## 3. 不确定性与缺项

- **未给出事实 ID**：包内无 `facts` 数组，唯一可用标识是记忆条目的 `sourceEventIds` 与 `commitmentId`；已在 `provenance-A.jsonl` 按 case 列出 `factsAllEventIds` / `factsKeyEventIds`（含 `goal:<commitmentId>`）。
- **`目标` 行缺失**（6 例，均为 480 分钟）：无法区分"从未立任务"与"已结清但未记录"，故只能按记忆中的已接受承诺推断，置信度 0.50–0.55。
- **燃料显示 20.00**（8 例）：`refuel` 前提为 `fuel < 20`，显示值四舍五入到 2 位，无法判断是 19.99 还是 20.00。处理：不判非法，只判"接近上限、收益近零"而弃选。
- **行程耗时不可见**：不知道到仓库/厨房需要多少分钟，故无法精确计算"剩余 60 分钟是否够交付"（仅 660 分钟、已在厨房的 deliver 可确定）。
- **携带饭数量不可见**：`deliver` 仅能凭引擎给出候选反推 `carrying meals ≥ 1`。
- **NPC 是否会代为履约不可见**；不纳入判断。
- **行动非法**：A 轮未发现明确违反前提的候选。所有候选的 `alive/food/hunger/stamina/firewood` 前提与显示值相容（唯一边界项是上述 `fuel=20.00` 的 refuel）。

## 4. 泄漏检查

包内无策略名、无分数、无分支结果、无 B 轮事实；候选描述仅含自然语言动作。**LEAK: none**。本会话此前未见过该批标签或另一审答案，无需标记受影响 case。

## 5. 会话与文件

- 会话标识：`CODEBUDDY_SESSION_ID=c04c8711e4e8477aa9b053eb6224e8f6`（CLAUDE_SESSION_ID 同值）
- 模型/配置：DeepSeek-V4.1-Flash，CPU 会话，无 GPU，无采样随机性（一次性人工判定）
- 产物：
  - `review-A.jsonl` sha256 `ecb98bd263c93ed8ec18afc42030dc196b10c7a3a07fbf9a8a138031f9f1f197`
  - `provenance-A.jsonl` sha256 `bd6602a113564b69998a51d5214e0f2ba717d6d47aa90ec161fc37a14105c29a`
  - `review-A.sha256`（对上述两文件与 packet 的校验行）
