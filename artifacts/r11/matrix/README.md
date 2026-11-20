# R11 H — matrix, D2 and full-state evidence

Frozen before any live run:

| file | meaning |
|---|---|
| `scenario.json` | the one scenario (world, initial condition, commitments, D2 gate, interference schedule/triggers). `scenarioSha` is written next to every game. |
| `metric-spec.json` | primary/secondary metrics, exposure rules, resource rates, gap definition. |
| `preregistration.json` | the two unseen seeds, the arms, the opportunity rules and the D2 rule. |
| `ENVIRONMENT.json` | host, node, python, GPU state, determinism control. |
| `D-RUNNER-COMPAT.json` | D's shared four-day runner builds the same initial authority from the same seed; the declared scenario overrides are listed. |
| `MATRIX.md` / `matrix-table.json` | per-game verdicts, checks and per-seed paired differences. |
| `INSTANCES.jsonl` | one row per commitment instance (fulfilment/overdue/exit/cancel effects/change/contention/work). |
| `exposure.json` | D2 + story exposure acceptance: probe proves all four stories; reference rows record what the reference policy actually took (`not_exposed` = null). |

Per game (`arms/<arm>/<seed>/`, `reference/<arm>/<seed>/`, `probe/...`):

| file | meaning |
|---|---|
| `preflight.json` | head/manifest/renderer/feature identity, C's shared validator result when present. |
| `d1-start.json`, `commitment-input.json` | common initial world hash + the commitment-input positive proof. |
| `d2-exit.json`, `d2/save-manifest.json`, `D2-SAVE.md` | the save clock, active commitments, **bound in-flight work (same instance AND revision)**, file hashes, both pids. |
| `restore-compare.json` | full-state equality between the save and the new-pid load. |
| `interference.json` | actual world minute of each story, wait, target and detail. |
| `metrics.json` | recomputed from the complete decisions/workLog/receipts/memories + the resource timeline. |
| `replay-continuous/compare.json`, `replay-segmented/compare.json` | same-action controls, `countsAsModelResult=false`. |
| `verify-d2.json` | hard checks (`ok`) and story exposure (`exposed`). |
| `tamper.json` | five deliberate corruptions on the D2 save and the D4 final. |
| `summary.json` | the game identity, exits, pids, evidence hashes and `gameSha256`. |

Raw files (`decisions-*.jsonl`, `final-state.json`, `d2/session.json*`,
`scorer-*.jsonl`) are gitignored on purpose. They are bound by
`summary.json.evidence` and `d2/save-manifest.json`; the acceptance raw pack is
listed in the handoff `H/` with a SHA256SUMS file.

Recompute without rerunning a game:

```bash
export PATH=/data/home/user_00/.local/node22/bin:$PATH
node scripts/r11/run-matrix.mjs --verify   --out <gameDir>   # rewrite verify-d2.json
node scripts/r11/run-matrix.mjs --tamper   --out <gameDir>   # rewrite tamper.json
node scripts/r11/run-matrix.mjs --d2-report --out <gameDir>  # rewrite D2-SAVE.md
node scripts/r11/run-matrix.mjs --exposure-summary --out artifacts/r11/matrix
```
