/**
 * G07 worker D — proof that verify() compares the data lines literally and
 * really re-executes the recorded ledger on a fresh Engine.
 *
 * Every batch here is produced by the in-process fake fixture server: the
 * batch is `mode: 'fake'` and every snapshot is `mode: 'fixture'`. Nothing in
 * this file is a claim about a live model; it only shows that the verifier
 * detects a tampered data line, a tampered command result and a tampered
 * final state inside a fake batch.
 */
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import {
  G07_EXPECTED_FEEDBACK_LINE, G07_EXPECTED_GOAL_HUNGER, G07_EXPECTED_OBSERVATION,
  dataLine, promptCaptures, promptDataLines, readBatch, reexecuteCommands, sha256,
  verifyBatch, verifyPromptData,
} from '../scripts/g07-eval-lib';
import type { G07DataLineName, G07EpisodeRecord } from '../scripts/g07-eval-lib';
import { runG07Batch, type G07RunOptions } from '../scripts/eval-g07';

interface FakeServer {
  url: string;
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

async function startServer(content = '{"type":"stop"}'): Promise<FakeServer> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      if (req.url === '/health') {
        res.statusCode = 200;
        res.end('ok');
        return;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ data: [{ id: 'fake-model' }] }));
      return;
    }
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      requests.push(JSON.parse(raw) as Record<string, unknown>);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}

function batchOptions(url: string, out: string, batchId: string): G07RunOptions {
  return { out, batchId, url, model: 'fake-model', fetchImpl: (input, init) => fetch(input, init), mode: 'fake' };
}

let server!: FakeServer;
let root = '';
let goodBatch = '';

before(async () => {
  server = await startServer();
  root = mkdtempSync(join(tmpdir(), 'frostecho-g07-engine-'));
  const result = await runG07Batch(batchOptions(server.url, root, 'g07-engine'));
  assert.equal(result.exitCode, 0);
  goodBatch = result.batchDir;
});

after(async () => {
  await server.close();
  rmSync(root, { recursive: true, force: true });
});

function episodePath(dir: string, episodeId: string): string {
  return join(dir, 'episodes', `${episodeId}.json`);
}

function readRecord(dir: string, episodeId: string): G07EpisodeRecord {
  return JSON.parse(readFileSync(episodePath(dir, episodeId), 'utf8')) as G07EpisodeRecord;
}

function writeRecord(dir: string, record: G07EpisodeRecord): void {
  writeFileSync(episodePath(dir, record.plan.episodeId), JSON.stringify(record, null, 2), 'utf8');
}

/** A private copy of the clean batch, so a tamper never touches the original. */
function copyBatch(label: string): string {
  const dir = join(mkdtempSync(join(tmpdir(), `frostecho-g07-${label}-`)), 'batch');
  cpSync(goodBatch, dir, { recursive: true });
  return dir;
}

/** Rewrites exactly one captured data line and keeps the recorded prompt hash consistent. */
function tamperLine(dir: string, episodeId: string, name: G07DataLineName, replacement: string): void {
  const record = readRecord(dir, episodeId);
  const exchange = record.http[0];
  assert.ok(exchange !== undefined, `${episodeId}: no captured HTTP exchange`);
  const messages = exchange.request.body.messages as { content?: string }[];
  const content = String(messages[0]?.content ?? '');
  const original = dataLine(content, name);
  assert.ok(original !== null, `${episodeId}: the prompt has no ${name} data line`);
  const tampered = content.replace(String(original), replacement);
  assert.notEqual(tampered, content, 'the tamper must change the prompt');
  messages[0] = { ...messages[0], content: tampered };
  // Keep the untouched hash claim honest: the template hash strips this line,
  // so only the data-line check can catch the change.
  record.prompt.sha256 = sha256(tampered);
  writeRecord(dir, record);
}

function tamperRecord(dir: string, episodeId: string, mutate: (record: G07EpisodeRecord) => void): void {
  const record = readRecord(dir, episodeId);
  mutate(record);
  writeRecord(dir, record);
}

const OBSERVATION_PREFIX = 'observation: ';

test('a clean fake batch verifies ok, and its captured data lines are the frozen ones', () => {
  const verified = verifyBatch(goodBatch);
  assert.deepEqual(verified.issues, []);
  assert.equal(verified.ok, true);
  assert.equal(verified.stats.mode, 'fake', 'this is a fake batch, not a live run');

  const batch = readBatch(goodBatch);
  assert.equal(batch.episodes.size, 8);
  const captures = promptCaptures(batch);
  assert.equal(captures.length, 8);
  assert.deepEqual(verifyPromptData(captures), []);

  for (const record of batch.episodes.values()) {
    const id = record.plan.episodeId;
    assert.equal(record.snapshot.mode, 'fixture', `${id}: a fake batch writes fixture snapshots`);
    const exchange = record.http[0];
    assert.ok(exchange !== undefined, `${id}: no captured prompt`);
    const messages = exchange.request.body.messages as { content?: string }[];
    const prompt = String(messages[0]?.content ?? '');
    const lines = promptDataLines(prompt);
    assert.deepEqual(JSON.parse(String(lines.observation).slice(OBSERVATION_PREFIX.length)), G07_EXPECTED_OBSERVATION);
    assert.equal(lines.goal, `goal: hunger >= ${G07_EXPECTED_GOAL_HUNGER}`);
    assert.equal(lines.feedback, G07_EXPECTED_FEEDBACK_LINE);
    assert.deepEqual(reexecuteCommands(record), [], `${id}: a clean record re-executes without a difference`);
  }

  // The three data lines are byte-identical across all eight prompts; the two
  // arms differ on exactly one line, the playerMessages line.
  for (const name of ['observation', 'goal', 'feedback'] as const) {
    assert.equal(new Set(captures.map(capture => dataLine(capture.prompt, name))).size, 1, `${name} must not vary`);
  }
  const off = captures.find(capture => capture.episodeId === 'g07-r1-s1-off');
  const on = captures.find(capture => capture.episodeId === 'g07-r1-s1-on');
  assert.ok(off !== undefined && on !== undefined);
  const offLines = off.prompt.split('\n');
  const onLines = on.prompt.split('\n');
  assert.equal(offLines.length, onLines.length);
  const differing = offLines.map((line, index) => (line === onLines[index] ? -1 : index)).filter(index => index >= 0);
  assert.equal(differing.length, 1, 'only one line may differ between the arms');
  assert.ok(offLines[differing[0] as number]?.startsWith('playerMessages:'), 'the differing line is playerMessages');

  // The re-execution path really submits: tampering one recorded result in
  // memory makes it report a difference.
  const witness = structuredClone([...batch.episodes.values()][0] as G07EpisodeRecord);
  assert.ok(witness.snapshot.commands.length > 0, 'the clean batch records at least one command');
  const entry = witness.snapshot.commands[0];
  assert.ok(entry !== undefined);
  entry.result.status = 'rejected';
  assert.ok(reexecuteCommands(witness).some(issue => issue.includes('re-executing command')),
    'a tampered result must be caught by the re-execution');
});

test('tampering one observation data line fails verify and names the line', () => {
  const dir = copyBatch('obs');
  try {
    tamperLine(dir, 'g07-r1-s1-off', 'observation',
      `observation: ${JSON.stringify({ ...G07_EXPECTED_OBSERVATION, hunger: 41 })}`);
    const verified = verifyBatch(dir);
    assert.equal(verified.ok, false);
    assert.ok(verified.issues.some(issue => issue.includes('g07-r1-s1-off') && issue.includes('observation')));
    assert.ok(verified.issues.some(issue => issue.includes('observation.hunger')),
      'the issue must name the tampered observation field');
    assert.equal(verified.issues.some(issue => issue.includes('template')), false,
      'the template hash cannot see the observation line');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tampering the goal data line fails verify and names the line', () => {
  const dir = copyBatch('goal');
  try {
    tamperLine(dir, 'g07-r2-s2-on', 'goal', 'goal: hunger >= 60');
    const verified = verifyBatch(dir);
    assert.equal(verified.ok, false);
    assert.ok(verified.issues.some(issue => issue.includes('g07-r2-s2-on') && issue.includes('goal.hungerAtLeast')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('tampering the feedback data line fails verify and names the line', () => {
  const dir = copyBatch('feedback');
  try {
    tamperLine(dir, 'g07-r1-s2-on', 'feedback', 'feedback: {"kind":"accepted"}');
    const verified = verifyBatch(dir);
    assert.equal(verified.ok, false);
    assert.ok(verified.issues.some(issue => issue.includes('g07-r1-s2-on') && issue.includes('feedback')));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a tampered command result fails the independent Engine re-execution', () => {
  const dir = copyBatch('command');
  try {
    tamperRecord(dir, 'g07-r1-s1-on', record => {
      const entry = record.snapshot.commands[0];
      assert.ok(entry !== undefined, 'the episode must record at least one command');
      assert.equal(entry.result.status, 'accepted');
      entry.result.status = 'rejected';
    });
    const verified = verifyBatch(dir);
    assert.equal(verified.ok, false);
    assert.ok(verified.issues.some(issue => issue.includes('g07-r1-s1-on')
      && issue.includes('re-executing command')
      && issue.includes('the ledger says rejected')),
    `expected a re-execution issue, got: ${verified.issues.join(' | ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the re-execution also covers an accepted eat and the rejected player eat', async () => {
  const eatServer = await startServer('{"type":"eat"}');
  const eatRoot = mkdtempSync(join(tmpdir(), 'frostecho-g07-eat-'));
  try {
    const result = await runG07Batch(batchOptions(eatServer.url, eatRoot, 'g07-engine-eat'));
    assert.equal(result.exitCode, 0);
    assert.equal(result.summary.mode, 'fake');
    const verified = verifyBatch(result.batchDir);
    assert.deepEqual(verified.issues, []);
    const batch = readBatch(result.batchDir);
    for (const record of batch.episodes.values()) {
      const statuses = record.snapshot.commands.map(entry => `${entry.command.actorId}:${entry.command.type}:${entry.result.status}`);
      assert.deepEqual(statuses, ['npc_a:eat:accepted', 'npc_b:eat:rejected'],
        `${record.plan.episodeId}: the ledger must hold an accepted npc eat and a rejected player eat`);
      assert.deepEqual(reexecuteCommands(record), [],
        `${record.plan.episodeId}: an accepted-plus-rejected ledger must re-execute identically`);
    }
  } finally {
    await eatServer.close();
    rmSync(eatRoot, { recursive: true, force: true });
  }
});

test('a tampered final state fails the independent Engine re-execution', () => {
  const dir = copyBatch('final');
  try {
    tamperRecord(dir, 'g07-r1-s2-off', record => {
      record.snapshot.finalState.npcs.npc_b.hunger += 1;
    });
    const verified = verifyBatch(dir);
    assert.equal(verified.ok, false);
    assert.ok(verified.issues.some(issue => issue.includes('g07-r1-s2-off')
      && issue.includes('re-executing the recorded commands produced a different final state')),
    `expected a re-execution issue, got: ${verified.issues.join(' | ')}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
