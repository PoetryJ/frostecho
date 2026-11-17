# R9 — B（长程记忆四故事）与 D（5 类 work-proxy 真实玩法）交付

分支 `codex/r9-long-horizon`（接 `codex/r8-train-play-20261117`，未合 main）。
本轮只做 B 剩余四故事与 D 的 5 类 work-proxy；未重建工程，未改冻结对照 `3f8121a` 的 results 原始字节。
执行人数：**1 个写入会话**（O 的集成槽位串行落地 B、D 两条线，没有虚报并行 agent）。

单一执行入口（三端共用，未新增第二条计时路径）：

```
runStep → durationOf/beginWork（占用）→ advanceWorld（权威时钟）→ settleWork（结算）
        → 已提交回执（worked/gathered/…）→ 任务/承诺结案（同一条回执）
```

地点闸门只有一张表：`src/r7/domains/tasks/index.ts:requiredPlaceOf`（候选层）与
`src/survival/world-v2.ts:WORK_MODE_PLACE`（权威层）同源；`step.executeCandidate` 在入口先判。

---

## D：5 类 work-proxy 的原作语义

此前这 5 类都执行同一条 `work(minutes=40)`，产出电力并盖一个 `worked` 回执——这是占位符，不是原作玩法。
现在每条都按 `task-system.js:TASK_DETAILS` / `task-effects.js:_applyTaskEffect` 落到真实工作模式、真实工时与体力、
真实地点、真实效果；回执仍只有一种类型 `worked`（冻结回执契约不变），但带 `mode` 与真实效果字段，任务目标改为按 `mode` 校验。

| 任务（原作） | 触发 | 可选行动（本轮实现） | 成本 | 结果（已提交回执的真实字段） | 结局影响 |
|---|---|---|---|---|---|
| `COLLECT_MATERIAL` 探索废墟（`task-system.js:76-82`） | 议会/玩家派“探索/废墟/材料” | 先真实步行到 `village`（废墟点），再 `work(mode=explore)` | 60 分钟、18 体力、每 NPC 每日 3 次 | `worked{mode:explore,amount:1}`；完成 +5 San；**不产公共资源**（原作 `GATHER_RATES` 无 `explore`，`task-effects.js:115-119` 写入的 `explore` 并不在资源池） | 无直接结局通道；只有 San，限次防刷 |
| `BOOST_MORALE` 鼓舞士气（`:96-104`） | 派“安抚/鼓舞/士气” | 步行到 `dorm-a`，`work(mode=morale)` | 30 分钟、8 体力 | 同屋其他存活 NPC +36 San（0.02/s）、自己 +5 San | 抬高同屋 San，抵消户外 San 流失；不直接决定生死 |
| `COORDINATE` 统筹协调（`:109-119`） | 派“统筹/协调/组织” | 步行到 `dorm-a`，`work(mode=coordinate)` | 60 分钟、5 体力 | 同屋 +36 San（0.01/s）、自己 +5 | 同上 |
| `MAINTAIN_ORDER` 维持秩序（`:132-142`） | 派“巡逻/守夜/秩序” | 步行到 `dorm-a`，`work(mode=order)` | 60 分钟、5 体力 | 同屋 +54 San（0.015/s）、自己 +5 | 同上 |
| `SCOUT_RUINS` 废墟侦察（`:157-169`） | 派“侦察/巡查/废墟” | 先到 `village`，`work(mode=scout)` | 40 分钟、20 体力 | 每分钟 12% 掉落（原作 0.002/s）：药品 5 / 食物 8 / 电力 5，逐分钟由 `hashUnit(rngSeed, 工作区间起点, …)` 决定；自己 +5 San | **唯一有真实资源通道的 work-proxy**：药品→治疗、食物→饱食、电力→供暖，间接进入存活与结局 |

证据（`dist/tests/r9/work-proxy.test.js`，7/7）：

- 五类各自：错地点**不提供**即时行动、只提供真实步行候选；直接命令在错地点被拒且**不扣时间/体力**；
  抵达后占用真实工时，时钟到点才结算；与“同状态无占用”对照臂比较，San、体力、资源增量与上表逐项相等（±0.01）。
- `SCOUT_RUINS` 掉落跨“退出→新进程→继续”完全一致（随机身份是工作区间起点，不是世界版本）。
- 反例：电力工作回执不能结士气体力任务（`receipt_goal_mode_mismatch`）。
- 地点反例复验：`npc_05` 在仓库执行 `gather(firewood)` / `work(morale)` →
  `wrong_location: gather needs village, actor is at warehouse` / `work(morale) needs dorm-a`（均 0 资源、0 时间）。
- 成功控制：15 类任务矩阵仍 15/15 凭自己的回执结案（`scripts/r8/task-matrix.mjs`），没有因加严地点而失去资源来源。
- 四日参考局仍 D1 08:00→D4 18:00 elapsed=4920、8 存活 perfect、0 拒绝、278 条工作记录。

未证明：这 5 类仍不是原作全部细节（工坊门/室内门口二选一的门语义被收紧为“必须进对应房间”；
`SCOUT_RUINS` 的稀有物资未按原作再细分 i18n 文案）。

---

## B：长程记忆四故事

### 接口变化（只加不改）

- `session.ingestCommitmentEvent(event, {audience, source, authority, speakerId})`：
  默认仍是全队公开事件；私有取消只写进真实听者，并把 `heardBy`/`toldBy` 写进记录。
- `GameplayLoop.cancelCommitment(..., {heardBy})`：玩家当面取消只被在场者听见，来源是 `player_statement`。
- `GameplayLoop.relayCancellation(commitmentId, {tellerId, audience})`：转述者**必须自己听过**该取消
  （否则返回 `null`），听者记为“NPC 转述的玩家话”（`authority:npc`），不是新的引擎事实。
- `commitment-bridge`：只有本 actor 自己听过的终止事件才算“已结束”；没听过就按**它以为仍然有效**继续行动，
  且任何回执都不能让一条已取消的承诺变成 `fulfilled`。
- 未同意的改约（`pending-change`）：不提供新来源动作；只许“等待答复/按原约定说明”，且**不重复**已知失败的取餐。
- `visibleMemory(..., selection)`：`raw-last12`（冻结对照）与 `obligation-first`（新策略）**同条数预算**，
  新策略优先当前义务、授权变更、条件变化；两条都保留 `source/observedAt/speakerId/heardBy`。
- `R8Runtime.onWorkSettled(commandId, hook)`：占用型动作在**结算自己的回执**时通知承诺桥，
  履约不再依赖“意图”（此前 `deliver` 占用 15 分钟后承诺不会结案——真实缺口，已修）。

### 四故事结果（`node dist/scripts/r9/memory-stories.js --out artifacts/r9/memory-stories`）

| 故事 | 干扰事件 | D2 退出→新进程 | 最终结果 | 关键计数 |
|---|---|---|---|---|
| 1 已听见/未听见取消 | 公共补货 + 6 条闲聊 | 状态指纹一致；仍是“未听见” | 承诺 `cancelled`，未履约 | 听见者 0 候选；未听见者先做 2 个真实动作（move/withdraw 回执），转述后 0 候选、0 新回执；非法转述（没听过者）返回 `null` |
| 2 改源未同意 | 玩家“仓库已补货”传闻 + 8 条闲聊 | 未答复提案与 revision 完整恢复 | 拒绝后回到原约定，凭 `npc_01-r8-58:meal_delivered:60` 履约 | 未同意期间 0 次改源采集；同意对照臂才出现 gather 且真实执行 1 次 |
| 3 旧失败条件解除 | 补货前后共 45 条闲聊 | 条件笔记跨重启存活 | 条件臂直接取餐并履约 | 条件臂适用笔记只剩“缺货已解除”；未条件化臂仍保留过期缺货教训，代价是 30 分钟白跑 |
| 4 两承诺争一份饭 | 6 条闲聊 | 两承诺与缺货证据一致恢复 | 赢家 `fulfilled`（`npc_01-r8-57:meal_delivered:59`），输家 `cancelled` | `out_of_stock` 回执 1 次；之后重复无效动作 0 次；输家改约保持未同意，最终由玩家当面取消 |

记忆臂对照（同 12 条预算，`artifacts/r9/memory-stories/*/story*.json`）：

- 故事 3：`raw-last12` 12 条全是 `team_chatter`，**看不到** `stock_restocked`；新策略同一 12 条内含
  `out_of_stock` 与 `stock_restocked`，因此“条件已变”进入模型输入。
- 故事 2/4：新策略保留 `commitment_accepted`/`commitment_change_proposed`/`out_of_stock`/`commitment_fulfilled`，
  原始臂只剩 `r8_actor`/`heating_settled` 等无关记录。
- 诚实边界：这是**同条数**预算，不是同字节；义务记录携带更多证据字段，字节约 +20%
  （例：故事 3 3510→4214 B）。没有用真实 tokenizer 计量，也没有据此宣称成本等价。

---

## 复跑命令

```bash
export PATH=$HOME/.local/node22/bin:$PATH
npm run build
node --test dist/tests/r9/work-proxy.test.js dist/tests/r9/memory-invariants.test.js   # 11/11
node dist/scripts/r9/memory-stories.js --out artifacts/r9/memory-stories               # 四故事，失败即 exit 1
node scripts/r8/task-matrix.mjs "$PWD"                                                 # 15/15
node dist/scripts/r8/verify.js --out artifacts/r9/verify-bd                             # 10 pass / 0 fail / 1 blocked
node dist/scripts/r8/playthrough.js --profile gospel-5.8.19 --seed r9-d --mode reference --out <dir>
```

- 全量 `npm test`：**791 项，790 通过，1 失败**；唯一失败仍是既有环境问题
  （safe-delete shim 无法写 `/.Trash-1003`），未改断言。
- `verify` 唯一 `blocked` 项仍是 `jev-preflight`：本机 transformers 无法构建 `qwen3_5`
  架构且没有可用权重，**本轮 0 次模型前向、0 GPU 卡时**；不把规则脚本结果说成模型能力。

## 交付物与 git 写入受阻（如实记录）

- 工作树在 `FrostEcho-r9`（分支 `codex/r9-long-horizon`，HEAD `1a6807cd`，未合 main）。
- **`git add/commit` 被拒**：共享对象库 `/data3/DATA/project/project_meishijiang/FrostEcho/.git/objects`
  为 `root:root drwxr-xr-x`，当前用户 `user_00` 无写权限，报
  `insufficient permission for adding an object to repository database`。
  所以本轮**没有新增提交**，只交出可复现的工作树 + 补丁包；不谎称已提交新分支。
- 代码补丁：`artifacts/r9/patch/r9-b-d-tracked.patch`
  （11 个已跟踪文件，1052 行，SHA256 `a0fd283ddd7df6023d29a7b5aea9643953870851bc1a07bce20d06cae8b31186`）。
- 新增文件：`artifacts/r9/patch/r9-b-d-new-files.tar.gz`（本文件 + `scripts/r9/` + `tests/r9/`）。
- 改动清单：`artifacts/r9/patch/r9-status.txt`。
- 证据：`artifacts/r9/memory-stories/`（四故事 + D2 存档 7 件套 + steps，summary SHA256
  `dc1a77a9de3d7141e730f9b0dd274914877b8264604e3321a43bce56ae1212a4`）；
  `artifacts/r9/verify-bd/verify.json`（SHA256 `09fc8600915016651025ff2fafe2282fecdc0184aab41b6fbb4e92205528552d`）。
- 所有者（或有写权限的用户）建分支提交：

```bash
cd /data3/DATA/project/project_meishijiang/FrostEcho-r9
git apply artifacts/r9/patch/r9-b-d-tracked.patch
tar xzf artifacts/r9/patch/r9-b-d-new-files.tar.gz
git add -A src scripts tests R9-B-D-DELIVERY.md artifacts/r9/memory-stories artifacts/r9/patch
git commit -m "feat(r9): five real work-proxy classes and four long-horizon memory stories"
```

## 未证明 / 已知缺口

1. 本轮 B、D 全部是 CPU 规则/脚本决策；真实 27B 头未参与，模型对记忆/工作模式的收益未测。
2. `raw-last12` 与新策略只对齐“条数”，未对齐 token；未做真实 encoder 下的长度分布测量。
3. 四个故事只用 `npc_01`/`npc_02` 作主角；8 人社会扩散只在四日整局里体现，故事级未重复。
4. 门语义收紧为“必须进入对应室内房间”，原作允许“站在门口或室内”，本轮的窄化会多走一段路。
5. `src/r7/integration/step-goal-binding.test.ts` 的前两条仍是上一轮占用契约之前的“立即生效”假设，
   属既有失败，未在本轮修复；`dist/tests` 下的门禁不受影响。
6. A 的整点分段仍会把“在整点之间结束的工作”结算推迟到下一个边界；本轮未改，四日结果按此计时。
7. 本轮按指示只做 5 类 work-proxy（加地点闸门），**未**在本轮新增危机/协商的网页录制、
   未改 `public/r7` 展示层；网页门仍用既有 `r8-step` 链路通过（8 条记录、8 条多候选、8 条 applied），
   不把这次结果说成“完整原作玩法已交付”。
