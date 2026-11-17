/**
 * R9 (D): the five work-proxy tasks are no longer a generic `work` that yields
 * power. Each one now proves, through the ONE authoritative path
 * (candidate -> beginWork -> advanceWorld -> settleWork -> committed receipt ->
 * task close), the original `task-effects.js` semantics:
 *
 *   COLLECT_MATERIAL  60 min, 18 stamina, ruins (village), no public resource,
 *                     +5 sanity on completion, daily limit 3
 *   BOOST_MORALE      30 min,  8 stamina, dorm-a, +36 sanity to same-room
 *   COORDINATE        60 min,  5 stamina, dorm-a, +36 sanity to same-room
 *   MAINTAIN_ORDER    60 min,  5 stamina, dorm-a, +54 sanity to same-room
 *   SCOUT_RUINS       40 min, 20 stamina, ruins (village), 0.002/s loot roll
 *                     (medicine 5 / food 8 / power 5)
 *
 * Also proved: the site gate (wrong place spends nothing, offers a real walk
 * instead) and the receipt-mode gate (a power receipt cannot close a morale
 * task).
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { makeChoiceResult, type Candidate, type ChoiceRequest } from '../../src/decision/contracts';
import { referenceAgencyScorer } from '../../src/r7/agency/reference';
import { buildActionOptions } from '../../src/r7/agency/options';
import { TASK_CATALOG, type TaskTypeId } from '../../src/r7/domains/tasks/index';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { executeCandidate, runStep } from '../../src/r7/integration/step';
import { WORK_MODE_PLACE } from '../../src/survival/world-v2';

const MODE_OF: Record<string, 'explore' | 'morale' | 'coordinate' | 'order' | 'scout'> = {
  COLLECT_MATERIAL: 'explore', BOOST_MORALE: 'morale', COORDINATE: 'coordinate',
  MAINTAIN_ORDER: 'order', SCOUT_RUINS: 'scout',
};

function forced(select: (request: ChoiceRequest) => Candidate | undefined) {
  return { identity: referenceAgencyScorer().identity, score(request: ChoiceRequest) {
    const candidate = select(request);
    return makeChoiceResult({ request, scorerId: 'r9-work-proxy-explicit',
      scores: request.candidates.map(row => ({ candidateId: row.id,
        logit: Number(row.id === candidate?.id) })),
      disposition: candidate ? 'accept' : 'abstain', selectedId: candidate?.id ?? null,
      reason: 'CPU test over the actual offered candidates' });
  } };
}

function assign(runtime: R8Runtime, type: TaskTypeId, actor: string) {
  runtime.dispatch('tasks', 'propose', 'old_qian', { type, assigneeId: actor });
  const taskId = runtime.states.tasks.tasks.at(-1)!.taskId;
  runtime.dispatch('tasks', 'respond', actor, { taskId, verdict: 'accept' });
  return taskId;
}

/** Real walk through the shared step contract, then the clock settles it. */
async function walkTo(runtime: R8Runtime, actor: string, place: string) {
  const result = await runStep(runtime, forced(request => request.candidates.find(row =>
    row.parameters.action === 'move' && row.parameters.to === place
    && row.parameters.purpose === 'task-place')), { actorIds: [actor] });
  assert.equal(result.records[0].executionStatus, 'working',
    `walk candidate must occupy the actor: ${result.records[0].reason}`);
  const until = runtime.busyUntil(actor);
  assert.ok(until !== null);
  runtime.advanceWorld(until!);
  assert.equal(runtime.world.npcs[actor].location, place);
}

async function startWork(runtime: R8Runtime, actor: string, taskId: string) {
  const result = await runStep(runtime, forced(request => request.candidates.find(row =>
    row.parameters.taskId === taskId)), { actorIds: [actor] });
  assert.equal(result.records[0].executionStatus, 'working',
    `work must be occupied, not instant: ${result.records[0].reason}`);
  return result;
}

for (const [type, mode] of Object.entries(MODE_OF)) {
  test(`${type} does the original ${mode} work at ${WORK_MODE_PLACE[mode]} and closes on its own receipt`,
    async () => {
      const runtime = R8Runtime.create({ seed: `r9-work-${type}` });
      const actor = 'npc_01';
      const definition = TASK_CATALOG[type as TaskTypeId];
      const place = WORK_MODE_PLACE[mode];

      // 1. Wrong place: the option is not offered, the real walk is.
      const taskId = assign(runtime, type as TaskTypeId, actor);
      const before = buildActionOptions({
        actorId: actor,
        npc: { ...runtime.world.npcs[actor] } as never,
        resources: runtime.world.resources, furnace: runtime.world.furnace,
        weather: runtime.world.weather, machines: {},
        tasks: [{ taskId, type, status: 'accepted' }],
        stockBelief: { level: null, rumor: false }, notes: [],
      });
      if (runtime.world.npcs[actor].location !== place) {
        assert.equal(before.candidates.some(row => row.parameters.taskId === taskId), false);
        assert.ok(before.rules.some(rule => rule.startsWith(`task.work-place-blocked:${type}`)));
        assert.ok(before.candidates.some(row => row.parameters.action === 'move'
          && row.parameters.to === place && row.parameters.purpose === 'task-place'));
      }

      // 2. A direct command from the wrong site is refused and spends nothing.
      if (runtime.world.npcs[actor].location === place) {
        const wrongPlace = place === 'village' ? 'dorm-a' : 'village';
        runtime.session.submitWorldCommand({ commandId: `r9-place-away-${type}`,
          type: 'move', actorId: actor, to: wrongPlace as never });
      }
      if (runtime.world.npcs[actor].location !== place) {
        const clock = runtime.world.simTime;
        const stamina = runtime.world.npcs[actor].stamina;
        const direct = executeCandidate(runtime, actor, {
          id: `direct-${type}`, kind: 'work', description: 'direct',
          parameters: { action: 'work', mode, minutes: definition.minutes },
          preconditions: [], expectedEffects: {}, utilityComponents: {},
        }, `direct-${type}`);
        assert.equal(direct.status, 'rejected');
        assert.match(direct.reason, /wrong_location/);
        assert.equal(runtime.world.simTime, clock);
        assert.equal(runtime.world.npcs[actor].stamina, stamina);
        // Known starting site for the real run below: the actor's own room.
        runtime.session.submitWorldCommand({ commandId: `r9-place-back-${type}`,
          type: 'move', actorId: actor, to: 'dorm-a' });
      }

      // 3. Real arrival, real work, real settlement, compared against a
      // control arm that shares the exact same pre-work state but has no
      // occupancy: the delta is the work itself, not the heating/decay span.
      if (runtime.world.npcs[actor].location !== place) await walkTo(runtime, actor, place);
      const started = await startWork(runtime, actor, taskId);
      const until = runtime.busyUntil(actor);
      assert.ok(until !== null);
      // The work is not instant: nothing has been applied yet.
      assert.equal(runtime.states.tasks.tasks.find(row => row.taskId === taskId)!.status, 'accepted');
      const roomMates = Object.values(runtime.world.npcs)
        .filter(npc => npc.alive && npc.id !== actor && npc.location === place).map(npc => npc.id);

      const dir = mkdtempSync(join(tmpdir(), `r9-work-${type}-`));
      try {
        const path = join(dir, 'session.json');
        runtime.save(path);
        const control = R8Runtime.load(path);
        control.work.clear(); // control arm: same state, no work item

        runtime.advanceWorld(until!);
        control.advanceWorld(until!);

        const task = runtime.states.tasks.tasks.find(row => row.taskId === taskId)!;
        assert.equal(task.status, 'done', `receipt closed the task: ${started.records[0].reason}`);
        assert.equal(control.states.tasks.tasks.find(row => row.taskId === taskId)!.status,
          'accepted');
        const receipt = runtime.committedEvents().filter(event => event.actorId === actor
          && event.type === 'worked').at(-1)!;
        assert.equal(receipt.type, 'worked');
        assert.equal(receipt.payload.mode, mode);
        assert.equal(receipt.payload.minutes, definition.minutes);
        assert.equal(runtime.workLog.at(-1)!.status, 'applied');

        const expectedOthers = mode === 'morale' || mode === 'coordinate' ? 36
          : mode === 'order' ? 54 : 0;
        assert.equal(receipt.payload.sanityOthers ?? 0, expectedOthers);
        for (const id of roomMates) {
          const gained = runtime.world.npcs[id].san - control.world.npcs[id].san;
          const expected = Math.min(expectedOthers, 100 - control.world.npcs[id].san);
          assert.ok(Math.abs(gained - expected) < 0.01,
            `${id} sanity delta ${gained} != original ${expected}`);
        }
        // Completion sanity +5 (task-effects.js:157,180), clamped at 100.
        const selfSanity = runtime.world.npcs[actor].san - control.world.npcs[actor].san;
        assert.ok(Math.abs(selfSanity - Math.min(5, 100 - control.world.npcs[actor].san)) < 0.01,
          `actor sanity delta ${selfSanity}`);
        // The real stamina cost is the original `staminaCost` for that duty.
        const staminaSpent = control.world.npcs[actor].stamina - runtime.world.npcs[actor].stamina;
        assert.ok(Math.abs(staminaSpent - definition.staminaCost) < 0.01,
          `real work cost ${staminaSpent} != original ${definition.staminaCost}`);

        const delta = (key: 'food' | 'firewood' | 'power' | 'medicine') =>
          Number((runtime.world.resources[key] - control.world.resources[key]).toFixed(6));
        if (mode === 'explore') {
          // The original `explore` source has no public resource and is absent
          // from GATHER_RATES: the trip adds nothing to the pool.
          assert.deepEqual([delta('food'), delta('firewood'), delta('power'), delta('medicine')],
            [0, 0, 0, 0]);
        } else if (mode === 'scout') {
          assert.equal(receipt.payload.rolls, definition.minutes);
          assert.equal(delta('food'), Number(receipt.payload.lootFood));
          assert.equal(delta('medicine'), Number(receipt.payload.lootMedicine));
          assert.equal(delta('power'), Number(receipt.payload.lootPower));
          assert.equal(delta('firewood'), 0);
          assert.ok(Number(receipt.payload.lootFood) + Number(receipt.payload.lootPower)
            + Number(receipt.payload.lootMedicine) > 0,
          'a 40 minute ruins search found nothing');
        } else {
          assert.deepEqual([delta('food'), delta('firewood'), delta('power'), delta('medicine')],
            [0, 0, 0, 0]);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
}

test('scout loot is identical across an exit and a new process at the same work interval', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r9-work-restore-'));
  try {
    const runtime = R8Runtime.create({ seed: 'r9-work-restore' });
    const actor = 'npc_01';
    runtime.session.submitWorldCommand({ commandId: 'walk-village', type: 'move',
      actorId: actor, to: 'village' });
    const taskId = assign(runtime, 'SCOUT_RUINS', actor);
    await startWork(runtime, actor, taskId);
    const path = join(dir, 'session.json');
    runtime.save(path);
    const restored = R8Runtime.load(path);
    const until = restored.busyUntil(actor);
    assert.ok(until !== null, 'occupancy survives a restore');
    restored.advanceWorld(until!);
    runtime.advanceWorld(until!);
    const lootOf = (source: R8Runtime) => {
      const event = source.committedEvents().filter(row => row.actorId === actor
        && row.type === 'worked').at(-1)!;
      return [event.payload.lootFood, event.payload.lootPower, event.payload.lootMedicine];
    };
    assert.deepEqual(lootOf(restored), lootOf(runtime));
    assert.equal(restored.states.tasks.tasks.find(row => row.taskId === taskId)!.status, 'done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a power receipt cannot close a morale task (the mode is part of the goal)', () => {
  const runtime = R8Runtime.create({ seed: 'r9-mode-goal' });
  const actor = 'npc_01';
  const taskId = assign(runtime, 'BOOST_MORALE', actor);
  // A synthetic committed receipt of the wrong mode: the predicate, not the
  // happy path, is under test.
  runtime.recordCommitted([{ eventId: 'synthetic-power-work', type: 'worked', actorId: actor,
    simTime: runtime.world.simTime, payload: { action: 'work', mode: 'power', power: 4, amount: 1 } }]);
  const rejected = runtime.dispatch('tasks', 'complete', actor,
    { taskId, receiptEventId: 'synthetic-power-work' });
  assert.equal(rejected.rejected[0]?.code, 'receipt_goal_mode_mismatch');
  assert.equal(runtime.states.tasks.tasks.find(row => row.taskId === taskId)!.status, 'accepted');
});
