/**
 * G09 worker D tests — the frozen matrix, the runner and the read-only
 * verifier (legal batch passes, every contradiction is rejected).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  G09_CELLS, canonical, deriveG09Ledger, g09InitialState, g09Plan, readG09Batch, verifyG09Batch, verifyG09Prefix,
} from '../scripts/g09-eval-lib';
import { G09_HARD_CHAT_LIMIT, G09_REQUEST_TEXT } from '../src/negotiation/contracts';

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-g09-eval-'));
}

function runEval(root: string, batch: string, extra: string[] = []): { code: number; out: string } {
  try {
    const out = execFileSync(process.execPath, ['dist/scripts/eval-g09.js', '--out', root, '--batch', batch, '--fake', ...extra], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return { code: failure.status ?? 1, out: `${failure.stdout ?? ''}${failure.stderr ?? ''}` };
  }
}

function editJson(path: string, mutate: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  mutate(value);
  writeFileSync(path, JSON.stringify(value, null, 2));
}

test('the plan is frozen: 8 episodes, four cells, two reps, 16 chats', () => {
  const plan = g09Plan('b');
  assert.equal(plan.plan.length, 8);
  assert.equal(plan.hardChatLimit, G09_HARD_CHAT_LIMIT);
  assert.deepEqual(plan.plan.map(entry => entry.cell), [
    's40-self_only', 's40-choice', 's60-self_only', 's60-choice',
    's40-self_only', 's40-choice', 's60-self_only', 's60-choice',
  ]);
  assert.deepEqual(plan.plan.map(entry => entry.episodeId).slice(0, 4), [
    'g09-r1-s40-self_only', 'g09-r1-s40-choice', 'g09-r1-s60-self_only', 'g09-r1-s60-choice',
  ]);
  // Every cell appears exactly twice, at both satieties, with both arms.
  for (const cell of G09_CELLS) {
    assert.equal(plan.plan.filter(entry => entry.cell === cell.cell).length, 2);
  }
  // The choice arm names its request; self_only has none.
  assert.equal(plan.plan.find(entry => entry.cell === 's40-choice')?.requestId, 'g09-r1-s40-choice-req-1');
  assert.equal(plan.plan.find(entry => entry.cell === 's40-self_only')?.requestId, null);
  // The world: one food, the cell's satiety, the player passive.
  const state = g09InitialState(60);
  assert.equal(state.food.kitchen, 1);
  assert.equal(state.npcs.npc_a.hunger, 60);
  assert.equal(state.npcs.npc_b.hunger, 20);
});

test('a legal fake batch passes: 8/8, 16 chats, goal then action costs', () => {
  const root = tempRoot();
  try {
    const run = runEval(root, 'legal');
    assert.equal(run.code, 0, run.out);
    const verify = verifyG09Batch(join(root, 'legal'));
    assert.deepEqual(verify.issues, []);
    assert.equal(verify.ok, true);
    assert.equal(verify.complete, true);
    assert.equal(verify.derivation.protocol.completed, 8);
    assert.equal(verify.derivation.protocol.goalPhases, 8);
    assert.equal(verify.derivation.protocol.actionPhases, 8);
    assert.equal(verify.derivation.costs.chatRequests, 16);
    assert.equal(verify.derivation.costs.goalTokens, 480);
    assert.equal(verify.derivation.costs.actionTokens, 480);
    // The reference yields in choice and eats everything: every promise broke.
    assert.equal(verify.derivation.goals.yield_once, 4);
    assert.equal(verify.derivation.goals.feed_self, 4);
    assert.equal(verify.derivation.fulfilment.byCell['s40-choice']!.violated, 2);
    assert.equal(verify.derivation.fulfilment.byCell['s40-self_only']!.not_applicable, 2);
    // The prefix gate proves the first pair.
    assert.equal(verifyG09Prefix(join(root, 'legal')).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a promise that is actually kept counts as fulfilled', () => {
  const root = tempRoot();
  try {
    // The NPC stops instead of eating: the player's eat succeeds.
    const run = runEval(root, 'kept', ['--fake-action', '{"type":"stop"}']);
    assert.equal(run.code, 0, run.out);
    const verify = verifyG09Batch(join(root, 'kept'));
    assert.equal(verify.ok, true, verify.issues.join('; '));
    assert.equal(verify.derivation.fulfilment.byCell['s40-choice']!.fulfilled, 2);
    assert.equal(verify.derivation.fulfilment.byCell['s60-choice']!.fulfilled, 2);
    assert.equal(verify.derivation.fulfilment.byCell['s40-choice']!.violated, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tampered summary cannot vouch for itself', () => {
  const root = tempRoot();
  try {
    assert.equal(runEval(root, 'tamper-sum').code, 0);
    const dir = join(root, 'tamper-sum');
    editJson(join(dir, 'summary.json'), summary => {
      summary.protocol = { planned: 8, completed: 8, failed: 0, notRun: 0, goalPhases: 8, actionPhases: 8 };
      (summary.costs as Record<string, unknown>).chatRequests = 999;
      (summary.goals as Record<string, unknown>).yield_once = 0;
      (summary.fulfilment as Record<string, unknown>).byCell = {};
      summary.episodes = [];
    });
    const verify = verifyG09Batch(dir);
    assert.equal(verify.ok, false);
    for (const fragment of ['summary.costs', 'summary.goals', 'summary.fulfilment', 'summary.episodes']) {
      assert.ok(verify.issues.some(issue => issue.includes(fragment)), `${fragment}: ${verify.issues.join('; ')}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a goal answer that no longer matches the raw response is rejected', () => {
  const root = tempRoot();
  try {
    assert.equal(runEval(root, 'tamper-goal').code, 0);
    const dir = join(root, 'tamper-goal');
    // exchange.raw is the model's verbatim answer content.
    editJson(join(dir, 'episodes', 'g09-r1-s40-choice.json'), record => {
      const http = record.http as { stage: string; raw: string }[];
      http.find(exchange => exchange.stage === 'goal')!.raw = '{"goal":"feed_self"}';
    });
    const verify = verifyG09Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.some(issue => issue.includes('goal exchange raw differs from the binding raw')), verify.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an action that no longer matches the ledger is rejected by re-execution', () => {
  const root = tempRoot();
  try {
    assert.equal(runEval(root, 'tamper-action').code, 0);
    const dir = join(root, 'tamper-action');
    editJson(join(dir, 'episodes', 'g09-r1-s40-self_only.json'), record => {
      const http = record.http as { stage: string; raw: string }[];
      http.find(exchange => exchange.stage === 'action')!.raw = '{"type":"stop"}';
    });
    const verify = verifyG09Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.some(issue => issue.includes('action exchange raw differs')), verify.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a forged verdict or a dropped ledger command is rejected', () => {
  const root = tempRoot();
  try {
    assert.equal(runEval(root, 'forged').code, 0);
    const dir = join(root, 'forged');
    // 1. Forged verdict.
    editJson(join(dir, 'episodes', 'g09-r1-s40-choice.json'), record => {
      (record.fulfilment as { verdict: string }).verdict = 'fulfilled';
    });
    assert.equal(verifyG09Batch(dir).ok, false);
    // 2. Dropped npc eat command: the re-execution and the action no longer agree.
    editJson(join(dir, 'episodes', 'g09-r1-s60-self_only.json'), record => {
      const snapshot = record.snapshot as { commands: { command: { actorId: string } }[] };
      snapshot.commands = snapshot.commands.filter(entry => entry.command.actorId !== 'npc_a');
    });
    const verify = verifyG09Batch(dir);
    assert.equal(verify.ok, false);
    assert.ok(verify.issues.some(issue => issue.includes('no eat command') || issue.includes('re-execut')), verify.issues.join('; '));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a truncated batch is never complete, and the ledger charges every begin', () => {
  const root = tempRoot();
  try {
    assert.equal(runEval(root, 'cut').code, 0);
    const dir = join(root, 'cut');
    rmSync(join(dir, 'episodes', 'g09-r2-s60-choice.json'));
    const verify = verifyG09Batch(dir);
    assert.equal(verify.ok, false);
    assert.equal(verify.complete, false);

    // 8 begins / 7 finishes: spent charges begins, usage stays unknown.
    rmSync(join(dir, 'attempts', `${readdirSync(join(dir, 'attempts')).filter(n => n.endsWith('.finish.json'))[0]!.replace('.finish.json', '')}.finish.json`));
    const led = handle(() => deriveG09Ledger(dir, readG09Batch(dir).episodes));
    assert.equal(led.begins, 16);
    assert.equal(led.finishes, 15);
    assert.equal(led.unresolved, 1);
    assert.equal(led.usageUnknown, true);
    assert.equal(led.knownTokenSum, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function handle<T>(fn: () => T): T {
  return fn();
}

test('the request text in an episode is the frozen one', () => {
  const root = tempRoot();
  try {
    assert.equal(runEval(root, 'text').code, 0);
    const batch = readG09Batch(join(root, 'text'));
    const choice = batch.episodes.find(record => record.cell === 's40-choice')!;
    assert.equal(choice.request?.text, G09_REQUEST_TEXT);
    assert.equal(canonical(choice.request?.options), canonical(['feed_self', 'yield_once']));
    const self = batch.episodes.find(record => record.cell === 's40-self_only')!;
    assert.equal(self.request, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
