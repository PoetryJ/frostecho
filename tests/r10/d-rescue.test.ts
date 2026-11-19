/**
 * D (R10): the rescue is a ROUTED rescue — walking, never a teleport.
 *
 * Original (`src/systems/event-system.js:370-401`): the rescuer must stand in the
 * victim's scene, have stamina > 30, the victim gains +0.5 bodyTemp and the
 * rescuer pays 10 stamina. The old port wrote `victim.location = 'medical'` and
 * granted +3 bodyTemp / +10 health / +5 stamina for free, which the authority
 * now refuses on the original map; this test pins the routed behaviour:
 *   1. refusing from another room changes nothing (no teleport, no healing);
 *   2. `reach` needs the real walk and pays the real cost;
 *   3. `escort` needs BOTH bodies in the medical room;
 *   4. the closed crisis records the real escort minutes.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeChoiceResult, type Candidate, type ChoiceRequest } from '../../src/decision/contracts';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { runStep } from '../../src/r7/integration/step';
import { RESCUE_BODY_TEMP_GAIN, RESCUE_RESCUER_STAMINA_COST } from '../../src/r7/domains/crises/index';

function forced(select: (request: ChoiceRequest) => Candidate | undefined) {
  return { identity: { mode: 'reference' as const, scorerId: 'r10-d-rescue', experimental: false,
    countsAsAdmitted: false }, score(request: ChoiceRequest) {
    const candidate = select(request);
    return makeChoiceResult({ request, scorerId: 'r10-d-rescue',
      scores: request.candidates.map(row => ({ candidateId: row.id,
        logit: Number(row.id === candidate?.id) })),
      disposition: candidate ? 'accept' : 'abstain', selectedId: candidate?.id ?? null,
      reason: 'CPU test' });
  } };
}

/**
 * A room-to-room walk is a queued 15-minute action (`ACTION_MINUTES.move`), not
 * an instant location write: the same `beginIntent` + `advanceWorld` path the
 * candidate layer uses for "前往X".
 */
async function walk(runtime: R8Runtime, actor: string, to: string): Promise<void> {
  const candidate: Candidate = {
    id: `walk-${actor}-${to}`, kind: 'move', description: `前往${to}`,
    parameters: { action: 'move', to, purpose: 'test-walk' },
    preconditions: ['alive'], expectedEffects: { travelMinutes: 15 }, utilityComponents: {},
  };
  const begun = runtime.beginIntent({ intentId: `walk-${actor}-${to}-${runtime.world.simTime}`,
    commandId: `walk-${actor}-${to}-${runtime.world.simTime}`, actorId: actor,
    candidate, minutes: 15 });
  assert.ok(!('rejected' in begun), 'the walk must be queueable');
  if ('rejected' in begun) return;
  assert.equal(begun.intent.dueAt - runtime.world.simTime, 15,
    'a room-to-room walk is the table\'s 15 minutes');
  runtime.advanceWorld(begun.intent.dueAt);
  assert.equal(runtime.world.npcs[actor].location, to);
  void runStep;
  void forced;
}

test('routed rescue: walk to the victim, then escort both to medical', async () => {
  const runtime = R8Runtime.create({ seed: 'r10-rescue' });
  const victim = 'npc_06';
  const rescuer = 'npc_07';
  for (const id of [victim, rescuer]) {
    runtime.session.submitWorldCommand({ commandId: `place-${id}`, type: 'move', actorId: id,
      to: 'workshop' as never });
  }
  // Severe hypothermia: the crisis opens on the next span (`bodyTemp < 33`).
  runtime.world.npcs[victim] = { ...runtime.world.npcs[victim], bodyTemp: 31.5 };
  runtime.advanceWorld(runtime.world.simTime + 1);
  const crises = runtime.states.crises as { active: { kind: string; subjectIds: string[] }[] };
  assert.ok(crises.active.some(entry => entry.kind === 'rescue'
    && entry.subjectIds.includes(victim)), 'a rescue crisis must open');

  // 1. From the wrong room nothing happens: no teleport, no free healing.
  runtime.session.submitWorldCommand({ commandId: 'away', type: 'move', actorId: rescuer,
    to: 'dorm-a' as never });
  const before = { location: runtime.world.npcs[victim].location,
    bodyTemp: runtime.world.npcs[victim].bodyTemp, health: runtime.world.npcs[victim].health,
    clock: runtime.world.simTime };
  const refused = runtime.dispatch('crises', 'rescue', rescuer, { victimId: victim, stage: 'reach' });
  assert.equal(refused.rejected.length, 1);
  assert.equal(refused.rejected[0].code, 'wrong_location');
  assert.equal(runtime.world.npcs[victim].location, before.location);
  assert.equal(runtime.world.npcs[victim].bodyTemp, before.bodyTemp);
  assert.equal(runtime.world.npcs[victim].health, before.health);
  assert.equal(runtime.world.simTime, before.clock);

  // 2. The rescuer really walks there; then reach pays the original price.
  await walk(runtime, rescuer, 'workshop');
  const staminaBefore = runtime.world.npcs[rescuer].stamina;
  const tempBefore = runtime.world.npcs[victim].bodyTemp ?? 36.5;
  const reach = runtime.dispatch('crises', 'rescue', rescuer, { victimId: victim, stage: 'reach' });
  assert.equal(reach.rejected.length, 0, JSON.stringify(reach.rejected));
  assert.ok(reach.events.some(event => event.type === 'rescue_reached'));
  const afterReach = runtime.world.npcs[victim].bodyTemp ?? 36.5;
  assert.ok(afterReach - tempBefore >= RESCUE_BODY_TEMP_GAIN - 0.2,
    `victim warms by ${RESCUE_BODY_TEMP_GAIN}, got ${(afterReach - tempBefore).toFixed(2)}`);
  assert.ok(runtime.world.npcs[rescuer].stamina <= staminaBefore - RESCUE_RESCUER_STAMINA_COST + 0.1,
    'the rescuer pays 10 stamina');
  assert.equal(runtime.world.npcs[victim].location, 'workshop', 'nobody was moved by the rescue');

  // 3. Escort before both bodies are in the medical room is refused.
  const early = runtime.dispatch('crises', 'rescue', rescuer, { victimId: victim, stage: 'escort' });
  assert.equal(early.rejected.length, 1);
  assert.equal(early.rejected[0].code, 'not_at_medical');

  // 4. Both walk; then the escort closes with the real minutes on record.
  const reachedAt = runtime.world.simTime;
  await walk(runtime, victim, 'medical');
  await walk(runtime, rescuer, 'medical');
  const escort = runtime.dispatch('crises', 'rescue', rescuer, { victimId: victim, stage: 'escort' });
  assert.equal(escort.rejected.length, 0, JSON.stringify(escort.rejected));
  const resolved = escort.events.find(event => event.type === 'crisis_resolved')!;
  const payload = resolved.payload as { at?: string; escortMinutes?: number; rescuerId?: string };
  assert.equal(payload.at, 'medical');
  assert.equal(payload.rescuerId, rescuer);
  assert.equal(payload.escortMinutes, runtime.world.simTime - reachedAt);
  assert.ok((payload.escortMinutes ?? 0) >= 30, 'two real 15-minute walks are on the clock');
  assert.equal(runtime.world.npcs[victim].location, 'medical');
});
