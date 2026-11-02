/**
 * G05 workstream D — interactive needs-lifecycle CLI.
 * step | run | status | time <1-120> | world restock dorm|kitchen <1-10> |
 * need never|one-shot|recurring | quit.
 *
 * Built on the G04 lifecycle CLI: the G05 additions are simulated-time
 * advancement (`time`), the runtime need-policy switch (`need`), and a status
 * line that shows simTime plus the need ledger. The record is written by the
 * shared writer (writeReactiveEpisode) under the g05 schema; every termination
 * path funnels into one idempotent finalize().
 */
import { createInterface } from 'node:readline/promises';
import { LIVE_DECISION_TIMEOUT_MS, type Provider } from '../src/agent/contracts';
import { liveTimeoutMs } from '../src/agent/live-record';
import { createHttpProvider, loadHttpConfigFromEnv } from '../src/agent/providers/http';
import { createReferenceProvider } from '../src/agent/providers/reference';
import type { Location } from '../src/types';
import { buildNeedsWorld, createNeedsGame } from '../src/needs/game';
import { G04_THINKING, type NeedPolicy, type ReactiveGame } from '../src/reactive/contracts';
import { writeReactiveEpisode } from '../src/reactive/record';

interface CliOptions {
  live: boolean;
  episode: string;
  out: string;
  timeoutMs?: number;
  order: 'ac' | 'ca';
  need: NeedPolicy;
}

function parseArgs(argv: string[]): CliOptions {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const options: CliOptions = {
    live: false,
    episode: `play-g05-${stamp}`,
    out: 'artifacts/g05-play',
    order: 'ac',
    need: 'one-shot',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') options.live = true;
    else if (arg === '--episode') options.episode = argv[++i] ?? '';
    else if (arg === '--out') options.out = argv[++i] ?? '';
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]);
    else if (arg === '--order') {
      const value = argv[++i] ?? '';
      if (value !== 'ac' && value !== 'ca') { console.error('--order must be ac or ca'); process.exit(2); }
      options.order = value;
    } else if (arg === '--need') {
      const value = argv[++i] ?? '';
      if (value !== 'one-shot' && value !== 'recurring') {
        console.error('--need must be one-shot or recurring (G05-R1 has no third arm)');
        process.exit(2);
      }
      options.need = value;
    } else { console.error(`unknown argument ${arg}`); process.exit(2); }
  }
  if (!options.episode) { console.error('--episode requires a value'); process.exit(2); }
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    console.error('--timeout must be a positive number');
    process.exit(2);
  }
  return options;
}

export function effectiveTimeoutMs(options: CliOptions, env: NodeJS.ProcessEnv): number {
  return options.timeoutMs ?? liveTimeoutMs(env, LIVE_DECISION_TIMEOUT_MS);
}

const USAGE = 'commands: step | run | status | world advance <1-10> | world restock dorm|kitchen <1-10> | need one-shot|recurring | quit';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const timeoutMs = effectiveTimeoutMs(options, process.env);
  // G05-R1-D: one thinking value feeds both the provider and the metadata.
  const thinking = G04_THINKING;
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
    providerFor = () => createHttpProvider({ ...config, enableThinking: thinking });
  } else {
    providerFor = () => createReferenceProvider();
  }

  const actorIds = options.order === 'ac' ? ['npc_a', 'npc_c'] : ['npc_c', 'npc_a'];
  const game: ReactiveGame = createNeedsGame({
    episodeId: options.episode,
    initialState: buildNeedsWorld({ kitchenFood: 4 }),
    actorIds,
    providerFor,
    mode,
    thinking,
    needPolicy: options.need,
    timeoutMs,
  });

  console.log(`G05 episode ${options.episode} (${mode}, need=${game.getNeedPolicy()}, order=${options.order})`);
  console.log(USAGE);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let running = false;
  let finalized = false;
  let fatal = false;

  const report = (): void => {
    const status = game.status();
    for (const id of game.actorIds) {
      const actor = status.actors[id];
      console.log(`  ${id}: ${actor?.location ?? '?'} hunger=${actor?.hunger ?? '?'} state=${actor?.state ?? '?'} cycle=${actor?.cycle ?? 0} calls=${actor?.providerCalls ?? 0}`);
    }
    console.log(`  simTime=${status.simTime} food.kitchen=${status.food.kitchen} food.dorm=${status.food.dorm} need=${game.getNeedPolicy()}`);
  };

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
      console.log(`saved ${dir} (stopReason=${record.stopReason}, needPolicy=${record.needPolicy ?? 'one-shot'})`);
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
        console.log('episode interrupted (need expiry / timeout / provider error) — quitting');
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
    if (line.startsWith('world advance')) {
      const match = /^world advance ([0-9]+)$/.exec(line);
      if (match === null) {
        console.log('[advance rejected] usage: world advance <1-10>');
        rl.prompt();
        return;
      }
      const result = game.worldAdvanceTime(Number(match[1]));
      console.log(result.ok
        ? `[advance accepted] simTime ${result.before} -> ${result.after}`
        : `[advance rejected] ${result.error}`);
      report();
      rl.prompt();
      return;
    }
    if (line === 'need' || line.startsWith('need ')) {
      const arg = line === 'need' ? '' : line.slice(5);
      if (arg === '') {
        console.log(`need policy = ${game.getNeedPolicy()}`);
      } else if (arg === 'one-shot' || arg === 'recurring') {
        game.setNeedPolicy(arg);
        console.log(`need policy -> ${game.getNeedPolicy()}`);
      } else {
        console.log('[need rejected] usage: need one-shot|recurring');
      }
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
  rl.on('close', () => { void finalize('eof'); });
  rl.setPrompt('> ');
  rl.prompt();
}

void main();
