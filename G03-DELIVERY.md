# G03 — Dual autonomous NPCs + player intervention (delivery notes)

Branch: `codex/g03-multi-npc` (from baseline 317dfc7). Commits: A scheduler, B game/CLI, C scenarios/record/eval, D JSON-root hardening (independent), fixture + live evidence.

## Status

- Tests: 137/137 (`npm test`) — includes G03 scheduler/game/record suites, probe regressions (null/array/primitive roots), and the untouched pre-existing suites.
- Fixture batch: `artifacts/g03/g03-fixture-20261030` — 12/12 episodes, 44 reference decisions, `--verify` ok.
- Live batches:
  - `g03-live-20261030` — kept as an infrastructure-interrupt record: `FROSTECHO_LLM_URL` was set to the `/v1` base instead of the full chat-completions endpoint (the adapter does not append a path); first request 404, batch stopped, 11 not_run. Preserved per CONTRACTS ("records of failed runs are also records").
  - `g03-live-20261030-r2` — corrected endpoint; health ok; gate [a,c] 6/6 pass then [c,a] 6/6; 12/12 episodes pass, 44 chat requests (exactly the reference path), 0 replay mismatches, `--verify` ok.
- Model: qwen3.8-27b via 127.0.0.1:18872, serial requests, no retries, harness never restarted the service.

## Scenario outcomes (live, both orders, thinking on/off)

- M1: both NPCs reach 70, player stays 20, kitchen ends 0.
- M2: first-scheduled NPC reaches 70, the other stops at 40; reversing the order flips the winner (recorded, not judged).
- M3: player steals the only food mid-decision (b 20→50); both NPCs stop at 40 with a recorded NO_FOOD contention.

## Verification semantics

`verifyMultiEpisode` re-derives: sidecar equality, fresh-Engine re-execution of every logged command, event/state equality, replayMatches, per-actor goal recomputation, scenario re-judgement, commandId grammar, turn/command ledger, parse re-checks, and the 5-decision budget ceiling. Summaries rebuild from disk only. Batch CLI: 0 all pass; 1 behavior/execution failure; 2 missing config/precondition.

## D (H01 follow-up, independent commit)

`probe-json-shapes.cjs` originally reproduced: game.json=null silently ignored (CLI exit 0), meta.json/replay.json=null TypeError. Now: per-game and batch verification reject null/array/primitive roots with named issues; the batch layer never silently ignores a failed verification; CLI exits 1. Probe re-run: all three cases ok=false, no throws.
