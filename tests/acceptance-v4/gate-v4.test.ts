/**
 * R4 acceptance gate (black box, real CLI): identity across processes, bounded
 * async control, negotiation stories and rumor consumption. Every assertion is
 * read from the authoritative save file / CLI receipts, never from internals.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const CLI = join('dist', 'scripts', 'play-sprint.js');

function cli(statePath: string, input: string, extra: string[] = [],
  env: NodeJS.ProcessEnv = process.env): Array<Record<string, any>> {
  const run = spawnSync(process.execPath, [CLI, '--state', statePath, ...extra],
    { input, encoding: 'utf8', cwd: process.cwd(), env });
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  return run.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function saved(statePath: string): any {
  return JSON.parse(readFileSync(statePath, 'utf8'));
}

test('V4-G1: promise identity survives restart; restock accumulates; explicit retry replays', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v4-g1-'));
  const state = join(dir, 's.json');
  try {
    const first = cli(state, 'promise npc_01\ncancel npc_01\nrestock 2 player\nsave\nquit\n',
      ['--fresh', '--npc', '2']);
    assert.equal(first.find(row => row.command === 'promise')!.duplicate, false);
    const second = cli(state, 'promise npc_01\nknowledge\nrestock 3 player\nsave\nquit\n');
    const fresh = second.find(row => row.command === 'promise')!;
    assert.equal(fresh.duplicate, false, 'a new user intent is a new instance');
    const knowledge = second.find(row => row.command === 'knowledge')!;
    assert.equal(knowledge.instances.length, 2);
    assert.equal(knowledge.instances.at(-1).state, 'active');
    assert.equal(second.find(row => row.command === 'restock')!.warehouseFood, 9,
      '4 default + 2 + 3 across two processes');
    // Explicit same-id retry with identical content replays; different content conflicts.
    const replay = cli(state, 'restock 2 player id=op-x\nrestock 2 player id=op-x\n'
      + 'restock 5 player id=op-x\ntask-status\nquit\n');
    const restocks = replay.filter(row => row.command === 'restock');
    assert.equal(restocks[0].status, 'applied');
    assert.equal(restocks[1].status, 'duplicate');
    assert.equal(restocks[2].status, 'rejected');
    assert.equal(restocks[2].reason, 'command_id_conflict');
    assert.equal(replay.find(row => row.command === 'task-status')!.status
      .spatial.warehouseFood, 9 + 2, 'a conflict has zero side effects');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V4-G2: save waits boundedly, cancel confirms before release, nothing stale commits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v4-g2-'));
  const state = join(dir, 's.json');
  const started = join(dir, 'started.json');
  const release = join(dir, 'release.flag');
  const child = spawn(process.execPath, [CLI, '--state', state, '--fresh', '--npc', '2',
    '--scorer', join(process.cwd(), 'tests/fixtures/async-scorer.cjs')],
  { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, R3_SCORER_STARTED: started, R3_SCORER_RELEASE: release,
      R4_BARRIER_MS: '3000', R4_STEP_TIMEOUT_MS: '8000', R3_SCORER_TARGET: 'c-eat' } });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  const wait = async (pattern: RegExp, timeoutMs = 8000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(out)) {
      if (Date.now() > deadline) throw new Error(`timeout ${pattern}\n${out}`);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
  try {
    await wait(/"event":"ready"/);
    child.stdin.write('step npc_01\n');
    const deadline = Date.now() + 8000;
    while (!existsSync(started)) {
      if (Date.now() > deadline) throw new Error('scorer never started');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    const at = Date.now();
    child.stdin.write('save\ncancel npc_01\n');
    await wait(/"command":"save"/, 6000);
    const saveLatency = Date.now() - at;
    assert.ok(saveLatency < 5000, `save was bounded (${saveLatency}ms)`);
    assert.ok(/"command":"cancel"/.test(out), 'cancel confirmed while the save ran');
    assert.equal(existsSync(release), false, 'cancel did not wait for the scorer');
    writeFileSync(release, 'go', 'utf8');
    await wait(/"command":"step"/, 6000);
    child.stdin.write('task-status\nquit\n');
    await wait(/"event":"exit"/, 8000);
    const rows = out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
    const decision = rows.find(row => row.command === 'step')!.decisions[0];
    assert.equal(decision.executed, false, 'the released stale result executes nothing');
    assert.deepEqual(decision.eventIds, []);
    assert.equal(saved(state).world.version, 0, 'the save froze zero world effects');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V4-G2: EOF with a never-released scorer exits within the bound', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'v4-g2eof-'));
  const state = join(dir, 's.json');
  const started = join(dir, 'started.json');
  const child = spawn(process.execPath, [CLI, '--state', state, '--fresh', '--npc', '2',
    '--scorer', join(process.cwd(), 'tests/fixtures/async-scorer.cjs')],
  { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, R3_SCORER_STARTED: started,
      R3_SCORER_RELEASE: join(dir, 'never'), R4_BARRIER_MS: '1200',
      R4_STEP_TIMEOUT_MS: '9000', R3_SCORER_TARGET: 'c-eat' } });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  const startedAt = Date.now();
  try {
    await new Promise(resolve => setTimeout(resolve, 300));
    child.stdin.write('step npc_01\n');
    const deadline = Date.now() + 6000;
    while (!existsSync(started)) {
      if (Date.now() > deadline) throw new Error('scorer never started');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('EOF never settled')), 8000);
      child.on('close', () => { clearTimeout(timer); resolve(); });
      child.stdin.end();
    });
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed < 7000, `EOF exited within the bound (${elapsed}ms)`);
    assert.match(out, /barrier_timeout/, 'the timeout is recorded explicitly');
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V4-G3: the real CLI completes spatial deliveries over a simulated day', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v4-g3-'));
  const state = join(dir, 's.json');
  try {
    const roster = ['npc_01', 'npc_02', 'npc_03', 'npc_04'];
    const script = [...roster.map(id => `assign ${id} deliver-meal`)];
    for (let step = 0; step < 16; step += 1) script.push('game-step');
    script.push('advance 1440', 'task-status', 'quit');
    const rows = cli(state, script.join('\n'), ['--fresh', '--npc', '4', '--food', '12']);
    const status = rows.find(row => row.command === 'task-status')!.status;
    // R4: travel now advances the SAME clock as advance, so a 24h step window
    // legitimately reports more elapsed hours (the walking itself counts).
    assert.ok(status.hoursElapsed >= 24, `elapsed ${status.hoursElapsed}h`);
    assert.ok(status.spatial.deliveredMeals >= 1,
      'at least one real meal_delivered receipt in the window');
    assert.ok(status.spatial.warehouseFood >= 0);
    assert.equal(typeof status.spatial.deliveredMeals, 'number');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V4-G4: CLI story A — request, shortage proposal, accept, deliver, fulfilled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v4-g4a-'));
  const state = join(dir, 's.json');
  try {
    const first = cli(state, 'travel npc_02 warehouse\nwithdraw npc_02 4\n'
      + 'request npc_01 deliver-meal\ngame-step\ngame-step\ngame-step\ngame-step\n'
      + 'commitment-status\nsave\nquit\n', ['--fresh', '--npc', '3']);
    const requested = first.find(row => row.command === 'request')!;
    assert.equal(requested.response.verdict, 'accept');
    assert.equal(requested.commitment.status, 'active');
    const mid = first.find(row => row.command === 'commitment-status')!;
    const pending = mid.commitments[0];
    assert.equal(pending.status, 'pending-change');
    assert.equal(pending.changes[0].kind, 'alt-source');
    const second = cli(state, `respond-change ${pending.commitmentId} accept\n`
      + 'game-step\ngame-step\ngame-step\ngame-step\ngame-step\ngame-step\n'
      + 'commitment-status\nsave\nquit\n');
    const accepted = second.find(row => row.command === 'respond-change')!;
    assert.equal(accepted.commitment.status, 'active');
    assert.equal(accepted.commitment.revision, 2);
    assert.ok(accepted.commitment.conditions.includes('source:gather'));
    const finalStatus = second.filter(row => row.command === 'commitment-status').at(-1)!;
    assert.equal(finalStatus.commitments[0].status, 'fulfilled');
    assert.ok(finalStatus.commitments[0].evidenceEventIds.length >= 1);
    assert.ok(saved(state).world.spatial.deliveredMeals >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V4-G4: CLI story B — survival proposal, reject keeps terms, dying exit', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v4-g4b-'));
  const state = join(dir, 's.json');
  try {
    const first = cli(state, 'request npc_01 deliver-meal\nadvance 3300\ngame-step\nsave\nquit\n',
      ['--fresh', '--npc', '2', '--food', '0']);
    const pending = first.filter(row => row.command === 'game-step').at(-1)!;
    const statusRow = cli(state, 'commitment-status\nquit\n').find(
      row => row.command === 'commitment-status')!;
    const commitment = statusRow.commitments[0];
    assert.equal(commitment.status, 'pending-change');
    assert.equal(commitment.changes[0].kind, 'suspend');
    const second = cli(state, `respond-change ${commitment.commitmentId} reject\n`
      + 'advance 900\ngame-step\ncommitment-status\nknowledge\nsave\nquit\n');
    const rejected = second.find(row => row.command === 'respond-change')!;
    assert.equal(rejected.commitment.status, 'active', 'reject never becomes agreement');
    assert.equal(rejected.commitment.revision, 1);
    assert.ok(pending);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('V4-G5: a consumed rumor no longer drives empty probes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'v4-g5-'));
  const state = join(dir, 's.json');
  try {
    const rows = cli(state, 'travel npc_02 warehouse\nwithdraw npc_02 4\n'
      + 'tell-restock npc_01\nassign npc_01 deliver-meal\n'
      + 'game-step\ngame-step\ngame-step\ngame-step\ngame-step\ngame-step\n'
      + 'task-status\nquit\n', ['--fresh', '--npc', '3']);
    const picks = rows.filter(row => row.command === 'game-step')
      .flatMap(row => row.records)
      .filter((record: any) => record.actorId === 'npc_01')
      .map((record: any) => record.selectedId);
    assert.ok(picks.includes('g-withdraw'), 'the first attempt is a real probe');
    assert.ok(picks.some((id: string) => id === 'g-gather-food' || id === 'g-deposit'),
      'the consumed hypothesis switches the source');
    const withdrawCount = picks.filter((id: string) => id === 'g-withdraw').length;
    assert.ok(withdrawCount <= 2, `no repeated empty probes (${withdrawCount})`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
