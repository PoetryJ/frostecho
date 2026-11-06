# 4 个可从旧合同重现的 goal 上下文

所有上下文只使用**决策时可见**的观察字段，不含未来结果、不含其他 NPC 的属性，
因此可以用旧合同的既有接口原样重建（`check-order.ts` 就是这么做的）。

> **更正（2026-11-06）**：以上下文必须能由**真实入口**产生（`createApplicationController` → `DecideInput`）；
> 手工构造的观察只能证明 prompt 可渲染，不证明运行时会发出 goal 请求。阈值见 `GOAL_HUNGER_AT_LEAST = 70`。

## 决策时可见字段（全部来自现有接口）

| 字段 | 来源 | 说明 |
| --- | --- | --- |
| `observation.id` | `src/agent/contracts.ts:27-37` | 本 actor 自己的 id，渲染进首行 |
| `observation.location` | 同上 | `RULES.LOCATIONS = ['dorm','kitchen']`（`src/types.ts:3`） |
| `observation.hunger` | 同上 | 饱食度，渲染为 `selfSatiety` |
| `observation.foodHere` | 同上 | **仅当前位置**的食物，渲染为 `foodKitchen` |
| `observation.reachable` | 同上 | 合法移动目标集合 |
| `goalChoice.simTime` | `src/agent/contracts.ts:446-448` | 逻辑时间 |
| `goalChoice.text` | `G09_REQUEST_TEXT`（`src/negotiation/contracts.ts:51`） | 冻结请求文本 |
| `goalChoice.options` | `G09_ALLOWED_GOALS.choice`（`src/negotiation/contracts.ts:55-58`） | **唯一自变量**：`['feed_self','yield_once']` |

**宿主字段不渲染**（`GoalPromptContext` 注释 `src/negotiation/contracts.ts:194-213`）：
`arm`、`requestId`、`episodeId`、`playerId`、`playerSatiety`、`deadlineAfterRound`、
`createdAtSimTime`、`expiresAtSimTime`、`observation`（整个对象）。这一点由
`check-order.ts` 的 a2 不泄漏断言间接守护（禁止 token 列表）。

渲染出的 prompt 只有 5 行（`src/negotiation/contracts.ts:222-231`）：

```
你是 npc_a，位于<location>。当前逻辑时间 1。
你的饱食度：<hunger>。你所在位置的剩余食物：<foodHere>。
玩家说：“请把最后一份食物留给我，你先不要吃。”
请从候选目标中选择一个，只回复一个 JSON 对象，不要输出任何其他内容。
candidateGoals: ["feed_self","yield_once"]        <- 唯一随顺序变化的行
```

因此"其余 prompt 字节相同"是**结构保证**，不是人工保证。

## 四个上下文

稳定 ID 不随顺序改变；每次交换只把最后一行替换为逆序。

### C1 `ctx-kitchen-food-hunger40`

- 观察：`location=kitchen, hunger=40, foodHere=1, reachable=[dorm,kitchen]`
- 为什么合法：厨房有食物且饥饿低于目标阈值（`hungerAtLeast=90`），
  `EAT_FOOD_COST=1`、`EAT_HUNGER_RESTORE=30`（`src/types.ts:4-5`）使"吃一份"有确定收益，
  与"让给玩家"构成真实张力。
- 正序 `["feed_self","yield_once"]` / 反序 `["yield_once","feed_self"]`

### C2 `ctx-kitchen-empty-hunger40`

- 观察：`location=kitchen, hunger=40, foodHere=0, reachable=[dorm,kitchen]`
- 为什么合法：动作模板本身就把"在厨房但 foodHere=0"当作可能情形（`src/agent/providers/http.ts:104-110`
  的指导行），此时请求在当前地点无法兑现，两个候选的后果不同，是顺序效应的强候选。
- 正序 / 反序：同 C1 的两种排列。

### C3 `ctx-dorm-hunger40`

- 观察：`location=dorm, hunger=40, foodHere=0, reachable=[dorm,kitchen]`
- 为什么合法：`foodHere` 只报当前位置，宿舍必然为 0；这是 G09 真实开局常见状态。
- 正序 / 反序：同 C1。

### C4 `ctx-kitchen-food-hunger90`（边界样本，ID 保持不变）

- 观察：`location=kitchen, hunger=90, foodHere=1, reachable=[dorm,kitchen]`
- 更正（2026-11-06）：生产目标阈值是 `GOAL_HUNGER_AT_LEAST = 70`（`src/agent/contracts.ts:16`）；
  旧稿把 **90 当阈值**是倒推错误——90 是“衰减到 30 后两次 +30 吃饭”的**观测终态**。
- 因此本上下文降级为**边界样本**：hunger=90 远高于阈值 70，"最大化饱食"已不能解释选择；
  但它只能用于预检/边界说明，**不能冒充自然 goal 选择样本**。
- ID 保持 `ctx-kitchen-food-hunger90`（稳定 ID 不改），其“合法性”论证改为边界论证。
- 正序 / 反序：同 C1。

## 顺序呈现的平衡

| 上下文 | 第一次呈现 | 第二次呈现 |
| --- | --- | --- |
| C1 | 正序 | 反序 |
| C2 | 反序 | 正序 |
| C3 | 正序 | 反序 |
| C4 | 反序 | 正序 |

即 2 对正序先、2 对反序先，共 8 次（`proposedCalls=8`，未授权）。

## 固有限制（必须随结论一起报告）

候选 ID 是**语义标签**（`feed_self` 一词本身携带含义），JSON 数组换序只改变位置，
不改变标签可见性。所以本设计能回答"答案是否随顺序改变"，**不能**回答
"纯位置效应有多大"。若需要分离标签与位置，必须引入无意义标签（如 A/B），
那是**新的提示词合同**，超出本轮授权范围。
