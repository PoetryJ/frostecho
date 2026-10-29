# G00-R1 失败输入：修复前 / 修复后

环境：Node v22.23.4，npm 10.9.9，TypeScript 5.9.3，Linux x86_64。旧游戏未运行。

修复前记录在修代码之前对当时的 `Engine` 提交同样输入得到。修复后是同一组输入跑当前构建，见 `g00-r1-after.json`。世界状态在两组拒绝路径里都与提交前一致，事件条数不变。

## 1. move 的 actorId

命令：`{ commandId, actorId, type: "move", payload: { to: "kitchen" } }`，初始世界。

| actorId | 修复前 | 修复后 |
|---|---|---|
| `toString` | 抛 TypeError: Cannot set properties of undefined (setting 'location')。状态与事件不变，日志为空（seq 已增加但没有拒绝记录） | `rejected` / `UNKNOWN_ACTOR`，日志 1 条，状态与事件不变 |
| `constructor` | 同上 TypeError，日志为空 | 同上 `UNKNOWN_ACTOR` |
| `proto` | 已经是 `UNKNOWN_ACTOR` 并写入日志。它不是 `Object.prototype` 上的键 | 仍是 `UNKNOWN_ACTOR` |
| `__proto__`（同一根因，不在三条指定回归里） | 同上 TypeError | `UNKNOWN_ACTOR` |

## 2. 同一 commandId 的 eat，payload 是否出现

npc_a 已在 kitchen。指纹修复前：省略、显式 `undefined`、显式 `null` 都是 `{"actorId":"npc_a","payload":null,"type":"eat"}`。显式 `{}` 是 `{"payload":{}}`，与省略不同。

| 顺序 | JSON 往返后再提交第二条 | 修复前第二条 | 修复后第二条 |
|---|---|---|---|
| 省略 → `{}` | 否 / 是 | `COMMAND_ID_CONFLICT` | `COMMAND_ID_CONFLICT` |
| `{}` → 省略 | 否 / 是 | `COMMAND_ID_CONFLICT` | `COMMAND_ID_CONFLICT` |
| 省略 → `null` | 否 / 是 | `duplicate`（把已接受的 eat 再报一遍） | `COMMAND_ID_CONFLICT` |
| `null` → 省略 | 否 / 是 | `duplicate`（沿用 `INVALID_PAYLOAD`，省略的 eat 不会执行） | `COMMAND_ID_CONFLICT` |
| 省略 → 省略，`{}` → `{}`，`null` → `null` | 否 | `duplicate` | `duplicate` |
| 省略 → 显式 `undefined` | 否 | `duplicate` | `duplicate`（JSON 会丢掉两者） |

假设“指纹把缺失 payload 收成 `{}`，于是省略和 `{}` 撞车”与修复前的代码不符，已放弃。撞车的是 `payload ?? null` 加上 `canonical` 把 `undefined` 写成 `null`。

## 根因

1. 角色查找用 `state.npcs[actorId]` 的真值。普通对象能读到 `Object.prototype` 上的 `toString`、`constructor`、`__proto__`。这些值是真的，`decide` 就发出 `npcId` 为空的 `NpcMoved`。`applyEvent` 执行 `s.npcs[undefined].location = ...` 抛 TypeError。异常冒出 `submit`，拒绝没有写入日志。字面量 `proto` 读出来是 `undefined`，所以修复前就不会抛。
2. 指纹写成 `canonical({ ..., payload: c.payload ?? null })`，而 `canonical` 对对象里的 `undefined` 也输出 `null`。省略 payload、显式 `undefined`、显式 `null` 变成同一字符串。eat 的校验把省略和 `undefined` 当成空 payload（可以吃），把 `null` 当成 `INVALID_PAYLOAD`。同一 id 下“能吃”和“非法 payload”被当成重复提交。`{}` 修复前就已经和省略冲突，不是这次的失败输入。

## 预防

- 用调用方给的字符串做键时，用 `Object.hasOwn`（或 `Object.create(null)` 的表），不要用 `in`，也不要看括号取值是不是真的。回归固定 `toString`、`constructor`、`proto`。`decide` 对未知角色返回 `UNKNOWN_ACTOR`，不要靠外层吞掉 TypeError。
- 指纹不要把缺失值收成 `null` 或 `{}`。规范化 JSON 省略值为 `undefined` 的键（与 `JSON.stringify` 一致），`null` 和 `{}` 保持原样。同 id 不同指纹必须是 `COMMAND_ID_CONFLICT`，包括 JSON 保存再恢复之后。键排序后的相同内容、以及失败命令的原样重试，仍是 `duplicate`。
