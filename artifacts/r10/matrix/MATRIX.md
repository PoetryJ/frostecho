# R10 matrix — 2 heads x 2 memory fills x 2 seeds (8 live) + CPU reference (4)

scenario `02a1a73ce509df4c` · source `4479999` · token budget 640 · seeds r10h-1 / r10h-2

| game | arm | seed | start | resume | replay | status | fulfil | exit/deadline | post-cancel | unauth | dup | stuck | survivors | coverage h | lit h | work h | fwd | game SHA |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arms/old-raw/r10h-1 | old-raw | r10h-1 | 14 | — | — | refused:head_was_trained_on_another_renderer | — | —/— | — | — | — | — | — | — | — | — | 0 | d43f6dcad88a |
| arms/old-raw/r10h-2 | old-raw | r10h-2 | 14 | — | — | refused:head_was_trained_on_another_renderer | — | —/— | — | — | — | — | — | — | — | — | 0 | 758026e69286 |
| arms/old-conditional/r10h-1 | old-conditional | r10h-1 | 14 | — | — | refused:head_was_trained_on_another_renderer | — | —/— | — | — | — | — | — | — | — | — | 0 | f61b1ddf9464 |
| arms/old-conditional/r10h-2 | old-conditional | r10h-2 | 14 | — | — | refused:head_was_trained_on_another_renderer | — | —/— | — | — | — | — | — | — | — | — | 0 | 97b8ffede2ef |
| arms/new-raw/r10h-1 | new-raw | r10h-1 | 0 | 0 | 0 | completed | 3 | 0/0 | 0 | 0 | 0 | 0 | 5 | 0 | 54 | 107.3 | 260 | 07c31f6e1198 |
| arms/new-raw/r10h-2 | new-raw | r10h-2 | 0 | 0 | 0 | completed | 3 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 114.1 | 233 | 49e2a7a59b5c |
| arms/new-conditional/r10h-1 | new-conditional | r10h-1 | 0 | 0 | 0 | completed | 2 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 109.1 | 226 | 71e513cbaa75 |
| arms/new-conditional/r10h-2 | new-conditional | r10h-2 | 0 | 0 | 0 | completed | 2 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 109.1 | 226 | 684391656250 |
| reference/reference-raw/r10h-1 | reference-raw | r10h-1 | 0 | 0 | 0 | completed | 4 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 88.7 | 0 (rule) | 5d9c9c4ea9ab |
| reference/reference-raw/r10h-2 | reference-raw | r10h-2 | 0 | 0 | 0 | completed | 4 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 89.3 | 0 (rule) | ddd98be36546 |
| reference/reference-conditional/r10h-1 | reference-conditional | r10h-1 | 0 | 0 | 0 | completed | 4 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 88.7 | 0 (rule) | dac8a3c976d2 |
| reference/reference-conditional/r10h-2 | reference-conditional | r10h-2 | 0 | 0 | 0 | completed | 4 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 89.3 | 0 (rule) | 53ff30ee68b3 |

`refused:<reason>` = the game never started (no rule/replay substitute). `replay` is a separate same-action control and is not a model result.

## Auxiliary metrics

| game | model dec | busy skip | settle fail | crisis | coverage h | lit h | work h | fwd | timeout | gpu s | replay |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arms/old-raw/r10h-1 | — | — | — | — | — | — | — | 0 | — | 0 | — |
| arms/old-raw/r10h-2 | — | — | — | — | — | — | — | 0 | — | 0 | — |
| arms/old-conditional/r10h-1 | — | — | — | — | — | — | — | 0 | — | 0 | — |
| arms/old-conditional/r10h-2 | — | — | — | — | — | — | — | 0 | — | 0 | — |
| arms/new-raw/r10h-1 | 260 | 0 | 23 | 1 | 0 | 54 | 107.3 | 260 | 0 | 2566.1 | equivalent |
| arms/new-raw/r10h-2 | 233 | 0 | 6 | 1 | 0 | 54 | 114.1 | 233 | 0 | 2297.0 | equivalent |
| arms/new-conditional/r10h-1 | 226 | 0 | 9 | 1 | 0 | 54 | 109.1 | 226 | 0 | 2232.1 | equivalent |
| arms/new-conditional/r10h-2 | 226 | 0 | 9 | 1 | 0 | 54 | 109.1 | 226 | 0 | 2230.4 | equivalent |
| reference/reference-raw/r10h-1 | 0 | 0 | 7 | 1 | 0 | 54 | 88.7 | 0 (rule) | 0 | 0 | equivalent |
| reference/reference-raw/r10h-2 | 0 | 0 | 7 | 1 | 0 | 54 | 89.3 | 0 (rule) | 0 | 0 | equivalent |
| reference/reference-conditional/r10h-1 | 0 | 0 | 7 | 1 | 0 | 54 | 88.7 | 0 (rule) | 0 | 0 | equivalent |
| reference/reference-conditional/r10h-2 | 0 | 0 | 7 | 1 | 0 | 54 | 89.3 | 0 (rule) | 0 | 0 | equivalent |

Reference-arm note: the reference policy fulfils all four promises on D1 (11:00-13:00), so at the D2 checkpoint it has no active commitment to cancel or renegotiate. `exit/post-cancel/unauth` are therefore 0-of-0 for that arm, not verified zeros.

Harness-fix note: artifacts/r10/matrix/arms/new-raw/r10h-1 resume exited 17 on the first pass because settled intents were looked up in the pruned `runtime.intents`; the verdict was recomputed from `workLog` (`--reconcile`), so the original exit stays in `summary.json.exitsBeforeFix`.

checks: scenarioIdentical=true · worldInitIdenticalPerSeed=true · memoryBudgetIdentical=true · commitmentInputPositiveControl=true · commitmentInputNegativeControl=true · liveArmsStarted=4 · liveArmsRefusedAtPreflight=4 · liveArmsFailedAfterStart=0 · referenceGamesCompleted=4 · resumeUsedNewProcess=true · realForwards=945 · gpuWallSeconds=9325.6
