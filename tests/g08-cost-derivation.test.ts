/**
 * G08 closeout worker B — the ledger derivation must be recomputed, complete
 * (8 episodes, four cells x two repetitions, four pairs) and must never turn
 * unknown usage into a zero cost.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runG08Batch, type G08RunOptions } from '../scripts/eval-g08';
import { deriveLedgerCosts } from '../scripts/g08-evidence-cost';
import { verifyG08Batch } from '../scripts/g08-eval-lib';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-g08-cost-'));
}

async function seedBatch(root: string): Promise<string> {
  const fetchImpl: typeof fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as { messages?: { content?: string }[] };
    const prompt = String(body.messages?.[0]?.content ?? '');
    const content = prompt.includes('allowedActions: ["move","eat","stop","wait"]') ? '{"type":"wait"}' : '{"type":"eat"}';
    return new Response(JSON.stringify({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const options: G08RunOptions = {
    out: root, batchId: 'seed', url: 'http://127.0.0.1:1/v1/chat/completions',
    model: 'fake-model', fetchImpl, mode: 'fake',
  };
  const result = await runG08Batch(options);
  assert.equal(result.exitCode, 0);
  return result.batchDir;
}

function editJson(file: string, fn: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  fn(value);
  writeFileSync(file, JSON.stringify(value, null, 2));
}

test('an honest batch derives all eight episodes, four cells and four pairs', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const derivation = deriveLedgerCosts(dir);
    assert.deepEqual(derivation.issues, []);
    assert.equal(derivation.counts.planned, 8);
    assert.equal(derivation.counts.completed, 8);
    assert.equal(derivation.counts.chatRequests, 8);
    assert.equal(derivation.counts.spent, 8);
    assert.equal(derivation.counts.unresolved, 0);
    assert.equal(derivation.episodes.length, 8);
    assert.equal(derivation.cells.length, 4);
    for (const cell of derivation.cells) {
      assert.equal(cell.episodes.length, 2, cell.cell);
      assert.equal(cell.totalTokens, 24, cell.cell);
    }
    assert.equal(derivation.pairs.length, 4);
    for (const pair of derivation.pairs) {
      assert.equal(pair.offTokens, 12, pair.pair);
      assert.equal(pair.onTokens, 12, pair.pair);
      assert.equal(pair.delta, 0, pair.pair);
    }
    assert.equal(derivation.knownTokenSum, 96);
    // The expectation is the shape the summary must match.
    const costs = derivation.expectation.costs as Record<string, unknown>;
    assert.equal(costs.knownTokenSum, 96);
    assert.equal((derivation.expectation.chatRequests as number), 8);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable usage is unknown, never a zero cost', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    editJson(join(dir, 'episodes', 'g08-r1-legacy-off.json'), record => {
      const http = record.http as { response: { raw: string } }[];
      const response = JSON.parse(http[0]!.response.raw) as Record<string, unknown>;
      delete response.usage;
      http[0]!.response.raw = JSON.stringify(response);
    });
    const derivation = deriveLedgerCosts(dir);
    const episode = derivation.episodes.find(cost => cost.episodeId === 'g08-r1-legacy-off');
    assert.ok(episode !== undefined);
    assert.equal(episode.totalTokens, null);
    assert.equal(episode.usageUnknown, true);
    assert.equal(derivation.counts.usageUnknown, 1);
    // The known part survives; the total stays explicitly unknown.
    assert.equal(derivation.knownTokenSum, 84);
    const pair = derivation.pairs.find(candidate => candidate.pair === 'legacy-r1');
    assert.equal(pair?.delta, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a duplicated finish is a named ledger issue', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const attempts = join(dir, 'attempts');
    const finish = readdirSync(attempts).find(name => name.endsWith('.finish.json'));
    assert.ok(finish !== undefined);
    writeFileSync(join(attempts, `dup-${finish}`), readFileSync(join(attempts, finish), 'utf8'));
    const derivation = deriveLedgerCosts(dir);
    assert.ok(derivation.issues.some(issue => issue.includes('duplicate attempt finish')), derivation.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an orphan finish and an unresolved begin are both named', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const attempts = join(dir, 'attempts');
    const finish = readdirSync(attempts).find(name => name.endsWith('.finish.json'));
    assert.ok(finish !== undefined);
    // An orphan: a finish with no begin.
    const orphan = JSON.parse(readFileSync(join(attempts, finish), 'utf8')) as Record<string, unknown>;
    orphan.attemptId = 'att-orphan';
    writeFileSync(join(attempts, 'att-orphan.finish.json'), JSON.stringify(orphan, null, 2));
    // An unresolved begin with no finish.
    const begin = readdirSync(attempts).find(name => name.endsWith('.begin.json'));
    assert.ok(begin !== undefined);
    const dangling = JSON.parse(readFileSync(join(attempts, begin), 'utf8')) as Record<string, unknown>;
    dangling.attemptId = 'att-dangling';
    writeFileSync(join(attempts, 'att-dangling.begin.json'), JSON.stringify(dangling, null, 2));
    const derivation = deriveLedgerCosts(dir);
    assert.ok(derivation.issues.some(issue => issue.includes('no matching begin')), derivation.issues.join('; '));
    assert.ok(derivation.issues.some(issue => issue.includes('without a finish record')), derivation.issues.join('; '));
    assert.equal(derivation.counts.unresolved, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the hard chat budget cannot be exceeded by the ledger', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const attempts = join(dir, 'attempts');
    const begin = readdirSync(attempts).find(name => name.endsWith('.begin.json'));
    assert.ok(begin !== undefined);
    const extra = JSON.parse(readFileSync(join(attempts, begin), 'utf8')) as Record<string, unknown>;
    extra.attemptId = 'att-extra';
    writeFileSync(join(attempts, 'att-extra.begin.json'), JSON.stringify(extra, null, 2));
    const derivation = deriveLedgerCosts(dir);
    assert.ok(derivation.issues.some(issue => issue.includes('over the frozen budget')), derivation.issues.join('; '));
    assert.equal(derivation.counts.chatRequests, 9);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('spent charges begins conservatively; an unresolved begin keeps usage unknown', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    // 8 begins / 7 finishes: drop the finish of one named attempt.
    const record = JSON.parse(readFileSync(join(dir, 'episodes', 'g08-r1-legacy-off.json'), 'utf8')) as {
      attempts: { attemptId: string }[];
    };
    const attemptId = record.attempts[0]!.attemptId;
    rmSync(join(dir, 'attempts', `${attemptId}.finish.json`));
    const derivation = deriveLedgerCosts(dir);
    assert.equal(derivation.counts.chatRequests, 8);
    assert.equal(derivation.counts.spent, 8, 'spent must charge begins, not finishes');
    assert.equal(derivation.counts.unresolved, 1);
    const episode = derivation.episodes.find(cost => cost.episodeId === 'g08-r1-legacy-off');
    assert.ok(episode !== undefined);
    assert.equal(episode.finishes, 0);
    assert.equal(episode.totalTokens, null, 'an unresolved attempt cannot report a known token total');
    assert.equal(episode.usageUnknown, true);
    assert.ok(derivation.issues.some(issue => issue.includes('without a finish record')), derivation.issues.join('; '));
    // The tampered batch must fail the read-only verification.
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a blocked ledger record is counted, not silently dropped', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    writeFileSync(join(dir, 'attempts', 'blocked-0001.json'), JSON.stringify({
      schema: 'frostecho.g07.live.blocked/1', seq: 1, at: new Date().toISOString(),
      episodeId: 'g08-r2-legacy-off', actorId: 'npc_a', cycle: 1, round: 1, reason: 'chat budget exhausted',
    }, null, 2));
    const derivation = deriveLedgerCosts(dir);
    assert.equal(derivation.counts.blocked, 1);
    assert.equal(derivation.expectation.gateBlocked, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
