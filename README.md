# FrostEcho

包名 `frostecho`。展示名 FrostEcho。GitHub 仓库：PoetryJ/frostecho（https://github.com/PoetryJ/frostecho）。

G00 是最小动作执行与事件重放内核。G00 验收时包名曾是 `gospel-rebuild`（历史记录见 ACCEPTANCE.md）。G01 起包名为 `frostecho`。

G01 复用同一个 Engine，让单个 NPC 走观察 → 决策 → 解析 → `Engine.submit` → 反馈 → 下一轮。世界状态只通过 `Engine.submit` 改变。

TypeScript，测试用 `node:test`，无其他运行时依赖。

```
npm install
npm test            # 编译后自动发现 dist/tests/**/*.test.js（目录参数在 Node 22 上不能用）
npm run demo        # G00 内核演示
npm run demo:g01    # G01 闭环。离线用参考策略。真实模型未配齐时标明 REAL MODEL UNVERIFIED，不用离线结果顶替
npm run build
npm run manifest
```

真实模型是可选的。`FROSTECHO_LLM_URL` 必须是完整的 chat/completions URL，`FROSTECHO_LLM_MODEL` 是服务器上的模型名，`FROSTECHO_LLM_API_KEY` 可选，只从环境变量读取，不写入记录：

```
FROSTECHO_LLM_URL=https://host/v1/chat/completions \
FROSTECHO_LLM_MODEL=server-model-name \
FROSTECHO_LLM_API_KEY=optional \
npm run demo:g01
```

配齐后演示会实跑 3 次，并写出成功次数、请求次数、延迟和失败原因。

## G01 行为

- 观察只有自己的 id、位置、hunger（饱腹，越高越饱）、当前位置的食物、可到达地点。不含其他地点的食物、其他 NPC、全局日志。
- 模型只收到观察、目标 hunger≥70、上一步反馈。调试记录不回灌。
- 解析只接受 `{"type":"move","to":"dorm"|"kitchen"}`、`{"type":"eat"}`、`{"type":"stop"}`。多余字段和非法地点都拒绝。
- `actorId` 由调用方固定。`commandId` 由 runner 按 `runId:round` 生成。`stop` 不是世界命令。
- 最多 5 次 provider 调用。非法输出占用次数，下一轮只收到错误反馈，没有单独的修复重试。
- 超时会取消请求。取消之后才到达的响应不会执行。
- 只有权威状态里 hunger≥70 才算成功。模型说出 `stop` 不算达成目标。
- 参考策略只读自己的输入：没饱且不在厨房就去厨房；在厨房且这里有食物就吃；否则停止。

## 布局

`src/types.ts`、`src/rules.ts`、`src/engine.ts` 是 G00。`src/agent/contracts.ts` 是 G01 的观察、Provider、解析和 Runner 类型。`observation.ts` 与 `parser.ts` 是纯函数。`providers/reference.ts` 与 `providers/http.ts` 是两个适配器。`runner.ts` 是闭环。G00 的设计与验收仍是 DESIGN.md、ACCEPTANCE.md。原始轨迹在 `artifacts/g01/`。
