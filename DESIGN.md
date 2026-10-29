# G00 设计说明 —— 最小动作执行与事件重放内核

## 1. 旧游戏吃饭链路（证据来自 extracted/ 下 5 个文件）

标注：**[事实]** = 代码中直接可见；**[推断]** = 根据命名/注释推测，代码不在本次提供的文件中；**[复现]** = 实际运行复现过（本轮无，旧游戏未运行）。

| 步骤 | 文件:行 | 函数 | 说明 |
|---|---|---|---|
| 1 LLM 返回 action | npc-ai.js:1719,1769 | prompt 模板 | [事实] 提示词允许 `type: go_to|rest|eat`，eat 目标 kitchen_door |
| 2 生成意图 | npc-ai.js:1906 → npc-intent.js:93 | `_createIntentFromAction` | [事实] id=`${npc.id}_intent_${seq}`，seq 为 NPC 本地计数；`createdAt` 为 gameTime，缺失时退回 `Date.now()`（:111） |
| 3 提交 | npc-ai.js:1917 → npc-intent.js:140 | `_submitIntent` | [事实] low 优先级不提交，只写记忆（npc-ai.js:1918-1921） |
| 4 仲裁 | npc-intent.js:115-138 | `_arbitrateIntent` | [事实] 只检查死亡/聊天/行为锁/覆盖状态，返回 execute/pending/reject；**不检查食物、位置** |
| 5 执行 | npc-intent.js:177 → npc-ai.js:342 | `_executeAction` | [事实] npc-ai.js:468-472 hunger<50 时 go_to kitchen_door 被**改写**为 eat；:512-521 eat 设 `_hungerOverride/_hungerTarget` 并导航 |
| 6 到达 | npc-ai.js:964, 1015-1019 | `_onActionArrived` | [事实] eat 到达后调用 `_startEating`；:1026-1031 go_to 到 kitchen 且饥饿也会自动吃 |
| 7 开始吃 | npc-eating.js:105-121 | `_startEating` | [事实] 加行为锁，`isEating=true`，`eatingTimer=20`；**此处不扣食物、不改 hunger** |
| 8 饥饿覆盖路径 | npc-eating.js:157-247, 47-63, 229 | `_triggerHungerBehavior` 等 | [事实] 另一条独立入口也会调用 `_startEating`；:160 仅以 `food>0` 作为触发门槛 |
| 9 扣食物 | resource-system.js:207-216 | `consumeResource` | [事实] 不足时 `actual=min(current,amount)`，静默部分消费，返回实际值，不报错 |
| 10 吃饭扣食物 | resource-system.js:225 注释 | `npcEatAtKitchen` | [推断] 注释写"已拆分到 resource-consumption.js"，该文件未提供，无法给出行号 |
| 11 恢复 hunger | npc-eating.js:134 注释"恢复饱腹值已在调用前处理" | `_onEatingComplete` 调用方 | [推断] 计时结束时在别处恢复 hunger，调用方不在提供文件中 |
| 12 存档 | game-save.js:12-42, resource-system.js:408-420 | `save` / `serialize` | [事实] 只存状态快照到 localStorage，含 `savedAt: Date.now()`；**无命令/事件记录，无去重信息** |

据此可见的结构性问题（[推断]，未复现）：
- 意图→执行之间没有"验证资源前置条件"的统一点；食物检查分散在触发时（food>0）和最终扣减时（min 截断），两者之间有 20 秒吃饭时长，两个 NPC 可能都通过 `food>0` 而开始吃最后一份。
- `consumeResource` 静默部分消费，吃饭"成功"与"吃到多少"不一致，无拒绝原因。
- 有多个入口（LLM eat、go_to 改写、到达兜底、饥饿覆盖）都能触发吃饭，顺序不可记录。
- 无 commandId 去重：存档恢复后无法判断某意图是否已生效。
- 逻辑依赖 `Date.now()` 回退，重放不确定。

## 2. 经典问题与本轮处理

- **命令 vs 事实**：`Command` 只是愿望；只有引擎 `decide()` 通过后生成的 `WorldEvent` 才是事实。重放只读事件。
- **资源修改原子性**：`decide` 为纯函数，先算出全部事件与新状态，校验不变量（食物非负整数、hunger∈[0,100]），通过后一次性替换状态并追加事件；任何失败都不提交。单线程顺序处理 = 每条命令一个事务。
- **重试幂等性**：`processed[commandId] = {fingerprint, result}`。同 id 同内容 → `duplicate`，返回原结果与原 eventIds，无新效果；同 id 不同内容（actorId/type/payload 的规范化 JSON 不同）→ `COMMAND_ID_CONFLICT`。被拒绝的命令也记入，重试仍返回原拒绝（不会因世界变化变成成功）。
- **状态重放**：`replay(initial, events)` 只调用 `applyEvent` reducer，不调用 `decide`/执行器/模型。`Engine.restore` 用重放重建状态并与保存的 state 交叉校验，不一致即判存档损坏。

## 3. 四类数据

- **WorldState**：权威状态（tick、npcs{location,hunger}、food{dorm,kitchen}）。对外只给深拷贝，内部深冻结。
- **Command**：`{commandId, actorId, type, payload}`，角色希望做的事。
- **CommandResult**：`{commandId, seq, status: accepted|rejected|duplicate, reason?, detail?, eventIds, originalSeq?}`。
- **WorldEvent**：`NpcMoved | FoodConsumed | HungerChanged`，带 `eventId, seq, commandId`，关联到命令。

全局记录（log + events）用于引擎与调试，不作为 NPC 默认上下文。本轮不实现观察/记忆。

## 4. 实验常量（明确标注，不宣称还原旧平衡）
`EAT_FOOD_COST=1`，`EAT_HUNGER_RESTORE=30`，hunger clamp `0..100`，地点 `dorm/kitchen`，厨房初始食物 1；npc_a 初始 hunger 40，npc_b 20，均在 dorm。（旧游戏为 food 130、每人每餐 1.8，见 resource-system.js:18,38。）

## 5. 方法参考（访问日期 2026-10-29）
- Martin Fowler, *Event Sourcing* (martinfowler.com/eaaDev/EventSourcing.html)：借鉴"状态 = 初始状态 + 事件序列"与"事件重放重建状态"。本轮未实现 Fowler 文中的外部系统网关、逆向事件。（基于已知内容，本次未重新抓取页面全文。）
- deepseek-harness `docs/architecture.md`、`packages/core/tools/README.md`：2026-10-29 抓取 architecture.md 返回空内容（0 行）；未能获得可借鉴内容，故**未借鉴**。仅保留"工具/动作调用须经统一入口验证"这一通用思路，不归因于该仓库。
