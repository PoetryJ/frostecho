# R11 盲审 F — B 轮封存报告

状态：**已封存**。第二阶段未改判 A 轮任何一条；改判/不接受之处按事后结果单独记录。

## 1. 快照核验

| 项 | 值 |
|---|---|
| packageId | `ba1ca15c0cc005543f10cb5429a44272b5991a5115c133ccee95421953bd6386` |
| salt | `947eafc47dd2ec863876c0396193c3067b8fc350f53c69439d903497b8d59395` |
| packet-B.jsonl sha256 | `0c05c43833d0a3b967c4d66c1bd6e897244e37f5f0721aa8d97878f23a44c5fe`（与清单一致） |
| review-template-B sha256 | `61165c7c0c15fdf42ba9514c8487b4e84713e1af8b6824688e23d6dcea3dc42f`（一致） |
| caseId | 48/48，与 packet-A **同集合同顺序**，`MISMATCH: none` |
| 分支 | 243 条，`schema=frostecho.r11c.packet-b/1`，`continuationPolicy=reference-rule/1` |
| 泄漏 | 分支内无分数/策略名/模型身份/正确答案；`LEAK: none` |

共同截止时刻 `commonDeadline` 逐案采用（`commitment-due` 11 例 = 720；`frozen-default` 37 例 = t0+240 → 720/900/1020/1140），未使用真实时钟或事后信息。

## 2. B 轮判定口径

- **P1 授权门槛**：`authorization.withdrawn=true`、`unauthorizedSideEffects>0`、`firstAction.status≠applied` 或回执缺失的分支不接受。本轮 243 条分支全部 `withdrawn=false`、`unauthorizedSideEffects=0`、`status=applied`，门槛未淘汰任何分支。
- **P2 在办义务（active/fulfilled）**：只接受 `statusAtDeadline=fulfilled` 且 `completedAt ≤ commonDeadline` 且有 `receiptTypes` 的分支；截止时仍 `active` 视为未履约，不接受。若一条都没有 → `abstain=true`。
- **P3 pending-change**：该目标自身的 `alt-source` 变更在截止时仍未决，属治理未决而非居民过失，按"未决非失败"处理（INSTRUCTIONS-B 的 `pending` 布尔在本包 243 条分支中全为 false，此条为同类情形的方法学延伸）。
- **P4 无义务 / 未决状态**：接受全部无撤回、无越权、公共资源未耗尽的分支；**代价只记录不否决**，因为 B 包不含体力/健康/体温结局，采柴、休息、回宿舍的收益无法与木柴净额对冲。唯一例外：t0 食物 ≤ 3 时排除"进食"分支（无义务状态下仍从 3 份口粮扣减，属可避免的自损）。

## 3. 结果分布

| decisionStatus | 例数 | 接受分支 |
|---|---|---|
| `obligation_fulfilled` | 5 | 仅 `b1`（675 ≤ 720，回执 `meal_delivered`） |
| `obligation_failed_all` | 6 | 空，`abstain=true` |
| `obligation_pending_change` | 2 | 全部 6 条 |
| `no_obligation_food_critical` | 2 | 4 条（排除 o1 进食） |
| `no_obligation` | 33 | 全部 |
| 合计 | 48 | 6 例弃权 |

全包 243 条分支：`fulfilled` 5、`active`（截止时）56、`pending-change` 12、无义务 170。

## 4. 事前合理性与事后结果（A→B 对照）

- A 轮选择在 B 轮被接受 **42/48**。
- 6 例不被接受，全部是 **t0=480 的桥接/补仓承诺**（case 1/9/21/29/33/41）：分支 `firstAction` 均 `applied`（动作本身合法、授权有效），但到 720 截止时义务仍 `active`、`completedAt=None`——**事前合理、事后未履约**，不是动作非法。这 6 例 A 轮给的置信度本就最低（0.60–0.85 中的 0.80/0.60），此处不改 A 原判，仅记录结果。
- 2 例 `pending-change`（case 11/43，t0=780）：A 轮选桥接（o1/b1）时该目标已进入变更待决，B 轮确认无分支能结清；原判保留，接受集不因此收窄。
- 5 例 t0=660 送饭（case 2/14/30/34/46）：A 选 deliver，B 全部 `completedAt=675`、回执 `meal_delivered`，事前事后一致。

## 5. 缺项与不确定

- **无生存维度结局**：B 只给资源/人时/回执，没有体力、健康、体温、饥饿。P4 的"可接受"因此只覆盖授权与资源，不覆盖"这个休息是否真的恢复了体力"。
- **`personMinutes` 语义未说明**：取值 90–707，与动作时长不单调（如 10 分钟添柴 90，0 分钟等待 144；15 分钟去仓库 334）。本报告只记录，不据此排名或否决。
- **`refusal="original_maps_traversed"`**（80 条）：属空间迁移提示，`status` 仍为 `applied`，不作为拒绝处理。
- **`exogenous` 全为空**：无外生事件可解释失败，故 P2 的失败判定没有豁免项。
- **无"没有合适候选"以外的非法动作**：243 条分支无越权、无撤回、无拒绝，B 包本身不能区分"行动非法"；该项只能在 A 轮层面对照前提。

## 6. 文件与会话

- `review-B.jsonl` sha256 `c94d2a9987c925ea87ed93df29b539bcd5465372bc317d479553171b1d8a3cf4`
- `provenance-B.jsonl` sha256 `05ab40a5a231915e6a7cc9a60fbd5862cf82df6ad188741398b9a89c13c0a9a5`
- `review-B.sha256` 含上述两行 + packet-B 校验行
- 会话 `CODEBUDDY_SESSION_ID=c04c8711e4e8477aa9b053eb6224e8f6`；模型 DeepSeek-V4.1-Flash，CPU，无采样随机性
- 未读 `key.json`、`C/real-run/`、`in/G`、`return/G/`；未开子 agent；未做多数票
