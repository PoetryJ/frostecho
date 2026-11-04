#!/usr/bin/env node
/**
 * G09 worker C — the playable goal-choice CLI.
 *
 *   play-g09 --new  --root DIR --slot S --arm self_only|choice --satiety 40|60
 *                   [--goal-answer feed_self|yield_once] [--live --http URL --model M]
 *                   [--goal] [--step] [--player-eat] [--status] [--save]
 *   play-g09 --load --root DIR --slot S [--goal|--step|--player-eat|--status|--save]
 *
 * Two phases, one session, one budget:
 *   --goal       the goal-choice phase (one provider call, no world command)
 *   --step       the action phase (one provider call, one command)
 *   --player-eat the player's single eat attempt
 *
 * A loaded slot spends ZERO provider calls and never chooses again: the
 * binding comes back from the checkpoint and the next --step is an action.
 * Offline (reference) mode is deterministic and marked as such in the output.
 */
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createNeedsGame, buildNeedsWorld } from '../src/needs/game';
import { createHttpProvider } from '../src/agent/providers/http';
import type { G08EffectiveConfig } from '../src/temporal/contracts';
import {
  G09_REQUEST_TEXT, G09_SELF_TEXT, G09_GOAL_DEADLINE_ROUND, G09_TIMEOUT_MS,
  type GoalArm, type GoalChoiceId, type GoalRequestSnapshot, type SatietyLevel,
} from '../src/negotiation/contracts';
import { createGoalRequest, decideGoalRequest } from '../src/negotiation/requests';
import { createG09ReferenceProvider } from '../src/negotiation/reference';
import {
  g09CheckpointPath, loadG09Checkpoint, restoreG09Game, saveG09Checkpoint,
  type G09Checkpoint,
} from '../src/negotiation/checkpoint';

const USAGE = `Usage:
  play-g09 --new --root DIR --slot NAME --arm self_only|choice --satiety 40|60 [--goal-answer G] [--live --http URL --model M] [--goal] [--step] [--player-eat] [--status] [--save]
  play-g09 --load --root DIR --slot NAME [--goal] [--step] [--player-eat] [--status] [--save] [--live --http URL --model M]`;

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

interface Args {
  root: string; slot: string; create: boolean; load: boolean; save: boolean;
  arm: GoalArm; satiety: SatietyLevel; goalAnswer: GoalChoiceId;
  live: boolean; http: string; model: string | null;
  goal: boolean; step: boolean; playerEat: boolean; statusOnly: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    root: 'artifacts/g09-play', slot: 'demo', create: false, load: false, save: false,
    arm: 'choice', satiety: 40, goalAnswer: 'feed_self', live: false,
    http: 'http://127.0.0.1:18872/v1/chat/completions', model: null,
    goal: false, step: false, playerEat: false, statusOnly: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    switch (a) {
      case '--root': args.root = argv[++i]; break;
      case '--slot': args.slot = argv[++i]; break;
      case '--new': args.create = true; break;
      case '--load': args.load = true; break;
      case '--save': args.save = true; break;
      case '--live': args.live = true; break;
      case '--http': args.http = argv[++i]; break;
      case '--model': args.model = argv[++i]; break;
      case '--goal': args.goal = true; break;
      case '--step': args.step = true; break;
      case '--player-eat': args.playerEat = true; break;
      case '--status': args.statusOnly = true; break;
      case '--arm': {
        const v = argv[++i];
        if (v !== 'self_only' && v !== 'choice') fail('--arm must be self_only|choice');
        args.arm = v;
        break;
      }
      case '--satiety': {
        const v = Number(argv[++i]);
        if (v !== 40 && v !== 60) fail('--satiety must be 40|60');
        args.satiety = v as SatietyLevel;
        break;
      }
      case '--goal-answer': {
        const v = argv[++i];
        if (v !== 'feed_self' && v !== 'yield_once') fail('--goal-answer must be feed_self|yield_once');
        args.goalAnswer = v;
        break;
      }
      case '--help': case '-h': console.log(USAGE); process.exit(0); break;
      default: fail(`unknown argument ${JSON.stringify(a)}\n${USAGE}`);
    }
  }
  return args;
}

function effectiveConfig(args: Args): G08EffectiveConfig {
  if (args.live && args.model === null) fail('--live requires --model');
  const mode = args.live ? 'live' : 'reference';
  const config: G08EffectiveConfig = {
    mode,
    requestModel: args.model,
    thinking: true,
    timeoutMs: G09_TIMEOUT_MS,
  };
  return config;
}

function providerFor(args: Args, config: G08EffectiveConfig) {
  if (config.mode === 'live') {
    const provider = createHttpProvider({
      url: args.http, model: String(config.requestModel), enableThinking: config.thinking,
    });
    return () => provider;
  }
  const provider = createG09ReferenceProvider({ goal: args.goalAnswer });
  return () => provider;
}

function goalProtocol(args: Args, requestId: string | null) {
  return {
    arm: args.arm,
    requestId,
    text: args.arm === 'choice' ? G09_REQUEST_TEXT : G09_SELF_TEXT,
    options: args.arm === 'choice' ? (['feed_self', 'yield_once'] as const) : (['feed_self'] as const),
    deadlineAfterRound: G09_GOAL_DEADLINE_ROUND,
    playerId: 'npc_b',
  };
}

function printStatus(label: string, game: ReturnType<typeof createNeedsGame>, request: GoalRequestSnapshot | null, binding: unknown): void {
  const snapshot = game.snapshot();
  const sessions = game.sessionsOf();
  const calls = sessions.reduce((sum, entry) => sum + entry.session.providerCalls, 0);
  const state = game.world.getState();
  console.log(`[${label}] phase=${sessions[0]?.session.phase ?? 'none'} calls=${calls}`);
  console.log(`  food kitchen=${state.food?.kitchen} simTime=${state.simTime}`);
  console.log(`  npc_a hunger=${state.npcs?.npc_a?.hunger} npc_b hunger=${state.npcs?.npc_b?.hunger}`);
  if (request !== null) console.log(`  request ${request.requestId}: ${request.status} options=${JSON.stringify(request.options)}`);
  console.log(`  binding: ${binding === null ? 'none' : JSON.stringify(binding)}`);
  console.log(`  commands=${snapshot.commands.length} sessionStatus=${JSON.stringify(game.status().actors ?? {})}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.create === args.load) fail('choose exactly one of --new | --load');
  const root = resolve(args.root);
  mkdirSync(root, { recursive: true });
  const config = effectiveConfig(args);
  const makeProvider = providerFor(args, config);

  let game: ReturnType<typeof createNeedsGame>;
  let request: GoalRequestSnapshot | null = null;
  let binding: G09Checkpoint['binding'] = null;
  let arm: GoalArm = args.arm;
  let satiety: SatietyLevel = args.satiety;
  let loaded = false;

  if (args.create) {
    const initialState = buildNeedsWorld({
      actorIds: ['npc_a'], kitchenFood: 1,
      hunger: { npc_a: satiety, npc_b: 20, npc_c: 40 },
    });
    const requestId = args.arm === 'choice' ? `${args.slot}-req-1` : null;
    if (requestId !== null) {
      const created = createGoalRequest({
        requestId, episodeId: args.slot, to: 'npc_a', text: G09_REQUEST_TEXT,
        options: ['feed_self', 'yield_once'], createdAtSimTime: 0, arm: 'choice',
      });
      if (!created.ok) fail(`cannot create the request: ${created.issues.join('; ')}`);
      request = created.value;
    }
    game = createNeedsGame({
      episodeId: args.slot,
      initialState,
      actorIds: ['npc_a'],
      providerFor: makeProvider,
      mode: config.mode === 'live' ? 'live' : 'reference',
      thinking: config.thinking,
      needPolicy: 'one-shot',
      requestModel: config.requestModel ?? undefined,
      timeoutMs: config.timeoutMs,
      actionSet: 'legacy',
      goalProtocol: goalProtocol(args, requestId),
    });
  } else {
    const path = g09CheckpointPath(root, args.slot);
    const loadedSlot = loadG09Checkpoint(path);
    if (!loadedSlot.ok) fail(`cannot load ${path}: ${loadedSlot.issues?.join('; ')}`);
    const restored = restoreG09Game(loadedSlot.value, {
      providerFor: makeProvider,
      now: Date.now,
      playerId: 'npc_b',
    });
    if (!restored.ok) fail(`cannot restore ${path}: ${restored.issues?.join('; ')}`);
    game = restored.value.game as ReturnType<typeof createNeedsGame>;
    request = loadedSlot.value.envelope.request;
    binding = loadedSlot.value.envelope.binding;
    arm = loadedSlot.value.envelope.arm;
    satiety = loadedSlot.value.envelope.satiety;
    loaded = true;
    console.log(`loaded ${args.slot} (${arm}, satiety ${satiety}) — zero provider calls, no re-choice`);
  }

  // The session restores its own binding; the envelope is only cross-checked.
  const sessionBinding = () => {
    const sessions = game.sessionsOf();
    return sessions.length > 0 ? sessions[0]!.session.goalBinding : null;
  };

  if (args.statusOnly) {
    printStatus(`status ${args.slot}`, game, request, binding);
    return;
  }

  if (args.goal) {
    if (sessionBinding() !== null) {
      console.log('goal already decided — the session never chooses again');
    } else {
      await game.advance();
      const decided = sessionBinding();
      const session = game.sessionsOf()[0]?.session;
      if (decided === null) {
        console.log(`goal phase: no binding (session ${session?.status ?? 'missing'})`);
      } else {
        binding = decided;
        const round = decided.decidedRound;
        if (request !== null) {
          const applied = decideGoalRequest({
            raw: decided.raw, round, decidedAtSimTime: decided.decidedAtSimTime,
            request, episodeId: request.episodeId,
          });
          if (applied.ok) request = applied.value.request;
        }
        console.log(`goal phase: ${decided.goal} (request ${request === null ? 'none' : request.status})`);
      }
    }
  }

  if (args.step) {
    await game.advance();
  }

  if (args.playerEat) {
    const result = game.playerLine('player eat');
    console.log(`player eat -> ${JSON.stringify(result)}`);
  }

  if (args.goal || args.step || args.playerEat) {
    printStatus(`${loaded ? 'load' : 'new'} ${args.slot}`, game, request, binding);
  }

  if (args.save) {
    const saved = saveG09Checkpoint(root, args.slot, game, { arm, satiety, request, binding }, config);
    if (!saved.ok) fail(`cannot save: ${saved.issues?.join('; ')}`);
    console.log(`saved -> ${saved.value.path}`);
  }
}

main().catch(error => fail(error instanceof Error ? error.message : String(error)));
