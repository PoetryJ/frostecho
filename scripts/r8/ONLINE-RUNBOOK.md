# Live Gospel entry

Build once: `npm ci && npm run build`. Restore the original verified artwork with
`python handoff/20261113-r7-full-goal/bootstrap.py` before the browser/asset checks.

`play-sprint` keeps the old profile by default. The web entry starts new games
with `gospel-5.8.19`; existing web save pointers without a profile continue as
legacy. A Gospel save requires its `.r8.json` sidecar and restores the same
session object used by the task/commitment ledgers.

## Reference play

```
node scripts/r8/online-play.mjs --fresh --mode reference --steps 3 --out artifacts/live-reference
node dist/scripts/r8/playthrough.js --profile gospel-5.8.19 --mode reference --seed demo --out artifacts/fourday-reference
npm run play:r7
```

The web single-step and autoplay both send `game-step` to the profile-aware CLI.
The CLI and the four-day script both call `runStep`; selected actions enter the
same runtime authority and committed receipt ledger. Autoplay and explicit
advance use `advanceWorld` for the Gospel profile.

For the full village and seven interiors, add `--full-map` to either runner or
click **启用完整地图** in the web UI. The resident's authoritative map/cell controls
the view. Click a ground tile to walk; click a door to walk to its trigger and
cross. `r8-walk npc_01 <x> <y>`, `r8-door npc_01`, and `r8-inspect npc_01` expose
the same commands. Warehouse entry creates a personal stock observation; it
does not grant that knowledge to other residents. Once enabled, model movement
and night travel use the same original-map runtime. Save/continue preserves it.

New Gospel web sessions use the original 130 starting food; legacy sessions keep
120. An already running web server needs a normal restart to pick up this new
default. Existing saves keep their actual resource state.

## Real JEV service

Set `FROSTECHO_SCORER_COMMAND_JSON` to a JSON array containing the Python
executable, `research/decision-choice/jev05/action/serve_joint.py`, and its real
encoder/head arguments. The array is executed directly, without a shell.
Set `FROSTECHO_MODE=jev-experimental` before starting the web entry.

```
node scripts/r8/online-play.mjs --fresh --mode jev-experimental --steps 2 --actors npc_01,npc_02 --out artifacts/live-jev
node scripts/r8/online-play.mjs --fresh --full-map --mode jev-experimental --steps 6 --out artifacts/live-jev-original-maps
```

The service stays loaded across decisions. Each input is the
`frostecho.joint-encoding-request/1` envelope containing the actual ChoiceRequest,
exact `requestJson`, UTF-16 candidate spans, and renderer/text/input hashes.
The service response must bind requestId, candidateSetHash and inputSha256.
Identity is fixed after its first response. Experimental decisions are never
marked admitted; missing scorer configuration is an error, not a rule fallback.

The runner keeps stdin open until each reply. It then saves, exits, starts a new
process, compares the complete runtime and saved session/ledger documents, and
writes `online-report.json`, `cli.jsonl`, `scorer.jsonl`, and the save sidecars.
`scorer.jsonl` preserves raw requests/replies and stderr. Inspect its encoder
identity and call counters before calling a run a real model result.

For a manual session:

```
node dist/scripts/play-sprint.js --profile gospel-5.8.19 --mode jev-experimental --state saves/live/session.json --fresh
```

Send `r8-step npc_01`, wait for its result, then `save` and `quit`. Do not pipe a
single line and immediately close stdin: EOF intentionally drains/revokes jobs
within the existing barrier timeout. Cancel remains responsive while the model
is running. `--scorer-timeout-ms` defaults to 300000; a service timeout terminates
that child so its late response cannot satisfy another request.

## Targeted checks

```
node --test scripts/r8/live-entry.test.mjs
node --test scripts/r8/commitment-bridge.test.mjs
```

The JSONL service used in that test is explicitly a protocol fixture with zero
encoder forwards. Tests cover actual process/HTTP entry, queue cancellation,
legacy preservation, whole-state restore, seven real map image routes, and an
HTTP route across three interiors. They do not establish model quality or calibration.

Gospel task assignment exposes the fifteen domain task types. `assign npc_01
COLLECT_FOOD` proposes a task; `r8-respond npc_01 <taskId> accept` accepts it. The
web task panel exposes these responses. Morning proposals/votes still use the
documented reference policy.

`request npc_01 deliver-meal` and `request npc_01 supply-warehouse` now expose
their existing commitment/task IDs as goals and bound candidates in the same
R8 score request. No second task queue or legacy automatic game step runs.
After a personally witnessed shortage, the delivery promise proposes an
alternative source and waits for `respond-change <commitmentId> accept`. The
selected actions must actually gather, deposit, withdraw and deliver; only a
committed matching delivery/deposit receipt fulfils the original promise.
Cancellation/revision changes while scoring revoke the stale decision even
when world version and memory did not change. Other legacy goal types are not
bridged by this adapter. Negotiation rules and the reference story passing do
not by themselves prove the experimental JEV head will choose to fulfil it.
