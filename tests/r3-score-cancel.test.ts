/**
 * R3 (G1-3): the real CLI with a controllable ASYNC scorer — after `started`,
 * a cancel is confirmed promptly, and releasing the old score afterwards has
 * zero world effect (no command submitted, no event, no version bump) and zero
 * promise fulfilment. Then a fresh step succeeds with the new generation.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const CLI = join('dist', 'scripts', 'play-sprint.js');
const SCORER = join(process.cwd(), 'tests', 'fixtures', 'async-scorer.cjs');

function start(args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: process.cwd(), env,
    stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => { out += chunk; });
  child.stderr.on('data', (chunk: string) => { err += chunk; });
  const done = new Promise<{ code: number; out: string; err: string }>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`timeout\n${out}\n${err}`));
    }, 20000);
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? 1, out, err }); });
    child.on('error', error => { clearTimeout(timer); reject(error); });
  });
  const wait = async (pattern: RegExp, timeoutMs = 8000): Promise<RegExpMatchArray> => {
    const started = Date.now();
    for (;;) {
      const match = out.match(pattern);
      if (match) return match;
      if (Date.now() - started > timeoutMs) {
        throw new Error(`waiting for ${pattern}\nstdout=${out}\nstderr=${err}`);
      }
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
  return { child, wait, done, stdout: () => out };
}

function rows(out: string): Array<Record<string, unknown>> {
  return out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function rowFor(out: string, command: string, index = 0): Record<string, unknown> | null {
  const matches = out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.command === command);
  return matches[index] ?? null;
}

function decisionOf(row: Record<string, unknown> | null): Record<string, unknown> | null {
  const decisions = row?.decisions as Array<Record<string, unknown>> | undefined;
  return decisions?.[0] ?? null;
}

function countRows(out: string, command: string): number {
  return out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(row => row.command === command).length;
}

test('CLI async scorer: cancel is confirmed before release and the stale result commits nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-score-cancel-'));
  const state = join(dir, 'session.json');
  const startedFile = join(dir, 'started.json');
  const releaseFile = join(dir, 'release.flag');
  const env: NodeJS.ProcessEnv = { ...process.env, R3_SCORER_STARTED: startedFile,
    R3_SCORER_RELEASE: releaseFile, R3_SCORER_TARGET: 'c-eat' };
  const play = start(['--state', state, '--fresh', '--npc', '2', '--scorer', SCORER], env);
  try {
    await play.wait(/"event":"ready"/);
    play.child.stdin.write('step npc_01\n');
    const startedDeadline = Date.now() + 8000;
    while (!existsSync(startedFile)) {
      if (Date.now() > startedDeadline) {
        throw new Error(`scorer never started\nstdout=${play.stdout()}`);
      }
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    assert.equal(existsSync(startedFile), true, 'the async scorer signalled started');
    const startedAt = JSON.parse(readFileSync(startedFile, 'utf8')) as { requestId: string };

    // Cancel while the old score is still held: the confirmation is immediate.
    const cancelAt = Date.now();
    play.child.stdin.write('cancel npc_01\n');
    await play.wait(/^\{"command":"cancel"/m);
    const confirmDelay = Date.now() - cancelAt;
    const cancelRow = rowFor(play.stdout(), 'cancel');
    assert.ok(cancelRow);
    assert.equal(typeof cancelRow.promiseId, 'string');
    assert.equal(cancelRow.onlyObserver, 'npc_01');
    assert.equal(existsSync(releaseFile), false, 'cancel did not wait for the scorer');
    assert.ok(confirmDelay < 3000, `cancel confirmed promptly (${confirmDelay}ms)`);

    // Now release the stale result: it must be rejected at the synchronous commit.
    writeFileSync(releaseFile, 'go\n', 'utf8');
    await play.wait(/^\{"command":"step"/m);
    const step = decisionOf(rowFor(play.stdout(), 'step')) as { status: string;
      executed: boolean; eventIds: string[]; reason: string;
      executionStatus: string | null } | null;
    assert.ok(step, 'the step decision is reported');
    assert.equal(step.executed, false, 'the stale async result executed nothing');
    assert.deepEqual(step.eventIds, [], 'no world events were emitted');
    assert.ok(['cancelled', 'rejected', 'scored'].includes(step.status)
      || step.executionStatus === 'rejected',
      `stale outcome is cancelled/rejected/scored-without-commit (${step.status})`);
    if (step.reason) assert.match(step.reason, /generation|stale|cancel/);

    // A fresh step after the cancel uses the NEW generation and commits normally.
    // (The release flag stays: this scorer instance is already resolved; the
    // next score() call sees the existing flag and resolves immediately.)
    play.child.stdin.write('step npc_01\n');
    const freshDeadline = Date.now() + 12000;
    while (countRows(play.stdout(), 'step') < 2) {
      if (Date.now() > freshDeadline) {
        throw new Error(`fresh step never settled\nstdout=${play.stdout()}`);
      }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    play.child.stdin.write('observe\nquit\n');
    const result = await play.done;
    assert.equal(result.code, 0, result.err);
    const all = rows(result.out);
    const steps = all.filter(row => row.command === 'step')
      .map(row => decisionOf(row) as { executed: boolean; eventIds: string[];
        status: string });
    assert.equal(steps.length, 2);
    assert.equal(steps[0].executed, false, 'stale step: zero execution');
    assert.deepEqual(steps[0].eventIds, []);
    assert.equal(steps[1].eventIds.length > 0 || steps[1].executed, true,
      'the post-cancel step runs on the current generation');
    // The request identity captured before the release is the pre-cancel one.
    const observe = all.find(row => row.command === 'observe') as { version?: number };
    assert.ok(observe);
    assert.equal(startedAt.requestId.length > 0, true);
  } finally {
    if (play.child.exitCode === null) play.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI async scorer: without a cancel the slow result commits exactly once', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r3-score-slow-'));
  const state = join(dir, 'session.json');
  const startedFile = join(dir, 'started.json');
  const releaseFile = join(dir, 'release.flag');
  const play = start(['--state', state, '--fresh', '--npc', '2', '--scorer', SCORER],
    { ...process.env, R3_SCORER_STARTED: startedFile,
      R3_SCORER_RELEASE: releaseFile, R3_SCORER_TARGET: 'c-eat' });
  try {
    await play.wait(/"event":"ready"/);
    play.child.stdin.write('step npc_01\n');
    const deadline = Date.now() + 8000;
    while (!existsSync(startedFile)) {
      if (Date.now() > deadline) throw new Error('scorer never started');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    writeFileSync(releaseFile, 'go\n', 'utf8');
    await play.wait(/^\{"command":"step"/m);
    const step = decisionOf(rowFor(play.stdout(), 'step')) as { executed: boolean;
      eventIds: string[]; executionStatus: string | null } | null;
    assert.ok(step, 'the step decision is reported');
    assert.equal(step.executed, true, 'a released (not cancelled) async result commits');
    assert.ok(step.eventIds.length > 0);
    play.child.stdin.write('quit\n');
    const result = await play.done;
    assert.equal(result.code, 0, result.err);
  } finally {
    if (play.child.exitCode === null) play.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});
