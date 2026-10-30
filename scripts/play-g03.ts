/**
 * G03 workstream B — interactive two-NPC CLI.
 * step | run | status | player move dorm|kitchen | player eat | quit.
 * `run` never blocks the prompt: NPC steps proceed in the background while
 * player lines keep landing through the same Engine. Default policy is the
 * offline reference; --live uses the HTTP provider from the environment.
 */
import { createInterface } from 'node:readline/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHttpProvider, enableThinkingFromEnv, loadHttpConfigFromEnv } from '../src/agent/providers/http';
import { createReferenceProvider } from '../src/agent/providers/reference';
import type { Provider } from '../src/agent/contracts';
import { createMultiGame } from '../src/multi/game';
import type { MultiDecidingInfo } from '../src/multi/contracts';
import type { WorldState } from '../src/types';

interface CliOptions {
  live: boolean;
  episode: string;
  out: string;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { live: false, episode: `play-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`, out: 'artifacts/g03-play' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') options.live = true;
    else if (arg === '--episode') options.episode = argv[++i] ?? '';
    else if (arg === '--out') options.out = argv[++i] ?? '';
    else { console.error(`unknown argument ${arg}`); process.exit(2); }
  }
  if (!options.episode) { console.error('--episode requires a value'); process.exit(2); }
  return options;
}

/** Default playable world: everyone in the dorm, food in the kitchen (M1 layout). */
function defaultWorld(): WorldState {
  return {
    npcs: {
      npc_a: { id: 'npc_a', location: 'dorm', hunger: 0 },
      npc_b: { id: 'npc_b', location: 'dorm', hunger: 0 },
      npc_c: { id: 'npc_c', location: 'dorm', hunger: 0 },
    },
    food: { kitchen: 2, dorm: 0 },
    tick: 0,
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let providerFor: (actorId: string) => Provider;
  let mode: 'reference' | 'live' = 'reference';
  let thinking: boolean | null = null;
  if (options.live) {
    const config = loadHttpConfigFromEnv();
    if (!config) {
      console.error('live mode requires FROSTECHO_AGENT_URL and FROSTECHO_AGENT_MODEL in the environment');
      process.exit(2);
    }
    const enableThinking = enableThinkingFromEnv();
    providerFor = () => createHttpProvider({ ...config, enableThinking });
    mode = 'live';
    thinking = enableThinking;
  } else {
    providerFor = () => createReferenceProvider();
  }

  const game = createMultiGame({
    episodeId: options.episode,
    initialState: defaultWorld(),
    actorIds: ['npc_a', 'npc_c'],
    providerFor,
    mode,
    thinking,
    onDeciding: (info: MultiDecidingInfo) => {
      console.log(`[deciding] ${info.actorId} round ${info.round}: ${JSON.stringify(info.observation)}`);
    },
  });

  console.log(`G03 episode ${options.episode} (${mode}) — actors npc_a, npc_c; you are npc_b`);
  console.log('commands: step | run | status | player move dorm|kitchen | player eat | quit');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let running = false;

  const reportTurns = (): void => {
    const state = game.world.getState();
    for (const id of game.actorIds) {
      const s = state.npcs[id];
      if (s) console.log(`  ${id}: ${s.location} hunger=${s.hunger} status=${game.actorStatus(id)}`);
    }
    console.log(`  player: ${state.npcs.npc_b?.location ?? '?'} hunger=${state.npcs.npc_b?.hunger ?? '?'} food.kitchen=${state.food.kitchen}`);
  };

  const finishRun = (kind: string): void => {
    running = false;
    console.log(`[run ${kind}]`);
    reportTurns();
    if (kind === 'interrupted') {
      console.log('episode interrupted (timeout/provider error) — quitting');
      void game.close().then(() => rl.close());
    }
  };

  rl.on('line', (raw: string) => {
    const line = raw.trim();
    if (line === '' || line === 'help') {
      console.log('commands: step | run | status | player move dorm|kitchen | player eat | quit');
      rl.prompt();
      return;
    }
    if (line === 'quit') {
      void (async () => {
        await game.close();
        const record = game.snapshot();
        const dir = join(options.out, options.episode);
        mkdirSync(dir, { recursive: true });
        const file = join(dir, 'game.json');
        writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
        console.log(`saved ${file} (stopReason=${record.stopReason}, turns=${record.turns.length})`);
        rl.close();
      })();
      return;
    }
    if (line === 'status') {
      console.log(game.statusText());
      reportTurns();
      rl.prompt();
      return;
    }
    if (line === 'step') {
      void game.advance().then(outcome => {
        console.log(`[step ${outcome.kind}]`);
        reportTurns();
        rl.prompt();
      });
      return;
    }
    if (line === 'run') {
      if (running) console.log('[run already active]');
      else {
        running = true;
        console.log('[run started] keep typing player lines while NPCs decide');
        void game.run().then(kind => finishRun(kind));
      }
      rl.prompt();
      return;
    }
    if (line.startsWith('player ')) {
      const result = game.playerLine(line);
      if (result.ok) console.log(`[player accepted] ${result.command.commandId}`);
      else console.log(`[player rejected] ${result.error}`);
      reportTurns();
      rl.prompt();
      return;
    }
    console.log(`unknown command ${JSON.stringify(line)}`);
    rl.prompt();
  });
  rl.on('close', () => process.exit(0));
  rl.setPrompt('> ');
  rl.prompt();
}

void main();
