# R10 C 线大件证据（未入库，保留在本机）

完整证据根：`/data3/DATA/project/project_meishijiang/artifacts/r10/c`。`EVIDENCE.json` 里每个小件都有 SHA256；本文件只列不进 git 的大件。

| 目录 | 大小 | 在 git 里? | 说明 |
|---|---|---|---|
| `capture/snapshots` | 825 MiB | 否 | 每例可恢复快照 |
| `labels-primary/branches` | 825 MiB | 否 | 逐分支 rollout 状态副本 |
| `labels-strict/branches` | 825 MiB | 否 | 逐分支 rollout 状态副本 |
| `enc/parts` | 20 MiB | 否 | 分批特征分片 |

快照与分支副本不入库的原因：312 例 × 2.6 MiB ≈ 827 MiB（PlaySession 含 8 人完整记忆），分支目录是同一快照的逐候选副本（830 MiB）。
它们可由 `capture-cases.mjs` 与 `label-branches.mjs` 确定性重建；本轮已验证：
重新采集后 312 例的 `requestJson`/`renderedTextSha256` 全等，抽检 40 个快照文件逐字节相同（`cmp` 全等）。

入库的大件（29 MiB）：`capture/cases.jsonl`、`labels-*/labels.jsonl`、`corpus-*/corpus.jsonl`、
`enc/features.npz`（21 MiB，156 例 × 候选的真实 27B 特征，`featureIdentityHash=57bc3f50…`）、`enc/records.jsonl`。
