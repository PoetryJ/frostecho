/**
 * G10 worker D — independent acceptance for the continuous kitchen.
 *
 * Real stdin child processes for the three demos, real cross-process save /
 * load, a real loopback socket for the HTTP path, and full semantic snapshots
 * for the continuous-vs-resumed comparison. Expectations come from CASES.txt,
 * never from the implementation under test.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseInput } from '../src/application/commands';
import { createApplicationController, emptyPorts } from '../src/application/session';
import { createG10Runtime, type G10Runtime } from '../src/application/adapters';
import type { ApplicationController, AppView } from '../src/application/contracts';
import { buildNeedsWorld, createNeedsGame } from '../src/needs/game';
import { createGoalRequest } from '../src/negotiation/requests';
import { G09_REQUEST_TEXT } from '../src/negotiation/contracts';
import type { G08EffectiveConfig } from '../src/temporal/contracts';

const ROOT = process.cwd();
const CLI = join(ROOT, 'dist/scripts/play-g10.js');
const DEMO = (name: string) => join(ROOT, `scripts/g10-demo/${name}.txt`);

function tempRoot(tag: string): string {
  return mkdtempSync(join(tmpdir(), `frostech-g10-${tag}-`));
}

function runCli(args: string[], input: string | null, env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 60_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    if (input !== null) child.stdin.end(input);
    else child.stdin.end();
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function runScript(name: string, root: string, extra: string[] = []): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return runCli(['--goals', 'negotiated', '--fixture', name, '--root', root, '--slot', 'demo', ...extra], readFileSync(DEMO(name), 'utf8'));
}

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function envelopePayload(path: string): any {
  return readJson(path).payload;
}

function runRecord(root: string, slot = 'demo'): { path: string; payload: any } {
  for (const name of readdirSync(root).sort()) {
    if (name.startsWith(`${slot}-run`) && name.endsWith('.run.json')) {
      const path = join(root, name);
      return { path, payload: readJson(path).payload };
    }
  }
  throw new Error(`no run record for ${slot} in ${root}: ${readdirSync(root).join(',')}`);
}

function savedSlot(root: string, slot: string): string {
  return join(root, `${slot}.g09.json`);
}

/* ------------------------------------------------------------------ */
/* U1 — the parser is pure and strict                                  */
/* ------------------------------------------------------------------ */
test('U1: every command parses at its boundary; invalid input never reaches the game', () => {
  const ok: [string, any][] = [
    ['help', { kind: 'help' }],
    ['status', { kind: 'status' }],
    ['request npc_a yield_once', { kind: 'request', actorId: 'npc_a', goal: 'yield_once' }],
    ['step', { kind: 'step' }],
    ['run 1', { kind: 'run', steps: 1 }],
    ['run 20', { kind: 'run', steps: 20 }],
    ['player move dorm', { kind: 'player_move', to: 'dorm' }],
    ['player move kitchen', { kind: 'player_move', to: 'kitchen' }],
    ['player eat', { kind: 'player_eat' }],
    ['world time 1', { kind: 'world_time', steps: 1 }],
    ['world time 10', { kind: 'world_time', steps: 10 }],
    ['world restock kitchen 1', { kind: 'world_restock', location: 'kitchen', amount: 1 }],
    ['world restock dorm 10', { kind: 'world_restock', location: 'dorm', amount: 10 }],
    ['save slot-a', { kind: 'save', slot: 'slot-a' }],
    ['quit', { kind: 'quit' }],
  ];
  for (const [line, expected] of ok) {
    const parsed = parseInput(line);
    assert.equal(parsed.ok, true, line);
    if (parsed.ok) assert.deepEqual(parsed.command, expected, line);
  }
  const bad = [
    '', '   ', 'nope', 'help now', 'request npc_b yield_once', 'request npc_a feed_self',
    'request npc_a', 'run', 'run 0', 'run 21', 'run x', 'player move', 'player move attic',
    'player', 'player fly', 'world', 'world time 0', 'world time 11', 'world time x',
    'world restock kitchen', 'world restock garage 1', 'world restock kitchen 11',
    'save', 'save Bad_Slot', 'quit now', 'status extra',
  ];
  for (const line of bad) {
    assert.equal(parseInput(line).ok, false, JSON.stringify(line));
  }
});

/* ------------------------------------------------------------------ */
/* U2 — the controller is bounded, busy-safe and idempotent            */
/* ------------------------------------------------------------------ */
function offlineRuntime(root: string, fixture: 'cooperate' | 'decline' | 'violate' = 'cooperate', slot = 'unit'): G10Runtime {
  const built = createG10Runtime({
    root, slot, goals: 'negotiated', candidates: 'choice', satiety: 40,
    fixture, live: false, http: '', model: null, campaign: null, campaignLimit: null,
  });
  assert.ok(built.ok, JSON.stringify(built));
  return built.value;
}

test('U2: step is at most one call, run N is at most N advances, reads are free', async () => {
  const root = tempRoot('u2');
  try {
    const runtime = offlineRuntime(root);
    const controller = createApplicationController({ game: runtime.game, config: runtime.config, root, slot: runtime.slot, meta: runtime.meta, ports: runtime.ports });
    assert.equal((await controller.execute({ kind: 'request', actorId: 'npc_a', goal: 'yield_once' })).ok, true);
    assert.equal(controller.view().budget.sessionCalls, 0, 'request is 0 calls');
    assert.equal((await controller.execute({ kind: 'status' })).ok, true);
    assert.equal(controller.view().budget.episodeCalls, 0, 'status is free');

    const step = await controller.execute({ kind: 'step' });
    assert.equal(step.ok, true);
    assert.equal(controller.view().budget.sessionCalls, 1, 'one step is one call');
    const run = await controller.execute({ kind: 'run', steps: 5 });
    assert.ok(run.advanced !== undefined && run.advanced >= 1 && run.advanced <= 5);
    const callsBefore = controller.view().budget.episodeCalls;
    assert.equal(callsBefore, 1 + (run.advanced ?? 0), 'run advances at most one call per advance');
    await controller.execute({ kind: 'world_restock', location: 'kitchen', amount: 1 });
    assert.equal(controller.view().budget.episodeCalls, callsBefore, 'world inputs are 0 provider calls');
    const idle = await controller.execute({ kind: 'run', steps: 5 });
    assert.equal(idle.ok, false);
    assert.equal(controller.view().budget.episodeCalls, callsBefore, 'an idle run calls nothing');
    assert.equal(runtime.wire().length, 0, 'offline produces no wire');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('U2b: reentrant step is busy, save is SAVE_BUSY, close is idempotent', async () => {
  let release!: (value: string) => void;
  let entered!: () => void;
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  const game = createNeedsGame({
    episodeId: 'unit', initialState: buildNeedsWorld({ actorIds: ['npc_a', 'npc_c'], kitchenFood: 1, hunger: { npc_a: 40, npc_b: 40, npc_c: 70 } }),
    actorIds: ['npc_a', 'npc_c'],
    providerFor: () => ({
      async decide(input: { goalChoice?: unknown }) {
        if (input.goalChoice === undefined) {
          entered();
          return new Promise<string>(resolve => { release = resolve; });
        }
        return '{"goal":"yield_once"}';
      },
    }),
    mode: 'reference', thinking: true, needPolicy: 'recurring', timeoutMs: 120_000,
    actionSet: 'timed_wait', goalMode: 'negotiated', candidateSet: 'choice', playerId: 'npc_b',
  });
  const built = createGoalRequest({ requestId: 'u2-req-1', episodeId: 'unit', to: 'npc_a', text: G09_REQUEST_TEXT, options: ['feed_self', 'yield_once'], createdAtSimTime: 0, arm: 'choice' });
  assert.ok(built.ok);
  assert.equal(game.submitGoalRequest(built.value).ok, true);
  const config: G08EffectiveConfig = { mode: 'reference', requestModel: null, thinking: true, timeoutMs: 120_000 };
  const controller: ApplicationController = createApplicationController({
    game, config, root: '/tmp', slot: 'unit',
    meta: { schema: 'frostecho.g10.app/1', episodeId: 'unit', providerKind: 'reference', fixtureId: null, goalMode: 'negotiated', candidateSet: 'choice', satiety: 40, scripted: true },
    ports: emptyPorts(),
  });
  await controller.execute({ kind: 'step' }); // goal
  const pending = controller.execute({ kind: 'step' }); // action blocks
  await enteredPromise;
  const second = await controller.execute({ kind: 'step' });
  assert.equal(second.code, 'BUSY');
  const save = await controller.execute({ kind: 'save', slot: 'busy-slot' });
  assert.equal(save.code, 'SAVE_BUSY');
  release('{"type":"wait"}');
  await pending;
  const closed = await controller.close();
  assert.equal(closed.ok, true);
  const again = await controller.close();
  assert.deepEqual(again, closed, 'close is idempotent');
  const afterClose = await controller.execute({ kind: 'step' });
  assert.equal(afterClose.code, 'CLOSED');
});

/* ------------------------------------------------------------------ */
/* P1/P2/P3 — the three demos through the real stdin CLI               */
/* ------------------------------------------------------------------ */
test('P1/P2/P3: the three scripted demos produce the contract outcomes with exactly two decisions', async () => {
  const cases = [
    { name: 'cooperate', playerHunger: 70, npcHunger: 40, food: 0, status: 'accepted', outcome: 'fulfilled', selected: true, hunger: false, wake: 1 },
    { name: 'decline', playerHunger: 40, npcHunger: 70, food: 0, status: 'declined', outcome: 'pending', selected: true, hunger: true, wake: null },
    { name: 'violate', playerHunger: 40, npcHunger: 70, food: 0, status: 'accepted', outcome: 'violated', selected: false, hunger: true, wake: null },
  ] as const;
  for (const expected of cases) {
    const root = tempRoot(`p-${expected.name}`);
    try {
      const result = await runScript(expected.name, root);
      assert.equal(result.code, 0, `${expected.name}: ${result.stderr}`);
      assert.match(result.stdout, /脚本演示/, 'the demo is labelled scripted');
      const record = runRecord(root).payload;
      const view: AppView = record.beforeCloseView;
      assert.equal(view.scripted, true);
      assert.equal(view.fixtureId, expected.name);
      assert.equal(view.budget.episodeCalls, 2, `${expected.name}: exactly two scripted decisions`);
      assert.equal(view.simTime, 0);
      assert.equal(view.player.hunger, expected.playerHunger);
      assert.equal(view.food.kitchen, expected.food);
      const npc = view.npcs.find((entry: any) => entry.actorId === 'npc_a');
      assert.ok(npc);
      assert.equal(npc.wakeAtSimTime, expected.wake);
      if (expected.name === 'cooperate') assert.equal(npc.wakeAtSimTime, 1, 'the original wait deadline stays 1');
      assert.ok(npc.request, 'the request is visible');
      assert.equal(npc.request.status, expected.status);
      assert.equal(npc.request.outcome, expected.outcome);
      assert.equal(npc.selectedGoalAchieved, expected.selected);
      assert.equal(npc.hungerNeedSatisfied, expected.hunger);
      const stateHunger = readJson(savedSlot(root, `${expected.name}-slot`)).payload.game.engine.state.npcs.npc_a.hunger;
      assert.equal(stateHunger, expected.npcHunger, 'the authoritative NPC hunger');
      const savedRequests = envelopePayload(savedSlot(root, `${expected.name}-slot`)).requests.requests['demo-req-1'];
      assert.equal(savedRequests.status, expected.status);
      assert.equal(savedRequests.outcome, expected.outcome);
      if (expected.name === 'decline') {
        assert.match(result.stdout, /NO_FOOD|世界拒绝/, 'the player eat is a normal NO_FOOD rejection');
      }
      if (expected.name === 'violate') {
        assert.notEqual(npc.sessionOutcome, 'goal_reached', 'the top-level label is never goal_reached');
        assert.equal(npc.sessionOutcome, 'selected_goal_yield');
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

/* ------------------------------------------------------------------ */
/* S1 — three cut points across processes vs the continuous run         */
/* ------------------------------------------------------------------ */
function stripTransport(steps: readonly any[]): any[] {
  return steps.map(step => {
    const copy = { ...step };
    delete copy.transport;
    return copy;
  });
}

function gameSemantics(game: ReturnType<typeof createNeedsGame>, requests: any): any {
  const session = game.sessionsOf().find(entry => entry.actorId === 'npc_a')!.session;
  return JSON.parse(JSON.stringify({
    requests: requests.requests,
    processed: [...requests.processed].sort(),
    binding: session.goalBinding,
    decision: session.goalDecision,
    phase: session.phase,
    status: session.status,
    providerCalls: session.providerCalls,
    wake: session.wakeAtSimTime,
    cycles: game.sessionsOf().map(entry => [entry.actorId, entry.cycle]),
    steps: stripTransport(session.steps as readonly any[]),
    state: game.world.getState(),
    log: game.world.getLog().map(entry => ({ seq: entry.seq, command: entry.command, status: entry.result.status, reason: entry.result.reason })),
  }));
}

function envelopeSemantics(payload: any): any {
  const cycles = payload.game.cycles['npc_a'] as any[];
  const session = cycles[cycles.length - 1].session;
  return JSON.parse(JSON.stringify({
    requests: payload.requests.requests,
    processed: [...payload.requests.processed].sort(),
    binding: payload.binding,
    decision: session.goalDecision ?? null,
    phase: session.goalProtocol !== null && session.goalDecision === null ? 'goal_choice' : 'action',
    status: session.status,
    providerCalls: session.providerCalls,
    wake: session.wakeAtSimTime ?? null,
    cycles: Object.keys(payload.game.cycles).sort().map(actor => [actor, payload.game.cycles[actor].length]),
    steps: stripTransport(session.steps ?? []),
    state: payload.game.engine.state,
    log: payload.game.engine.log.map((entry: any) => ({ seq: entry.seq, command: entry.command, status: entry.result.status, reason: entry.result.reason })),
  }));
}

test('S1: three cut points survive a process exit and match the continuous run at every step', async () => {
  const root = tempRoot('s1');
  const cliRoot = join(root, 'cli');
  try {
    // Continuous side: the same fixture and action sequence in one controller.
    const runtime = offlineRuntime(join(root, 'continuous'), 'cooperate', 'demo');
    const controller = createApplicationController({ game: runtime.game, config: runtime.config, root: runtime.root, slot: runtime.slot, meta: runtime.meta, ports: runtime.ports });
    await controller.execute({ kind: 'request', actorId: 'npc_a', goal: 'yield_once' });
    const snapshots: any[] = [];
    await controller.execute({ kind: 'step' });
    snapshots.push(gameSemantics(runtime.game, runtime.game.goalRequests()));
    await controller.execute({ kind: 'step' });
    snapshots.push(gameSemantics(runtime.game, runtime.game.goalRequests()));
    await controller.execute({ kind: 'player_eat' });
    snapshots.push(gameSemantics(runtime.game, runtime.game.goalRequests()));

    // Resumed side: every boundary crosses a new process.
    const created = await runCli(['--goals', 'negotiated', '--fixture', 'cooperate', '--root', cliRoot, '--slot', 'demo'],
      'request npc_a yield_once\nstep\nsave cut1\nquit\n');
    assert.equal(created.code, 0, created.stderr);
    assert.equal(envelopeSemantics(envelopePayload(savedSlot(cliRoot, 'cut1'))).providerCalls, 1);
    const cut1Bytes = readFileSync(savedSlot(cliRoot, 'cut1'));

    const step2 = await runCli(['--load', savedSlot(cliRoot, 'cut1')], 'step\nsave cut2\nquit\n');
    assert.equal(step2.code, 0, step2.stderr);
    assert.match(step2.stdout, /0 次调用、0 次提交、不重选目标/);
    const eaten = await runCli(['--load', savedSlot(cliRoot, 'cut2')], 'player eat\nsave cut3\nquit\n');
    assert.equal(eaten.code, 0, eaten.stderr);

    const cut2 = envelopeSemantics(envelopePayload(savedSlot(cliRoot, 'cut2')));
    const cut3 = envelopeSemantics(envelopePayload(savedSlot(cliRoot, 'cut3')));
    assert.deepEqual(cut2, snapshots[1], 'cut 2 equals the continuous state after the wait');
    assert.deepEqual(cut3, snapshots[2], 'cut 3 equals the continuous state after the player eat');
    assert.deepEqual(readFileSync(savedSlot(cliRoot, 'cut1')), cut1Bytes, 'the source slot bytes never change');
    assert.equal(cut3.requests['demo-req-1'].outcome, 'fulfilled');
    assert.equal(cut3.wake, 1, 'the wait deadline survives the restore');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* S2 — save boundaries and conflicts                                  */
/* ------------------------------------------------------------------ */
test('S2: a second save of the same slot is refused byte-for-byte; a load conflict exits 2', async () => {
  const root = tempRoot('s2');
  try {
    const first = await runCli(['--goals', 'negotiated', '--fixture', 'cooperate', '--root', root, '--slot', 'demo'],
      'request npc_a yield_once\nstep\nsave same-slot\nsave same-slot\nquit\n');
    assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /SAVE_FAILED|EXISTS|already exists/);
    const bytes = readFileSync(savedSlot(root, 'same-slot'));

    const fixtureConflict = await runCli(['--load', savedSlot(root, 'same-slot'), '--fixture', 'violate'], 'status\nquit\n');
    assert.equal(fixtureConflict.code, 2);
    assert.equal(readFileSync(savedSlot(root, 'same-slot')).equals(bytes), true);

    const goalConflict = await runCli(['--load', savedSlot(root, 'same-slot'), '--goals', 'legacy'], 'status\nquit\n');
    assert.equal(goalConflict.code, 2);

    const record = runRecord(root).payload;
    assert.equal(record.beforeCloseView.budget.episodeCalls, 1, 'the failed load made no call');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* N1/N2 — offline default, loopback wire, failures                     */
/* ------------------------------------------------------------------ */
interface Loopback {
  url: string;
  posts: { body: string; index: number }[];
  close(): Promise<void>;
}

async function loopback(answer: (prompt: string, index: number) => { status?: number; body: string; delay?: number }): Promise<Loopback> {
  const posts: { body: string; index: number }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += String(chunk); });
    req.on('end', () => {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(req.url === '/v1/models' ? JSON.stringify({ data: [{ id: 'loopback-model' }] }) : '{}');
        return;
      }
      const index = posts.length;
      posts.push({ body: raw, index });
      const parsed = JSON.parse(raw) as { messages?: { content?: string }[] };
      const prompt = String(parsed.messages?.[0]?.content ?? '');
      const value = answer(prompt, index);
      const send = (): void => {
        res.statusCode = value.status ?? 200;
        res.setHeader('content-type', 'application/json');
        res.end(value.body);
      };
      if (value.delay === undefined) send();
      else setTimeout(send, value.delay);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    posts,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

function yieldAnswer(prompt: string): { body: string } {
  const content = prompt.includes('candidateGoals:') ? '{"goal":"yield_once"}' : '{"type":"wait"}';
  return {
    body: JSON.stringify({
      id: 'wire-sentinel', object: 'chat.completion', model: 'loopback-model',
      choices: [{ message: { role: 'assistant', content } }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      extraWireMarker: 'must-be-preserved',
    }),
  };
}

test('N1: default offline ignores env; the live path is real wire with the saved goal after a restore', async () => {
  const root = tempRoot('n1');
  const server = await loopback(yieldAnswer);
  try {
    // Default offline, env pointing at a real socket: still zero POST.
    const offline = await runCli(['--goals', 'negotiated', '--root', join(root, 'off'), '--slot', 'demo'],
      'request npc_a yield_once\nstep\nquit\n',
      { ...process.env, FROSTECHO_LLM_URL: server.url, FROSTECHO_LLM_MODEL: 'loopback-model' });
    assert.equal(offline.code, 0, offline.stderr);
    assert.equal(server.posts.length, 0, 'no env-driven network');

    const liveRoot = join(root, 'live');
    const campaign = join(root, 'campaign');
    const liveArgs = ['--goals', 'negotiated', '--live', '--http', server.url, '--model', 'loopback-model', '--campaign', campaign, '--campaign-limit', '6'];
    const created = await runCli([...liveArgs, '--root', liveRoot, '--slot', 'demo'], 'request npc_a yield_once\nstep\nsave live-goal\nquit\n');
    assert.equal(created.code, 0, created.stderr);
    assert.equal(server.posts.length, 1);
    const goalWire = server.posts[0]!;

    const restored = await runCli(['--load', savedSlot(liveRoot, 'live-goal'), '--live', '--http', server.url, '--model', 'loopback-model', '--campaign', campaign],
      'step\nplayer eat\nsave live-eaten\nquit\n');
    assert.equal(restored.code, 0, restored.stderr);
    assert.equal(server.posts.length, 2, 'the load itself made no call');
    const actionPrompt = String((JSON.parse(server.posts[1]!.body) as { messages: { content: string }[] }).messages[0]!.content);
    // G10: the structured active goal replaces the old free-text goal line.
    assert.ok(actionPrompt.includes('activeGoal: {"kind":"yield_once"'), 'the action prompt keeps the saved goal');
    assert.ok(!/^goal: hunger/m.test(actionPrompt), 'yield_once must not render a second satiety goal');
    assert.ok(!actionPrompt.includes('candidateGoals:'), 'the goal is not re-asked');

    const createdRecord = runRecord(liveRoot, 'demo').payload;
    const restoredRecord = runRecord(liveRoot, 'live-goal').payload;
    const wire = [...createdRecord.wire, ...restoredRecord.wire];
    assert.equal(wire.length, 2);
    assert.equal(wire[0].requestBodyText, goalWire.body, 'the recorded goal body is the server wire');
    assert.equal(wire[0].endpointClass, 'loopback');
    assert.equal(wire[0].status, 200);
    assert.ok(String(wire[0].responseBody).includes('extraWireMarker'));
    const ledger = readJson(join(campaign, 'campaign.json'));
    assert.equal(ledger.spent, 2);
    for (const exchange of wire) {
      assert.ok(ledger.attempts.some((attempt: any) => attempt.attemptId === exchange.attemptId), 'wire and ledger attempts agree');
    }
    const saved = envelopePayload(savedSlot(liveRoot, 'live-eaten'));
    assert.equal(saved.requests.requests['demo-req-1'].outcome, 'fulfilled');
    assert.equal(saved.game.cycles['npc_a'].at(-1).session.providerCalls, 2);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('N2: a 500 stops at one POST with evidence; NO_FOOD keeps the session usable', async () => {
  const root = tempRoot('n2');
  const server = await loopback(() => ({ status: 500, body: '{"error":{"message":"boom","code":"SERVER_BOOM"}}' }));
  try {
    const liveArgs = ['--goals', 'negotiated', '--live', '--http', server.url, '--model', 'loopback-model', '--campaign', join(root, 'campaign'), '--campaign-limit', '4'];
    const failed = await runCli([...liveArgs, '--root', join(root, 'live'), '--slot', 'demo'], 'request npc_a yield_once\nstep\nquit\n');
    assert.notEqual(failed.code, 0, 'a provider failure must not exit 0');
    assert.equal(server.posts.length, 1, 'no implicit retry');
    assert.equal(existsSync(join(root, 'live', 'demo.failure.json')), true);
    const failure = readJson(join(root, 'live', 'demo.failure.json'));
    assert.equal(failure.wire[0].status, 500);
    assert.ok(String(failure.wire[0].responseBody).includes('SERVER_BOOM'));
    assert.deepEqual(failure.wire[0].requestBody, JSON.parse(server.posts[0]!.body), 'the failed request body is the real wire');
    assert.equal(readJson(join(root, 'campaign', 'campaign.json')).attempts.length, 1);
  } finally {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }

  const offRoot = tempRoot('n2b');
  try {
    const decline = await runCli(['--goals', 'negotiated', '--fixture', 'decline', '--root', offRoot, '--slot', 'demo'],
      'request npc_a yield_once\nstep\nstep\nplayer eat\nsave after-no-food\nquit\n');
    assert.equal(decline.code, 0, 'NO_FOOD is a normal game result');
    assert.equal(existsSync(savedSlot(offRoot, 'after-no-food')), true, 'a normal rejection still saves');
  } finally {
    rmSync(offRoot, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* X1 — quit / EOF / SIGINT finalize once without new decisions        */
/* ------------------------------------------------------------------ */
test('X1: quit and EOF each finalize once and never add a model call (all platforms)', async () => {
  const root = tempRoot('x1');
  try {
    const quit = await runCli(['--goals', 'negotiated', '--fixture', 'cooperate', '--root', join(root, 'quit'), '--slot', 'demo'],
      'request npc_a yield_once\nstep\nquit\n');
    assert.equal(quit.code, 0, quit.stderr);
    assert.equal(runRecord(join(root, 'quit')).payload.beforeCloseView.budget.episodeCalls, 1);

    const eof = await runCli(['--goals', 'negotiated', '--fixture', 'cooperate', '--root', join(root, 'eof'), '--slot', 'demo'],
      'request npc_a yield_once\nstep\n');
    assert.equal(eof.code, 0, eof.stderr);
    assert.equal(runRecord(join(root, 'eof')).payload.beforeCloseView.budget.episodeCalls, 1, 'the accepted command is not lost');

  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * POSIX keeps a REAL SIGINT child test. On Windows child.kill('SIGINT') is a
 * forced termination, not a terminal Ctrl+C: it is explicitly skipped, never
 * treated as a pass. Real terminal Ctrl+C on Windows is NOT verified here.
 */
test('X1b: POSIX SIGINT finalizes once without a model call', {
  skip: process.platform === 'win32'
    ? 'Windows child.kill(SIGINT) is forced termination, not terminal Ctrl+C (unverified)'
    : false,
}, async () => {
  const root = tempRoot('x1-sigint');
  try {
    const hard = await new Promise<{ code: number | null }>((resolve, reject) => {
      const child = spawn(process.execPath, [CLI, '--goals', 'negotiated', '--fixture', 'cooperate', '--root', join(root, 'sigint'), '--slot', 'demo'], { cwd: ROOT });
      let stdout = '';
      child.stdout.on('data', chunk => { stdout += String(chunk); });
      const timer = setTimeout(() => reject(new Error(`SIGINT child did not start: ${stdout}`)), 20_000);
      const poll = setInterval(() => {
        if (stdout.includes('g10>') || stdout.includes('输入 help')) {
          clearInterval(poll);
          child.kill('SIGINT');
          timer.refresh();
        }
      }, 50);
      child.on('close', code => { clearTimeout(timer); clearInterval(poll); resolve({ code }); });
    });
    assert.equal(hard.code, 0, 'a clean SIGINT exits 0');
    assert.equal(runRecord(join(root, 'sigint')).payload.beforeCloseView.budget.episodeCalls, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
