/**
 * A: phase-selected thinking at the application/provider boundary.
 *
 * Offline only: a random-port fake OpenAI server, a temp campaign ledger and
 * the REAL adapters/controller. What is pinned here:
 *   - goal -> thinking, action -> actionThinking (explicit false);
 *   - an absent override keeps every request body byte-identical (all true);
 *   - the saved slot carries the override and a restored runtime still uses
 *     action=false, including after a process-free reload;
 *   - an explicit load value that conflicts with the slot is refused before
 *     any provider exists: zero POST, original slot bytes untouched;
 *   - an invalid CLI value is a config error (exit 2), never a silent default.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createG10Runtime, loadG10Runtime, type G10Runtime } from '../src/application/adapters';
import { createApplicationController } from '../src/application/session';
import { parseInput } from '../src/application/commands';
import type { ApplicationController } from '../src/application/contracts';
import { loadCampaign } from '../src/eval/campaign-budget';

const PLAY = join(process.cwd(), 'dist/scripts/play-g10.js');
const MODEL = 'qwen3.8-27b';

interface FakeServer { url: string; posts: Record<string, any>[]; close(): Promise<void> }

async function fakeOpenAi(): Promise<FakeServer> {
  const posts: Record<string, any>[] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', chunk => chunks.push(chunk as Buffer));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (request.method === 'GET') {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ data: [{ id: MODEL }] }));
        return;
      }
      const body = JSON.parse(raw) as Record<string, any>;
      posts.push(body);
      const answer = raw.includes('feed_self') ? '{"goal":"yield_once"}'
        : raw.includes('yield_once') ? '{"type":"wait"}' : '{"type":"eat"}';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        choices: [{ index: 0, message: { role: 'assistant', content: answer }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
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

interface Built { runtime: G10Runtime; controller: ApplicationController; campaign: string }

function build(server: FakeServer, actionThinking?: boolean): Built {
  const base = mkdtempSync(join(tmpdir(), 'fe-action-provider-'));
  const campaign = join(base, 'campaign');
  const built = createG10Runtime({
    root: join(base, 'root'), slot: 'slot', goals: 'negotiated', candidates: 'choice', satiety: 40,
    fixture: null, live: true, http: server.url, model: MODEL, campaign, campaignLimit: 8,
    ...(actionThinking !== undefined ? { actionThinking } : {}),
  });
  assert.equal(built.ok, true, built.ok ? '' : (built.issues ?? []).join('; '));
  const runtime = built.value;
  const controller = createApplicationController({
    game: runtime.game, config: runtime.config, root: runtime.root, slot: runtime.slot, meta: runtime.meta, ports: runtime.ports,
  });
  return { runtime, controller, campaign };
}

const execute = async (controller: ApplicationController, line: string): Promise<ReturnType<ApplicationController['execute']>> => {
  const parsed = parseInput(line);
  assert.equal(parsed.ok, true, parsed.ok ? '' : parsed.message);
  return controller.execute(parsed.command);
};

const thinkingOf = (body: Record<string, any>): unknown => body.chat_template_kwargs?.enable_thinking;

test('goal keeps thinking on while the action phase is explicitly off', async () => {
  const server = await fakeOpenAi();
  try {
    const { runtime, controller, campaign } = build(server, false);
    assert.equal((await execute(controller, 'request npc_a yield_once')).ok, true);
    assert.equal((await execute(controller, 'run 1')).ok, true);
    assert.equal((await execute(controller, 'run 1')).ok, true);
    const wire = runtime.wire();
    assert.equal(wire.length, 2, 'one goal call and one action call');
    assert.equal(thinkingOf(wire[0]!.requestBody as Record<string, any>), true, 'goal must keep thinking on');
    assert.equal(thinkingOf(wire[1]!.requestBody as Record<string, any>), false, 'action must be off');
    assert.equal(loadCampaign(campaign).spent, 2, 'exactly one budget unit per phase');
    assert.deepEqual(runtime.game.snapshot().requestConfig.enableThinking, [true, false], 'the record lists both actual values');

    const saved = await execute(controller, 'save aud-off');
    assert.equal(saved.ok, true);
    const slotPath = controller.view().savedPath;
    assert.notEqual(slotPath, null);
    const before = readFileSync(slotPath!);
    assert.match(before.toString('utf8'), /"actionThinking": false/);

    const loaded = loadG10Runtime(slotPath!, {
      live: true, model: MODEL, fixture: null, http: server.url, campaign, campaignLimit: null,
    });
    assert.equal(loaded.ok, true, loaded.ok ? '' : (loaded.issues ?? []).join('; '));
    assert.equal(loaded.value.config.actionThinking, false, 'restore adopts the saved action value');
    assert.equal((loaded.value.game as unknown as { actionThinking?: boolean }).actionThinking, false);

    const posts = server.posts.length;
    const conflict = loadG10Runtime(slotPath!, {
      live: true, model: MODEL, fixture: null, http: server.url, campaign, campaignLimit: null, actionThinking: true,
    });
    assert.equal(conflict.ok, false, 'an explicit value that contradicts the slot must be refused');
    assert.match((conflict.ok ? [] : conflict.issues ?? []).join('; '), /action-thinking conflict/);
    assert.equal(server.posts.length, posts, 'zero POST on the refusal');
    assert.equal(readFileSync(slotPath!).equals(before), true, 'the original slot bytes are untouched');

    const same = loadG10Runtime(slotPath!, {
      live: true, model: MODEL, fixture: null, http: server.url, campaign, campaignLimit: null, actionThinking: false,
    });
    assert.equal(same.ok, true, 'the same explicit value is accepted');
  } finally {
    await server.close();
  }
});

test('without the flag every request keeps the historical all-on body', async () => {
  const server = await fakeOpenAi();
  try {
    const { runtime, controller } = build(server);
    assert.equal((await execute(controller, 'request npc_a yield_once')).ok, true);
    assert.equal((await execute(controller, 'run 1')).ok, true);
    assert.equal((await execute(controller, 'run 1')).ok, true);
    const wire = runtime.wire();
    assert.equal(wire.length, 2);
    assert.deepEqual(wire.map(entry => thinkingOf(entry.requestBody as Record<string, any>)), [true, true]);
    assert.equal('actionThinking' in runtime.config, false, 'the override is not serialized when absent');
    const saved = await execute(controller, 'save aud-old');
    assert.equal(saved.ok, true);
    const bytes = readFileSync(controller.view().savedPath!).toString('utf8');
    assert.equal(bytes.includes('actionThinking'), false, 'old slot key set stays byte-identical');
  } finally {
    await server.close();
  }
});

test('an invalid --action-thinking value is a config error, not a silent default', async () => {
  const run = await new Promise<{ code: number | null; stderr: string }>(resolve => {
    const child = spawn(process.execPath, [PLAY, '--action-thinking', 'maybe'], { cwd: process.cwd() });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => resolve({ code, stderr }));
  });
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--action-thinking must be on\|off/);
});
