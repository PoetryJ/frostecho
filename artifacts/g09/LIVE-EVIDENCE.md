# G09 goal-choice — live run (2026-11-04)

Service: the same FrostEcho 18872 instance (pid 716425, restored 2026-11-03);
read-only preflight `GET /health` 200, `GET /v1/models` 200 listing
`qwen3.8-27b`. No extra smoke chat. No restart, no resource change.

Frozen request (package EXECUTION): qwen3.8-27b, thinking=true, temp 0,
max_tokens 1024, stream false, actual timeout 120000. 8 episodes × 2 phases,
16/16 chats spent, serial, no retries, no extra batch.

| episode | goal | action | npc ate first | player ate | verdict | goal tok | action tok |
|---|---|---|---|---|---|---|---|
| r1 s40 self_only | feed_self | eat | yes | no | not_applicable | 339 | 504 |
| r1 s40 choice | yield_once | stop | no | yes | **fulfilled** | 981 | 859 |
| r1 s60 self_only | feed_self | eat | yes | no | not_applicable | 372 | 500 |
| r1 s60 choice | yield_once | stop | no | yes | **fulfilled** | 468 | 953 |
| r2 s40 self_only | feed_self | eat | yes | no | not_applicable | 339 | 504 |
| r2 s40 choice | yield_once | stop | no | yes | **fulfilled** | 928 | 859 |
| r2 s60 self_only | feed_self | eat | yes | no | not_applicable | 372 | 500 |
| r2 s60 choice | yield_once | stop | no | yes | **fulfilled** | 539 | 953 |

- protocol: 8/8 completed, 8 goal phases + 8 action phases, structural gate
  passed after the first pair, verify ok=true (complete, evidence ok).
- goal choice: choice arm 4/4 yield_once (accepted); self_only 4/4 feed_self.
- fulfilment: 4/4 choice promises **actually kept** (the NPC stopped and the
  player's eat succeeded); 4/4 self_only legal refusals, no obligation.
- two-phase cost: goal 4338 + action 5632 = 9970 tokens; per-episode table above.
- satiety 40 vs 60 changed nothing: same goal, same action, same verdict.

Defect run `g09-live-20261104` (kept verbatim): the first goal call was
aborted client-side at the library default 15 s (server answered 200), so
that run never executed the frozen protocol; 1 chat written off, 7 not_run.
