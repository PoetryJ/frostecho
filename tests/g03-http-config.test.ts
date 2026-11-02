/**
 * G03-R1 regression (D) — the live path really goes through HTTP and every
 * request carries the thinking flag of *its own* episode.
 *
 * A local HTTP server plays the reference policy (so the 12 episodes are
 * deterministic), while health, transport recording, verification and the
 * batch report run exactly as in production. The old bug passed 44 requests
 * with the environment default (all thinking=true); the fixed path must send
 * 22 with false and 22 with true, and verification must reject a record whose
 * thinking flag contradicts its own request bodies.
 */
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { referenceDecision } from '../src/agent/providers/reference';
import { sourceFingerprint } from '../src/eval/store';
import { runG03Batch, verifyG03Batch } from '../src/multi/eval';
import { verifyMultiEpisode } from '../src/multi/record';

const MODEL = 'qwen3.8-27b';

interface Recorded {
  body: Record<string, unknown>;
  prompt: string;
  thinking: unknown;
}

function readPromptField(prompt: string, field: string): unknown {
  const match = new RegExp(`^${field}: (.*)$`, 'm').exec(prompt);
  assert.ok(match, `prompt is missing ${field}`);
  return JSON.parse(match[1]);
}

/** Serve /v1/models + /v1/chat/completions, answering with the reference policy. */
async function startServer(recorded: Recorded[]): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: MODEL }] }));
      return;
    }
    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        const messages = body.messages as { content: string }[];
        const prompt = messages[0].content;
        recorded.push({ body, prompt, thinking: (body.chat_template_kwargs as { enable_thinking?: unknown }).enable_thinking });
        const observation = readPromptField(prompt, 'observation');
        const feedback = readPromptField(prompt, 'feedback');
        const text = referenceDecision({ observation, goal: { hungerAtLeast: 70 }, feedback } as never);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          id: 'chatcmpl-test',
          object: 'chat.completion',
          model: MODEL,
          choices: [{ index: 0, message: { role: 'assistant', content: text }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
        }));
      });
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'not found' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number };
  return { server, url: `http://127.0.0.1:${address.port}/v1/chat/completions` };
}

test('live batch: 44 HTTP requests, per-episode thinking honoured, evidence verifies', async () => {
  const recorded: Recorded[] = [];
  const { server, url } = await startServer(recorded);
  const root = mkdtempSync(join(tmpdir(), 'g03-http-'));
  const previous = { url: process.env.FROSTECHO_LLM_URL, model: process.env.FROSTECHO_LLM_MODEL };
  process.env.FROSTECHO_LLM_URL = url;
  process.env.FROSTECHO_LLM_MODEL = MODEL;
  try {
    const result = await runG03Batch({ artifactsRoot: root, batch: 'r1-http', mode: 'live' });
    assert.equal(result.exitCode, 0, result.message);

    // 22 thinking=false + 22 thinking=true: nothing follows the process default.
    const off = recorded.filter(r => r.thinking === false).length;
    const on = recorded.filter(r => r.thinking === true).length;
    assert.equal(recorded.length, 44, `expected 44 requests, got ${recorded.length}`);
    assert.equal(off, 22, `expected 22 thinking=false requests, got ${off}`);
    assert.equal(on, 22, `expected 22 thinking=true requests, got ${on}`);

    // Every body names the configured model and the declared sampling profile.
    for (const request of recorded) {
      assert.equal(request.body.model, MODEL);
      assert.equal(request.body.stream, false);
    }

    // Rendered prompts are the frozen ones.
    assert.ok(recorded.every(r => r.prompt.includes('Reply with one JSON object and no other text.')));

    // Verification cross-checks thinking per request and finds no contradiction.
    for (const scenario of ['m1', 'm2', 'm3']) {
      for (const order of ['ac', 'ca']) {
        for (const state of ['off', 'on']) {
          const dir = join(root, 'r1-http', 'episodes', `${scenario}-${order}-${state}`);
          const verification = verifyMultiEpisode(dir);
          assert.equal(verification.ok, true, `${scenario}-${order}-${state}: ${verification.issues.join('; ')}`);
        }
      }
    }

    // batch.json keeps the version and preflight through every status rewrite.
    const batch = JSON.parse(readFileSync(join(root, 'r1-http', 'batch.json'), 'utf8'));
    assert.equal(batch.status, 'finished');
    assert.equal(batch.version.sourceFingerprint, sourceFingerprint(process.cwd()));
    assert.equal(batch.health.modelsUrlPath, '/v1/models');
    assert.equal(batch.health.modelMatch, true);
    assert.deepEqual(batch.thinkingPlan, [false, true]);
    assert.equal(verifyG03Batch(join(root, 'r1-http')).exitCode, 0);
  } finally {
    server.close();
    if (previous.url === undefined) delete process.env.FROSTECHO_LLM_URL; else process.env.FROSTECHO_LLM_URL = previous.url;
    if (previous.model === undefined) delete process.env.FROSTECHO_LLM_MODEL; else process.env.FROSTECHO_LLM_MODEL = previous.model;
    rmSync(root, { recursive: true, force: true });
  }
});

test('verification rejects a record whose thinking flag contradicts its request bodies', async () => {
  const recorded: Recorded[] = [];
  const { server, url } = await startServer(recorded);
  const root = mkdtempSync(join(tmpdir(), 'g03-http-tamper-'));
  const previous = { url: process.env.FROSTECHO_LLM_URL, model: process.env.FROSTECHO_LLM_MODEL };
  process.env.FROSTECHO_LLM_URL = url;
  process.env.FROSTECHO_LLM_MODEL = MODEL;
  try {
    const result = await runG03Batch({ artifactsRoot: root, batch: 'tamper', mode: 'live', order: 'ac' });
    assert.equal(result.exitCode, 0, result.message);
    const dir = join(root, 'tamper', 'episodes', 'm1-ac-off');
    const file = join(dir, 'game.json');
    const record = JSON.parse(readFileSync(file, 'utf8'));
    assert.equal(record.thinking, false);
    record.thinking = true; // claim the episode ran with thinking on
    writeFileSync(file, JSON.stringify(record, null, 2) + '\n');
    const verification = verifyMultiEpisode(dir);
    assert.equal(verification.ok, false);
    assert.ok(
      verification.issues.some(issue => issue.includes('enable_thinking=false') && issue.includes('thinking=true')),
      verification.issues.join('; '),
    );
  } finally {
    server.close();
    if (previous.url === undefined) delete process.env.FROSTECHO_LLM_URL; else process.env.FROSTECHO_LLM_URL = previous.url;
    if (previous.model === undefined) delete process.env.FROSTECHO_LLM_MODEL; else process.env.FROSTECHO_LLM_MODEL = previous.model;
    rmSync(root, { recursive: true, force: true });
  }
});
