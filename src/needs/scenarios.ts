/**
 * G05-R1 workstream C — the restored T1/T2/T3 matrix.
 *
 * Frozen by CONTRACTS.txt §4: every episode starts with A/C/B in the kitchen at
 * satiety 70, simTime 0, dorm food 0. T1 kitchen=4, T2 kitchen=2, T3 kitchen=0.
 * Each scenario runs under one-shot and recurring, in both rotation orders:
 * 12 trajectories, exactly 20 reference decisions (t1 recurring 4 + t3
 * recurring 6, per chain), 4 model-calling trajectories and 8 zero-call ones.
 * Zero-call trajectories still execute run/pump for real (T2 pumps 100 times).
 *
 * Expected values mirror the independent golden-g05.cjs oracle; they are
 * acceptance inputs, never tuned to the implementation.
 */
import type { Provider } from '../agent/contracts';
import { buildNeedsWorld, createNeedsGame } from './game';
import type { NeedPolicy, ReactiveRecord } from '../reactive/contracts';

export type G05ScenarioKind = 't1' | 't2' | 't3';
export type G05Chain = 'ac' | 'ca';

export interface G05Scenario {
  id: string;
  kind: G05ScenarioKind;
  chain: G05Chain;
  needPolicy: NeedPolicy;
  kitchenFood: number;
}

export const G05_SCENARIOS: readonly G05Scenario[] = (() => {
  const out: G05Scenario[] = [];
  for (const chain of ['ac', 'ca'] as const) {
    for (const kind of ['t1', 't2', 't3'] as const) {
      for (const needPolicy of ['one-shot', 'recurring'] as const) {
        out.push({
          id: `${chain}/${kind}/${needPolicy}`,
          kind,
          chain,
          needPolicy,
          kitchenFood: kind === 't1' ? 4 : kind === 't2' ? 2 : 0,
        });
      }
    }
  }
  return out;
})();

/** State view compared at each checkpoint; mirrors the golden oracle. */
export interface CheckpointView {
  simTime: number;
  a: number;
  b: number;
  c: number;
  food: number;
  calls: number;
}

export interface G05Checkpoint {
  label: string;
  /** Event count at the checkpoint — lets verification replay the world. */
  logCursor: number;
  /** Command-ledger count at the checkpoint — lets verification recount calls. */
  commandCursor: number;
  expected: Partial<CheckpointView>;
  actual: CheckpointView;
}

export interface G05ScenarioRecord extends ReactiveRecord {
  scenarioId: string;
  matrixVersion: string;
  /** Frozen experimental rule triple, recorded next to every episode. */
  rules: { LOW: number; GOAL: number; DECAY_PER_STEP: number };
  checkpoints: G05Checkpoint[];
  /** T2 only: cycle counts before/after the 100 pumps. */
  restCycles?: { before: Record<string, number>; after: Record<string, number> };
}

export interface G05ScenarioRun {
  scenario: G05Scenario;
  record: G05ScenarioRecord;
  scenarioPass: boolean;
  issues: string[];
}

export interface RunScenarioOptions {
  providerFor: (actorId: string) => Provider;
  mode: 'reference' | 'fixture' | 'live';
  timeoutMs?: number;
  thinking?: boolean;
  /** Live model name recorded on zero-request trajectories too. */
  requestModel?: string;
}

/** Fixed expectations, copied from the independent golden oracle. */
function expectations(scenario: G05Scenario): Record<string, Partial<CheckpointView>> {
  const recurring = scenario.needPolicy === 'recurring';
  if (scenario.kind === 't1') {
    return {
      meal1: recurring
        ? { simTime: 3, a: 70, b: 40, c: 70, food: 2, calls: 2 }
        : { simTime: 3, a: 40, b: 40, c: 40, food: 4, calls: 0 },
      meal2: recurring
        ? { simTime: 6, a: 70, b: 10, c: 70, food: 0, calls: 4 }
        : { simTime: 6, a: 10, b: 10, c: 10, food: 4, calls: 0 },
    };
  }
  if (scenario.kind === 't2') {
    return { rest100: { simTime: 2, a: 50, b: 50, c: 50, food: 2, calls: 0 } };
  }
  return {
    empty: { simTime: 3, a: 40, b: 40, c: 40, food: 0, calls: recurring ? 2 : 0 },
    waiting_decay: { simTime: 4, a: 30, b: 30, c: 30, food: 0, calls: recurring ? 2 : 0 },
    refed: recurring
      ? { simTime: 4, a: 90, b: 30, c: 90, food: 0, calls: 6 }
      : { simTime: 4, a: 30, b: 30, c: 30, food: 4, calls: 0 },
  };
}

export async function runScenario(scenario: G05Scenario, options: RunScenarioOptions): Promise<G05ScenarioRun> {
  const actorIds = scenario.chain === 'ac' ? ['npc_a', 'npc_c'] : ['npc_c', 'npc_a'];
  const game = createNeedsGame({
    episodeId: `g05-${scenario.id.replace(/\//g, '-')}`,
    initialState: buildNeedsWorld({ kitchenFood: scenario.kitchenFood }),
    actorIds,
    providerFor: options.providerFor,
    mode: options.mode,
    thinking: options.thinking ?? true,
    needPolicy: scenario.needPolicy,
    timeoutMs: options.timeoutMs,
    requestModel: options.requestModel,
  });
  const issues: string[] = [];
  const checkpoints: G05Checkpoint[] = [];
  const expected = expectations(scenario);
  let restCycles: G05ScenarioRecord['restCycles'];

  const check = (label: string): ReactiveRecord => {
    const record = game.snapshot();
    const actual: CheckpointView = {
      simTime: record.finalState.simTime ?? 0,
      a: record.finalState.npcs.npc_a.hunger,
      b: record.finalState.npcs.npc_b.hunger,
      c: record.finalState.npcs.npc_c.hunger,
      food: record.finalState.food.kitchen,
      calls: Object.values(record.actors).reduce((s, actor) => s + actor.providerCalls, 0),
    };
    const exp = label === 'initial' ? { simTime: 0, a: 70, b: 70, c: 70, calls: 0 } : expected[label];
    // Live judging (WORKER-C): model trajectories are judged by fixed checkpoint
    // end states, legality, local observations and the 5/10 budgets — the
    // reference call count is not required to match. Every checkpoint whose
    // expectation is zero calls (all of T2/one-shot, the initial check, the
    // empty/waiting stages) stays strictly zero: an unexpected request there is
    // still a failure.
    const liveAllowsExtraCalls = options.mode === 'live' && (exp.calls ?? 0) > 0;
    for (const [key, value] of Object.entries(exp)) {
      if (liveAllowsExtraCalls && key === 'calls') continue;
      if (actual[key as keyof CheckpointView] !== value) {
        issues.push(`${label}.${key}: ${actual[key as keyof CheckpointView]} != ${value}`);
      }
    }
    checkpoints.push({ label, logCursor: record.events.length, commandCursor: record.commands.length, expected: exp, actual });
    return record;
  };
  const advance = async (steps: number): Promise<void> => {
    const result = game.worldAdvanceTime(steps);
    if (!result.ok) issues.push(`advance(${steps}) rejected: ${result.error}`);
    await game.runUntilIdle();
  };

  try {
    await game.runUntilIdle();
    check('initial');
    if (scenario.kind === 't1') {
      await advance(3);
      check('meal1');
      await advance(3);
      check('meal2');
    } else if (scenario.kind === 't2') {
      await advance(1);
      await advance(1);
      const before = game.snapshot();
      const cyclesBefore = Object.fromEntries(Object.entries(before.actors).map(([id, a]) => [id, a.cycles]));
      for (let i = 0; i < 100; i++) {
        game.notifyWorldChange();
        await game.runUntilIdle();
      }
      const after = check('rest100');
      const cyclesAfter = Object.fromEntries(Object.entries(after.actors).map(([id, a]) => [id, a.cycles]));
      for (const id of game.actorIds) {
        if (cyclesAfter[id] !== cyclesBefore[id]) issues.push(`rest100.${id}: extra cycle`);
      }
      restCycles = { before: cyclesBefore, after: cyclesAfter };
    } else {
      await advance(3);
      const waiting = check('empty');
      if (scenario.needPolicy === 'recurring') {
        for (const id of game.actorIds) {
          if (waiting.actors[id]?.state !== 'waiting') issues.push(`empty.${id}: expected waiting, got ${waiting.actors[id]?.state}`);
        }
      }
      await advance(1);
      check('waiting_decay');
      if (!game.worldRestock('kitchen', 4).ok) issues.push('restock rejected');
      await game.runUntilIdle();
      check('refed');
    }
  } catch (err) {
    issues.push(String(err instanceof Error ? err.stack : err));
  } finally {
    await game.close();
  }

  const base = game.snapshot();
  const record: G05ScenarioRecord = {
    ...base,
    scenarioId: scenario.id,
    scenarioPass: issues.length === 0,
    matrixVersion: 'g05-r1-t123',
    rules: { LOW: 40, GOAL: 70, DECAY_PER_STEP: 10 },
    checkpoints,
    ...(restCycles !== undefined ? { restCycles } : {}),
  };
  return { scenario, record, scenarioPass: issues.length === 0, issues };
}
