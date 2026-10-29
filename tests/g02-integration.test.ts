import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { initialWorld, replay } from '../src';
import { createReferenceProvider } from '../src/agent';
import {
  createPlayGame, runScenario, saveGameRecord,
} from '../src/play';
import { scripted } from './agent-helpers';

function gate() {
  let release: (value: string) => void = () => {};
  let calls = 0;
  return {
    calls: () => calls,
    release(value: string) { release(value); },
    provider: {
      decide() {
        calls += 1;
        return new Promise<string>(resolve => { release = resolve; });
      },
    },
  };
}

test('S1 fixture: no intervention, A move+eat, hunger 40→70, scenario pass is its own field', async () => {
  const judged = await runScenario({
    scenarioId: 's1',
    provider: createReferenceProvider(),
    batchId: 's1-fixture',
    thinking: true,
    mode: 'fixture',
    now: () => 0,
  });
  assert.equal(judged.scenarioPass, true, judged.reasons.join('\n'));
  assert.equal(judged.goalReached, true);
  assert.equal(judged.record.scenarioPass, true);
  assert.equal(judged.record.outcome, 'goal_reached');
  assert.equal(judged.record.finalState.npcs.npc_a.hunger, 70);
  assert.equal(judged.record.finalState.food.kitchen, 0);
  assert.deepEqual(judged.record.commands.map(entry => `${entry.role}:${entry.command.commandId}:${entry.command.type}`), [
    'npc:s1-fixture:npc:1:move',
    'npc:s1-fixture:npc:2:eat',
  ]);
  assert.equal(judged.record.commands.some(entry => entry.role === 'player'), false);
});

test('S2 fixture: player eats before A observes, A stops, hunger stays 40, stop is not the goal', async () => {
  const judged = await runScenario({
    scenarioId: 's2',
    provider: createReferenceProvider(),
    batchId: 's2-fixture',
    thinking: false,
    mode: 'fixture',
    now: () => 0,
  });
  assert.equal(judged.scenarioPass, true, judged.reasons.join('\n'));
  assert.equal(judged.goalReached, false);
  assert.equal(judged.record.scenarioPass, true);
  assert.notEqual(judged.record.scenarioPass, judged.record.goalReached);
  assert.equal(judged.record.outcome, 'stopped');
  assert.equal(judged.record.finalState.npcs.npc_a.hunger, 40);
  assert.equal(judged.record.finalState.npcs.npc_b.hunger, 50);
  assert.equal(judged.record.finalState.food.kitchen, 0);
  const playerEat = judged.record.commands.find(entry => entry.role === 'player' && entry.command.type === 'eat');
  const npcMove = judged.record.commands.find(entry => entry.role === 'npc' && entry.command.type === 'move');
  assert.ok(playerEat && npcMove);
  assert.ok(playerEat.exec.seq < npcMove.exec.seq);
  assert.equal(playerEat.command.actorId, 'npc_b');
  assert.equal(playerEat.command.commandId, 's2-fixture:player:2');
  assert.equal(npcMove.command.commandId, 's2-fixture:npc:1');
  assert.equal(judged.record.commands.some(entry => entry.role === 'npc' && entry.command.type === 'eat'), false);
  const stop = judged.record.decisions.find(decision => decision.step?.parse.ok && decision.step.parse.action.type === 'stop');
  assert.equal(stop?.step?.observation.location, 'kitchen');
  assert.equal(stop?.step?.observation.foodHere, 0);
});

test('S3 fixture: stale kitchen observe, B eats first, A gets NO_FOOD then a fresh observe and stops', async () => {
  const judged = await runScenario({
    scenarioId: 's3',
    provider: createReferenceProvider(),
    batchId: 's3-fixture',
    thinking: true,
    mode: 'fixture',
    now: () => 0,
  });
  assert.equal(judged.scenarioPass, true, judged.reasons.join('\n'));
  assert.equal(judged.goalReached, false);
  assert.equal(judged.record.scenarioPass, true);
  assert.equal(judged.record.goalReached, false);
  assert.equal(judged.record.outcome, 'stopped');
  assert.equal(judged.record.finalState.npcs.npc_a.hunger, 40);
  assert.deepEqual(replay(judged.record.initialState, judged.record.events), judged.record.finalState);
  assert.equal(judged.record.replayMatches, true);
  const kinds = judged.record.commands.map(entry => `${entry.role}:${entry.command.type}:${entry.exec.status}:${entry.exec.reason ?? ''}`);
  assert.deepEqual(kinds, [
    'npc:move:accepted:',
    'player:move:accepted:',
    'player:eat:accepted:',
    'npc:eat:rejected:NO_FOOD',
  ]);
  const npcEat = judged.record.commands.find(entry => entry.role === 'npc' && entry.command.type === 'eat');
  const playerEat = judged.record.commands.find(entry => entry.role === 'player' && entry.command.type === 'eat');
  assert.ok(npcEat && playerEat);
  assert.ok(playerEat.exec.seq < npcEat.exec.seq);
  assert.equal(npcEat.command.commandId, 's3-fixture:npc:2');
  assert.equal(playerEat.command.commandId, 's3-fixture:player:2');
  const stale = judged.record.decisions.find(decision => decision.step?.exec?.reason === 'NO_FOOD');
  assert.equal(stale?.step?.observation.foodHere, 1);
  const follow = judged.record.decisions[judged.record.decisions.indexOf(stale!) + 1];
  assert.equal(follow.inputFeedback?.reason, 'NO_FOOD');
  assert.equal(follow.step?.observation.foodHere, 0);
  assert.equal(follow.step?.parse.ok && follow.step.parse.action.type, 'stop');
});

test('player commands stay on npc_b and NPC steps stay on npc_a', async () => {
  const game = createPlayGame({
    batchId: 'roles',
    provider: createReferenceProvider(),
    mode: 'fixture',
    now: () => 0,
  });
  const moved = game.playerLine('player move kitchen');
  assert.equal(moved.ok, true);
  if (!moved.ok) return;
  assert.equal(moved.command.actorId, 'npc_b');
  assert.equal(moved.command.commandId, 'roles:player:1');
  assert.equal(game.world.getState().npcs.npc_a.location, 'dorm');
  assert.equal(game.world.getState().npcs.npc_b.location, 'kitchen');
  const step = await game.npcStep();
  assert.equal(step.step?.command?.actorId, 'npc_a');
  assert.equal(step.step?.command?.commandId, 'roles:npc:1');
  assert.equal(JSON.stringify(step.step?.observation).includes('npc_b'), false);
  assert.equal(game.world.getState().npcs.npc_b.location, 'kitchen');
  assert.equal(game.playerLine('player move moon').ok, false);
  assert.equal(game.world.getLog().filter(entry => entry.command.actorId === 'npc_a').length, 1);
});

test('quit waits for the in-flight step, then refuses new commands, and the record replays', async () => {
  const held = gate();
  const game = createPlayGame({
    batchId: 'quit-game',
    provider: held.provider,
    mode: 'fixture',
    now: () => 0,
  });
  const stepping = game.npcStep();
  assert.equal(game.session.status, 'deciding');
  let finished = false;
  const quitting = game.quit().then(record => { finished = true; return record; });
  await Promise.resolve();
  assert.equal(finished, false);
  const refused = game.playerLine('player eat');
  assert.equal(refused.ok, false);
  if (refused.ok) return;
  assert.equal(refused.error, 'closed');
  const blocked = await game.npcStep();
  assert.equal(blocked.providerCalled, false);
  assert.equal(held.calls(), 1);
  held.release('{"type":"stop"}');
  const record = await quitting;
  await stepping;
  assert.equal(finished, true);
  assert.equal(record.commands.some(entry => entry.role === 'player'), false);
  assert.equal(record.outcome, 'stopped');
  assert.equal(record.goalReached, false);
  assert.deepEqual(replay(record.initialState, record.events), record.finalState);
  const dir = saveGameRecord(mkdtempSync(join(tmpdir(), 'frostecho-g02-')), record);
  const events = JSON.parse(readFileSync(join(dir, 'events.json'), 'utf8'));
  const commands = JSON.parse(readFileSync(join(dir, 'commands.json'), 'utf8'));
  assert.deepEqual(events, record.events);
  assert.deepEqual(commands, record.commands);
  assert.equal(JSON.stringify(initialWorld()), JSON.stringify(record.initialState));
});

test('play session budget, busy, and late timeout do not copy a second loop', async () => {
  const script = scripted(Array.from({ length: 8 }, () => '{"type":"fly"}'));
  const budget = createPlayGame({
    batchId: 'play-budget',
    provider: script.provider,
    mode: 'fixture',
    now: () => 0,
  });
  for (let i = 0; i < 5; i++) {
    const step = await budget.npcStep();
    assert.equal(step.providerCalled, true);
  }
  const sixth = await budget.npcStep();
  assert.equal(sixth.providerCalled, false);
  assert.equal(sixth.status, 'budget_exhausted');
  assert.equal(script.calls(), 5);

  const held = gate();
  const busy = createPlayGame({ batchId: 'play-busy', provider: held.provider, mode: 'fixture', now: () => 0 });
  const first = busy.npcStep();
  const second = await busy.npcStep();
  assert.equal(second.status, 'busy');
  assert.equal(held.calls(), 1);
  held.release('{"type":"stop"}');
  assert.equal((await first).status, 'stopped');
  assert.equal(held.calls(), 1);

  let fire: () => void = () => {};
  let late = false;
  const timed = createPlayGame({
    batchId: 'play-late',
    mode: 'fixture',
    now: () => 0,
    timeoutMs: 15000,
    scheduleTimeout(fn) {
      fire = fn;
      return { cancel() {} };
    },
    provider: {
      decide(_input, signal) {
        return new Promise(resolve => {
          signal.addEventListener('abort', () => {
            late = true;
            resolve('{"type":"eat"}');
          });
        });
      },
    },
  });
  const pending = timed.npcStep();
  fire();
  const step = await pending;
  assert.equal(late, true);
  assert.equal(step.status, 'timeout');
  assert.equal(timed.world.getEvents().length, 0);
  assert.equal(timed.world.getState().npcs.npc_a.hunger, 40);
  const record = timed.snapshot();
  assert.equal(record.replayMatches, true);
  assert.equal(record.goalReached, false);
});
