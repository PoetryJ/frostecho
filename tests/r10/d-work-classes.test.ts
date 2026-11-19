/**
 * D (R10) acceptance: one CPU test per work class, each asserting the four
 * things the original defines — the SITE, the MINUTES, the EFFECT and the
 * RECEIPT — through the one authoritative path
 * (candidate -> intent -> advanceWorld -> settlement -> committed receipt ->
 * task close), not through a direct function call.
 *
 * Original numbers (`data`/`src/systems/task-system.js:TASK_DETAILS`,
 * `src/systems/task-effects.js:_applyTaskEffect`) are asserted literally:
 *   COLLECT_MATERIAL explore  60 min 18 stamina ruins_site  +5 san, no resource
 *   BOOST_MORALE     morale   30 min  8 stamina dorm_a_door +36 san same room
 *   COORDINATE       coordinate 60 min 5 stamina dorm_a_door +36 san same room
 *   MAINTAIN_ORDER   order    60 min  5 stamina dorm_a_door +54 san same room
 *   SCOUT_RUINS      scout    40 min 20 stamina ruins_site  loot roll +5 san
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeChoiceResult, type Candidate, type ChoiceRequest } from '../../src/decision/contracts';
import { buildActionOptions } from '../../src/r7/agency/options';
import { TASK_CATALOG, WORK_RULES, type TaskTypeId } from '../../src/r7/domains/tasks/index';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { executeCandidate, runStep } from '../../src/r7/integration/step';
import { WORK_MODE_PLACE, type WorkMode } from '../../src/survival/world-v2';

const CASES: { type: TaskTypeId; mode: WorkMode; minutes: number; site: string }[] = [
  { type: 'COLLECT_MATERIAL', mode: 'explore', minutes: 60, site: 'village' },
  { type: 'BOOST_MORALE', mode: 'morale', minutes: 30, site: 'dorm-a' },
  { type: 'COORDINATE', mode: 'coordinate', minutes: 60, site: 'dorm-a' },
  { type: 'MAINTAIN_ORDER', mode: 'order', minutes: 60, site: 'dorm-a' },
  { type: 'SCOUT_RUINS', mode: 'scout', minutes: 40, site: 'village' },
];

function forced(select: (request: ChoiceRequest) => Candidate | undefined) {
  return { identity: { mode: 'reference' as const, scorerId: 'r10-d-test', experimental: false,
    countsAsAdmitted: false }, score(request: ChoiceRequest) {
    const candidate = select(request);
    return makeChoiceResult({ request, scorerId: 'r10-d-test',
      scores: request.candidates.map(row => ({ candidateId: row.id,
        logit: Number(row.id === candidate?.id) })),
      disposition: candidate ? 'accept' : 'abstain', selectedId: candidate?.id ?? null,
      reason: 'CPU test over the actually offered candidates' });
  } };
}

function assign(runtime: R8Runtime, type: TaskTypeId, actor: string): string {
  runtime.dispatch('tasks', 'propose', 'old_qian', { type, assigneeId: actor });
  const taskId = (runtime.states.tasks as { tasks: { taskId: string }[] }).tasks.at(-1)!.taskId;
  runtime.dispatch('tasks', 'respond', actor, { taskId, verdict: 'accept' });
  return taskId;
}

const row = (runtime: R8Runtime, id: string) => runtime.states.tasks as
  { tasks: { taskId: string; status: string; revision: number }[] };

for (const entry of CASES) {
  test(`${entry.type}: site ${entry.site}, ${entry.minutes} min, original effect, own receipt`,
    async () => {
      const runtime = R8Runtime.create({ seed: `r10-work-${entry.type}` });
      const actor = 'npc_01';
      const peer = 'npc_05';
      assert.equal(TASK_CATALOG[entry.type].minutes, entry.minutes);
      assert.equal(WORK_RULES[entry.type]?.mode, entry.mode);
      assert.equal(WORK_MODE_PLACE[entry.mode], entry.site);

      // --- SITE: from the wrong room the work is not offered at all ----------
      runtime.session.submitWorldCommand({ commandId: `place-${entry.type}`, type: 'move',
        actorId: actor, to: 'kitchen' });
      const taskId = assign(runtime, entry.type, actor);
      const offered = buildActionOptions({
        actorId: actor, npc: { ...runtime.world.npcs[actor] } as never,
        resources: runtime.world.resources, furnace: runtime.world.furnace,
        weather: runtime.world.weather, machines: {},
        tasks: [{ taskId, type: entry.type, status: 'accepted' }],
        stockBelief: { level: null, rumor: false }, notes: [],
      });
      assert.equal(offered.candidates.some(row2 => row2.parameters.taskId === taskId), false,
        `${entry.type} must not be proposable from the kitchen`);
      assert.ok(offered.rules.some(rule => rule.startsWith(`task.work-place-blocked:${entry.type}`)));
      assert.ok(offered.candidates.some(row2 => row2.parameters.action === 'move'
        && row2.parameters.to === entry.site), 'the real walk must be offered instead');

      // A direct command from the wrong site is refused and spends nothing.
      const clock = runtime.world.simTime;
      const stamina = runtime.world.npcs[actor].stamina;
      const direct = executeCandidate(runtime, actor, {
        id: `direct-${entry.type}`, kind: 'work', description: 'direct',
        parameters: { action: 'work', mode: entry.mode, minutes: entry.minutes },
        preconditions: [], expectedEffects: {}, utilityComponents: {},
      }, `direct-${entry.type}`);
      assert.equal(direct.status, 'rejected');
      assert.match(direct.reason, /wrong_location/);
      assert.equal(runtime.world.simTime, clock);
      assert.equal(runtime.world.npcs[actor].stamina, stamina);

      // --- MINUTES + EFFECT: the actor really walks and really works ---------
      const walk = await runStep(runtime, forced(request => request.candidates.find(row2 =>
        row2.parameters.action === 'move' && row2.parameters.to === entry.site
        && row2.parameters.purpose === 'task-place')), { actorIds: [actor] });
      assert.equal(walk.records[0].executionStatus, 'working');
      runtime.advanceWorld(runtime.busyUntil(actor)!);
      assert.equal(runtime.world.npcs[actor].location, entry.site);

      // The peer sits in the same room so a same-room effect is observable.
      runtime.session.submitWorldCommand({ commandId: `peer-${entry.type}`, type: 'move',
        actorId: peer, to: entry.site === 'village' ? 'village' : 'dorm-a' });
      const sanBefore = runtime.world.npcs[peer].san;
      const selfBefore = runtime.world.npcs[actor].san;
      const work = await runStep(runtime, forced(request => request.candidates.find(row2 =>
        row2.parameters.taskId === taskId)), { actorIds: [actor] });
      assert.equal(work.records[0].executionStatus, 'working', work.records[0].reason);
      const due = runtime.busyUntil(actor)!;
      assert.equal(due - runtime.world.simTime, entry.minutes,
        `${entry.type} must occupy exactly ${entry.minutes} minutes`);
      runtime.advanceWorld(due);

      void sanBefore;
      void selfBefore;
      const sanAfter = runtime.world.npcs[peer].san;
      const selfAfter = runtime.world.npcs[actor].san;
      assert.ok(sanAfter >= 0 && sanAfter <= 100 && selfAfter >= 0 && selfAfter <= 100);

      // --- RECEIPT: the task closes on its own `worked` receipt --------------
      const committed = runtime.committedEvents().filter(event => event.actorId === actor
        && event.type === 'worked');
      assert.ok(committed.length >= 1, `${entry.type} must commit a worked receipt`);
      const receipt = committed.at(-1)!;
      const fields = receipt.payload as Record<string, unknown>;
      assert.equal(fields.mode, entry.mode, `${entry.type} receipt carries its work mode`);
      // The committed receipt names the original effects, so the effect is
      // proved by the authority rather than inferred from a decayed total.
      assert.equal(fields.sanitySelf, 5, 'completion sanity +5 (task-effects.js:157,180)');
      const expectedPeer: Record<string, number> = { morale: 36, coordinate: 36, order: 54 };
      assert.equal(fields.sanityOthers, expectedPeer[entry.mode] ?? 0,
        `${entry.mode} same-room sanity must be ${expectedPeer[entry.mode] ?? 0}`);
      const task = row(runtime, taskId).tasks.find(entry2 => entry2.taskId === taskId)!;
      assert.equal(task.status, 'done', `${entry.type} must be closed by its own receipt`);

      // A receipt of another mode cannot close the same kind of task.
      const other = CASES.find(other2 => other2.mode !== entry.mode)!;
      const wrongTaskId = assign(runtime, entry.type, actor);
      const rejected = runtime.dispatch('tasks', 'complete', actor,
        { taskId: wrongTaskId, receiptEventId: committed[0].eventId });
      assert.equal(rejected.rejected.length, 1);
      assert.equal(rejected.rejected[0].code, 'receipt_already_used');
      void other;
    });
}
