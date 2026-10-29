# G00 验收报告

实现提交（代码+测试+产物）：`a0220f8ce4424383115e5bf0b8708e49ffc25089`（本文件与 MANIFEST.sha256 在其后的文档提交中加入；最终 HEAD 见 `git log`）。
运行环境：Node v20.19.2, TypeScript 5（box Linux 上运行；同一树已复制到 Windows 工作目录）。命令：`npm test`。

## 测试结果（11/11 通过，0 失败；原始记录 artifacts/tests/*.json，摘要 artifacts/test-summary.txt）
| 场景 | 结果 | 具体观测 |
|---|---|---|
| A 移动+吃饭 | 通过 | npc_a dorm→kitchen；kitchen.food 1→0；hunger 40→70；事件 NpcMoved, FoodConsumed, HungerChanged |
| A2 上限 | 通过 | hunger 90 吃后 =100（clamp） |
| B a 先 | 通过 | npc_a accepted (40→70)；npc_b rejected NO_FOOD，hunger 保持 20；food=0 |
| B b 先 | 通过 | npc_b accepted (20→50)；npc_a rejected NO_FOOD，hunger 保持 40；food=0 |
| C 重复成功命令 | 通过 | 连续两次重提 → status=duplicate，eventIds 与原相同 (e2,e3)，originalSeq=2；状态与事件数不变 |
| D 同 id 换参数 | 通过 | move d1 {to:kitchen} 已接受后，d1 {to:dorm} 与 d1 eat 均 rejected COMMAND_ID_CONFLICT；状态不变 |
| E 非法/前置条件 | 通过 | UNKNOWN_ACTOR(ghost)、UNKNOWN_ACTION(fly)、INVALID_PAYLOAD(to=moon / payload=null / eat{amount:5})、INVALID_COMMAND(缺 commandId)、ALREADY_THERE、NOT_IN_KITCHEN、NO_FOOD；每次前后状态 deepEqual、事件数不变 |
| F 重放 | 通过 | 7 条命令（含拒绝与重复）后，replay(initial, events) deepEqual 实时状态；npc_b 最终 {dorm, 50} |
| G 恢复后重试 | 通过 | JSON 往返保存→restore；重提 g2 eat → duplicate；g2 换参数 → CONFLICT；事件仍 3 条；新命令 g3 得到 e4（序号连续无冲突） |
| 不可变性 | 通过 | 修改 getState/getEvents/getLog 返回值及提交后修改输入对象，均不影响引擎；篡改存档 state → restore 抛 corrupt |
| 确定性 | 通过 | 相同命令两次运行 save() JSON 完全相同（无墙钟） |

每个测试都执行全局检查：资源非负整数、hunger∈[0,100]、每个已接受 eat 恰有 FoodConsumed+HungerChanged、消费事件数 = 初始-最终食物、重放一致。

## G 保存的去重信息
SaveData 包含：`initialState`、`events`、`state`（仅交叉校验）、`seq`、`eventCounter`、`log`，以及 **`processed: { [commandId]: { fingerprint, result } }`**——fingerprint 为 actorId/type/payload 的规范化 JSON，result 为原 CommandResult。恢复后据此识别 duplicate/conflict；seq/eventCounter 保证新 id 不碰撞。

## 实现期间的错误
首次编译与测试即全部通过，未遇到失败；因此没有"错误→根因→修复"记录可报告（如实说明，未编造）。
已知设计取舍：被拒绝的命令也进入去重表，同 id 重试返回原拒绝，调用方须换新 commandId 才能在条件变化后重试。

## 当前限制
- 单进程、同步、内存内；无并发写入、无持久化文件格式版本迁移。
- 去重表与日志无限增长，无压缩/快照。
- 旧代码 resource-consumption.js / hunger 恢复调用方未提供，链路第 10、11 步为推断。
- 旧游戏的问题均为代码阅读推断，未实际运行复现。
- deepseek-harness 参考文档抓取为空，未借鉴。

## 下一轮建议（未实施）
1. 事件 schema 版本号与升级器；2. 快照+截断事件日志；3. 去重表 TTL/窗口；4. 将旧游戏吃饭多入口统一改为发 Command 的对照实验；5. 时间推进作为显式命令（tick），hunger 衰减成为事件。

本轮结果仅支持声明范围内的执行与重放正确性，不证明 NPC 更聪明或完整游戏更稳定。
