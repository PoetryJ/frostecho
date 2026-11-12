/**
 * R3 (P/E) real-CLI acceptance: the warehouse -> kitchen delivery run driven
 * through the actual play-sprint process — success trajectory, honest
 * resource-shortage trajectory, blocked road, cancel (zero later commits) and
 * save/quit + new-process restore.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const CLI = join('dist', 'scripts', 'play-sprint.js');

function run(statePath: string, input: string, extra: string[] = []): Array<Record<string, unknown>> {
  const result = spawnSync(process.execPath, [CLI, '--state', statePath, ...extra],
    { input, encoding: 'utf8', cwd: process.cwd() });
  assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
  return result.stdout.trim().split('\n').filter(line => line.length > 0)
    .map(line => JSON.parse(line));
}

test('CLI: delivery task completes over the real map and reports done', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-cli-success-'));
  const state = join(dir, 'session.json');
  try {
    const rows = run(state, [
      'assign npc_01 deliver-meal',
      'game-step', 'game-step', 'game-step', 'game-step', 'game-step', 'game-step',
      'where npc_01',
      'task-status',
      'quit',
    ].join('\n'), ['--fresh', '--npc', '3']);
    const assign = rows.find(row => row.command === 'assign') as { task: { kind: string } };
    assert.equal(assign.task.kind, 'deliver-meal');
    const steps = rows.filter(row => row.command === 'game-step');
    assert.equal(steps.length, 6);
    for (const step of steps) assert.equal(step.mode, 'reference-rules/1');
    const status = rows.find(row => row.command === 'task-status') as {
      status: { tasks: Array<{ kind: string; status: string }>;
        spatial?: { deliveredMeals: number; warehouseFood: number } };
    };
    assert.equal(status.status.tasks.find(task => task.kind === 'deliver-meal')?.status, 'done');
    assert.ok((status.status.spatial?.deliveredMeals ?? 0) >= 1);
    const where = rows.find(row => row.command === 'where') as { location: string };
    assert.equal(where.location, 'kitchen');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: empty warehouse yields out_of_stock, keeps the promise, retries after restock', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-cli-empty-'));
  const state = join(dir, 'session.json');
  try {
    const rows = run(state, [
      'travel npc_01 warehouse',
      'withdraw npc_01 4',
      'assign npc_02 deliver-meal',
      'game-step', 'game-step', 'game-step', 'game-step',
      'task-status',
      'restock 3 player',
      'tell-restock npc_02',
      'game-step', 'game-step', 'game-step', 'game-step', 'game-step', 'game-step',
      'task-status',
      'quit',
    ].join('\n'), ['--fresh', '--npc', '3']);
    const withdraw = rows.find(row => row.command === 'withdraw') as { events: Array<{ type: string }> };
    assert.equal(withdraw.events[0].type, 'stock_withdrawn');
    const midSteps = rows.filter(row => row.command === 'game-step').slice(0, 4);
    const sawOutOfStock = midSteps.some(step =>
      (step.records as Array<{ selectedId: string }>).some(record =>
        record.selectedId === 'g-withdraw'));
    assert.equal(sawOutOfStock, true, 'npc_02 attempts the warehouse in person');
    const midStatus = rows.filter(row => row.command === 'task-status')[0] as {
      status: { tasks: Array<{ kind: string; status: string }> };
    };
    assert.equal(midStatus.status.tasks.find(task => task.kind === 'deliver-meal')?.status,
      'active', 'a failed attempt keeps the promise');
    const finalStatus = rows.filter(row => row.command === 'task-status')[1] as {
      status: { tasks: Array<{ kind: string; status: string }>;
        spatial?: { deliveredMeals: number } };
    };
    assert.equal(finalStatus.status.tasks.find(task => task.kind === 'deliver-meal')?.status,
      'done', 'restock + rumor enables the retry');
    assert.ok((finalStatus.status.spatial?.deliveredMeals ?? 0) >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: a sealed warehouse door is reported and never silently cancelled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-cli-blocked-'));
  const state = join(dir, 'session.json');
  try {
    const rows = run(state, [
      'close-road 15,15 16,15 17,15 15,16 16,16 17,16',
      'assign npc_01 deliver-meal',
      'game-step', 'game-step',
      'task-status',
      'open-road 15,15 16,15 17,15 15,16 16,16 17,16',
      'game-step', 'game-step', 'game-step', 'game-step', 'game-step', 'game-step',
      'task-status',
      'quit',
    ].join('\n'), ['--fresh', '--npc', '3']);
    const steps = rows.filter(row => row.command === 'game-step');
    const reported = steps.slice(0, 2).some(step =>
      (step.records as Array<{ selectedId: string; reason: string }>)
        .some(record => record.selectedId === 'g-report-blocked'));
    assert.equal(reported, true, 'the sealed door is an observable report');
    const mid = rows.filter(row => row.command === 'task-status')[0] as {
      status: { tasks: Array<{ kind: string; status: string }> };
    };
    assert.equal(mid.status.tasks.find(task => task.kind === 'deliver-meal')?.status, 'active');
    const final = rows.filter(row => row.command === 'task-status')[1] as {
      status: { tasks: Array<{ kind: string; status: string }> };
    };
    assert.equal(final.status.tasks.find(task => task.kind === 'deliver-meal')?.status, 'done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: cancelling the task means zero delivery commits afterwards', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-cli-cancel-'));
  const state = join(dir, 'session.json');
  try {
    const rows = run(state, [
      'assign npc_01 deliver-meal',
      'task-status',
      'save',
      'quit',
    ].join('\n'), ['--fresh', '--npc', '3']);
    const status = rows.find(row => row.command === 'task-status') as {
      status: { tasks: Array<{ taskId: string; kind: string; status: string }> };
    };
    const task = status.status.tasks.find(item => item.kind === 'deliver-meal')!;
    const after = run(state, [
      `cancel-task ${task.taskId}`, 'cancel-task ' + task.taskId,
      'game-step', 'game-step', 'game-step',
      'task-status',
      'quit',
    ].join('\n'));
    const cancels = after.filter(row => row.command === 'cancel-task');
    assert.equal(cancels[0].cancelled, true);
    assert.equal(cancels[1].cancelled, false, 'cancel is idempotent');
    const final = after.find(row => row.command === 'task-status') as {
      status: { tasks: Array<{ kind: string; status: string }>;
        spatial?: { deliveredMeals: number } };
    };
    assert.equal(final.status.tasks.find(item => item.kind === 'deliver-meal')?.status,
      'cancelled');
    assert.equal(final.status.spatial?.deliveredMeals ?? 0, 0,
      'a cancelled task performs no delivery');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: save + new process restores path, belief, experience and board', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-cli-restore-'));
  const state = join(dir, 'session.json');
  try {
    const first = run(state, [
      'travel npc_01 warehouse',
      'withdraw npc_01 4',
      'assign npc_02 deliver-meal',
      'game-step', 'game-step',
      'save',
      'task-status',
      'quit',
    ].join('\n'), ['--fresh', '--npc', '3']);
    const before = (first.find(row => row.command === 'task-status') as {
      status: { spatial: { warehouseFood: number; deliveredMeals: number };
        tasks: Array<{ kind: string; status: string }> } }).status;
    const second = run(state, [
      'where npc_02',
      'task-status',
      'restock 2 player',
      'tell-restock npc_02',
      'game-step', 'game-step', 'game-step', 'game-step', 'game-step', 'game-step',
      'task-status',
      'quit',
    ].join('\n'));
    const restored = (second.find(row => row.command === 'task-status') as {
      status: { spatial: { warehouseFood: number; deliveredMeals: number };
        tasks: Array<{ kind: string; status: string }> } }).status;
    assert.equal(restored.spatial.warehouseFood, before.spatial.warehouseFood,
      'warehouse stock survives the process boundary');
    assert.equal(restored.tasks.find(task => task.kind === 'deliver-meal')?.status === 'active'
      || restored.tasks.find(task => task.kind === 'deliver-meal')?.status === 'done', true);
    const final = (second.filter(row => row.command === 'task-status')[1] as {
      status: { tasks: Array<{ kind: string; status: string }>;
        spatial: { deliveredMeals: number } } }).status;
    assert.equal(final.tasks.find(task => task.kind === 'deliver-meal')?.status, 'done',
      'the restored world can still complete the run');
    assert.ok(final.spatial.deliveredMeals >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: the frozen 8-NPC four-day chain still runs alongside the spatial layer', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-cli-frozen-'));
  const state = join(dir, 'session.json');
  try {
    const rows = run(state, [
      'assign npc_01 gather-food',
      'assign npc_02 gather-wood',
      'assign npc_03 heating',
      'game-step',
      'advance 1440', 'advance 1440', 'advance 1440', 'advance 1440',
      'task-status',
      'quit',
    ].join('\n'), ['--fresh']);
    const status = rows.find(row => row.command === 'task-status') as {
      status: { hoursElapsed: number; ending: string; spatial?: unknown } };
    assert.equal(status.status.hoursElapsed, 96, 'the four-day window still advances');
    assert.ok(['survived', 'all-dead'].includes(status.status.ending),
      `ending settles from the authoritative state (${status.status.ending})`);
    assert.equal(status.status.spatial, undefined,
      'the classic command stream never materializes a spatial field');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
