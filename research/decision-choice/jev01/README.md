# JEV-01 — frozen-Qwen choice probe (research shadow)

Baseline `d8aa517`, branch `codex/jev-01-choice-probe`, isolated worktree.
No production file changed; no HTTP to 18872; one local Qwen3.8-27B instance
sharded over four GPUs, batch 1, bf16, `thinking=off`, backbone and LM head
frozen. All outputs are shadow research.

## Semantics

Four stable candidate IDs: `PLAYER_FIRST`, `NPC_FIRST`, `NO_PRIORITY_REQUEST`,
`NEEDS_CLARIFICATION`. The task is understanding who the player asks to eat
first, never whether the NPC accepts.

## Arms

| arm | what it does |
| --- | --- |
| R `rules` | transparent regex/keyword baseline, may abstain |
| J `json` | same Qwen, greedy `{"selectedId":"A"}`, strict parse, no repair |
| L `label_logits` | one forward, `lm_head(h_q)` over the four display-label tokens |
| H0 `linear_head` | `w^T LN(h_i)` on the same cached features |
| H1 `pointer_head` | `q^T k_i/sqrt(128) + v^T k_i`, rank 128 |

L/H0/H1 share byte-identical token IDs (one forward per presentation);
J differs only in the protocol tail. Candidate order is re-encoded, never
just row-swapped.

## Commands

```bash
export JEV=research/decision-choice/jev01
export PY=/data/social-agent-lab/server/venv-vllm032/bin/python
PYTHONPATH=$JEV:$JEV/.vendor $PY $JEV/data/generate.py   # 640 cases, 2 orders
PYTHONPATH=$JEV $PY -m unittest discover -s $JEV/tests    # CPU/fake gate
PYTHONPATH=$JEV:$JEV/.vendor $PY $JEV/run.py lock
PYTHONPATH=$JEV:$JEV/.vendor $PY $JEV/run.py experiment  # ONE GPU run
PYTHONPATH=$JEV $PY $JEV/run.py report
PYTHONPATH=$JEV $PY $JEV/audit/verify.py
```

## Dataset

640 base cases, balanced 96/16/16/32 by class; 60 hand-written template
families split before variants (36/8/8/8). Test = 64 new-combination + 64
language-OOD, gold sealed with SHA. This is a bounded synthetic/annotated
pilot, not 640 real players.

## Files

`contracts.py` frozen caps/classes/hashes · `data/` dataset, rules, feature IO ·
`backends/local_qwen.py` one local backend · `heads/` H0/H1 + training ·
`eval/metrics.py` metrics/calibration · `run.py` orchestrator · `audit/` independent
verification · `tests/` CPU/fake gate.
