/**
 * G08 closeout worker D — independent black-box acceptance.
 *
 * These tests only use the public surface (runG08Batch / verifyG08Batch /
 * verifyG08Prefix / the CLI) and the files on disk. They assert the CONTRACT,
 * not a particular hardcoded counterexample: a legal batch passes, any single
 * contradiction is rejected with a named finding, verification is read-only,
 * and the exit code follows the evidence.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runG08Batch, type G08RunOptions } from '../scripts/eval-g08';
import { verifyG08Batch, verifyG08Prefix } from '../scripts/g08-eval-lib';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-g08-blackbox-'));
}

async function seedBatch(root: string, batchId = 'seed'): Promise<string> {
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
    out: root, batchId, url: 'http://127.0.0.1:1/v1/chat/completions',
    model: 'fake-model', fetchImpl, mode: 'fake',
  };
  return (await runG08Batch(options)).batchDir;
}

function edit(file: string, fn: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  fn(value);
  writeFileSync(file, JSON.stringify(value, null, 2));
}

/** Stable hash of every file under a directory (proves read-only verify). */
function hashTree(dir: string): string {
  const hash = createHash('sha256');
  const walk = (current: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statIsDir(path)) { walk(path); continue; }
      hash.update(path.slice(dir.length));
      hash.update(readFileSync(path));
    }
  };
  walk(dir);
  return hash.digest('hex');
}

function statIsDir(path: string): boolean {
  try {
    return readdirSync(path) !== undefined;
  } catch {
    return false;
  }
}

test('a legal mixed batch passes, and verification does not touch the evidence', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const before = hashTree(dir);
    const verify = verifyG08Batch(dir);
    assert.deepEqual(verify.issues, []);
    assert.deepEqual(verify.configurationIssues, []);
    assert.equal(verify.runSucceeded, true);
    assert.equal(verify.stats.completed, 8);
    assert.equal(verify.stats.chatRequests, 8);
    assert.equal(hashTree(dir), before, 'verification must be read-only');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a command/event contradiction is rejected', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    edit(join(dir, 'episodes', 'g08-r1-legacy-off.json'), record => {
      const command = ((record.snapshot as { commands: { command: Record<string, unknown> }[] }).commands[0]!).command;
      command.type = 'move';
      command.payload = { to: 'dorm' };
    });
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.some(issue => issue.includes('re-execut')), verify.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a self-consistent ledger that no longer matches the raw decision is rejected', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    edit(join(dir, 'episodes', 'g08-r1-timed_wait-off.json'), record => {
      const http = (record.http as { response: { raw: string } }[])[0]!;
      const response = JSON.parse(http.response.raw) as { choices: { message: { content: string } }[] };
      response.choices[0]!.message.content = '{"type":"eat"}';
      http.response.raw = JSON.stringify(response);
    });
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.some(issue => issue.includes('raw response says eat')), verify.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tampered summary cannot vouch for itself', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    edit(join(dir, 'summary.json'), summary => {
      summary.chatRequests = 999;
      summary.gateSpent = 999;
      (summary.totals as Record<string, unknown>).completed = 999;
      const tokens = summary.tokens as { totalTokens: unknown }[];
      tokens[0]!.totalTokens = 999;
      ((summary.costs as Record<string, unknown>).counts as Record<string, unknown>).spent = 999;
    });
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
    for (const fragment of ['summary.chatRequests', 'summary.gateSpent', 'summary.totals.completed', 'summary.tokens', 'summary.costs.counts.spent']) {
      assert.ok(verify.issues.some(issue => issue.includes(fragment)), `${fragment}: ${verify.issues.join('; ')}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing summary fails the complete verification', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    rmSync(join(dir, 'summary.json'));
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.some(issue => issue.includes('summary.json is missing')), verify.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a duplicated finish is rejected by the full verifier', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const attempts = join(dir, 'attempts');
    const finish = readdirSync(attempts).filter(name => name.endsWith('.finish.json'))[0]!;
    cpSync(join(attempts, finish), join(attempts, `dup-${finish}`));
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.some(issue => issue.includes('duplicate attempt finish')), verify.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown usage is acknowledged, not silently zeroed', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    edit(join(dir, 'episodes', 'g08-r2-legacy-on.json'), record => {
      const http = (record.http as { response: { raw: string } }[])[0]!;
      const response = JSON.parse(http.response.raw) as Record<string, unknown>;
      delete response.usage;
      http.response.raw = JSON.stringify(response);
    });
    // The summary was derived before the mutation: it must disagree now.
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.some(issue => issue.includes('g08-r2-legacy-on') && issue.includes('totalTokens')),
      verify.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the prefix gate passes the first pair but a truncated batch is never complete', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const prefix = verifyG08Prefix(dir);
    assert.equal(prefix.stats.planned, 2);
    assert.equal(prefix.ok, true);
    // An empty batch: zero records, zero success.
    const emptyRoot = tempRoot();
    try {
      const empty = await seedBatch(emptyRoot, 'empty');
      for (const name of ['episodes', 'attempts', 'status']) {
        for (const file of readdirSync(join(empty, name))) rmSync(join(empty, name, file));
      }
      const truncated = verifyG08Batch(empty);
      assert.equal(truncated.complete, false);
      assert.equal(truncated.runSucceeded, false);
      const truncatedPrefix = verifyG08Prefix(empty);
      assert.equal(truncatedPrefix.ok, false, 'a prefix over zero episodes must not pass');
    } finally {
      rmSync(emptyRoot, { recursive: true, force: true });
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('corrupted evidence is a named failure, never an exception', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    writeFileSync(join(dir, 'episodes', 'g08-r1-legacy-off.json'), '{not json');
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an illegal first episode stops the batch: one request, seven not_run, nonzero exit', async () => {
  const root = tempRoot();
  try {
    const fetchImpl: typeof fetch = async () => new Response(JSON.stringify({
      choices: [{ message: { content: '{"type":"wait"}' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { 'content-type': 'application/json' } });
    let requests = 0;
    const counting: typeof fetch = async (input, init) => {
      requests += 1;
      return fetchImpl(input, init);
    };
    const result = await runG08Batch({
      out: root, batchId: 'illegal', url: 'http://127.0.0.1:1/v1/chat/completions',
      model: 'fake-model', fetchImpl: counting, mode: 'fake',
    });
    assert.equal(requests, 1);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.verify.stats.completed, 0);
    assert.equal(result.verify.stats.notRun, 7);
    assert.equal(existsSync(join(result.batchDir, 'summary.json')), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
