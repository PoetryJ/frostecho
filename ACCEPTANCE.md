# G00-R1 验收报告

实现提交（代码、测试、DESIGN、运行记录）：`d4d7c583718cb6aa44dc64776fe34bcd4a3d8f68`。
本文件与 `MANIFEST.sha256` 在该提交的直接子提交中冻结。验收树以 `git rev-parse HEAD` 为准。

运行环境（`artifacts/env.txt`）：Node v22.23.4，npm 10.9.9，TypeScript 5.9.3，Linux 6.12.94+ x86_64。命令与退出码：`npm test` → 0（`artifacts/test-run.txt`），`npm run demo` → 0（`artifacts/demo-run.txt`，演示正文仍是 `artifacts/demo-output.txt`）。

Node 22 把 `node --test dist/tests/` 当成模块去加载，目录参数会失败。`npm test` 改为编译后执行 `node --test dist/tests/scenarios.test.js`。这是测试入口，不是规则变化。

## 测试结果（18/18 通过，0 失败）

原有 11 项仍通过。新增 7 项。摘要 `artifacts/test-summary.txt`，单测原始记录 `artifacts/tests/*.json`。

| 场景 | 结果 | 观测 |
|---|---|---|
| A–G、不可变性、确定性 | 通过 | 与 G00 相同：移动+吃饭、饥饿封顶、争最后一份食物的两种顺序、成功命令重复、换参数冲突、非法/前置条件、重放、恢复后重试、返回值不能反写引擎、两次 `save()` JSON 相同 |
| H `toString` / `constructor` / `proto` | 通过 | move 不抛异常；`rejected` / `UNKNOWN_ACTOR`；日志 1 条；状态与事件不变 |
| I 省略 payload vs `{}` | 通过 | 两种提交顺序都是 `COMMAND_ID_CONFLICT`；状态与事件停在第一条 |
| I-restore | 通过 | JSON 保存再 `restore` 之后，两种顺序仍是 `COMMAND_ID_CONFLICT` |
| I-null 省略 vs 显式 `null` | 通过 | 两种顺序，以及两种顺序在 JSON 往返之后，都是 `COMMAND_ID_CONFLICT`。先 `null` 时第一条仍是 `INVALID_PAYLOAD` |
| J 保持原行为 | 通过 | `{}` 重复、省略与显式 `undefined` 重复、命令字段顺序和 payload 键顺序视为相同、失败 eat 在角色已经走进厨房后重试仍是原来的 `NOT_IN_KITCHEN`，食物与 hunger 不变 |

每个测试仍跑全局检查：不变量、已接受的 eat 恰有 FoodConsumed+HungerChanged、食物守恒、重放一致。

## 修复前 / 修复后

同一组输入的对照在 `artifacts/g00-r1-before-after.md`，机器可读副本为 `artifacts/g00-r1-before.json` 与 `artifacts/g00-r1-after.json`。

- move + `toString` 或 `constructor`：修复前 TypeError，日志为空；修复后 `UNKNOWN_ACTOR` 并记日志。字面量 `proto` 修复前已经是 `UNKNOWN_ACTOR`（它不是原型键）。`__proto__` 修复前同样 TypeError，修复后同样拒绝。
- 同一 commandId 的 eat：省略 vs `{}` 修复前就已经是 `COMMAND_ID_CONFLICT`（两种顺序、含 JSON 往返）。省略 vs 显式 `null` 修复前是 `duplicate`，修复后是 `COMMAND_ID_CONFLICT`。真正的重复、键顺序、失败重试修复前后都是 `duplicate`。

## 根因和预防

1. 角色。`decide` 用 `state.npcs[actorId]` 的真值。继承来的 `toString`、`constructor`、`__proto__` 是真的，于是发出没有 id 的 `NpcMoved`，`applyEvent` 对缺失 npc 写 `location` 抛 TypeError，`submit` 没有留下拒绝记录。预防：只认 `Object.hasOwn`；未知角色返回 `UNKNOWN_ACTOR`。不要用 `in` 或括号取值的真值判断调用方给的键，也不要在 `submit` 里吞掉 TypeError 来掩盖。回归覆盖 `toString`、`constructor`、`proto`。
2. 指纹。`fingerprint` 写了 `c.payload ?? null`，`canonical` 又把对象里的 `undefined` 编成 `null`。省略 payload、显式 `undefined`、显式 `null` 变成同一字符串。eat 的校验接受前两者、拒绝 `null`，所以“同 id、不同内容”被报成 duplicate。假设“缺失被收成 `{}`”不成立：修复前 `{}` 的指纹已经和省略不同。预防：不要把缺失值收成 `null` 或 `{}`；规范化时丢掉值为 `undefined` 的键（与 `JSON.stringify` 一致），保留 `null` 和 `{}`。同 id 不同指纹，包括保存恢复之后，必须是 `COMMAND_ID_CONFLICT`。键排序后相同，以及失败命令原样重试，仍是 duplicate。

## 旧吃饭链路（只改正文档）

`resource-consumption.js` 本轮已读，不再写“文件未提供”。npc.js:766 的 `update` 调用 npc-goals.js:172–207 的 `_updateHunger`，计时结束时就地结算，不调用 `_onEatingComplete`。不足分支：剩余食物大于 0 且小于硬编码 1.5 时吃光剩余，hunger 加 `round(60 * ratio)`；食物为 0 时不调用 `consumeResource`，hunger 减 10。`npcEatAtKitchen` 只有定义（resource-consumption.js:352），resource-system.js:224 只是拆分注释，没有调用点；它自己的不足分支是另一套数字（1.8 与 +25），不能当成 766 的结算。定时共餐 `_checkMealTime` 由 resource-system.js:241 调用，又是一套（+30 / 按比例 / -5）。以上为静态分析，旧游戏未运行。细节在 DESIGN.md §1.1。

## 当前限制

- 单进程、同步、内存内；无并发写入，无存档版本迁移。去重表与日志不截断。
- 被拒绝的命令占住 commandId，条件变了也必须换新 id。这是规则，不是缺陷。
- 省略 payload 与显式 `payload: undefined` 规范化后相同。
- 旧游戏步骤 1–8 仍是上一轮对未随本轮附上的 npc-ai.js / npc-intent.js 的阅读，本轮没有重核，也没有运行旧游戏。
- 不接模型，不改包名（仍是 `gospel-rebuild`；展示名 FrostEcho），不进入 G01。

本轮只证明这两处边界和原有执行/重放仍符合 G00 的声明，不证明 NPC 更聪明或完整游戏更稳。
