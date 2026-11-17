import assert from 'node:assert/strict';
import { test } from 'node:test';
import { LongTermMemory, compareMemoryContexts, type ObservedEvent } from '../../../src/r7/memory';
import { applyCommand, createWorldV2, type Command } from '../../../src/survival/world-v2';
import { BUILDINGS, MAPS, findPath } from '../../../src/spatial-v2/map';

function event(id: string, kind: string, payload: Record<string, unknown>,
  simTime = 1, observedBy = ['a']): ObservedEvent {
  return { eventId: id, lifeId: 'life-1', actorId: 'a', simTime,
    kind, payload, observedBy, source: 'observation' };
}
const query = { actorId: 'a', goal: 'deliver-meal', place: 'warehouse', now: 1000, tokenBudget: 10_000 };

test('only observed restock changes knowledge; rumors stay reported and legacy bridge stays local', () => {
  const memory = new LongTermMemory();
  memory.ingest(event('empty', 'out_of_stock', { place: 'warehouse', available: 0, wanted: 1 }, 1, ['a', 'b']));
  memory.ingest({ ...event('rumor', 'restock_rumor', { text: '仓库满了', place: 'warehouse' }, 2, ['a', 'b']), source: 'report' });
  assert.equal(memory.toLegacyExperience('a').believesWarehouseEmpty('a'), true);
  const before = memory.consolidate({ actorId: 'a', now: 2 });
  assert.equal(before.notes.filter(note => note.key === 'stock:warehouse' && note.valid)[0].value, 'empty');
  memory.ingest(event('restock', 'stock_restocked', { place: 'warehouse', amount: 4, total: 4 }, 3));
  assert.equal(memory.toLegacyExperience('a').believesWarehouseEmpty('a'), false);
  assert.equal(memory.toLegacyExperience('b').believesWarehouseEmpty('b'), true);
  assert.ok(!memory.query({ ...query, actorId: 'b' }).evidenceIds.includes('life-1/restock'));
  assert.equal(memory.evidence('a', ['life-1/restock'], 3)[0].eventId, 'restock');
  assert.throws(() => memory.evidence('b', ['life-1/restock'], 3), /not visible/);
  const notes = memory.consolidate({ actorId: 'a', now: 3 }).notes;
  const current = notes.find(note => note.key === 'stock:warehouse' && note.valid)!;
  assert.equal(current.value, 'stocked');
  assert.equal(current.supersedes, notes.find(note => note.value === 'empty')!.id);
  assert.deepEqual(notes.find(note => note.value === 'empty')!.invalidatedBy, ['life-1/restock']);
});

test('authoritative WorldV2 action chain becomes a sourced conditional successful alternative', () => {
  const memory = new LongTermMemory();
  let world = createWorldV2({ npcIds: ['a', 'b'], resources: { food: 0 }, rngSeed: 'memory-chain' });
  const warehouse = BUILDINGS.find(building => building.id === 'warehouse')!.door;
  const kitchen = BUILDINGS.find(building => building.id === 'kitchen')!.door;
  world.npcs.a.location = 'warehouse';
  world.spatial = { positions: { a: warehouse }, stocks: { warehouse: { food: 0 } },
    carry: {}, closedCells: [], deliveredMeals: 0 };
  const run = (command: Command): void => {
    const result = applyCommand(world, command); world = result.state;
    result.events.forEach(item => memory.ingestWorldEvent(item, { observedBy: ['a'] }));
  };
  run({ commandId: 'fail', type: 'withdraw', actorId: 'a', place: 'warehouse', resource: 'food', amount: 1 });
  run({ commandId: 'gather', type: 'gather', actorId: 'a', resource: 'food', amount: 2 });
  run({ commandId: 'deposit', type: 'deposit', actorId: 'a', place: 'warehouse', resource: 'food', amount: 1 });
  run({ commandId: 'withdraw', type: 'withdraw', actorId: 'a', place: 'warehouse', resource: 'food', amount: 1 });
  run({ commandId: 'walk', type: 'travel', actorId: 'a',
    route: findPath(MAPS.village, warehouse, kitchen).path!, minutesPerTile: 2 });
  run({ commandId: 'delivered', type: 'deliver', actorId: 'a', to: 'kitchen', amount: 1 });
  assert.equal(world.spatial!.deliveredMeals, 1);
  const consolidated = memory.consolidate({ actorId: 'a', now: world.simTime });
  const alternative = consolidated.experiences.find(item => item.attempt === 'gather-deposit-withdraw-deliver')!;
  assert.equal(alternative.outcome, 'success');
  assert.equal(alternative.basis, 'observed-sequence');
  assert.equal(alternative.evidenceIds.length, 5);
  assert.ok(consolidated.experiences.some(item => item.attempt === 'warehouse-withdraw' && item.outcome === 'failure'));
  const context = memory.query({ ...query, now: world.simTime });
  assert.ok(context.applicableExperienceIds.includes(alternative.id));
  assert.equal(memory.query({ ...query, actorId: 'b' }).items.length, 0);
  run({ commandId: 'refill', type: 'restock', place: 'warehouse', resource: 'food', amount: 5, source: 'test' });
  const updated = memory.query({ ...query, now: world.simTime });
  assert.equal(updated.items.find(item => item.id === alternative.id)!.applicability, 'contradicted');
  assert.ok(!updated.applicableExperienceIds.includes(alternative.id));
});

test('successful cooperation remains conditional on observed relationship changes', () => {
  const memory = new LongTermMemory();
  memory.ingest(event('help', 'cooperation_received', { partnerId: 'b', goal: 'deliver-meal', receiptId: 'actual-help' }));
  const original = memory.query(query);
  const cooperation = original.items.find(item => item.kind === 'experience')!;
  assert.equal(cooperation.applicability, 'applicable');
  memory.ingest(event('conflict', 'relation_changed', { targetId: 'b', trust: 0.1 }, 2));
  assert.equal(memory.query(query).items.find(item => item.id === cooperation.id)!.applicability, 'contradicted');
  memory.ingest(event('reconciled', 'relation_changed', { targetId: 'b', trust: 0.8 }, 3));
  assert.equal(memory.query(query).items.find(item => item.id === cooperation.id)!.applicability, 'applicable');
});

test('raw/layered contexts branch from identical evidence and obey a complete-item byte budget', () => {
  const memory = new LongTermMemory();
  memory.ingest(event('empty', 'out_of_stock', { place: 'warehouse', available: 0, wanted: 1 }));
  for (let index = 0; index < 12; index++) {
    memory.ingest(event(`noise-${index}`, 'waited', { reason: `rest-${index}` }, index + 2));
  }
  const pair = compareMemoryContexts(memory, { ...query, tokenBudget: 600 });
  assert.equal(pair.raw.observationHash, pair.layered.observationHash);
  assert.notEqual(pair.raw.memoryHash, pair.layered.memoryHash);
  assert.ok(pair.layered.contextText.includes('来源缺货'));
  assert.ok(!pair.raw.contextText.includes('out_of_stock'));
  for (const context of Object.values(pair)) {
    assert.ok(context.estimatedTokens <= context.tokenBudget);
    assert.equal(Buffer.byteLength(context.contextText, 'utf8'), context.estimatedTokens);
    assert.ok(context.omitted > 0);
    assert.ok(context.evidenceIds.every(id => id.startsWith('life-1/')));
  }
  assert.equal(memory.query({ ...query, tokenBudget: 0 }).contextText, '');
});

test('save/restore rebuilds sources, excludes future events, and returns detached state', () => {
  const memory = new LongTermMemory();
  memory.ingest(event('empty', 'out_of_stock', { place: 'warehouse', available: 0 }, 1));
  memory.ingest(event('future', 'stock_restocked', { place: 'warehouse', amount: 3, total: 3 }, 50));
  assert.ok(!memory.query({ ...query, now: 2 }).evidenceIds.includes('life-1/future'));
  const serialized = memory.serialize();
  const restored = LongTermMemory.restore(JSON.parse(JSON.stringify(serialized)));
  assert.deepEqual(restored.query(query), memory.query(query));
  serialized.events[0].observedBy.push('b');
  serialized.events[0].payload.available = 99;
  assert.equal(restored.query({ ...query, actorId: 'b' }).items.length, 0);
  assert.equal(memory.serialize().events[0].payload.available, 0);
  assert.throws(() => restored.ingest(event('empty', 'out_of_stock', { place: 'warehouse', available: 2 }, 1)), /event_id_conflict/);
  assert.equal(restored.ingest(memory.serialize().events[0]).duplicate, true);
});

test('next life keeps conditional lessons but never revives old stock facts or commitments', () => {
  const memory = new LongTermMemory();
  memory.ingest(event('empty', 'out_of_stock', { place: 'warehouse', available: 0 }));
  memory.ingest(event('promise', 'commitment_accepted', { commitmentId: 'old-promise' }, 2));
  memory.nextLife({ nextLifeId: 'life-2', ending: 'bleak', rulesProfile: 'gospel-5.8.19', seed: 'life2' });
  const unknown = memory.query({ ...query, now: 0 });
  assert.ok(!unknown.contextText.includes('old-promise'));
  assert.equal(unknown.items.find(item => item.kind === 'experience')!.applicability, 'unknown');
  assert.equal(memory.toLegacyExperience('a').believesWarehouseEmpty('a'), false);
  memory.ingest({ ...event('fresh', 'stock_restocked', { place: 'warehouse', amount: 3, total: 3 }), lifeId: 'life-2' });
  assert.equal(memory.query(query).items.find(item => item.kind === 'experience')!.applicability, 'contradicted');
  const restored = LongTermMemory.restore(JSON.parse(JSON.stringify(memory.serialize())));
  assert.deepEqual(restored.query(query), memory.query(query));
});

test('nonempty but insufficient stock is not recorded as an empty warehouse', () => {
  const memory = new LongTermMemory();
  memory.ingest(event('partial', 'out_of_stock', { place: 'warehouse', available: 1, wanted: 2 }));
  const notes = memory.consolidate({ actorId: 'a', now: 1 }).notes;
  assert.equal(notes.find(note => note.key === 'stock:warehouse')!.value, 'limited');
});
