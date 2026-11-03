/**
 * G08 worker D — independent tests for the timed-wait experiment.
 *
 * These tests do not import the implementation's own success counters. They
 * watch the world, the provider, the captured HTTP bodies and the files on
 * disk: the frozen 4-cell matrix, the capability axis in the real prompt
 * (allowedActions / wait line), strict wait parsing, the wait acceptance +
 * deadline evidence, the shared template across all four arms, one chat
 * request per completed episode, and failure/budget stops that leave the
 * remaining slots not_run without overwriting or retrying anything.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderDecidePrompt } from '../src/agent/providers/http';
import type { DecideInput } from '../src/agent/contracts';
import { runG08Batch, type G08RunOptions } from '../scripts/eval-g08';
import {
  G08_PLAN, G08_SCENARIO_TEXT, G08_ALLOWED_BY_ACTION_SET, G08_WAIT_LINE,
  allowedActionsLine, hasWaitLine, promptIssuesFor, strictG08Action, stripG08PromptData,
  verifyG08Batch,
} from '../scripts/g08-eval-lib';
import { sha256 } from '../scripts/g07-eval-lib';

const SAMPLE_INPUT: DecideInput = {
  observation: { id: 'npc_a', location: 'kitchen', hunger: 40, foodHere: 1, reachable: ['dorm', 'kitchen'] },
  goal: { hungerAtLeast: 70 },
  feedback: null,
};

function promptWith(axis: { actionSet: 'legacy' | 'timed_wait'; playerMessages: boolean }): string {
  return renderDecidePrompt({
    ...SAMPLE_INPUT,
    allowedActions: axis.actionSet,
    ...(axis.playerMessages ? { playerMessages: [{ sender: 'npc_b', text: G08_SCENARIO_TEXT }] } : {}),
  });
}

interface FakeServer {
  url: string;
  requests: Record<string, unknown>[];
  close(): Promise<void>;
}

async function startServer(options: { failAt?: number; content?: string; model?: string; perAxis?: boolean } = {}): Promise<FakeServer> {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    if (req.method === 'GET') {
      if (req.url === '/health') {
        res.statusCode = 200;
        res.end('ok');
        return;
      }
      if (req.url === '/v1/models') {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: options.model ?? 'fake-model' }] }));
        return;
      }
      res.statusCode = 404;
      res.end('no');
      return;
    }
    let raw = '';
    req.on('data', (chunk: Buffer) => { raw += chunk.toString('utf8'); });
    req.on('end', () => {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      requests.push(parsed);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      if (options.failAt !== undefined && requests.length === options.failAt) {
        res.statusCode = 500;
        res.end('{"error":"boom"}');
        return;
      }
      let content = options.content ?? '{"type":"wait"}';
      if (options.perAxis === true) {
        // Answer within the arm's own action set: legacy cannot wait.
        const body = parsed as { messages?: { content?: string }[] };
        const prompt = String(body.messages?.[0]?.content ?? '');
        content = prompt.includes('"wait"') && prompt.includes('allowedActions: ["move","eat","stop","wait"]')
          ? '{"type":"wait"}'
          : '{"type":"eat"}';
      }
      res.end(JSON.stringify({
        choices: [{ message: { content } }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
      }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close(err => (err ? reject(err) : resolve()))),
  };
}

function batchOptions(url: string, out: string, batchId: string, extra: Partial<G08RunOptions> = {}): G08RunOptions {
  return {
    out,
    batchId,
    url,
    model: 'fake-model',
    fetchImpl: (input, init) => fetch(input, init),
    mode: 'fake',
    ...extra,
  };
}

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-g08-eval-'));
}

function promptOfEpisode(root: string, batchId: string, episodeId: string): string {
  const body = JSON.parse(readFileSync(join(root, batchId, 'episodes', `${episodeId}.json`), 'utf8')) as {
    http: { request: { body: { messages?: { content?: string }[] } } }[];
  };
  return String(body.http[0]?.request.body.messages?.[0]?.content ?? '');
}

test('the plan is frozen: rep1 forward, rep2 the exact reverse, 4 balanced cells', () => {
  assert.equal(G08_PLAN.length, 8);
  assert.deepEqual(G08_PLAN.map(entry => `${entry.actionSet}-${entry.arm}-r${entry.rep}`), [
    'legacy-off-r1', 'legacy-on-r1', 'timed_wait-off-r1', 'timed_wait-on-r1',
    'timed_wait-on-r2', 'timed_wait-off-r2', 'legacy-on-r2', 'legacy-off-r2',
  ]);
  assert.deepEqual(G08_PLAN.map(entry => entry.episodeId), [
    'g08-r1-legacy-off', 'g08-r1-legacy-on', 'g08-r1-timed_wait-off', 'g08-r1-timed_wait-on',
    'g08-r2-timed_wait-on', 'g08-r2-timed_wait-off', 'g08-r2-legacy-on', 'g08-r2-legacy-off',
  ]);
  for (const actionSet of ['legacy', 'timed_wait'] as const) {
    for (const arm of ['off', 'on'] as const) {
      assert.equal(G08_PLAN.filter(entry => entry.actionSet === actionSet && entry.arm === arm).length, 2);
    }
  }
  for (let i = 0; i < G08_PLAN.length; i += 1) assert.equal(G08_PLAN[i].index, i + 1);
});

test('the capability axis is visible in allowedActions; the wait rule is shared (G08-R1 C2)', () => {
  const legacy = promptWith({ actionSet: 'legacy', playerMessages: false });
  const timed = promptWith({ actionSet: 'timed_wait', playerMessages: false });
  assert.equal(allowedActionsLine(legacy), `allowedActions: ${G08_ALLOWED_BY_ACTION_SET.legacy}`);
  assert.equal(allowedActionsLine(timed), `allowedActions: ${G08_ALLOWED_BY_ACTION_SET.timed_wait}`);
  // The wait rule is part of the ONE skeleton on both arms — the capability
  // difference lives in the allowedActions data line only.
  assert.equal(hasWaitLine(legacy), true);
  assert.equal(hasWaitLine(timed), true);
  assert.ok(legacy.includes('only when allowedActions includes "wait"'));
});

test('all four arms share one template once the axis data lines are stripped', () => {
  const prompts = [
    promptWith({ actionSet: 'legacy', playerMessages: false }),
    promptWith({ actionSet: 'legacy', playerMessages: true }),
    promptWith({ actionSet: 'timed_wait', playerMessages: false }),
    promptWith({ actionSet: 'timed_wait', playerMessages: true }),
  ];
  const stripped = prompts.map(p => stripG08PromptData(p));
  for (let i = 1; i < stripped.length; i += 1) assert.equal(stripped[i], stripped[0]);
  assert.equal(new Set(prompts.map(p => sha256(p))).size, 4);
});

test('promptIssuesFor catches a wrong axis, a missing wait line and a leaked playerMessages line', () => {
  const legacy = promptWith({ actionSet: 'legacy', playerMessages: false });
  const legacyOn = promptWith({ actionSet: 'legacy', playerMessages: true });
  const timed = promptWith({ actionSet: 'timed_wait', playerMessages: false });
  const timedOn = promptWith({ actionSet: 'timed_wait', playerMessages: true });
  assert.deepEqual(promptIssuesFor(G08_PLAN[0], legacy), []);
  assert.deepEqual(promptIssuesFor(G08_PLAN[1], legacyOn), []);
  assert.deepEqual(promptIssuesFor(G08_PLAN[2], timed), []);
  assert.deepEqual(promptIssuesFor(G08_PLAN[3], timedOn), []);
  assert.ok(promptIssuesFor(G08_PLAN[0], legacyOn).some(i => i.includes('messages-off')));
  assert.ok(promptIssuesFor(G08_PLAN[1], legacy).some(i => i.includes('messages-on')));
  assert.ok(promptIssuesFor(G08_PLAN[0], timed).some(i => i.includes('legacy axis')));
  // A skeleton without the shared wait rule is rejected on either arm.
  const missingWait = legacy.split('\n').filter(line => line !== G08_WAIT_LINE).join('\n');
  assert.ok(promptIssuesFor(G08_PLAN[2], missingWait).includes('the shared G08 template must carry the wait rule'));
  assert.deepEqual(promptIssuesFor(G08_PLAN[0], null), ['no prompt text was captured']);
});

test('strictG08Action accepts wait only as the exact one-key object', () => {
  assert.deepEqual(strictG08Action('{"type":"wait"}'), { type: 'wait' });
  assert.equal(strictG08Action('{"type":"wait","to":"kitchen"}'), 'invalid_output');
  assert.equal(strictG08Action('{"type":"wait","hungerAtLeast":70}'), 'invalid_output');
  assert.equal(strictG08Action('{"type":"fly"}'), 'invalid_output');
  assert.equal(strictG08Action('not json'), 'invalid_output');
  assert.equal(strictG08Action('[]'), 'invalid_output');
  assert.equal(strictG08Action('"wait"'), 'invalid_output');
  assert.equal(strictG08Action(null), null);
  assert.deepEqual(strictG08Action('{"type":"eat"}'), { type: 'eat' });
  assert.deepEqual(strictG08Action('{"type":"move","to":"kitchen"}'), { type: 'move', to: 'kitchen' });
  assert.equal(strictG08Action('{"type":"move","to":"mars"}'), 'invalid_output');
  assert.equal(strictG08Action('{"type":"move"}'), 'invalid_output');
  assert.equal(strictG08Action('{"type":"eat","to":"kitchen"}'), 'invalid_output');
});

test('a legal per-axis batch: timed_wait accepts wait with deadline 1, legacy eats first', async () => {
  const root = tempRoot();
  const server = await startServer({ perAxis: true });
  try {
    const result = await runG08Batch(batchOptions(server.url, root, 'b1'));
    assert.equal(result.verify.stats.completed, 8);
    assert.equal(result.verify.ok, true);
    assert.equal(server.requests.length, 8);
    assert.equal(result.verify.stats.chatRequests, 8);
    const byId = new Map(result.verify.stats.cells.map(c => [c.episodeId, c]));
    for (const entry of G08_PLAN) {
      const cell = byId.get(entry.episodeId);
      assert.ok(cell !== undefined);
      if (entry.actionSet === 'timed_wait') {
        // The runner accepted the wait and froze the deadline at simTime 0 + 1.
        assert.equal(cell.waitAccepted, true, entry.episodeId);
        assert.equal(cell.wakeAtSimTime, 1, entry.episodeId);
        assert.equal(cell.npcAte, false, entry.episodeId);
        assert.equal(cell.playerAte, true, entry.episodeId);
      } else {
        // The legacy axis answered eat (its only sensible action here).
        assert.equal(cell.waitAccepted, false, entry.episodeId);
        assert.equal(cell.npcAte, true, entry.episodeId);
        assert.equal(cell.playerAte, false, entry.episodeId);
      }
      assert.equal(cell.totalTokens, 12, entry.episodeId);
    }
    // Disk evidence: one episode file per slot, one status file per slot.
    assert.equal(readdirSync(join(root, 'b1', 'episodes')).length, 8);
    assert.equal(readdirSync(join(root, 'b1', 'status')).length, 8);
    assert.equal(readdirSync(join(root, 'b1', 'attempts')).filter(n => n.endsWith('.begin.json')).length, 8);
    // The prompt axis travelled into every real request body.
    const legacyContent = promptOfEpisode(root, 'b1', 'g08-r1-legacy-off');
    const timedContent = promptOfEpisode(root, 'b1', 'g08-r1-timed_wait-on');
    assert.ok(legacyContent.includes('allowedActions: ["move","eat","stop"]'));
    assert.ok(legacyContent.includes('only when allowedActions includes "wait"'));
    assert.ok(timedContent.includes('allowedActions: ["move","eat","stop","wait"]'));
    assert.ok(timedContent.includes('"wait" pauses your current session'));
    // And the message arm carried the frozen S1 into the real request.
    assert.ok(timedContent.includes(G08_SCENARIO_TEXT));
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an illegal legacy wait fails the experiment fast (G08-R1 C1)', async () => {
  const root = tempRoot();
  const server = await startServer({ content: '{"type":"wait"}' });
  try {
    const result = await runG08Batch(batchOptions(server.url, root, 'b0'));
    // The very first legacy episode is invalid output: no player action, no
    // second decision, no retry — the remaining seven slots stay not_run.
    assert.equal(server.requests.length, 1);
    assert.equal(result.verify.stats.completed, 0);
    assert.equal(result.verify.stats.failed, 1);
    assert.equal(result.verify.stats.notRun, 7);
    assert.notEqual(result.exitCode, 0);
    const first = result.verify.stats.cells.find(c => c.episodeId === 'g08-r1-legacy-off');
    assert.ok(first !== undefined);
    assert.equal(first.outcome, 'invalid_output');
    // The episode record proves the player action never ran.
    const episode = JSON.parse(readFileSync(join(root, 'b0', 'episodes', 'g08-r1-legacy-off.json'), 'utf8')) as {
      outcome: string;
      behavior: unknown;
    };
    assert.equal(episode.outcome, 'invalid_output');
    assert.equal(episode.behavior, null);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('an eat-responder batch: the NPC eats first and the player attempt is rejected', async () => {
  const root = tempRoot();
  const server = await startServer({ content: '{"type":"eat"}' });
  try {
    const result = await runG08Batch(batchOptions(server.url, root, 'b2'));
    assert.equal(result.verify.stats.completed, 8);
    assert.equal(result.verify.ok, true);
    for (const cell of result.verify.stats.cells) {
      assert.equal(cell.npcAction, 'eat');
      assert.equal(cell.npcAte, true);
      assert.equal(cell.playerAte, false);
      assert.equal(cell.waitAccepted, false);
    }
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a transport failure stops the batch: no retry, the rest stay not_run, verify reports it', async () => {
  const root = tempRoot();
  const server = await startServer({ content: '{"type":"stop"}', failAt: 3 });
  try {
    const result = await runG08Batch(batchOptions(server.url, root, 'b3'));
    assert.equal(server.requests.length, 3);
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.verify.stats.completed, 2);
    assert.equal(result.verify.stats.failed, 1);
    assert.equal(result.verify.stats.notRun, 5);
    const third = result.verify.stats.cells.find(c => c.episodeId === 'g08-r1-timed_wait-off');
    assert.ok(third !== undefined);
    assert.equal(third.outcome, 'transport_failure');
    const statuses = readdirSync(join(root, 'b3', 'status'));
    const notRun = statuses.filter(name => {
      const body = JSON.parse(readFileSync(join(root, 'b3', 'status', name), 'utf8')) as { status: string };
      return body.status === 'not_run';
    });
    assert.equal(notRun.length, 5);
    // verify.ok is evidence correctness, not completeness: the failure itself
    // is reported through stats/exitCode, and its evidence must still be true.
    assert.equal(result.verify.ok, true);
    assert.equal(result.verify.stats.failed, 1);
    assert.notEqual(result.exitCode, 0);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('the hard budget stops the batch mid-matrix and the blocked attempts are recorded', async () => {
  const root = tempRoot();
  const server = await startServer({ content: '{"type":"stop"}' });
  try {
    const result = await runG08Batch({ ...batchOptions(server.url, root, 'b4'), limit: 2 });
    assert.equal(result.verify.stats.completed, 2);
    const third = result.verify.stats.cells.find(c => c.episodeId === 'g08-r1-timed_wait-off');
    assert.ok(third !== undefined);
    assert.equal(third.outcome, 'budget_blocked');
    assert.equal(result.verify.stats.notRun, 5);
    const blocked = readdirSync(join(root, 'b4', 'attempts')).filter(n => n.startsWith('blocked-'));
    assert.ok(blocked.length >= 1);
    assert.notEqual(result.exitCode, 0);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('verifyG08Batch re-reads a finished batch from disk and stays read-only', async () => {
  const root = tempRoot();
  const server = await startServer({ content: '{"type":"wait"}' });
  try {
    await runG08Batch(batchOptions(server.url, root, 'b5'));
    const dir = join(root, 'b5');
    const before = dirFingerprint(dir);
    const first = verifyG08Batch(dir);
    const second = verifyG08Batch(dir);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(second.stats.cells, first.stats.cells);
    assert.equal(dirFingerprint(dir), before);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function dirFingerprint(dir: string): string {
  const parts: string[] = [];
  const walk = (current: string, prefix: string): void => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      if (statSync(path).isDirectory()) walk(path, `${prefix}${name}/`);
      else parts.push(`${prefix}${name}\0${readFileSync(path, 'utf8')}`);
    }
  };
  walk(dir, '');
  return sha256(parts.join('\n'));
}
