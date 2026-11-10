# JEV-02R1 选择性拒答返工包

修正 JEV-02 验收缺口：单一 policy 接线、预测阶段 gold 访问阻断、按 `operation` 计费、
族隔离的新校准/盲测数据、独立盲标、温度与单次/双次一致性策略对照。

**本轮结论：两条冻结策略均 `valid=false`（不可用）。** 详见 `results/REPORT.md`。

## 目录

| 路径 | 内容 |
| --- | --- |
| `contract.json` | 冻结的语义合同与预注册策略/门槛（写数据前冻结） |
| `data/` | 三份数据、封存 gold、盲标结果、分歧与裁决、数据卡 `card.md` |
| `policies/` | `single_pass.json`、`reverse_pair_consensus.json`（唯一策略工件） |
| `results/` | REPORT、final、原始分数、逐条预测、校准表、延迟、统计、解封记录 |
| `evidence/` | ledger `jobs.jsonl`、模型身份、封存/阻断记录、CLI 真实运行输出 |
| `tests/test_r1.py` | 28 项 CPU 测试（ledger/policy/decide/封存/指标/选模/数据门控） |
| `audit/` | 只读核验器说明 |
| `verify.py` | 只读重算：从原始分数+policy+gold 复算并比对，不写盘 |

## 环境

- Python 3.11、torch 2.8.0（共享 env `siren3`）。
- **该检查点 `model_type=qwen3_5`，共享 env 的 transformers 4.51.3 无法加载。**
  本轮把 `transformers==5.22.2` + `tokenizers/huggingface_hub/safetensors/regex/typer` 装进隔离目录
  `/data3/DATA/project/project_meishijiang/.r1deps`，仅以 `PYTHONPATH` 前置使用，未修改共享环境：

```bash
D=/data3/DATA/project/project_meishijiang/.r1deps
python3 -m pip install --no-deps --target $D transformers==5.22.2
python3 -m pip install --target $D "tokenizers>=0.23.1,<0.24" "huggingface_hub>=1.31,<3" \
  "safetensors>=0.8" "regex>=2025.10.22" typer pyyaml tqdm packaging filelock "jinja2>=3.1.6"
```

## 复跑（按序）

```bash
cd research/decision-choice/jev02r1
python3 build_data.py            # 从 data/*.part*.jsonl 重建三份数据（parts 已清理则跳过）
python3 datagate.py --write      # 数据门控：规模/族隔离/去重/泄漏，应 passes=true
python3 adjudicate_r1.py         # 盲标 vs 作者标签一致性 + 裁决，写回 cal 与 test gold
python3 -m unittest tests.test_r1

PYTHONPATH=$D python3 extract.py --splits cal-temperature cal-policy test --generate test --tag a2
python3 cal_scores.py            # CPU 读出 cal 分数（冻结头）
python3 fit.py                   # 温度 T1/Tfit 对照 + 固定网格选 tau + 写 policy
python3 predict_batch.py         # 封存 test 预测 + gold 阻断正向对照
PYTHONPATH=$D python3 latency.py --cases 32
python3 unseal.py --attempt 1    # 单次解封；再次运行必须 --attempt N --reason "..."
python3 report_stats.py
python3 verify.py                # 只读核验，应 passes=true
```

`extract.py` 的 job id 带 `--tag`：失败/中断的尝试保留在自己的 id 下并照常计费，重跑不会静默复用作废额度。

## 复跑注意

- `data/*.part*.jsonl` 只在首次构建时需要；`build_data.py` 在 parts 缺失时会从已组装文件重建派生文件。
- `cache/` 不入库（约 100 MB 隐藏状态）；复跑会重新提特征，成本见 REPORT §5。
- 判定策略可用性只看 `policies/*.json` 的 `valid` 与 `tau`；不要用 `results/final.json.arms` 里的诊断曲线替代。
