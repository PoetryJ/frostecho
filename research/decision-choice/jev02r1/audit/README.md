# 只读核验

本目录不再放独立脚本：核验器就是仓库内的两个只读入口。

1. `../verify.py` — 从 `results/test-scores.jsonl`（原始 logits）、`policies/*.json` 与
   `data/test.gold.json` 重新计算每个 base 的决策，与封存的 `results/test-predictions-*.jsonl`
   逐条比对，并核对 unseal-record 里的每个哈希。**不写任何文件**，失败返回 1。
2. `../datagate.py` — 数据门控（规模、族隔离、玩家原文去重、prompt 泄漏），只读。

核验通过输出：`{"failures": [], "passes": true}`。
