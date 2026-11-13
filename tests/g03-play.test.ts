/**
 * G03 workstream B self-tests — two autonomous NPCs plus the player.
 * Offline reference policy only; no network, no sleeps.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Provider } from '../src/agent/contracts';
import { createReferenceProvider } from '../src/agent/providers/reference';
import { createMultiGame, parseG03PlayerLine } from '../src/multi/game';
import type { MultiDecidingInfo } from '../src/multi/contracts';
import type { WorldState } from '../src/types';

function world(npcALocation: 'dorm' | 'kitchen' = 'dorm', npcCLocation: 'dorm' | 'kitchen' = 'dorm', kitchenFood = 4): WorldState {
  return {
    npcs: {
      npc_a: { id: 'npc_a', location: npcALocation, hunger: 0 },
      npc_b: { id: 'npc_b', location: 'dorm', hunger: 0 },
      npc_c: { id: 'npc_c', location: npcCLocation, hunger: 0 },
    },
    food: { kitchen: kitchenFood, dorm: 0 },
    tick: 0,
  };
}

test('parseG03PlayerLine accepts only the two player verbs', () => {
  assert.deepEqual(parseG03PlayerLine('player move dorm'), { kind: 'move', to: 'dorm' });
  assert.deepEqual(parseG03PlayerLine(' player move kitchen '), { kind: 'move', to: 'kitchen' });
  assert.deepEqual(parseG03PlayerLine('player eat'), { kind: 'eat' });
  assert.equal(parseG03PlayerLine('').kind, 'blank');
  assert.equal(parseG03PlayerLine('player fly').kind, 'invalid');
  assert.equal(parseG03PlayerLine('npc_a move dorm').kind, 'invalid');
});

test('two NPCs run to terminal statuses with unique per-actor command ids', async () => {
  const game = createMultiGame({
    episodeId: 'e2',
    initialState: world(),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => createReferenceProvider(),
    mode: 'reference',
    thinking: null,
  });
  assert.equal(await game.run(), 'done');
  const record = game.snapshot();
  // kitchen starts with 4 food: each NPC moves, eats twice (60 < 70), then the
  // reference policy stops when no food is left — an authoritative goal miss.
  assert.equal(record.actors.npc_a.status, 'stopped');
  assert.equal(record.actors.npc_c.status, 'stopped');
  assert.equal(record.actors.npc_a.goalReached, false);
  assert.equal(record.actors.npc_c.goalReached, false);
  const npcIds = record.commands.map(entry => entry.command.commandId).filter(id => !id.includes(':player:'));
  const unique = new Set(npcIds);
  assert.equal(unique.size, npcIds.length);
  for (const id of npcIds) assert.match(id, /^e2:npc:(npc_a|npc_c):\d+$/);
  assert.ok(record.turns.length >= 4);
  assert.equal(record.stopReason, 'completed');
});

test('player line lands between NPC steps and is recorded once in the ledger', async () => {
  const playerMoves: string[] = [];
  const game = createMultiGame({
    episodeId: 'e3',
    initialState: world(),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => createReferenceProvider(),
    mode: 'reference',
    thinking: null,
    onDeciding: (info: MultiDecidingInfo) => {
      if (info.actorId === 'npc_a' && info.round === 1) {
        // synchronous submit while npc_a is waiting for its model text
        const r = game.playerLine('player move kitchen');
        if (r.ok) playerMoves.push(r.command.commandId);
      }
    },
  });
  assert.equal(await game.run(), 'done');
  assert.equal(playerMoves.length, 1);
  const record = game.snapshot();
  const playerEntries = record.commands.filter(e => e.command.commandId.includes(':player:'));
  assert.equal(playerEntries.length, 1);
  assert.equal(playerEntries[0].command.actorId, 'npc_b');
  assert.equal(playerEntries[0].result.status, 'accepted');
  assert.equal(record.finalState.npcs.npc_b.location, 'kitchen');
  assert.ok(record.events.filter(e => e.type === 'NpcMoved').length >= 3); // npc_a, npc_c, player
});

test('snapshot captures replayMatches and authoritative per-actor goals', async () => {
  const game = createMultiGame({
    episodeId: 'e4',
    initialState: world(),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => createReferenceProvider(),
    mode: 'reference',
    thinking: null,
  });
  await game.run();
  const record = game.snapshot();
  assert.equal(record.schema, 'frostecho.g03.game/1');
  assert.equal(record.replayMatches, true);
  assert.equal(record.actors.npc_a.goalReached, false); // 2 eats → 60 < 70: authoritative, not claimed
  assert.equal(record.actors.npc_c.goalReached, false);
  assert.ok(Array.isArray(record.turns) && record.turns.length > 0);
  assert.ok(record.turns.every(t => t.actorId === 'npc_a' || t.actorId === 'npc_c'));
  assert.ok(record.turns.every((t, i) => t.globalTurn === i + 1));
  assert.ok(typeof record.timing.totalMs === 'number');
  assert.deepEqual(record.actorOrder, ['npc_a', 'npc_c']);
});

test('close marks user_closed and stops new steps', async () => {
  const game = createMultiGame({
    episodeId: 'e5',
    initialState: world(),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => createReferenceProvider(),
    mode: 'reference',
    thinking: null,
  });
  const first = game.advance();
  await first;
  await game.close();
  const record = game.snapshot();
  assert.equal(record.stopReason, 'user_closed');
  assert.equal((await game.advance()).kind, 'closed');
});

test('each actor gets an independent provider instance', () => {
  const seen: Provider[] = [];
  const game = createMultiGame({
    episodeId: 'e6',
    initialState: world(),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => { const p = createReferenceProvider(); seen.push(p); return p; },
    mode: 'reference',
    thinking: null,
  });
  assert.equal(seen.length, 2);
  assert.notEqual(seen[0], seen[1]);
  assert.equal(game.actorIds.includes('npc_b'), false);
});

test('player line rejects bad verbs and impossible moves without crashing', () => {
  const game = createMultiGame({
    episodeId: 'e7',
    initialState: world(),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => createReferenceProvider(),
    mode: 'reference',
    thinking: null,
  });
  const bad = game.playerLine('player fly');
  assert.equal(bad.ok, false);
  game.playerLine('player move kitchen'); // accepted
  const dup = game.playerLine('player move kitchen');
  assert.equal(dup.ok, false); // already there → rejected by rules
  const eat = game.playerLine('player eat'); // in kitchen, food available
  assert.equal(eat.ok, true);
  assert.equal(game.world.getState().npcs.npc_b.hunger, 30);
});
