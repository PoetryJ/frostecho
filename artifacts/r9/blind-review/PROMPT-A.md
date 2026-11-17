# 盲审任务 A（独立审阅者 A）

你是一位独立审阅者。你要判断：在**只能看到决策前信息**的条件下，哪些行动是**可以接受的**。

## 你拿到的文件

`packet/review-cases.jsonl`，每行一个案子，字段如下：

```json
{"schema":"frostecho.r9.blind-review-item/1",
 "caseId":"c-xxxxxxxxxxxx",
 "inputSha256":"…",
 "visible":{
   "observationText":"第几天/第几分钟、天气、公共资源、炉火、自身状态、仓库认知",
   "question":"现在最该做什么？",
   "candidates":[{"id":"a-…","text":"候选描述 {参数} [动作类] 前提:…"}],
   "memory":[{"kind":"…","learnedAt":时间,"source":"engine|player_statement|inference","detail":{…}}],
   "goals":[{"taskId":"…","type":"…"}]
 }}
```

## 你要做什么

对每一条，给出**可接受行动集合**（acceptable set）：

- 可接受 = 一个称职的当事人在这个可见信息下，**可以正当地选择**的行动。
- 不是"最好的那一个"，而是所有站得住脚的选择。通常 1–4 个，可以更多。
- 判断依据只能是 `visible` 里的内容：他的身体状态、公共资源、他**自己**看到的仓库认知、他记得的事、他背着的任务。
- **不要**因为某个行动"可能失败"就排除它：缺货、路远、要花时间，都属于可以尝试的代价。
- **要**排除在当前可见信息下明显不可能或明显错误的行动，例如：资源明确为 0 却要消耗它、人不在那个地点却做只能在那个地点做的事、任务已被取消却继续做它、与已知事实直接冲突。
- 若你认为信息不足以下判断，把 `acceptableIds` 设为 `[]`，并把 `insufficientInfo` 设为 `true`，在 `reason` 里说明缺什么。

## 你看不到（也不允许推测）

- 当事人最后实际做了什么（没有 selectedId）
- 这件事的后果、回执、成功或失败
- 案子的来源类别、陷阱类型、分区
- 另一位审阅者的任何输出
- 任何外部资料、历史对话、代码仓库

如果你在文件里看到上述内容，说明包发错了，请停止并报告，不要继续猜。

## 输出格式（严格）

输出一个 JSONL 文件 `review-A.jsonl`，每行一条，**顺序与输入一致**，字段固定：

```json
{"caseId":"c-xxxxxxxxxxxx","inputSha256":"<原样抄>","acceptableIds":["a-…"],"insufficientInfo":false,"reason":"一句话，说明为什么这些可接受/为什么排除某个"}
```

硬性要求：

1. `caseId` 与 `inputSha256` 必须与输入逐字一致；不要新增、合并或遗漏任何一条（共 48 条）。
2. `acceptableIds` 只能来自该案 `visible.candidates[].id`，不得编造。
3. 每条都要有 `reason`，不超过 60 字。
4. 只输出 JSONL，不要 Markdown 代码块、不要解释性前言或结语。
5. 全程独立完成；不要与其他审阅者、也不要与任何"标准答案"比对。

## 一条虚构示例（不是真实数据）

输入（节选）：资源 食物 4、药品 0；自身健康 40；候选：`a-1` 吃药、`a-2` 去采集、`a-3` 休息、`a-4` 等待。

输出：

```json
{"caseId":"c-example00000","inputSha256":"<原样>","acceptableIds":["a-2","a-3","a-4"],"insufficientInfo":false,"reason":"药品为0，吃药不可执行；采集、休息、等待都站得住"}
```

开始前请确认：你只使用了 `visible` 字段，没有参考任何后果或他人意见。
