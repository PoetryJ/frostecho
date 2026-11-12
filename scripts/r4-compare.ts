/**
 * R4 (G5) paired comparison — three memory arms over six classes, with the
 * SAME visible state, seed, external-event script and candidate rules; only
 * the stock-belief mechanism differs.
 *
 * Arms:
 *   raw        strong rules over raw events (newest direct evidence)
 *   summary    raw evidence + deterministic one-line shortage summary
 *   experience conditional notes with evidence/conditions/invalidation
 * (the historical `none` arm is kept in the report for continuity)
 *
 * Classes: rumor, witnessed-empty, restocked, blocked, explicit-release,
 * survival-conflict. Metrics: real deliveries, useless repeated actions,
 * negotiation->action consistency, restore latency and cost. Zero gain is an
 * acceptable research result and is reported as-is.
 *
 * Run: node dist/scripts/r4-compare.js [--out <dir>]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GameplayLoop, actorCell, MINUTES_PER_TILE, type MemoryArm }
  from '../src/gameplay-v2/loop';
import { BUILDINGS, MAPS, findPath } from '../src/spatial-v2/map';
import type { GameplayStepRecord } from '../src/gameplay-v2/decisions';

const WAREHOUSE = BUILDINGS.find(building => building.id === 'warehouse')!.door;

function travelTo(play: GameplayLoop, actorId: string, door: { x: number; y: number }): void {
  const route = findPath(MAPS.village, actorCell(play.session.world, actorId), door).path!;
  play.submitSpatial({ commandId: `cmp-t-${actorId}-${play.session.world.version}`,
    type: 'travel', actorId, route, minutesPerTile: MINUTES_PER_TILE });
}

function drain(play: GameplayLoop, actorId = 'npc_02'): void {
  travelTo(play, actorId, WAREHOUSE);
  play.submitSpatial({ commandId: 'cmp-drain-w', type: 'withdraw', actorId,
    place: 'warehouse', resource: 'food', amount: 4 });
}

export interface ArmMetrics {
  arm: MemoryArm;
  steps: number;
  outOfStockObserved: number;
  uselessRepeats: number;
  gatherActions: number;
  depositActions: number;
  deliveredMeals: number;
  taskStatus: string;
  completedAtStep: number | null;
  negotiations: number;
  negotiationActionMismatch: number;
  restoreLatencySteps: number | null;
  commandCount: number;
  simTimeAtEnd: number;
}

interface Scenario {
  name: string;
  klass: string;
  actorId: string;
  maxSteps: number;
  /** The setup creates (and may cancel) its own task; never assign implicitly. */
  manualTask?: boolean;
  setup?: (play: GameplayLoop) => void;
  atStep?: Record<number, (play: GameplayLoop) => void>;
}

const SCENARIOS: Scenario[] = [
  { name: 'rumor-consumed', klass: 'rumor', actorId: 'npc_01', maxSteps: 14,
    setup: play => { drain(play); play.session.tellRestock('npc_01'); } },
  { name: 'witnessed-empty', klass: 'witnessed-empty', actorId: 'npc_03', maxSteps: 12,
    setup: play => drain(play) },
  { name: 'restocked', klass: 'restocked', actorId: 'npc_04', maxSteps: 14,
    setup: play => drain(play),
    atStep: { 3: play => { play.submitSpatial({ commandId: 'cmp-refill',
      type: 'restock', place: 'warehouse', resource: 'food', amount: 3,
      source: 'player' }); play.session.tellRestock('npc_04'); } } },
  { name: 'blocked', klass: 'blocked', actorId: 'npc_05', maxSteps: 14,
    setup: play => play.submitSpatial({ commandId: 'cmp-seal', type: 'close-road',
      cells: [{ x: WAREHOUSE.x - 1, y: WAREHOUSE.y }, { x: WAREHOUSE.x, y: WAREHOUSE.y },
        { x: WAREHOUSE.x + 1, y: WAREHOUSE.y },
        { x: WAREHOUSE.x - 1, y: WAREHOUSE.y + 1 }, { x: WAREHOUSE.x, y: WAREHOUSE.y + 1 },
        { x: WAREHOUSE.x + 1, y: WAREHOUSE.y + 1 }] }),
    atStep: { 2: play => play.submitSpatial({ commandId: 'cmp-open', type: 'open-road',
      cells: [{ x: WAREHOUSE.x - 1, y: WAREHOUSE.y }, { x: WAREHOUSE.x, y: WAREHOUSE.y },
        { x: WAREHOUSE.x + 1, y: WAREHOUSE.y },
        { x: WAREHOUSE.x - 1, y: WAREHOUSE.y + 1 }, { x: WAREHOUSE.x, y: WAREHOUSE.y + 1 },
        { x: WAREHOUSE.x + 1, y: WAREHOUSE.y + 1 }] }) } },
  { name: 'explicit-release', klass: 'explicit-release', actorId: 'npc_06', maxSteps: 10,
    manualTask: true,
    setup: play => {
      drain(play);
      const asked = play.requestCommitment('npc_06', 'deliver-meal', { inputId: 'cmp-req' });
      if (asked.commitment.status === 'active') {
        play.cancelCommitment(asked.commitment.commitmentId, { inputId: 'cmp-cancel' });
      }
    } },
  { name: 'survival-conflict', klass: 'survival-conflict', actorId: 'npc_07', maxSteps: 12,
    manualTask: true,
    setup: play => {
      play.requestCommitment('npc_07', 'deliver-meal', { inputId: 'cmp-sv-req' });
      play.advance(3300);
    },
    atStep: {
      1: play => {
        const row = play.commitments.activeFor('npc_07')[0];
        const open = row?.changes.filter(change => change.status === 'open').at(-1);
        if (row && open) {
          play.respondChange(row.commitmentId, 'reject', { inputId: 'cmp-sv-no' });
        }
      },
      2: play => play.advance(600),
      4: play => play.advance(600),
      6: play => play.advance(600),
      8: play => play.advance(600),
    } },
];

function countOut(play: GameplayLoop, actorId: string): number {
  const store = play.session.memories.get(actorId);
  if (!store) return 0;
  const records = store.toJSON().records
    .filter(record => record.observerId === actorId);
  return records.filter(record => record.kind === 'out_of_stock').length;
}

function runArm(scenario: Scenario, arm: MemoryArm): ArmMetrics {
  const play = GameplayLoop.create(8, { seed: `r4-cmp-${scenario.name}`,
    food: scenario.klass === 'survival-conflict' ? 0 : undefined }, { memoryArm: arm });
  scenario.setup?.(play);
  const existing = play.board.activeFor(scenario.actorId)
    .find(entry => entry.kind === 'deliver-meal')
    ?? play.board.toJSON().find(entry => entry.actorId === scenario.actorId
      && entry.kind === 'deliver-meal');
  const task = existing ?? (scenario.manualTask ? null
    : play.assign(scenario.actorId, 'deliver-meal'));
  let outOfStock = 0;
  let uselessRepeats = 0;
  let gather = 0;
  let deposit = 0;
  let delivered = 0;
  let completedAt: number | null = null;
  let negotiations = 0;
  let mismatch = 0;
  let restoreLatency: number | null = null;
  let lastSelected: string | null = null;
  let commands = 0;
  for (let step = 0; step < scenario.maxSteps; step += 1) {
    const before = countOut(play, scenario.actorId);
    const acceptedBefore = play.commitments.all()
      .filter(row => row.changes.some(change => change.status === 'accepted')).length;
    const result = play.step();
    commands += 1;
    const after = countOut(play, scenario.actorId);
    outOfStock += after - before;
    const acceptedAfter = play.commitments.all()
      .filter(row => row.changes.some(change => change.status === 'accepted')).length;
    if (acceptedAfter > acceptedBefore) negotiations += 1;
    const record = result.records.find(entry => entry.actorId === scenario.actorId);
    if (record) {
      if (record.selectedId && record.selectedId === lastSelected) uselessRepeats += 1;
      lastSelected = record.selectedId;
      if (record.selectedId === 'g-gather-food') gather += 1;
      if (record.selectedId === 'g-deposit') deposit += 1;
      // Negotiation->action consistency: after an accepted alt-source, the very
      // next work action must be on the agreed chain.
      if (negotiations > 0 && restoreLatency === null
        && record.selectedId && ['g-deposit', 'g-gather-food', 'g-travel-warehouse',
          'g-withdraw', 'g-travel-kitchen', 'g-deliver'].includes(record.selectedId)) {
        restoreLatency = step + 1;
      }
    }
    delivered = play.session.world.spatial?.deliveredMeals ?? 0;
    if (task && completedAt === null && play.board.toJSON()
      .find(item => item.taskId === task.taskId)?.status === 'done') {
      completedAt = step + 1;
    }
    const action = scenario.atStep?.[step + 1];
    if (action) action(play);

  }
  // Consistency check: an accepted alt-source must lead to source actions.
  for (const row of play.commitments.all()) {
    const acceptedSource = row.changes.some(change => change.kind === 'alt-source'
      && change.status === 'accepted');
    if (acceptedSource && gather + deposit === 0 && delivered === 0) mismatch += 1;
  }
  return {
    arm, steps: scenario.maxSteps, outOfStockObserved: outOfStock,
    uselessRepeats, gatherActions: gather, depositActions: deposit,
    deliveredMeals: delivered,
    taskStatus: task
      ? play.board.toJSON().find(item => item.taskId === task.taskId)?.status ?? 'missing'
      : (play.commitments.all()[0]?.status ?? 'no-commitment'),
    completedAtStep: completedAt, negotiations,
    negotiationActionMismatch: mismatch, restoreLatencySteps: restoreLatency,
    commandCount: commands, simTimeAtEnd: play.session.world.simTime,
  };
}

function main(): void {
  const index = process.argv.indexOf('--out');
  const outDir = index !== -1 && process.argv[index + 1]
    ? resolve(process.argv[index + 1])
    : resolve('artifacts/sprint-r4/comparison');
  mkdirSync(outDir, { recursive: true });
  const arms: MemoryArm[] = ['none', 'raw', 'summary', 'experience'];
  const report = {
    schema: 'frostecho.r4.comparison/1',
    design: 'same seed / visible state / external script / candidate rules; '
      + 'the four arms differ ONLY in the stock-belief mechanism',
    arms,
    scenarios: SCENARIOS.map(scenario => ({
      name: scenario.name, klass: scenario.klass, actorId: scenario.actorId,
      maxSteps: scenario.maxSteps,
      metrics: Object.fromEntries(arms.map(arm => [arm, runArm(scenario, arm)])),
    })),
    reproCommand: 'node dist/scripts/r4-compare.js --out artifacts/sprint-r4/comparison',
    note: 'zero gain is an acceptable result; the report never claims model learning',
  };
  const path = join(outDir, 'comparison.json');
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const lines = report.scenarios.map(scenario => {
    const cells = arms.map(arm => {
      const metric = scenario.metrics[arm];
      return `${arm}: out=${metric.outOfStockObserved} del=${metric.deliveredMeals} `
        + `rep=${metric.uselessRepeats} ${metric.taskStatus}`;
    });
    return `${scenario.name} [${scenario.klass}] ${cells.join(' | ')}`;
  });
  process.stdout.write(`${JSON.stringify({ schema: report.schema, path,
    scenarios: report.scenarios.length })}\n${lines.join('\n')}\n`);
}

main();
