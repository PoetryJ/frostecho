/**
 * G11-live — the externalBudget wiring through the REAL fresh/load entries.
 *
 * The reactive layer had the callback for a while (tests/g11-needs-resume);
 * these locks prove the APPLICATION layer actually injects it:
 *
 *   1. fresh entry (play-g10 --live): an exhausted campaign stops the
 *      continuation after the deadline settle with ZERO extra posts
 *   2. restore chain: GameRestoreRuntime.externalBudget SURVIVES
 *      loadG09Checkpoint -> restoreG09Game -> restoreNeedsGame -> createNeedsGame
 *   3. load entry: a ledger that becomes unreadable fails CLOSED (no cycle,
 *      zero posts) — a broken counter never buys a free continuation
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createG10Runtime, loadG10Runtime, type G10Runtime } from '../src/application/adapters';
import { createApplicationController } from '../src/application/session';
import { loadG09Checkpoint, restoreG09Game } from '../src/negotiation/checkpoint';
import type { Provider } from '../src/agent/contracts';

const PLAY = join(process.cwd(), 'dist/scripts/play-g10.js');

async function fakeOpenAi(): Promise<{ url: string; posts: string[]; close(): Promise<void> }> {
  const posts: string[] = [];
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
      const answer = body.includes('feed_self')
        ? '{"goal":"yield_once"}'
        : body.includes('yield_once')
          ? '{"type":"wait"}'
          : '{"type":"eat"}';
      posts.push(body);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        id: `chatcmpl-wire-${posts.length}`, object: 'chat.completion', created: 1, model: 'qwen3.8-27b',
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

function runPlay(args: string[], stdin: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [PLAY, ...args], { cwd: process.cwd() });
    let stdout = '';
    let stderr = '';
    child.stdin.write(stdin);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    const kill = setTimeout(() => child.kill('SIGKILL'), 120_000);
    child.on('close', code => { clearTimeout(kill); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}

test('fresh entry: an exhausted campaign blocks the continuation with ZERO posts (app wiring, not a hand-injected unit)', async () => {
  const server = await fakeOpenAi();
  try {
    const base = mkdtempSync(join(tmpdir(), 'fe-g11-fresh-'));
    const root = join(base, 'root');
    const campaign = join(base, 'campaign');
    const played = await runPlay([
      '--goals', 'negotiated', '--candidates', 'choice', '--satiety', '40',
      '--live', '--http', server.url, '--model', 'qwen3.8-27b',
      '--campaign', campaign, '--campaign-limit', '2', '--root', root, '--slot', 'exhaust',
    ], 'request npc_a yield_once\nrun 1\nrun 1\nworld time 1\nrun 1\nquit\n');
    assert.equal(played.code, 0, `play-g10 exited ${String(played.code)}: ${played.stderr.slice(-300)}`);
    // The campaign (limit 2) funded exactly goal + wait; the expired settle's
    // continuation consults the ledger via the REAL app path and stops.
    assert.equal(server.posts.length, 2, 'no third post after the campaign is exhausted');
    const ledger = JSON.parse(readFileSync(join(campaign, 'campaign.json'), 'utf8')) as { limit: number; spent: number };
    assert.equal(ledger.limit, 2);
    assert.equal(ledger.spent, 2);
    assert.match(played.stdout, /空闲/, 'the dead run 1 is refused as IDLE, not retried');
    const record = readdirSync(root).find(name => name.endsWith('.run.json'));
    assert.ok(record !== undefined, 'the run record exists');
    const payload = JSON.parse(readFileSync(join(root, record), 'utf8')) as { payload: { authoritative: { snapshot: { actors: Record<string, { state: string; cycles: number; providerCalls: number }> } } } };
    const npcA = payload.payload.authoritative.snapshot.actors['npc_a']!;
    assert.equal(npcA.state, 'stopped', 'the gate stops the actor instead of opening an unfunded cycle');
    assert.equal(npcA.cycles, 1, 'NO continuation cycle is opened (the negotiated goal+wait is ONE cycle)');
    assert.equal(npcA.providerCalls, 2);
  } finally {
    await server.close();
  }
});

test('the restore chain preserves GameRestoreRuntime.externalBudget (false stops, true continues)', async () => {
  // Build a pre-close slot offline: request accepted, npc_a in a timed wait.
  const base = mkdtempSync(join(tmpdir(), 'fe-g11-restore-'));
  const built = createG10Runtime({
    root: join(base, 'r'), slot: 'chain-wait', goals: 'negotiated', candidates: 'choice', satiety: 40,
    fixture: 'w1', live: false, http: '', model: null, campaign: null, campaignLimit: null,
  });
  assert.equal(built.ok, true);
  const runtime: G10Runtime = built.value;
  const controller = createApplicationController({
    game: runtime.game, config: runtime.config, root: runtime.root, slot: runtime.slot,
    meta: runtime.meta, ports: runtime.ports,
  });
  await controller.execute({ kind: 'request', actorId: 'npc_a', goal: 'yield_once' });
  await controller.execute({ kind: 'run', steps: 1 });
  await controller.execute({ kind: 'run', steps: 1 });
  const saved = await controller.execute({ kind: 'save', slot: 'chain-wait' });
  assert.equal(saved.ok, true);
  const slotPath = controller.view().savedPath!;

  const restoreWith = async (externalBudget: (() => boolean) | undefined): Promise<{ calls: number; state: string; cycles: number }> => {
    const calls: string[] = [];
    const provider: Provider = {
      async decide(input: { goalChoice?: unknown; activeGoal?: { kind?: string } }) {
        calls.push(input.goalChoice !== undefined ? 'goal' : input.activeGoal?.kind === 'yield_once' ? 'wait' : 'action');
        return input.goalChoice !== undefined ? '{"goal":"yield_once"}' : (input.activeGoal?.kind === 'yield_once' ? '{"type":"wait"}' : '{"type":"eat"}');
      },
    };
    const read = loadG09Checkpoint(slotPath);
    assert.equal(read.ok, true);
    const restored = restoreG09Game(read.value, {
      providerFor: () => provider,
      now: () => 0,
      playerId: 'npc_b',
      ...(externalBudget !== undefined ? { externalBudget } : {}),
    });
    assert.equal(restored.ok, true, 'restore refused');
    const game = restored.value.game;
    game.worldAdvanceTime(1); // deadline: the settle consults the callback
    let outcome = await game.advance();
    for (let index = 0; index < 3 && outcome.kind === 'idle' && calls.length === 0; index += 1) {
      outcome = await game.advance();
    }
    return { calls: calls.length, state: game.actorStateOf('npc_a'), cycles: game.cyclesOf('npc_a') };
  };

  const blocked = await restoreWith(() => false);
  assert.equal(blocked.calls, 0, 'externalBudget=false must reach the restored game: zero calls');
  assert.equal(blocked.state, 'stopped');
  assert.equal(blocked.cycles, 1, 'no continuation cycle (the negotiated goal+wait is ONE cycle)');

  const allowed = await restoreWith(() => true);
  assert.ok(allowed.calls >= 1, 'externalBudget=true lets the continuation run');
  assert.ok(allowed.cycles >= 2, 'a continuation cycle opens');
});

test('load entry: an unreadable ledger fails CLOSED — no cycle, zero posts', async () => {
  const server = await fakeOpenAi();
  try {
    const base = mkdtempSync(join(tmpdir(), 'fe-g11-closed-'));
    const root = join(base, 'root');
    const campaign = join(base, 'campaign');
    const built = createG10Runtime({
      root, slot: 'fc-wait', goals: 'negotiated', candidates: 'choice', satiety: 40,
      fixture: null, live: true, http: server.url, model: 'qwen3.8-27b',
      campaign, campaignLimit: 2,
    });
    assert.equal(built.ok, true);
    const fresh: G10Runtime = built.value;
    const controller = createApplicationController({
      game: fresh.game, config: fresh.config, root: fresh.root, slot: fresh.slot,
      meta: fresh.meta, ports: fresh.ports,
    });
    await controller.execute({ kind: 'request', actorId: 'npc_a', goal: 'yield_once' });
    await controller.execute({ kind: 'run', steps: 1 });
    await controller.execute({ kind: 'run', steps: 1 });
    const saved = await controller.execute({ kind: 'save', slot: 'fc-wait' });
    assert.equal(saved.ok, true);
    assert.equal(server.posts.length, 2, 'goal + wait funded, campaign exhausted');

    // Load through the REAL load entry (binding validated against the ledger),
    // THEN break the ledger so the gate's NEXT read fails: it must fail closed.
    const loaded = loadG10Runtime(controller.view().savedPath!, {
      live: true, model: 'qwen3.8-27b', fixture: null,
      http: server.url, campaign, campaignLimit: null,
    });
    assert.equal(loaded.ok, true, 'load refused');
    const resumed = createApplicationController({
      game: loaded.value.game, config: loaded.value.config, root: loaded.value.root, slot: loaded.value.slot,
      meta: loaded.value.meta, ports: loaded.value.ports,
    });
    assert.ok(existsSync(join(campaign, 'campaign.json')));
    writeFileSync(join(campaign, 'campaign.json'), 'not-json{{');
    await resumed.execute({ kind: 'world_time', steps: 1 }); // settle: gate read throws
    const dead = await resumed.execute({ kind: 'run', steps: 1 });
    assert.equal(dead.ok, false);
    assert.match(`${dead.code} ${dead.detail ?? ''}`, /IDLE|空闲/, 'refused idle, not a free continuation');
    assert.equal(server.posts.length, 2, 'a failed ledger read never buys a provider call');
    const view = resumed.view();
    const npcA = view.npcs.find(npc => npc.actorId === 'npc_a')!;
    assert.equal(npcA.status, 'stopped');
  } finally {
    await server.close();
  }
});
