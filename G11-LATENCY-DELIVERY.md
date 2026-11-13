# G11 延迟先导交付（2026-11-09）— 8/8 已完成

源码提交 `5a7f5d0`（补丁）+ `3ad74dc`（离线交付）；真实运行在 HEAD `3ad74dc`、`src/scripts/tests` 干净时执行。
运行产物：`artifacts/g11-latency/g11-latency-20261106-r1`（唯一目录，未删未改名）。
包内：`handoff/20261106-g11-latency-pilot/`（bundle、证据 tar、DELIVERY-SHA256SUMS.txt、live-summary.json、
PLAN-8CALLS.txt、B-ACCEPTANCE.md、D-ANALYSIS.md、D-LIVE-ANALYSIS.md、BUILD-IDENTITY.txt、evidence/）。

## 汇报（8 行）

1. 测试：定向 15/15、全量 549/549（0 fail/0 skip）、`g11-demo` exit 0、旧批只读 verify exit 1（evidenceOk=true/complete=false）。
2. 预检：`/health`、`/v1/models` 均 200，model=qwen3.8-27b，config/tokenizer 哈希与冻结值一致。
3. 真实 POST：**8/8**，全部 HTTP 200、finish=stop、timeout 0、unknown usage 0。
4. 配对：**4/4 完整配对**；动作 4/4 相同（Y#1/Y#2=wait，N#1/N#2=eat）。
5. 耗时：off 3705/732 ms（Y）、382/378 ms（N）；on 21718/21719 ms（Y）、11826/11770 ms（N）。
6. Token：off 1254、on 2562，已知合计 **3816**（无未知）；reasoning on 1152、off 0。
7. 成本：账本 8/8，无失败/重试/补批；旧批剩 2 次未用；未提交任何游戏世界命令。
8. 局限：每格仅 2 次，不给 p95/长期质量/因果根因；单步合法 ≠ 整局成功；temperature=0 非位级确定。

## 原始证据

| 证据 | 文件 |
| --- | --- |
| 8 次原始 attempt（请求/响应/usage/hash） | `artifacts/.../attempts/att-0001..0008.json` |
| 账本与运行起点 | `artifacts/.../campaign/campaign.json`、`run-start.json` |
| 预检（0 POST） | `artifacts/.../preflight.json`、`preflight-health.*`、`preflight-models.*` |
| 工具汇总 | `handoff/.../live-summary.json` |
| D 独立逐条重建 | `handoff/.../D-LIVE-ANALYSIS.md` |
| 离线门控 | `handoff/.../B-ACCEPTANCE.md`、`evidence/full-test.log`、`evidence/g11-demo.log`、`evidence/old-batch-verify.log` |
| 身份 | `handoff/.../BUILD-IDENTITY.txt`、`run-start.json`（HEAD 3ad74dc、干净） |

## 复跑/阅读命令

```bash
export PATH=/root/.workbuddy/binaries/node/versions/20.18.0/bin:$PATH
cd /data3/DATA/project/project_meishijiang/FrostEcho
node dist/scripts/g11-latency-probe.js summarize \
  --dir artifacts/g11-latency/g11-latency-20261106-r1 \
  --out /tmp/recheck-summary.json        # 只读重算，不发送请求
```

离线门控可复跑：`npm run build`、`node --test dist/tests/g11-verify-latency.test.js`、
`node scripts/g11-demo.mjs`、旧批 `g11-live.js verify`（预期 exit 1）。
本包不 push/merge、不进入 G12；剩余行为判断留给 Codex 验收与负责人。
