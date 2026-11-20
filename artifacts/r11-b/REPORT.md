# R11-B：单条裁剪、同一投影、可恢复条件记忆

源码 `d291669`（起点 `24406c4`，R10 源码 `288a288`）。全部为 CPU 运行，0 次 GPU/模型调用。
本目录的每个数字都由已编译的产品模块产出（`dist/src/r7/...`），脚本只测量不判定。

## 1. 反例：首条记录突破预算

复现入口（原样，未改审计脚本）：

```
npm run build && node artifacts/r10-independent-audit/runtime/extra.cjs
```

| | 修复前 | 修复后 |
|---|---|---|
| budget | 64 | 64 |
| 记入记忆的单条 | 1（无条件收入） | 1（裁剪后收入） |
| 自身计数器 units | 6580 | 61 |
| 实际进入渲染的字节 | 19748 | 191 |
| `issueReproduced` | true | false |

修复后 64 单位下的实际行（`texts/oversized-single.b64.obligation-first.memory.txt`）：

```
- [player_statement] commitment_accepted 知于480 发生于480 关于npc_01,player {"occurredAt":480,"commitmentId":"cpu-c1","pointer":"large-realistic-commitment","truncated":true}
```

保留：来源 `[player_statement]`、知于/发生于两个时间、实例 `commitmentId`、可追溯指针
`pointer`（事件 id）与 `originalSha256`（未裁剪 payload 的 SHA-256）、截断标记。
64 单位下 `revision` 因差 4 字节落进裁剪记录（`level=pointer-only`, `droppedFields=["text","revision"]`）；
预算 ≥65 时修订号回到行内（`texts/oversized-single.b96...`）。这不是静默丢弃：裁剪记录逐条列出被裁字段。

## 2. 预算边界（`memory-budget.json`，42 个用例全部 `withinBudget=true`）

同一长承诺，`obligation-first`：

| budget | units | kept | block 字节 | 裁剪级别 |
|---|---|---|---|---|
| 0 | 0 | 0 | 0 | omitted |
| 8 | 0 | 0 | 0 | omitted |
| 32 | 0 | 0 | 0 | omitted |
| 64 | 61 | 1 | 182 | pointer-only |
| 96 | 65 | 1 | 195 | pointer-only（含 revision） |
| 192 | 161 | 1 | 481 | text-trim（保留正文片段） |
| 640 | 353 | 1 | 1057 | text-trim |

- 0 与负数：预算被夹到 0，记忆块为空，被省略的记录仍进 `truncatedFacts`（`level=omitted`）。
- 多条：`many-records` 用例（3 条长记录 + 6 条普通记录）在 240/640 下先给高优先级记录裁剪，
  为后续记录预留指针行，小记录不被长记录挤掉。
- raw 与 conditional：同预算、同 `unitId`、同候选集（`candidateSetHash` 相等），只有排序不同。

## 3. 估算单位与真实 tokenizer（`encoder-tokens.json`）

- 估算单位：`utf8-bytes/3-ceil/1` = `ceil(UTF-8 字节 / 3)`，`unitKind=estimated-token`，确定性、无 tokenizer。
- 真实计数：`Qwen2TokenizerFast`（`/data2/model_weights/Qwen3.8-27B`，vocab 248077，CPU，`add_special_tokens=False`），
  对同一批字节计数，32 个文本 SHA 全部与 manifest 相符。
- 结果：均值比 1.034，最大 **多出 143 token**（中文正文 + JSON 结构时估算偏低，估算不是上界）。
  `estimateIsConservative=false` 如实记录。若调用方需要“不超过 N 个真实 token”，
  应把 tokenizer 计数作为 `StepOptions.tokenCounter` 传入（预算与编码侧同时切换），
  而不是把估算叫做 token。

## 4. 同一投影（`summary.json`：6 条 step 记录 `agreesWithRender=true`）

`src/r7/memory/window.ts::projectMemory` 是唯一的窗口决策；`step.ts::visibleMemory` 是它的薄包装。
CLI（`scripts/play-sprint.ts`）、网页（`CliBridge` 驱动同一 CLI）、数据采集（`tests/r10-b/capture.ts`）、
四日 runner（`scripts/r8/playthrough.ts`、`scripts/r10/d-fourday.ts`）都经 `runStep` 取得同一投影。
`runStep` 在交给 scorer 之前断言 `renderMemoryBlock(request.memoryFacts) === projection.block`，
并把 `memoryBytes / memoryBlockSha256 / memorySegmentSha256 / memorySegmentBytes`
写成 step 证据（编码前字节）。

## 5. 四故事与恢复（`memory-stories/`，`allPassed=true`）

每个故事都含 D2 08:00 保存 → 退出 → 新进程加载，全部检查通过：

1. 听见/未听见取消：未听见者在取消前后、以及跨 D2 重启后，**输入逐字节相等**
   （`renderSha256` 与记忆块 SHA 相同）；合法转述后输入才改变。
2. 提议换源未同意：未同意前不提供改源动作，重启后仍不提供；拒绝后回到原约定并按送达回执履约。
3. 亲见补货解除旧失败：条件笔记随见证补货失效，对照臂保留陈旧教训并多付一次采集行程。
4. 两项承诺争一份资源：先取者得、后者产生真实缺货回执且不重复无效动作；取消对仅被听见者生效。

恢复对照（`restoreParts`）逐项比较：个人记录、关系/承诺视图、条件笔记依赖、经验库、
决策记忆及其**摄取游标**（`memoryCursors`）。游标在 R11 前不落盘，恢复时从 0 重扫；
现在随 `*.long-term-memory.json` 保存并在 `GameplayLoop.fromSidecars` 恢复。

### 5b. 真实四日 runner：连续 vs 拆段（`continuous-vs-restored.json`）

同一 seed 跑两遍真实的 `scripts/r8/playthrough.ts`（`--profile gospel-5.8.19 --mode reference`）：

- 连续：一个进程跑到 D4 → 318 次决策、68 次执行、4 人存活、`bleak`；
- 拆段：`--stop-after-days 2`（D2 08:00 保存）→ 新进程 `--restore` 跑到 D4 →
  136 + 190 次决策、19 + 49 次执行、4 人存活、`bleak`。

按 `(actorId, 世界时钟, requestId)` 把恢复段的每条决策与连续段的同一条配对，
**166/166 条的 `memoryBlockSha256 / memoryTokens / memoryKept / memoryDropped` 完全相同**。

（连续与拆段的决策条数不同：318 vs 136+190，`rejected` 4 vs 6；同一 seed 在**基线 `24406c4`**
上跑出同样的 318/326 与 4/6，说明这是保存/恢复的既有差异，不属于记忆投影，
留给 D/H 的权威等价比较，不在这里改。）

复跑：

```
node dist/scripts/r8/playthrough.js --profile gospel-5.8.19 --seed r11b-runner --mode reference --out /tmp/cont
node dist/scripts/r8/playthrough.js --profile gospel-5.8.19 --seed r11b-runner --mode reference --out /tmp/split --stop-after-days 2
node dist/scripts/r8/playthrough.js --profile gospel-5.8.19 --seed r11b-runner --mode reference --out /tmp/split --restore /tmp/split/state.json
node scripts/r11-b/compare-continuous.mjs /tmp/cont /tmp/split --out artifacts/r11-b/continuous-vs-restored.json
```

## 6. 复跑

```
npm run build
node artifacts/r10-independent-audit/runtime/extra.cjs            # 反例：issueReproduced=false
node dist/scripts/r11-b/memory-evidence.js --out artifacts/r11-b  # 预算矩阵 + 输入字节/SHA
python3 scripts/r11-b/tokenize_blocks.py --out artifacts/r11-b \
  --model /data2/model_weights/Qwen3.8-27B                        # 真实 tokenizer 计数
node dist/scripts/r9/memory-stories.js --out artifacts/r11-b/memory-stories
node --test dist/tests/r11-b/*.test.js                            # 9 项
```

全量：857 项，856 通过，1 失败为环境 safe-delete（`python resolution keeps an absolute path
that contains spaces`），已在基线 `24406c4` 上复现同样失败，与本次改动无关。

## 7. 限制

- 估算单位不是 tokenizer 上界（见 §3），预算数字不能直接当模型 token 读。
- 64 单位下修订号会被裁掉（差 4 字节）；如需在该预算内保留修订，只能降低估算尺度或接受更少正文。
- 四故事是 CPU 脚本决策，不代表模型长程收益；本目录不含任何 GPU 或实模结果。
