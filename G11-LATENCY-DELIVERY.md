# G11 延迟先导交付（2026-11-09）— `offline_ready`

源码提交 `5a7f5d0`（分支 `codex/g11-latency-pilot`，基线 `0f9143d`）。
包内文件：`handoff/20261106-g11-latency-pilot/`（bundle、证据 tar、DELIVERY-SHA256SUMS.txt、
PLAN-8CALLS.txt、B-ACCEPTANCE.md、D-ANALYSIS.md、BUILD-IDENTITY.txt、evidence/）。

## 汇报（8 行）

1. 测试：定向 15/15，全量 549/549（0 fail / 0 skip），`g11-demo` exit 0。
2. 旧批只读核验：exit 1，`evidenceOk=true / complete=false / issues=[]`，源哈希未变。
3. 真实 POST：**0/8**（未花费）；预检 `GET /health`、`/v1/models` 均 connection refused。
4. 配对：**0/4**（8 条全部 `not_run`），无可报告的延迟/动作差异。
5. 成本：已知 token 0、未知 0、未运行 8；账本未创建，旧批剩余 2 次未使用。
6. 停止原因：服务不可达；按协议不重启服务、不换端点，交 `offline_ready`。
7. 固定目录 `artifacts/g11-latency/g11-latency-20261106-r1` 未创建（避免半成品，不删除/不改名）。
8. 局限：`temperature=0` 不保证位级一致；0 调用下不能声称任何 on/off 效应或 p95。

## 原始证据

| 证据 | 文件 |
| --- | --- |
| 补丁/定向测试 | `evidence/b-independent-targeted.log`、`B-ACCEPTANCE.md` |
| 全量测试（549） | `evidence/full-test.log` |
| 离线演示 | `evidence/g11-demo.log` |
| 旧批只读核验 | `evidence/old-batch-verify.log`、`evidence/source-hashes.txt` |
| 报告计算 fake 验证 | `evidence/d-fake-check.log`、`D-ANALYSIS.md` |
| 服务预检（0 POST） | `evidence/preflight-20261109.log` |
| 构建/运行身份 | `BUILD-IDENTITY.txt`（HEAD、干净源码、node 20.18.0、tsc 5.9.3、dist/lock 哈希） |

## 复跑（离线，零 POST）

```bash
export PATH=/root/.workbuddy/binaries/node/versions/20.18.0/bin:$PATH
cd /data3/DATA/project/project_meishijiang/FrostEcho
npm run build && node --test dist/tests/g11-verify-latency.test.js
node scripts/g11-demo.mjs
node dist/scripts/g11-live.js verify --batch artifacts/g11-live/g11-live-20261105-r1 \
  --campaign artifacts/g11-live/campaign-approved8 --http x --model x   # expect exit 1
```

真实 8 次仍待服务在同一端点恢复后、由负责人确认再执行（`PLAN-8CALLS.txt`）；
本包不重启服务、不 push、不 merge、不进入 G12。
