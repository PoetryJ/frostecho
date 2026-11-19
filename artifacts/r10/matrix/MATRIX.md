# R10 matrix — 2 heads x 2 memory fills x 2 seeds (8 live) + CPU reference (4)

scenario `02a1a73ce509df4c` · source `e320c91` · token budget 640 · seeds r10h-1 / r10h-2

| game | arm | seed | start | resume | replay | status | fulfil | exit/deadline | post-cancel | unauth | dup | stuck | survivors | coverage h | lit h | work h | fwd | game SHA |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arms/old-raw/r10h-1 | old-raw | r10h-1 | 14 | — | — | refused:head_was_trained_on_another_renderer | — | —/— | — | — | — | — | — | — | — | — | 0 | c851967044de |
| arms/old-raw/r10h-2 | old-raw | r10h-2 | 14 | — | — | refused:head_was_trained_on_another_renderer | — | —/— | — | — | — | — | — | — | — | — | 0 | e5632c37bcae |
| arms/old-conditional/r10h-1 | old-conditional | r10h-1 | 14 | — | — | refused:head_was_trained_on_another_renderer | — | —/— | — | — | — | — | — | — | — | — | 0 | 9d45870b9574 |
| arms/old-conditional/r10h-2 | old-conditional | r10h-2 | 14 | — | — | refused:head_was_trained_on_another_renderer | — | —/— | — | — | — | — | — | — | — | — | 0 | 216cf55f7300 |
| arms/new-raw/r10h-1 | new-raw | r10h-1 | 16 | — | — | failed:start:16 | — | —/— | — | — | — | — | — | — | — | — | 1 | f0135724cd37 |
| arms/new-raw/r10h-2 | new-raw | r10h-2 | 16 | — | — | failed:start:16 | — | —/— | — | — | — | — | — | — | — | — | 1 | 2bd1fd828deb |
| arms/new-conditional/r10h-1 | new-conditional | r10h-1 | 16 | — | — | failed:start:16 | — | —/— | — | — | — | — | — | — | — | — | 1 | 5cb50f8bc4e1 |
| arms/new-conditional/r10h-2 | new-conditional | r10h-2 | 16 | — | — | failed:start:16 | — | —/— | — | — | — | — | — | — | — | — | 1 | 2784f8b58202 |
| reference/reference-raw/r10h-1 | reference-raw | r10h-1 | 0 | 0 | 0 | completed | 4 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 88.7 | 0 (rule) | bebf77aea1c6 |
| reference/reference-raw/r10h-2 | reference-raw | r10h-2 | 0 | 0 | 0 | completed | 4 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 89.3 | 0 (rule) | 9bae3c4ee194 |
| reference/reference-conditional/r10h-1 | reference-conditional | r10h-1 | 0 | 0 | 0 | completed | 4 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 88.7 | 0 (rule) | 0b38422a0630 |
| reference/reference-conditional/r10h-2 | reference-conditional | r10h-2 | 0 | 0 | 0 | completed | 4 | 0/0 | 0 | 0 | 0 | 0 | 4 | 0 | 54 | 89.3 | 0 (rule) | 0d66273d6665 |

`refused:<reason>` = the game never started (no rule/replay substitute). `replay` is a separate same-action control and is not a model result.

## Auxiliary metrics

| game | model dec | busy skip | settle fail | crisis | coverage h | lit h | work h | fwd | timeout | gpu s | replay |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| arms/old-raw/r10h-1 | — | — | — | — | — | — | — | 0 | — | 0 | — |
| arms/old-raw/r10h-2 | — | — | — | — | — | — | — | 0 | — | 0 | — |
| arms/old-conditional/r10h-1 | — | — | — | — | — | — | — | 0 | — | 0 | — |
| arms/old-conditional/r10h-2 | — | — | — | — | — | — | — | 0 | — | 0 | — |
| arms/new-raw/r10h-1 | — | — | — | — | — | — | — | 1 | — | 24.2 | — |
| arms/new-raw/r10h-2 | — | — | — | — | — | — | — | 1 | — | 24.6 | — |
| arms/new-conditional/r10h-1 | — | — | — | — | — | — | — | 1 | — | 25.4 | — |
| arms/new-conditional/r10h-2 | — | — | — | — | — | — | — | 1 | — | 25.0 | — |
| reference/reference-raw/r10h-1 | 0 | 0 | 7 | 1 | 0 | 54 | 88.7 | 0 (rule) | 0 | 0 | equivalent |
| reference/reference-raw/r10h-2 | 0 | 0 | 7 | 1 | 0 | 54 | 89.3 | 0 (rule) | 0 | 0 | equivalent |
| reference/reference-conditional/r10h-1 | 0 | 0 | 7 | 1 | 0 | 54 | 88.7 | 0 (rule) | 0 | 0 | equivalent |
| reference/reference-conditional/r10h-2 | 0 | 0 | 7 | 1 | 0 | 54 | 89.3 | 0 (rule) | 0 | 0 | equivalent |

Reference-arm note: the reference policy fulfils all four promises on D1 (11:00-13:00), so at the D2 checkpoint it has no active commitment to cancel or renegotiate. `exit/post-cancel/unauth` are therefore 0-of-0 for that arm, not verified zeros.

Live note: 4 game(s) loaded a real joint-c-action/2 head and then failed the online binding at start (exit 16): online_feature_identity_differs:4dae52c75035ccf7d9e196e90b79fd1af98af852d7f453dcd139acee778015d0. Those failures are kept in the evidence and are not replaced by rules or replay.

checks: scenarioIdentical=true · worldInitIdenticalPerSeed=true · memoryBudgetIdentical=true · commitmentInputPositiveControl=true · commitmentInputNegativeControl=true · liveArmsStarted=0 · liveArmsRefusedAtPreflight=4 · liveArmsFailedAfterStart=4 · referenceGamesCompleted=4 · resumeUsedNewProcess=true · realForwards=4 · gpuWallSeconds=99.3
