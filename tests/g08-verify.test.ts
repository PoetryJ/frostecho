/**
 * G08-R1 worker D — independent recomputation of the evidence and tampering
 * black-box tests. The verifier is fed copies of a real batch after bytes are
 * changed; every counterexample must be a NAMED finding, and a tampered batch
 * must never look like success. The positive case proves the recomputation
 * does not reject honest evidence.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runG08Batch, type G08RunOptions } from '../scripts/eval-g08';
import { verifyG08Batch, verifyG08Prefix } from '../scripts/g08-eval-lib';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-g08-verify-'));
}

/** A legal per-axis fake batch: legacy eats, timed_wait waits. */
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
  const result = await runG08Batch(options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.verify.complete, true);
  assert.equal(result.verify.evidenceOk, true);
  assert.equal(result.verify.ok, true);
  return result.batchDir;
}

function copyOf(source: string, target: string): string {
  cpSync(source, target, { recursive: true, errorOnExist: true, force: false });
  return target;
}

function mutateEpisode(dir: string, change: (record: Record<string, unknown>) => void): void {
  const file = join(dir, 'episodes', 'g08-r1-legacy-off.json');
  const data = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  change(data);
  writeFileSync(file, JSON.stringify(data, null, 2));
}

test('the honest batch passes: evidence ok, complete, 8/8, no issues', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const verify = verifyG08Batch(dir);
    assert.equal(verify.evidenceOk, true);
    assert.equal(verify.complete, true);
    assert.equal(verify.runSucceeded, true);
    assert.equal(verify.stats.completed, 8);
    assert.deepEqual(verify.issues, []);
    assert.deepEqual(verify.configurationIssues, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an impossible world is detected: the events cannot rebuild the final state', async () => {
  const root = tempRoot();
  try {
    const dir = copyOf(await seedBatch(root), join(root, 'impossible'));
    mutateEpisode(dir, record => {
      const snapshot = record.snapshot as { finalState: { npcs: Record<string, { hunger: number }>; food: Record<string, number> } };
      snapshot.finalState.npcs.npc_a.hunger = 999;
      snapshot.finalState.food.kitchen = 999;
    });
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.some(issue => issue.includes('rebuild the final state')), verify.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a timeout that disagrees with the frozen 120000 is a configuration finding', async () => {
  const root = tempRoot();
  try {
    const dir = copyOf(await seedBatch(root), join(root, 'timeout'));
    mutateEpisode(dir, record => {
      const snapshot = record.snapshot as { requestConfig: { timeoutMs: number } };
      snapshot.requestConfig.timeoutMs = 15000;
    });
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.configurationIssues.some(issue => issue.includes('timeout')), verify.configurationIssues.join('; '));
    assert.equal(verify.behaviorAndCostOk, true);
    assert.equal(verify.configurationConsistent, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a request body that leaks another model/config is caught', async () => {
  const root = tempRoot();
  try {
    const dir = copyOf(await seedBatch(root), join(root, 'body'));
    mutateEpisode(dir, record => {
      const http = record.http as { request: { body: Record<string, unknown> } }[];
      http[0].request.body.model = 'wrong-model';
      http[0].request.body.chat_template_kwargs = { enable_thinking: false };
      http[0].request.body.temperature = 1;
    });
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.configurationIssues.some(issue => issue.includes('model')), verify.configurationIssues.join('; '));
    assert.ok(verify.configurationIssues.some(issue => issue.includes('enable_thinking')));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a raw response that no longer matches the recorded action is caught', async () => {
  const root = tempRoot();
  try {
    const dir = copyOf(await seedBatch(root), join(root, 'raw'));
    mutateEpisode(dir, record => {
      const http = record.http as { response: { raw: string } }[];
      const response = JSON.parse(http[0].response.raw) as { choices: { message: { content: string } }[] };
      response.choices[0].message.content = '{"type":"stop"}';
      http[0].response.raw = JSON.stringify(response);
    });
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.some(issue => issue.includes('the raw response says')), verify.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a deleted ledger is caught: 8 episodes, zero attempt files', async () => {
  const root = tempRoot();
  try {
    const dir = copyOf(await seedBatch(root), join(root, 'ledger'));
    for (const name of readdirSync(join(dir, 'attempts'))) rmSync(join(dir, 'attempts', name));
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.some(issue => issue.includes('missing ledger')), verify.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an empty batch is never complete success', async () => {
  const root = tempRoot();
  try {
    const dir = copyOf(await seedBatch(root), join(root, 'empty'));
    for (const name of ['episodes', 'attempts', 'status']) {
      for (const file of readdirSync(join(dir, name))) rmSync(join(dir, name, file));
    }
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
    assert.equal(verify.complete, false);
    assert.equal(verify.stats.completed, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('unknown/corrupted JSON is a named finding, never an exception', async () => {
  const root = tempRoot();
  try {
    const dir = copyOf(await seedBatch(root), join(root, 'corrupt'));
    writeFileSync(join(dir, 'episodes', 'g08-r1-legacy-off.json'), 'null');
    writeFileSync(join(dir, 'status', 'g08-r1-legacy-on.json'), '[]');
    writeFileSync(join(dir, 'attempts', 'att-0001.begin.json'), '{"broken":');
    const verify = verifyG08Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.length > 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the prefix gate checks only the first pair and never passes an empty prefix', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const prefix = verifyG08Prefix(dir);
    assert.equal(prefix.stats.planned, 2);
    assert.equal(prefix.complete, true);
    assert.equal(prefix.evidenceOk, true);
    // A batch with no episodes yet: zero completed must NOT pass.
    const emptyDir = join(root, 'prefix-empty');
    mkdirSync(join(emptyDir), { recursive: true });
    cpSync(join(dir, 'plan.json'), join(emptyDir, 'plan.json'));
    const empty = verifyG08Prefix(emptyDir);
    assert.equal(empty.complete, false);
    assert.equal(empty.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
