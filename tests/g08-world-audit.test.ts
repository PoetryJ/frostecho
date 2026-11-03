/**
 * G08 closeout worker A — the world causal chain must be re-derivable from
 * the raw response. These tests mutate ONE thing at a time on a real fake
 * batch and require a NAMED rejection, while the honest records pass.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { runG08Batch, type G08RunOptions } from '../scripts/eval-g08';
import { G08_PLAN } from '../scripts/g08-eval-lib';
import { auditWorldEpisode } from '../scripts/g08-evidence-world';
import type { WorldAuditRecord } from '../scripts/g08-evidence-contracts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-g08-world-'));
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

function loadRecord(batchDir: string, episodeId: string): WorldAuditRecord {
  return JSON.parse(readFileSync(join(batchDir, 'episodes', `${episodeId}.json`), 'utf8')) as WorldAuditRecord;
}

function entryOf(episodeId: string) {
  const entry = G08_PLAN.find(candidate => candidate.episodeId === episodeId);
  assert.ok(entry !== undefined);
  return entry;
}

test('an honest eat episode: the command chain is the model output', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const record = loadRecord(dir, 'g08-r1-legacy-off');
    const audit = auditWorldEpisode(entryOf('g08-r1-legacy-off'), record);
    assert.deepEqual(audit.issues, []);
    assert.equal(audit.derivedBehavior?.npcAction, 'eat');
    assert.equal(audit.derivedBehavior?.npcAte, true);
    assert.equal(audit.derivedBehavior?.playerEatStatus, 'rejected');
    assert.equal(audit.derivedBehavior?.waitAccepted, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an honest wait episode: no world command, paused with deadline 1', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const record = loadRecord(dir, 'g08-r1-timed_wait-off');
    const audit = auditWorldEpisode(entryOf('g08-r1-timed_wait-off'), record);
    assert.deepEqual(audit.issues, []);
    assert.equal(audit.derivedBehavior?.npcAction, 'wait');
    assert.equal(audit.derivedBehavior?.npcAte, false);
    assert.equal(audit.derivedBehavior?.waitAccepted, true);
    assert.equal(audit.derivedBehavior?.waitDeadline, 1);
    assert.equal(audit.derivedBehavior?.playerEatStatus, 'accepted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a command changed to move while the events still say eat is rejected', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const record = loadRecord(dir, 'g08-r1-legacy-off');
    const command = (record.snapshot.commands[0] as { command: Record<string, unknown> }).command;
    command.type = 'move';
    command.payload = { to: 'dorm' };
    const audit = auditWorldEpisode(entryOf('g08-r1-legacy-off'), record);
    assert.ok(audit.issues.length > 0);
    assert.ok(audit.issues.some(issue => issue.includes('the raw response says eat')), audit.issues.join('; '));
    assert.ok(audit.issues.some(issue => issue.includes('re-execut')), audit.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a command/event ledger that no longer matches the raw action is rejected', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const record = loadRecord(dir, 'g08-r1-legacy-off');
    // Keep the executed eat command and its events; change only the model text.
    const http = record.http[0] as { response: { raw: string } };
    const response = JSON.parse(http.response.raw) as { choices: { message: { content: string } }[] };
    response.choices[0].message.content = '{"type":"move","to":"dorm"}';
    http.response.raw = JSON.stringify(response);
    const audit = auditWorldEpisode(entryOf('g08-r1-legacy-off'), record);
    assert.ok(audit.issues.some(issue => issue.includes('the raw response says move')), audit.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a forged wait flag without the paused game state is rejected', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const record = loadRecord(dir, 'g08-r1-legacy-off');
    (record.behavior as { wait: { accepted: boolean; wakeAtSimTime: number | null } }).wait = { accepted: true, wakeAtSimTime: 1 };
    const audit = auditWorldEpisode(entryOf('g08-r1-legacy-off'), record);
    assert.ok(audit.issues.some(issue => issue.includes('behavior.wait.accepted true contradicts')), audit.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a forged player status is rejected against the executed command', async () => {
  const root = tempRoot();
  try {
    const dir = await seedBatch(root);
    const record = loadRecord(dir, 'g08-r1-legacy-off');
    (record.behavior as { playerEatCommand: { status: string } }).playerEatCommand = { status: 'accepted' };
    const audit = auditWorldEpisode(entryOf('g08-r1-legacy-off'), record);
    assert.ok(audit.issues.some(issue => issue.includes('playerEatCommand.status')), audit.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
