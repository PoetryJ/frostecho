/**
 * R2 four-day playable slice: task assignment, need conflicts, relation as a
 * real candidate input, cancel effects, and save/restore across processes.
 * Mode is reference-rules/1 (deterministic), never model understanding.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { GameplayLoop } from '../src/gameplay-v2/loop';
import { buildGameplayCandidates, chooseReference } from '../src/gameplay-v2/decisions';
import type { GameplayDecisionInput } from '../src/gameplay-v2/decisions';

function baseInput(overrides: Partial<GameplayDecisionInput> = {}): GameplayDecisionInput {
  return {
    actorId: 'npc_01',
    npc: { id: 'npc_01', location: 'dorm-a', hunger: 60, stamina: 80, health: 100, san: 80, alive: true },
    resources: { food: 5, firewood: 5, power: 50, medicine: 2 },
    furnace: { lit: true, fuel: 50, warmth: 1 },
    tasks: [],
    relationTrust: 0,
    ...overrides,
  };
}

test('R2-P1: 8 NPC x 4 days = 96h completes tasks and settles the ending', () => {
  const roster: [string, 'gather-food' | 'gather-wood' | 'heating' | 'leave-food'][] = [
    ['npc_01', 'gather-food'], ['npc_02', 'gather-food'], ['npc_03', 'gather-food'],
    ['npc_04', 'gather-wood'], ['npc_05', 'gather-wood'], ['npc_06', 'heating'],
    ['npc_07', 'heating'], ['npc_08', 'leave-food'],
  ];
  for (const seed of ['seed-17', 'seed-29', 'seed-43']) {
    const loop = GameplayLoop.create(8, { days: 4, seed, food: 12 });
    for (let day = 0; day < 4; day += 1) {
      for (const [actorId, kind] of roster) loop.assign(actorId, kind);
      const stepped = loop.step();
      assert.equal(stepped.mode, 'reference-rules/1');
      assert.ok(stepped.records.length >= 6, 'most NPCs decide each day');
      loop.advance(1440);
    }
    const status = loop.status();
    assert.equal(status.hoursElapsed, 96, `${seed} must run 96 real hours`);
    assert.equal(status.ending, 'survived', `${seed} ending comes from the authoritative state`);
    const resources = status.resources as Record<string, number>;
    for (const value of Object.values(resources)) assert.ok(value >= 0);
    assert.ok(loop.session.world.version > 0);
  }
});

test('R2-P2: an all-dead ending is reachable from the authoritative state', () => {
  const loop = GameplayLoop.create(1, { days: 4, seed: 'doom', food: 0 });
  const npc = loop.session.world.npcs.npc_01;
  npc.hunger = 0;
  npc.health = 2;
  loop.advance(1440);
  assert.equal(loop.session.world.npcs.npc_01.alive, false);
  assert.equal(loop.session.world.ending, 'all-dead');
});

test('R2-P3: cancelling a task stops that NPC from executing it', () => {
  const loop = GameplayLoop.create(2, { days: 4, seed: 'cancel-task', food: 5 });
  const task = loop.assign('npc_01', 'gather-food');
  assert.equal(loop.cancelTask(task.taskId), true);
  assert.equal(loop.cancelTask(task.taskId), false, 'cancel is idempotent');
  const stepped = loop.step();
  const record = stepped.records.find(entry => entry.actorId === 'npc_01')!;
  assert.notEqual(record.selectedId, 'g-gather-food');
  assert.ok(loop.board.activeFor('npc_01').length === 0);
});

test('R2-P4: hunger vs leave-food conflict is observable and defers the task', () => {
  const loop = GameplayLoop.create(2, { days: 4, seed: 'conflict', food: 4 });
  loop.assign('npc_01', 'leave-food');
  loop.session.world.npcs.npc_01.hunger = 20;
  const record = loop.step().records.find(entry => entry.actorId === 'npc_01')!;
  assert.equal(record.conflict?.kind, 'hunger_vs_leave-food');
  assert.equal(record.selectedId, 'g-eat');
  assert.equal(loop.session.knowledge().npc_01.promises[0].status, 'active',
    'a deferred task is not a kept promise');
});

test('R2-P5: relation is a pre-registered candidate input (high vs low trust)', () => {
  const input = baseInput({
    tasks: [
      { taskId: 't-gather', actorId: 'npc_01', kind: 'gather-food', status: 'active', assignedAt: 0 },
      { taskId: 't-help', actorId: 'npc_01', kind: 'leave-food', status: 'active',
        assignedAt: 0, promiseId: 'p-food-npc_01' },
    ],
  });
  const low = buildGameplayCandidates({ ...input, relationTrust: 0 });
  const high = buildGameplayCandidates({ ...input, relationTrust: 1 });
  assert.equal(chooseReference(low.candidates).candidate.id, 'g-gather-food',
    'trust 0 pre-registers gather-food (0.56 > 0.45)');
  assert.equal(chooseReference(high.candidates).candidate.id, 'c-help-p-food-npc_01',
    'trust 1 pre-registers leave-food (0.60 > 0.56)');
  assert.equal(low.conflict, null);
  assert.equal(high.conflict, null);
});

test('R2-P7: the real CLI assigns, runs and restores gameplay tasks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-gameplay-cli-'));
  const state = join(dir, 'session.json');
  try {
    const first = spawnSync(process.execPath,
      ['dist/scripts/play-sprint.js', '--state', state, '--fresh', '--npc', '3', '--food', '6'],
      { input: 'assign npc_01 gather-food\ntask-status\ngame-step\nsave\nquit\n',
        encoding: 'utf8', cwd: process.cwd() });
    assert.equal(first.status, 0, first.stderr);
    const rows = first.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.equal(rows.find(row => row.command === 'assign')?.task?.kind, 'gather-food');
    const status = rows.find(row => row.command === 'task-status');
    assert.equal(status.status.mode, 'reference-rules/1');
    assert.equal(status.status.tasks.length, 1);
    assert.equal(rows.find(row => row.command === 'game-step')?.mode, 'reference-rules/1');
    const second = spawnSync(process.execPath,
      ['dist/scripts/play-sprint.js', '--state', state],
      { input: 'task-status\nquit\n', encoding: 'utf8', cwd: process.cwd() });
    assert.equal(second.status, 0, second.stderr);
    const restored = second.stdout.trim().split('\n').map(line => JSON.parse(line))
      .find(row => row.command === 'task-status');
    assert.equal(restored.status.tasks.length, 1, 'task board restored from the sidecar');
    assert.ok(restored.status.version === undefined || restored.status.version >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R2-P6: task board and world survive save/restore and continue playing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r2-gameplay-'));
  try {
    const state = join(dir, 'session.json');
    const loop = GameplayLoop.create(3, { days: 4, seed: 'restore', food: 6 });
    loop.assign('npc_01', 'gather-food');
    loop.assign('npc_02', 'leave-food');
    loop.step();
    loop.advance(1440);
    loop.save(state);
    const before = loop.status();
    const restored = GameplayLoop.load(state);
    const after = restored.status();
    assert.equal(after.hoursElapsed, before.hoursElapsed);
    assert.equal(after.ending, before.ending);
    assert.deepEqual(restored.board.toJSON(), loop.board.toJSON());
    const continued = restored.step();
    assert.ok(continued.records.length >= 1);
    restored.advance(1440);
    assert.equal(restored.status().hoursElapsed, 48);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
