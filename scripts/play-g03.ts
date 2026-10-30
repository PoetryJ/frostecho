/**
 * G03 workstream B — interactive two-NPC CLI.
 * step | run | status | player move dorm|kitchen | player eat | quit.
 * `run` never blocks the prompt: NPC steps proceed in the background while
 * player lines keep landing through the same Engine. Default policy is the
 * offline reference; --live uses the HTTP provider from the environment.
 *
 * G03-R1: every termination path (quit, EOF, interrupt, fatal error) goes
 * through one idempotent finalize() that persists exactly one record and sets
 * the exit code (0 normal, 1 interrupted/failure, 2 configuration).
 */
import { createInterface } from 'node:readline/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHttpProvider, enableThinkingFromEnv, loadHttpConfigFromEnv } from '../src/agent/providers/http';
import { createReferenceProvider } from '../src/agent/providers/reference';
import type { Provider } from '../src/agent/contracts';
import { createMultiGame } from '../src/multi/game';
import type { MultiDecidingInfo } from '../src/multi/contracts';
import { loadMultiScenario } from '../src/multi/scenarios';

interface CliOptions {
  live: boolean;
  episode: string;
  out: string;
  timeoutMs: number;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { live: false, episode: `play-${new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14)}`, out: 'artifacts/g03-play', timeoutMs: 15_000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') options.live = true;
    else if (arg === '--episode') options.episode = argv[++i] ?? '';
    else if (arg === '--out') options.out = argv[++i] ?? '';
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]);
    else { console.error(`unknown argument ${arg}`); process.exit(2); }
  }
  if (!options.episode) { console.error('--episode requires a value'); process.exit(2); }
  return options;
}

const USAGE = 'commands: step | run | status | player move dorm|kitchen | player eat | quit';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  let providerFor: (actorId: string) => Provider;
  let mode: 'reference' | 'live' = 'reference';
  let thinking: boolean | null = null;
  if (options.live) {
    const config = loadHttpConfigFromEnv();
    if (!config) {
      console.error('live mode requires FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL in the environment');
      process.exitCode = 2;
      return;
    }
    thinking = enableThinkingFromEnv();
    providerFor = () => createHttpProvider({ ...config, enableThinking: thinking === true });
    mode = 'live';
  } else {
    providerFor = () => createReferenceProvider();
  }

  const scenario = loadMultiScenario('m1');
  const game = createMultiGame({
    episodeId: options.episode,
    initialState: structuredClone(scenario.initialState),
    actorIds: ['npc_a', 'npc_c'],
    providerFor,
    mode,
    thinking,
    timeoutMs: options.timeoutMs,
    onDeciding: (info: MultiDecidingInfo) => {
      console.log(`[deciding] ${info.actorId} round ${info.round}: ${JSON.stringify(info.observation)}`);
    },
  });

  console.log(`G03 episode ${options.episode} (${mode}) — actors npc_a, npc_c; you are npc_b`);
  console.log(USAGE);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let running = false;
  let finalized = false;
  let fatal = false;

  const reportTurns = (): void => {
    const state = game.world.getState();
    for (const id of game.actorIds) {
      const s = state.npcs[id];
      if (s) console.log(`  ${id}: ${s.location} hunger=${s.hunger} status=${game.actorStatus(id)}`);
    }
    console.log(`  player: ${state.npcs.npc_b?.location ?? '?'} hunger=${state.npcs.npc_b?.hunger ?? '?'} food.kitchen=${state.food.kitchen}`);
  };

  /** Single termination path: close once, save once, set the exit code. */
  const finalize = async (reason: string): Promise<void> => {
    if (finalized) return;
    finalized = true;
    running = false;
    try {
      await game.close();
    } catch (err) {
      fatal = true;
      console.error(`[close] ${err instanceof Error ? err.message : String(err)}`);
    }
    const record = game.snapshot();
    const dir = join(options.out, options.episode);
    try {
      mkdirSync(dir, { recursive: true });
      const file = join(dir, 'game.json');
      writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
      console.log(`saved ${file} (stopReason=${record.stopReason}, turns=${record.turns.length})`);
    } catch (err) {
      fatal = true;
      console.error(`[save] ${err instanceof Error ? err.message : String(err)}`);
    }
    if (record.stopReason === 'interrupted' || fatal) process.exitCode = 1;
    else process.exitCode = 0;
    console.log(`[finalize ${reason}] exit=${String(process.exitCode)}`);
    rl.close();
  };

  const finishRun = (kind: string): void => {
    running = false;
    console.log(`[run ${kind}]`);
    reportTurns();
    if (kind === 'interrupted') {
      console.log('episode interrupted (timeout/provider error) — quitting');
      void finalize('interrupted');
    }
  };

  rl.on('line', (raw: string) => {
    const line = raw.trim();
    if (line === '' || line === 'help') {
      console.log(USAGE);
      rl.prompt();
      return;
    }
    if (line === 'quit') {
      void finalize('quit');
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
        if (outcome.kind === 'interrupted') void finalize('interrupted');
        else rl.prompt();
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
  // EOF (Ctrl-D) is a normal termination and must persist like quit.
  rl.on('close', () => { void finalize('eof'); });
  rl.setPrompt('> ');
  rl.prompt();
}

void main();
