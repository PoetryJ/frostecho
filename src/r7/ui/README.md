# R7 browser entry

This is the player entry for the shared FrostEcho world. It does not start the
legacy `window.GST` simulation or keep a second authoritative state.

```text
python handoff/20261113-r7-full-goal/bootstrap.py
npm ci
npm run build
node dist/scripts/r7/play-web.js
```

Open `http://127.0.0.1:18740`. `--port 0` selects an available local port;
`--port 18741` selects a specific port. The server binds only to `127.0.0.1`.
No model endpoint is contacted by this entry. The current CLI uses its explicit
reference rules; a model integration must change the underlying CLI and report
its actual mode.

## Transport and saves

- One child process runs `dist/scripts/play-sprint.js` for the active game.
- Every UI action writes one original stdin command. Requests are correlated
  with the CLI's real `jobId`. The transport does not serialize cancellation
  behind a pending scorer or create an alternate command queue.
- The UI reads `observe`, `task-status`, and `where`. Its local state is a view
  cache, never an execution source.
- New games use `saves/r7/<sessionId>/session.json`. The CLI writes the world
  and existing task/experience/commitment/council sidecars. `last-session.json`
  points to the most recent game. Starting a new game first saves the old one.
- `web-cli.jsonl` retains submitted command lines and original result records.
  A web request timeout is reported as uncertain, not as a cancelled action.
- Auto play invokes `game-step` and reads back the world. If no action advanced
  simulation time, it invokes `advance 15`. If a travel/rest action advanced
  time, it does not add the idle interval. Pause prevents subsequent scheduled
  decisions; it does not undo an already accepted action.
- Save-and-exit, server Ctrl+C, and changing games reuse CLI `save`/`quit`.

## Original visual material

Static images and BGM are served read-only from the bootstrapped
`handoff/20261113-r7-full-goal/reference-extracted/assets/` directory, rather
than copied into `public/`. Map coordinates come from `src/spatial-v2/map.ts`.
The palette follows original `style.css`; images come from the original
village base, building artwork and resident portraits.

Resident display identities follow the exact order and `spriteDir` mapping in
the original `data/npc-configs.js`: `npc_01..08` map to 李婶、赵铁柱、王策、老钱、
苏岩、陆辰、歆玥、清璇. Authority IDs are unchanged. Displaying identity and
occupation does not assert that all original personality rules are integrated.

The entry exposes the engine's actual tasks, negotiations, council requests,
memory view and ending. At this stage the original seven indoor scenes,
production/crisis/reincarnation modules and autonomous council responses need
the shared domain integration. Unsupported operations are not simulated in the
browser. The command box follows real CLI syntax, and does not claim general
natural-language understanding.

## Verification

```text
node --test dist/tests/r7/ui/web-entry.test.js
```

The tests start the HTTP server and actual CLI subprocesses, execute travel and
commitment requests, save/quit/restart, compare restored authority state, and
check that automatic actions advance time and pause stops new scheduling.
They do not claim a visual browser review or real-model performance result.
