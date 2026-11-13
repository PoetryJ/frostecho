# JEV-03 读出位置对照包

同一冻结 27B 主干、同一 renderer/候选描述、同一份特征缓存，比较三种读出：

| 臂 | 结构 | 参数量 | 监督 |
| --- | --- | --- | --- |
| M0 | `z_i = w·LN(h_i)`，JEV-02 M1 冻结权重 | 5,120 | 旧数据（不重训） |
| C | `z_i = w·LN(h_i)`，新训练 | 5,120 | 新 384 例 × 四序 |
| Q | `z = W·LN(hq)`，W[4,5120] | 20,480 | 新 384 例 × 四序 |

C 与 M0 是同一函数类，因此 C−M0 只衡量新监督；Q 同时改变读出位置（最终前缀 token）与参数化，
不能据此把差异单独归因于结构。本轮不拟合温度/阈值，不产出 `valid=true` 策略。

## 目录

| 路径 | 内容 |
| --- | --- |
| `data/contract.json` | semantic-contract/2（13 条规则 + 与 R1 的差异）与 8 个句型定义 |
| `data/boundary.jsonl` | 32 条公开语义边界样例 |
| `data/train|dev|test.jsonl` | 384/128/256 例，96 个来源组，每类 2 例/组 |
| `data/*.inputs.jsonl` | 无标签输入（caseId/groupId/context/playerText） |
| `data/test.gold.json` | 封存 gold（自校验哈希） |
| `data/challenge.jsonl` | 未计分挑战例（转述当下意见，两种读法） |
| `data/blind/` | 五个独立盲标会话的原始紧凑编码与映射 |
| `data/adjudication.json` | 逐条分歧与裁决理由 |
| `heads/j3heads.py` | C/Q 两个头与参数计数 |
| `train.py` / `seal.py` | 六次 CPU 训练；dev 选定与封存（在任何 test 分数之前） |
| `extract.py` | 单进程 27B 特征缓存 + JSON 生成 + 固定计时 |
| `predict.py` / `unseal.py` | 封存打分（gold 行为阻断）与一次解封 |
| `report.py` / `verify.py` | 报告生成与只读复算 |
| `tests/test_j3.py` | 26 项 CPU 测试（另有 R1 28 项仍全过） |

## 复跑

```bash
cd research/decision-choice/jev03
python3 data/build.py                       # 768 例 + 门控（族/类/去重/跨轮重合）
python3 -m unittest tests.test_j3           # 26 项
cd ../jev02r1 && python3 -m unittest tests.test_r1 && cd -

D=/data3/DATA/project/project_meishijiang/.r1deps    # transformers 5.22.2 隔离目录
PYTHONPATH=$D python3 extract.py --splits train dev --tag p1     # 8 预热 + 2048 前向
python3 train.py                                                 # 6 次 CPU 训练
python3 seal.py                                                  # dev 选定 + 封存
PYTHONPATH=$D python3 extract.py --splits test --json --timing --tag p2
python3 predict.py                                               # gold 阻断 + 逐条分数
python3 unseal.py --attempt 1                                    # 只解封一次
python3 report.py && python3 verify.py                           # 报告与只读复算
```

`cache/` 不入库；重跑会重新提特征（成本见 `results/REPORT.md`）。
