/**
 * D (R10): crisis TIMING, straight from the original event dispatch.
 *
 *   - frostbite is a DAY-2 event only (`event-system.js:341`, `_checkFrostbite`
 *     returns unless `ws.currentDay === 2`), threshold bodyTemp < 34.5;
 *   - the food conflict opens below 8 food with a 60 game-minute cooldown
 *     (`event-system.js:113`: 3600 s at 1 game minute per second);
 *   - the day-4 lockdown broadcast fires once, on day 4
 *     (`event-system.js:405-441`).
 *
 * Everything goes through `advanceWorld`, so the timing is the one clock.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { R8Runtime } from '../../src/r7/integration/runtime';
import { FOOD_CONFLICT_COOLDOWN, FOOD_CONFLICT_THRESHOLD } from '../../src/r7/domains/crises/index';
import { GOSPEL_PROFILE } from '../../src/r7/contracts';

const crisisState = (runtime: R8Runtime) => runtime.states.crises as {
  active: { kind: string; subjectIds: string[]; startedAtMinute: number }[];
  history: { kind: string; resolvedAtMinute: number | null }[];
  lastFoodConflictMinute: number;
};

test('frostbite opens on day 2 only, and only below 34.5 C', () => {
  const runtime = R8Runtime.create({ seed: 'r10-crisis-frostbite' });
  // Day 1 with a cold body: no frostbite event exists on day 1.
  runtime.world.npcs.npc_07 = { ...runtime.world.npcs.npc_07, bodyTemp: 34.2 };
  runtime.advanceWorld(runtime.world.simTime + 60);
  assert.equal(crisisState(runtime).active.some(entry => entry.kind === 'frostbite'), false);
  assert.equal(crisisState(runtime).history.some(entry => entry.kind === 'frostbite'), false);

  // Walk up to the last minute of day 1, chill the body there, then cross the
  // day boundary: central heating would otherwise recover it first.
  runtime.advanceWorld(GOSPEL_PROFILE.minutesPerDay - 1);
  runtime.world.npcs.npc_07 = { ...runtime.world.npcs.npc_07, bodyTemp: 34.2 };
  runtime.advanceWorld(GOSPEL_PROFILE.minutesPerDay + 1);
  const frost = crisisState(runtime).active.filter(entry => entry.kind === 'frostbite');
  assert.equal(frost.length, 1);
  assert.deepEqual(frost[0].subjectIds, ['npc_07']);
  // The opening minute is on the same clock as the world, not a step index.
  assert.ok(frost[0].startedAtMinute >= GOSPEL_PROFILE.minutesPerDay
    && frost[0].startedAtMinute < GOSPEL_PROFILE.minutesPerDay + 120,
    `frostbite recorded on the world clock, got ${frost[0].startedAtMinute}`);

  // A warm body closes it again.
  runtime.world.npcs.npc_07 = { ...runtime.world.npcs.npc_07, bodyTemp: 36.4 };
  runtime.advanceWorld(runtime.world.simTime + 60);
  assert.equal(crisisState(runtime).active.some(entry => entry.kind === 'frostbite'), false);
});

test('the food conflict honours its threshold and 60-minute cooldown', () => {
  const runtime = R8Runtime.create({ seed: 'r10-crisis-food' });
  assert.ok(FOOD_CONFLICT_THRESHOLD >= 1);
  // One-minute spans keep the recorded minute and the world clock equal, so the
  // cooldown can be checked against the record itself.
  const tick = () => runtime.advanceWorld(runtime.world.simTime + 1);
  runtime.world.resources.food = FOOD_CONFLICT_THRESHOLD - 1;
  tick();
  const opened = crisisState(runtime).active.filter(entry => entry.kind === 'food_conflict');
  assert.equal(opened.length, 1);
  const openedAt = crisisState(runtime).lastFoodConflictMinute;
  assert.equal(opened[0].startedAtMinute, openedAt,
    'the record and the cooldown clock name the same minute');

  // Above the threshold it resolves and the cooldown clock is untouched.
  runtime.world.resources.food = FOOD_CONFLICT_THRESHOLD + 4;
  tick();
  assert.equal(crisisState(runtime).active.some(entry => entry.kind === 'food_conflict'), false);

  // A new shortage inside the cooldown must NOT open a second crisis: the
  // cooldown runs from the OPENING minute, not from the resolution.
  runtime.world.resources.food = 1;
  while (runtime.snapshot().absoluteMinute < openedAt + FOOD_CONFLICT_COOLDOWN - 5) tick();
  assert.equal(crisisState(runtime).active.some(entry => entry.kind === 'food_conflict'), false,
    'the 60-minute cooldown still holds');
  // Past the cooldown it opens again.
  while (runtime.snapshot().absoluteMinute < openedAt + FOOD_CONFLICT_COOLDOWN + 2) tick();
  assert.equal(crisisState(runtime).active.filter(entry => entry.kind === 'food_conflict').length, 1);
});

test('the day-4 lockdown broadcast fires once, on day 4', () => {
  const runtime = R8Runtime.create({ seed: 'r10-crisis-day4' });
  runtime.advanceWorld(GOSPEL_PROFILE.minutesPerDay * 3 - 1);   // still day 3
  assert.equal(crisisState(runtime).active.some(entry => entry.kind === 'day4_warning'), false);
  runtime.advanceWorld(GOSPEL_PROFILE.minutesPerDay * 3 + 60);  // day 4
  const warnings = crisisState(runtime).active.filter(entry => entry.kind === 'day4_warning');
  assert.equal(warnings.length, 1);
  runtime.advanceWorld(runtime.world.simTime + 120);
  assert.equal(crisisState(runtime).active.filter(entry => entry.kind === 'day4_warning').length, 1,
    'the broadcast is not repeated every span');
});
