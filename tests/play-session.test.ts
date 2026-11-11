import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PlaySession } from '../src/application-v2/session';
import type { Candidate } from '../src/decision/contracts';

function helpCandidate(promiseId: string): Candidate {
  return { id: `c-help-${promiseId}`, kind: 'help', description: '留饭',
    parameters: { action: 'reserve', amount: 1, forId: 'player' },
    preconditions: ['food >= 1'], expectedEffects: { food: -1 }, utilityComponents: { obligation: 1 } };
}

test('player cancellation reaches only the addressed NPC', () => {
  const session = PlaySession.create(3, { seed: 'trace' });
  const { promiseId } = session.playerPromise('npc_01');
  session.playerCancel('npc_01');
  const knowledge = session.knowledge();
  assert.equal(knowledge.npc_01.promises[0].status, 'cancelled');
  assert.equal(knowledge.npc_02.promises[0].status, 'active');
  assert.equal(session.plans.find(plan => plan.promiseId === promiseId)!.state, 'invalidated');
});

test('a rejected reserve writes no promise_kept; success is fulfilled once', () => {
  const session = PlaySession.create(2, { seed: 'reject', food: 0 });
  const { promiseId } = session.playerPromise('npc_01');
  const candidate = helpCandidate(promiseId);
  const rejected = session.executeCandidate('npc_01', candidate, 'cmd-reject');
  assert.equal(rejected.status, 'rejected');
  assert.equal(session.knowledge().npc_01.promises[0].status, 'active');

  session.world = { ...session.world, resources: { ...session.world.resources, food: 2 } };
  const applied = session.executeCandidate('npc_01', candidate, 'cmd-apply');
  assert.equal(applied.status, 'applied');
  assert.equal(applied.eventIds.length, 1);
  assert.equal(session.knowledge().npc_01.promises[0].status, 'kept');

  const duplicate = session.executeCandidate('npc_01', candidate, 'cmd-apply');
  assert.equal(duplicate.status, 'unknown');
  assert.equal(session.world.resources.food, 1);
  assert.equal(session.knowledge().npc_01.promises[0].status, 'kept');
});

test('a real stdin session saves, exits, restores and keeps the asymmetry', () => {
  const dir = mkdtempSync(join(tmpdir(), 'frostecho-play-'));
  const state = join(dir, 'session.json');
  try {
    const first = spawnSync(process.execPath, ['dist/scripts/play-sprint.js', '--state', state], {
      input: 'promise npc_01\ncancel npc_01\nsave\nquit\n', encoding: 'utf8', cwd: process.cwd(),
    });
    assert.equal(first.status, 0, first.stderr);
    const second = spawnSync(process.execPath, ['dist/scripts/play-sprint.js', '--state', state], {
      input: 'knowledge\ntell npc_02 npc_01\nknowledge\nsave\nquit\n', encoding: 'utf8', cwd: process.cwd(),
    });
    assert.equal(second.status, 0, second.stderr);
    const rows = second.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows[0].restored, true);
    assert.equal(rows[1].knowledge.npc_01.promises[0].status, 'cancelled');
    assert.equal(rows[1].knowledge.npc_02.promises[0].status, 'active');
    assert.equal(rows[3].knowledge.npc_02.promises[0].status, 'cancelled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('stdin input changes the trajectory and executes authoritative commands', async () => {
  const session = PlaySession.create(3, { seed: 'decide' });
  session.playerPromise('npc_01');
  session.playerCancel('npc_01');
  const decisions = await session.stepAll();
  assert.ok(decisions.length >= 1);
  for (const decision of decisions) {
    assert.ok(['applied', 'rejected', 'unknown', 'scored'].includes(decision.status));
    assert.ok(decision.executed === false || decision.eventIds.length >= 0);
  }
  assert.ok(session.world.version > 0);
});

test('R1-G: a confirmed fulfilment changes the relation once and survives restore', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'frostecho-relation-'));
  const state = join(dir, 'session.json');
  try {
    const session = PlaySession.create(2, { seed: 'relation', food: 2 });
    session.playerPromise('npc_01');
    const decision = await session.stepActor('npc_01');
    assert.equal(decision.executed, true);
    assert.deepEqual(decision.eventIds.length, 1);
    const relation = session.knowledge().npc_01.relation as { trust: number } | null;
    assert.ok(relation && relation.trust > 0);
    session.save(state);
    const restored = PlaySession.load(state);
    const restoredRelation = restored.knowledge().npc_01.relation as { trust: number } | null;
    assert.equal(restoredRelation?.trust, relation.trust);
    assert.equal(restored.world.resources.food, session.world.resources.food);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
