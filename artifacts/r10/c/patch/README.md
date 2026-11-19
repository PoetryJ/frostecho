# R10 C 线交接包（对应 B 线的 B-R10.md + artifacts/r10-b + emit-evidence.mjs）

分支 `codex/r10-c`，基线 `054cab0`，HEAD `a855f5e`，tree `ea354cba0bdcec3bbb6772c44d58384ebee8dd97`。

| 交付物 | 路径 |
|---|---|
| 说明（≤40 行） | `C-R10.md` |
| 证据索引（每文件 SHA256/成本/控制项/身份阶梯） | `artifacts/r10/c/EVIDENCE.json` |
| 入库证据（43 MiB，含交付身份的 156 例真实特征） | `artifacts/r10/c/` |
| 重建索引 | `research/decision-choice/r10/write-evidence.mjs` |
| 全链路一键复跑 | `research/decision-choice/r10/run-all.sh` |
| 身份预检（10 s，不编码） | `research/decision-choice/r10/probe-identity.py --hog-mib 0` |

## 取回分支（三选一）

```bash
# 1) 直接读本机 worktree
git -C /data3/DATA/project/project_meishijiang/r10-wt/c log --oneline -1

# 2) 从 bundle 取回到任意已含 054cab0 的仓库（thin bundle，前提提交就是基线）
git fetch /data3/DATA/project/project_meishijiang/r10-wt/r10-c.bundle codex/r10-c:refs/heads/r10-c
git rev-parse r10-c^{tree}    # 应为 ea354cba0bdcec3bbb6772c44d58384ebee8dd97

# 3) 只要文本证据（不含 21 MiB 的 features.npz）
tar xzf C-R10-text-evidence.tar.gz -C <某空目录>
```

已实测：在上面第 2 步的取回结果上 `git rev-parse r10-c^{tree}` 与 worktree HEAD 树哈希一致（`ea354cba…`）。

## 与 B 线的结构对应

| B | C |
|---|---|
| `B-R10.md`（35 行） | `C-R10.md`（29 行） |
| `artifacts/r10-b/*.json` + `texts/` | `artifacts/r10/c/*`（EVIDENCE/placement-diagnosis/identity-ladder/labels/corpus/train/controls） |
| `scripts/r10-b/emit-evidence.mjs` | `research/decision-choice/r10/write-evidence.mjs`（同一职责：从产物现算索引，不手抄数字） |
| 改 `src/r7/integration/step.ts`、`src/r7/jev/scorer-client.ts` | 不改 `src`；C 的独占范围是 `research/*` 与数据 |
| `node --test dist/tests/r10-b/*.test.js` | `check-consistency.mjs`（跨产物门）+ 7 个 `refusal.json` 负控 |

## 两个必须知道的前置

1. 交付的四头绑定服务端身份 `4dae52c7…`（GPU1 混合放置，24/68 模块在卡上，10.58 s/前向）。
   跑局前先 `probe-identity.py --hog-mib 0`，输出不是 `4dae52c7…` 就会被身份契约拒绝（阶梯：24 层 `4dae52c7`、23 层 `fb54542a`、22 层 `518e60ee`）。
2. `serve_joint.py` 硬性要求 `frostecho.action-weak-experiment/1` + `labelSource=reference-imitation`；
   本语料是同快照分支标注，manifest 里显式写 `serveCompatibility{matchesSchema:false,matchesLabelSource:false}`，
   没有为了过门而改标签。要接进 serve，需放开 allowlist（`src/` 改动，不在 C 的独占范围）。
