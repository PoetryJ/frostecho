# FrostEcho

包名 `frostecho`。展示名 FrostEcho。GitHub 仓库：PoetryJ/frostecho（https://github.com/PoetryJ/frostecho）。

G00 是最小动作执行与事件重放内核。G00 验收时包名曾是 `gospel-rebuild`（历史记录见 ACCEPTANCE.md）。G01 起包名为 `frostecho`。

G01 复用同一个 Engine，让单个 NPC 走观察 → 决策 → 解析 → `Engine.submit` → 反馈 → 下一轮。世界状态只通过 `Engine.submit` 改变。

TypeScript，测试用 `node:test`，无其他运行时依赖。

```
npm install
npm test            # 编译后自动发现 dist/tests/**/*.test.js（目录参数在 Node 22 上不能用）
npm run demo        # G00。永远离线，设置了 FROSTECHO_LLM_* 也不访问网络
npm run demo:g01    # G01 参考策略。永远离线
npm run demo:g01:live  # G01 实模型。只走 HTTP
npm run build
npm run manifest
```

`npm run demo` 和 `npm run demo:g01` 不读取模型环境变量，也不会把离线结果当成实模型成功。

实模型入口是 `npm run demo:g01:live`。它只发 HTTP，没有参考策略兜底。`FROSTECHO_LLM_URL` 必须是完整的 chat/completions URL，`FROSTECHO_LLM_MODEL` 是服务器上的模型名。两者缺一，或只有空白，退出码 **2**，不发请求。`FROSTECHO_LLM_API_KEY` 可选，只放 `Authorization` 头，不写入记录、不进提示词。

请求体固定为已验证的采样：`temperature: 0`，`max_tokens: 1024`，`stream: false`，`chat_template_kwargs: {"enable_thinking": true}`。解析只用 `choices[0].message.content`。`reasoning` / `reasoning_content` / thinking 不是动作。每一轮有超时（默认 15000ms），每轮最多 5 次决策，失败不自动重试。

连续 3 次都满足 hunger≥70 且事件重放与终态一致，退出码 **0**。任一失败、目标未达到或重放不一致，退出码 **1**。三次网络尝试都失败时不会退出 0。每次运行（含失败）各写一个目录到 `artifacts/g01-live/run-1` … `run-3`：初始状态、每步观察 / 原始模型输出 / 解析 / 命令 / 执行结果或错误、事件、终态、重放检查、耗时、请求统计、模型名和采样。`summary.json` 从这些记录读出，不另记一份内存结果。密钥和 URL 不落盘。

可选、不是必填配置：`FROSTECHO_LIVE_TIMEOUT_MS` 覆盖每轮超时；`FROSTECHO_LIVE_ARTIFACT_DIR` 换记录目录，默认 `artifacts/g01-live`。

有 SSH 隧道的机器上重跑（先让连接脚本导出 `FROSTECHO_LLM_URL` 和 `FROSTECHO_LLM_MODEL`；云端环境到不了 `http://127.0.0.1:18872`，不要在那里声称实模型成功）：

```
npm test && npm run demo && npm run demo:g01 && npm run demo:g01:live
```

`demo:g01:live` 连续实跑 3 次，并写入 `artifacts/g01-live/`。

## G01 行为

- 观察只有自己的 id、位置、hunger（饱腹，越高越饱）、当前位置的食物、可到达地点。不含其他地点的食物、其他 NPC、全局日志。
- 模型只收到观察、目标 hunger≥70、上一步反馈。调试记录不回灌。
- 解析只接受 `{"type":"move","to":"dorm"|"kitchen"}`、`{"type":"eat"}`、`{"type":"stop"}`。多余字段和非法地点都拒绝。
- `actorId` 由调用方固定。`commandId` 由 runner 按 `runId:round` 生成。`stop` 不是世界命令。
- 最多 5 次 provider 调用。非法输出占用次数，下一轮只收到错误反馈，没有单独的修复重试。
- 超时会取消请求。取消之后才到达的响应不会执行。
- 只有权威状态里 hunger≥70 才算成功。模型说出 `stop` 不算达成目标。
- 参考策略只读自己的输入：已经达到 hunger 目标就停止，人在厨房且还有食物也停止；没饱且不在厨房就去厨房；在厨房且这里有食物就吃；否则停止。

## 布局

`src/types.ts`、`src/rules.ts`、`src/engine.ts` 是 G00。`src/agent/contracts.ts` 是 G01 的观察、Provider、解析和 Runner 类型。`observation.ts` 与 `parser.ts` 是纯函数。`providers/reference.ts` 与 `providers/http.ts` 是两个适配器。`runner.ts` 是闭环。`live-record.ts` 把每次实跑写成 `artifacts/g01-live/`。G00 的设计与验收仍是 DESIGN.md、ACCEPTANCE.md。离线轨迹在 `artifacts/g01/`。
