# Matrix truth after the 2026-11-26 clock fix

This table is the evidence from the `h-run` tree (`b0919f1`, based on the frozen
`1d140c2`), imported into the integration branch unchanged.

| arm | seed | status | note |
| --- | --- | --- | --- |
| base-conditional | r11h-1 | completed | live, D2 2100, 0 diff, terminal extinction, main metric 4/6 |
| base-conditional | r11h-2 | completed | live, D2 2040, 0 diff, terminal extinction, main metric 4/7 |
| fulfil-conditional | r11h-1 | failed:start:16 | `advanceWorld refuses to move backwards: 1830 -> 1800`; rerun pending |
| fulfil-conditional | r11h-2 | failed:start:16 | same clock crash; rerun pending |
| base-raw / fulfil-raw | both | failed:start:16 / 12 | blocked by `memory-identity`: manifest binds `obligation-first`, raw arm asks `raw-last12` |

`pairedSeedCoverage` is false. Do not report the fulfilment arm as completed and
do not use replay/fallback to fill a live arm.

The crash came from a stale round target: the sleep-travel loop advanced the
clock to 1830 after `before=1770` was captured, then `advanceWorld(1800)` was
called. Integration commit `159a608` clamps the round and the final advance to
the current clock; `spatial.land()` also refuses to ask the clock to move
backwards. After the two fulfil games really finish, replace this note and the
table rows with their summaries; until then the status above is the delivery.
