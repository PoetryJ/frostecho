/**
 * R3 paired comparison (E): same-state branch control over six failure/success
 * classes. For every scenario both arms are loaded from ONE frozen snapshot
 * (same seed, same world state, same task board, same experience notes) and
 * then replay the SAME external-event script; the only difference is whether
 * the delivery policy consults conditional experience notes.
 *   arm "reference-only"  : useExperience=false (never learns stock levels)
 *   arm "with-experience" : useExperience=true  (notes invalidated by restock)
 *
 * Snapshots are written to <out>/snapshots/<scenario>.session.json (+ .tasks /
 * .experience sidecars). reset = reload the snapshot again; branch = load it
 * with the other arm flag; replay = rerun this command with the same --out.
 *
 * Run: node dist/scripts/r3-compare.js [--out <dir>]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { GameplayLoop, actorCell, MINUTES_PER_TILE } from '../src/gameplay-v2/loop';
import { BUILDINGS, MAPS, findPath } from '../src/spatial-v2/map';

type ExternalAction = (play: GameplayLoop) => void;

interface ArmMetrics {
  useExperience: boolean;
  fromSnapshotAtStep: number;
  steps: number;
  outOfStockObserved: number;
  gatherFallbackSteps: number;
  deliveredMeals: number;
  taskStatus: string;
  completedAtStep: number | null;
  simTimeAtEnd: number;
  experienceNotes: Array<{ lesson: string; valid: boolean; evidence: number }>;
}

const WAREHOUSE_DOOR = BUILDINGS.find(building => building.id === 'warehouse')!.door;
const KITCHEN_DOOR = BUILDINGS.find(building => building.id === 'kitchen')!.door;

function drainWarehouse(play: GameplayLoop, actorId: string): void {
  const session = play.session;
  play.submitSpatial({ commandId: 'cmp-drain-t', type: 'travel', actorId,
    route: findPath(MAPS.village, actorCell(session.world, actorId), WAREHOUSE_DOOR)!.path!,
    minutesPerTile: MINUTES_PER_TILE });
  play.submitSpatial({ commandId: 'cmp-drain-w', type: 'withdraw', actorId,
    place: 'warehouse', resource: 'food', amount: 4 });
}

const SEAL_CELLS = [{ x: WAREHOUSE_DOOR.x - 1, y: WAREHOUSE_DOOR.y },
  { x: WAREHOUSE_DOOR.x, y: WAREHOUSE_DOOR.y },
  { x: WAREHOUSE_DOOR.x + 1, y: WAREHOUSE_DOOR.y },
  { x: WAREHOUSE_DOOR.x - 1, y: WAREHOUSE_DOOR.y + 1 },
  { x: WAREHOUSE_DOOR.x, y: WAREHOUSE_DOOR.y + 1 },
  { x: WAREHOUSE_DOOR.x + 1, y: WAREHOUSE_DOOR.y + 1 }];

function sealWarehouseDoor(play: GameplayLoop): void {
  play.submitSpatial({ commandId: 'cmp-seal', type: 'close-road', cells: SEAL_CELLS });
}

interface Scenario {
  name: string;
  actorId: string;
  /** Branch class: what makes this scenario interesting. */
  failureClass: string;
  setup?: (play: GameplayLoop) => void;
  /** Steps run BEFORE the snapshot (both arms share this prefix). */
  branchAtStep: number;
  /** step -> external actions issued AFTER that absolute step ran. */
  atStep?: Record<number, ExternalAction[]>;
  maxSteps: number;
}

const SCENARIOS: Scenario[] = [
  { name: 'success', actorId: 'npc_01', failureClass: 'none-baseline',
    branchAtStep: 2, maxSteps: 12 },
  { name: 'empty-then-restock', actorId: 'npc_02', failureClass: 'missing-stock',
    setup: play => drainWarehouse(play, 'npc_01'), branchAtStep: 4,
    atStep: { 4: [play => {
      play.submitSpatial({ commandId: 'cmp-refill', type: 'restock', place: 'warehouse',
        resource: 'food', amount: 3, source: 'player' });
      play.session.tellRestock('npc_02');
    }] },
    maxSteps: 16 },
  { name: 'blocked-then-reopen', actorId: 'npc_03', failureClass: 'road-blocked',
    setup: play => sealWarehouseDoor(play), branchAtStep: 3,
    atStep: { 3: [play => play.submitSpatial({ commandId: 'cmp-reopen',
      type: 'open-road', cells: SEAL_CELLS })] },
    maxSteps: 16 },
  { name: 'empty-throughout', actorId: 'npc_04', failureClass: 'persistent-shortage',
    setup: play => drainWarehouse(play, 'npc_01'), branchAtStep: 4, maxSteps: 16 },
  { name: 'rumor-only-then-real-restock', actorId: 'npc_05', failureClass: 'rumor-conflict',
    setup: play => drainWarehouse(play, 'npc_01'), branchAtStep: 4,
    atStep: {
      4: [play => play.session.tellRestock('npc_05')],
      8: [play => play.submitSpatial({ commandId: 'cmp-late-refill', type: 'restock',
        place: 'warehouse', resource: 'food', amount: 2, source: 'player' })],
    },
    maxSteps: 20 },
  { name: 'detour-success', actorId: 'npc_06', failureClass: 'detour',
    setup: play => play.submitSpatial({ commandId: 'cmp-side-road', type: 'close-road',
      cells: [{ x: KITCHEN_DOOR.x + 1, y: KITCHEN_DOOR.y },
        { x: KITCHEN_DOOR.x + 2, y: KITCHEN_DOOR.y }] }),
    branchAtStep: 2, maxSteps: 14 },
];

function countOut(play: GameplayLoop, actorId: string): number {
  const store = play.session.memories.get(actorId);
  if (!store) return 0;
  const query = store.query({ observerId: actorId, now: play.session.world.simTime, topK: 100 });
  return query.items.filter(item => item.kind === 'out_of_stock').length;
}

/** Run one arm from a frozen snapshot through the shared external script. */
function runArm(snapshotPath: string, scenario: Scenario, useExperience: boolean,
  taskId: string): ArmMetrics {
  const play = GameplayLoop.load(snapshotPath, { useExperience });
  let outOfStock = 0;
  let gatherFallback = 0;
  let completedAtStep: number | null = null;
  let steps = 0;
  for (; steps < scenario.maxSteps; steps += 1) {
    const absolute = scenario.branchAtStep + steps + 1;
    const before = countOut(play, scenario.actorId);
    const result = play.step();
    outOfStock += countOut(play, scenario.actorId) - before;
    gatherFallback += result.records
      .filter(record => record.actorId === scenario.actorId)
      .filter(record => record.selectedId === 'g-gather-food'
        || record.selectedId === 'g-report-delay').length;
    if (completedAtStep === null
      && play.board.toJSON().find(item => item.taskId === taskId)?.status === 'done') {
      completedAtStep = steps + 1;
    }
    for (const action of scenario.atStep?.[absolute] ?? []) action(play);
  }
  return {
    useExperience,
    fromSnapshotAtStep: scenario.branchAtStep,
    steps,
    outOfStockObserved: outOfStock,
    gatherFallbackSteps: gatherFallback,
    deliveredMeals: play.session.world.spatial?.deliveredMeals ?? 0,
    taskStatus: play.board.toJSON().find(item => item.taskId === taskId)?.status ?? 'missing',
    completedAtStep,
    simTimeAtEnd: play.session.world.simTime,
    experienceNotes: Object.values(play.experience.toJSON()).map(note => ({
      lesson: note.lesson, valid: note.valid, evidence: note.evidenceEventIds.length })),
  };
}

function main(): void {
  const outIndex = process.argv.indexOf('--out');
  const outDir = outIndex !== -1 && process.argv[outIndex + 1]
    ? resolve(process.argv[outIndex + 1])
    : resolve('handoff/20261112-sprint-r3/artifacts/r3-comparison');
  const snapshotDir = join(outDir, 'snapshots');
  mkdirSync(snapshotDir, { recursive: true });

  const scenarios = SCENARIOS.map(scenario => {
    // Shared prefix: build the SAME state, then freeze it.
    const play = GameplayLoop.create(8, { seed: `r3-compare-${scenario.name}` },
      { useExperience: true });
    scenario.setup?.(play);
    const task = play.assign(scenario.actorId, 'deliver-meal');
    for (let step = 0; step < scenario.branchAtStep; step += 1) {
      play.step();
      for (const action of scenario.atStep?.[step + 1] ?? []) action(play);
    }
    const snapshotPath = join(snapshotDir, `${scenario.name}.session.json`);
    play.save(snapshotPath);
    writeFileSync(join(snapshotDir, `${scenario.name}.replay.json`), `${JSON.stringify({
      scenario: scenario.name, actorId: scenario.actorId, taskId: task.taskId,
      failureClass: scenario.failureClass, seed: `r3-compare-${scenario.name}`,
      branchAtStep: scenario.branchAtStep, maxSteps: scenario.maxSteps,
      externalEvents: Object.fromEntries(Object.entries(scenario.atStep ?? {})
        .map(([step, actions]) => [step, actions.length])),
      reset: `GameplayLoop.load('${snapshotPath}')`,
      branch: `GameplayLoop.load('${snapshotPath}', { useExperience: false | true })`,
      replay: 'node dist/scripts/r3-compare.js --out <same dir>',
    }, null, 2)}\n`, 'utf8');
    return {
      name: scenario.name,
      actorId: scenario.actorId,
      failureClass: scenario.failureClass,
      branchAtStep: scenario.branchAtStep,
      maxSteps: scenario.maxSteps,
      taskId: task.taskId,
      snapshot: snapshotPath,
      arms: {
        'reference-only': runArm(snapshotPath, scenario, false, task.taskId),
        'with-experience': runArm(snapshotPath, scenario, true, task.taskId),
      },
    };
  });

  const report = {
    schema: 'frostecho.r3.comparison/1',
    design: 'same frozen snapshot per scenario; arms differ only in conditional '
      + 'experience notes (never a permanent option disable)',
    metricDefinitions: {
      outOfStockObserved: 'out_of_stock records in the actor memory after the snapshot',
      gatherFallbackSteps: 'steps selecting a gather/report fallback candidate',
      completedAtStep: 'steps after the snapshot until the task board shows done',
    },
    arms: { 'reference-only': { useExperience: false },
      'with-experience': { useExperience: true } },
    scenarios,
    reproCommand: 'node dist/scripts/r3-compare.js --out <dir>',
  };
  const path = join(outDir, 'comparison.json');
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  process.stdout.write(`${JSON.stringify({ schema: report.schema, path,
    scenarios: report.scenarios.length })}\n`);
}

main();
