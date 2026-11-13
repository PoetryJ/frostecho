/**
 * R6 CLI acceptance: supply fulfilment, capture-only queue grants, and the
 * four-morning story. One session; these are the same checks verify-r6 runs.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runStory } from '../../scripts/verify-r6';

const CLI = join('dist', 'scripts', 'play-sprint.js');
const SCORER = join(process.cwd(), 'tests', 'fixtures', 'async-scorer.cjs');

interface Row { [key: string]: any }

function cli(state: string, input: string, extra: string[] = []): Row[] {
  const run = spawnSync(process.execPath, [CLI, '--state', state, ...extra],
    { cwd: process.cwd(), input, encoding: 'utf8', timeout: 60_000 });
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout.slice(-1500)}`);
  return run.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function sidecar(state: string, suffix: string): any {
  return JSON.parse(readFileSync(`${state}${suffix}`, 'utf8'));
}

test('R6-P: a real stock_deposited receipt fulfils only that supply commitment', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r6-p-'));
  const state = join(dir, 's.json');
  try {
    const first = cli(state, 'council-open\ncouncil-resolve\nsave\nquit\n',
      ['--fresh', '--npc', '8']);
    const request = first.find(row => row.command === 'council-resolve')!.requests
      .find((row: Row) => row.role === 'supply');
    cli(state, `council-respond ${request.requestId} accept\n${'game-step\n'.repeat(4)}save\nquit\n`);
    const committed = sidecar(state, '.commitments.json').commitments
      .find((row: Row) => row.goal === 'supply-warehouse');
    const task = sidecar(state, '.tasks.json').find((row: Row) => row.commitmentId === committed.commitmentId);
    assert.equal(task.status, 'done');
    assert.equal(committed.status, 'fulfilled');
    assert.ok(committed.evidenceEventIds.length > 0);
    assert.ok(committed.evidenceEventIds[0].includes(':stock_deposited:'));
    const again = cli(state, 'game-step\ncommitment-status\nsave\nquit\n');
    const restored = again.find(row => row.command === 'commitment-status')!.commitments
      .find((row: Row) => row.commitmentId === committed.commitmentId);
    assert.equal(restored.status, 'fulfilled');
    assert.deepEqual(restored.evidenceEventIds, committed.evidenceEventIds);
    const food = JSON.parse(readFileSync(state, 'utf8')).world.spatial.stocks.warehouse.food;
    assert.equal(food, 6);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R6-P: cancel before the deposit does not fulfil, and a meal receipt still does', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r6-p2-'));
  const state = join(dir, 's.json');
  try {
    const first = cli(state, 'council-open\ncouncil-resolve\nsave\nquit\n',
      ['--fresh', '--npc', '8']);
    const requests = first.find(row => row.command === 'council-resolve')!.requests;
    const supply = requests.find((row: Row) => row.role === 'supply');
    const deliver = requests.find((row: Row) => row.role === 'deliver');
    const accepted = cli(state, `council-respond ${supply.requestId} accept\n`
      + `council-respond ${deliver.requestId} accept\nsave\nquit\n`);
    const supplyId = accepted.find(row => row.command === 'council-respond')!.commitment.commitmentId;
    cli(state, `relinquish ${supplyId}\n${'game-step\n'.repeat(6)}save\nquit\n`);
    const rows = sidecar(state, '.commitments.json').commitments;
    const supplyRow = rows.find((row: Row) => row.commitmentId === supplyId);
    const meal = rows.find((row: Row) => row.goal === 'deliver-meal');
    assert.equal(supplyRow.status, 'withdrawn');
    assert.deepEqual(supplyRow.evidenceEventIds, []);
    assert.equal(meal.status, 'fulfilled');
    assert.ok(meal.evidenceEventIds[0].includes(':meal_delivered:'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R6-R: a step outside the save capture runs once, and an explicit cancel stays dead', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r6-r-'));
  const state = join(dir, 's.json');
  const started = join(dir, 'started');
  const release = join(dir, 'release');
  const child = spawn(process.execPath, [CLI, '--fresh', '--npc', '2', '--state', state, '--scorer', SCORER], {
    cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, R3_SCORER_STARTED: started, R3_SCORER_RELEASE: release,
      R3_SCORER_TARGET: 'c-eat', R4_BARRIER_MS: '350', R4_STEP_TIMEOUT_MS: '5000' },
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  const rows = () => out.trim() ? out.trim().split('\n').map(line => JSON.parse(line)) : [];
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(out.slice(-1500));
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  try {
    await wait(() => rows().some(row => row.event === 'ready'));
    child.stdin.write('step npc_01\n');
    await wait(() => existsSync(started));
    child.stdin.write('save\nstep npc_01\n');
    await wait(() => rows().some(row => row.command === 'save' && row.saved));
    writeFileSync(release, 'go');
    await wait(() => rows().filter(row => row.command === 'step').length === 2);
    child.stdin.write('step npc_01\nsave\nquit\n');
    await new Promise(resolve => child.on('close', resolve));
    const steps = rows().filter(row => row.command === 'step');
    assert.equal(steps[0].decisions[0].executed, false);
    assert.equal(steps[1].decisions[0].executed, true);
    assert.equal(steps[1].decisions[0].eventIds.length > 0, true);
    assert.equal(steps[2].decisions[0].executed, true);
    const saved = JSON.parse(readFileSync(state, 'utf8'));
    assert.equal(saved.world.version, 2);
  } finally {
    if (child.exitCode === null) child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R6 play: four mornings, one exit, one observed shortage, both arms agree', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r6-play-'));
  try {
    const story = await runStory(dir);
    assert.equal(story.pass, true, story.reason);
    assert.ok(story.continuous.simMinutes > 4320);
    assert.equal(story.continuous.simMinutes, story.segmented.simMinutes);
    assert.ok(story.continuous.supplyFulfilled >= 1);
    assert.ok(story.continuous.mealFulfilled >= 1);
    assert.equal(story.continuous.activeWithOpenPromise, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
