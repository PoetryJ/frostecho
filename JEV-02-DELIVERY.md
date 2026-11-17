# JEV-02 overnight delivery — frozen Qwen choice heads (shadow)

Baseline `5c1e033`; isolated worktree branch `codex/jev-02-overnight`; source
commit `65cc7ae` (+ this doc). No production defaults changed, no push/merge,
no HTTP to 18872, no old budget used.

## Report (10 lines)

1. **P0 fixed**: ledger is reserve→begin→finish, caps checked at reserve before compute; 9,132 jobs charged, 3 failed/unfinished kept and counted; a real "forward OK, head throws" injection stays charged; candidate positions come from renderer structure with 16/16 fake-block regressions (player text containing “候选：A. …”).
2. **Data**: 1,024 train / 128 dev / 512 cal (256 temperature + 256 policy) / 256 test; 32 test families (8/class), 64 new-combination + 64 language-OOD per class-half; all `synthetic_dialogue` (no human labels); dedupe train 94.2% / test 77.0% player-text, 0% dialogue; phenomena cover omission/negation/revocation/correction/quote/reference/multi-turn/food objects.
3. **Label independence**: D-built test; B blind pass before predictions; 30 disagreements, all resolved by a written rubric, 0 unscored challenge — but A/B/C/D are the same operator in separate passes, not independent humans (stated everywhere).
4. **Training**: six runs = M1/M2 × seeds 17/29/43, 5,120 params each, 4 re-encoded permutations/case, AdamW lr .001/wd .01, batch 32 groups, patience 10; dev NLL M1 0.0400/0.0415/0.0516, M2 0.0376/0.0383/0.0467; selected M1/M2 seed 17 by dev only.
5. **Test (256×4)**: M1 0.891 original / 0.840 combined, M2 0.887 / 0.840, J 0.734 / 0.755, L 0.570 / 0.543, old H0 0.438 / 0.391, R 0.383; order consistency M1 0.664, M2 0.672, J 0.629, L 0.039, old H0 0.000; M1 macro-F1 0.835, ECE 0.054.
6. **Ablation**: M2's 0.1×JS term gives no accuracy gain (+0.000) and only +0.008 consistency → **not justified**; M1 is the candidate.
7. **Calibration/abstain**: T=0.6486 on cal-temperature; cal-policy threshold 0.5 has 2.3% error, but the frozen threshold on test accepts 99.2% with **11.0%/11.4% errors** → **no usable threshold at ≤5%**; no reliability guarantee; label-clarification and model-abstain kept separate.
8. **Latency/cost**: J 650.7 ms vs L 116.7 / M1 115.4 / M2 115.5 ms (−82%), prefill floor 113 ms; 9,132 jobs (1,026 generation, cap 1,700), 1,028,963 input / 7,406 generated tokens, 1,900 s model time, 1.25 h span, peak 13.4–14.9 GiB/GPU (cap 24), window 12 h.
9. **Diagnostics/failures**: removing player text drops M1 0.906→0.250 on 64 test cases (diagnostic only); 9 driver attempts (bugs fixed between attempts), 3 charged failures/unfinished, no model answer or generation retried; JEV-01 1808-vs-1809 ledger correction appended.
10. **Recommendation**: carry **M1 (linear CE)** forward, do **not** adopt M2 yet, do not use L or old H0, keep abstention off, and **collect human-checked natural data** before any production proposal; new model beats old H0 but the synthetic, single-operator evidence cannot support a reliability claim.

## Artifacts

| item | path |
| --- | --- |
| recommended head | `research/decision-choice/jev02/runs/M1-seed17/candidate.safetensors` (sha256 `d53d9b368cac14acecfaaa5aca5fc5ae8873028ca92af9ba9d8423b273be634e`), `last.pt` |
| all six runs | `runs/{M1,M2}-seed{17,29,43}/{best.pt,last.pt,candidate.safetensors,run.json}` |
| predictions / unseal | `results/test-predictions/*.jsonl`, `results/unseal-record.json`, `results/results.json` |
| metrics / cards | `results/REPORT.md`, `summary-table.json`, `MODEL-CARD.md`, `data/data-card.md` |
| audit | `audit/audit-results.json` (80/80), `audit/verify.py`, `label/disagreements.json` |
| cost / P0 evidence | `results/final-cost.json`, `evidence/p0-injection.json`, `evidence/p0-position.json` |
| prediction demo | `evidence/predict-demo.json` + `predict.py` (new process, shadow only) |
| bundle / evidence / SHA | `handoff/20261109-jev-02-delivery/` |

## Reproduce

```bash
export JEV=research/decision-choice/jev02
export PY=/data/social-agent-lab/server/venv-vllm032/bin/python
PYTHONPATH=$JEV:$JEV/.vendor $PY -m unittest discover -s $JEV/tests   # 14/14
PYTHONPATH=$JEV $PY $JEV/run.py report
PYTHONPATH=$JEV $PY $JEV/audit/verify.py                               # 80/80
PYTHONPATH=$JEV $PY $JEV/predict.py --checkpoint $JEV/runs/M1-seed17/candidate.safetensors \
  --context "厨房里只有一份饭，玩家刚进门。" --player "你先吃，我不饿。"
```

GPU retraining is not automatic: it needs a fresh authorization/directory;
features, generations, predictions and weights are in the external evidence tar.
