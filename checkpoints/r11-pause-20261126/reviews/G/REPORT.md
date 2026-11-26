# G / 盲审 A 轮回执

- 状态：**DONE-A（已封存）**，等待 O 在 F/G 双封后投 `packet-B.jsonl`
- 角色：独立盲审 G；未开子 agent；单一会话
- 时间：2026-11-26 17:0x CST（首次轮询 11-20 13:02 时 in/G 为空，本日投递后开工）

## 1. 输入核对

| 文件 | 声明 SHA（package.json） | 实测 SHA | 结论 |
|---|---|---|---|
| `packet-A.jsonl` | f661c262d57ea951952cdee566646a17d4a148bd7c42b679bb15f1aa5ff8d2c8 | 同左 | 一致 |
| `review-template-A.jsonl` | 606e4dfc5af1a751f06dd57ea67c9b5770d6de920ecc7dbaa4a4e3af8299059d | 同左 | 一致 |
| `package.json` | — | c45a7c7798ed01b94d6dc8c74b668e0de57703f2e2af1e73c964e2e8d417b042 | 记录 |
| `INSTRUCTIONS.md` | — | 116d46cd16a2fd9f0bef720bf83ffaea3360b20249b96bc20337de46d22a1dce | 记录 |

- `packageId`：ba1ca15c0cc005543f10cb5429a44272b5991a5115c133ccee95421953bd6386；salt 947eafc4…（仅记录，未使用）
- 包内声明 `packet-B` 为 0c05c43833d0a3b967c4d66c1bd6e897244e37f5f0721aa8d97878f23a44c5fe（尚未投递，未读取）
- 案数：48；候选总数 243，与 `counts.branches=243` 一致

## 2. 隔离声明

- 只读 `in/G/`，只写 `return/G/`。
- 未读仓库代码、R10 训练/模型分数、`key.json`、`in/F/`、`packet-B.jsonl`、公共状态文件中的审阅答案。
- 全盘检索未发现 `packet-A/B` 其他副本；未接触任何标签或另一审答案 → **无受污染 case**。

## 3. 判定口径（仅用当事人可见事实）

1. 存在 `active`+`ready` 且未逾期承诺时，取唯一绑定 `commitmentId`/`commitmentRevision` 的 bridge 动作；同目的地但无回执的普通移动不视为等价。
2. 承诺已逾期时仍取承诺动作（止损），但降置信并在明细记 `insufficient_evidence`。
3. 无待办承诺时按"冬储/生存边际价值"排序：采集木柴 ＞ 进食 ＞ 休息 ＞ 等待/无关移动（食物充裕时采食、燃料充足时添柴均无边际价值）。
4. 前置不成立一律剔除并标 `illegalCandidates`：本包关键边界为 **燃料 20.00 不满足 `fuel < 20`**，9 例 `refuel` 候选据此判非法。
5. 多条等价时并列列出（不投票），分歧保留。

## 4. 结果统计

- 48 案全部给出非空可接受集合；`abstain=false` 48/48。
- 单一候选 28 案；并列 2 候选 20 案。
- 含非法候选 9 案（均为 `refuel`，`fuel=20.00`）：c-0217955cd704372c、c-6a7976e74dc34745、c-eb29c17353672681、c-639ef9dd4f2c9138、c-724d2f4f54cda69f、c-923cf3b02dc48130、c-049069731f92b909、c-fd3a63fcddc9e253、c-c6a4e0f41a4ec678。
- 低置信（≤0.45）：9 案，均为"无承诺 + 资源/选项贫乏"状态；已写明不能确定的原因。

## 5. 缺项（影响可判定性，非本人遗漏）

1. `carrying meals >= 1`（deliver 前置）在任何案中都不可直接观察，仅能由 `ready=true` 推定 → 5 例 deliver 判定均标注。
2. 目标行的 `commitmentId` 与可见 accepted 记忆中的 `commitmentId` **系统性地不一致**（例：目标 cm-020db187…，记忆 accepted 为 cm-b366f1bc…）；来源链缺口，已在各案 `facts` 中并列记录。
3. 候选未给代价/时长/成功概率，且无历史回执字段 → 只能做序数比较。
4. 包内**无绝对截止时刻 t\***，仅有承诺 `deadline=720`；第二阶段核对"同一快照与绝对截止"时以此为准或缺项单列。
5. 观察中的"仓库认知"为 0/2/3/4 份，但无仓库实际存量事实，`warehouse-supply` 条件是否满足不可验。

## 6. 封存

| 文件 | SHA256 |
|---|---|
| `review-A.jsonl` | 见 `review-A.sha256`（写入后只读） |
| `review-A-detail.jsonl` | 见 `review-A.sha256`（逐案 confidence / 非法候选 / 依据 / 不确定项，供 O 审计） |

- 两个文件均 `chmod 444`；`review-A.jsonl` 字段严格等于模板（`abstain`/`anonymousCaseId`/`expectedAcceptableCandidateIds`/`rationale`/`schema`），confidence 以 `conf=` 记在 `rationale` 尾注，结构化值在 `review-A-detail.jsonl`。
- 行序与 `review-template-A.jsonl` 一致（逐行断言通过）。
- 会话标识：**unavailable**（本 IDE 会话未暴露会话 ID）；配置：DeepSeek-V4.1-Flash，CPU，单 agent，无子 agent。

## 7. 待 O

1. 收取 `return/G/{review-A.jsonl, review-A-detail.jsonl, review-A.sha256, REPORT.md}`。
2. 与 `return/F/` 双封后投 `packet-B.jsonl`（同 packageId/salt，附分支事实、回执与共同截止 t\*）。
3. 第二阶段将保留本阶段原判；如有改变另写 `changedFrom` + 理由。
