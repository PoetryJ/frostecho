import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Engine, initialWorld, replay, RULES } from '../src';
import { DecideInput, createReferenceProvider, deterministicRecord, runAgent } from '../src/agent';
import { globalChecks } from './helpers';
import { countingWorld, scripted, writeTrace } from './agent-helpers';

function clock(step: number) {
  let t = 0;
  return () => {
    const current = t;
    t += step;
    return current;
  };
}

test('happy path: move then eat, food 1→0, hunger 40→70, replay matches', async () => {
  const eng = new Engine(initialWorld());
  const world = countingWorld(eng);
  const seen: DecideInput[] = [];
  let calls = 0;
  const inner = createReferenceProvider();
  const result = await runAgent({
    world,
    actorId: 'npc_a',
    runId: 'g01-happy',
    now: () => 0,
    provider: {
      decide(input, signal) {
        calls += 1;
        seen.push(structuredClone(input));
        return inner.decide(input, signal);
      },
    },
  });
  assert.equal(result.outcome, 'goal_reached');
  assert.equal(result.goalReached, true);
  assert.equal(calls, 2);
  assert.equal(result.providerCalls, 2);
  assert.equal(world.submits(), 2);
  assert.equal(result.finalState.food.kitchen, 0);
  assert.equal(result.finalState.food.dorm, 0);
  assert.equal(result.finalState.npcs.npc_a.hunger, 70);
  assert.equal(result.finalState.npcs.npc_a.hunger, 40 + RULES.EAT_HUNGER_RESTORE);
  assert.equal(result.finalState.npcs.npc_a.location, 'kitchen');
  assert.deepEqual(result.finalState.npcs.npc_b, { id: 'npc_b', location: 'dorm', hunger: 20 });
  assert.deepEqual(result.events.map(e => e.type), ['NpcMoved', 'FoodConsumed', 'HungerChanged']);
  assert.deepEqual(replay(result.initialState, result.events), result.finalState);
  assert.equal(result.steps[0].observation.location, 'dorm');
  assert.equal(result.steps[0].observation.foodHere, 0);
  assert.equal(result.steps[0].observation.hunger, 40);
  assert.equal(JSON.stringify(result.steps[0].observation).includes('npc_b'), false);
  assert.equal(result.steps[1].observation.location, 'kitchen');
  assert.equal(result.steps[1].observation.foodHere, 1);
  assert.equal(result.steps[1].observation.hunger, 40);
  assert.equal(result.steps[0].raw, '{"type":"move","to":"kitchen"}');
  assert.equal(result.steps[1].raw, '{"type":"eat"}');
  assert.equal(result.steps[0].command?.commandId, 'g01-happy:1');
  assert.equal(result.steps[1].command?.commandId, 'g01-happy:2');
  assert.equal(result.steps[0].command?.actorId, 'npc_a');
  assert.equal(result.steps[1].command?.actorId, 'npc_a');
  assert.equal(result.events[0].commandId, 'g01-happy:1');
  assert.equal(result.events[1].commandId, 'g01-happy:2');
  assert.equal(seen[0].feedback, null);
  assert.equal(seen[1].feedback?.kind, 'accepted');
  assert.equal(JSON.stringify(seen[0]).includes('npc_b'), false);
  assert.equal(JSON.stringify(seen[1]).includes(result.steps[0].raw), false);
  assert.deepEqual(Object.keys(seen[0]).sort(), ['feedback', 'goal', 'observation']);
  assert.equal(eng.getLog().length, 2);
  assert.equal(eng.getLog().every(entry => entry.command.actorId === 'npc_a'), true);
  globalChecks(eng);
  writeTrace('happy-path', result);
});

async function decideOnce(world: ReturnType<typeof initialWorld>): Promise<DecideInput | undefined> {
  const eng = new Engine(world);
  let seen: DecideInput | undefined;
  const result = await runAgent({
    world: countingWorld(eng),
    actorId: 'npc_a',
    runId: 'invisible',
    provider: {
      async decide(input) {
        seen = structuredClone(input);
        return '{"type":"stop"}';
      },
    },
  });
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.goalReached, false);
  assert.deepEqual(result.finalState, result.initialState);
  return seen;
}

test('invisible place food and other NPC attrs do not change the decide input', async () => {
  const base = await decideOnce(initialWorld());
  const hiddenWorld = initialWorld();
  hiddenWorld.food.kitchen = 50;
  hiddenWorld.npcs.npc_b.hunger = 1;
  hiddenWorld.npcs.npc_b.location = 'kitchen';
  hiddenWorld.tick = 9;
  const hidden = await decideOnce(hiddenWorld);
  assert.deepEqual(base, hidden);
  assert.equal(JSON.stringify(base).includes('npc_b'), false);
  const visibleWorld = initialWorld();
  visibleWorld.food.dorm = 3;
  const visible = await decideOnce(visibleWorld);
  assert.equal(visible?.observation.foodHere, 3);
  assert.notDeepEqual(base, visible);
});

test('no kitchen food while already there is a normal stop and is not the goal', async () => {
  const world = initialWorld();
  world.npcs.npc_a.location = 'kitchen';
  world.food.kitchen = 0;
  const eng = new Engine(world);
  const before = eng.getState();
  const port = countingWorld(eng);
  const result = await runAgent({
    world: port,
    provider: createReferenceProvider(),
    actorId: 'npc_a',
    runId: 'no-food',
    now: () => 0,
  });
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.goalReached, false);
  assert.equal(port.submits(), 0);
  assert.equal(result.steps[0].command, undefined);
  assert.equal(result.steps[0].raw, '{"type":"stop"}');
  assert.deepEqual(eng.getState(), before);
  assert.deepEqual(result.events, []);
  writeTrace('no-food-stop', result);
});

test('a model stop from the dorm leaves state unchanged and is not success', async () => {
  const eng = new Engine(initialWorld());
  const before = eng.getState();
  const script = scripted(['{"type":"stop"}']);
  const result = await runAgent({
    world: countingWorld(eng),
    provider: script.provider,
    actorId: 'npc_a',
    runId: 'model-stop',
    now: () => 0,
  });
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.goalReached, false);
  assert.equal(script.calls(), 1);
  assert.deepEqual(eng.getState(), before);
  assert.deepEqual(eng.getEvents(), []);
  writeTrace('model-stop', result);
});

test('empty kitchen from the dorm: reference moves, then stops, hunger stays 40', async () => {
  const world = initialWorld();
  world.food.kitchen = 0;
  const eng = new Engine(world);
  const result = await runAgent({
    world: countingWorld(eng),
    provider: createReferenceProvider(),
    actorId: 'npc_a',
    runId: 'empty-kitchen',
    now: () => 0,
  });
  assert.equal(result.outcome, 'stopped');
  assert.equal(result.goalReached, false);
  assert.equal(result.finalState.npcs.npc_a.location, 'kitchen');
  assert.equal(result.finalState.npcs.npc_a.hunger, 40);
  assert.equal(result.finalState.food.kitchen, 0);
  assert.deepEqual(result.events.map(e => e.type), ['NpcMoved']);
  writeTrace('empty-kitchen-from-dorm', result);
});

test('illegal JSON, illegal action, and forged actorId are not submitted; the next round can recover', async () => {
  const eng = new Engine(initialWorld());
  const seen: DecideInput[] = [];
  const script = scripted([
    'not json',
    '{"type":"fly"}',
    '{"type":"move","to":"kitchen","actorId":"npc_b","commandId":"forged"}',
    '{"type":"move","to":"kitchen"}',
    '{"type":"eat"}',
  ], seen);
  const port = countingWorld(eng);
  const result = await runAgent({
    world: port,
    provider: script.provider,
    actorId: 'npc_a',
    runId: 'recover',
    now: () => 0,
  });
  assert.equal(result.goalReached, true);
  assert.equal(result.outcome, 'goal_reached');
  assert.equal(script.calls(), 5);
  assert.equal(port.submits(), 2);
  assert.equal(result.finalState.food.kitchen, 0);
  assert.equal(result.finalState.npcs.npc_a.hunger, 70);
  assert.equal(seen[1].feedback?.kind, 'invalid_output');
  assert.match(seen[1].feedback?.detail ?? '', /invalid JSON/);
  assert.equal(seen[3].feedback?.kind, 'invalid_output');
  assert.equal(port.commands().every(command => (command as { actorId: string }).actorId === 'npc_a'), true);
  assert.deepEqual(port.commands().map(command => (command as { commandId: string }).commandId), ['recover:4', 'recover:5']);
  assert.equal(eng.getLog().some(entry => entry.command.actorId === 'npc_b'), false);
  assert.equal(result.steps[0].command, undefined);
  assert.equal(result.steps[2].command, undefined);
  writeTrace('illegal-then-correct', result);
});

test('eat in the dorm is rejected, fed back, then move and eat reach the goal', async () => {
  const eng = new Engine(initialWorld());
  const seen: DecideInput[] = [];
  const script = scripted([
    '{"type":"eat"}',
    '{"type":"move","to":"kitchen"}',
    '{"type":"eat"}',
  ], seen);
  const port = countingWorld(eng);
  const result = await runAgent({
    world: port,
    provider: script.provider,
    actorId: 'npc_a',
    runId: 'eat-dorm',
    now: () => 0,
  });
  assert.equal(port.submits(), 3);
  assert.equal(result.steps[0].exec?.status, 'rejected');
  assert.equal(result.steps[0].exec?.reason, 'NOT_IN_KITCHEN');
  assert.equal(seen[1].feedback?.kind, 'rejected');
  assert.equal(seen[1].feedback?.reason, 'NOT_IN_KITCHEN');
  assert.match(seen[1].feedback?.detail ?? '', /NOT_IN_KITCHEN/);
  assert.equal(seen[2].feedback?.kind, 'accepted');
  assert.equal(result.goalReached, true);
  assert.equal(result.finalState.npcs.npc_a.hunger, 70);
  assert.equal(result.finalState.food.kitchen, 0);
  assert.deepEqual(replay(result.initialState, result.events), result.finalState);
  writeTrace('eat-rejected-then-recover', result);
});

test('five consecutive illegal outputs end the run with no world commands', async () => {
  const eng = new Engine(initialWorld());
  const before = eng.getState();
  const lines = [
    'nope',
    '{"type":"fly"}',
    '{"type":"eat","x":1}',
    '{"type":"move","to":"moon"}',
    '{"type":"move","to":"kitchen","actorId":"npc_b"}',
    '{"type":"eat"}',
  ];
  const script = scripted(lines);
  const port = countingWorld(eng);
  const result = await runAgent({
    world: port,
    provider: script.provider,
    actorId: 'npc_a',
    runId: 'budget',
    now: () => 0,
  });
  assert.equal(script.calls(), 5);
  assert.equal(result.providerCalls, 5);
  assert.equal(result.outcome, 'budget_exhausted');
  assert.equal(result.goalReached, false);
  assert.equal(port.submits(), 0);
  assert.deepEqual(eng.getState(), before);
  assert.deepEqual(eng.getEvents(), []);
  writeTrace('budget-illegal', result);
});

test('a late provider response after timeout is not executed', async () => {
  const eng = new Engine(initialWorld());
  const port = countingWorld(eng);
  let late = false;
  const result = await runAgent({
    world: port,
    actorId: 'npc_a',
    runId: 'late',
    timeoutMs: 30,
    now: () => 0,
    provider: {
      decide(_input, signal) {
        return new Promise(resolve => {
          const timer = setTimeout(() => {
            late = true;
            resolve('{"type":"eat"}');
          }, 250);
          signal.addEventListener('abort', () => {
            clearTimeout(timer);
            setTimeout(() => {
              late = true;
              resolve('{"type":"eat"}');
            }, 40);
          });
        });
      },
    },
  });
  assert.equal(late, false);
  assert.equal(result.outcome, 'timeout');
  assert.equal(result.goalReached, false);
  assert.equal(result.error, 'timeout');
  assert.equal(result.steps[0].raw, '');
  assert.equal(result.steps[0].command, undefined);
  assert.equal(port.submits(), 0);
  await new Promise(resolve => setTimeout(resolve, 80));
  assert.equal(late, true);
  assert.equal(port.submits(), 0);
  assert.deepEqual(eng.getEvents(), []);
  assert.equal(eng.getState().npcs.npc_a.hunger, 40);
  writeTrace('timeout-no-execute', result);
});

test('same initial state, runId, and reference policy produce identical actions, events, and final state', async () => {
  const run = (step: number) => {
    const eng = new Engine(initialWorld());
    return runAgent({
      world: countingWorld(eng),
      provider: createReferenceProvider(),
      actorId: 'npc_a',
      runId: 'det-1',
      now: clock(step),
    });
  };
  const first = await run(1);
  const second = await run(5);
  assert.deepEqual(deterministicRecord(first), deterministicRecord(second));
  assert.notDeepEqual(first.timing, second.timing);
  assert.equal(first.goalReached, true);
  assert.deepEqual(first.events, second.events);
  assert.deepEqual(first.finalState, second.finalState);
  assert.deepEqual(replay(first.initialState, first.events), first.finalState);
});

for (const actorId of ['proto', '__proto__']) {
  test(`actorId ${actorId} is not submitted by the runner`, async () => {
    const eng = new Engine(initialWorld());
    const port = countingWorld(eng);
    const result = await runAgent({
      world: port,
      provider: createReferenceProvider(),
      actorId,
      runId: 'proto-run',
    });
    assert.equal(result.outcome, 'invalid_run');
    assert.equal(result.goalReached, false);
    assert.equal(result.providerCalls, 0);
    assert.equal(port.submits(), 0);
    assert.deepEqual(eng.getEvents(), []);
    assert.equal(eng.getLog().length, 0);
  });
}

test('already full hunger is success without a provider call', async () => {
  const world = initialWorld();
  world.npcs.npc_a.hunger = 70;
  const eng = new Engine(world);
  let calls = 0;
  const result = await runAgent({
    world: countingWorld(eng),
    actorId: 'npc_a',
    runId: 'already',
    provider: { async decide() { calls += 1; return '{"type":"eat"}'; } },
  });
  assert.equal(calls, 0);
  assert.equal(result.outcome, 'goal_reached');
  assert.equal(result.goalReached, true);
  assert.equal(result.providerCalls, 0);
  assert.deepEqual(result.finalState, result.initialState);
});
