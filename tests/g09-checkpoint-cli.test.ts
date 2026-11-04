/**
 * G09 worker C tests — the goal-choice save slot and the playable CLI.
 *
 * Restore is data-only: zero provider calls and no re-choice.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { buildNeedsWorld, createNeedsGame } from '../src/needs/game';
import { createG09ReferenceProvider } from '../src/negotiation/reference';
import {
  g09CheckpointPath, loadG09Checkpoint, restoreG09Game, saveG09Checkpoint,
} from '../src/negotiation/checkpoint';
import { createGoalRequest } from '../src/negotiation/requests';
import {
  G09_CHECKPOINT_SCHEMA, G09_REQUEST_TEXT, G09_SESSION_SCHEMA,
  type GoalRequestSnapshot, type SatietyLevel,
} from '../src/negotiation/contracts';
import type { G08EffectiveConfig } from '../src/temporal/contracts';
import type { GoalProtocolOptions } from '../src/agent/contracts';

const CONFIG: G08EffectiveConfig = { mode: 'reference', requestModel: null, thinking: true, timeoutMs: 120000 };

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), 'frostecho-g09-slot-'));
}

function world(satiety: SatietyLevel) {
  return buildNeedsWorld({ actorIds: ['npc_a'], kitchenFood: 1, hunger: { npc_a: satiety, npc_b: 20, npc_c: 40 } });
}

function protocol(overrides: Partial<GoalProtocolOptions> = {}): GoalProtocolOptions {
  return {
    arm: 'choice', requestId: 'req-1', text: G09_REQUEST_TEXT,
    options: ['feed_self', 'yield_once'], deadlineAfterRound: 1, playerId: 'npc_b', ...overrides,
  };
}

function newGame(satiety: SatietyLevel, goalAnswer: 'feed_self' | 'yield_once', proto = protocol()) {
  const provider = createG09ReferenceProvider({ goal: goalAnswer });
  const game = createNeedsGame({
    episodeId: 'g09-play',
    initialState: world(satiety),
    actorIds: ['npc_a'],
    providerFor: () => provider,
    mode: 'reference',
    thinking: true,
    needPolicy: 'one-shot',
    timeoutMs: 120000,
    actionSet: 'legacy',
    goalProtocol: proto,
  });
  return game;
}

function choiceRequest(episodeId: string): GoalRequestSnapshot {
  const built = createGoalRequest({
    requestId: 'req-1', episodeId, to: 'npc_a', text: G09_REQUEST_TEXT,
    options: ['feed_self', 'yield_once'], createdAtSimTime: 0, arm: 'choice',
  });
  assert.ok(built.ok);
  return built.value;
}

test('a decided slot round-trips: schema, request, binding, config', async () => {
  const root = tempRoot();
  try {
    const game = newGame(40, 'yield_once');
    await game.advance(); // goal phase
    const binding = game.sessionsOf()[0]!.session.goalBinding;
    assert.equal(binding?.goal, 'yield_once');
    const request = { ...choiceRequest('g09-play'), status: 'accepted' as const, decision: { goal: 'yield_once' as const, round: 1, raw: '{"goal":"yield_once"}' } };
    const saved = saveG09Checkpoint(root, 'slot-a', game, { arm: 'choice', satiety: 40, request, binding }, CONFIG);
    assert.ok(saved.ok, saved.ok ? '' : saved.issues?.join('; '));

    const loaded = loadG09Checkpoint(g09CheckpointPath(root, 'slot-a'));
    assert.ok(loaded.ok);
    assert.equal(loaded.value.envelope.schema, G09_CHECKPOINT_SCHEMA);
    assert.equal(loaded.value.envelope.arm, 'choice');
    assert.equal(loaded.value.envelope.satiety, 40);
    assert.equal(loaded.value.envelope.binding?.goal, 'yield_once');
    assert.deepEqual(loaded.value.envelope.effectiveConfig, CONFIG);
    // The embedded sessions are G09 format.
    const session = loaded.value.envelope.game.cycles.npc_a?.[0]?.session as { schema?: string } | undefined;
    assert.equal(session?.schema, G09_SESSION_SCHEMA);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('restore spends ZERO provider calls and never re-chooses', async () => {
  const root = tempRoot();
  try {
    const game = newGame(40, 'yield_once');
    await game.advance();
    const binding = game.sessionsOf()[0]!.session.goalBinding;
    const request = { ...choiceRequest('g09-play'), status: 'accepted' as const, decision: { goal: 'yield_once' as const, round: 1, raw: '{"goal":"yield_once"}' } };
    assert.ok(saveG09Checkpoint(root, 'slot-b', game, { arm: 'choice', satiety: 40, request, binding }, CONFIG).ok);

    const loaded = loadG09Checkpoint(g09CheckpointPath(root, 'slot-b'));
    assert.ok(loaded.ok);
    let called = 0;
    const restored = restoreG09Game(loaded.value, {
      providerFor: () => ({ decide: async () => { called += 1; return '{"type":"stop"}'; } }),
      now: Date.now,
      playerId: 'npc_b',
    });
    assert.ok(restored.ok, restored.ok ? '' : restored.issues?.join('; '));
    assert.equal(called, 0, 'restore must not call the provider');
    const session = restored.value.game.sessionsOf()[0]!.session;
    assert.equal(session.phase, 'action');
    assert.equal(session.goalBinding?.goal, 'yield_once');
    assert.equal(session.providerCalls, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a pending slot restores into the goal phase (choice not yet made)', () => {
  const root = tempRoot();
  try {
    const game = newGame(60, 'feed_self');
    const saved = saveG09Checkpoint(root, 'slot-c', game, { arm: 'choice', satiety: 60, request: choiceRequest('g09-play'), binding: null }, CONFIG);
    assert.ok(saved.ok, saved.ok ? '' : saved.issues?.join('; '));
    const loaded = loadG09Checkpoint(g09CheckpointPath(root, 'slot-c'));
    assert.ok(loaded.ok);
    const restored = restoreG09Game(loaded.value, { providerFor: () => createG09ReferenceProvider(), now: Date.now });
    assert.ok(restored.ok, restored.ok ? '' : restored.issues?.join('; '));
    assert.equal(restored.value.game.sessionsOf()[0]!.session.phase, 'goal_choice');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the self_only slot carries no request and a feed_self binding', async () => {
  const root = tempRoot();
  try {
    const game = newGame(40, 'feed_self', protocol({ arm: 'self_only', requestId: null, options: ['feed_self'] }));
    await game.advance();
    const binding = game.sessionsOf()[0]!.session.goalBinding;
    assert.equal(binding?.goal, 'feed_self');
    assert.equal(binding?.requestId, null);
    const saved = saveG09Checkpoint(root, 'slot-d', game, { arm: 'self_only', satiety: 40, request: null, binding }, CONFIG);
    assert.ok(saved.ok, saved.ok ? '' : saved.issues?.join('; '));
    const loaded = loadG09Checkpoint(g09CheckpointPath(root, 'slot-d'));
    assert.ok(loaded.ok);
    assert.equal(loaded.value.envelope.request, null);
    const restored = restoreG09Game(loaded.value, { providerFor: () => createG09ReferenceProvider(), now: Date.now });
    assert.ok(restored.ok);
    assert.equal(restored.value.game.sessionsOf()[0]!.session.goalBinding?.goal, 'feed_self');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('tampered or inconsistent slots are rejected before touching a game', async () => {
  const root = tempRoot();
  try {
    const game = newGame(40, 'yield_once');
    await game.advance();
    const binding = game.sessionsOf()[0]!.session.goalBinding!;
    const request = { ...choiceRequest('g09-play'), status: 'accepted' as const, decision: { goal: 'yield_once' as const, round: 1, raw: '{"goal":"yield_once"}' } };
    assert.ok(saveG09Checkpoint(root, 'slot-e', game, { arm: 'choice', satiety: 40, request, binding }, CONFIG).ok);
    const path = g09CheckpointPath(root, 'slot-e');

    // 1. Corrupt payload byte: the slot checksum catches it.
    const raw = JSON.parse(readFileSync(path, 'utf8')) as { sha256: string };
    writeFileSync(path, readFileSync(path, 'utf8').replace(/"goal": "yield_once"/, '"goal": "feed_self"'));
    assert.equal(loadG09Checkpoint(path).ok, false);

    // 2. Rewrite with a consistent checksum but a binding whose raw says feed_self.
    const original = JSON.parse(readFileSync(path, 'utf8')) as { payload: { binding: { raw: string } }; createdAt: string };
    original.payload.binding.raw = '{"goal":"feed_self"}';
    const { createHash } = await import('node:crypto');
    const canonical = (value: unknown): string => JSON.stringify(value, (_k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, (v as Record<string, unknown>)[k]])) : v));
    (original as unknown as { sha256: string }).sha256 = createHash('sha256').update(canonical(original.payload)).digest('hex');
    writeFileSync(path, JSON.stringify(original, null, 2) + '\n');
    const loaded = loadG09Checkpoint(path);
    assert.equal(loaded.ok, false, 'a binding that does not parse to its goal must be refused');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the CLI: new -> goal -> save -> load spends nothing and never re-chooses', () => {
  const root = tempRoot();
  try {
    const cli = (...args: string[]) => execFileSync(process.execPath, ['dist/scripts/play-g09.js', '--root', root, ...args], { encoding: 'utf8' });
    const created = cli('--new', '--slot', 'play', '--arm', 'choice', '--satiety', '40', '--goal-answer', 'yield_once', '--goal', '--save');
    assert.match(created, /goal phase: yield_once/);
    assert.match(created, /saved -> /);

    const status = cli('--load', '--slot', 'play', '--status');
    assert.match(status, /zero provider calls, no re-choice/);
    assert.match(status, /phase=action calls=1/);

    const again = cli('--load', '--slot', 'play', '--goal');
    assert.match(again, /goal already decided/);
    assert.match(again, /phase=action calls=1/, 'asking for the goal again must not spend a call');

    const stepped = cli('--load', '--slot', 'play', '--step', '--player-eat');
    assert.match(stepped, /phase=action calls=2/);
    assert.match(stepped, /NO_FOOD/, 'the reference NPC ate first, so the player finds no food');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
