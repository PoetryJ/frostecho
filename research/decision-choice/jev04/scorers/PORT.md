# JEV-04 ScorerPort 冻结契约（owner freeze，M 实现，owner 集成）

目的：给 Python 侧校准/模型一个**实际被调用**的适配入口，替代只交定义。
目录：`research/decision-choice/jev04/scorers/`（M 独占；不改 R 的 TS runtime）。

## load_artifact（必须实现）

```python
@dataclass(frozen=True)
class ScorerIdentity:
    model: str; head: str; adapter: str; tokenizer: str; renderer: str
    task: str; k: int; policy_version: str; memory_policy_version: str

def load_artifact(path: str) -> ScorerArtifact
```

- 读取 artifact 后核对身份七元组齐全；任一缺失/未知值 → `IdentityError`（fail closed）。
- artifact 元数据必须带 `mode: "fixture" | "real"`；fixture 结果只能用于接线验证，
  报告单列，不得计为 JEV/模型成功。

## decide（必须实现，全部 fail closed）

```python
def decide(artifact: ScorerArtifact, request: ScorerRequest) -> ScorerOutput
```

拒绝（抛 `ScorerInputError`，不产生默认选择）当且仅当：
1. `len(raw_logits) != artifact.identity.k` 或 `!= request.K`（logits 数=合法候选数=policy.K）
2. 任一 logit 非 finite（NaN/±Inf）
3. `request.identity` 与 `artifact.identity` 不一致（model/head/adapter/tokenizer/
   renderer/task/k/policy_version/memory_policy_version 逐项）
4. 未知 policy / 未注册 task

输出四层分开保留，不得只给最终选择：
```python
@dataclass(frozen=True)
class ScorerOutput:
    raw_logits: list[float]
    softmax_probabilities: list[float]
    temperature_probabilities: list[float]   # 用 artifact.temperature
    utility: list[float]                     # head 输出（可为同一数组的语义别名，但字段分开）
    selected_index: int | None               # None = unavailable/abstain
```

阈值/证书只来自独立数据（原协议），不得从训练集内自估后冒充证书。

## 验收（M 交）

- 正向：fake 合法 artifact（`mode: "fixture"`）走真实 `load_artifact→decide` 全链路，
  K 匹配、logits 有限 → 输出四层完整。
- 负向：K=4 给 2 logits；任一 NaN；身份漂移（换 tokenizer）；未知 policy —— 全部抛错，
  0 执行、0 选择。当前 R2 基线反例（cost-recovery-probe 记录的 accept）必须转为拒绝。
- T27 预检：新 runID；核对服务器上**任何** 27B 权重的真实身份（目录名不做唯一依据），
  记录 commit/数据 SHA/搜索覆盖/配置完整性；权重缺失时给文件清单与续传命令。
