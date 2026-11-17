/**
 * R3 (R): TaskBoard restart ID-collision regressions.
 *
 * Pre-R3 bug: `fromJSON` dropped the sequence counter, so after restore a new
 * assign minted `task-001-...` again and collided with the historical row;
 * cancel/complete used first-match lookup and mutated / missed the wrong row.
 * These tests pin the fixed contract on the unit and across two real CLI
 * processes, including a legacy archive that already carries the bug.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { TaskBoard } from '../src/gameplay-v2/tasks';

function cli(state: string, input: string, extra: string[] = []) {
  const run = spawnSync(process.execPath,
    ['dist/scripts/play-sprint.js', '--state', state, ...extra],
    { input, encoding: 'utf8', cwd: process.cwd() });
  assert.equal(run.status, 0, run.stderr);
  return run.stdout.trim().split('\n').map(line => JSON.parse(line));
}

test('R3-R1: fromJSON restores the sequence high-water mark', () => {
  const board = TaskBoard.fromJSON([
    { taskId: 'task-001-gather-food', actorId: 'npc_01', kind: 'gather-food',
      status: 'done', assignedAt: 0 },
    { taskId: 'task-007-gather-wood', actorId: 'npc_02', kind: 'gather-wood',
      status: 'cancelled', assignedAt: 60 },
  ]);
  const fresh = board.assign('npc_03', 'gather-food', { now: 120 });
  assert.equal(fresh.taskId, 'task-008-gather-food');
  assert.equal(board.tasks.length, 3);
});

test('R3-R2: done -> save -> restore -> new assign -> cancel acts on the new instance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-taskboard-done-'));
  try {
    const state = join(dir, 'session.json');
    const first = cli(state,
      'assign npc_01 gather-food\ngame-step\ntask-status\nsave\nquit\n',
      ['--fresh', '--npc', '3', '--food', '6']);
    const doneBoard = first.find(row => row.command === 'task-status').status.tasks;
    assert.equal(doneBoard.length, 1);
    assert.equal(doneBoard[0].status, 'done');
    assert.equal(doneBoard[0].taskId, 'task-001-gather-food');

    const second = cli(state,
      ['task-status', 'assign npc_01 gather-food', 'task-status',
        'cancel-task task-002-gather-food', 'task-status', 'save', 'quit', ''].join('\n'));
    const [beforeAssign, afterAssign, afterCancel] =
      second.filter(row => row.command === 'task-status')
        .map(row => row.status.tasks as Array<{ taskId: string; status: string }>);
    assert.equal(beforeAssign!.length, 1, 'history restored');
    const assigned = second.find(row => row.command === 'assign').task;
    assert.equal(assigned.taskId, 'task-002-gather-food', 'new instance gets a fresh ID');
    assert.equal(afterAssign!.find(t => t.taskId === 'task-001-gather-food')!.status, 'done');
    assert.equal(afterAssign!.find(t => t.taskId === 'task-002-gather-food')!.status, 'active');
    assert.equal(second.find(row => row.command === 'cancel-task').cancelled, true,
      'cancel must act on the new active instance, not the historical done row');
    assert.equal(afterCancel!.find(t => t.taskId === 'task-001-gather-food')!.status, 'done',
      'old history row untouched');
    assert.equal(afterCancel!.find(t => t.taskId === 'task-002-gather-food')!.status, 'cancelled');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-R3: cancelled -> save -> restore -> new assign gets a fresh active instance', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-taskboard-cancel-'));
  try {
    const state = join(dir, 'session.json');
    cli(state, 'assign npc_01 gather-food\ncancel-task task-001-gather-food\nsave\nquit\n',
      ['--fresh', '--npc', '3', '--food', '6']);
    const second = cli(state, 'assign npc_01 gather-food\ntask-status\nsave\nquit\n');
    const assigned = second.find(row => row.command === 'assign').task;
    assert.equal(assigned.taskId, 'task-002-gather-food');
    const tasks = second.find(row => row.command === 'task-status')
      .status.tasks as Array<{ taskId: string; status: string }>;
    assert.equal(tasks.find(t => t.taskId === 'task-001-gather-food')!.status, 'cancelled');
    assert.equal(tasks.find(t => t.taskId === 'task-002-gather-food')!.status, 'active');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-R4: repeated player command is idempotent across save/restore', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-taskboard-idem-'));
  try {
    const state = join(dir, 'session.json');
    cli(state, 'assign npc_01 gather-food\nsave\nquit\n',
      ['--fresh', '--npc', '3', '--food', '6']);
    const second = cli(state,
      'assign npc_01 gather-food\nassign npc_01 gather-food\ntask-status\nsave\nquit\n');
    const tasks = second.find(row => row.command === 'task-status').status.tasks;
    assert.equal(tasks.length, 1, 're-transmit reuses the active instance');
    assert.equal(tasks[0].taskId, 'task-001-gather-food');
    assert.equal(tasks[0].status, 'active');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R3-R5: legacy duplicate-ID archive resolves cancel to the active row', () => {
  // Shape produced by the pre-R3 bug: history row done + a second active row
  // carrying the same ID. Cancel must hit the active row and leave history.
  const board = TaskBoard.fromJSON([
    { taskId: 'task-001-gather-food', actorId: 'npc_01', kind: 'gather-food',
      status: 'done', assignedAt: 0 },
    { taskId: 'task-001-gather-food', actorId: 'npc_01', kind: 'gather-food',
      status: 'active', assignedAt: 1440 },
  ]);
  assert.equal(board.cancel('task-001-gather-food'), true);
  const byInsertion = board.tasks;
  assert.equal(byInsertion[0].status, 'done');
  assert.equal(byInsertion[1].status, 'cancelled');
});

test('R3-R6: explicit taskId collisions are content-checked and re-minted', () => {
  const board = new TaskBoard();
  board.assign('npc_01', 'gather-food', { taskId: 'task-001-gather-food', now: 0 });
  board.complete('task-001-gather-food');
  // Genuinely new request must not be swallowed by (or reuse) the terminal ID.
  const reissued = board.assign('npc_01', 'gather-food',
    { taskId: 'task-001-gather-food', now: 100 });
  assert.notEqual(reissued.taskId, 'task-001-gather-food');
  assert.equal(reissued.status, 'active');
  assert.equal(board.tasks.filter(t => t.taskId === 'task-001-gather-food').length, 1);

  // Explicit re-transmit naming the active row of the same (actor, kind) is
  // idempotent; naming it for a different actor/kind fails loudly.
  const again = board.assign('npc_01', 'gather-food',
    { taskId: reissued.taskId, now: 110 });
  assert.equal(again.taskId, reissued.taskId);
  assert.throws(() => board.assign('npc_02', 'gather-wood', { taskId: reissued.taskId }));
});
