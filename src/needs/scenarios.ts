/**
 * G05 workstream C — the official 12-trajectory matrix.
 *
 * Each trajectory is one episode driven only by world commands (restock /
 * advance_time) plus at most one explicit run. A trajectory without a `run`
 * step must finish with zero provider calls. Chains differ only in the
 * autonomous rotation order; both start from hunger npc_a=40 / npc_c=20 in an
 * empty kitchen.
 */
import type { WorldState } from '../types';
import type { Provider } from '../agent/contracts';
import { buildNeedsWorld, createNeedsGame } from './game';
import type { NeedPolicy, ReactiveRecord } from '../reactive/contracts';

export type ScenarioStep =
  | { kind: 'time'; minutes: number }
  | { kind: 'restock'; location: 'kitchen' | 'dorm'; amount: number }
  | { kind: 'run' };

export interface ScenarioExpectation {
  /** Total provider calls across both actors; 0 for zero-call trajectories. */
  totalCalls: number;
  /** Per-actor provider calls when non-zero. */
  calls?: Record<string, number>;
  simTime: number;
  interrupted?: boolean;
  /** Final lifecycle states, keyed by actor id. */
  states?: Record<string, string>;
  /** Expected needs ledger rows: [actorId, period, outcome]. */
  needs?: [string, number, string][];
}

export interface NeedScenario {
  id: string;
  chain: 'ac' | 'ca';
  needPolicy: NeedPolicy;
  steps: ScenarioStep[];
  expected: ScenarioExpectation;
}

const time = (minutes: number): ScenarioStep => ({ kind: 'time', minutes });
const restock = (amount: number): ScenarioStep => ({ kind: 'restock', location: 'kitchen', amount });
const run: ScenarioStep = { kind: 'run' };

/** Six trajectories for one chain; the two chains mirror each other. */
function chainScenarios(chain: 'ac' | 'ca'): NeedScenario[] {
  const p = (name: string) => `${chain}/${name}`;
  return [
    {
      id: p('metab-never-six-periods'),
      chain,
      needPolicy: 'never',
      steps: [time(30), time(30), time(30), time(30), time(30), time(30)],
      expected: { totalCalls: 0, simTime: 180, states: {}, needs: [] },
    },
    {
      id: p('metab-boundaries-and-cap'),
      chain,
      needPolicy: 'never',
      steps: [time(9), time(1), time(120)],
      expected: { totalCalls: 0, simTime: 130, states: {}, needs: [] },
    },
    {
      id: p('advance-rejections'),
      chain,
      needPolicy: 'never',
      steps: [time(0), time(121), time(-5), time(10)],
      expected: { totalCalls: 0, simTime: 10, states: {}, needs: [] },
    },
    {
      id: p('restock-never-stays-silent'),
      chain,
      needPolicy: 'never',
      steps: [restock(3), time(30), time(30)],
      expected: { totalCalls: 0, simTime: 60, states: {}, needs: [] },
    },
    {
      id: p('oneshot-feed-loop'),
      chain,
      needPolicy: 'one-shot',
      steps: [restock(3), time(30), run],
      // npc_a is the only actor at/above the hunger-30 gate after 30 minutes
      // (43 vs 23), so both chains expect exactly one satisfied need for it.
      expected: { totalCalls: 3, simTime: 30, states: { npc_a: 'satisfied', npc_c: 'satisfied' }, needs: [['npc_a', 1, 'satisfied']] },
    },
    {
      id: p('recurring-need-expired'),
      chain,
      needPolicy: 'recurring',
      steps: [time(30), time(30), run],
      // The need outranks every autonomous cycle: npc_a burns exactly 10
      // decisions and expires. Its first stop (empty kitchen) lets the other
      // chain actor's initial cycle run once in between, so both chains spend
      // {npc_a: 10, npc_c: 1}.
      expected: {
        totalCalls: 11,
        simTime: 60,
        interrupted: true,
        calls: { npc_a: 10, npc_c: 1 },
        needs: [['npc_a', 1, 'expired']],
      },
    },
  ];
}

export const G05_SCENARIOS: readonly NeedScenario[] = [...chainScenarios('ac'), ...chainScenarios('ca')];

export interface ScenarioRun {
  scenario: NeedScenario;
  record: ReactiveRecord;
  scenarioPass: boolean;
  issues: string[];
}

export interface RunScenarioOptions {
  providerFor: (actorId: string) => Provider;
  mode: 'reference' | 'fixture' | 'live';
  timeoutMs?: number;
  thinking?: boolean;
}

/** Drive one scenario to completion and judge it against its expectation. */
export async function runScenario(
  scenario: NeedScenario,
  options: RunScenarioOptions,
): Promise<ScenarioRun> {
  const actorIds = scenario.chain === 'ac' ? ['npc_a', 'npc_c'] : ['npc_c', 'npc_a'];
  const initialState: WorldState = buildNeedsWorld({ actorIds });
  const game = createNeedsGame({
    episodeId: `g05-${scenario.id.replace('/', '-')}`,
    initialState,
    actorIds,
    providerFor: options.providerFor,
    mode: options.mode === 'reference' ? 'reference' : options.mode,
    thinking: options.thinking ?? (options.mode === 'live'),
    needPolicy: scenario.needPolicy,
    timeoutMs: options.timeoutMs,
  });

  const rejected: string[] = [];
  for (const step of scenario.steps) {
    if (step.kind === 'time') {
      const result = game.worldAdvanceTime(step.minutes);
      if (!result.ok) rejected.push(`${step.minutes}min: ${result.error}`);
    } else if (step.kind === 'restock') {
      const result = game.worldRestock(step.location, step.amount);
      if (!result.ok) rejected.push(`restock: ${result.error}`);
    } else {
      await game.runUntilIdle();
    }
  }
  await game.close();
  const record = game.snapshot();

  const issues: string[] = [];
  const totalCalls = Object.values(record.actors).reduce((sum, actor) => sum + actor.providerCalls, 0);
  if (totalCalls !== scenario.expected.totalCalls) {
    issues.push(`totalCalls ${totalCalls} != ${scenario.expected.totalCalls}`);
  }
  if (scenario.expected.calls !== undefined) {
    for (const [actorId, calls] of Object.entries(scenario.expected.calls)) {
      if (record.actors[actorId]?.providerCalls !== calls) {
        issues.push(`${actorId} calls ${record.actors[actorId]?.providerCalls} != ${calls}`);
      }
    }
  }
  const simTime = record.finalState.simTime ?? 0;
  if (simTime !== scenario.expected.simTime) issues.push(`simTime ${simTime} != ${scenario.expected.simTime}`);
  if (Boolean(record.stopReason === 'interrupted') !== Boolean(scenario.expected.interrupted)) {
    issues.push(`interrupted ${record.stopReason} != ${scenario.expected.interrupted === true}`);
  }
  for (const [actorId, state] of Object.entries(scenario.expected.states ?? {})) {
    if (record.actors[actorId]?.state !== state) {
      issues.push(`${actorId} state ${record.actors[actorId]?.state} != ${state}`);
    }
  }
  const actualNeeds = (record.needs ?? []).map(n => [n.actorId, n.period, n.outcome] as [string, number, string]);
  const expectedNeeds = scenario.expected.needs ?? [];
  if (JSON.stringify(actualNeeds) !== JSON.stringify(expectedNeeds)) {
    issues.push(`needs ${JSON.stringify(actualNeeds)} != ${JSON.stringify(expectedNeeds)}`);
  }
  if (scenario.needPolicy === 'never' && totalCalls === 0) {
    // Zero-call trajectories must also show no wake transitions at all.
    const wakes = record.transitions.filter(t => t.reason.includes('wake'));
    if (wakes.length > 0) issues.push(`zero-call trajectory woke actors: ${wakes.length}`);
  }

  return { scenario, record, scenarioPass: issues.length === 0, issues };
}
