# JEV-03R1 行为对照包

在冻结的 M0 / C-seed43 / Q-seed17 上，用 96 对（192 例）最小反事实与同义对照检验
“是否真的使用上下文”。不训练、不校准、不发 valid=true、不补旧 204 条生成。

## 结构

| 路径 | 内容 |
| --- | --- |
| `data/semantic3.json` | 语义 v3（13 条规则 + 相对 v2 的差异 + 32 条 CPU 锚点） |
| `data/pairs_flip_a.py` `pairs_flip_b.py` `pairs_inv.py` | 96 对源：F1–F4 flip，I1–I2 invariant |
| `data/build.py` | 组装 192 例 + 成对门控（同文本/同类覆盖/跨轮去重） |
| `cases.jsonl` `inputs.jsonl` `gold.json` `pairs.json` `stats.json` | 封存数据 |
| `data/blind/` | 两个独立盲标会话的锚点与案例结果 |
| `store.py` | JobStore：reserve/begin/commit_result/finish/recover，结果事实在磁盘 |
| `runtime.py` | plan/caps 校验、设备边界、缓存绑定、真实计量 |
| `run.py` | 唯一新批：8+8 预热、768 特征、768 生成 |
| `assemble.py` | 逐 job 特征 → 派生 npz + binding + generations.jsonl |
| `score.py` | CPU 读出 M0/C/Q（四序分别计） |
| `cost.py` | 从逐 job 产物派生成交表（并标注 ledger 的 cost 缺陷） |
| `report.py` `verify.py` | 成对指标与只读复算 |
| `tests/test_behavior.py` | 25 项 CPU 门控（隐藏 GPU 下通过） |

## 复跑

```bash
cd research/decision-choice/jev03/behavior
python3 data/build.py                       # 192 例 + 门控
CUDA_VISIBLE_DEVICES= python3 -m unittest tests.test_behavior
D=/data3/DATA/project/project_meishijiang/.r1deps
PYTHONPATH=$D python3 run.py                # 唯一新批（1552 ops，约 24 分钟）
python3 cost.py && python3 assemble.py && python3 score.py
python3 report.py && python3 verify.py
```

`results/feature-jobs/` 与 `behavior-features.npz` 不入库（约 80 MB）；重跑会重新提特征。
