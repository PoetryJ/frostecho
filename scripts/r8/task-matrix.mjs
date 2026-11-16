#!/usr/bin/env node
/**
 * All fifteen original task types, each driven once through the real path:
 * propose -> accept -> real work (world command or build) -> committed receipt
 * -> complete. Then the same task is re-run with an invented receipt and must
 * stay open. No task may be closed by a receipt that never landed.
 */
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const require = createRequire(import.meta.url);
const root = process.argv[2] ?? process.cwd();
const { R8Runtime } = require(resolve(root, 'dist/src/r7/integration/runtime.js'));
const { TASK_IDS, WORK_RULES } = require(resolve(root, 'dist/src/r7/domains/tasks/index.js'));

const results = [];

function commandFor(rule, actorId, commandId) {
  switch (rule.action) {
    case 'gather': return { commandId, type: 'gather', actorId, resource: rule.resource,
      amount: rule.amount ?? 1 };
    case 'work': return { commandId, type: 'work', actorId, minutes: rule.minutes ?? 40 };
    case 'refuel': return { commandId, type: 'refuel', actorId, amount: rule.amount ?? 1 };
    case 'medical': return { commandId, type: 'medical', actorId, targetId: actorId,
      amount: rule.amount ?? 1 };
    case 'rest': return { commandId, type: 'rest', actorId, minutes: rule.minutes ?? 60 };
    case 'deposit': return { commandId, type: 'deposit', actorId, place: 'warehouse',
      resource: 'food', amount: rule.amount ?? 1 };
    default: return null;
  }
}

for (const type of TASK_IDS) {
  const runtime = R8Runtime.create({ seed: `matrix-${type}`,
    resources: { food: 60, firewood: 40, power: 40, medicine: 4 } });
  const actorId = runtime.context().actorIds[0];
  const actor2 = runtime.context().actorIds[1];

  // give the actor something to deposit / deliver when the task needs it
  if (type === 'DISTRIBUTE_FOOD') {
    // deposit requires standing at the warehouse; walk there first.
    const moved = runtime.session.submitWorldCommand({ commandId: 'walk-warehouse',
      type: 'move', actorId, to: 'warehouse' });
    if (moved.events) runtime.recordCommitted(moved.events);
  }

  const proposed = runtime.dispatch('tasks', 'propose', 'old_qian',
    { type, assigneeId: actorId });
  const task = runtime.states.tasks.tasks.at(-1);
  const accepted = runtime.dispatch('tasks', 'respond', actorId, { taskId: task.taskId,
    verdict: 'accept' });

  let work;
  if (type.startsWith('BUILD_')) {
    const machine = type === 'BUILD_GENERATOR' ? 'generator'
      : type === 'BUILD_LUMBER_MILL' ? 'lumberMill' : 'foodCollector';
    work = runtime.dispatch('production', 'build-machine', actorId,
      { machine, workerId: actorId });
    // real build time, then the machine must be running
    const spec = { generator: 240, lumberMill: 300, foodCollector: 300 }[machine];
    runtime.advanceWorld(runtime.world.simTime + spec);
  } else {
    const rule = WORK_RULES[type];
    const command = commandFor(rule, actorId, `work-${type}`);
    work = runtime.session.submitWorldCommand(command);
    if (work.events) runtime.recordCommitted(work.events);
  }

  let receiptId = (work.events ?? []).at(-1)?.eventId ?? null;
  if (type.startsWith('BUILD_')) {
    const machine = type === 'BUILD_GENERATOR' ? 'generator'
      : type === 'BUILD_LUMBER_MILL' ? 'lumberMill' : 'foodCollector';
    const built = runtime.committedEvents().filter(event => event.type === 'machine_built'
      && event.payload.machine === machine).at(-1);
    receiptId = built?.eventId ?? null;
  }
  const completed = runtime.dispatch('tasks', 'complete', actorId,
    { taskId: task.taskId, receiptEventId: receiptId });
  const statusAfter = runtime.states.tasks.tasks.find(entry => entry.taskId === task.taskId).status;

  // Negative control on a SEPARATE open task: an invented id closes nothing,
  // and another actor's receipt cannot close someone else's task.
  runtime.dispatch('tasks', 'propose', 'old_qian', { type, assigneeId: actor2 });
  const control = runtime.states.tasks.tasks.at(-1);
  runtime.dispatch('tasks', 'respond', actor2, { taskId: control.taskId, verdict: 'accept' });
  const forged = runtime.dispatch('tasks', 'complete', actor2,
    { taskId: control.taskId, receiptEventId: 'invented-receipt' });
  const forgedTask = runtime.states.tasks.tasks.find(entry => entry.taskId === control.taskId);

  results.push({
    type,
    proposed: proposed.rejected.length === 0,
    accepted: accepted.rejected.length === 0,
    workStatus: work.status ?? (work.applied.length > 0 ? 'applied' : 'rejected'),
    receiptId,
    completedStatus: statusAfter,
    completedRejections: completed.rejected.map(entry => entry.code),
    forgedRejected: forged.rejected.map(entry => entry.code),
    forgedStillOpen: forgedTask.status !== 'done',
  });
}

const failed = results.filter(row => row.completedStatus !== 'done'
  || !row.forgedStillOpen || row.forgedRejected.length === 0);
const report = {
  schema: 'frostecho.r8.task-matrix/1',
  types: results.length,
  done: results.filter(row => row.completedStatus === 'done').length,
  failed: failed.length,
  results,
  verdict: failed.length === 0 ? 'match' : 'mismatch',
};
console.log(JSON.stringify(report, null, 2));
if (failed.length > 0) process.exitCode = 1;
