# Four-day strategy ladder (same seed, one driver)

Driver: `src/r7/integration/fourday.ts`, entry `dist/scripts/r10/d-fourday.js`.
Map profile: engine 3-map (frozen).
Food: 130 (shared default; no row is handed extra).

| seed | strategy | ending | survivors | decisions | applied/rejected/cancelled | rescues | nightWalks | outdoorReturns | vetoes | withdrawals | council accept/decline/counter/reassigned | clockSha256 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| r11-d-base | `reference-rule/1` | bleak | 4 | 290 | 200/0/0 | 0 | 0 | 0 | 0 | 0 | 16/1/9/3 | `f23a04c53ae04367` |
| r11-d-base | `npc-schedule/home-at-night/1+outdoor-limit/120min/1+reference-survival/1+lethal-day-withdrawal/1+walk-escort/1+recorded-survival-exit/1+supply-then-restart/1` | perfect | 8 | 304 | 200/0/0 | 0 | 14 | 0 | 4 | 0 | 12/0/12/0 | `8b60c9f944dd3a65` |
| r11-d-2 | `reference-rule/1` | bleak | 3 | 286 | 200/0/0 | 0 | 0 | 0 | 0 | 0 | 16/1/11/3 | `4bdcb954ffdb9e66` |
| r11-d-2 | `npc-schedule/home-at-night/1+outdoor-limit/120min/1+reference-survival/1+lethal-day-withdrawal/1+walk-escort/1+recorded-survival-exit/1+supply-then-restart/1` | normal | 7 | 278 | 200/0/0 | 0 | 15 | 0 | 1 | 0 | 12/0/13/0 | `c2602cb4b9a4e2d8` |
| r10-d | `reference-rule/1` | bleak | 3 | 286 | 200/0/0 | 0 | 0 | 0 | 0 | 0 | 16/1/11/3 | `c257da591a43ec8a` |
| r10-d | `npc-schedule/home-at-night/1+outdoor-limit/120min/1+reference-survival/1+lethal-day-withdrawal/1+walk-escort/1+recorded-survival-exit/1+supply-then-restart/1` | perfect | 8 | 296 | 200/0/0 | 0 | 15 | 0 | 1 | 0 | 12/0/12/0 | `5b31ea698363e66d` |

## What each switch adds (per seed)

### r11-d-base

- `npc-schedule/home-at-night/1+outdoor-limit/120min/1+reference-survival/1+lethal-day-withdrawal/1+walk-escort/1+recorded-survival-exit/1+supply-then-restart/1` vs `reference-rule/1`: survivors 4 -> 8, ending bleak -> perfect; adds `npc-schedule/home-at-night/1`, `outdoor-limit/120min/1`, `reference-survival/1`, `lethal-day-withdrawal/1`, `walk-escort/1`, `recorded-survival-exit/1`, `supply-then-restart/1`; receipts: rescues 0->0, nightWalks 0->14, outdoorReturns 0->0, vetoes 0->4, withdrawals 0->0.

### r11-d-2

- `npc-schedule/home-at-night/1+outdoor-limit/120min/1+reference-survival/1+lethal-day-withdrawal/1+walk-escort/1+recorded-survival-exit/1+supply-then-restart/1` vs `reference-rule/1`: survivors 3 -> 7, ending bleak -> normal; adds `npc-schedule/home-at-night/1`, `outdoor-limit/120min/1`, `reference-survival/1`, `lethal-day-withdrawal/1`, `walk-escort/1`, `recorded-survival-exit/1`, `supply-then-restart/1`; receipts: rescues 0->0, nightWalks 0->15, outdoorReturns 0->0, vetoes 0->1, withdrawals 0->0.

### r10-d

- `npc-schedule/home-at-night/1+outdoor-limit/120min/1+reference-survival/1+lethal-day-withdrawal/1+walk-escort/1+recorded-survival-exit/1+supply-then-restart/1` vs `reference-rule/1`: survivors 3 -> 8, ending bleak -> perfect; adds `npc-schedule/home-at-night/1`, `outdoor-limit/120min/1`, `reference-survival/1`, `lethal-day-withdrawal/1`, `walk-escort/1`, `recorded-survival-exit/1`, `supply-then-restart/1`; receipts: rescues 0->0, nightWalks 0->15, outdoorReturns 0->0, vetoes 0->1, withdrawals 0->0.

