# R11 four-arm matrix — base/fulfil x raw/conditional x 2 unseen seeds

scenario `8c10c158d599eb59` · source `24406c4` · budget 640 · seeds r11h-1 / r11h-2

| game | arm | seed | status | save clock | active@save | bound work@save | fulfil | overdue | exit | post-cancel | unagreed | survivors | gap h (food) | fwd | game SHA |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| artifacts/r11/matrix/arms/base-raw/r11h-1 | base-raw | r11h-1 | failed:start:12 | — | — | — | —/— | — | — | — | — | — | — | 0 | 86f60b9bdf45 |
| artifacts/r11/matrix/arms/base-raw/r11h-2 | base-raw | r11h-2 | failed:start:12 | — | — | — | —/— | — | — | — | — | — | — | 0 | cd135e4b30cc |
| artifacts/r11/matrix/arms/base-conditional/r11h-1 | base-conditional | r11h-1 | failed:start:12 | — | — | — | —/— | — | — | — | — | — | — | 0 | db4d48be34e2 |
| artifacts/r11/matrix/arms/base-conditional/r11h-2 | base-conditional | r11h-2 | failed:start:12 | — | — | — | —/— | — | — | — | — | — | — | 0 | 800ece8e807b |
| artifacts/r11/matrix/arms/fulfil-raw/r11h-1 | fulfil-raw | r11h-1 | failed:start:12 | — | — | — | —/— | — | — | — | — | — | — | 0 | 715ee5fc2e22 |
| artifacts/r11/matrix/arms/fulfil-raw/r11h-2 | fulfil-raw | r11h-2 | failed:start:12 | — | — | — | —/— | — | — | — | — | — | — | 0 | acd247d564d6 |
| artifacts/r11/matrix/arms/fulfil-conditional/r11h-1 | fulfil-conditional | r11h-1 | failed:start:12 | — | — | — | —/— | — | — | — | — | — | — | 0 | 7a16f0079ca0 |
| artifacts/r11/matrix/arms/fulfil-conditional/r11h-2 | fulfil-conditional | r11h-2 | failed:start:12 | — | — | — | —/— | — | — | — | — | — | — | 0 | 8f75eae65bd8 |
| artifacts/r11/matrix/reference/reference-raw/r11h-1 | reference-raw | r11h-1 | completed | 2040 | 2 | 2 | 4/8 | 4 | 0 | 0 | 0 | 3 | 0 | 0 (rule) | 6c30b6434ebb |
| artifacts/r11/matrix/reference/reference-raw/r11h-2 | reference-raw | r11h-2 | completed | 2040 | 2 | 2 | 4/8 | 4 | 0 | 0 | 0 | 4 | 0 | 0 (rule) | d82ba8283db5 |
| artifacts/r11/matrix/reference/reference-conditional/r11h-1 | reference-conditional | r11h-1 | completed | 2040 | 2 | 2 | 4/8 | 4 | 0 | 0 | 0 | 3 | 0 | 0 (rule) | 225197f2f0dd |
| artifacts/r11/matrix/reference/reference-conditional/r11h-2 | reference-conditional | r11h-2 | completed | 2040 | 2 | 2 | 4/8 | 4 | 0 | 0 | 0 | 4 | 0 | 0 (rule) | 2a585de2907c |

`exit` is the authorised exit count; `post-cancel` counts late physical effects (receipts) after a cancellation, not rejected attempts. Replay and fallback are separate controls and are not model results.

## Per-seed paired differences (fulfil − base)

- r11h-1 · raw-last12: incomplete pair
- r11h-1 · obligation-first: incomplete pair
- r11h-2 · raw-last12: incomplete pair
- r11h-2 · obligation-first: incomplete pair

Reference note: the reference arm has no model head; its rows are controls on the same scenario and story schedule. A legal early completion is recorded as `not_exposed` and the pre-designed delegation provides the opportunity; no arm is credited with a zero-violation result on a zero opportunity.

## Resources — final inventory hours vs four-day gap hours

| game | inventory h (food / firewood / power) | gap h (food / firewood / power) |
| --- | --- | --- |
| artifacts/r11/matrix/arms/base-raw/r11h-1 | — | — |
| artifacts/r11/matrix/arms/base-raw/r11h-2 | — | — |
| artifacts/r11/matrix/arms/base-conditional/r11h-1 | — | — |
| artifacts/r11/matrix/arms/base-conditional/r11h-2 | — | — |
| artifacts/r11/matrix/arms/fulfil-raw/r11h-1 | — | — |
| artifacts/r11/matrix/arms/fulfil-raw/r11h-2 | — | — |
| artifacts/r11/matrix/arms/fulfil-conditional/r11h-1 | — | — |
| artifacts/r11/matrix/arms/fulfil-conditional/r11h-2 | — | — |
| artifacts/r11/matrix/reference/reference-raw/r11h-1 | 16.0 / 0 / 0 | 0 / 31 / 10 |
| artifacts/r11/matrix/reference/reference-raw/r11h-2 | 16.0 / 0 / 0 | 0 / 32 / 0 |
| artifacts/r11/matrix/reference/reference-conditional/r11h-1 | 16.0 / 0 / 0 | 0 / 31 / 10 |
| artifacts/r11/matrix/reference/reference-conditional/r11h-2 | 16.0 / 0 / 0 | 0 / 32 / 0 |

checks: scenarioIdentical=true · worldInitIdenticalPerSeed=true · memoryBudgetIdentical=true · commitmentInputPositiveControl=true · commitmentInputNegativeControl=true · liveArmsStarted=0 · liveArmsRefusedAtPreflight=8 · liveArmsFailedAfterStart=0 · referenceGamesCompleted=4 · resumeUsedNewProcess=true · saveHadBoundWork=true · restoreEqual=true · replayContinuousEqual=true · replaySegmentedEqual=true · tamperDetected=true · pairedSeedCoverage=false · realForwards=0 · gpuWallSeconds=0
