/**
 * G04 workstream B — interactive lifecycle CLI.
 * step | run | status | player move dorm|kitchen | player eat |
 * world restock dorm|kitchen <1..10> | quit.
 *
 * Default policy is `event`: after `run` drains to idle, a world restock or a
 * player line re-pumps the scheduler, so a waiting NPC can resume. `--policy
 * legacy` keeps the G03 behaviour (a stopped NPC never wakes). `status` only
 * reads: it never issues a provider request.
 *
 * The record is written by the G04 writer (`writeReactiveEpisode`), not a
 * second copy. Every termination path (quit, EOF, interrupt, fatal error) goes
 * through one idempotent finalize(): exit 0 normal, 1 interrupted/failure,
 * 2 missing configuration.
 */
import { createInterface } from 'node:readline/promises';
import { LIVE_DECISION_TIMEOUT_MS } from '../src/agent/contracts';
import { liveTimeoutMs } from '../src/agent/live-record';
import { createHttpProvider, loadHttpConfigFromEnv } from '../src/agent/providers/http';
import { createReferenceProvider } from '../src/agent/providers/reference';
import type { Provider } from '../src/agent/contracts';
import type { Location } from '../src/types';
import { createReactiveGame } from '../src/reactive/game';
import type { ReactiveGame, WakePolicy } from '../src/reactive/contracts';
import { G04_THINKING } from '../src/reactive/contracts';
import { actorIdsFor, initialState } from '../src/reactive/scenarios';
import { writeReactiveEpisode } from '../src/reactive/record';

interface CliOptions {
  live: boolean;
  episode: string;
  out: string;
  /** Explicit --timeout only; otherwise env override, then the 30s live default. */
  timeoutMs?: number;
  policy: WakePolicy;
  order: 'ac' | 'ca';
}

function parseArgs(argv: string[]): CliOptions {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const options: CliOptions = {
    live: false,
    episode: `play-g04-${stamp}`,
    out: 'artifacts/g04-play',
    policy: 'event',
    order: 'ac',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') options.live = true;
    else if (arg === '--episode') options.episode = argv[++i] ?? '';
    else if (arg === '--out') options.out = argv[++i] ?? '';
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]);
    else if (arg === '--policy') {
      const value = argv[++i] ?? '';
      if (value !== 'legacy' && value !== 'event') { console.error('--policy must be legacy or event'); process.exit(2); }
      options.policy = value;
    } else if (arg === '--order') {
      const value = argv[++i] ?? '';
      if (value !== 'ac' && value !== 'ca') { console.error('--order must be ac or ca'); process.exit(2); }
      options.order = value;
    } else { console.error(`unknown argument ${arg}`); process.exit(2); }
  }
  if (!options.episode) { console.error('--episode requires a value'); process.exit(2); }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    console.error('--timeout must be a positive number');
    process.exit(2);
  }
  return options;
}

/** Effective live decision timeout: explicit --timeout > FROSTECHO_LIVE_TIMEOUT_MS > 30s. */
export function effectiveTimeoutMs(options: CliOptions, env: NodeJS.ProcessEnv): number {
  return options.timeoutMs ?? liveTimeoutMs(env, LIVE_DECISION_TIMEOUT_MS);
}

const USAGE = 'commands: step | run | status | player move dorm|kitchen | player eat | world restock dorm|kitchen <1-10> | quit';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const timeoutMs = effectiveTimeoutMs(options, process.env);
  let providerFor: (actorId: string) => Provider;
  let mode: 'reference' | 'live' = 'reference';
  if (options.live) {
    const config = loadHttpConfigFromEnv();
    if (!config) {
      console.error('live mode requires FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL in the environment');
      process.exitCode = 2;
      return;
    }
    mode = 'live';
    providerFor = () => createHttpProvider({ ...config, enableThinking: G04_THINKING });
  } else {
    providerFor = () => createReferenceProvider();
  }

  const game: ReactiveGame = createReactiveGame({
    episodeId: options.episode,
    initialState: initialState(),
    actorIds: actorIdsFor(options.order),
    providerFor,
    mode,
    thinking: G04_THINKING,
    wakePolicy: options.policy,
    timeoutMs,
  });

  console.log(`G04 episode ${options.episode} (${mode}, policy=${options.policy}, order=${options.order}) — you are npc_b`);
  console.log(USAGE);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let running = false;
  let finalized = false;
  let fatal = false;

  const report = (): void => {
    const status = game.status();
    for (const id of game.actorIds) {
      const actor = status.actors[id];
      console.log(`  ${id}: ${actor?.location ?? '?'} hunger=${actor?.hunger ?? '?'} state=${actor?.state ?? '?'} cycle=${actor?.cycle ?? 0}`);
    }
    console.log(`  player: ${status.player.location ?? '?'} hunger=${status.player.hunger ?? '?'} food.kitchen=${status.food.kitchen} food.dorm=${status.food.dorm}`);
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
    try {
      const dir = writeReactiveEpisode(options.out, options.episode, record);
      console.log(`saved ${dir} (stopReason=${record.stopReason}, wakePolicy=${record.wakePolicy})`);
    } catch (err) {
      fatal = true;
      console.error(`[save] ${err instanceof Error ? err.message : String(err)}`);
    }
    if (record.stopReason === 'interrupted' || fatal) process.exitCode = 1;
    else process.exitCode = 0;
    console.log(`[finalize ${reason}] exit=${String(process.exitCode)}`);
    rl.close();
  };

  const drive = (): void => {
    if (running || finalized) return;
    running = true;
    void game.runUntilIdle().then(outcome => {
      running = false;
      console.log(`[run ${outcome.kind}]`);
      report();
      if (outcome.kind === 'interrupted') {
        console.log('episode interrupted (timeout/provider error) — quitting');
        void finalize('interrupted');
      }
    });
  };

  rl.on('line', (raw: string) => {
    const line = raw.trim().replace(/\s+/g, ' ');
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
      report();
      console.log(`  commands=${game.status().commands} events=${game.status().events}`);
      rl.prompt();
      return;
    }
    if (line === 'step') {
      void game.advance().then(outcome => {
        console.log(`[step ${outcome.kind}]`);
        report();
        if (outcome.kind === 'interrupted') void finalize('interrupted');
        else rl.prompt();
      });
      return;
    }
    if (line === 'run') {
      if (running) console.log('[run already active]');
      else {
        console.log('[run started]');
        drive();
      }
      rl.prompt();
      return;
    }
    if (line.startsWith('player ')) {
      const result = game.playerLine(line);
      console.log(result.ok ? `[player accepted] ${result.detail}` : `[player rejected] ${result.detail}`);
      report();
      // Player input is an external change: re-check conditions and resume.
      if (result.ok) drive();
      rl.prompt();
      return;
    }
    if (line.startsWith('world restock ')) {
      const match = /^world restock (dorm|kitchen) ([0-9]+)$/.exec(line);
      if (match === null) {
        console.log('[world rejected] usage: world restock dorm|kitchen <1-10>');
        rl.prompt();
        return;
      }
      const location = match[1] as Location;
      const amount = Number(match[2]);
      const result = game.worldRestock(location, amount);
      console.log(result.ok ? `[world accepted] ${result.command.commandId}` : `[world rejected] ${result.error ?? 'rejected'}`);
      report();
      if (result.ok) drive();
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
