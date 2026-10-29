import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Engine, checkInvariants, replay } from '../src';
import assert from 'node:assert/strict';
export function dump(name: string, eng: Engine, extra: Record<string, unknown> = {}) {
  const dir = join(process.cwd(), 'artifacts', 'tests');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name + '.json'), JSON.stringify({ scenario: name, initialState: eng.getInitialState(), log: eng.getLog(), events: eng.getEvents(), finalState: eng.getState(), ...extra }, null, 2));
}
/** Global checks: invariants, every successful eat has FoodConsumed+HungerChanged, food conservation, replay equality. */
export function globalChecks(eng: Engine) {
  const s = eng.getState();
  assert.deepEqual(checkInvariants(s), []);
  const ev = eng.getEvents();
  const acceptedEats = eng.getLog().filter(l => l.result.status === 'accepted' && l.command.type === 'eat');
  for (const l of acceptedEats) {
    const mine = ev.filter(e => e.commandId === l.command.commandId).map(e => e.type);
    assert.deepEqual(mine, ['FoodConsumed', 'HungerChanged']);
  }
  const consumed = ev.filter(e => e.type === 'FoodConsumed').length;
  assert.equal(consumed, acceptedEats.length);
  assert.equal(eng.getInitialState().food.kitchen - s.food.kitchen, consumed);
  assert.deepEqual(replay(eng.getInitialState(), ev), s);
}
