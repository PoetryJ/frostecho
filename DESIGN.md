# G00 设计说明 —— 最小动作执行与事件重放内核

## 1. 旧游戏吃饭链路（静态分析，未运行旧游戏）

本轮重读五个摘录：npc.js、npc-goals.js、npc-eating.js、resource-consumption.js、resource-system.js。

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
| 9 扣食物函数 | resource-system.js:207-216 | `consumeResource` | [事实·定义] `actual=min(current,amount)`，库存写成 `max(0,current-amount)`，账本加 actual，返回 actual，不抛错。个人吃饭结算并不靠这次静默截断表达“不够”（见 1.1） |
| 10 食堂个人进食 | resource-consumption.js:352-396；resource-system.js:224 仅注释 | `npcEatAtKitchen` | [事实·定义，五个摘录中无调用点] 文件已提供。224 行是拆分注释，不是调用。不足分支不能当成 766 的结算 |
| 11 吃饭计时结束并改 hunger | npc.js:766 → npc-goals.js:172-207 | `NPC.update` → `_updateHunger` | [事实·调用点] 饱腹增减写在这里。`_onEatingComplete`（npc-eating.js:127）只有定义和一句注释，摘录中无调用，本路径不调用它 |
| 12 存档 | game-save.js:12-42（上轮，本轮未重开）, resource-system.js:408-420 | `save` / `serialize` | [事实] `serialize` 只存资源快照；上轮所见存档含 `savedAt: Date.now()`，**无命令/事件记录，无去重信息** |

步骤 1–8 沿用上一轮对 npc-ai.js / npc-intent.js 的阅读，本轮五个摘录未包含那两个文件，没有重核。以下 1.1 只依据本轮摘录，**未运行旧游戏**。

### 1.1 从 npc.js:766 往下的实际结算

[事实] `NPC.update`（npc.js:597）在 766 行调用 `this._updateHunger(dt, game)`。注释 760–763 说明先 `_updateSleepState` 再饥饿，避免“饿醒立刻又睡”的循环。

[事实] `_updateHunger` 定义在 npc-goals.js:140。`this.isEating` 时（172）`eatingTimer -= dt`；`eatingTimer <= 0`（174–208）就地结算，然后 `return`。这里**没有**调用 `_onEatingComplete`。食物常量是函数内硬编码 `foodPerMeal = 1.5`，不是 resource-system.js:38 的 `1.8`。

结算三分（都是 [事实]，写在 npc-goals.js:178–201）：

| 条件 | 食物 | hunger | 其它 |
|---|---|---|---|
| `rs2.food >= 1.5` | `consumeResource('food', 1.5, 个人进食)` | `+60`，再 `min(100, …)` | stamina/sanity/health 另有加成；心情“吃饱” |
| `rs2.food > 0` 且 `< 1.5`（**不足**） | `avail = rs2.food`，`ratio = avail/1.5`，`consumeResource('food', avail, 个人进食(不足))`，把剩余一次吃光 | `+Math.round(60 * ratio)`，再封顶 100 | stamina/sanity/health 按 ratio 缩小；心情“没吃够”。不拒绝、不中断收尾 |
| 否则（没有食物，或没有 resourceSystem） | **不调用** `consumeResource` | `-10`，再 `max(0, …)` | 心情沮丧 |

收尾（202–206，[事实]）清 `_hungerOverride/_hungerTarget` 和两只计时器，`_hungerTriggerCooldown = 20`，`_releaseBehaviorLock('eating')`，并把日程索引打回 -1。这些清理是内联的，不是 `_onEatingComplete`。

和另外两段代码分开，避免把“定义”当成“766 的调用点”：

- [事实·定义+注释，无调用点] `proto._onEatingComplete`（npc-eating.js:127–152）。134 行注释写“恢复饱腹值已在调用前处理”。五个摘录里搜不到调用。不能用这句注释推断结算发生在别的未提供文件里；766 这条链的结算就是上面的三分。
- [事实·定义，无调用点] `proto.npcEatAtKitchen`（resource-consumption.js:352–396）。门槛：死亡、`hunger>=70`、同一 NPC 300000ms 内（`Date.now()`）不重复。`needed` 取 `RESOURCE_CONSUMPTION.foodPerMealPerPerson`（resource-system.js:38 为 **1.8**）。足量：扣 1.8，hunger **+25**，返回 true。不足（`food>0`）：吃光剩余，hunger `+round(25*ratio)`，返回 true。为零：打事件日志，返回 false，**不改 hunger**。resource-system.js:224 只有注释 `[已拆分到 resource-consumption.js] npcEatAtKitchen`。
- [事实·另一条调用链，不是 766] `ResourceSystem.update`（resource-system.js:241）调用 `_checkMealTime`（定义在 resource-consumption.js:131–217）。定时共餐：足量 hunger **+30**；不足（182–201）按 `food/totalNeeded` 比例，hunger `+round(30*ratio)` 并吃光；为零（202–207）hunger **-5**。`totalNeeded` 还乘难度和天气食物乘数。这是全员开饭，不是个人 `eatingTimer` 走完。

[事实] `_startEating`（npc-eating.js:105–121）只加行为锁、`isEating=true`、`eatingTimer=20`，**不扣食物、不改 hunger**。它的调用点在本文件：`_checkEatingArrival`（63）和 `_triggerHungerBehavior`（229）。`_triggerHungerBehavior`（160–163）在 `food>0` 时才开始；食物检查和 20 秒后的结算不在同一处。谁调用 `_checkEatingArrival`，五个摘录里没有（npc.js:676 只在注释里提到这个名字）。

[推断，未运行] 两个 NPC 可以都在 `food>0` 时开始吃，计时结束才在 `_updateHunger` 里抢剩余食物；后结算的那个走进不足或断粮分支。更新顺序决定谁吃满，摘录里看不到 NPC 列表的遍历顺序。

据此可见的结构性问题（未运行旧游戏；多 NPC 交错为 [推断]）：
- 没有统一的资源前置校验。`_startEating` 不看食物；`_triggerHungerBehavior` 只要求 `food>0`；扣减发生在约 20 秒后的 `_updateHunger`。两个 NPC 可能都开始吃最后一份，后结算的进入 1.1 的不足或断粮分支。
- 三条结算对“不够”各写各的，都没有拒绝原因：个人计时结束按比例加 hunger 或 -10；定时共餐按比例或 -5；`npcEatAtKitchen` 只有定义，食物为零时返回 false 且不改 hunger。`consumeResource` 自身仍会静默截断。
- 有多个入口（LLM eat、go_to 改写、到达兜底、饥饿覆盖）都能触发吃饭，顺序不可记录。
- 无 commandId 去重：存档恢复后无法判断某意图是否已生效。
- 逻辑依赖 `Date.now()` 回退（意图时间、食堂进食冷却），重放不确定。

## 2. 经典问题与本轮处理

- **命令 vs 事实**：`Command` 只是愿望；只有引擎 `decide()` 通过后生成的 `WorldEvent` 才是事实。重放只读事件。
- **角色存在性**：`decide` 用 `Object.hasOwn(state.npcs, actorId)` 判断角色，不用括号取值的真值。`toString`、`constructor`、`__proto__` 等继承属性是真值，接着会发出缺少 id 的 `NpcMoved`，`applyEvent` 对不存在的 npc 写 `location` 并抛 TypeError。这些 id 返回 `UNKNOWN_ACTOR`，写入日志，世界状态和事件都不变。字面量 `proto` 不是原型上的键。
- **资源修改原子性**：`decide` 为纯函数，先算出全部事件与新状态，校验不变量（食物非负整数、hunger∈[0,100]），通过后一次性替换状态并追加事件；任何失败都不提交。单线程顺序处理 = 每条命令一个事务。校验失败必须返回拒绝，不能把异常抛出 `submit`。
- **重试幂等性**：`processed[commandId] = {fingerprint, result}`。指纹是 actorId、type、payload 的规范化 JSON：对象键排序；值为 `undefined` 的键省略（与 `JSON.stringify` 相同），所以省略 payload 和显式 `payload: undefined` 是同一内容。`null`、`{}` 和省略三者互不相同，禁止把缺失 payload 收成 `null` 或 `{}`。同 id 同指纹 → `duplicate`，返回原结果与原 eventIds，无新效果；同 id 不同指纹 → `COMMAND_ID_CONFLICT`。eat 的校验接受省略和 `{}`、拒绝 `null`，但指纹比“校验是否通过”更细：同 id 下省略 vs `{}`、省略 vs `null` 都是冲突。被拒绝的命令也记入，原样重试仍返回原拒绝（不会因世界变化变成成功）。只改字段顺序、规范化结果相同的，视为 duplicate。
- **状态重放**：`replay(initial, events)` 只调用 `applyEvent` reducer，不调用 `decide`/执行器/模型。`Engine.restore` 用重放重建状态并与保存的 state 交叉校验，不一致即判存档损坏。去重表里存的是指纹字符串，JSON 往返后仍按该字符串区分 duplicate 与 conflict。

## 3. 四类数据

- **WorldState**：权威状态（tick、npcs{location,hunger}、food{dorm,kitchen}）。对外只给深拷贝，内部深冻结。
- **Command**：`{commandId, actorId, type, payload}`，角色希望做的事。
- **CommandResult**：`{commandId, seq, status: accepted|rejected|duplicate, reason?, detail?, eventIds, originalSeq?}`。
- **WorldEvent**：`NpcMoved | FoodConsumed | HungerChanged`，带 `eventId, seq, commandId`，关联到命令。

全局记录（log + events）用于引擎与调试，不作为 NPC 默认上下文。本轮不实现观察/记忆。

## 4. 实验常量（明确标注，不宣称还原旧平衡）
`EAT_FOOD_COST=1`，`EAT_HUNGER_RESTORE=30`，hunger clamp `0..100`，地点 `dorm/kitchen`，厨房初始食物 1；npc_a 初始 hunger 40，npc_b 20，均在 dorm。旧游戏初始 food=130、常量 `foodPerMealPerPerson=1.8`（resource-system.js:18,38），用于定时共餐和 `npcEatAtKitchen` 的定义。npc.js:766 的个人结算另写死 1.5 与 hunger+60（见 1.1）。本内核的 1 与 30 不对应其中任何一条。

## 5. 方法参考（访问日期 2026-10-29）
- Martin Fowler, *Event Sourcing* (martinfowler.com/eaaDev/EventSourcing.html)：借鉴"状态 = 初始状态 + 事件序列"与"事件重放重建状态"。本轮未实现 Fowler 文中的外部系统网关、逆向事件。（基于已知内容，本次未重新抓取页面全文。）
- deepseek-harness `docs/architecture.md`、`packages/core/tools/README.md`：2026-10-29 抓取 architecture.md 返回空内容（0 行）；未能获得可借鉴内容，故**未借鉴**。仅保留"工具/动作调用须经统一入口验证"这一通用思路，不归因于该仓库。
