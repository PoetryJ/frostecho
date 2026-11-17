# JEV-01 delivery — frozen Qwen choice probe (shadow)

Baseline `d8aa517`; isolated worktree branch `codex/jev-01-choice-probe`; source
commit `2d2daab`. No production default changed, no push/merge, no HTTP/18872,
no old campaign budget.

## Report (10 lines)

1. 数据：640 base / 最多1280输入；60个手写模板族先分组后造样本，384/64/64/128，test=64新组合+64语言OOD；另有10条真实 controller→Provider 输入与2个零调用边界；合成先导，非640名玩家。
2. 冻结：同一份 Qwen3.8-27B，单进程四卡分片、bf16、batch1、26.9B参数；backbone/LM head/tokenizer/mask 全冻结，无 LoRA、无新 token；L/H0/H1 共用同一次前向与同一 token IDs。
3. 头：6次训练（H0 5,120参数、H1 1,310,848参数 × seed17/29/43）；dev NLL 选定 H0=17、H1=29；权重、每轮 loss/dev、参数表与 SHA 均已落盘。
4. 质量（test 原序128）：H0-17 **0.898**（13错）> J 0.781（28错）> R 0.820 > L 0.691；逆序 H0 0.898 / J 0.891 / H1-29 0.930；换序一致率 H0 0.891 > H1 0.867 > J/L 0.844 > R 1.0(覆盖0.945)。
5. OOD：H0 新组合0.906/语言0.891，J 0.813/0.859，H1-29 0.961/0.813，L 0.719/0.664，R 1.000/0.641（NF15 为0）——规则只对模板型新组合有效。
6. 校准：L ECE 0.140→0.132；H0 0.066→0.089（cal过小，反而变差）；H1 0.142→0.059；J 无 NLL/Brier（合同规定）。
7. 延迟（32冻结呈现，完整重跑）：J 758.5ms vs L 123.4 / H0 122.9 / H1 122.3ms（改善83.8–83.9%）；prefill≈120ms，J decode≈541ms；32条最小值/中位数见 latency.json。
8. 成本/显存：1808 jobs（1280特征+384生成+128延迟+8warmup+8兼容），232,110输入token/2,954生成token，模型时间533.3s，账本跨度13.7min；单卡峰值15.05GiB（4卡13.05/14.90/14.92/7.36），加载6.5s，训练9.03s CPU。
9. 失败记录：首个进程在延迟阶段因驱动 bug（LinearHead 多传参数）停止于1680 jobs，预测已写并哈希、未读 gold；随后仅补延迟，复用账本2条、总账仍精确1808，未重算特征/生成/训练/预测；D 审计91/91通过。
10. 建议：**继续训练线性头 H0 并补自然数据**——H0 比 J 少15错/128且端到端快约84%，但 H1 不明显优于 H0（复杂度不值）、免训练 L 不够（69%，从不预测澄清类）、规则在新组合上过拟合；8个测试族+合成模板+12分seed摆幅不足以接入，下一步扩自然标注、保留 H0、暂不引入 H1。

## Artifacts

| item | path |
| --- | --- |
| recalculation | `research/decision-choice/jev01/results/REPORT.md`, `summary-table.json` |
| 6 training runs + weights | `research/decision-choice/jev01/runs/{linear,pointer}_head-seed{17,29,43}/{run.json,head.pt}` |
| raw jobs / outputs | `evidence/jobs.jsonl`, `results/j-generations.jsonl`, `results/test-predictions/*` |
| feature cache manifest | `cache/features-*.meta.json` (npz in the evidence tar) |
| independent audit | `audit/verify.py`, `audit/audit-results.json`, `results/D-AUDIT.md`, `audit/TEST-LABEL-REVIEW.json` |
| bundle / evidence / SHA | `handoff/20261109-jev-01-delivery/` |

## Reproduce (CPU checks + recalculation)

```bash
export JEV=research/decision-choice/jev01
export PY=/data/social-agent-lab/server/venv-vllm032/bin/python
PYTHONPATH=$JEV:.vendor $PY -m unittest discover -s $JEV/tests
PYTHONPATH=$JEV $PY $JEV/run.py report
PYTHONPATH=$JEV $PY $JEV/audit/verify.py
```

GPU re-run is deliberately not automatic: it would need a new authorization and
a fresh directory (features/J/latency are already sealed in the evidence tar).
