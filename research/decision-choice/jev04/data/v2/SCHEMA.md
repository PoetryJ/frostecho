# JEV-04 数据 v2 冻结 schema（owner freeze，D 实现，H 审查）

基线：v1 锚点 64 例保留在 `data/anchors/`（不动）。v2 全部落在 `data/v2/`。

## 案例记录（JSONL，一行一例）

```json
{
  "schema": "frostecho.jev04.case/2",
  "caseId": "v2-<familyId>-<ordinal>",
  "version": 2,
  "task": "promise_cancel | reference_resolution | info_asymmetry | goal_tradeoff",
  "K": 2,
  "candidates": [
    { "id": "a", "text": "...", "params": { "...": "..." } }
  ],
  "acceptableSet": ["a"],
  "polarity": "acceptable | reject-all",
  "narrative": { "text": "..." },
  "facts": [ { "id": "f1", "kind": "...", "content": { } } ],
  "oracle": {
    "rule": "命名规则ID（可复算，不写自由文本结论）",
    "decision": "a",
    "requires": ["f1"],
    "rationale": "引用 facts 的短说明"
  },
  "hiddenTruth": { "...": "仅 oracle 可见的事实" },
  "familyId": "gQ07",
  "sourceGroup": "gQ07",
  "generatorSkeleton": "skeleton-id@rev",
  "reviewLog": [
    { "session": "v2-s1", "labeler": "...", "acceptableSet": ["a"], "comment": "..." }
  ],
  "provenance": { "fromV1": "gQ07-A", "change": "oracle fix + narrative regenerated" }
}
```

## 冻结规则

1. `narrative.text` 与 `facts` 必须由同一事件源程序生成；改 facts 必须重新生成叙述，
   不允许手改一边。`hiddenTruth` 不进入叙述。
2. `oracle.rule` 是可复算规则 ID；语义冲突（如 gQ07 明确取消被标留饭）必须修 oracle
   或改事件源，禁止保留错误标签。
3. `acceptableSet` 必须是候选 ID 的子集且非空（`polarity="reject-all"` 时为空集并显式声明）。
4. 家族与独立性：`familyId` = 真实生成家族（同一骨架+同一参数改写）；`sourceGroup` 用于
   train/dev 隔离，先分组再分份；同 `sourceGroup` 不得跨 split。改名/重排序不算新家族。
5. 每例记录 `reviewLog`；v1 迁移例的 `provenance.fromV1` 指回旧 caseId，旧文件不改。
6. gold（acceptableSet/oracle）不进入模型输入字段（narrative/facts/candidates 之外）。
7. 分歧处理：每条 v1 分歧（69 条）在 `adjudication.jsonl` 有裁决记录：
   `{caseId, dispute, ruling, rulingBy, action: keep|revise|challenge|drop, newCaseId?}`；
   修订例需重新盲审后才可进 train/dev。
