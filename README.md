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

请求体固定为已验证的采样：`temperature: 0`，`max_tokens: 1024`，`stream: false`。`chat_template_kwargs.enable_thinking` 默认 **true**。`FROSTECHO_LLM_THINKING=false` 只关闭这一次请求的 thinking，不改变生产默认。解析只用 `choices[0].message.content`。`reasoning` / `reasoning_content` / thinking 不是动作。人已经在厨房、这里食物是 0、饥饿还没到目标时，提示词要求回复 `{"type":"stop"}`，不要为了看不见的远处食物来回移动。实模型每一轮超时默认 **30000ms**（`FROSTECHO_LIVE_TIMEOUT_MS` 可覆盖），避免大约 15 秒的 thinking 被当成超时。每轮最多 5 次决策，失败不自动重试。连接失败会记下不含密钥的 cause code 和 message，而不是只有一句 `network error`。

连续 3 次都满足 hunger≥70 且事件重放与终态一致，并且元数据里的目标和调用次数与落盘的终态、步骤一致，退出码 **0**。任一失败、目标未达到、重放不一致或元数据对不上，退出码 **1**。三次网络尝试都失败时不会退出 0。每次启动新建 `artifacts/g01-live/batch-<时间>-<随机>/`，里面是 `run-1` … `run-3` 和 `summary.json`。已有批次和目录里的其他文件不会被删除。步骤里会记下实际请求体、响应内容、HTTP 状态、usage、耗时和错误；密钥和 URL 不落盘。`summary.json` 用终态重算 hunger≥70，并用步骤条数核对调用次数，不信任内存里的另一份结果。

可选、不是必填配置：`FROSTECHO_LIVE_TIMEOUT_MS` 覆盖每轮超时；`FROSTECHO_LIVE_ARTIFACT_DIR` 换记录根目录，默认 `artifacts/g01-live`。

有 SSH 隧道的 Windows 机器上重跑（先 source 连接脚本，让它导出 `FROSTECHO_LLM_URL` 和 `FROSTECHO_LLM_MODEL`；云端环境到不了 `http://127.0.0.1:18872`，不要在那里声称实模型成功）：

```
npm test
npm run eval:g02
```

`npm run eval:g02` 串行打 18 局（S1/S2/S3 × 3 次 × thinking 开/关），最多 90 次请求，决策超时默认 30000ms，失败不重试，不改共享 GPU 的采样。生产默认仍是 thinking=true。结果在 `artifacts/g02/<batch>/`。没有那两个环境变量时退出码 **2**。只想检查夹具、不打实模型：`npm run eval:g02 -- --fixture`（这不是实模型成功）。模型进程被停掉之后要先在 Windows 上把服务拉起来，这里不会重启共享 GPU。

`npm run demo:g01:live` 仍是 G01 的三次实跑，写入一个新的 `artifacts/g01-live/batch-*/`。

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

`src/types.ts`、`src/rules.ts`、`src/engine.ts` 是 G00。`src/agent/contracts.ts` 是观察、Provider、解析、Runner 和会话类型。`observation.ts` 与 `parser.ts` 是纯函数。`providers/reference.ts` 与 `providers/http.ts` 是两个适配器。`runner.ts` 里 `createAgentSession` / `stepAgent` 是同一条执行路径，`runAgent` 只是把它跑到结束。`live-record.ts` 把每次实跑写成一个新的 `artifacts/g01-live/batch-*/`。`src/play/` 是 G02：玩家命令、S1–S3 和 `eval:g02`。G00 的设计与验收仍是 DESIGN.md、ACCEPTANCE.md。离线轨迹在 `artifacts/g01/`。

## G02 玩家干预

玩家只控制 `npc_b`。模型只控制 `npc_a`。世界仍然只通过 `Engine.submit` 改变。

```
npm run play
npm run play -- --live
```

默认是参考策略，不读 `FROSTECHO_LLM_*`，也不会把离线结果当成实模型。`--live` 才发 HTTP。命令：`player move dorm`、`player move kitchen`、`player eat`、`npc step`、`status`、`quit`。玩家命令在 NPC 等待模型时仍然提交。`quit` 不再接受新命令，等当前这一步走完它自己的超时，然后把整局（玩家命令、NPC 命令、事件）写到 `artifacts/g02/play/<batch>/`。

命令号是 `<batch>:player:<seq>` 和 `<batch>:npc:<seq>`。G01 的 `<runId>:<round>` 不变。

固定场景（夹具里必须通过；`scenarioPass` 和 A 的 `goalReached` 分开记，stop 不算达成目标）：

| 场景 | 发生的事 | A 的 hunger | scenarioPass | goalReached |
|---|---|---|---|---|
| S1 | 无人干预，A 移动并吃掉食物 | 40→70 | 通过 | true |
| S2 | 在 A 下一次观察之前，B 移动并吃掉最后一份；A 看到没有食物后停止 | 保持 40 | 通过 | false |
| S3 | A 已观察到厨房食物为 1、还没提交 eat；B 先吃掉；A 的 eat 得到 `NO_FOOD`，下一步拿到新观察和拒绝反馈后停止 | 保持 40 | 通过 | false |

`npm run eval:g02` 对这三组各打 3 次，thinking 开和关各打一遍，共 18 局。两组用同一个模型、同一份提示词、同一套世界规则和同一种干预顺序，只改 `enable_thinking`。摘要里有场景通过率、请求数、耗时、token，以及 transport / parse / decide / execute 计数。失败局留在 `artifacts/g02/<batch>/games/`。云端夹具结果不能当作 qwen 实跑。
