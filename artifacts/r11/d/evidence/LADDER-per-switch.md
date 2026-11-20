# Four-day strategy ladder (same seed, one driver)

Driver: `src/r7/integration/fourday.ts`, entry `dist/scripts/r10/d-fourday.js`.
Map profile: engine 3-map (frozen).
Food: 130 (shared default; no row is handed extra).

| seed | strategy | ending | survivors | decisions | applied/rejected/cancelled | rescues | nightWalks | outdoorReturns | vetoes | withdrawals | council accept/decline/counter/reassigned | clockSha256 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| r11-d-base | `reference-rule/1` | bleak | 4 | 290 | 200/0/0 | 0 | 0 | 0 | 0 | 0 | 16/1/9/3 | `f23a04c53ae04367` |
| r11-d-base | `npc-schedule/home-at-night/1` | bleak | 4 | 304 | 200/0/0 | 0 | 14 | 0 | 0 | 0 | 12/0/12/0 | `0740bef8291c51f8` |
| r11-d-base | `npc-schedule/home-at-night/1+outdoor-limit/120min/1` | bleak | 4 | 304 | 200/0/0 | 0 | 14 | 0 | 0 | 0 | 12/0/12/0 | `0740bef8291c51f8` |
| r11-d-base | `npc-schedule/home-at-night/1+reference-survival/1` | perfect | 8 | 304 | 200/0/0 | 0 | 14 | 0 | 4 | 0 | 12/0/12/0 | `8b60c9f944dd3a65` |
| r11-d-base | `npc-schedule/home-at-night/1+lethal-day-withdrawal/1` | bleak | 4 | 304 | 200/0/0 | 0 | 14 | 0 | 0 | 0 | 12/0/12/0 | `0740bef8291c51f8` |
| r11-d-base | `npc-schedule/home-at-night/1+reference-survival/1+lethal-day-withdrawal/1` | perfect | 8 | 304 | 200/0/0 | 0 | 14 | 0 | 4 | 0 | 12/0/12/0 | `8b60c9f944dd3a65` |
| r11-d-base | `npc-schedule/home-at-night/1+walk-escort/1` | bleak | 4 | 304 | 200/0/0 | 0 | 14 | 0 | 0 | 0 | 12/0/12/0 | `0740bef8291c51f8` |
| r11-d-base | `npc-schedule/home-at-night/1+recorded-survival-exit/1` | bleak | 4 | 304 | 200/0/0 | 0 | 14 | 0 | 0 | 0 | 12/0/12/0 | `0740bef8291c51f8` |
| r11-d-base | `npc-schedule/home-at-night/1+outdoor-limit/120min/1+reference-survival/1+lethal-day-withdrawal/1+walk-escort/1+recorded-survival-exit/1+supply-then-restart/1` | perfect | 8 | 304 | 200/0/0 | 0 | 14 | 0 | 4 | 0 | 12/0/12/0 | `8b60c9f944dd3a65` |

## What each switch adds (per seed)

### r11-d-base

- `npc-schedule/home-at-night/1` vs `reference-rule/1`: survivors 4 -> 4, ending bleak -> bleak; adds `npc-schedule/home-at-night/1`; receipts: rescues 0->0, nightWalks 0->14, outdoorReturns 0->0, vetoes 0->0, withdrawals 0->0.
- `npc-schedule/home-at-night/1+outdoor-limit/120min/1` vs `npc-schedule/home-at-night/1`: survivors 4 -> 4, ending bleak -> bleak; adds `outdoor-limit/120min/1`; receipts: rescues 0->0, nightWalks 14->14, outdoorReturns 0->0, vetoes 0->0, withdrawals 0->0.
- `npc-schedule/home-at-night/1+reference-survival/1` vs `npc-schedule/home-at-night/1+outdoor-limit/120min/1`: survivors 4 -> 8, ending bleak -> perfect; adds `reference-survival/1`; receipts: rescues 0->0, nightWalks 14->14, outdoorReturns 0->0, vetoes 0->4, withdrawals 0->0.
- `npc-schedule/home-at-night/1+lethal-day-withdrawal/1` vs `npc-schedule/home-at-night/1+reference-survival/1`: survivors 8 -> 4, ending perfect -> bleak; adds `lethal-day-withdrawal/1`; receipts: rescues 0->0, nightWalks 14->14, outdoorReturns 0->0, vetoes 4->0, withdrawals 0->0.
- `npc-schedule/home-at-night/1+reference-survival/1+lethal-day-withdrawal/1` vs `npc-schedule/home-at-night/1+lethal-day-withdrawal/1`: survivors 4 -> 8, ending bleak -> perfect; adds `reference-survival/1`; receipts: rescues 0->0, nightWalks 14->14, outdoorReturns 0->0, vetoes 0->4, withdrawals 0->0.
- `npc-schedule/home-at-night/1+walk-escort/1` vs `npc-schedule/home-at-night/1+reference-survival/1+lethal-day-withdrawal/1`: survivors 8 -> 4, ending perfect -> bleak; adds `walk-escort/1`; receipts: rescues 0->0, nightWalks 14->14, outdoorReturns 0->0, vetoes 4->0, withdrawals 0->0.
- `npc-schedule/home-at-night/1+recorded-survival-exit/1` vs `npc-schedule/home-at-night/1+walk-escort/1`: survivors 4 -> 4, ending bleak -> bleak; adds `recorded-survival-exit/1`; receipts: rescues 0->0, nightWalks 14->14, outdoorReturns 0->0, vetoes 0->0, withdrawals 0->0.
- `npc-schedule/home-at-night/1+outdoor-limit/120min/1+reference-survival/1+lethal-day-withdrawal/1+walk-escort/1+recorded-survival-exit/1+supply-then-restart/1` vs `npc-schedule/home-at-night/1+recorded-survival-exit/1`: survivors 4 -> 8, ending bleak -> perfect; adds `outdoor-limit/120min/1`, `reference-survival/1`, `lethal-day-withdrawal/1`, `walk-escort/1`, `supply-then-restart/1`; receipts: rescues 0->0, nightWalks 14->14, outdoorReturns 0->0, vetoes 0->4, withdrawals 0->0.

