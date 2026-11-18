# R10 matrix — 2 heads x 2 memory fills x 2 seeds (8 live) + CPU reference (4)

scenario `02a1a73ce509df4c` · source `054cab0` · token budget 640 · seeds r10h-1 / r10h-2

| game | arm | seed | start | resume | replay | status | fulfil | exit/deadline | post-cancel | unauth | dup | stuck | survivors | coverage h | lit h | work h | fwd | game SHA |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arms/old-raw/r10h-1 | old-raw | r10h-1 | 14 | — | — | refused:head_was_trained_on_another_renderer | — | —/— | — | — | — | — | — | — | — | — | — | 01dd9f9ffb82 |
| arms/old-raw/r10h-2 | old-raw | r10h-2 | 14 | — | — | refused:head_was_trained_on_another_renderer | — | —/— | — | — | — | — | — | — | — | — | — | 4d35fc1d9540 |
| arms/old-conditional/r10h-1 | old-conditional | r10h-1 | 14 | — | — | refused:head_was_trained_on_another_renderer | — | —/— | — | — | — | — | — | — | — | — | — | 3b219919c3e1 |
| arms/old-conditional/r10h-2 | old-conditional | r10h-2 | 14 | — | — | refused:head_was_trained_on_another_renderer | — | —/— | — | — | — | — | — | — | — | — | — | 0890b670ecae |
| arms/new-raw/r10h-1 | new-raw | r10h-1 | 12 | — | — | refused:head_artifact_missing | — | —/— | — | — | — | — | — | — | — | — | — | 99ca5a7c4dbb |
| arms/new-raw/r10h-2 | new-raw | r10h-2 | 12 | — | — | refused:head_artifact_missing | — | —/— | — | — | — | — | — | — | — | — | — | b68b221972e2 |
| arms/new-conditional/r10h-1 | new-conditional | r10h-1 | 12 | — | — | refused:head_artifact_missing | — | —/— | — | — | — | — | — | — | — | — | — | bb19bbcfd319 |
| arms/new-conditional/r10h-2 | new-conditional | r10h-2 | 12 | — | — | refused:head_artifact_missing | — | —/— | — | — | — | — | — | — | — | — | — | d76d4cf057a0 |
| reference/reference-raw/r10h-1 | reference-raw | r10h-1 | 0 | 0 | 0 | completed | 4 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 88.7 | 0 (rule) | a57322785bb6 |
| reference/reference-raw/r10h-2 | reference-raw | r10h-2 | 0 | 0 | 0 | completed | 4 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 89.3 | 0 (rule) | 3dc3186af343 |
| reference/reference-conditional/r10h-1 | reference-conditional | r10h-1 | 0 | 0 | 0 | completed | 4 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 88.7 | 0 (rule) | ab723f59df64 |
| reference/reference-conditional/r10h-2 | reference-conditional | r10h-2 | 0 | 0 | 0 | completed | 4 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 89.3 | 0 (rule) | c2c33edd6078 |

`refused:<reason>` = the game never started (no rule/replay substitute). `replay` is a separate same-action control and is not a model result.

## Auxiliary metrics

| game | model dec | busy skip | settle fail | crisis | coverage h | lit h | work h | fwd | timeout | gpu s | replay |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arms/old-raw/r10h-1 | — | — | — | — | — | — | — | — | — | — | — |
| arms/old-raw/r10h-2 | — | — | — | — | — | — | — | — | — | — | — |
| arms/old-conditional/r10h-1 | — | — | — | — | — | — | — | — | — | — | — |
| arms/old-conditional/r10h-2 | — | — | — | — | — | — | — | — | — | — | — |
| arms/new-raw/r10h-1 | — | — | — | — | — | — | — | — | — | — | — |
| arms/new-raw/r10h-2 | — | — | — | — | — | — | — | — | — | — | — |
| arms/new-conditional/r10h-1 | — | — | — | — | — | — | — | — | — | — | — |
| arms/new-conditional/r10h-2 | — | — | — | — | — | — | — | — | — | — | — |
| reference/reference-raw/r10h-1 | 0 | 0 | 7 | 1 | 0 | 54 | 88.7 | 0 (rule) | 0 | 0 | equivalent |
| reference/reference-raw/r10h-2 | 0 | 0 | 7 | 1 | 0 | 54 | 89.3 | 0 (rule) | 0 | 0 | equivalent |
| reference/reference-conditional/r10h-1 | 0 | 0 | 7 | 1 | 0 | 54 | 88.7 | 0 (rule) | 0 | 0 | equivalent |
| reference/reference-conditional/r10h-2 | 0 | 0 | 7 | 1 | 0 | 54 | 89.3 | 0 (rule) | 0 | 0 | equivalent |

Reference-arm note: the reference policy fulfils all four promises on D1 (11:00-13:00), so at the D2 checkpoint it has no active commitment to cancel or renegotiate. `exit/post-cancel/unauth` are therefore 0-of-0 for that arm, not verified zeros; the eight live arms that would exercise them never started (no head trained on `joint-c-action/2`).

checks: scenarioIdentical=true · worldInitIdenticalPerSeed=true · memoryBudgetIdentical=true · commitmentInputPositiveControl=true · commitmentInputNegativeControl=true · liveArmsStarted=0 · liveArmsRefused=8 · referenceGamesCompleted=4 · resumeUsedNewProcess=true · realForwards=0 · gpuWallSeconds=0
