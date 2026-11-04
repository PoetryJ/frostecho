/**
 * G09-R2 worker D — the seven independent acceptance scenarios (F1-F7).
 *
 * Every game assertion drives the real createNeedsGame controller: sessions,
 * the authoritative Engine log, the request store, checkpoint save/restore in
 * a DIFFERENT node process (CLI), and a real loopback HTTP socket for the
 * --live path. The expectations come from the frozen contract in CASES.txt,
 * never from the product helpers under test.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildNeedsWorld, createNeedsGame } from '../src/needs/game';
import type { AgentSession, GoalHostPort } from '../src/agent/contracts';
import { G09_REQUEST_TEXT, G09_TIMEOUT_MS } from '../src/negotiation/contracts';
import { createGoalRequest } from '../src/negotiation/requests';
import {
  loadG09Checkpoint, restoreG09Game, saveG09Checkpoint, type LoadedG09Checkpoint,
} from '../src/negotiation/checkpoint';
import type { G08EffectiveConfig } from '../src/temporal/contracts';

const NPC = 'npc_a';
const ROOT = process.cwd();
const CONFIG: G08EffectiveConfig = { mode: 'reference', requestModel: null, thinking: true, timeoutMs: G09_TIMEOUT_MS };

type NeedsGame = ReturnType<typeof createNeedsGame>;

function tempRoot(tag: string): string {
  return mkdtempSync(join(tmpdir(), `frostech-g09r2-${tag}-`));
}

function world(food = 1, hungerA = 40) {
  return buildNeedsWorld({
    actorIds: [NPC, 'npc_c'],
    kitchenFood: food,
    hunger: { npc_a: hungerA, npc_b: 40, npc_c: 70 },
  });
}

function request(id = 'req-1', createdAt = 0) {
  const built = createGoalRequest({
    requestId: id, episodeId: 'ep', to: NPC, text: G09_REQUEST_TEXT,
    options: ['feed_self', 'yield_once'], createdAtSimTime: createdAt, arm: 'choice',
  });
  assert.ok(built.ok);
  return built.value;
}

interface Script { (input: { goalChoice?: unknown }): string | Promise<string> }

function gameWith(script: Script, options: { food?: number; hungerA?: number } = {}): NeedsGame {
  const game = createNeedsGame({
    episodeId: 'ep',
    initialState: world(options.food ?? 1, options.hungerA ?? 40),
    actorIds: [NPC, 'npc_c'],
    providerFor: () => ({ decide: (input) => Promise.resolve(script(input)) }),
    mode: 'reference', thinking: true, needPolicy: 'recurring', timeoutMs: G09_TIMEOUT_MS,
    actionSet: 'timed_wait', goalMode: 'negotiated', candidateSet: 'choice', playerId: 'npc_b',
  });
  return game;
}

function submit(game: NeedsGame, id = 'req-1'): void {
  const controller = game as unknown as { submitGoalRequest(r: unknown): { ok: boolean } };
  assert.equal(controller.submitGoalRequest(request(id)).ok, true);
}

function store(game: NeedsGame): { requests: Record<string, any>; processed: string[] } {
  return (game as unknown as { goalRequests(): { requests: Record<string, any>; processed: string[] } }).goalRequests();
}

function sessionOf(game: NeedsGame): AgentSession {
  const entry = game.sessionsOf().find(candidate => candidate.actorId === NPC);
  assert.ok(entry, 'npc_a session must exist');
  return entry.session;
}


function waitForFile(path: string, timeoutMs = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const tick = (): void => {
      if (existsSync(path)) { resolve(); return; }
      if (Date.now() > deadline) { reject(new Error(`barrier timeout: ${path}`)); return; }
      setTimeout(tick, 5);
    };
    tick();
  });
}

/* ------------------------------------------------------------------ */
/* F1 — in-flight deadlines and the acceptance seq                     */
/* ------------------------------------------------------------------ */
test('F1a: a goal answer released after the deadline is discarded (no binding, no submit)', async () => {
  const gate = makeGate();
  let calls = 0;
  const game = gameWith(() => {
    calls += 1;
    return Promise.resolve().then(() => { gate.enter(); return gate.promise; });
  });
  submit(game);
  const pending = game.advance();
  await gate.entered;
  game.worldAdvanceTime(1);
  gate.release('{"goal":"yield_once"}');
  await pending;
  const session = sessionOf(game);
  assert.equal(session.goalBinding, null);
  assert.equal(session.status, 'failed');
  assert.equal(session.result().outcome, 'request_expired');
  assert.equal(session.providerCalls, 1, 'the sent call stays spent exactly once');
  assert.equal(game.world.getLog().length, 1, 'only the advance_time command exists');
  assert.equal(store(game).requests['req-1'].status, 'expired');
  assert.equal(calls, 1);
});

test('F1b: a wait answer released after the action deadline creates no new wait deadline', async () => {
  const gate = makeGate();
  let calls = 0;
  const game = gameWith(input => {
    calls += 1;
    if (input.goalChoice !== undefined) return '{"goal":"yield_once"}';
    return Promise.resolve().then(() => { gate.enter(); return gate.promise; });
  });
  submit(game);
  await game.advance();
  const pending = game.advance();
  await gate.entered;
  game.worldAdvanceTime(1);
  gate.release('{"type":"wait"}');
  await pending;
  const session = sessionOf(game);
  assert.equal(session.status, 'failed');
  assert.equal(session.wakeAtSimTime, null, 'no new deadline after the request ended');
  assert.equal(session.providerCalls, 2, 'goal + action, both spent');
  assert.equal(game.world.getLog().length, 1, 'the late wait submitted nothing');
});

test('F1c: a player eat before acceptance cannot fulfil the later promise, and the seq is the receive seq', async () => {
  const gate = makeGate();
  let calls = 0;
  const game = gameWith(() => {
    calls += 1;
    if (calls !== 1) return '{"type":"eat"}';
    return Promise.resolve().then(() => { gate.enter(); return gate.promise; });
  }, { food: 2 });
  submit(game);
  const pending = game.advance();
  await gate.entered;
  const eat = game.playerLine('player eat');
  assert.equal(eat.ok, true);
  const seqAtRelease = game.world.logLength();
  assert.equal(seqAtRelease, 1);
  gate.release('{"goal":"yield_once"}');
  await pending;
  const binding = sessionOf(game).goalBinding;
  assert.ok(binding, 'the promise is accepted while the request is still pending');
  assert.equal(binding.acceptedAfterSeq, seqAtRelease, 'acceptance uses the receive-point seq, never the attach seq 0');
  assert.equal(store(game).requests['req-1'].outcome, 'pending', 'the earlier eat proves nothing');
  await game.advance();
  assert.equal(store(game).requests['req-1'].outcome, 'violated', 'the NPC eat after acceptance is a violation');
});

/* ------------------------------------------------------------------ */
/* F2 — real fulfilment, real violation, separate goal axes            */
/* ------------------------------------------------------------------ */
test('F2a: yield -> stop -> player eat fulfils immediately; selected goal true, hunger need false', async () => {
  const game = gameWith(input => (input.goalChoice === undefined ? '{"type":"stop"}' : '{"goal":"yield_once"}'));
  submit(game);
  await game.advance();
  await game.advance();
  assert.equal(store(game).requests['req-1'].outcome, 'pending');
  const eat = game.playerLine('player eat');
  assert.equal(eat.ok, true);
  assert.equal(store(game).requests['req-1'].outcome, 'fulfilled');
  const result = sessionOf(game).result();
  assert.equal(result.selectedGoalReached, true);
  assert.equal(result.goalReached, true);
  assert.equal(result.hungerNeedSatisfied, false);
  assert.equal(game.world.getState().npcs[NPC]?.hunger, 40);
  assert.equal(game.snapshot().actors[NPC]?.goalReached, true);
  game.worldAdvanceTime(1);
  assert.equal(store(game).requests['req-1'].outcome, 'fulfilled', 'expiry never rewrites a fulfilled promise');
});

test('F2b: NPC eats first -> violated forever, even at hunger 70 and after a later player eat', async () => {
  const game = gameWith(input => (input.goalChoice === undefined ? '{"type":"eat"}' : '{"goal":"yield_once"}'), { food: 2 });
  submit(game);
  await game.advance();
  await game.advance();
  assert.equal(store(game).requests['req-1'].outcome, 'violated');
  game.playerLine('player eat');
  game.worldAdvanceTime(1);
  assert.equal(store(game).requests['req-1'].outcome, 'violated');
  const result = sessionOf(game).result();
  assert.equal(result.selectedGoalReached, false);
  assert.equal(result.goalReached, false);
});

test('F2d: a feed_self refusal is recorded in the store and still runs the ordinary hunger action', async () => {
  const game = gameWith(input => (input.goalChoice === undefined ? '{"type":"eat"}' : '{"goal":"feed_self"}'));
  submit(game);
  await game.advance();
  const request = store(game).requests['req-1'];
  assert.equal(request.status, 'declined');
  assert.equal(request.outcome, 'pending', 'a declined request carries no fulfilment outcome');
  assert.equal(sessionOf(game).goalBinding, null);
  await game.advance();
  assert.equal(game.world.getState().npcs[NPC]?.hunger, 70, 'the refusal does not block the ordinary goal');
  assert.equal(sessionOf(game).status, 'goal_reached');
  assert.equal(sessionOf(game).result().goalReached, true);
});

test('F2c: close cancels an unfinished request; the terminal outcome is idempotent', async () => {
  const game = gameWith(input => (input.goalChoice === undefined ? '{"type":"stop"}' : '{"goal":"yield_once"}'));
  submit(game);
  await game.advance();
  await game.advance();
  assert.equal(store(game).requests['req-1'].outcome, 'pending');
  await game.close();
  assert.equal(store(game).requests['req-1'].outcome, 'cancelled');
  const frozen = JSON.stringify(store(game).requests['req-1']);
  await game.close();
  assert.equal(JSON.stringify(store(game).requests['req-1']), frozen);
});

/* ------------------------------------------------------------------ */
/* CLI helpers (cross-process save/load, real socket)                  */
/* ------------------------------------------------------------------ */
function runArgs(args: string[], env: NodeJS.ProcessEnv = process.env): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), 60_000);
    child.stdout.on('data', chunk => { stdout += String(chunk); });
    child.stderr.on('data', chunk => { stderr += String(chunk); });
    child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
  });
}

function runNode(script: string, args: string[], env: NodeJS.ProcessEnv = process.env) {
  return runArgs([script, ...args], env);
}

function runCode(code: string) {
  return runArgs(['-e', code]);
}

function cli(args: string[]) {
  return runNode(join(ROOT, 'dist/scripts/play-g09.js'), args);
}

interface Loopback {
  url: string;
  prompts: string[];
  posts: number;
  close(): Promise<void>;
}

async function loopback(answer: (prompt: string) => { body: string; status?: number }): Promise<Loopback> {
  const prompts: string[] = [];
  let posts = 0;
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', chunk => { raw += String(chunk); });
    req.on('end', () => {
      if (req.method === 'GET') {
        res.setHeader('content-type', 'application/json');
        res.end(req.url === '/v1/models' ? JSON.stringify({ data: [{ id: 'loopback-model' }] }) : '{}');
        return;
      }
      posts += 1;
      const body = JSON.parse(raw) as { messages?: { content?: string }[] };
      const prompt = String(body.messages?.[0]?.content ?? '');
      prompts.push(prompt);
      const answerValue = answer(prompt);
      res.statusCode = answerValue.status ?? 200;
      res.setHeader('content-type', 'application/json');
      res.end(answerValue.body);
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/v1/chat/completions`,
    prompts,
    get posts() { return posts; },
    close: () => new Promise<void>(resolve => { server.close(() => resolve()); }),
  };
}

function yieldWaitAnswer(prompt: string): { body: string } {
  const content = prompt.includes('candidateGoals:') ? '{"goal":"yield_once"}' : '{"type":"wait"}';
  return {
    body: JSON.stringify({
      id: 'wire-sentinel', object: 'chat.completion', model: 'loopback-model',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      extraWireMarker: 'must-be-preserved',
    }),
  };
}

function envelope(path: string): any {
  return JSON.parse(readFileSync(path, 'utf8')).payload;
}

function savedSlot(root: string, slot: string): string {
  return join(root, `${slot}.g09.json`);
}

function sessionPayload(payload: any): any {
  return payload.game.cycles[NPC].at(-1).session;
}

/* ------------------------------------------------------------------ */
/* F3 — the same yield goal across three save cut points               */
/* ------------------------------------------------------------------ */
test('F3: save at three cut points, load in another process, and keep the same yield goal', async () => {
  const root = tempRoot('f3');
  const http = await loopback(yieldWaitAnswer);
  try {
    const common = ['--goals', 'negotiated', '--candidates', 'choice', '--request', 'npc_a=yield_once',
      '--live', '--http', http.url, '--model', 'loopback-model'];
    // Cut 1 — before the choice.
    const before = await cli(['--new', '--root', root, '--slot', 'before', ...common, '--save']);
    assert.equal(before.code, 0, before.stderr);
    // Cut 2 — after the choice, before the action.
    const chosen = await cli(['--new', '--root', root, '--slot', 'chosen0', ...common, '--step', '--save-as', 'chosen']);
    assert.equal(chosen.code, 0, chosen.stderr);
    // Cut 3 — after the wait.
    const waiting = await cli(['--load', '--path', savedSlot(root, 'chosen'), '--live', '--http', http.url, '--model', 'loopback-model', '--step', '--save-as', 'waiting']);
    assert.equal(waiting.code, 0, waiting.stderr);

    const beforePayload = envelope(savedSlot(root, 'before'));
    const chosenPayload = envelope(savedSlot(root, 'chosen'));
    const waitingPayload = envelope(savedSlot(root, 'waiting'));
    assert.equal(sessionPayload(beforePayload).goalBinding, null, 'cut 1 has no binding yet');
    assert.equal(sessionPayload(chosenPayload).goalBinding?.goal, 'yield_once', 'cut 2 keeps the binding');
    assert.equal(sessionPayload(waitingPayload).goalBinding?.goal, 'yield_once', 'cut 3 keeps the binding');
    assert.equal(sessionPayload(waitingPayload).status, 'waiting_time');
    assert.equal(sessionPayload(waitingPayload).wakeAtSimTime, 1);
    const request = waitingPayload.requests.requests['chosen0-req-1'];
    assert.equal(request.status, 'accepted');
    assert.equal(request.outcome, 'pending');
    assert.equal(request.acceptedAfterSeq, 0);

    // Loading spends zero calls and submits nothing; the action prompt after a
    // load still carries the YIELD goal line and never re-asks the goal.
    const promptsBefore = http.prompts.length;
    const resumed = await cli(['--load', '--path', savedSlot(root, 'waiting'), '--live', '--http', http.url, '--model', 'loopback-model', '--status']);
    assert.equal(resumed.code, 0, resumed.stderr);
    assert.match(resumed.stdout, /zero calls, no re-choice/);
    assert.equal(http.prompts.length, promptsBefore, 'a load makes no provider call');
    const loadedChosen = await cli(['--load', '--path', savedSlot(root, 'chosen'), '--live', '--http', http.url, '--model', 'loopback-model', '--step', '--save-as', 'chosen-again']);
    assert.equal(loadedChosen.code, 0, loadedChosen.stderr);
    const actionPrompt = http.prompts[http.prompts.length - 1]!;
    assert.ok(actionPrompt.includes('你已选择的目标：yield_once'), 'the restored action prompt keeps the yield goal');
    assert.ok(!actionPrompt.includes('candidateGoals:'), 'the goal is never re-asked');

    // The original slot bytes never change; the re-saved session keeps the
    // phase, binding, request seqs, cycles, budget and the wait deadline.
    const waitingBytes = readFileSync(savedSlot(root, 'waiting'));
    const again = envelope(savedSlot(root, 'chosen-again'));
    const original = envelope(savedSlot(root, 'chosen'));
    assert.equal(JSON.stringify(sessionPayload(again).goalBinding), JSON.stringify(sessionPayload(original).goalBinding));
    assert.equal(JSON.stringify(again.requests), JSON.stringify(original.requests));
    assert.equal(sessionPayload(again).providerCalls, sessionPayload(original).providerCalls + 1);
    assert.equal(again.game.engine.log.length, original.game.engine.log.length);
    const afterTime = await cli(['--load', '--path', savedSlot(root, 'waiting'), '--live', '--http', http.url, '--model', 'loopback-model', '--time', '1', '--save-as', 'awake']);
    assert.equal(afterTime.code, 0, afterTime.stderr);
    assert.deepEqual(readFileSync(savedSlot(root, 'waiting')), waitingBytes, 'the source slot is never rewritten');

    // The restored player eat fulfils the request immediately.
    const eaten = await cli(['--load', '--path', savedSlot(root, 'waiting'), '--live', '--http', http.url, '--model', 'loopback-model', '--eat', '--save-as', 'eaten']);
    assert.equal(eaten.code, 0, eaten.stderr);
    assert.equal(envelope(savedSlot(root, 'eaten')).requests.requests['chosen0-req-1'].outcome, 'fulfilled');
  } finally {
    await http.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* F4 — CLI time and wait                                              */
/* ------------------------------------------------------------------ */
test('F4: --time advances the authoritative clock, expires the open request, and never rewrites a fulfilled one', async () => {
  const root = tempRoot('f4');
  const http = await loopback(yieldWaitAnswer);
  try {
    const common = ['--goals', 'negotiated', '--candidates', 'choice', '--request', 'npc_a=yield_once',
      '--live', '--http', http.url, '--model', 'loopback-model'];
    await cli(['--new', '--root', root, '--slot', 'f4', ...common, '--step', '--save-as', 'f4-chosen']);
    await cli(['--load', '--path', savedSlot(root, 'f4-chosen'), '--live', '--http', http.url, '--model', 'loopback-model', '--step', '--save-as', 'f4-waiting']);
    const waiting = envelope(savedSlot(root, 'f4-waiting'));
    assert.equal(sessionPayload(waiting).wakeAtSimTime, 1);
    const callsBefore = sessionPayload(waiting).providerCalls;

    const timed = await cli(['--load', '--path', savedSlot(root, 'f4-waiting'), '--live', '--http', http.url, '--model', 'loopback-model', '--time', '1', '--save-as', 'f4-awake']);
    assert.equal(timed.code, 0, timed.stderr);
    assert.match(timed.stdout, /selected goal: yield_once/);
    assert.match(timed.stdout, /hunger goal: achieved=false hunger=30/);
    const awake = envelope(savedSlot(root, 'f4-awake'));
    assert.equal(awake.game.engine.state.simTime, 1);
    assert.equal(sessionPayload(awake).providerCalls, callsBefore, 'time spends no model call');
    const request = awake.requests.requests['f4-req-1'];
    assert.equal(request.outcome, 'expired');
    assert.equal(request.expiresAtSimTime, 1, 'the expiry is never extended');

    // Player eat first, then time: the fulfilment is permanent.
    const eaten = await cli(['--load', '--path', savedSlot(root, 'f4-waiting'), '--live', '--http', http.url, '--model', 'loopback-model', '--eat', '--time', '1', '--save-as', 'f4-eaten']);
    assert.equal(eaten.code, 0, eaten.stderr);
    assert.equal(envelope(savedSlot(root, 'f4-eaten')).requests.requests['f4-req-1'].outcome, 'fulfilled');
  } finally {
    await http.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* F5 — the real live code path on loopback                            */
/* ------------------------------------------------------------------ */
test('F5: eval --live records the REAL wire (8 episodes, 16 POST, verify green)', async () => {
  const root = tempRoot('f5');
  const wire: { request: any; requestText: string; response: string }[] = [];
  const http = await loopback(prompt => {
    const isGoal = prompt.includes('candidateGoals:');
    const goal = prompt.includes('candidateGoals: [\"feed_self\"]') ? 'feed_self' : 'yield_once';
    const content = isGoal ? JSON.stringify({ goal }) : '{"type":"wait"}';
    const response = JSON.stringify({
      id: `wire-${wire.length + 1}`, object: 'chat.completion', model: 'loopback-model',
      choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 },
      extraWireMarker: 'must-be-preserved',
    });
    wire.push({ request: null, requestText: '', response });
    return { body: response };
  });
  try {
    const result = await runNode(join(ROOT, 'dist/scripts/eval-g09.js'), [
      '--out', join(root, 'artifacts'), '--batch', 'loopback-live', '--campaign', join(root, 'campaign'),
      '--campaign-limit', '16', '--live', '--http', http.url, '--model', 'loopback-model',
    ]);
    assert.equal(result.code, 0, result.stderr);
    assert.equal(http.posts, 16, '8 episodes x two calls');
    assert.match(result.stdout, /verify loopback-live: ok=true/);
    const episodes = ['g09-r1-s40-self_only', 'g09-r1-s40-choice', 'g09-r1-s60-self_only', 'g09-r1-s60-choice',
      'g09-r2-s40-self_only', 'g09-r2-s40-choice', 'g09-r2-s60-self_only', 'g09-r2-s60-choice'];
    const records = episodes.map(id => JSON.parse(readFileSync(join(root, 'artifacts/loopback-live/episodes', `${id}.json`), 'utf8')));
    const recorded = records.flatMap(record => record.http);
    assert.equal(recorded.length, 16);
    for (const exchange of recorded) {
      assert.ok(JSON.stringify(exchange.requestBody).includes('messages'), 'the recorded body is the serialized request');
      assert.ok(String(exchange.response.body).includes('extraWireMarker'), 'the raw response body is preserved');
      assert.ok(String(exchange.response.body).includes('"id":"wire-'), 'response id preserved');
      assert.equal(exchange.response.usage.total_tokens, 14);
    }
    const verify = await runNode(join(ROOT, 'dist/scripts/eval-g09.js'), [
      '--verify', '--out', join(root, 'artifacts'), '--batch', 'loopback-live', '--campaign', join(root, 'campaign'),
    ]);
    assert.equal(verify.code, 0, verify.stdout + verify.stderr);
    assert.match(verify.stdout, /ok=true/);
  } finally {
    await http.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('F5b: a 500 on the first call stops the batch, keeps the raw evidence, and invents no usage', async () => {
  const root = tempRoot('f5b');
  let posts = 0;
  const http = await loopback(() => {
    posts += 1;
    return { status: 500, body: '{"error":{"message":"boom","code":"SERVER_BOOM"}}' };
  });
  try {
    const result = await runNode(join(ROOT, 'dist/scripts/eval-g09.js'), [
      '--out', join(root, 'artifacts'), '--batch', 'loopback-500', '--campaign', join(root, 'campaign'),
      '--campaign-limit', '16', '--live', '--http', http.url, '--model', 'loopback-model',
    ]);
    assert.notEqual(result.code, 0, 'a failed live run must not exit 0');
    assert.equal(http.posts, 1, 'no implicit retry and no later episode');
    const first = JSON.parse(readFileSync(join(root, 'artifacts/loopback-500/episodes/g09-r1-s40-self_only.json'), 'utf8'));
    assert.equal(first.outcome, 'provider_error');
    assert.equal(first.http[0].response.status, 500);
    assert.ok(String(first.http[0].response.body).includes('SERVER_BOOM'), 'the raw 500 body is kept');
    assert.equal(first.http[0].response.usage, null, 'missing usage stays null');
    const later = JSON.parse(readFileSync(join(root, 'artifacts/loopback-500/episodes/g09-r1-s40-choice.json'), 'utf8'));
    assert.equal(later.outcome, 'not_run');
    assert.equal(later.http.length, 0);
  } finally {
    await http.close();
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* F6 — first-open init + concurrency + restart budget                 */
/* ------------------------------------------------------------------ */
function budgetChild(root: string): string {
  const path = join(root, 'budget-child.cjs');
  writeFileSync(path, `const fs=require('node:fs'),path=require('node:path');
const [lib,dir,mode,batch]=process.argv.slice(2);
if(mode==='slow'){const orig=fs.renameSync;let once=true;fs.renameSync=function(a,b){if(once){once=false;fs.writeFileSync(path.join(dir,'ready'),'ready');while(!fs.existsSync(path.join(dir,'go')))Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,5);}return orig(a,b);};}
const c=require(lib);
try{
  if(mode!=='reserve')c.openCampaign(dir,mode==='slow'?1:1,'race');
  const r=c.reserveCampaignChat(dir,{batch:batch||mode,episodeId:batch||mode,phase:'goal'});
  console.log(JSON.stringify({ok:r.ok,spent:r.state.spent,attempts:r.state.attempts.length,ids:r.state.attempts.map(a=>a.attemptId)}));
}catch(e){console.log(JSON.stringify({ok:false,error:String(e&&e.message||e)}));}
`);
  return path;
}

test('F6a: two processes race the FIRST open with limit 1 — only one authorization survives', async () => {
  const root = tempRoot('f6a');
  try {
    const child = budgetChild(root);
    const lib = join(ROOT, 'dist/scripts/campaign-budget.js');
    const dir = join(root, 'race');
    const slow = runNode(child, [lib, dir, 'slow']);
    await waitForFile(join(dir, 'ready'));
    const fast = runNode(child, [lib, dir, 'fast']);
    const fastResult = await fast;
    writeFileSync(join(dir, 'go'), 'go');
    const slowResult = await slow;
    const fastState = JSON.parse(fastResult.stdout || '{"ok":false}');
    const slowState = JSON.parse(slowResult.stdout);
    assert.equal(slowState.ok, true);
    assert.equal(fastState.ok, false, 'the losing first open must fail explicitly, never overwrite');
    const ledger = JSON.parse(readFileSync(join(dir, 'campaign.json'), 'utf8'));
    const granted = [slowState, fastState].filter(value => value.ok).length;
    assert.equal(granted, 1);
    assert.equal(ledger.spent, granted, 'the disk keeps exactly the real grants');
    assert.equal(ledger.attempts.length, granted);
    assert.equal(ledger.limit, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F6b: eight processes on an existing limit-2 ledger grant at most two unique attempts', async () => {
  const root = tempRoot('f6b');
  try {
    const lib = join(ROOT, 'dist/scripts/campaign-budget.js');
    const dir = join(root, 'parallel');
    // The existing ledger is created through the real open path.
    const created = await runCode(`const c=require(${JSON.stringify(lib)});const s=c.openCampaign(${JSON.stringify(dir)},2,'parallel');console.log(JSON.stringify(s));`);
    assert.equal(created.code, 0, created.stderr);
    const child = budgetChild(root);
    const runs = await Promise.all(Array.from({ length: 8 }, (_value, index) => runNode(child, [lib, dir, 'reserve', `b${index}`])));
    const results = runs.map(run => JSON.parse(run.stdout));
    const granted = results.filter(value => value.ok).length;
    assert.ok(granted <= 2, `at most two grants, got ${granted}`);
    assert.ok(granted >= 1, 'at least one grant on a free ledger');
    const ledger = JSON.parse(readFileSync(join(dir, 'campaign.json'), 'utf8'));
    assert.equal(ledger.spent, granted);
    const ids = ledger.attempts.map((attempt: { attemptId: string }) => attempt.attemptId);
    assert.equal(new Set(ids).size, ids.length, 'attempt ids are unique');
    const seqs = ledger.attempts.map((attempt: { seq: number }) => attempt.seq);
    assert.equal(new Set(seqs).size, seqs.length, 'seqs are unique');

    // A restart (new open) and a new batch never refresh the budget.
    const restarted = await runCode(`const c=require(${JSON.stringify(lib)});const s=c.openCampaign(${JSON.stringify(dir)},99,'restart');console.log(JSON.stringify({limit:s.limit,spent:s.spent}));`);
    const state = JSON.parse(restarted.stdout);
    assert.equal(state.limit, 2, 'the limit is immutable');
    assert.equal(state.spent, granted);
    const otherBatch = await runNode(child, [lib, dir, 'reserve', 'fresh-batch']);
    assert.equal(JSON.parse(otherBatch.stdout).ok, false, 'a new batch name does not refresh the budget');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F6c: limit 0 authorizes nothing, and a reserved-but-unfinished call stays spent', async () => {
  const root = tempRoot('f6c');
  try {
    const lib = join(ROOT, 'dist/scripts/campaign-budget.js');
    const dir = join(root, 'zero');
    const run = await runCode(`const c=require(${JSON.stringify(lib)});const s=c.openCampaign(${JSON.stringify(dir)},0,'zero');const r=c.reserveCampaignChat(${JSON.stringify(dir)},{batch:'z',episodeId:'z',phase:'goal'});console.log(JSON.stringify({ok:r.ok,spent:r.state.spent,known:c.campaignCounts(s).known}));`);
    const zero = JSON.parse(run.stdout);
    assert.equal(zero.ok, false);
    assert.equal(zero.spent, 0);
    const one = join(root, 'one');
    const unfinished = await runCode(`const c=require(${JSON.stringify(lib)});c.openCampaign(${JSON.stringify(one)},2,'one');const r=c.reserveCampaignChat(${JSON.stringify(one)},{batch:'a',episodeId:'a',phase:'goal'});const s=c.loadCampaign(${JSON.stringify(one)});console.log(JSON.stringify({ok:r.ok,spent:s.spent,known:c.campaignCounts(s).known}));`);
    const state = JSON.parse(unfinished.stdout);
    assert.equal(state.ok, true);
    assert.equal(state.spent, 1);
    assert.equal(state.known, null, 'an unfinished call has unknown usage and stays spent');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* F7 — contract-first trajectory comparison (continuous vs resumed)   */
/* ------------------------------------------------------------------ */
interface Facts {
  requests: unknown;
  processed: string[];
  binding: unknown;
  decision: unknown;
  phase: string;
  status: string;
  providerCalls: number;
  wake: number | null;
  cycles: unknown;
  state: unknown;
  log: unknown;
}

function facts(game: NeedsGame, requests: { requests: Record<string, any>; processed: string[] }): Facts {
  const session = sessionOf(game);
  const strip = (steps: readonly any[]) => steps.map(step => {
    const copy = { ...step };
    delete copy.transport;
    return copy;
  });
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
    steps: strip(session.steps as readonly any[]),
    state: game.world.getState(),
    log: game.world.getLog().map(entry => ({ seq: entry.seq, command: entry.command, status: entry.result.status, reason: entry.result.reason })),
  }));
}

function contractFacts(game: NeedsGame, requests: { requests: Record<string, any>; processed: string[] }): Record<string, unknown> {
  const session = sessionOf(game);
  const request = requests.requests['req-1'];
  const result = session.result();
  return {
    status: request?.status ?? null,
    sessionStatus: session.status,
    outcome: request?.outcome ?? null,
    acceptedAfterSeq: request?.acceptedAfterSeq ?? null,
    bindingGoal: session.goalBinding?.goal ?? null,
    acceptedAfterSeqBinding: session.goalBinding?.acceptedAfterSeq ?? null,
    phase: session.phase,
    providerCalls: session.providerCalls,
    wake: session.wakeAtSimTime,
    selectedGoalReached: result.selectedGoalReached,
    hungerNeedSatisfied: result.hungerNeedSatisfied,
    processed: [...requests.processed].sort(),
  };
}

async function saveAndRestore(root: string, slot: string, game: NeedsGame, script: Script): Promise<{ game: NeedsGame; requests: { requests: Record<string, any>; processed: string[] } }> {
  const session = sessionOf(game);
  const saved = saveG09Checkpoint(root, slot, game, {
    arm: 'choice', satiety: 40,
    requests: (game as unknown as { goalRequests(): { requests: Record<string, any>; processed: string[] } }).goalRequests(),
    binding: session.goalBinding,
  }, CONFIG);
  assert.ok(saved.ok, JSON.stringify(saved));
  const loaded = loadG09Checkpoint(saved.value.path) as { ok: true; value: LoadedG09Checkpoint };
  assert.equal(loaded.ok, true);
  const restored = restoreG09Game(loaded.value, {
    providerFor: () => ({ decide: (input) => Promise.resolve(script(input)) }),
    now: Date.now, playerId: 'npc_b',
  });
  assert.ok(restored.ok, JSON.stringify(restored));
  return {
    game: restored.value.game as NeedsGame,
    requests: restored.value.store,
  };
}

interface Gate { promise: Promise<string>; entered: Promise<void>; enter(): void; release(value: string): void }

function makeGate(): Gate {
  let enter!: () => void;
  let release!: (value: string) => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const promise = new Promise<string>(resolve => { release = resolve; });
  return { promise, entered, enter: () => enter(), release: (value: string) => release(value) };
}

type Step =
  | { kind: 'advance' }
  | { kind: 'eat' }
  | { kind: 'time' }
  | { kind: 'inflight'; release: string; during: 'time' | 'eat' };

async function runTrajectory(
  tag: string,
  steps: Step[],
  restored: boolean,
  root: string,
  answers: string[],
  food = 1,
) {
  let calls = 0;
  const holder: { gate: Gate | null } = { gate: null };
  let inflightCall = -1;
  let ordinal = 0;
  for (const step of steps) {
    if (step.kind === 'advance' || step.kind === 'inflight') {
      if (step.kind === 'inflight' && inflightCall < 0) inflightCall = ordinal;
      ordinal += 1;
    }
  }
  const script: Script = () => {
    const index = calls;
    calls += 1;
    if (index === inflightCall) {
      const current = makeGate();
      holder.gate = current;
      return Promise.resolve().then(() => { current.enter(); return current.promise; });
    }
    return answers[index] ?? answers[answers.length - 1]!;
  };
  const initial = gameWith(script, { food });
  submit(initial);
  let current = initial;
  let requests = store(initial);
  const factsAt: Facts[] = [];
  const contractAt: Record<string, unknown>[] = [];
  if (restored) {
    const resumed = await saveAndRestore(root, `${tag}-init`, current, script);
    current = resumed.game;
    requests = resumed.requests;
  }
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]!;
    if (step.kind === 'advance') {
      await current.advance();
    } else if (step.kind === 'eat') {
      current.playerLine('player eat');
    } else if (step.kind === 'time') {
      current.worldAdvanceTime(1);
    } else {
      const pending = current.advance();
      const active = holder.gate;
      assert.ok(active, 'the in-flight provider gate must be armed');
      await active.entered;
      if (step.during === 'eat') current.playerLine('player eat');
      else current.worldAdvanceTime(1);
      active.release(step.release);
      await pending;
    }
    factsAt.push(facts(current, requests));
    contractAt.push(contractFacts(current, requests));
    if (restored && index < steps.length - 1) {
      const resumed = await saveAndRestore(root, `${tag}-step-${index}`, current, script);
      current = resumed.game;
      requests = resumed.requests;
    }
  }
  return { factsAt, contractAt };
}

test('F7: six short sequences are judged by the contract first, then continuous == resumed', async () => {
  const root = tempRoot('f7');
  try {
    const cases: {
      name: string;
      steps: Step[];
      answers: string[];
      food?: number;
      check: (index: number, facts: Record<string, unknown>) => void;
    }[] = [
      {
        name: 'yield-wait-player eat',
        steps: [{ kind: 'advance' }, { kind: 'advance' }, { kind: 'eat' }],
        answers: ['{"goal":"yield_once"}', '{"type":"wait"}'],
        check: (index, value) => {
          if (index !== 2) return;
          assert.equal(value.outcome, 'fulfilled');
          assert.equal(value.selectedGoalReached, true);
          assert.equal(value.hungerNeedSatisfied, false);
        },
      },
      {
        name: 'yield-NPC-eats-first',
        steps: [{ kind: 'advance' }, { kind: 'advance' }, { kind: 'eat' }],
        answers: ['{"goal":"yield_once"}', '{"type":"eat"}'],
        check: (index, value) => {
          if (index === 0) return;
          assert.equal(value.outcome, 'violated');
          assert.equal(value.selectedGoalReached, false);
        },
      },
      {
        name: 'pre-acceptance-player-eat',
        steps: [{ kind: 'inflight', during: 'eat', release: '{"goal":"yield_once"}' }, { kind: 'advance' }],
        answers: ['{"goal":"yield_once"}', '{"type":"eat"}'],
        food: 2,
        check: (index, value) => {
          if (index === 0) {
            assert.equal(value.acceptedAfterSeq, 1);
            assert.equal(value.acceptedAfterSeqBinding, 1);
            assert.equal(value.outcome, 'pending', 'the eat before acceptance proves nothing');
          } else {
            assert.equal(value.outcome, 'violated');
          }
        },
      },
      {
        name: 'goal-in-flight-expiry',
        steps: [{ kind: 'inflight', during: 'time', release: '{"goal":"yield_once"}' }],
        answers: ['{"goal":"yield_once"}'],
        check: (index, value) => {
          if (index !== 0) return;
          assert.equal(value.bindingGoal, null);
          assert.equal(value.sessionStatus, 'failed');
          assert.equal(value.providerCalls, 1);
        },
      },
      {
        name: 'action-in-flight-expiry',
        steps: [{ kind: 'advance' }, { kind: 'inflight', during: 'time', release: '{"type":"wait"}' }],
        answers: ['{"goal":"yield_once"}', '{"type":"wait"}'],
        check: (index, value) => {
          if (index !== 1) return;
          assert.equal(value.bindingGoal, 'yield_once');
          assert.equal(value.sessionStatus, 'failed');
          assert.equal(value.wake, null);
          assert.equal(value.providerCalls, 2);
        },
      },
    ];
    for (const scenario of cases) {
      const slug = scenario.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const continuous = await runTrajectory(`c-${slug}`, scenario.steps, false, root, scenario.answers, scenario.food ?? 1);
      const resumed = await runTrajectory(`r-${slug}`, scenario.steps, true, root, scenario.answers, scenario.food ?? 1);
      for (let index = 0; index < scenario.steps.length; index += 1) {
        scenario.check(index, continuous.contractAt[index]!);
        scenario.check(index, resumed.contractAt[index]!);
        assert.deepEqual(
          resumed.factsAt[index], continuous.factsAt[index],
          `${scenario.name}: step ${index} semantic state diverged between continuous and resumed`,
        );
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('F7b: post-acceptance continuation across processes equals the continuous run', async () => {
  const root = tempRoot('f7b');
  const http = await loopback(yieldWaitAnswer);
  try {
    // Continuous: goal yield -> stop -> player eat (all in one controller).
    const game = gameWith(input => (input.goalChoice === undefined ? '{"type":"stop"}' : '{"goal":"yield_once"}'));
    submit(game);
    await game.advance();
    await game.advance();
    game.playerLine('player eat');
    const continuous = contractFacts(game, store(game));

    // Resumed: every boundary crosses a NEW node process.
    const common = ['--goals', 'negotiated', '--candidates', 'choice', '--live', '--http', http.url, '--model', 'loopback-model'];
    const created = await cli(['--new', '--root', root, '--slot', 'f7b', ...common, '--request', 'npc_a=yield_once', '--step', '--save-as', 'f7b-goal']);
    assert.equal(created.code, 0, created.stderr);
    const stopped = await cli(['--load', '--path', savedSlot(root, 'f7b-goal'), '--live', '--http', http.url, '--model', 'loopback-model', '--step', '--save-as', 'f7b-stop']);
    assert.equal(stopped.code, 0, stopped.stderr);
    const eaten = await cli(['--load', '--path', savedSlot(root, 'f7b-stop'), '--live', '--http', http.url, '--model', 'loopback-model', '--eat', '--save-as', 'f7b-eat']);
    assert.equal(eaten.code, 0, eaten.stderr);
    const payload = envelope(savedSlot(root, 'f7b-eat'));
    const request = payload.requests.requests['f7b-req-1'];
    const session = sessionPayload(payload);
    assert.equal(request.status, 'accepted');
    assert.equal(request.outcome, 'fulfilled');
    assert.equal(request.acceptedAfterSeq, continuous.acceptedAfterSeq);
    assert.equal(session.goalBinding.goal, continuous.bindingGoal);
    assert.equal(session.goalBinding.acceptedAfterSeq, continuous.acceptedAfterSeqBinding);
    assert.deepEqual([...payload.requests.processed].sort(), [request.requestId]);
    assert.ok(Array.isArray(continuous.processed) && continuous.processed.length === 1);
    assert.equal(session.providerCalls, 2, 'goal + action, then zero calls on load/eat');
  } finally {
    await http.close();
    rmSync(root, { recursive: true, force: true });
  }
});
