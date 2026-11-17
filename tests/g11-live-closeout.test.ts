/**
 * G11-live — independent black-box locks for the real-entry closeout.
 *
 * Everything here is OFFLINE: a self-built OpenAI-compatible server answers
 * with fixed text, the campaign ledger lives in a temp dir, and the REAL CLI
 * (dist/scripts/g11-live.js, dist/scripts/play-g10.js) drives the real
 * application path. No 18872, no real quota. These tests re-assert the shipped
 * behaviours through the shipped entry points:
 *
 *   1. a failed promise settles with zero calls and never continues (the
 *      lifecycle-review counterexample, game level)
 *   2. quitting with an open promise leaves `cancelled` evidence in the
 *      closing record while the SAVED SLOT keeps the promise open (CLI level)
 *   3. a funded campaign completes W1+W2 exactly (8 posts, restore free)
 *   4. an exhausted campaign blocks the restored continuation BEFORE any
 *      provider attempt (limit 2: goal+wait only, then a dead `run 1`)
 *   5. feed_self answers classify not_triggered and stop the batch
 *   6. an HTTP 500 on the first post stops with evidence and no re-run
 *   7. same-name batches are refused with zero posts
 *   8. verify detects ledger tampering, parentSlot forgery and slot rewrites
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createNeedsGame, buildNeedsWorld, type NeedsGame } from '../src/needs/game';
import { slotChecksum } from '../src/persistence/atomic-slot';
import { createGoalRequest } from '../src/negotiation/requests';
import { G09_REQUEST_TEXT } from '../src/negotiation/contracts';
import type { DecideInput } from '../src/agent/contracts';
import { createG10Runtime, type G10Runtime } from '../src/application/adapters';
import { createApplicationController } from '../src/application/session';
import { renderStatus } from '../src/application/presenter';
import type { ApplicationController, AppCommand } from '../src/application/contracts';

const DRIVER = join(process.cwd(), 'dist/scripts/g11-live.js');
const PLAY = join(process.cwd(), 'dist/scripts/play-g10.js');
/** Shared by the funded test and the tamper test (tests run in file order). */
type AnyJson = Record<string, any>;

let fundedBatch: string | null = null;
let fundedCampaign: string | null = null;

interface FakeServer {
  url: string;
  posts: { body: string; answer: string }[];
  close(): Promise<void>;
}

/** OpenAI-compatible offline server; `script` overrides the answers by call order. */
async function fakeOpenAi(script: string | null, failMode: 'none' | 'http500' = 'none'): Promise<FakeServer> {
  const posts: { body: string; answer: string }[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: 'qwen3.8-27b' }] }));
        return;
      }
      const index = posts.length;
      const scripted = script !== null ? (script.split(',')[index] ?? script.split(',').at(-1)!) : undefined;
      const answer = scripted !== undefined
        ? scripted
        : body.includes('feed_self')
          ? '{"goal":"yield_once"}'
          : body.includes('yield_once')
            ? '{"type":"wait"}'
            : '{"type":"eat"}';
      posts.push({ body, answer });
      if (failMode === 'http500') {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'injected failure' } }));
        return;
      }
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: `chatcmpl-test-${index + 1}`, object: 'chat.completion', created: 1,
        model: 'qwen3.8-27b',
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  return {
    url: `http://127.0.0.1:${String(address.port)}/v1/chat/completions`,
    posts,
    close: () => new Promise((resolve, reject) => server.close(error => (error === undefined ? resolve() : reject(error)))),
  };
}

interface CliRun { code: number; stdout: string; stderr: string }

function cli(entry: string, args: string[], stdin: string | null = null): Promise<CliRun> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [entry, ...args], { cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    if (stdin !== null) child.stdin.write(stdin);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => resolve({ code: code ?? -1, stdout, stderr }));
  });
}

interface SceneFile {
  overall: string;
  prefix: { classification: string; reasons: string[]; posts: number; slotPath: string | null; slotSha256: string | null } | null;
  suffix: { classification: string; reasons: string[]; posts: number; slotSha256: string | null } | null;
}

function readScene(batch: string, scene: 'W1' | 'W2'): SceneFile | null {
  const path = join(batch, `scene-${scene}.json`);
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) as SceneFile : null;
}

const readJson = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;

async function runBatch(server: FakeServer, options: { limit: number; script?: string; fail?: 'http500' }): Promise<{
  batch: string; campaign: string; run: CliRun; ledger: { limit: number; spent: number };
}> {
  const base = mkdtempSync(join(tmpdir(), 'fe-g11-live-'));
  const batch = join(base, 'batch');
  const campaign = join(base, 'campaign');
  await cli(DRIVER, ['prepare', '--batch', batch, '--campaign', campaign, '--http', server.url, '--model', 'qwen3.8-27b', '--limit', String(options.limit)]);
  const run = await cli(DRIVER, ['run', '--batch', batch, '--campaign', campaign, '--http', server.url, '--model', 'qwen3.8-27b']);
  const ledger = readJson(join(campaign, 'campaign.json'));
  return { batch, campaign, run, ledger: { limit: ledger.limit as number, spent: ledger.spent as number } };
}

/* ------------------------------------------------------------------ */
/* 1-2: game-level and CLI-level terminal locks (no HTTP)              */
/* ------------------------------------------------------------------ */

test('a failed promise settles with zero calls and never continues (lifecycle counterexample)', async () => {
  const calls: string[] = [];
  const game: NeedsGame = createNeedsGame({
    episodeId: 'failed-e2e',
    initialState: buildNeedsWorld({ kitchenFood: 1, hunger: { npc_a: 40, npc_b: 40, npc_c: 70 } }),
    actorIds: ['npc_a'],
    providerFor: () => ({
      async decide(input: DecideInput) {
        calls.push(input.goalChoice !== undefined ? 'goal' : input.activeGoal?.kind === 'yield_once' ? 'wait' : 'action');
        return input.goalChoice !== undefined ? '{"goal":"yield_once"}' : (input.activeGoal?.kind === 'yield_once' ? '{"type":"wait"}' : '{"type":"eat"}');
      },
    }),
    mode: 'reference', thinking: true, needPolicy: 'recurring', timeoutMs: 120_000, actionSet: 'timed_wait',
    goalMode: 'negotiated', candidateSet: 'choice', playerId: 'npc_b',
  });
  const built = createGoalRequest({
    requestId: 'r-failed', episodeId: 'failed-e2e', to: 'npc_a', text: G09_REQUEST_TEXT,
    options: ['feed_self', 'yield_once'], createdAtSimTime: 0, arm: 'choice',
  });
  assert.equal(built.ok, true);
  assert.equal(game.submitGoalRequest(built.value).ok, true);
  await game.advance(); // goal choice
  await game.advance(); // action -> timed wait
  assert.equal(calls.join(','), 'goal,wait');
  // The player leaves the kitchen: feeding the NPC is now IMPOSSIBLE.
  assert.equal(game.playerLine('player move dorm').ok, true);
  assert.equal(game.playerLine('player eat').ok, false, 'the player cannot eat from the dorm');
  game.worldAdvanceTime(1);
  assert.equal(game.goalRequests().requests['r-failed']!.outcome, 'failed', 'the impossibility settles as failed');
  // The deadline settle spends ZERO calls and never continues a failed promise.
  const outcome = await game.advance();
  assert.equal(outcome.kind, 'idle');
  assert.equal(calls.length, 2, 'a failed promise never re-asks nor continues');
  assert.equal(game.goalRequests().requests['r-failed']!.outcome, 'failed', 'failed is monotonic');
  assert.equal(game.actorStateOf('npc_a'), 'stopped');
  assert.equal(game.cyclesOf('npc_a'), 1, 'a failed promise opens NO continuation cycle (the negotiated goal+wait is ONE cycle)');
});

test('quitting with an open promise leaves cancelled evidence; the slot keeps the promise open', async () => {
  const base = mkdtempSync(join(tmpdir(), 'fe-g11-quit-'));
  const root = join(base, 'root');
  const stdin = 'request npc_a yield_once\nrun 1\nrun 1\nsave cxwait\nquit\n';
  const played = await cli(PLAY, ['--fixture', 'w1', '--goals', 'negotiated', '--satiety', '40', '--root', root, '--slot', 'cxwait'], stdin);
  assert.equal(played.code, 0, `play-g10 exited ${String(played.code)}: ${played.stderr.slice(-300)}`);
  const records = readdirSync(root).filter(name => name.endsWith('.run.json')).sort();
  assert.equal(records.length, 1, `expected exactly one run record, got ${records.join(',')}`);
  const record = readJson(join(root, records[0]!)) as { payload: { authoritative: { requests: Record<string, { status: string; outcome: string; outcomeReason: string }>; snapshot: { actors: Record<string, { cycles: number; providerCalls: number }> }; budget: { providerCalls: number } } } };
  const requests = Object.values(record.payload.authoritative.requests);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.status, 'cancelled');
  assert.equal(requests[0]!.outcome, 'cancelled');
  assert.match(requests[0]!.outcomeReason, /closed/i);
  // The cancelled settle itself spends ZERO provider calls and opens no new
  // cycle: goal choice + timed wait are still the only 2 calls / 2 cycles.
  assert.equal(record.payload.authoritative.budget.providerCalls, 2, 'the cancelled settle never re-asks the old goal');
  assert.equal(record.payload.authoritative.snapshot.actors['npc_a']!.cycles, 1, 'the cancelled settle opens no continuation cycle (the negotiated goal+wait is ONE cycle)');
  assert.equal(record.payload.authoritative.snapshot.actors['npc_a']!.providerCalls, 2);
  // The SAVED slot (written BEFORE quit) still holds the open promise: the
  // restored game must see accepted/pending, never the closing cancellation.
  const slot = readJson(join(root, 'cxwait.g09.json')) as { payload: { binding: { goal: string }; game: { requestStore: { requests: Record<string, { status: string; outcome: string; expiresAtSimTime: number }> } } } };
  assert.equal(slot.payload.binding.goal, 'yield_once');
  const saved = Object.values(slot.payload.game.requestStore.requests);
  assert.equal(saved.length, 1);
  assert.equal(saved[0]!.status, 'accepted');
  assert.equal(saved[0]!.outcome, 'pending');
  assert.equal(saved[0]!.expiresAtSimTime, 1);
});

test('the view reports the CURRENT session goal only: terminal requests keep their own line, the settle never re-asks, feed_self shows its own decision', async () => {
  const build = (fixture: 'w1' | 'w2' | 'decline', slot: string): ApplicationController => {
    const base = mkdtempSync(join(tmpdir(), 'fe-g11-view-'));
    const built = createG10Runtime({
      root: join(base, fixture), slot, goals: 'negotiated', candidates: 'choice', satiety: 40,
      fixture, live: false, http: '', model: null, campaign: null, campaignLimit: null,
    });
    assert.equal(built.ok, true);
    const runtime: G10Runtime = built.value;
    return createApplicationController({
      game: runtime.game, config: runtime.config, root: runtime.root, slot: runtime.slot,
      meta: runtime.meta, ports: runtime.ports,
    });
  };
  const npcA = (view: ReturnType<ApplicationController['view']>): ReturnType<ApplicationController['view']>['npcs'][number] =>
    view.npcs.find(npc => npc.actorId === 'npc_a')!;

  // FAILED lifecycle: the player leaves, so the promise can never be kept.
  {
    const controller = build('w1', 'view-failed');
    await controller.execute({ kind: 'request', actorId: 'npc_a', goal: 'yield_once' });
    await controller.execute({ kind: 'run', steps: 1 }); // goal choice -> yield_once binding
    await controller.execute({ kind: 'run', steps: 1 }); // action -> timed wait
    await controller.execute({ kind: 'player_move', to: 'dorm' });
    await controller.execute({ kind: 'player_eat' }); // refused (no food in the dorm): impossibility
    await controller.execute({ kind: 'world_time', steps: 1 });
    assert.equal(npcA(controller.view()).request!.outcome, 'failed');
    assert.equal(npcA(controller.view()).selectedGoal, 'yield_once');
    assert.equal(npcA(controller.view()).selectedGoalBasis, 'session_binding');
    // The failed settle is zero-call: more advances never re-ask the old goal.
    await controller.execute({ kind: 'run', steps: 1 });
    await controller.execute({ kind: 'run', steps: 1 });
    assert.equal(npcA(controller.view()).providerCalls, 2, 'the failed settle never re-asks');
    const lines = renderStatus(controller.view());
    assert.ok(lines.some(line => line.includes('请求失败：')), `display lines:\n${lines.join('\n')}`);
    assert.ok(lines.some(line => line.includes('（本session选定）')));
  }
  // EXPIRED lifecycle: nobody eats before the deadline.
  {
    const controller = build('w2', 'view-expired');
    await controller.execute({ kind: 'request', actorId: 'npc_a', goal: 'yield_once' });
    await controller.execute({ kind: 'run', steps: 1 });
    await controller.execute({ kind: 'run', steps: 1 });
    await controller.execute({ kind: 'world_time', steps: 1 });
    assert.equal(npcA(controller.view()).request!.outcome, 'expired');
    assert.equal(npcA(controller.view()).selectedGoalBasis, 'session_binding', 'the ended session still owns its own choice');
    await controller.execute({ kind: 'run', steps: 1 }); // zero-call continuation open (fixture mode)
    assert.equal(npcA(controller.view()).providerCalls, 2, 'the expired settle is zero-call');
    const lines = renderStatus(controller.view());
    assert.ok(lines.some(line => line.includes('请求已到期，未履约')), `display lines:\n${lines.join('\n')}`);
  }
  // feed_self decline: the session's OWN binding-less decision still shows.
  {
    const controller = build('decline', 'view-decline');
    await controller.execute({ kind: 'request', actorId: 'npc_a', goal: 'yield_once' });
    await controller.execute({ kind: 'run', steps: 1 }); // declines: feed_self
    await controller.execute({ kind: 'run', steps: 1 }); // action: eat
    const view = controller.view();
    assert.equal(npcA(view).selectedGoal, 'feed_self');
    assert.equal(npcA(view).selectedGoalBasis, 'session_binding', 'the session decided feed_self itself');
    assert.equal(npcA(view).request!.status, 'declined');
    const lines = renderStatus(view);
    assert.ok(lines.some(line => line.includes('选定目标=feed_self') && line.includes('（按饱食判定）')), `display lines:\n${lines.join('\n')}`);
    assert.ok(lines.some(line => line.includes('拒绝合作（feed_self）')));
  }
});

/* ------------------------------------------------------------------ */
/* 3-6: real-driver black box against the offline OpenAI server        */
/* ------------------------------------------------------------------ */

test('a funded campaign completes W1 and W2 exactly: 8 posts, restore free, verify clean', async () => {
  const server = await fakeOpenAi(null);
  try {
    const { batch, campaign, run, ledger } = await runBatch(server, { limit: 8 });
    fundedBatch = batch;
    fundedCampaign = campaign;
    assert.equal(run.code, 0, `run exited ${String(run.code)}: ${run.stderr.slice(-300)}`);
    assert.equal(server.posts.length, 8, `exactly the authorized 8 posts, got ${String(server.posts.length)}`);
    assert.equal(ledger.limit, 8);
    assert.equal(ledger.spent, 8, 'every post is charged once');
    for (const [scene, suffix] of [['W1', 'fulfilled'], ['W2', 'expired']] as const) {
      const file = readScene(batch, scene);
      assert.notEqual(file, null, `${scene} scene file exists`);
      assert.equal(file!.overall, 'success');
      assert.equal(file!.prefix!.classification, 'goal_triggered');
      assert.equal(file!.suffix!.classification, suffix);
      assert.equal(file!.prefix!.posts, 2, `${scene} prefix = goal + wait`);
      assert.equal(file!.suffix!.posts, 2, `${scene} suffix = the two resumed eats`);
      assert.equal(file!.prefix!.slotSha256, file!.suffix!.slotSha256, `${scene}: the suffix restored the SAME pre-close slot`);
    }
    // The restore itself is free and the waits are free: only 4 posts per scene.
    const w1Wire = server.posts.slice(0, 4).map(post => post.answer);
    assert.deepEqual(w1Wire, ['{"goal":"yield_once"}', '{"type":"wait"}', '{"type":"eat"}', '{"type":"eat"}'], 'W1 wire: goal, wait, eat, eat');
    // verify is read-only: it writes nothing into the batch. --out stores the
    // handoff copy outside the evidence roots, which is what makes "verify
    // changes no byte" checkable (see the hash-invariance test).
    const verifyOut = join(batch, '..', 'verify-out', 'verify.json');
    const verified = await cli(DRIVER, ['verify', '--batch', batch, '--campaign', campaign, '--out', verifyOut]);
    assert.equal(verified.code, 0, `verify found problems: ${verified.stdout.slice(-400)}`);
    assert.equal(existsSync(join(batch, 'verify.json')), false, 'verify must not write batch/verify.json');
    const report = readJson(verifyOut) as {
      issues: string[];
      evidenceOk: boolean;
      complete: boolean;
      ok: boolean;
      costs: { spent: number; attempts: number; totalTokens: number | null; unknownUsage: string[] };
      posts: { total: number; perScene: Record<string, number> };
    };
    assert.deepEqual(report.issues, []);
    assert.equal(report.evidenceOk, true);
    assert.equal(report.complete, true);
    assert.equal(report.ok, true);
    assert.equal(report.costs.spent, 8);
    assert.equal(report.costs.attempts, 8);
    assert.equal(report.costs.totalTokens, 960, '8 x 120 tokens aggregated once by unique attemptId');
    assert.deepEqual(report.costs.unknownUsage, []);
    assert.equal(report.posts.total, 8);
    assert.deepEqual(report.posts.perScene, { W1: 4, W2: 4 });
  } finally {
    await server.close();
  }
});

test('an exhausted campaign blocks the restored continuation BEFORE any provider attempt', async () => {
  const server = await fakeOpenAi(null);
  try {
    const { batch, run, ledger } = await runBatch(server, { limit: 2 });
    // W1's prefix legally spends the whole campaign (goal + timed wait)...
    const w1 = readScene(batch, 'W1')!;
    assert.equal(w1.overall, 'goal_not_reached');
    assert.equal(w1.prefix!.classification, 'goal_triggered');
    assert.equal(w1.prefix!.posts, 2);
    // ...so the restored suffix finds nothing to continue: with the SCENE
    // baseline the guard refuses BEFORE any provider attempt (the whole scene
    // share 2/2 is already spent) — nothing re-asked, the ledger untouched.
    assert.equal(w1.suffix!.classification, 'goal_not_reached');
    assert.match(w1.suffix!.reasons.join(' | '), /scene share 2\/2 already spent/);
    assert.equal(w1.suffix!.posts, 0, 'the blocked continuation spends ZERO posts');
    assert.equal(server.posts.length, 2, 'no provider attempt beyond the funded goal+wait');
    assert.equal(ledger.limit, 2);
    assert.equal(ledger.spent, 2);
    // The batch STOPS: W2 stays not_run at zero cost.
    assert.equal(readScene(batch, 'W2'), null);
    assert.equal(run.code, 1);
  } finally {
    await server.close();
  }
});

test('a feed_self answer classifies not_triggered and stops the batch', async () => {
  const server = await fakeOpenAi('{"goal":"feed_self"}');
  try {
    const { batch, run } = await runBatch(server, { limit: 8 });
    assert.equal(run.code, 1);
    assert.equal(server.posts.length, 1, 'one goal-choice post, then stop');
    const w1 = readScene(batch, 'W1')!;
    assert.equal(w1.overall, 'not_triggered');
    assert.equal(w1.prefix!.classification, 'not_triggered');
    assert.match(w1.prefix!.reasons.join(' | '), /feed_self/);
    assert.equal(readScene(batch, 'W2'), null, 'W2 never runs after a stop');
  } finally {
    await server.close();
  }
});

test('an HTTP 500 on the first post stops with evidence and no re-run', async () => {
  const server = await fakeOpenAi(null, 'http500');
  try {
    const { batch, campaign, run } = await runBatch(server, { limit: 8 });
    assert.equal(run.code, 1);
    assert.equal(server.posts.length, 1, 'the failed post is NOT retried');
    const w1 = readScene(batch, 'W1')!;
    assert.equal(w1.overall, 'technical_failure');
    assert.equal(w1.prefix!.classification, 'technical_failure');
    assert.ok(w1.prefix!.reasons.length > 0, 'the failure reason is recorded');
    assert.ok(w1.prefix!.slotPath === null, 'no slot is saved for a failed prefix');
    assert.equal(readScene(batch, 'W2'), null);
    // The failing run record survives for forensics.
    const records = readdirSync(join(batch, 'w1')).filter(name => name.endsWith('.run.json'));
    assert.equal(records.length, 1, 'the failure evidence run record exists');
    void campaign;
  } finally {
    await server.close();
  }
});

/* ------------------------------------------------------------------ */
/* 7-8: prepare exclusivity and verify tamper detection                */
/* ------------------------------------------------------------------ */

test('a same-name batch is refused with ZERO posts', async () => {
  const server = await fakeOpenAi(null);
  try {
    const base = mkdtempSync(join(tmpdir(), 'fe-g11-name-'));
    const batch = join(base, 'batch');
    const campaign = join(base, 'campaign');
    const first = await cli(DRIVER, ['prepare', '--batch', batch, '--campaign', campaign, '--http', server.url, '--model', 'qwen3.8-27b', '--limit', '8']);
    assert.equal(first.code, 0);
    const second = await cli(DRIVER, ['prepare', '--batch', batch, '--campaign', campaign, '--http', server.url, '--model', 'qwen3.8-27b', '--limit', '8']);
    assert.equal(second.code, 2, 'prepare refuses an existing plan');
    assert.match(second.stderr, /plan already exists/);
    assert.equal(server.posts.length, 0, 'no POST is spent by refusals');
  } finally {
    await server.close();
  }
});

test('verify detects ledger tampering, forged lineage and slot rewrites', async () => {
  assert.notEqual(fundedBatch, null, 'the funded test must run first (file order)');
  const base = mkdtempSync(join(tmpdir(), 'fe-g11-tamper-'));
  const batch = join(base, 'batch');
  const campaign = join(base, 'campaign');
  const reportPath = join(base, 'report', 'verify.json');
  const pristine = (): void => {
    rmSync(batch, { recursive: true, force: true });
    rmSync(campaign, { recursive: true, force: true });
    cpSync(fundedBatch!, batch, { recursive: true });
    cpSync(fundedCampaign!, campaign, { recursive: true });
  };
  pristine();
  const verifyArgs = ['verify', '--batch', batch, '--campaign', campaign, '--out', reportPath];
  /**
   * The copy keeps the ORIGINAL absolute paths inside every record. That is
   * legal evidence: worker A compares slots and the campaign locator by their
   * path TAIL, so a relocated copy still verifies. Nothing is text-edited,
   * which is also why the old Windows trap (JSON stores `C:\\tmp\\...` while the
   * test compared a single-backslash string, so the rewrite silently did
   * nothing AND broke the envelope hash) cannot come back here.
   */
  const clean = await cli(DRIVER, verifyArgs);
  assert.equal(clean.code, 0, `a relocated copy must verify byte-identically: ${clean.stdout.slice(-500)}`);

  const problemsOf = async (): Promise<string> => {
    const report = readJson(reportPath) as { issues: string[] };
    return report.issues.join(' | ');
  };
  /**
   * Semantic tampering: edit the payload AND re-sign the envelope with the
   * same slotChecksum the store uses, so the checksum cannot be the catcher.
   * Whatever fires now is a real semantic check.
   */
  const resign = (path: string, edit: (payload: AnyJson) => void): void => {
    const envelope = readJson(path) as { sha256: string; payload: AnyJson };
    edit(envelope.payload);
    writeFileSync(path, `${JSON.stringify({ ...envelope, sha256: slotChecksum(envelope.payload) }, null, 2)}\n`);
  };
  const expectIssue = async (pattern: RegExp, why: string): Promise<void> => {
    const checked = await cli(DRIVER, verifyArgs);
    assert.equal(checked.code, 1, `${why}: verify must fail (stdout ${checked.stdout.slice(-300)})`);
    assert.match(await problemsOf(), pattern, why);
  };

  // 1. Integrity: the ledger inflates spent without a matching attempt.
  const ledgerPath = join(campaign, 'campaign.json');
  const ledger = readJson(ledgerPath) as { spent: number };
  writeFileSync(ledgerPath, JSON.stringify({ ...ledger, spent: ledger.spent + 1 }, null, 2));
  await expectIssue(/ledger spent/, 'an inflated ledger spend must be caught by the ledger recount');
  pristine();

  // 2. Lineage: a suffix record claims a parent slot it never restored.
  const waitRecord = join(batch, 'w1', 'w1-wait-run.run.json');
  resign(waitRecord, payload => {
    (payload.lineage as AnyJson).parentSlot = '/tmp/forged.g09.json';
  });
  await expectIssue(/parentSlot/, 'a forged parentSlot must be caught even with a valid checksum');
  pristine();

  // 3. Slot rewrite: the bytes on disk no longer match the hash in the scene file.
  const slotPath = join(batch, 'w1', 'w1-wait.g09.json');
  writeFileSync(slotPath, `${readFileSync(slotPath, 'utf8')} `);
  await expectIssue(/slot bytes hash does not match the scene record/, 'a rewritten slot must be caught by the byte hash');
  pristine();

  // 4. AttemptId forgery: the wire names an attempt the ledger never charged.
  const prefixRecord = join(batch, 'w1', 'w1-prefix-run.run.json');
  const originalWire = (readJson(prefixRecord) as { payload: { wire: { attemptId: string }[] } }).payload.wire.map(entry => entry.attemptId);
  resign(prefixRecord, payload => {
    (payload.wire as { attemptId: string }[])[0]!.attemptId = 'att-forged';
  });
  await expectIssue(/att-forged is not in the campaign ledger/, 'a forged attemptId must not match any charged attempt');
  pristine();

  // 5. Cost tampering: the ledger total no longer equals the wire usage.
  const ledgerAll = readJson(ledgerPath) as { attempts: { attemptId: string; totalTokens: number | null }[] };
  const firstId = originalWire[0]!;
  const inflated = ledgerAll.attempts.map(attempt => attempt.attemptId === firstId ? { ...attempt, totalTokens: (attempt.totalTokens ?? 0) + 1 } : attempt);
  writeFileSync(ledgerPath, JSON.stringify({ ...ledgerAll, attempts: inflated }, null, 2));
  await expectIssue(/wire tokens \d+ != ledger \d+/, 'the ledger total must equal the recorded wire usage');
  pristine();

  // 6. Semantic re-derivation: the recorded end state is impossible. The world
  //    is REPLAYED on a fresh Engine, so a hand-edited final state is caught by
  //    the re-execution itself, not by a hard-coded satiety constant.
  const suffixRecord = join(batch, 'w1', 'w1-wait-run.run.json');
  resign(suffixRecord, payload => {
    (((payload.authoritative as AnyJson).snapshot as AnyJson).finalState as AnyJson).npcs = { npc_a: { hunger: 999 } };
  });
  await expectIssue(/different final state|re-execut/i, 'a hand-edited final state must be caught by re-derivation');
  pristine();

  // 7. The raw model text is re-parsed, not trusted: the body still parses as a
  //    chat completion, but its answer is now a stop and cannot be the recorded eat.
  resign(suffixRecord, payload => {
    const wire = payload.wire as { responseBody: string }[];
    const body = JSON.parse(wire[0]!.responseBody) as { choices: { message: { content: string } }[] };
    body.choices[0]!.message.content = '{"type":"stop"}';
    wire[0]!.responseBody = JSON.stringify(body);
  });
  await expectIssue(/is not the eat|is not the recorded eat/, 'the raw response must be re-parsed strictly');
  pristine();

  // 8. Command provenance: dropping the model-driven commands changes the count.
  resign(suffixRecord, payload => {
    ((payload.authoritative as AnyJson).snapshot as AnyJson).commands = [];
  });
  await expectIssue(/model-driven commands for/, 'commands must be replayed and counted against the wire');
  pristine();

  // 9. Omission: a missing scene is not evidence of success, it is incomplete.
  rmSync(join(batch, 'w2'), { recursive: true, force: true });
  rmSync(join(batch, 'scene-W2.json'), { force: true });
  const omitted = await cli(DRIVER, verifyArgs);
  assert.equal(omitted.code, 1, 'a missing scene must close the gate');
  const omittedReport = readJson(reportPath) as { complete: boolean; evidenceOk: boolean; classification: string; scenes: { scene: string; status: string }[] };
  assert.equal(omittedReport.complete, false, 'a scene with no records cannot complete the batch');
  // W2 was charged in the ledger but its records are gone: omission of CHARGED
  // work is an inconsistency, never a silent not_run.
  assert.equal(omittedReport.scenes.find(scene => scene.scene === 'W2')?.status, 'inconsistent');
  assert.equal(omittedReport.classification, 'inconsistent');
  pristine();

  // 10. A MISSING usage is honest accounting, not tampering: null on BOTH sides
  //     still verifies, and the grand total stays unknown instead of partial.
  const nulledLedger = (readJson(ledgerPath) as { attempts: { attemptId: string; totalTokens: number | null }[] });
  writeFileSync(ledgerPath, JSON.stringify({
    ...nulledLedger,
    attempts: nulledLedger.attempts.map(attempt => attempt.attemptId === firstId ? { ...attempt, totalTokens: null } : attempt),
  }, null, 2));
  resign(prefixRecord, payload => {
    (payload.wire as { usage: unknown }[])[0]!.usage = null;
  });
  const nullVerified = await cli(DRIVER, verifyArgs);
  assert.equal(nullVerified.code, 0, `null usage on both sides should still verify: ${nullVerified.stdout.slice(-300)}`);
  const nullReport = readJson(reportPath) as { issues: string[]; costs: { totalTokens: number | null; unknownUsage: string[] } };
  assert.deepEqual(nullReport.issues, []);
  assert.equal(nullReport.costs.unknownUsage.length, 1);
  assert.equal(nullReport.costs.totalTokens, null, 'an incomplete total is reported as unknown, never as a partial sum');
});

test('a scene that DECLARES its failure is evidence-ok but never complete', async () => {
  assert.notEqual(fundedBatch, null, 'the funded test must run first (file order)');
  const base = mkdtempSync(join(tmpdir(), 'fe-g11-declared-'));
  const batch = join(base, 'batch');
  const campaign = join(base, 'campaign');
  cpSync(fundedBatch!, batch, { recursive: true });
  cpSync(fundedCampaign!, campaign, { recursive: true });

  // W2's action timed out: no response body, no wait slot, no suffix, no binding.
  const prefixPath = join(batch, 'w2', 'w2-prefix-run.run.json');
  const envelope = readJson(prefixPath) as { sha256: string; payload: AnyJson };
  const wire = envelope.payload.wire as AnyJson[];
  const failedId = String(wire[1]!.attemptId);
  wire[1]!.status = null;
  wire[1]!.responseBody = null;
  wire[1]!.usage = null;
  wire[1]!.error = 'timeout';
  envelope.payload.campaign = { ...(envelope.payload.campaign as AnyJson), binding: null };
  writeFileSync(prefixPath, JSON.stringify({ ...envelope, sha256: slotChecksum(envelope.payload) }));
  // Read what the suffix charged BEFORE deleting its record.
  const suffixRange = ((readJson(join(batch, 'w2', 'w2-wait-run.run.json')) as AnyJson).payload.lineage as AnyJson).attemptRange as { first: string; last: string };
  rmSync(join(batch, 'w2', 'w2-wait-run.run.json'), { force: true });
  rmSync(join(batch, 'w2', 'w2-wait.g09.json'), { force: true });

  const ledgerPath = join(campaign, 'campaign.json');
  const ledger = readJson(ledgerPath) as { attempts: AnyJson[]; spent: number };
  // A run that never reached W2's suffix never charged for it, so the two
  // suffix attempts are dropped: leaving charged-but-wireless entries would be
  // a real contradiction, which is exactly what the verifier must reject.
  const dropped = new Set(ledger.attempts
    .filter(attempt => String(attempt.attemptId) >= String(suffixRange.first) && String(attempt.attemptId) <= String(suffixRange.last))
    .map(attempt => String(attempt.attemptId)));
  const kept = ledger.attempts
    .filter(attempt => !dropped.has(String(attempt.attemptId)))
    .map(attempt => attempt.attemptId === failedId
      ? { ...attempt, state: 'finished', outcome: 'provider_error', totalTokens: null }
      : attempt);
  writeFileSync(ledgerPath, JSON.stringify({ ...ledger, attempts: kept, spent: kept.length }, null, 2));

  const scenePath = join(batch, 'scene-W2.json');
  const scene = readJson(scenePath) as AnyJson;
  writeFileSync(scenePath, JSON.stringify({
    ...scene,
    overall: 'technical_failure',
    prefix: { ...(scene.prefix as AnyJson), classification: 'technical_failure' },
    suffix: null,
  }, null, 2));

  const out = join(base, 'verify.json');
  const verified = await cli(DRIVER, ['verify', '--batch', batch, '--campaign', campaign, '--out', out]);
  assert.equal(verified.code, 1, 'an honestly failed scene is not a completion');
  const report = readJson(out) as {
    evidenceOk: boolean; complete: boolean; ok: boolean; classification: string;
    issues: string[]; expectations: string[]; scenes: { scene: string; status: string }[];
  };
  assert.deepEqual(report.issues, [], 'a declared failure is not corrupted evidence');
  assert.equal(report.evidenceOk, true);
  assert.equal(report.complete, false, 'the gate stays closed');
  assert.equal(report.ok, false);
  assert.equal(report.classification, 'incomplete');
  assert.equal(report.scenes.find(entry => entry.scene === 'W2')?.status, 'incomplete');
  const expected = report.expectations.join(' | ');
  assert.match(expected, /did not finish/, 'the aborted request is an unmet outcome, not corruption');
  assert.match(expected, /w2-wait-run\.run\.json|has no suffix|pre-close slot/, 'the suffix that never ran is an expectation');
  assert.equal(report.expectations.some(entry => entry.includes('the scene file hides')), false);
});
