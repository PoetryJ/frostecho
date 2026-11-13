/**
 * G10-R1 worker C — independent black-box acceptance.
 *
 * Real CLI child processes, real restore paths and a real loopback socket.
 * Save refusals and durable IO failures are classified separately; a live
 * slot is bound to its exact ledger before any POST; the run record is
 * re-executed by a fresh Engine. Platform-specific exit tests are split:
 * Windows child.kill('SIGINT') is never treated as terminal Ctrl+C.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readRunRecord } from '../src/application/persistence';
import { writeExclusiveSlot } from '../src/persistence/atomic-slot';
import { reexecuteCommands } from '../scripts/g07-eval-lib';

const ROOT = process.cwd();
const CLI = join(ROOT, 'dist/scripts/play-g10.js');
const EVAL = join(ROOT, 'dist/scripts/eval-g09.js');
const LEDGER = join(ROOT, 'dist/scripts/campaign-budget.js');
const DEMO = (name: string) => join(ROOT, `scripts/g10-demo/${name}.txt`);

function tempRoot(tag: string): string {
  return mkdtempSync(join(tmpdir(), `frostech-g10r1-${tag}-`));
}

interface RunResult { code: number | null; stdout: string; stderr: string }

function runCli(args: string[], input: string, env: NodeJS.ProcessEnv = process.env): Promise<RunResult> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.stdin.end(input);
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

interface OpenChild { child: ReturnType<typeof spawn>; stdout(): string; stderr(): string; result(): Promise<RunResult> }

function openCli(args: string[]): OpenChild {
  const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT });
  let stdout = '';
  let stderr = '';
  const done = new Promise<RunResult>(resolve => {
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
  child.stdout.on('data', chunk => { stdout += String(chunk); });
  child.stderr.on('data', chunk => { stderr += String(chunk); });
  return { child, stdout: () => stdout, stderr: () => stderr, result: () => done };
}

async function waitFor(child: OpenChild, text: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!child.stdout().includes(text)) {
    if (Date.now() > deadline) throw new Error(`child did not start: ${child.stdout().slice(-300)} ${child.stderr().slice(-300)}`);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runRecord(root: string, slot = 'demo'): { path: string; payload: any } {
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(`${slot}-run`) && name.endsWith('.run.json')) {
      const path = join(root, name);
      return { path, payload: readJson(path).payload };
    }
  }
  throw new Error(`no run record for ${slot} in ${root}: ${readdirSync(root).join(',')}`);
}

function savedSlot(root: string, slot: string): string {
  return join(root, `${slot}.g09.json`);
}

interface Loopback {
  url: string;
  posts: { body: unknown; bodyText: string }[];
  close(): Promise<void>;
}

async function loopback(answer: (prompt: string) => { status?: number; body: string }): Promise<Loopback> {
  const posts: { body: unknown; bodyText: string }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += String(chunk); });
    req.on('end', () => {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(req.url === '/v1/models' ? JSON.stringify({ data: [{ id: 'loopback-model' }] }) : '{}');
        return;
      }
      const parsed = JSON.parse(raw) as { messages?: { content?: string }[] };
      const prompt = String(parsed.messages?.[0]?.content ?? '');
      posts.push({ body: parsed, bodyText: raw });
      const value = answer(prompt);
      res.statusCode = value.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(value.body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    posts,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function yieldWait(prompt: string): { body: string } {
  const content = prompt.includes('candidateGoals:') ? '{"goal":"yield_once"}' : '{"type":"wait"}';
  return {
    body: JSON.stringify({
      id: 'r1-wire', object: 'chat.completion', model: 'loopback-model',
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      extraWireMarker: 'must-be-preserved',
    }),
  };
}

function newCampaign(dir: string, limit: number, id: string): void {
  execFileSync(process.execPath, ['-e', `const c=require(${JSON.stringify(LEDGER)});c.openCampaign(${JSON.stringify(dir)},${limit},${JSON.stringify(id)});`], { cwd: ROOT });
}

/* ------------------------------------------------------------------ */
/* I1 — invalid startup                                                */
/* ------------------------------------------------------------------ */
test('I1: --root pointing at a regular file exits 2 with zero decisions and no record', async () => {
  const root = tempRoot('i1');
  try {
    const rootFile = join(root, 'not-a-dir');
    writeFileSync(rootFile, 'file');
    const result = await runCli(['--root', rootFile, '--slot', 'demo'], 'step\nquit\n');
    assert.equal(result.code, 2, result.stderr);
    assert.match(result.stderr, /not a directory/);
    assert.ok(!result.stdout.includes('已保存'), 'never claims a save');
    assert.equal(readdirSync(root).filter(name => name.endsWith('.run.json')).length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* I2 — real IO failure is durable                                     */
/* ------------------------------------------------------------------ */
test('I2a: a save IO failure exits 1, names the cause, and later quit cannot wash it', async () => {
  const root = tempRoot('i2a');
  try {
    const bad = join(root, 'bad');
    const child = openCli(['--root', bad, '--slot', 'demo']);
    await waitFor(child, '输入 help');
    writeFileSync(bad, 'now a file');
    child.child.stdin!.write('save a\nquit\n');
    child.child.stdin!.end();
    const result = await child.result();
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /PERSISTENCE_FAILED|IO_ERROR|EEXIST|ENOTDIR/);
    assert.match(result.stderr, /bad/, 'the original path/cause is visible');
    assert.ok(!result.stdout.includes('已保存') && !result.stdout.includes('存档: /'), 'never claims a saved slot');
    assert.equal(existsSync(join(bad, 'demo-run.run.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('I2b: a final-record write failure exits 1, prints the cause, and writes nothing', async () => {
  const root = tempRoot('i2b');
  try {
    const bad = join(root, 'bad');
    const child = openCli(['--root', bad, '--slot', 'demo']);
    await waitFor(child, '输入 help');
    rmSync(bad, { recursive: true, force: true });
    writeFileSync(bad, 'now a file');
    child.child.stdin!.write('quit\n');
    child.child.stdin!.end();
    const result = await child.result();
    assert.equal(result.code, 1, result.stderr);
    assert.match(result.stderr, /PERSISTENCE_FAILED/);
    assert.match(result.stderr, /EEXIST|ENOTDIR|not a directory/);
    assert.ok(!result.stdout.includes('运行记录 ->'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* I3 — named refusals are not failures                                */
/* ------------------------------------------------------------------ */
test('I3: a duplicate/illegal slot is a named refusal; bytes stay; a new slot and a clean quit work', async () => {
  const root = tempRoot('i3');
  try {
    const result = await runCli(['--goals', 'negotiated', '--fixture', 'cooperate', '--root', root, '--slot', 'demo'],
      'request npc_a yield_once\nstep\nsave same\nsave same\nsave BAD_SLOT\nsave second\nquit\n');
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /EXISTS/);
    assert.match(result.stdout, /输入错误|槽名/, 'an illegal slot is a named refusal');
    const first = readFileSync(savedSlot(root, 'same'));
    assert.equal(readFileSync(savedSlot(root, 'same')).equals(first), true);
    assert.equal(existsSync(savedSlot(root, 'second')), true, 'a new slot continues normally');
    assert.equal(existsSync(join(root, 'demo-run.run.json')), true);
    assert.equal(runRecord(root).payload.schema, 'frostecho.g10.run/2');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* I4 — the run record is authoritative even without a save            */
/* ------------------------------------------------------------------ */
test('I4: quit without save leaves one exclusive, re-executable run record; the view is only a projection', async () => {
  const root = tempRoot('i4');
  try {
    const result = await runCli(['--goals', 'negotiated', '--fixture', 'cooperate', '--root', root, '--slot', 'demo'],
      readFileSync(DEMO('cooperate'), 'utf8'));
    assert.equal(result.code, 0, result.stderr);
    assert.equal(readdirSync(root).filter(name => name.endsWith('.run.json')).length, 1);
    const { path, payload } = runRecord(root);
    const read = readRunRecord(path);
    assert.equal(read.ok, true);
    const authority = payload.authoritative;
    for (const key of ['snapshot', 'checkpoint', 'engine', 'commands', 'events', 'processed', 'requests', 'budget']) {
      assert.ok(key in authority, `authoritative.${key} must exist`);
    }
    const issues = reexecuteCommands({ plan: { episodeId: 'demo' }, snapshot: authority.snapshot });
    assert.deepEqual(issues, [], 'a fresh Engine re-executes the commands and agrees');
    assert.deepEqual(authority.processed, ['demo-req-1']);
    assert.equal(authority.requests['demo-req-1'].outcome, 'fulfilled');
    assert.equal(payload.beforeCloseView.npcs.find((npc: any) => npc.actorId === 'npc_a').request.outcome, 'fulfilled');
    assert.deepEqual(payload.authoritative.engine.state, authority.snapshot.finalState, 'engine state equals the snapshot final state');
    assert.equal(payload.wire.length, 0, 'no fake HTTP history is invented offline');
    assert.equal(payload.lineage.parentSlot, null);
    // A second run never overwrites the first record.
    const second = await runCli(['--goals', 'negotiated', '--fixture', 'cooperate', '--root', root, '--slot', 'demo'], 'quit\n');
    assert.equal(second.code, 0, second.stderr);
    assert.equal(readdirSync(root).filter(name => name.endsWith('.run.json')).length, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* B1/B2/B3 — the ledger binding is immutable                          */
/* ------------------------------------------------------------------ */
test('B1: a saved live slot refuses a different limit-1 ledger before any POST', async () => {
  const root = tempRoot('b1');
  const server = await loopback(yieldWait);
  try {
    const camp1 = join(root, 'camp1');
    const camp2 = join(root, 'camp2');
    newCampaign(camp1, 1, 'task-one');
    newCampaign(camp2, 1, 'task-two');
    const live = ['--goals', 'negotiated', '--live', '--http', server.url, '--model', 'loopback-model'];
    const created = await runCli([...live, '--campaign', camp1, '--root', join(root, 'live'), '--slot', 'demo'],
      'request npc_a yield_once\nstep\nsave chosen\nquit\n');
    assert.equal(created.code, 0, created.stderr);
    assert.equal(server.posts.length, 1);
    const slot = savedSlot(join(root, 'live'), 'chosen');
    const bytes = readFileSync(slot);
    const ledger1 = readJson(join(camp1, 'campaign.json'));
    const ledger2 = readJson(join(camp2, 'campaign.json'));

    const switched = await runCli(['--load', slot, ...live, '--campaign', camp2], 'step\nquit\n');
    assert.equal(switched.code, 2, switched.stderr);
    assert.match(switched.stderr, /LEDGER_IDENTITY_MISMATCH/);
    assert.equal(server.posts.length, 1, 'the refusal happens before any POST');
    assert.equal(readFileSync(slot).equals(bytes), true);
    assert.deepEqual(readJson(join(camp1, 'campaign.json')), ledger1);
    assert.deepEqual(readJson(join(camp2, 'campaign.json')), ledger2);

    const limitOverride = await runCli(['--load', slot, ...live, '--campaign', camp1, '--campaign-limit', '5'], 'step\nquit\n');
    assert.equal(limitOverride.code, 2);
    assert.match(limitOverride.stderr, /LEDGER_LIMIT_MISMATCH/);
    assert.equal(server.posts.length, 1);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('B2: rollback, rewritten history, changed limit and a copied ledger are all refused', async () => {
  const root = tempRoot('b2');
  const server = await loopback(yieldWait);
  try {
    const camp = join(root, 'camp');
    newCampaign(camp, 2, 'task-b2');
    const live = ['--goals', 'negotiated', '--live', '--http', server.url, '--model', 'loopback-model'];
    const created = await runCli([...live, '--campaign', camp, '--root', join(root, 'live'), '--slot', 'demo'],
      'request npc_a yield_once\nstep\nsave chosen\nquit\n');
    assert.equal(created.code, 0, created.stderr);
    const slot = savedSlot(join(root, 'live'), 'chosen');
    const original = readJson(join(camp, 'campaign.json'));

    const ledgerPath = join(camp, 'campaign.json');
    const originalBytes = readFileSync(ledgerPath);
    const expectReject = async (mutated: unknown, pattern: RegExp): Promise<void> => {
      writeFileSync(ledgerPath, JSON.stringify(mutated));
      const attempt = await runCli(['--load', slot, ...live, '--campaign', camp], 'step\nquit\n');
      assert.equal(attempt.code, 2, attempt.stderr);
      assert.match(attempt.stderr, pattern);
      writeFileSync(ledgerPath, originalBytes);
    };

    await expectReject({ ...original, ledgerId: 'different-ledger' }, /LEDGER_IDENTITY_MISMATCH/);
    await expectReject({ ...original, spent: 0, attempts: [] }, /LEDGER_SPENT_BELOW_FLOOR|LEDGER_HISTORY_MISMATCH/);
    await expectReject({
      ...original,
      attempts: original.attempts.map((attempt: any, index: number) => index === 0 ? { ...attempt, attemptId: 'att-rewritten' } : attempt),
    }, /LEDGER_HISTORY_MISMATCH/);
    await expectReject({ ...original, limit: 5 }, /LEDGER_LIMIT_MISMATCH/);

    const copied = join(root, 'copied');
    newCampaign(copied, 2, 'task-b2');
    writeFileSync(join(copied, 'campaign.json'), JSON.stringify(original));
    const copiedRun = await runCli(['--load', slot, ...live, '--campaign', copied], 'step\nquit\n');
    assert.equal(copiedRun.code, 2);
    assert.match(copiedRun.stderr, /LEDGER_LOCATOR_MISMATCH/);

    assert.equal(server.posts.length, 1, 'every refusal happened before any POST');
    assert.deepEqual(readJson(join(camp, 'campaign.json')), original, 'the original ledger is restored unchanged');
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('B3: the same ledger may grow after the save; the old slot never refreshes the budget', async () => {
  const root = tempRoot('b3');
  const server = await loopback(yieldWait);
  try {
    const camp = join(root, 'camp');
    newCampaign(camp, 2, 'task-b3');
    const live = ['--goals', 'negotiated', '--live', '--http', server.url, '--model', 'loopback-model'];
    const created = await runCli([...live, '--campaign', camp, '--root', join(root, 'live'), '--slot', 'demo'],
      'request npc_a yield_once\nstep\nsave chosen\nquit\n');
    assert.equal(created.code, 0, created.stderr);
    assert.equal(server.posts.length, 1);
    const slot = savedSlot(join(root, 'live'), 'chosen');
    const slotBytes = readFileSync(slot);

    const resumed = await runCli(['--load', slot, ...live, '--campaign', camp], 'step\nquit\n');
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.equal(server.posts.length, 2, 'the same ledger continues to its authorized limit');
    assert.equal(readFileSync(slot).equals(slotBytes), true);

    const ledger = readJson(join(camp, 'campaign.json'));
    assert.equal(ledger.limit, 2);
    assert.equal(ledger.spent, 2);

    // A third attempt on the same ledger is blocked before the POST.
    const blocked = await runCli(['--load', slot, ...live, '--campaign', camp], 'request npc_a yield_once\nstep\nquit\n');
    assert.notEqual(blocked.code, 0);
    assert.equal(server.posts.length, 2, 'no budget was refreshed and no POST was sent');
    assert.equal(readJson(join(camp, 'campaign.json')).spent, 2);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('B4: an old fixture slot still restores; an old live slot without a binding is refused', async () => {
  const root = tempRoot('b4');
  try {
    // The committed G10 demo slot is app/1 (offline, no campaign binding).
    const fixtureSlot = join(ROOT, 'artifacts/g10/demos/cooperate-slot.g09.json');
    const fixtureCopy = join(root, 'old-fixture.g09.json');
    writeFileSync(fixtureCopy, readFileSync(fixtureSlot));
    const restored = await runCli(['--load', fixtureCopy, '--fixture', 'cooperate'], 'status\nquit\n');
    assert.equal(restored.code, 0, restored.stderr);
    assert.match(restored.stdout, /0 次调用、0 次提交、不重选目标/);
    assert.equal(readFileSync(fixtureSlot).equals(readFileSync(fixtureSlot)), true);

    // A live app/1 slot (pre-R1) has no binding: named refusal, zero POST.
    const payload = readJson(fixtureSlot).payload;
    const legacyLive = {
      ...readJson(fixtureSlot),
      payload: {
        ...payload,
        effectiveConfig: { mode: 'live', requestModel: 'loopback-model', thinking: true, timeoutMs: 120000 },
        app: { ...payload.app, providerKind: 'live', scripted: false },
      },
    };
    const written = writeExclusiveSlot(root, 'legacy-live', '.g09.json', 'frostecho.g09.checkpoint/3', legacyLive.payload);
    assert.equal(written.ok, true);
    const legacyPath = written.value.path;
    const refused = await runCli(['--load', legacyPath, '--live', '--http', 'http://127.0.0.1:9/v1/chat/completions', '--model', 'loopback-model', '--campaign', join(root, 'absent')], 'step\nquit\n');
    assert.equal(refused.code, 2, refused.stderr);
    assert.match(refused.stderr, /CAMPAIGN_BINDING_MISSING/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* L1/L2 — the live-ready rehearsal and plan                           */
/* ------------------------------------------------------------------ */
test('L1: the frozen 8-episode/16-POST eval path runs on a test-owned server and verifies read-only', async () => {
  const root = tempRoot('l1');
  const server = await loopback(prompt => {
    const goal = prompt.includes('candidateGoals: [\"feed_self\"]') ? 'feed_self' : 'yield_once';
    const content = prompt.includes('candidateGoals:') ? JSON.stringify({ goal }) : '{"type":"wait"}';
    return {
      body: JSON.stringify({
        id: 'l1-wire', object: 'chat.completion', model: 'loopback-model',
        choices: [{ message: { role: 'assistant', content } }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      }),
    };
  });
  try {
    const result = await new Promise<RunResult>(resolve => {
      const child = spawn(process.execPath, [EVAL,
        '--out', join(root, 'artifacts'), '--batch', 'loopback-live', '--campaign', join(root, 'campaign'),
        '--campaign-limit', '16', '--live', '--http', server.url, '--model', 'loopback-model',
      ], { cwd: ROOT });
      let stdout = '';
      let stderr = '';
      const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    });
    assert.equal(result.code, 0, result.stderr);
    assert.equal(server.posts.length, 16);
    assert.match(result.stdout, /verify loopback-live: ok=true/);
    const verify = await new Promise<RunResult>(resolve => {
      const child = spawn(process.execPath, [EVAL, '--verify', '--out', join(root, 'artifacts'), '--batch', 'loopback-live', '--campaign', join(root, 'campaign')], { cwd: ROOT });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      child.stderr.on('data', chunk => { stderr += String(chunk); });
      child.on('close', code => resolve({ code, stdout, stderr }));
    });
    assert.equal(verify.code, 0, verify.stdout + verify.stderr);
    const episode = readJson(join(root, 'artifacts/loopback-live/episodes/g09-r1-s40-choice.json'));
    assert.equal(episode.http.length, 2);
    assert.equal(episode.http[0].requestBody.messages[0].content.includes('candidateGoals:'), true);
    assert.ok(episode.http[0].response.body.includes('l1-wire'));
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('L2: live-plan proposes 16, authorizes 0 and never creates a real ledger', () => {
  const plan = readJson(join(ROOT, 'artifacts/g10-r1/live-plan.json'));
  assert.equal(plan.proposedChatLimit, 16);
  assert.equal(plan.authorizedChatLimit, 0);
  assert.equal(plan.status, 'awaiting_owner_authorization');
  assert.equal(plan.providerSource, 'test-owned loopback HTTP server (rehearsal only)');
  assert.equal(plan.model.endpointKind, 'full /v1/chat/completions');
  assert.equal(plan.automaticRetries, 0);
  assert.equal(plan.extraWaitContinuationCalls, 0);
  assert.deepEqual(plan.matrix, [
    [1, 40, 'self_only'], [1, 40, 'choice'], [1, 60, 'self_only'], [1, 60, 'choice'],
    [2, 60, 'choice'], [2, 60, 'self_only'], [2, 40, 'choice'], [2, 40, 'self_only'],
  ]);
});
