import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Engine, initialWorld, replay, RULES, SaveData } from '../src';
import { dump, globalChecks } from './helpers';

const mv = (id: string, a: string, to: string) => ({ commandId: id, actorId: a, type: 'move', payload: { to } });
const eat = (id: string, a: string) => ({ commandId: id, actorId: a, type: 'eat', payload: {} });

test('A: move to kitchen then eat', () => {
  const eng = new Engine(initialWorld());
  const r1 = eng.submit(mv('a1', 'npc_a', 'kitchen'));
  const r2 = eng.submit(eat('a2', 'npc_a'));
  assert.equal(r1.status, 'accepted'); assert.equal(r2.status, 'accepted');
  const s = eng.getState();
  assert.equal(s.npcs.npc_a.location, 'kitchen');
  assert.equal(s.food.kitchen, 0);                       // 1 - EAT_FOOD_COST
  assert.equal(s.npcs.npc_a.hunger, 40 + RULES.EAT_HUNGER_RESTORE); // 70
  assert.deepEqual(eng.getEvents().map(e => e.type), ['NpcMoved', 'FoodConsumed', 'HungerChanged']);
  globalChecks(eng); dump('A', eng);
});

test('A2: hunger clamps at 100', () => {
  const w = initialWorld(); w.npcs.npc_a.hunger = 90; w.npcs.npc_a.location = 'kitchen';
  const eng = new Engine(w);
  assert.equal(eng.submit(eat('c1', 'npc_a')).status, 'accepted');
  assert.equal(eng.getState().npcs.npc_a.hunger, 100);
  globalChecks(eng); dump('A2-clamp', eng);
});

for (const order of [['npc_a', 'npc_b'], ['npc_b', 'npc_a']]) {
  test(`B: contention for last food, order ${order.join(' then ')}`, () => {
    const eng = new Engine(initialWorld());
    eng.submit(mv('m_a', 'npc_a', 'kitchen')); eng.submit(mv('m_b', 'npc_b', 'kitchen'));
    const r1 = eng.submit(eat('eat_' + order[0], order[0]));
    const r2 = eng.submit(eat('eat_' + order[1], order[1]));
    assert.equal(r1.status, 'accepted');
    assert.equal(r2.status, 'rejected'); assert.equal(r2.reason, 'NO_FOOD');
    const s = eng.getState();
    assert.equal(s.food.kitchen, 0);
    const init = initialWorld();
    assert.equal(s.npcs[order[0]].hunger, init.npcs[order[0]].hunger + 30);
    assert.equal(s.npcs[order[1]].hunger, init.npcs[order[1]].hunger);
    globalChecks(eng); dump('B-' + order.join('-first-'), eng);
  });
}

test('C: duplicate successful command has no extra effect', () => {
  const eng = new Engine(initialWorld());
  eng.submit(mv('c_m', 'npc_a', 'kitchen'));
  const first = eng.submit(eat('c_e', 'npc_a'));
  const before = eng.getState(); const evCount = eng.getEvents().length;
  const again = eng.submit(eat('c_e', 'npc_a'));
  const again2 = eng.submit(eat('c_e', 'npc_a'));
  assert.equal(again.status, 'duplicate'); assert.equal(again2.status, 'duplicate');
  assert.deepEqual(again.eventIds, first.eventIds); assert.equal(again.originalSeq, first.seq);
  assert.deepEqual(eng.getState(), before); assert.equal(eng.getEvents().length, evCount);
  globalChecks(eng); dump('C', eng);
});

test('D: same commandId with different payload -> COMMAND_ID_CONFLICT', () => {
  const eng = new Engine(initialWorld());
  assert.equal(eng.submit(mv('d1', 'npc_a', 'kitchen')).status, 'accepted');
  const before = eng.getState(); const n = eng.getEvents().length;
  const r = eng.submit(mv('d1', 'npc_a', 'dorm'));
  const r2 = eng.submit(eat('d1', 'npc_a'));
  assert.equal(r.status, 'rejected'); assert.equal(r.reason, 'COMMAND_ID_CONFLICT');
  assert.equal(r2.reason, 'COMMAND_ID_CONFLICT');
  assert.deepEqual(eng.getState(), before); assert.equal(eng.getEvents().length, n);
  globalChecks(eng); dump('D', eng);
});

test('E: invalid input / unmet preconditions leave state unchanged', () => {
  const eng = new Engine(initialWorld());
  const cases: [unknown, string][] = [
    [mv('e1', 'ghost', 'kitchen'), 'UNKNOWN_ACTOR'],
    [{ commandId: 'e2', actorId: 'npc_a', type: 'fly', payload: {} }, 'UNKNOWN_ACTION'],
    [mv('e3', 'npc_a', 'moon'), 'INVALID_PAYLOAD'],
    [{ commandId: 'e4', actorId: 'npc_a', type: 'move', payload: null }, 'INVALID_PAYLOAD'],
    [{ commandId: 'e5', actorId: 'npc_a', type: 'eat', payload: { amount: 5 } }, 'INVALID_PAYLOAD'],
    [{ actorId: 'npc_a', type: 'eat' }, 'INVALID_COMMAND'],
    [mv('e6', 'npc_a', 'dorm'), 'ALREADY_THERE'],
    [eat('e7', 'npc_a'), 'NOT_IN_KITCHEN'],
  ];
  const results: unknown[] = [];
  for (const [c, reason] of cases) {
    const before = eng.getState(); const n = eng.getEvents().length;
    const r = eng.submit(c);
    results.push(r);
    assert.equal(r.status, 'rejected'); assert.equal(r.reason, reason, JSON.stringify(c));
    assert.deepEqual(eng.getState(), before); assert.equal(eng.getEvents().length, n);
  }
  // food exhausted
  eng.submit(mv('e8', 'npc_a', 'kitchen')); eng.submit(eat('e9', 'npc_a'));
  const before = eng.getState();
  const r = eng.submit(eat('e10', 'npc_a'));
  assert.equal(r.reason, 'NO_FOOD'); assert.deepEqual(eng.getState(), before);
  globalChecks(eng); dump('E', eng);
});

test('F: replay(initial, events) equals live final state; no executor called', () => {
  const eng = new Engine(initialWorld());
  for (const c of [mv('f1', 'npc_b', 'kitchen'), eat('f2', 'npc_a'), eat('f3', 'npc_b'), mv('f4', 'npc_a', 'kitchen'), eat('f5', 'npc_a'), mv('f6', 'npc_b', 'dorm'), eat('f3', 'npc_b')]) eng.submit(c);
  const live = eng.getState();
  const replayed = replay(eng.getInitialState(), JSON.parse(JSON.stringify(eng.getEvents())));
  assert.deepEqual(replayed, live);
  assert.deepEqual(live.npcs.npc_b, { id: 'npc_b', location: 'dorm', hunger: 50 });
  globalChecks(eng); dump('F', eng, { replayedState: replayed });
});

test('G: restore from save then retry completed command -> no duplicate effect', () => {
  const eng = new Engine(initialWorld());
  eng.submit(mv('g1', 'npc_a', 'kitchen')); eng.submit(eat('g2', 'npc_a'));
  const saved: SaveData = JSON.parse(JSON.stringify(eng.save())); // simulate disk round-trip
  const eng2 = Engine.restore(saved);
  assert.deepEqual(eng2.getState(), eng.getState());
  const r = eng2.submit(eat('g2', 'npc_a'));
  assert.equal(r.status, 'duplicate');
  const c = eng2.submit(mv('g2', 'npc_a', 'dorm'));
  assert.equal(c.reason, 'COMMAND_ID_CONFLICT');
  assert.deepEqual(eng2.getState(), eng.getState());
  assert.equal(eng2.getEvents().length, 3);
  // new command after restore continues seq/event ids without collision
  const n = eng2.submit(mv('g3', 'npc_a', 'dorm'));
  assert.equal(n.status, 'accepted'); assert.deepEqual(n.eventIds, ['e4']);
  globalChecks(eng2); dump('G', eng2, { saveData: saved });
});

test('Immutability: returned state/history cannot corrupt engine', () => {
  const eng = new Engine(initialWorld());
  eng.submit(mv('i1', 'npc_a', 'kitchen'));
  const s = eng.getState(); s.food.kitchen = 999; s.npcs.npc_a.hunger = -5;
  const ev = eng.getEvents(); (ev[0] as any).to = 'dorm'; ev.length = 0;
  const lg = eng.getLog(); lg[0].result.status = 'rejected';
  const input = eat('i2', 'npc_a'); const r = eng.submit(input); (input as any).actorId = 'npc_b';
  assert.equal(r.status, 'accepted');
  assert.equal(eng.getState().food.kitchen, 0);
  assert.equal(eng.getEvents().length, 3);
  assert.equal(eng.getLog()[0].result.status, 'accepted');
  assert.equal(eng.getLog()[1].command.actorId, 'npc_a');
  const sv = eng.save(); sv.state.food.kitchen = 50;
  assert.throws(() => Engine.restore(sv), /corrupt/);
  globalChecks(eng);
});

test('Determinism: same commands -> identical records (no wall clock)', () => {
  const run = () => { const e = new Engine(initialWorld()); e.submit(mv('x1', 'npc_a', 'kitchen')); e.submit(eat('x2', 'npc_a')); return JSON.stringify(e.save()); };
  assert.equal(run(), run());
});
