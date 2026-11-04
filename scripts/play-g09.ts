#!/usr/bin/env node
/**
 * G09-R1 worker C — the playable goal-choice CLI.
 *
 * Default is G08 behaviour (--goals legacy). With --goals negotiated the game
 * consumes ONE game-level request at a natural decision point, the same
 * session runs goal_choice then action, and the request store is the single
 * authority (saved/restored verbatim).
 *
 *   --new --root DIR --slot S [--goals legacy|negotiated] [--candidates self_only|choice]
 *        [--request npc_a=yield_once] [--satiety 40|60] [--live --http URL --model M]
 *   --load --path FILE [--step|--eat|--time N|--status|--save|--save-as SLOT]
 *
 * A loaded slot uses the SAVED model/mode/thinking/timeout: a conflicting flag
 * is refused before any HTTP. Load spends zero provider calls and never
 * re-chooses or re-issues a request.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { buildNeedsWorld, createNeedsGame } from '../src/needs/game';
import { createHttpProvider } from '../src/agent/providers/http';
import type { G08EffectiveConfig } from '../src/temporal/contracts';
import {
  G09_REQUEST_TEXT, G09_TIMEOUT_MS, G09_ALLOWED_GOALS,
  type GoalArm, type SatietyLevel,
} from '../src/negotiation/contracts';
import { createGoalRequest, createRequestStore, evaluateGoal, type GoalRequestStore } from '../src/negotiation/requests';
import {
  g09CheckpointPath, loadG09Checkpoint, restoreG09Game, saveG09Checkpoint,
} from '../src/negotiation/checkpoint';
import { g09RuntimeConfig } from './g09-eval-lib';

const USAGE = `Usage:
  play-g09 --new --root DIR --slot NAME [--goals legacy|negotiated] [--candidates self_only|choice]
           [--request npc_a=yield_once] [--satiety 40|60] [--live --http URL --model M]
           [--step] [--eat] [--time N] [--status] [--save]
  play-g09 --load --path FILE [--step] [--eat] [--time N] [--status] [--save] [--save-as SLOT]`;

function fail(message: string, code = 2): never {
  console.error(message);
  process.exit(code);
}

interface Args {
  root: string; slot: string; create: boolean; loadPath: string | null;
  goals: 'legacy' | 'negotiated'; candidates: GoalArm; satiety: SatietyLevel;
  request: string | null; live: boolean; http: string; model: string | null;
  step: boolean; eat: boolean; time: number | null; statusOnly: boolean;
  save: boolean; saveAs: string | null; failureBase: string | null; loadFlag: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    root: 'artifacts/g09-play', slot: 'demo', create: false, loadPath: null,
    goals: 'legacy', candidates: 'choice', satiety: 40, request: null,
    live: false, http: 'http://127.0.0.1:18872/v1/chat/completions', model: null,
    step: false, eat: false, time: null, statusOnly: false, save: false, saveAs: null, failureBase: null, loadFlag: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--root': args.root = argv[++i]; break;
      case '--slot': args.slot = argv[++i]; break;
      case '--new': args.create = true; break;
      case '--load': args.loadFlag = true; break;
      case '--path': args.loadPath = argv[++i]; break;
      case '--save-as': args.saveAs = argv[++i]; break;
      case '--save': args.save = true; break;
      case '--live': args.live = true; break;
      case '--http': args.http = argv[++i]; break;
      case '--model': args.model = argv[++i]; break;
      case '--step': args.step = true; break;
      case '--eat': args.eat = true; break;
      case '--status': args.statusOnly = true; break;
      case '--time': {
        const v = Number(argv[++i]);
        if (!Number.isInteger(v) || v <= 0) fail('--time expects a positive integer');
        args.time = v;
        break;
      }
      case '--goals': {
        const v = argv[++i];
        if (v !== 'legacy' && v !== 'negotiated') fail('--goals must be legacy|negotiated');
        args.goals = v;
        break;
      }
      case '--candidates': {
        const v = argv[++i];
        if (v !== 'self_only' && v !== 'choice') fail('--candidates must be self_only|choice');
        args.candidates = v;
        break;
      }
      case '--satiety': {
        const v = Number(argv[++i]);
        if (v !== 40 && v !== 60) fail('--satiety must be 40|60');
        args.satiety = v as SatietyLevel;
        break;
      }
      case '--request': args.request = argv[++i]; break;
      case '--help': case '-h': console.log(USAGE); process.exit(0); break;
      default: fail(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
    }
  }
  return args;
}

function providerFrom(args: Args, config: G08EffectiveConfig) {
  if (config.mode === 'live') {
    const provider = createHttpProvider({
      url: args.http, model: String(config.requestModel), enableThinking: config.thinking,
    });
    return () => provider;
  }
  // Reference mode: deterministic two-phase answers (documented, offline only).
  return () => ({
    async decide(input: { goalChoice?: unknown }) {
      return input.goalChoice === undefined ? '{"type":"eat"}' : '{"goal":"feed_self"}';
    },
  });
}

function printStatus(label: string, game: ReturnType<typeof createNeedsGame>, store: GoalRequestStore | null): void {
  const state = game.world.getState();
  const sessions = game.sessionsOf();
  const calls = sessions.reduce((sum, entry) => sum + entry.session.providerCalls, 0);
  console.log(`[${label}] calls=${calls} simTime=${state.simTime} food=${state.food?.kitchen}`);
  for (const entry of sessions) {
    console.log(`  ${entry.actorId} cycle=${entry.cycle} phase=${entry.session.phase} status=${entry.session.status} goal=${entry.session.goalBinding?.goal ?? '-'}`);
  }
  if (store !== null) {
    for (const request of Object.values(store.requests)) {
      console.log(`  request ${request.requestId}: status=${request.status} outcome=${request.outcome} expires=${request.expiresAtSimTime} processed=${store.processed.includes(request.requestId)}`);
    }
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.create === (args.loadPath !== null)) fail('choose exactly one of --new | --load --path');
  if (args.loadFlag && args.loadPath === null) fail('--load requires --path FILE');
  if (args.model !== null && args.loadPath !== null) {
    // The saved configuration wins; a conflicting flag is refused before HTTP.
    const loaded = loadG09Checkpoint(resolve(args.loadPath));
    if (!loaded.ok) fail(`cannot load: ${loaded.issues?.join('; ')}`);
    if (loaded.value.envelope.effectiveConfig.requestModel !== args.model) {
      fail(`model conflict: the slot was saved with ${JSON.stringify(loaded.value.envelope.effectiveConfig.requestModel)}, not ${JSON.stringify(args.model)}`);
    }
  }

  if (args.create) {
    mkdirSync(resolve(args.root), { recursive: true });
    const config: G08EffectiveConfig = {
      mode: args.live ? 'live' : 'reference',
      requestModel: args.model,
      thinking: true,
      timeoutMs: G09_TIMEOUT_MS,
    };
    const runtime = g09RuntimeConfig();
    const initialState = buildNeedsWorld({
      actorIds: [...runtime.actorIds], kitchenFood: 1,
      hunger: { npc_a: args.satiety, npc_b: 40, npc_c: 70 },
    });
    const game = createNeedsGame({
      episodeId: args.slot,
      initialState,
      actorIds: args.goals === 'negotiated' ? [...runtime.actorIds] : ['npc_a'],
      providerFor: providerFrom(args, config),
      mode: config.mode === 'live' ? 'live' : 'reference',
      thinking: config.thinking,
      needPolicy: args.goals === 'negotiated' ? runtime.needPolicy : 'one-shot',
      requestModel: config.requestModel ?? undefined,
      timeoutMs: config.timeoutMs,
      actionSet: args.goals === 'negotiated' ? runtime.actionSet : 'legacy',
      goalMode: args.goals,
      candidateSet: args.candidates,
      playerId: 'npc_b',
    });
    let store: GoalRequestStore | null = null;
    if (args.request !== null) {
      if (args.goals !== 'negotiated') fail('--request requires --goals negotiated');
      const [actor, kind] = args.request.split('=');
      if (actor !== 'npc_a' || kind !== 'yield_once') fail('--request expects npc_a=yield_once');
      const simTime = Number(game.world.getState().simTime ?? 0);
      const built = createGoalRequest({
        requestId: `${args.slot}-req-1`, episodeId: args.slot, to: 'npc_a',
        text: G09_REQUEST_TEXT, options: G09_ALLOWED_GOALS[args.candidates], createdAtSimTime: simTime,
        arm: args.candidates,
      });
      if (!built.ok) fail(`cannot build the request: ${built.issues.join('; ')}`);
      const enqueued = (game as unknown as { submitGoalRequest(r: unknown): { ok: boolean; issues?: string[] } }).submitGoalRequest(built.value);
      if (!enqueued.ok) fail(`cannot enqueue: ${(enqueued.issues ?? []).join('; ')}`);
      store = (game as unknown as { goalRequests(): GoalRequestStore }).goalRequests();
    }
    await runActions(args, game, store, config);
    return;
  }

  const loaded = loadG09Checkpoint(resolve(args.loadPath!));
  if (!loaded.ok) fail(`cannot load: ${loaded.issues?.join('; ')}`);
  const saved = loaded.value.envelope;
  args.failureBase = resolve(args.loadPath!).replace(/\.g09\.json$/, '.failure.json');
  args.candidates = saved.arm;
  args.satiety = saved.satiety;
  if (args.model !== null && saved.effectiveConfig.requestModel !== args.model) {
    fail(`model conflict: saved ${JSON.stringify(saved.effectiveConfig.requestModel)}`);
  }
  if (args.live && saved.effectiveConfig.mode !== 'live') fail('mode conflict: the slot is a reference slot');
  if (!args.live && saved.effectiveConfig.mode === 'live') fail('mode conflict: the slot is a live slot, pass --live');
  const factory = providerFrom(args, saved.effectiveConfig);
  let providerCalls = 0;
  const providerFor = () => {
    const provider = factory();
    return {
      async decide(input: { goalChoice?: unknown }, signal?: AbortSignal) {
        providerCalls += 1;
        return provider.decide(input as never, signal as AbortSignal);
      },
    };
  };
  const restored = restoreG09Game(loaded.value, { providerFor: providerFor as never, now: Date.now, playerId: 'npc_b' });
  if (!restored.ok) fail(`cannot restore: ${restored.issues?.join('; ')}`);
  console.log(`loaded ${args.loadPath} (${saved.arm}, saved ${saved.effectiveConfig.mode}/${saved.effectiveConfig.requestModel ?? '-'}) — zero calls, no re-choice`);
  await runActions(args, restored.value.game as ReturnType<typeof createNeedsGame>, restored.value.store, saved.effectiveConfig);
}

async function runActions(
  args: Args,
  game: ReturnType<typeof createNeedsGame>,
  store: GoalRequestStore | null,
  config: G08EffectiveConfig,
): Promise<void> {
  if (args.statusOnly) { printStatus(args.slot, game, store); return; }
  try {
    if (args.step) await game.advance();
    if (args.eat) {
      const eat = game.playerLine('player eat');
      console.log(`player eat -> ${JSON.stringify(eat)}`);
    }
    if (args.time !== null) {
      const advanced = (game as unknown as { advance_time?: (n: number) => unknown }).advance_time;
      if (typeof advanced !== 'function') fail('this game has no advance_time entry');
      console.log(`time -> ${JSON.stringify(advanced.call(game, args.time))}`);
    }
  } catch (error) {
    // A transport failure is recorded next to the slot, never as a success.
    const message = error instanceof Error ? error.message : String(error);
    const failurePath = args.failureBase ?? `${resolve(args.root, args.slot)}.failure.json`;
    mkdirSync(dirname(failurePath), { recursive: true });
    writeFileSync(failurePath, `${JSON.stringify({
      schema: 'frostecho.g09.run-failure/2', at: new Date().toISOString(),
      reason: message, config, phase: game.sessionsOf()[0]?.session.phase ?? null,
      sessionStatus: game.sessionsOf()[0]?.session.status ?? null,
      requests: store ?? null,
    }, null, 2)}\n`);
    console.error(`failed: ${message}`);
    process.exit(1);
  }
  // A committed call that ended provider_error/timeout/failed is a FAILURE:
  // nonzero exit, the failure record written separately, never a success slot.
  const failedSessions = game.sessionsOf().filter(entry => ['timeout', 'provider_error', 'failed', 'invalid_run'].includes(entry.session.status));
  if (failedSessions.length > 0) {
    const failurePath = args.failureBase ?? `${resolve(args.root, args.slot)}.failure.json`;
    mkdirSync(dirname(failurePath), { recursive: true });
    writeFileSync(failurePath, `${JSON.stringify({
      schema: 'frostecho.g09.run-failure/2',
      at: new Date().toISOString(),
      reason: failedSessions.map(entry => `${entry.actorId}: ${entry.session.status}`).join('; ')
      + failedSessions.flatMap(entry => (entry.session.steps ?? []).slice(-1).map(step => ` :: ${String(step.error ?? '')}`)).join(''),
      config,
      sessions: game.sessionsOf().map(entry => ({ actorId: entry.actorId, cycle: entry.cycle, status: entry.session.status, phase: entry.session.phase, providerCalls: entry.session.providerCalls })),
      requests: store ?? null,
    }, null, 2)}\n`);
    console.error(`failed: ${failedSessions.map(entry => entry.session.status).join('; ')}`);
    process.exit(1);
  }

  if (args.step || args.eat || args.time !== null) printStatus(args.slot, game, store);

  // The goal evaluator is exposed so a play session can report the selected goal.
  const session = game.sessionsOf()[0]?.session;
  if (session !== undefined && store !== null) {
    const binding = session.goalBinding;
    if (binding !== null) {
      const evaluation = evaluateGoal(binding, game.world.getState() as never, binding.goal === 'yield_once' ? 'npc_a' : 'npc_a', store.requests[binding.requestId] ?? null);
      console.log(`selected goal: ${binding.goal} achieved=${evaluation.achieved} basis=${evaluation.basis} (${evaluation.detail})`);
    }
  }

  if (args.save || args.saveAs !== null) {
    const slot = args.saveAs ?? args.slot;
    const state = store === null
      ? { arm: args.candidates, satiety: args.satiety, requests: createRequestStore(), binding: null }
      : {
        arm: args.candidates,
        satiety: args.satiety,
        requests: (game as unknown as { goalRequests(): GoalRequestStore }).goalRequests(),
        binding: store === null ? null : (game.sessionsOf()[0]?.session.goalBinding ?? null),
      };
    const saved = saveG09Checkpoint(resolve(args.root), slot, game, state, config);
    if (!saved.ok) fail(`cannot save: ${saved.issues?.join('; ')}`);
    console.log(`saved -> ${saved.value.path}`);
  }
}

void g09CheckpointPath;

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
