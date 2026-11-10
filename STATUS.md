# STATUS — sprint-1116

基线：`3758cb4`。集成分支：`codex/sprint-1116`（不合 main，不改已验收默认）。
本轮时间：2026-11-10 18:50 — 20:05（+08:00）。

## 执行包校验

- `handoff/20261110-sprint-1116/SHA256SUMS.txt`：19/19 OK。
- `handoff/20261110-memory-addendum/SHA256SUMS.txt`：2/2 OK。

## 工作区（真实隔离）

| 目录 | 分支 | 内容 |
| --- | --- | --- |
| `sprint-1116/integration` | `codex/sprint-1116` | 契约、E、C runtime、G/H、合并 |
| `sprint-1116/A` | `codex/s1116-A` | JEV03R1 CPU 收口 |
| `sprint-1116/C` | `codex/s1116-C` | 成本接线 + 真实证据复算 |
| `sprint-1116/D` | `codex/s1116-D` | 事件溯源记忆/关系 + 跨进程轨迹 |
| `sprint-1116/F` | `codex/s1116-F` | WorldV2 生存世界 + 规模 fixture |
| `sprint-1116/B` `E` `G` `H` | 对应分支 | 已建 worktree；本轮实现合入 integration |

**并行诚实说明**：本轮只启动了 2 个真实只读 subagent（A 数据审计、H legacy 盘点），
其余实现由主 agent 在各隔离 worktree 完成；不声称 8 个独立执行者已并行写码。
槽位/时长不足，按波次推进。

## 首 12 小时交付状态

| 项 | 状态 | 证据 |
| --- | --- | --- |
| CPU 收口（五错/16 标/双口径/成本） | 完成 | `jev04/cpu-closeout/recompute.json`、`REPORT.md` |
| 评分/校准/拒答 API + mock | 完成 | `src/decision/runtime.ts`、`jev04/calibration/calibration.py` |
| 至少一臂训练产物 | **数据门阻塞**；交可复现管线 fixture | `jev04/models/fixture-run/model-manifest.json` |
| 跨进程记忆/关系演示 | 完成 | `artifacts/sprint-1116/memory-trace/day2.json` |
| 8NPC 资源/时间/采集/吃饭/供暖闭环 | 完成 | `artifacts/sprint-1116/survival/8x4.json` |
| LEGACY-PARITY + 首个旧玩法适配 | 清单+reference 四日入口 | `legacy-parity.md`、`artifacts/sprint-1116/play/8npc-4day.json` |
| 12 条记忆 CPU 回归 | 并入测试，12/12 | `tests/memory-contract.test.ts` |

## 测试与验收

```bash
export PATH=/root/.workbuddy/binaries/node/versions/20.18.0/bin:$PATH
npm run build                       # 或 node node_modules/typescript/bin/tsc -p tsconfig.json
npm test
node dist/scripts/eval-full.js      # 独立验收
python3 -m unittest discover -s research/decision-choice/jev04/tests -p "test_*.py"
```

最近结果：`eval-full` 12 pass / 0 fail / 2 blocked：
- `g11-verify-latency`：3 条旧测试依赖未入库的 `artifacts/g11-live` 运行文件（基线即缺，非本轮回归）；
- `g11-live-resume`：watchdog 墙钟偶发（模块未改动，复跑 2/2 通过）。

## GPU / 算力

- 4×H20 97GB，当前每卡约 19–20GB 被其他进程占用；**本轮未启动任何新 GPU 进程**。
- B 因数据门未过，只跑 CPU 合成 fixture；未抢共享 GPU。
- 待门控通过后，由主 agent 统一排 27B 提特征 → 4B 训练，单协调者。

## 下一个阻塞（按关键路径）

1. A：64 锚点 + 独立复核 16 标/5 更正 + 结构化 facts/oracle；否则 4096 无法开工。
2. B：门控通过后接真实 27B/4B；当前只有 fixture。
3. G：地图/碰撞、任务、议会→命令、危机救援、结局/轮回仍为未开始。
4. H：g11 缺失证据需决定是否补 bundle（未补旧批，仅报告）。

## 纪律

- 未 push / 未合 main / 未改已验收默认。
- 旧 gold、预测、账本、checkpoint 未改；更正只做只读派生。
- 新模型仅 shadow（`jevShadowScorer`，`selectedId=null`），reference 成功不计为 JEV 成功。
