# LEGACY-PARITY（原作功能对照）

旧作参考：`handoff/20261110-sprint-1116/legacy/`（只读，未解压覆盖）。源码 115 文件与 asar 逐字节一致；
资产 85 项。**本表是清单，不是完成声明**：`状态` 仅表示 2026-11-10 首轮集成时的实际证据。

状态口径：
- `未开始`：只有旧路径，没有新实现。
- `脚手架`：有端口/接口/纯函数，但未接入四日场景。
- `fixture`：在离线 fixture 中跑通并有测试，未做原作资产/UI 对照。
- `未验证`：代码存在但本 sprint 未跑过对应玩家操作。

| 功能 | 旧路径 | 触发/期望 | 新模块 | 测试/证据 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 8 NPC 配置 | `data/npc-configs.js` | 8 名居民身份/日程 | `src/survival/world-v2.ts`（仅 id/状态，无身份） | `tests/survival.test.ts` 8NPC | fixture |
| 8 地图 | `src/map/village-map.js`, `src/map/indoor/*` | 室外 + 7 室内 | `LocationId` 枚举 | 类型级 | 脚手架 |
| 移动/碰撞/寻路 | `src/core/game-collision.js`, `src/utils/pathfinding.js` | 玩家/NPC 寻路 | `move` 命令 | 无路径网格 | 未开始 |
| 四日天气 | `src/systems/weather-system.js` | 每日天气切换 | `WorldV2.weather` | 固定 snow | 脚手架 |
| 饱食/体力/健康/SAN | `src/npc/npc-attributes.js` | 需求衰减/恢复 | `WorldV2.npcs` | `tests/survival.test.ts`（含饱食方向守护） | fixture |
| 食物/木柴/电力 | `src/systems/resource-system.js` | 采集/消耗 | `gather`/`eat`/`work` | 8x4、16x4、32x30 fixture | fixture |
| 暖炉/供暖/燃料 | `src/systems/furnace-system.js` | 添柴、供热、熄火 | `refuel` + `furnace` | `tests/survival.test.ts` | fixture |
| 机器/建造 | `src/systems/machine-system.js` | 修机器、解锁建造 | 无 | 无 | 未开始 |
| 医疗/健康 | `src/map/indoor/medical.js` | 治疗、伤病 | `medical` 命令 | 单测（库存校验） | 脚手架 |
| 死亡 | `src/systems/death-system.js` | 健康归零 | `npc_died` 事件 | 单测 | fixture |
| 四日结局 | `src/systems/death-ending.js` | 存活/全员死亡 | `ending` 字段 | 8x4 `survived`、32x30 `survived` | fixture |
| 轮回/继承 | `src/systems/reincarnation-system.js` | 前世总结/继承 | 无 | 无 | 未开始 |
| 每日任务/分工 | `src/systems/task-system.js`, `src/core/commander.js` | 派工、完成 | `src/planning/candidates.ts`（候选层） | `tests/planning.test.ts` | 脚手架 |
| 议会/投票 | `src/systems/council-system.js` | 决议变命令 | 无 | 无 | 未开始 |
| 危机/救援 | `src/systems/event-system.js` | 事件触发、救援 | 无 | 无 | 未开始 |
| 玩家下达命令 | `src/ui/hud.js` 等 | 玩家操作 | `scripts/play-sprint.ts`（CLI 轨迹） | `artifacts/sprint-1116/play/8npc-4day.json` | fixture |
| 承诺/留饭 | 旧对话系统（CHAT_ENABLED=false） | 接受/履约/撤销 | `src/memory/store.ts` + 候选 `help` | 12 条记忆回归 | fixture |
| 记忆/关系 | `src/npc/npc.js`（最近 20 条、affinity） | 长期记忆、关系变化 | `src/memory/store.ts` | 12 条记忆回归 + 跨进程轨迹 | fixture |
| UI/HUD | `src/ui/hud.js` | 状态显示 | 无 | 无 | 未开始 |
| 音效/BGM | `src/systems/bgm-system.js` | 场景音乐 | 无 | 无 | 未开始 |
| 双语 | `src/i18n/lang-zh.js`, `lang-en.js` | 中英切换 | 无 | 无 | 未开始 |
| 存档 | `src/core/game-save.js` | 多子系统持久化 | `WorldV2` 快照 + 迁移 | 迁移单测 | 脚手架 |
| 无线电修理 | 旧版注明已移除 | - | - | 旧功能维持关闭 | 显式移除 |
| 自主 CHAT | `src/core/constants.js:124` `CHAT_ENABLED=false` | 旧版关闭 | `shad0w` 评分端口 | `tests/runtime.test.ts` | 显式关闭 |

## 已知边界

- 旧状态是运行时 JS 对象，没有独立场景/存档 JSON；本表不声称已按字段逐一迁移。
- 新旧角色命名不一致（`npc-configs.js` 的 8 人与 `asset/character/` 目录名不同），迁移前须先做身份映射，不能静默改名。
- `window.GST` 全局写状态未搬运；WorldV2 是唯一权威。
- 下一轮优先：地图/碰撞、每日任务接线、议会→命令、危机/救援、结局/轮回记录。
