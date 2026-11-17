/**
 * R3 acceptance gate G2 (black box): the spatial delivery slice through the
 * shipped CLI. Asserts only what the player can observe: authoritative events,
 * world version movement (or not), task status and restored state.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const CLI = join('dist', 'scripts', 'play-sprint.js');

function cli(statePath: string, input: string, extra: string[] = []): Array<Record<string, any>> {
  const run = spawnSync(process.execPath, [CLI, '--state', statePath, ...extra],
    { input, encoding: 'utf8', cwd: process.cwd() });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function steps(rows: Array<Record<string, any>>): Array<Record<string, any>> {
  return rows.filter(row => row.command === 'game-step')
    .flatMap(row => row.records as Array<Record<string, any>>);
}

test('G2-P1: the real CLI walks the village grid to the warehouse and the kitchen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-g2p1-'));
  const state = join(dir, 's.json');
  try {
    const rows = cli(state, [
      'map', 'where npc_01', 'travel npc_01 warehouse', 'where npc_01',
      'withdraw npc_01 2', 'travel npc_01 kitchen', 'deliver npc_01 2',
      'task-status', 'quit',
    ].join('\n'), ['--fresh', '--npc', '3']);
    const map = rows.find(row => row.command === 'map')!.map;
    assert.equal(map.w, 50);
    assert.equal(map.h, 40);
    assert.ok(map.buildings.some((building: any) => building.id === 'warehouse'
      && building.door.x === 16 && building.door.y === 15));
    const traveled = rows.filter(row => row.command === 'travel');
    assert.equal(traveled.length, 2);
    for (const travel of traveled) {
      assert.equal(travel.status, 'applied');
      assert.ok(travel.tiles > 0, 'a real path was walked');
      assert.equal(travel.events[0].type, 'traveled');
    }
    assert.equal(traveled[0].location, 'warehouse');
    assert.equal(traveled[1].location, 'kitchen');
    const withdraw = rows.find(row => row.command === 'withdraw')!;
    assert.equal(withdraw.events[0].type, 'stock_withdrawn');
    assert.equal(withdraw.events[0].payload.remaining, 2);
    const deliver = rows.find(row => row.command === 'deliver')!;
    assert.equal(deliver.events[0].type, 'meal_delivered');
    assert.equal(deliver.deliveredMeals, 2);
    const status = rows.find(row => row.command === 'task-status')!.status;
    assert.equal(status.spatial.warehouseFood, 2);
    assert.equal(status.spatial.deliveredMeals, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G2-P2: walls cannot be crossed; a sealed door is an observable report', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-g2p2-'));
  const state = join(dir, 's.json');
  try {
    const rows = cli(state, [
      'close-road 15,15 16,15 17,15 15,16 16,16 17,16',
      'assign npc_01 deliver-meal',
      'game-step', 'game-step',
      'task-status',
      'quit',
    ].join('\n'), ['--fresh', '--npc', '3']);
    const picked = steps(rows).filter(record => record.actorId === 'npc_01');
    assert.ok(picked.some(record => record.selectedId === 'g-report-blocked'),
      'the blocked route leads to an explicit report');
    const status = rows.find(row => row.command === 'task-status')!.status;
    const task = status.tasks.find((item: any) => item.kind === 'deliver-meal');
    assert.equal(task.status, 'active', 'the promise survives the blocked road');
    assert.equal(status.spatial.deliveredMeals, 0, 'no delivery while blocked');
    assert.equal(status.spatial.warehouseFood, 4, 'the stock is untouched by the report');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G2-P3: witnessed shortage changes the next action; restock is retried', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-g2p3-'));
  const state = join(dir, 's.json');
  try {
    const rows = cli(state, [
      'travel npc_01 warehouse', 'withdraw npc_01 4',
      'assign npc_02 deliver-meal',
      'game-step', 'game-step', 'game-step',
      'task-status',
      'restock 2 player', 'tell-restock npc_02',
      'game-step', 'game-step', 'game-step', 'game-step', 'game-step', 'game-step',
      'task-status',
      'quit',
    ].join('\n'), ['--fresh', '--npc', '3']);
    const picked = steps(rows).filter(record => record.actorId === 'npc_02');
    const firstIds = picked.slice(0, 3).map(record => record.selectedId);
    assert.ok(firstIds.includes('g-withdraw'), 'attempts the empty warehouse in person');
    assert.ok(firstIds.some((id: string) => id === 'g-gather-food' || id === 'g-deposit'),
      'then changes the source (R4 inserts the deposit transfer)');
    const statuses = rows.filter(row => row.command === 'task-status')
      .map(row => row.status);
    assert.equal(statuses[0].tasks.find((item: any) => item.kind === 'deliver-meal').status,
      'active');
    assert.equal(statuses[1].tasks.find((item: any) => item.kind === 'deliver-meal').status,
      'done');
    assert.ok(statuses[1].spatial.deliveredMeals >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G2-P4: an explicit cancel means zero delivery; save/restore keeps beliefs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-g2p4-'));
  const state = join(dir, 's.json');
  try {
    const first = cli(state, [
      'travel npc_01 warehouse', 'withdraw npc_01 3',
      'assign npc_02 deliver-meal',
      'game-step', 'game-step',
      'save', 'task-status', 'quit',
    ].join('\n'), ['--fresh', '--npc', '3']);
    const before = first.find(row => row.command === 'task-status')!.status;
    const task = before.tasks.find((item: any) => item.kind === 'deliver-meal');
    const second = cli(state, [
      `cancel-task ${task.taskId}`,
      'game-step', 'game-step',
      'task-status', 'quit',
    ].join('\n'));
    const after = second.find(row => row.command === 'task-status')!.status;
    assert.equal(after.tasks.find((item: any) => item.kind === 'deliver-meal').status,
      'cancelled');
    assert.equal(after.spatial.warehouseFood, before.spatial.warehouseFood,
      'restore keeps the world state');
    assert.equal(after.spatial.deliveredMeals, before.spatial.deliveredMeals,
      'a cancelled task commits no delivery');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('G2-P5: the original 8-NPC four-day chain still runs unchanged', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-g2p5-'));
  const state = join(dir, 's.json');
  try {
    const roster = ['npc_01 gather-food', 'npc_02 gather-food', 'npc_03 gather-food',
      'npc_04 gather-wood', 'npc_05 gather-wood', 'npc_06 heating', 'npc_07 heating',
      'npc_08 leave-food'];
    const script: string[] = [];
    for (let day = 0; day < 4; day += 1) {
      script.push(...roster.map(entry => `assign ${entry}`), 'game-step', 'advance 1440');
    }
    script.push('task-status', 'quit');
    const rows = cli(state, script.join('\n'), ['--fresh', '--food', '12']);
    const status = rows.find(row => row.command === 'task-status')!.status;
    assert.equal(status.hoursElapsed, 96);
    assert.equal(status.ending, 'survived');
    assert.equal(status.spatial, undefined,
      'the classic matrix flow never materializes spatial state');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
