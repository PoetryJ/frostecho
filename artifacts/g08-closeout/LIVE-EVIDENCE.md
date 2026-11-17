# G08 closeout — live 8-episode run (2026-11-03)

Service restored once from `/data/frostecho-runtime/server.json` (original argv and
env overrides, TP4, gpu-memory-utilization 0.25, max-model-len 8192, max-num-seqs 1).
Launch record: `/data/frostecho-runtime/closeout-launch.json` (pid 716425).
Read-only preflight: `GET /health` 200, `GET /v1/models` 200 listing `qwen3.8-27b`.
No extra smoke chat was sent.

Batch: `g08-closeout-live-20261103` (frozen matrix, one advance per episode,
one player eat attempt, timeout 120000, thinking true, temperature 0,
max_tokens 1024, stream false). Chat requests: **8/8** (limit), no retries.

## Result (honest, final)

| cell | rep | action | npcAte | playerAte | tokens | latency (2 eps) |
|---|---|---|---|---|---|---|
| legacy-off | r1/r2 | eat | true | false | 544 / 544 | 56.9 s |
| legacy-on | r1/r2 | eat | true | false | 814 / 814 | 104.1 s |
| timed_wait-off | r1/r2 | eat | true | false | 507 / 507 | 39.6 s |
| timed_wait-on | r1/r2 | eat | true | false | 803 / 803 | 98.8 s |

- Every arm chose `eat`; **wait was never chosen**, so no wait mechanism was
  exercised by the real model (the mechanism itself is proven by the fake and
  state evidence, not by this run).
- Messages changed the cost, not the decision: on−off delta = +270 (legacy) and
  +296 (timed_wait) tokens per pair; S1 ("leave the last food for me") was not
  obeyed in any arm.
- Total 5336 tokens, usage known for all 8 responses, 0 blocked, 0 unresolved.
- `verify --batch g08-closeout-live-20261103` -> ok=true, exit 0 (read-only,
  recomputed from raw materials including the summary comparison).

## Interpretation

The frozen experiment answers only "what does the model do on this prompt"
— it does not prove or disprove the waiting mechanism. Defaults remain
legacy / messages off; whether to enable timed_wait or messages is a product
decision for the owner based on these numbers.
