import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Command, Engine, fingerprint, initialWorld, replay, RULES, SaveData } from '../src';
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

function kitchenEng() {
  const w = initialWorld();
  w.npcs.npc_a.location = 'kitchen';
  return new Engine(w);
}
/** Eat command. mode omit = no payload key; empty = {}; null = explicit null. */
function eatPayload(id: string, mode: 'omit' | 'empty' | 'null' | 'undef') {
  const c: Record<string, unknown> = { commandId: id, actorId: 'npc_a', type: 'eat' };
  if (mode === 'empty') c.payload = {};
  else if (mode === 'null') c.payload = null;
  else if (mode === 'undef') c.payload = undefined;
  return c;
}
function jsonRestore(eng: Engine) {
  return Engine.restore(JSON.parse(JSON.stringify(eng.save())) as SaveData);
}

for (const actorId of ['toString', 'constructor', 'proto', '__proto__']) {
  test(`H: move actorId ${actorId} -> UNKNOWN_ACTOR, no throw, state and events unchanged`, () => {
    const eng = new Engine(initialWorld());
    const before = eng.getState();
    const r = eng.submit({ commandId: 'h-' + actorId, actorId, type: 'move', payload: { to: 'kitchen' } });
    assert.equal(r.status, 'rejected');
    assert.equal(r.reason, 'UNKNOWN_ACTOR');
    assert.deepEqual(eng.getState(), before);
    assert.deepEqual(eng.getEvents(), []);
    const log = eng.getLog();
    assert.equal(log.length, 1);
    assert.equal(log[0].command.actorId, actorId);
    assert.equal(log[0].result.status, 'rejected');
    assert.equal(log[0].result.reason, 'UNKNOWN_ACTOR');
    globalChecks(eng); dump('H-' + actorId, eng);
  });
}

test('I: same commandId eat, omitted payload vs {} -> COMMAND_ID_CONFLICT both orders', () => {
  const orders = [['omit', 'empty'], ['empty', 'omit']] as const;
  for (const [first, second] of orders) {
    const eng = kitchenEng();
    const r1 = eng.submit(eatPayload('i-' + first, first));
    const before = eng.getState();
    const n = eng.getEvents().length;
    const r2 = eng.submit(eatPayload('i-' + first, second));
    assert.equal(r1.status, 'accepted', first);
    assert.equal(r2.status, 'rejected');
    assert.equal(r2.reason, 'COMMAND_ID_CONFLICT', first + ' then ' + second);
    assert.deepEqual(eng.getState(), before);
    assert.equal(eng.getEvents().length, n);
    globalChecks(eng); dump('I-' + first + '-then-' + second, eng);
  }
});

test('I-restore: omitted payload vs {} still conflicts after JSON save/restore, both orders', () => {
  for (const [first, second] of [['omit', 'empty'], ['empty', 'omit']] as const) {
    const eng = kitchenEng();
    assert.equal(eng.submit(eatPayload('ir-' + first, first)).status, 'accepted');
    const saved = JSON.parse(JSON.stringify(eng.save())) as SaveData;
    const eng2 = Engine.restore(saved);
    const before = eng2.getState();
    const n = eng2.getEvents().length;
    const r2 = eng2.submit(eatPayload('ir-' + first, second));
    assert.equal(r2.status, 'rejected');
    assert.equal(r2.reason, 'COMMAND_ID_CONFLICT', first + ' then ' + second);
    assert.deepEqual(eng2.getState(), before);
    assert.equal(eng2.getEvents().length, n);
    globalChecks(eng2); dump('I-restore-' + first + '-then-' + second, eng2, { saveData: saved });
  }
});

test('I-null: omitted payload vs explicit null -> COMMAND_ID_CONFLICT, both orders, and both after JSON restore', () => {
  const fpOmit = fingerprint({ commandId: 'fp', actorId: 'npc_a', type: 'eat' } as Command);
  const fpNull = fingerprint({ commandId: 'fp', actorId: 'npc_a', type: 'eat', payload: null });
  const fpEmpty = fingerprint({ commandId: 'fp', actorId: 'npc_a', type: 'eat', payload: {} });
  assert.notEqual(fpOmit, fpNull);
  assert.notEqual(fpOmit, fpEmpty);
  assert.notEqual(fpNull, fpEmpty);
  assert.equal(fpOmit, fingerprint({ commandId: 'fp', actorId: 'npc_a', type: 'eat', payload: undefined }));
  for (const restore of [false, true]) {
    for (const [first, second] of [['omit', 'null'], ['null', 'omit']] as const) {
      const eng = kitchenEng();
      const r1 = eng.submit(eatPayload('in-' + first + (restore ? '-r' : ''), first));
      const eng2 = restore ? jsonRestore(eng) : eng;
      const before = eng2.getState();
      const n = eng2.getEvents().length;
      const r2 = eng2.submit(eatPayload(r1.commandId, second));
      assert.equal(r2.status, 'rejected', `${first} then ${second} restore=${restore}`);
      assert.equal(r2.reason, 'COMMAND_ID_CONFLICT');
      assert.deepEqual(eng2.getState(), before);
      assert.equal(eng2.getEvents().length, n);
      if (first === 'null') assert.equal(r1.reason, 'INVALID_PAYLOAD');
      else assert.equal(r1.status, 'accepted');
      globalChecks(eng2);
      if (!restore) dump('I-null-' + first + '-then-' + second, eng2);
      else dump('I-null-restore-' + first + '-then-' + second, eng2);
    }
  }
});

test('J: true duplicates, key-order equality, and failed-command retry stay duplicates', () => {
  const dup = kitchenEng();
  const e1 = dup.submit(eatPayload('j-empty', 'empty'));
  const e2 = dup.submit({ payload: {}, type: 'eat', actorId: 'npc_a', commandId: 'j-empty' });
  assert.equal(e1.status, 'accepted');
  assert.equal(e2.status, 'duplicate');
  assert.equal(e2.originalSeq, e1.seq);
  assert.deepEqual(e2.eventIds, e1.eventIds);
  const o1 = dup.submit(eatPayload('j-omit', 'omit'));
  const o2 = dup.submit(eatPayload('j-omit', 'undef'));
  assert.equal(o1.status, 'rejected');
  assert.equal(o1.reason, 'NO_FOOD');
  assert.equal(o2.status, 'duplicate');
  assert.equal(o2.reason, 'NO_FOOD');

  const keys = new Engine(initialWorld());
  const k1 = keys.submit({ commandId: 'j-k', actorId: 'npc_a', type: 'move', payload: { to: 'kitchen' } });
  const k2 = keys.submit({ payload: { to: 'kitchen' }, type: 'move', commandId: 'j-k', actorId: 'npc_a' });
  assert.equal(k1.status, 'accepted');
  assert.equal(k2.status, 'duplicate');
  const p1 = keys.submit({ commandId: 'j-p', actorId: 'npc_a', type: 'move', payload: { extra: 1, to: 'moon' } });
  const p2 = keys.submit({ commandId: 'j-p', type: 'move', actorId: 'npc_a', payload: { to: 'moon', extra: 1 } });
  assert.equal(p1.status, 'rejected');
  assert.equal(p1.reason, 'INVALID_PAYLOAD');
  assert.equal(p2.status, 'duplicate');
  assert.equal(p2.reason, 'INVALID_PAYLOAD');

  const retry = new Engine(initialWorld());
  const f1 = retry.submit(eat('j-fail', 'npc_a'));
  assert.equal(f1.reason, 'NOT_IN_KITCHEN');
  assert.equal(retry.submit(mv('j-move', 'npc_a', 'kitchen')).status, 'accepted');
  const f2 = retry.submit(eat('j-fail', 'npc_a'));
  assert.equal(f2.status, 'duplicate');
  assert.equal(f2.reason, 'NOT_IN_KITCHEN');
  assert.equal(f2.originalSeq, f1.seq);
  assert.equal(retry.getState().food.kitchen, 1);
  assert.equal(retry.getState().npcs.npc_a.hunger, 40);
  globalChecks(dup); globalChecks(keys); globalChecks(retry);
  dump('J-dup', dup); dump('J-keys', keys); dump('J-retry', retry);
});
