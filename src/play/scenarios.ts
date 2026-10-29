import { Provider, RunOptions } from '../agent';
import { Engine } from '../engine';
import { RULES } from '../types';
import {
  DecisionTrace, GameRecord, PlayGame, createPlayGame,
} from './game';

export type ScenarioId = 's1' | 's2' | 's3';
export const SCENARIO_IDS: readonly ScenarioId[] = ['s1', 's2', 's3'];

export interface ScenarioJudgement {
  scenarioId: ScenarioId;
  scenarioPass: boolean;
  goalReached: boolean;
  reasons: string[];
  record: GameRecord;
}

export interface ScenarioOptions {
  scenarioId: ScenarioId;
  provider: Provider;
  batchId: string;
  thinking?: boolean | null;
  mode?: 'reference' | 'live' | 'fixture';
  timeoutMs?: number;
  now?: () => number;
  scheduleTimeout?: RunOptions['scheduleTimeout'];
  world?: Engine;
}

function actionType(decision: DecisionTrace): string | null {
  const parse = decision.step?.parse;
  if (!parse || !parse.ok) return null;
  return parse.action.type;
}

function checks(pairs: [boolean, string][], reasons: string[]): boolean {
  let ok = true;
  for (const [pass, label] of pairs) {
    if (pass) reasons.push(`pass: ${label}`);
    else {
      ok = false;
      reasons.push(`fail: ${label}`);
    }
  }
  return ok;
}

/** Player takes the last kitchen portion. Actor is always npc_b. */
export function playerTakeFood(game: PlayGame): void {
  const state = game.world.getState();
  if (state.npcs.npc_b?.location !== 'kitchen') game.playerLine('player move kitchen');
  if (game.world.getState().food.kitchen > 0) game.playerLine('player eat');
}

function judgeS1(record: GameRecord, reasons: string[]): boolean {
  const npc = record.finalState.npcs.npc_a;
  const other = record.finalState.npcs.npc_b;
  return checks([
    [record.goalReached === true, 'A goalReached'],
    [record.outcome === 'goal_reached', 'outcome goal_reached'],
    [npc?.hunger === 40 + RULES.EAT_HUNGER_RESTORE, 'A hunger 40→70'],
    [npc?.location === 'kitchen', 'A in kitchen'],
    [record.finalState.food.kitchen === 0, 'kitchen food consumed by A'],
    [record.commands.every(entry => entry.role === 'npc'), 'no player commands'],
    [record.commands.some(entry => entry.role === 'npc' && entry.command.type === 'move' && entry.exec.status === 'accepted'), 'A moved'],
    [record.commands.some(entry => entry.role === 'npc' && entry.command.type === 'eat' && entry.exec.status === 'accepted'), 'A ate'],
    [record.replayMatches, 'replay matches'],
    [other?.hunger === record.initialState.npcs.npc_b?.hunger, 'B hunger unchanged'],
    [other?.location === record.initialState.npcs.npc_b?.location, 'B location unchanged'],
  ], reasons);
}

function judgeS2(record: GameRecord, reasons: string[]): boolean {
  const npc = record.finalState.npcs.npc_a;
  const other = record.finalState.npcs.npc_b;
  const aHunger = record.events.filter(event => event.type === 'HungerChanged' && event.npcId === 'npc_a');
  const sawEmptyStop = record.decisions.some(decision =>
    decision.step?.observation.location === 'kitchen'
    && decision.step.observation.foodHere === 0
    && actionType(decision) === 'stop');
  const playerAte = record.commands.some(entry =>
    entry.role === 'player' && entry.command.type === 'eat' && entry.command.actorId === 'npc_b' && entry.exec.status === 'accepted');
  return checks([
    [record.goalReached === false, 'A goalReached stays false'],
    [record.outcome === 'stopped', 'outcome stopped'],
    [record.outcome === 'stopped' && record.goalReached === false, 'stop is not goalReached'],
    [npc?.hunger === record.initialState.npcs.npc_a?.hunger, 'A hunger stays 40'],
    [aHunger.length === 0, 'A has no HungerChanged'],
    [playerAte, 'B ate the food'],
    [other?.hunger === (record.initialState.npcs.npc_b?.hunger ?? 0) + RULES.EAT_HUNGER_RESTORE, 'B hunger increased'],
    [record.finalState.food.kitchen === 0, 'kitchen food is gone'],
    [sawEmptyStop, 'A observed no food and stopped'],
    [record.replayMatches, 'replay matches'],
  ], reasons);
}

function judgeS3(record: GameRecord, reasons: string[]): boolean {
  const npc = record.finalState.npcs.npc_a;
  const staleIndex = record.decisions.findIndex(decision =>
    decision.step?.observation.location === 'kitchen'
    && (decision.step.observation.foodHere ?? 0) >= 1
    && decision.step.command?.type === 'eat'
    && decision.step.exec?.reason === 'NO_FOOD'
    && decision.step.command.actorId === 'npc_a');
  const next = staleIndex >= 0 ? record.decisions[staleIndex + 1] : undefined;
  const aHunger = record.events.filter(event => event.type === 'HungerChanged' && event.npcId === 'npc_a');
  const playerAte = record.commands.some(entry =>
    entry.role === 'player' && entry.command.type === 'eat' && entry.exec.status === 'accepted');
  return checks([
    [record.goalReached === false, 'A goalReached stays false'],
    [record.outcome === 'stopped', 'outcome stopped'],
    [record.outcome === 'stopped' && record.goalReached === false, 'stop is not goalReached'],
    [staleIndex >= 0, 'stale observe submitted eat and got NO_FOOD'],
    [next?.step?.observation.foodHere === 0, 'next step observes no food'],
    [next?.inputFeedback?.kind === 'rejected' && next.inputFeedback.reason === 'NO_FOOD', 'next step receives NO_FOOD feedback'],
    [actionType(next ?? { round: 0, inputFeedback: null, terminalStatus: 'ready', providerCalled: false }) === 'stop', 'next step stops'],
    [npc?.hunger === record.initialState.npcs.npc_a?.hunger, 'A hunger stays 40'],
    [aHunger.length === 0, 'A has no HungerChanged'],
    [playerAte, 'B ate while A was waiting'],
    [record.replayMatches, 'replay matches'],
  ], reasons);
}

export function judgeScenario(scenarioId: ScenarioId, record: GameRecord): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  const pass = scenarioId === 's1' ? judgeS1(record, reasons)
    : scenarioId === 's2' ? judgeS2(record, reasons)
    : judgeS3(record, reasons);
  return { pass, reasons };
}

/**
 * S1: nobody else touches the food. A should move and eat.
 * S2: B eats before A's next observation. A should see an empty kitchen and stop.
 * S3: A has already observed kitchen food and is waiting. B eats. A's eat is NO_FOOD, then A stops.
 * scenarioPass is stored separately from goalReached.
 */
export async function runScenario(options: ScenarioOptions): Promise<ScenarioJudgement> {
  const game = createPlayGame({
    batchId: options.batchId,
    provider: options.provider,
    mode: options.mode ?? 'fixture',
    thinking: options.thinking ?? null,
    timeoutMs: options.timeoutMs,
    now: options.now,
    scheduleTimeout: options.scheduleTimeout,
    scenarioId: options.scenarioId,
    world: options.world,
  });

  if (options.scenarioId === 's3') {
    let stolen = false;
    game.session.onDeciding = phase => {
      if (stolen) return;
      if (phase.observation.location === 'kitchen' && phase.observation.foodHere >= 1) {
        stolen = true;
        playerTakeFood(game);
      }
    };
  }

  let stolen = false;
  while (game.session.status === 'ready' && !game.closed) {
    if (options.scenarioId === 's2' && !stolen && game.world.getState().food.kitchen > 0) {
      stolen = true;
      playerTakeFood(game);
    }
    const step = await game.npcStep();
    if (step.status === 'busy' || step.terminal) break;
  }

  const draft = game.snapshot();
  const judged = judgeScenario(options.scenarioId, draft);
  game.scenarioPass = judged.pass;
  game.reasons = judged.reasons;
  game.scenarioId = options.scenarioId;
  const record = game.snapshot();
  return {
    scenarioId: options.scenarioId,
    scenarioPass: judged.pass,
    goalReached: record.goalReached,
    reasons: judged.reasons,
    record,
  };
}
