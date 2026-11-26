# G / 盲审 B 轮回执

- 状态：**DONE-B（已封存）**；A 轮 `review-A.jsonl` 保持只读未改
- 角色：独立盲审 G；未开子 agent；单一会话
- 时间：2026-11-26 17:4x CST

## 1. 输入核对

| 文件 | 声明 SHA（package.json） | 实测 SHA | 结论 |
|---|---|---|---|
| `packet-B.jsonl` | 0c05c43833d0a3b967c4d66c1bd6e897244e37f5f0721aa8d97878f23a44c5fe | 同左 | 一致 |
| `review-template-B.jsonl` | 61165c7c0c15fdf42ba9514c8487b4e84713e1af8b6824688e23d6dcea3dc42f | 同左 | 一致 |
| `INSTRUCTIONS-B.md` | — | c784445e527b833f8c2a7020b9d0684958ac061f4c6cc4c96fb4f56b1284251f | 记录 |

- `packageId` 仍为 ba1ca15c0cc005543f10cb5429a44272b5991a5115c133ccee95421953bd6386，与 A 轮同包、同 salt。
- **同一快照核对**：48/48 案的 `t0.simTime` 与 `packet-A` 观察中的「第 N 分钟」逐一相等；caseId 集合、候选数/分支数（243）逐案一致；无不匹配。
- `exogenous` 全为 `[]`；`continuationPolicy` 全为 `reference-rule/1`；`pending=false` 243/243；`admitted=false` 0；`authorization.withdrawn` 0；`unauthorizedSideEffects>0` 0。
- **绝对截止**：以 `commonDeadline.simTime` 为唯一判据（`480→720`、`660→720` 为 `commitment-due`；`660→900`、`780→1020`、`900→1140` 为 `frozen-default`）。A 轮包内无 t\*，本轮以 B 包为准，未使用真实时钟。

## 2. 判定口径（事后、只用分支事实）

1. 授权门：`withdrawn` 或 `unauthorizedSideEffects>0` 直接排除（本包 0 例）。
2. 履约门：t0 存在义务时，只有 `statusAtDeadline=fulfilled` 且 `completedAt≤commonDeadline` 的分支可接受；`active` 视为逾期未完成。全部 `pending-change` 时按约定**不作失败计**，改按生存门判。
3. 全部 `active` 且无分支履约 → **无分支可接受，abstain=true**（不把"有进展"当作履约）。
4. 生存门（无义务/仅 pending）：食物>0；木柴、电力不低于存量一半（若该状态全部低于则视为整体性结果、不加罚）；食物紧缺（起始≤30）时须在本状态最好值 2 点以内。
5. 代价：资源逐项不低且人时更少（差值 ≥30 分钟才计）者占优；被占优的分支剔除，其余并列可接受。

## 3. 结果

- 判定路径：`fulfilled` 5 案、`all-missed→abstain` 6 案、`survival/pending` 37 案。
- 可接受集合规模：1 个 17 案、2 个 7 案、3 个 5 案、4 个 9 案、5 个 4 案、空（abstain）6 案。合计列入 137 个分支。
- **相对 A 轮改判 43/48**（只有 5 案不变，即 5 个 deliver 履约案）；A 轮所选 ⊆ B 轮可接受的仅 15/48。原因集中在两类：A 轮按可见文本选了"唯一最优"，B 轮显示候选间多为 1-4 点资源 / ≤60 人时的等价取舍；以及 6 案事后不可履约。

## 4. 关键发现（供 O 隔离后核对）

1. **6 案结构性不可履约**：`c-f1b496c6…`、`c-42376f5f…`、`c-3ea64e583…`、`c-451ce0b8…`、`c-26f05181…`、`c-bcb2e19b…`。义务（deliver-meal / supply-warehouse）在 720 截止前无任何分支结清（全部 `active`、`completedAt=null`、无履约回执）；仅 b1/b4/b5 取得 `warehouse_stock_observed@first-action`。A 轮所选 bridge 事前合理、事后未结清——A/B 分歧即"事前合理 vs 事后结果"，非笔误。
2. **5 案唯一履约分支**：`c-9acb2a0c…`、`c-17ee464c…`、`c-1d9e06e0…`、`c-a5f2c9f1…`、`c-4d8309f0…`，均 `b1` 在 675 分钟 `<720` 结清并出 `meal_delivered@first-action`；其余分支 `active`。A/B 一致。
3. **撤回 A 轮 refuel 非法判定（9 案）**：`c-0217955c…`、`c-6a7976e7…`、`c-eb29c173…`、`c-639ef9dd…`、`c-724d2f4f…`、`c-923cf3b0…`、`c-0490697…`、`c-fd3a63fc…`、`c-c6a4e0f4…`。A 轮据 `fuel=20.00` 不满足 `fuel<20` 判其非法；B 轮实测这些 refuel 分支 `admitted=true` 且出 `refuelled@first-action` 回执（木柴 -2），说明运行时口径为 `<=` 或燃料含隐藏小数。若 key 按 A 轮口径，属系统性口径差、非单案；其中 4 案的 refuel 分支（b3/b4）进入可接受集。
4. **pending-change 2 案**：`c-fd3a63fc…`、`c-c6a4e0f4…` 全部分支到截止为 `pending-change`，按指示不作失败计，按生存门与代价判。
5. **首动作边际价值被续跑策略抹平**：37 个无义务/仅 pending 案中，多数分支到截止的差异只有 1-4 点资源、30-60 人时；`reference-rule/1` 在剩余时间自行采集/添柴，使"添柴/等待/返宿"等首动作几乎等价。B 轮因此常给出多条并列，不代表审阅放宽。
6. **履约回执稀缺**：243 分支中只有 5 个含 `meal_delivered`；170 个分支 t0 时根本无义务；无任何分支出现授权撤回或越权副作用。

## 5. 缺项（影响可判定性）

1. 分支事实只有 food/firewood/medicine/power 四项资源，**无饥饿/体力/健康/体温**到截止值 → 生存门只能用资源判，不能用体征判。
2. 未给分支的 token/时长明细；`personMinutes` 语义按"人时成本"处理（越低越省），若原意为"投入产出"，第 5 条代价比较方向需反转。
3. `receipts` 混合通用类型（`r8_*`/`legacy_*`）与业务回执，`count` 含义未定义；本轮只使用类型是否出现。
4. 木柴/电力在 240 分钟窗口内的消耗由整体供暖与发电驱动，非单分支所致；本轮用"不低于存量一半"作近似门槛。
5. 义务 `kind` 只出现 `deliver-meal`、`supply-warehouse`；`pending-change` 的具体变更内容未给。

## 6. 封存

| 文件 | SHA256 |
|---|---|
| `review-B.jsonl` | 见 `review-B.sha256` |
| `review-B-detail.jsonl` | 见 `review-B.sha256` |

- 字段严格等于模板（`abstain`/`acceptableBranchIds`/`anonymousCaseId`/`rationale`/`schema`）；行序与模板一致；`abstain` 与空数组严格互为充要。
- 明细另存每案：`rule`、原分支/候选 ID、A 轮集合、`changedFromA`、逐分支 `statusAtDeadline`/`completedAt`/`receipts`/`personMinutes`/`after`/`delta`/授权位、`inputSha256`、`deadline`。
- 会话标识：**unavailable**；配置：DeepSeek-V4.1-Flash，CPU，单 agent，无子 agent。

## 7. 隔离声明

本轮只读 `in/G` 下 B 轮三件与自己的 `return/G`（含 A 轮结果用于对照）；未读 `key.json`、`C/real-run/`、`in/F/`、`return/F/` 及任何公共状态文件中的审阅答案；未见标签或对方结论 → **无受影响 case**，无需 `LEAK:` 标记。

## 8. 待 O

1. 收取 `return/G/{review-B.jsonl, review-B-detail.jsonl, review-B.sha256, REPORT-B.md}`，与 F 双封后解锁 key 计算一致率。
2. 若要复核 A/B 分歧，建议按第 4 节三组优先看：结构性不可履约 6 案、refuel 口径 9 案、首动作边际价值 37 案。
