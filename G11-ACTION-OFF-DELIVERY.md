# G11 action-off 完整玩法交付（2026-11-09）

源码提交 `d4cfbd2`（分支 `codex/g11-action-off`，基线 `9812692`）；运行记录在 `artifacts/g11-action-off/`。
包内：`handoff/20261109-g11-action-off/`（bundle、证据 tar、SHA、D-ACTION-OFF-AUDIT.md、
BUILD-IDENTITY.txt、evidence/）。

## 汇报（10 行）

1. 离线门控：全量 565/565（0 fail/0 skip，含新增 16 项）、`g11-demo` exit 0、旧 G11 批只读 `evidenceOk=true/complete=false/exit1`、旧先导重算仍 3816。
2. 预检：`/health`、`/v1/models` 200，qwen3.8-27b，config/tokenizer 哈希匹配；0 smoke POST。
3. 计划：`prepare --action-thinking off` 冻结 `actionThinking=false`、`promptVersion=g11-needs-resume/1`、8 次/每场 4；run 不可改计划。
4. 真实 POST：**8/8**（goal 2 次 on、action 6 次 off），全 200、无失败/超时/未知 usage、无重试。
5. 场景：W1 **fulfilled**（玩家先吃）、W2 **expired**（未吃）；均为 wait 存档退出→新进程恢复。
6. 恢复后续：两场普通需求各吃 2 次，npc_a 30→60→90、厨房 0、simTime 1，阈值仍 70。
7. 成本：2276 token（goal 462、action 1814）；reasoning 188，全部来自 goal；action reasoning 0。
8. 耗时：整批墙钟 26.3s；goal 起始间隔 7.12/6.99s；action 1.49/1.52s（进程内）、2.23/2.43s（跨存档重启，含开销）；4 进程 9.0/12.7/9.1/12.8s。
9. 校验：`verify` evidenceOk/complete/ok=true，issues=expectations=[]，W1/W2 各 4、slotHashOk=true，ledger↔wire 8/8；改 wire 或被拒的 load 均 0 POST。
10. 局限：每场景仅 1 次，不给 p95/长期质量/因果；G11 wire 不存 per-request latency（第 8 行为间隔/墙钟）；未 push/merge、未进 G12。

## 证据

| 内容 | 位置 |
| --- | --- |
| 冻结计划 / run-start | `artifacts/g11-action-off/g11-action-off-20261109-r1/` |
| 4 个 run 记录 / 2 个跨进程槽 / scene 文件 | 同上 `w1/`、`w2/`、`scene-W1/W2.json` |
| 账本（8/8） | `artifacts/g11-action-off/campaign-approved8-20261109-r1/campaign.json` |
| 只读 verify | `handoff/20261109-g11-action-off/evidence/verify.log` |
| 独立逐条审计 | `handoff/20261109-g11-action-off/D-ACTION-OFF-AUDIT.md`、`evidence/audit.json` |
| 预检/构建身份 | `evidence/preflight-manual.json`、`BUILD-IDENTITY.txt` |

## 复跑（离线）

```bash
export PATH=/root/.workbuddy/binaries/node/versions/20.18.0/bin:$PATH
cd /data3/DATA/project/project_meishijiang/FrostEcho
npm test
node scripts/g11-demo.mjs
node dist/scripts/g11-live.js verify \
  --batch artifacts/g11-action-off/g11-action-off-20261109-r1 \
  --campaign artifacts/g11-action-off/campaign-approved8-20261109-r1   # expect exit 0
```

真实 8 次额度已用尽（8/8）；本包不 push/merge、不进入 G12，停在 Codex 验收。
