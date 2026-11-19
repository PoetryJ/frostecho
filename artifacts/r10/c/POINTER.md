# R10 C 线证据说明

完整证据根：`/data3/DATA/project/project_meishijiang/artifacts/r10/c`（本目录是入库子集）。
`EVIDENCE.json` 给出每个文件的大小与 SHA256、来源 HEAD/tree、成本、控制项与身份阶梯。

## 入库（约 42 MiB）
`capture/cases.jsonl`（312 条真实 request）、`labels-primary/labels.jsonl`（2039 条分支终局事实）、
`labels-{base,discharge}/labels.jsonl`、`corpus-*/corpus.jsonl`、
`enc-gpu1/{features.npz,records.jsonl,metadata.json,qualification.json}`（交付身份 `4dae52c7`，156 例 × 候选的真实 27B 特征）、
`enc/{metadata.json,records.jsonl,...}`（all-CPU 身份 `57bc3f50` 的元数据，权重已作废，仅留档）、
`train-base-gpu1/`、`train-discharge-gpu1/`（交付四头 + 曲线 + dev 决策 + test 一次）、
`train-primary/`、`train-discharge/`（作废身份的四头，`EVIDENCE.json` 标 `superseded`）、
`placement-diagnosis.json`、`identity-ladder.json`、`identity-probes/`、`controls/`、`tests/`。

## 未入库（本机保留，可确定性重建）
| 目录 | 大小 | 说明 |
|---|---|---|
| `capture/snapshots` | 825 MiB | 每例可恢复快照（PlaySession 含 8 人完整记忆） |
| `labels-primary/branches` | 825 MiB | 逐分支 rollout 的状态副本 |
| `labels-strict/branches` | 825 MiB | focal-idle 变体的状态副本 |
| `enc-gpu1/parts` | 20 MiB | 分批特征分片（`features.npz` 已入库，分片仅供 resume） |

重建：`capture-cases.mjs`（64 s）+ `label-branches.mjs`（约 17 min，CPU）。
本轮已验证重采集的 312 例 `requestJson`/`renderedTextSha256` 全等、抽检 40 个快照 `cmp` 逐字节相同。

## 两个身份（不要混用）
- 服务端（GPU1 空闲，`--placement auto`）：`4dae52c7…`，24/68 模块在卡上、10.58 s/前向 → **交付的四头绑这个**。
- 2026-11-18 那次（GPU1 仅剩 4000 MiB）：`57bc3f50…`，全 CPU、36.7 s/前向 → 四头已作废。
- 阶梯：24 层 `4dae52c7`、23 层 `fb54542a`、22 层 `518e60ee`；跑局前用 `probe-identity.py --hog-mib 0` 验一次。

## 一致性门
`node research/decision-choice/r10/check-consistency.mjs --root artifacts/r10/c`
本 checkout 未含快照，故 `snapshotsChecked=0`（`consistency-checkout.json`）；对完整归档运行为 `snapshotsChecked=156`、0 问题（`consistency.json`）。
