/**
 * G06 — playable checkpoint CLI (worker C).
 *
 * Default reference/recurring. `--live` resumes real-model play (env URL/model
 * required). `--load <file>` resumes a saved checkpoint instead of starting a
 * new episode: the world, NPC lifecycles, rotation, budgets and command-id
 * counters come from the file, never re-derived; restoring calls no model and
 * replays no old command.
 *
 * commands: step | run | status | world advance <1-120> | world restock
 * dorm|kitchen <1-10> | player move dorm|kitchen | player eat | save <slot> |
 * need one-shot|recurring | quit. save prints the path, simTime and NPC states.
 * quit/EOF finalize once; a closed save still refuses further play.
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
import { exportGameCheckpoint, restoreNeedsGame } from '../src/reactive/checkpoint';
import { loadCheckpoint, saveCheckpoint } from '../src/persistence/file-store';
import type { GameCheckpoint } from '../src/persistence/contracts';

interface CliOptions {
  live: boolean;
  episode: string;
  out: string;
  timeoutMs?: number;
  order: 'ac' | 'ca';
  need: NeedPolicy;
  load?: string;
  slots: string;
}

function usageError(message: string): never {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv: string[]): CliOptions {
  const stamp = new Date().toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
  const options: CliOptions = {
    live: false,
    episode: `play-g06-${stamp}`,
    out: 'artifacts/g06-play',
    order: 'ac',
    need: 'recurring',
    slots: 'artifacts/g06-play/slots',
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--live') options.live = true;
    else if (arg === '--episode') options.episode = argv[++i] ?? '';
    else if (arg === '--out') options.out = argv[++i] ?? '';
    else if (arg === '--timeout') options.timeoutMs = Number(argv[++i]);
    else if (arg === '--load') options.load = argv[++i] ?? '';
    else if (arg === '--slots') options.slots = argv[++i] ?? '';
    else if (arg === '--order') {
      const value = argv[++i] ?? '';
      if (value !== 'ac' && value !== 'ca') usageError('--order must be ac or ca');
      options.order = value;
    } else if (arg === '--need') {
      const value = argv[++i] ?? '';
      if (value !== 'one-shot' && value !== 'recurring') usageError('--need must be one-shot or recurring');
      options.need = value;
    } else usageError(`unknown argument ${arg}`);
  }
  if (!options.episode) usageError('--episode requires a value');
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    usageError('--timeout must be a positive number');
  }
  return options;
}

const USAGE = 'commands: step | run | status | world advance <1-120> | world restock dorm|kitchen <1-10> | player move dorm|kitchen | player eat | save <slot> | need one-shot|recurring | quit';

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const cliTimeoutMs = options.timeoutMs ?? liveTimeoutMs(process.env, LIVE_DECISION_TIMEOUT_MS);
  const cliThinking = G04_THINKING;
  const mode: 'reference' | 'live' = options.live ? 'live' : 'reference';
  let providerFor: (actorId: string) => Provider;

  let game: ReactiveGame;
  if (options.load !== undefined) {
    // G06 correction: read and validate the saved mode/model BEFORE building
    // any provider, so a mismatch makes zero HTTP requests. thinking and
    // timeout come from the checkpoint's effective config, not from the CLI.
    const loaded = loadCheckpoint(options.load);
    if (!loaded.ok) {
      console.error(`[load rejected] ${loaded.code}: ${(loaded.issues ?? []).join('; ')}`);
      process.exitCode = 2;
      return;
    }
    const checkpoint: GameCheckpoint = loaded.value;
    if (checkpoint.mode !== mode) {
      console.error(`[load rejected] MODE_CONFLICT: checkpoint was saved in mode '${checkpoint.mode}' but the CLI is '${mode}'${checkpoint.mode === 'fixture' ? ' (fixture checkpoints belong to the eval harness)' : ''}`);
      process.exitCode = 2;
      return;
    }
    if (checkpoint.mode === 'live') {
      const config = loadHttpConfigFromEnv();
      if (!config) {
        console.error('[load rejected] MODEL_CONFLICT: a live checkpoint was saved with a model but FROSTECHO_LLM_URL / FROSTECHO_LLM_MODEL are not set');
        process.exitCode = 2;
        return;
      }
      if (typeof checkpoint.requestModel !== 'string' || checkpoint.requestModel.length === 0) {
        console.error('[load rejected] MODEL_CONFLICT: live checkpoint does not record the model it was saved with');
        process.exitCode = 2;
        return;
      }
      if (checkpoint.requestModel !== config.model) {
        console.error(`[load rejected] MODEL_CONFLICT: checkpoint model '${checkpoint.requestModel}' != environment model '${config.model}' (no request was sent)`);
        process.exitCode = 2;
        return;
      }
      providerFor = () => createHttpProvider({ ...config, enableThinking: checkpoint.thinking });
    } else {
      providerFor = () => createReferenceProvider();
    }
    const restored = restoreNeedsGame(checkpoint, { providerFor });
    if (!restored.ok) {
      console.error(`[load rejected] ${restored.code}: ${(restored.issues ?? []).join('; ')}`);
      process.exitCode = 2;
      return;
    }
    game = restored.value;
    console.log(`G06 resumed ${checkpoint.episodeId} from ${options.load} (mode=${checkpoint.mode}, model=${checkpoint.requestModel ?? 'reference'}, thinking=${checkpoint.thinking}, timeout=${checkpoint.timeoutMs}ms, need=${checkpoint.needPolicy}) — no model call, no command replay`);
  } else {
    // New live episodes record the actual model they used so a later load can
    // refuse a different one instead of silently switching.
    let requestModel: string | undefined;
    if (mode === 'live') {
      const config = loadHttpConfigFromEnv();
      if (!config) {
        console.error('live mode requires FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL in the environment');
        process.exitCode = 2;
        return;
      }
      requestModel = config.model;
      providerFor = () => createHttpProvider({ ...config, enableThinking: cliThinking });
    } else {
      providerFor = () => createReferenceProvider();
    }
    const actorIds = options.order === 'ac' ? ['npc_a', 'npc_c'] : ['npc_c', 'npc_a'];
    game = createNeedsGame({
      episodeId: options.episode,
      initialState: buildNeedsWorld({ kitchenFood: 4 }),
      actorIds,
      providerFor,
      mode,
      thinking: cliThinking,
      needPolicy: options.need,
      timeoutMs: cliTimeoutMs,
      requestModel,
    });
    console.log(`G06 episode ${options.episode} (${mode}, model=${requestModel ?? 'reference'}, need=${options.need}, order=${options.order})`);
  }
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
    console.log(`  simTime=${status.simTime} food.kitchen=${status.food.kitchen} food.dorm=${status.food.dorm} player=${status.player.location ?? '?'} hunger=${status.player.hunger ?? '?'} closed=${status.closed}`);
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
      const dir = writeReactiveEpisode(options.out, record.episodeId, record);
      console.log(`saved ${dir} (stopReason=${record.stopReason})`);
    } catch (err) {
      fatal = true;
      console.error(`[save] ${err instanceof Error ? err.message : String(err)}`);
    }
    if (record.stopReason === 'interrupted' || fatal) process.exitCode = 1;
    else process.exitCode = 0;
    console.log(`[finalize ${reason}] exit=${String(process.exitCode)}`);
    rl.close();
    // The state is already durable on disk; exit instead of lingering on the
    // HTTP adapter's keep-alive sockets.
    setImmediate(() => process.exit(process.exitCode ?? 0));
  };

  const drive = (): void => {
    if (running || finalized) return;
    running = true;
    void game.runUntilIdle().then(outcome => {
      running = false;
      console.log(`[run ${outcome.kind}]`);
      report();
      if (outcome.kind === 'interrupted') void finalize('interrupted');
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
      else drive();
      rl.prompt();
      return;
    }
    if (line.startsWith('save')) {
      const slot = line === 'save' ? '' : line.slice(5);
      const exported = exportGameCheckpoint(game);
      if (!exported.ok) {
        console.log(`[save rejected] ${exported.code}: ${(exported.issues ?? []).join('; ')}`);
        rl.prompt();
        return;
      }
      const saved = saveCheckpoint(options.slots, slot, exported.value);
      if (!saved.ok) {
        // EXISTS / SAVE_BUSY are ordinary operation rejections; an IO_ERROR
        // means the save never reached disk and must fail the final exit code.
        if (saved.code === 'IO_ERROR') fatal = true;
        console.log(`[save rejected] ${saved.code}: ${(saved.issues ?? []).join('; ')}`);
        rl.prompt();
        return;
      }
      const status = game.status();
      console.log(`[save ok] ${saved.value.path} simTime=${status.simTime} closed=${status.closed} interrupted=${status.interrupted}`);
      for (const id of game.actorIds) {
        const actor = status.actors[id];
        console.log(`  ${id}: state=${actor?.state ?? '?'} cycle=${actor?.cycle ?? 0} calls=${actor?.providerCalls ?? 0} hunger=${actor?.hunger ?? '?'}`);
      }
      rl.prompt();
      return;
    }
    if (line.startsWith('player ')) {
      const result = game.playerLine(line);
      console.log(result.ok ? `[player accepted] ${result.detail}` : `[player rejected] ${result.detail}`);
      report();
      rl.prompt();
      return;
    }
    if (line.startsWith('world advance')) {
      const match = /^world advance ([0-9]+)$/.exec(line);
      if (match === null) {
        console.log('[advance rejected] usage: world advance <1-120>');
        rl.prompt();
        return;
      }
      const result = game.worldAdvanceTime(Number(match[1]));
      console.log(result.ok ? `[advance accepted] simTime ${result.before} -> ${result.after}` : `[advance rejected] ${result.error}`);
      report();
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
      const result = game.worldRestock(match[1] as Location, Number(match[2]));
      console.log(result.ok ? `[world accepted] ${result.command.commandId}` : `[world rejected] ${result.error ?? 'rejected'}`);
      report();
      if (result.ok) drive();
      rl.prompt();
      return;
    }
    if (line === 'need' || line.startsWith('need ')) {
      const arg = line === 'need' ? '' : line.slice(5);
      if (arg === '') console.log(`need policy = ${game.getNeedPolicy()}`);
      else if (arg === 'one-shot' || arg === 'recurring') {
        game.setNeedPolicy(arg);
        console.log(`need policy -> ${game.getNeedPolicy()}`);
      } else console.log('[need rejected] usage: need one-shot|recurring');
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
