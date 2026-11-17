# G08-R1 evidence (2026-11-03)

Baseline `65ea754` → branch `codex/g08-r1-acceptance`.

## Live experiment disposition: offline_ready / service_unreachable

Read-only preflight (recorded here, not counted as chat):

| probe | result |
|---|---|
| `GET http://127.0.0.1:18872/health` | HTTP 000 (connection refused) |
| `GET http://127.0.0.1:18872/v1/models` | HTTP 000 |
| `POST /v1/chat/completions` reachability | HTTP 000 |

- **Real chat requests: 0 / 8.** The shared GPU service was NOT restarted or
  modified; per the execution package an unreachable service is delivered as
  `offline_ready / service_unreachable` with zero-chat evidence.
- Node actually used: the pre-installed `/root/.codebuddy-server-cn/bin/stable-*`
  runtime (v22.20.0); the documented `/root/.workbuddy/binaries/node/versions/24.14.0`
  path was not present in this environment.

## Offline gates (all green)

| gate | command | result |
|---|---|---|
| full suite | `node scripts/run-tests.mjs` | **383/383 pass** |
| golden | `node handoff/20261102-g08-timed-wait/golden-g05.cjs` | **12/12** |
| state probe | `node handoff/20261103-g08-r1/probes/state-probe.cjs <repo>` | A1–A3 fixed (missing simTime rejected, 3 named restore conflicts refused, actor call-10 settles budget_exhausted, 0-call restore) |
| cli probe | `node handoff/20261103-g08-r1/probes/cli-probe.cjs <repo>` | live seed keeps model-alpha/120000, changed model & live-as-script exit 2 with 0 requests, HTTP500 step/run exit 1 without saving, printed calls == saved |
| eval audit probe | `node handoff/20261103-g08-r1/probes/eval-audit-probe.cjs <repo>` | **8/8** (valid baseline + 6 tamper counterexamples + illegal failstop) |
| G07 old batch (read-only) | `node dist/scripts/eval-g07.js --verify --out artifacts/g07 --batch g07-live-20261102-r1` | exit 1, `behaviorAndCost=ok configuration=mismatch` (expected since R1) |

## New R1 batches in this directory

- `fixture-r1-legal/` — legal per-axis fake batch, 8/8 completed, 8 chat
  requests, verifier `ok=true` (mode=fake; mechanism only).
- `fixture-r1-illegal/` — always-wait responder: the FIRST legacy episode is
  `invalid_output`, the batch stops after 1 request, the remaining 7 are
  `not_run` (fail-stop path, no retry).
- `wake-demo2/` — cross-process recovery demo: create timed_wait slot, npc_a
  waits (deadline 1, 1 provider call) → save; new process loads (0 calls) →
  `--time 1` wakes it → the same cycle continues (2nd call, stop); a third
  process with a conflicting `--actions legacy` is refused at restore.

Old evidence (`artifacts/g07`, `artifacts/g08`, `artifacts/g08-play`) is
untouched.
