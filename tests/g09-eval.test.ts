/**
 * G09-R1 worker D tests — the ORIGINAL matrix and runtime, the task-scoped
 * campaign budget, and the read-only verifier against the external contract.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  G09_CELLS, canonical, frozenPlanEntries, g09InitialState, g09Plan, g09Protocol, g09RuntimeConfig,
  readG09Batch, verifyG09Batch,
} from '../scripts/g09-eval-lib';
import { loadCampaign, openCampaign, reserveCampaignChat } from '../scripts/campaign-budget';
import { G09_ALLOWED_GOALS, G09_HARD_CHAT_LIMIT, G09_REQUEST_TEXT } from '../src/negotiation/contracts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-g09r1-eval-'));
}

function runEval(out: string, batch: string, campaign: string, extra: string[] = []): { code: number; out: string } {
  try {
    const outText = execFileSync(process.execPath, ['dist/scripts/eval-g09.js', '--out', out, '--batch', batch, '--campaign', campaign, '--fake', ...extra], { encoding: 'utf8' });
    return { code: 0, out: outText };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

function hashTree(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path);
      else { hash.update(path.slice(dir.length)); hash.update(readFileSync(path)); }
    }
  };
  walk(dir);
  return hash.digest('hex');
}

test('the frozen matrix is exact and rep 2 is the reverse', () => {
  const plan = g09Plan('b');
  assert.deepEqual(plan.plan.map(entry => [entry.rep, entry.satiety, entry.arm]), [
    [1, 40, 'self_only'], [1, 40, 'choice'], [1, 60, 'self_only'], [1, 60, 'choice'],
    [2, 60, 'choice'], [2, 60, 'self_only'], [2, 40, 'choice'], [2, 40, 'self_only'],
  ]);
  for (const entry of plan.plan) assert.ok(entry.requestId.length > 0, 'both arms carry a host request id');
});

test('the frozen world and the shared runtime factory', () => {
  for (const hunger of [40, 60] as const) {
    const state = g09InitialState(hunger);
    assert.deepEqual(state, {
      tick: 0, simTime: 0,
      npcs: {
        npc_a: { id: 'npc_a', location: 'kitchen', hunger },
        npc_b: { id: 'npc_b', location: 'kitchen', hunger: 40 },
        npc_c: { id: 'npc_c', location: 'kitchen', hunger: 70 },
      },
      food: { kitchen: 1, dorm: 0 },
    });
  }
  assert.deepEqual(g09RuntimeConfig(), {
    actorIds: ['npc_a', 'npc_c'], needPolicy: 'recurring', policy: 'event', actionSet: 'timed_wait', goalMode: 'negotiated',
  });
  for (const arm of ['self_only', 'choice'] as const) {
    const protocol = g09Protocol({ arm, requestId: 'opaque' });
    assert.equal(protocol.text, G09_REQUEST_TEXT);
    assert.deepEqual([...protocol.options], [...G09_ALLOWED_GOALS[arm]]);
  }
});

test('the campaign budget never refreshes by batch name and survives a restart', () => {
  const root = tempRoot();
  try {
    const campaign = join(root, 'campaign');
    openCampaign(campaign, 2);
    assert.equal(reserveCampaignChat(campaign, { batch: 'a', episodeId: 'e1', phase: 'goal' }).ok, true);
    assert.equal(reserveCampaignChat(campaign, { batch: 'b', episodeId: 'e2', phase: 'goal' }).ok, true);
    const third = reserveCampaignChat(campaign, { batch: 'c', episodeId: 'e3', phase: 'goal' });
    assert.equal(third.ok, false, 'a new batch name gives no extra budget');
    const state = loadCampaign(campaign);
    assert.equal(state.spent, 2);
    assert.equal(state.limit, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a legal fake batch: 8 episodes, 16 POSTs, verify ok', () => {
  const root = tempRoot();
  try {
    const run = runEval(join(root, 'out'), 'legal', join(root, 'campaign'));
    assert.equal(run.code, 0, run.out);
    const verify = verifyG09Batch(join(root, 'out', 'legal'), { limit: G09_HARD_CHAT_LIMIT, spent: 16 });
    assert.deepEqual(verify.issues, []);
    assert.equal(verify.ok, true);
    assert.equal(verify.derivation.protocol.completed, 8);
    assert.equal(verify.derivation.costs.chatRequests, 16);
    assert.equal(verify.derivation.goals.yield_once, 4);
    assert.equal(verify.derivation.goals.feed_self, 4);
    // The reference yields in the choice arm and eats in the action phase.
    assert.equal(verify.derivation.fulfilment.byCell['s40-choice']!.violated, 2);
    assert.equal(verify.derivation.fulfilment.byCell['s60-self_only']!.not_applicable ?? 0, 0);
    const batch = readG09Batch(join(root, 'out', 'legal'));
    for (const record of batch.episodes) {
      assert.equal(record.http.length, 2);
      for (const exchange of record.http) {
        assert.ok(exchange.attemptId.length > 0);
        assert.ok(exchange.prompt.length > 0);
        assert.ok((exchange.requestBody as { model?: string }).model !== undefined);
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('campaign limit 2 stops after two POSTs across two batches', () => {
  const root = tempRoot();
  try {
    const campaign = join(root, 'campaign');
    const first = runEval(join(root, 'out'), 'first', campaign, ['--campaign-limit', '2']);
    assert.notEqual(first.code, 0, first.out);
    const spent1 = loadCampaign(campaign).spent;
    assert.ok(spent1 <= 2, `spent ${spent1}`);
    const second = runEval(join(root, 'out'), 'second', campaign);
    const spent2 = loadCampaign(campaign).spent;
    assert.equal(spent2, spent1, 'the second batch spends nothing: the task limit is already reached');
    assert.notEqual(second.code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a self-declared plan or summary cannot pass the external contract', () => {
  const root = tempRoot();
  try {
    assert.equal(runEval(join(root, 'out'), 'tamper', join(root, 'campaign')).code, 0);
    const dir = join(root, 'out', 'tamper');
    const edit = (path: string, mutate: (value: Record<string, unknown>) => void) => {
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      mutate(value);
      writeFileSync(path, JSON.stringify(value, null, 2));
    };
    edit(join(dir, 'plan.json'), plan => { plan.hardChatLimit = 999; });
    edit(join(dir, 'summary.json'), summary => {
      summary.hardChatLimit = 999;
      (summary.costs as Record<string, unknown>).chatRequests = 1;
    });
    const verify = verifyG09Batch(dir, { limit: G09_HARD_CHAT_LIMIT, spent: 16 });
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.some(issue => issue.includes('hardChatLimit')), verify.issues.join('; '));
    assert.ok(verify.issues.some(issue => issue.startsWith('summary.')), verify.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a wrong attempt association or begin configuration is rejected', () => {
  const root = tempRoot();
  try {
    const edit = (path: string, mutate: (value: Record<string, unknown>) => void) => {
      const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      mutate(value);
      writeFileSync(path, JSON.stringify(value, null, 2));
    };
    // 1. An exchange pointing at a nonexistent attempt (own batch).
    assert.equal(runEval(join(root, 'a'), 'assoc', join(root, 'campaign-a')).code, 0);
    const dirA = join(root, 'a', 'assoc');
    edit(join(dirA, 'episodes', 'g09-r1-s40-self_only.json'), record => {
      const http = record.http as { phase: string; attemptId: string }[];
      http.find(exchange => exchange.phase === 'goal')!.attemptId = 'att-9999';
    });
    const verifyA = verifyG09Batch(dirA, { limit: G09_HARD_CHAT_LIMIT, spent: 16 });
    assert.equal(verifyA.ok, false);
    assert.ok(verifyA.issues.some(issue => issue.includes('att-9999')), verifyA.issues.join('; '));

    // 2. A begin whose requestConfig model disagrees with the outbound body.
    assert.equal(runEval(join(root, 'b'), 'assoc', join(root, 'campaign-b')).code, 0);
    const dirB = join(root, 'b', 'assoc');
    const attempts = join(dirB, 'attempts');
    const firstBegin = readdirSync(attempts).filter(name => name.endsWith('.begin.json'))[0]!;
    edit(join(attempts, firstBegin), begin => {
      (begin.requestConfig as Record<string, unknown>).model = 'other-model';
    });
    const verifyB = verifyG09Batch(dirB, { limit: G09_HARD_CHAT_LIMIT, spent: 16 });
    assert.equal(verifyB.ok, false);
    assert.ok(verifyB.issues.some(issue => issue.includes('disagrees with the begin requestConfig')), verifyB.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('verification is read-only', () => {
  const root = tempRoot();
  try {
    assert.equal(runEval(join(root, 'out'), 'ro', join(root, 'campaign')).code, 0);
    const dir = join(root, 'out', 'ro');
    const before = hashTree(dir);
    verifyG09Batch(dir, { limit: G09_HARD_CHAT_LIMIT, spent: 16 });
    assert.equal(hashTree(dir), before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the frozen entries are derived from the contract, not from disk', () => {
  const frozen = frozenPlanEntries();
  assert.deepEqual(frozen.map(entry => entry.episodeId), g09Plan('x').plan.map(entry => entry.episodeId));
  assert.deepEqual(G09_CELLS.map(cell => cell.cell), ['s40-self_only', 's40-choice', 's60-self_only', 's60-choice']);
  assert.equal(canonical(frozen[0]!.cell), canonical('s40-self_only'));
});
