/**
 * R5 acceptance (black box, real CLI): the repaired commitment lifecycle, the
 * capture-only save barrier, canonical travel receipts, and the morning-council
 * vertical slice through a real 96h save/restore run.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const CLI = join('dist', 'scripts', 'play-sprint.js');
const SCORER = join(process.cwd(), 'tests', 'fixtures', 'async-scorer.cjs');

interface Row { [key: string]: any }

function cli(state: string, input: string, extra: string[] = [],
  env: NodeJS.ProcessEnv = process.env): Row[] {
  const run = spawnSync(process.execPath, [CLI, '--state', state, ...extra],
    { cwd: process.cwd(), input, encoding: 'utf8', timeout: 120_000, env });
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout.slice(-4000)}`);
  return run.stdout.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function sidecar<T = any>(state: string, suffix: string): T {
  return JSON.parse(readFileSync(`${state}${suffix}`, 'utf8')) as T;
}

function saved(state: string): any {
  return JSON.parse(readFileSync(state, 'utf8'));
}

async function live(state: string, env: NodeJS.ProcessEnv): Promise<{
  child: ReturnType<typeof spawn>; rows: () => Row[]; wait: (pattern: RegExp,
    timeoutMs?: number) => Promise<void>; done: Promise<number | null>;
}> {
  const child = spawn(process.execPath, [CLI, '--state', state, '--fresh', '--npc', '2',
    '--scorer', SCORER], { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, R4_BARRIER_MS: '400', R4_STEP_TIMEOUT_MS: '9000',
      R3_SCORER_TARGET: 'c-eat', ...env } });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  const rows = () => out.trim() ? out.trim().split('\n').map(line => JSON.parse(line)) : [];
  const wait = async (pattern: RegExp, timeoutMs = 15_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!pattern.test(out)) {
      if (Date.now() > deadline) throw new Error(`timeout ${pattern}\n${out}`);
      await new Promise(resolve => setTimeout(resolve, 15));
    }
  };
  const done = new Promise<number | null>(resolve => child.on('close', resolve));
  return { child, rows, wait, done };
}

test('R5-G1: terminal withdraw cancels the bound task and delivers nothing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-g1w-'));
  const state = join(dir, 's.json');
  try {
    cli(state, 'request npc_01 deliver-meal\nsave\nquit\n', ['--fresh', '--npc', '2']);
    const commitment = sidecar(state, '.commitments.json').commitments[0];
    const rows = cli(state, `relinquish ${commitment.commitmentId}\n`
      + `${'game-step\n'.repeat(8)}save\nquit\n`);
    const after = sidecar(state, '.commitments.json');
    const tasks = sidecar(state, '.tasks.json');
    assert.equal(after.commitments[0].status, 'withdrawn');
    assert.ok(tasks.every((task: any) => task.kind !== 'deliver-meal'
      || task.status === 'cancelled'), 'the work row is terminal, never legacy');
    assert.equal(saved(state).world.spatial?.deliveredMeals ?? 0, 0);
    assert.ok(rows.filter(row => row.command === 'game-step')
      .flatMap(row => row.records).every((record: any) => record.actorId !== 'npc_01'
        || record.selectedId !== 'g-deliver'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R5-G2: cancel closes an open change; a later old accept cannot revive it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-g2-'));
  const state = join(dir, 's.json');
  try {
    cli(state, 'travel npc_02 warehouse\nwithdraw npc_02 4\n'
      + 'request npc_01 deliver-meal\n' + 'game-step\n'.repeat(4) + 'save\nquit\n',
    ['--fresh', '--npc', '2']);
    const before = sidecar(state, '.commitments.json').commitments[0];
    assert.equal(before.status, 'pending-change');
    const rows = cli(state, `cancel-commitment ${before.commitmentId}\n`
      + `respond-change ${before.commitmentId} accept\ncommitment-status\nsave\nquit\n`);
    const after = sidecar(state, '.commitments.json').commitments[0];
    const tasks = sidecar(state, '.tasks.json');
    assert.equal(after.status, 'cancelled');
    assert.equal(after.revision, before.revision);
    assert.ok(after.changes.every((change: any) => change.status !== 'open'));
    assert.ok(tasks.every((task: any) => task.kind !== 'deliver-meal'
      || task.status === 'cancelled'));
    assert.equal(saved(state).world.spatial.deliveredMeals, 0);
    const ignored = rows.find(row => row.command === 'respond-change')!;
    assert.match(String(ignored.event.type), /ignored/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R5-G3: counter-accept binds one task, waits for the condition, then delivers', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-g3-'));
  const state = join(dir, 's.json');
  try {
    cli(state, 'advance 4000\nrequest npc_01 deliver-meal\nsave\nquit\n',
      ['--fresh', '--npc', '2']);
    const commitment = sidecar(state, '.commitments.json').commitments[0];
    assert.equal(commitment.status, 'proposed');
    const accept = cli(state, `respond-change ${commitment.commitmentId} accept\n`
      + 'game-step\ncommitment-status\nsave\nquit\n');
    const status = accept.find(row => row.command === 'commitment-status')!;
    const row = status.commitments[0];
    assert.equal(row.status, 'active');
    assert.ok(row.taskId, 'the accepted counter has exactly one linked task');
    const tasks = sidecar(state, '.tasks.json');
    assert.equal(tasks.filter((task: any) => task.kind === 'deliver-meal').length, 1);
    assert.equal(tasks[0].status, 'active');
    assert.equal(saved(state).world.spatial?.deliveredMeals ?? 0, 0,
      'the unmet resumeWhen is a real wait gate');
    // Eat to the agreed hunger threshold, then execute the same task.
    const later = cli(state, `${'game-step\n'.repeat(12)}commitment-status\nsave\nquit\n`);
    const final = later.filter(row => row.command === 'commitment-status').at(-1)!;
    assert.ok((saved(state).world.spatial?.deliveredMeals ?? 0) >= 1);
    assert.equal(final.commitments[0].status, 'fulfilled');
    assert.ok(final.commitments[0].evidenceEventIds.length >= 1);
    assert.equal(sidecar(state, '.tasks.json')
      .find((task: any) => task.kind === 'deliver-meal').status, 'done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R5-G4: a save barrier revokes exactly its captured queued steps', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-g4-'));
  const state = join(dir, 's.json');
  const started = join(dir, 'started');
  const release = join(dir, 'release');
  const running = await live(state, { R3_SCORER_STARTED: started, R3_SCORER_RELEASE: release });
  try {
    await running.wait(/"event":"ready"/);
    running.child.stdin!.write('step npc_01\nstep npc_02\n');
    const deadline = Date.now() + 8000;
    while (!existsSync(started)) {
      if (Date.now() > deadline) throw new Error('scorer never started');
      await new Promise(resolve => setTimeout(resolve, 15));
    }
    running.child.stdin!.write('save\n');
    await running.wait(/"command":"save"/);
    assert.equal(saved(state).world.version, 0, 'save captured zero world effects');
    writeFileSync(release, 'go');
    await running.wait(/"command":"step"[\s\S]*"command":"step"/);
    const late = running.rows().filter(row => row.command === 'step');
    assert.equal(late.length, 2, 'both captured step jobs get a real terminal row');
    assert.ok(late.every(row => row.cancelled === true
      || row.decisions?.every((decision: any) => decision.executed === false)));
    // A new step outside the captured set still succeeds.
    running.child.stdin!.write('step npc_01\n');
    await running.wait(/"command":"step"[\s\S]*"executed":true/);
    running.child.stdin!.write('save\nquit\n');
    await running.wait(/"event":"exit"/);
    assert.equal(saved(state).world.version, 1, 'the later step was not revoked');
  } finally {
    if (running.child.exitCode === null) running.child.kill('SIGKILL');
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R5-G5: travel replays the first receipt; same id/different target conflicts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-g5-'));
  const state = join(dir, 's.json');
  try {
    const first = cli(state, 'travel npc_01 warehouse id=travel-one\n'
      + 'travel npc_01 warehouse id=travel-one\n'
      + 'travel npc_01 kitchen id=travel-one\nwhere npc_01\nsave\nquit\n',
    ['--fresh', '--npc', '2']);
    const travels = first.filter(row => row.command === 'travel');
    assert.equal(travels[0].status, 'applied');
    assert.equal(travels[1].status, 'applied');
    assert.equal(travels[1].duplicate, true);
    assert.equal(travels[2].status, 'rejected');
    assert.equal(travels[2].reason, 'command_id_conflict');
    assert.equal(first.find(row => row.command === 'where')!.location, 'warehouse');
    const second = cli(state, 'travel npc_01 warehouse id=travel-one\nwhere npc_01\nquit\n');
    const replay = second.find(row => row.command === 'travel')!;
    assert.equal(replay.duplicate, true);
    assert.equal(replay.tiles, travels[0].tiles);
    assert.equal(second.find(row => row.command === 'where')!.location, 'warehouse');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R5-G6: morning council creates a resolution, two real assignments and receipts', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-g6-'));
  const state = join(dir, 's.json');
  try {
    const opened = cli(state, 'council-open\ncouncil-status\nsave\nquit\n',
      ['--fresh', '--npc', '8']);
    const council = opened.find(row => row.command === 'council-open')!.council;
    assert.equal(council.proposals.length, 2);
    const [planA, planB] = council.proposals;
    assert.notDeepEqual(planA.cost, planB.cost, 'the plans have a real cost difference');
    assert.ok(planB.assignments.some((entry: any) => entry.role === 'rest'));
    const resolved = cli(state, 'council-resolve\ncouncil-status\nsave\nquit\n')
      .find(row => row.command === 'council-resolve')!;
    const resolution = resolved.resolution;
    assert.equal(typeof resolution.councilId, 'string');
    assert.equal(typeof resolution.resolutionId, 'string');
    assert.match(resolution.source, /^council:/);
    assert.ok(resolution.revision >= 1);
    assert.ok(resolution.votes.every((vote: any) => vote.source === 'fixture-reference/1'));
    assert.ok(resolved.requests.length >= 2);
    const requestIds = resolved.requests.map((request: any) => request.requestId);
    const script = requestIds.map((id: string) => `council-respond ${id} accept`);
    script.push('council-status');
    script.push(...Array(14).fill('game-step'));
    script.push('council-status', 'task-status', 'save', 'quit');
    const run = cli(state, `${script.join('\n')}\n`);
    const status = run.filter(row => row.command === 'council-status').at(-1)!.council[0];
    assert.ok(status.requests.every((request: any) => request.status === 'accepted'));
    assert.ok(status.requests.every((request: any) => request.commitmentStatus));
    assert.ok(status.requests.every((request: any) => request.taskStatus));
    const tasks = sidecar(state, '.tasks.json');
    assert.ok(tasks.some((task: any) => task.kind === 'supply-warehouse'
      && task.status === 'done'));
    assert.ok(tasks.some((task: any) => task.kind === 'deliver-meal'
      && task.status === 'done'));
    assert.ok(saved(state).world.spatial.deliveredMeals >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R5-G7: an exit stops the old task; a substitute accepts a NEW request revision', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-g7-'));
  const state = join(dir, 's.json');
  try {
    const opened = cli(state, 'council-open\ncouncil-resolve\nsave\nquit\n',
      ['--fresh', '--npc', '8']).find(row => row.command === 'council-resolve')!;
    const supply = opened.requests.find((request: any) => request.role === 'supply');
    const deliver = opened.requests.find((request: any) => request.role === 'deliver');
    const accepted = cli(state, `council-respond ${supply.requestId} accept\n`
      + `council-respond ${deliver.requestId} accept\nsave\nquit\n`);
    const supplyCommitment = accepted.find(row => row.command === 'council-respond')!
      .commitment.commitmentId;
    const before = sidecar(state, '.tasks.json');
    cli(state, `relinquish ${supplyCommitment}\ncommitment-status\nsave\nquit\n`);
    const afterExit = sidecar(state, '.tasks.json');
    const oldTask = afterExit.find((task: any) => task.commitmentId === supplyCommitment);
    assert.equal(oldTask.status, 'cancelled');
    assert.ok(before.some((task: any) => task.taskId === oldTask.taskId
      && task.status === 'active'));
    const substitute = 'npc_04';
    const reassigned = cli(state, `council-reassign ${supply.requestId} ${substitute}\n`
      + 'council-status\nsave\nquit\n');
    const replacement = reassigned.find(row => row.command === 'council-reassign')!.request;
    assert.equal(replacement.actorId, substitute);
    assert.equal(replacement.revision, 2);
    assert.match(replacement.requestId, /:r2:/);
    assert.notEqual(replacement.requestId, supply.requestId);
    const acceptedNew = cli(state, `council-respond ${replacement.requestId} accept\n`
      + 'council-status\nsave\nquit\n');
    const newCommitment = acceptedNew.find(row => row.command === 'council-respond')!
      .commitment;
    assert.equal(newCommitment.promisorId, substitute);
    assert.notEqual(newCommitment.commitmentId, supplyCommitment);
    const tasks = sidecar(state, '.tasks.json');
    assert.equal(tasks.find((task: any) => task.taskId === oldTask.taskId).status,
      'cancelled', 'the old person is not renamed into the substitute');
    assert.ok(tasks.some((task: any) => task.commitmentId === newCommitment.commitmentId
      && task.status === 'active'));
    // A late answer to the superseded request is ignored.
    const late = cli(state, `council-respond ${supply.requestId} accept\nsave\nquit\n`);
    assert.equal(late.find(row => row.command === 'council-respond')!.ignored, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R5-G8: council resolution replays across processes without duplicate dispatch', () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-g8-'));
  const state = join(dir, 's.json');
  try {
    cli(state, 'council-open\ncouncil-resolve\nsave\nquit\n', ['--fresh', '--npc', '8']);
    const first = sidecar(state, '.council.json').councils[0];
    const replay = cli(state, 'council-open\ncouncil-resolve\ncouncil-vote '
      + `${first.proposals[0].proposalId}\ncouncil-status\nsave\nquit\n`);
    const opened = replay.find(row => row.command === 'council-open')!;
    const resolved = replay.find(row => row.command === 'council-resolve')!;
    const voted = replay.find(row => row.command === 'council-vote')!;
    assert.equal(opened.duplicate, true);
    assert.equal(resolved.duplicate, true);
    assert.equal(voted.ignored, true, 'a post-resolution vote cannot rewrite the revision');
    const after = sidecar(state, '.council.json').councils[0];
    assert.equal(after.requests.length, first.requests.length);
    assert.equal(after.resolution.resolutionId, first.resolution.resolutionId);
    assert.equal(after.resolution.revision, first.resolution.revision);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface Driver {
  send: (line: string) => Promise<Row>;
  close: () => Promise<void>;
}

async function openDriver(state: string, extra: string[]): Promise<Driver> {
  const child = spawn(process.execPath, [CLI, '--state', state, ...extra],
    { cwd: process.cwd(), stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', chunk => { out += chunk; });
  const rows = () => out.trim() ? out.trim().split('\n').map(line => JSON.parse(line)) : [];
  const wait = async (predicate: () => boolean, timeoutMs = 120_000) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`driver timeout\n${out.slice(-4000)}`);
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  };
  await wait(() => rows().some(row => row.event === 'ready'));
  const send = async (line: string): Promise<Row> => {
    const before = rows().length;
    child.stdin.write(`${line}\n`);
    await wait(() => rows().length > before);
    return rows()[rows().length - 1];
  };
  const close = async () => {
    if (child.exitCode === null) {
      const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.stdin.end();
      await new Promise(resolve => child.on('close', resolve));
      clearTimeout(timer);
    }
  };
  return { send, close };
}

async function runDay(driver: Driver, day: number): Promise<Row> {
  await driver.send('council-open');
  const resolved = await driver.send('council-resolve');
  const requests = resolved.requests as Array<{ requestId: string; actorId: string }>;
  for (const request of requests) {
    await driver.send(`council-respond ${request.requestId} accept`);
  }
  const busy = new Set(requests.map(request => request.actorId));
  const roles = ['heating', 'gather-food', 'gather-food', 'gather-wood', 'gather-wood',
    'gather-food'];
  let role = 0;
  for (let index = 1; index <= 8; index += 1) {
    const id = `npc_${String(index).padStart(2, '0')}`;
    if (busy.has(id)) continue;
    await driver.send(`assign ${id} ${roles[role % roles.length]}`);
    role += 1;
  }
  for (let chunk = 0; chunk < 4; chunk += 1) {
    await driver.send('advance 360');
    await driver.send('game-step');
    await driver.send('game-step');
  }
  return driver.send('task-status');
}

function authority(state: string): Record<string, unknown> {
  const doc = saved(state);
  const tasks = sidecar(state, '.tasks.json');
  const commitments = sidecar(state, '.commitments.json');
  const council = sidecar(state, '.council.json');
  return {
    simTime: doc.world.simTime,
    resources: doc.world.resources,
    furnace: doc.world.furnace,
    npcs: Object.fromEntries(Object.entries(doc.world.npcs).map(([id, npc]: any) =>
      [id, { hunger: Math.round(npc.hunger * 100) / 100,
        stamina: Math.round(npc.stamina * 100) / 100, health: npc.health,
        location: npc.location, alive: npc.alive }])),
    spatial: doc.world.spatial
      ? { warehouseFood: doc.world.spatial.stocks.warehouse.food,
        deliveredMeals: doc.world.spatial.deliveredMeals,
        carry: doc.world.spatial.carry }
      : null,
    tasks: tasks.map((task: any) => ({ kind: task.kind, actorId: task.actorId,
      status: task.status, taskId: task.taskId })),
    commitments: commitments.commitments.map((row: any) => ({
      promisorId: row.promisorId, goal: row.goal, status: row.status,
      revision: row.revision, taskId: row.taskId })),
    councils: council.councils.map((record: any) => ({
      councilId: record.councilId, day: record.day, status: record.status,
      revision: record.revision,
      resolutionId: record.resolution?.resolutionId ?? null,
      requests: record.requests.map((request: any) => ({
        requestId: request.requestId, role: request.role,
        actorId: request.actorId, status: request.status,
        revision: request.revision })),
    })),
  };
}

test('R5-G9: 8 NPCs live the same 96h with spatial work, one success and one honest shortage, '
  + 'and split saves match the continuous run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'r5-g9-'));
  const continuous = join(dir, 'continuous.json');
  const segmented = join(dir, 'segmented.json');
  const drivers: Driver[] = [];
  try {
    // Continuous: one process lives the whole 96h.
    const continuousDriver = await openDriver(continuous,
      ['--fresh', '--npc', '8', '--food', '120']);
    drivers.push(continuousDriver);
    const travel = await continuousDriver.send('travel npc_08 warehouse');
    assert.equal(travel.status, 'applied');
    const drained = await continuousDriver.send('withdraw npc_08 4');
    assert.equal(drained.status, 'applied');
    assert.equal(drained.warehouseFood, 0);
    const shortage = await continuousDriver.send('withdraw npc_08 1');
    assert.ok((shortage.events ?? []).some((event: any) => event.type === 'out_of_stock'),
      'an empty warehouse records out_of_stock, never a silent success');
    assert.equal(shortage.warehouseFood, 0);
    assert.equal(shortage.carry, 4, 'no meal was invented');
    const statuses: Row[] = [];
    for (let day = 1; day <= 4; day += 1) {
      statuses.push(await runDay(continuousDriver, day));
    }
    const final = statuses.at(-1)!.status;
    assert.ok(final.hoursElapsed >= 96, `elapsed ${final.hoursElapsed}`);
    assert.ok(final.spatial && typeof final.spatial.deliveredMeals === 'number');
    assert.ok(final.spatial.deliveredMeals >= 1, 'at least one real meal_delivered');
    assert.ok(statuses.some(row => row.status.council.some(
      (council: any) => council.resolution?.resolutionId)), 'councils resolved each day');
    await continuousDriver.send('save');
    await continuousDriver.send('quit');
    await continuousDriver.close();

    // Segmented: save/exit at every day boundary and resume a new process.
    for (let day = 1; day <= 4; day += 1) {
      const driver = await openDriver(segmented,
        day === 1 ? ['--fresh', '--npc', '8', '--food', '120'] : []);
      drivers.push(driver);
      if (day === 1) {
        await driver.send('travel npc_08 warehouse');
        await driver.send('withdraw npc_08 4');
        await driver.send('withdraw npc_08 1');
      }
      await runDay(driver, day);
      await driver.send('save');
      await driver.send('quit');
      await driver.close();
    }
    const left = authority(continuous);
    const right = authority(segmented);
    assert.equal(right.simTime, left.simTime);
    assert.deepEqual(right.resources, left.resources);
    assert.deepEqual(right.npcs, left.npcs);
    assert.deepEqual(right.spatial, left.spatial);
    assert.deepEqual(right.tasks, left.tasks);
    assert.deepEqual(right.commitments, left.commitments);
    assert.deepEqual(right.councils, left.councils);
  } finally {
    for (const driver of drivers) await driver.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
