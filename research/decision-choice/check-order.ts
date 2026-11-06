/**
 * Zero-model-call order-swap self-check (worker D of the G11-live resume).
 *
 * authorizedCalls = 0. This script never constructs a provider, never opens a
 * socket, never reads a ledger and never touches artifacts/. It renders the
 * PRODUCTION goal prompt twice per context (forward and reverse candidate
 * order) through the same function the HTTP provider uses, and asserts the
 * invariants that must hold BEFORE anyone is allowed to spend a real call:
 *
 *   a1  swapping the order does not change the ID -> target mapping
 *   a5  the PRODUCTION parser (strictGoalChoice) is the thing that binds a raw
 *       answer to a goal, and the production threshold is GOAL_HUNGER_AT_LEAST
 *       (70) — 90 is the observed terminal state, not the threshold
 *   a2  the prompt leaks no future outcome and no hidden NPC state
 *   a3  the render is byte-reproducible
 *   a4  the reverse order is the exact reversal and every other line is identical
 *
 * Run (the project tsconfig does not include research/, so compile explicitly):
 *   node_modules/.bin/tsc research/decision-choice/check-order.ts \
 *     --outDir /tmp/dd --rootDir . --target ES2022 --module commonjs \
 *     --strict --esModuleInterop --skipLibCheck
 *   node /tmp/dd/research/decision-choice/check-order.js
 */
import { createHash } from 'node:crypto';
import { renderDecidePrompt } from '../../src/agent/providers/http';
import type { DecideInput } from '../../src/agent/contracts';
import { G09_ALLOWED_GOALS, G09_REQUEST_TEXT, strictGoalChoice, type GoalChoiceId } from '../../src/negotiation/contracts';
import { GOAL_HUNGER_AT_LEAST } from '../../src/agent/contracts';
import type { Location } from '../../src/types';

const ACTOR = 'npc_a';
const FORWARD: readonly GoalChoiceId[] = G09_ALLOWED_GOALS.choice;
const REVERSE: readonly GoalChoiceId[] = [...FORWARD].reverse();

/** The canonical meaning of each ID: order must never change this mapping. */
const CANONICAL: Readonly<Record<GoalChoiceId, string>> = {
  yield_once: '把这份食物让给玩家，直到请求到期',
  feed_self: '先满足自己的饱食',
};

interface Context {
  id: string;
  location: Location;
  hunger: number;
  foodHere: number;
  reachable: Location[];
  /** Which order is presented first in the (unauthorized) proposal. */
  firstPresentation: 'forward' | 'reverse';
  why: string;
}

/** Four contexts that the OLD contracts already allow to occur. */
const CONTEXTS: readonly Context[] = [
  {
    id: 'ctx-kitchen-food-hunger40',
    location: 'kitchen', hunger: 40, foodHere: 1, reachable: ['dorm', 'kitchen'],
    firstPresentation: 'forward',
    why: 'RULES.EAT: kitchen with food, hunger below the goal — the canonical yield/feed_self tension',
  },
  {
    id: 'ctx-kitchen-empty-hunger40',
    location: 'kitchen', hunger: 40, foodHere: 0, reachable: ['dorm', 'kitchen'],
    firstPresentation: 'reverse',
    why: 'the action prompt itself names this case (kitchen, foodHere 0): the request cannot be met at all',
  },
  {
    id: 'ctx-dorm-hunger40',
    location: 'dorm', hunger: 40, foodHere: 0, reachable: ['dorm', 'kitchen'],
    firstPresentation: 'forward',
    why: 'food is only observable at the current location, so a dorm actor sees foodHere 0',
  },
  {
    id: 'ctx-kitchen-food-hunger90',
    location: 'kitchen', hunger: 90, foodHere: 1, reachable: ['dorm', 'kitchen'],
    firstPresentation: 'reverse',
    why: 'hunger already at RULES.HUNGER_GOAL: maximizing satiety no longer explains a choice',
  },
];

const inputFor = (context: Context, options: readonly GoalChoiceId[]): DecideInput => ({
  observation: {
    id: ACTOR,
    location: context.location,
    hunger: context.hunger,
    foodHere: context.foodHere,
    reachable: context.reachable,
  },
  // The PRODUCTION threshold is GOAL_HUNGER_AT_LEAST (70). 90 is the observed
  // terminal satiety after two +30 eats, not the decision threshold.
  goal: { hungerAtLeast: GOAL_HUNGER_AT_LEAST },
  feedback: null,
  goalChoice: {
    simTime: 1,
    arm: 'choice',
    requestId: 'req-order-check',
    text: G09_REQUEST_TEXT,
    options,
    expiresAtSimTime: 2,
    playerId: 'player',
  },
});

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

const lines = (prompt: string): string[] => prompt.split('\n');

/** The single candidate line, parsed back into the IDs the model would see. */
function candidateIds(prompt: string): string[] {
  const line = lines(prompt).find(entry => entry.startsWith('candidateGoals: '));
  if (line === undefined) throw new Error('no candidateGoals line');
  const parsed = JSON.parse(line.slice('candidateGoals: '.length)) as unknown;
  if (!Array.isArray(parsed)) throw new Error('candidateGoals is not an array');
  return parsed as string[];
}

const withoutCandidateLine = (prompt: string): string[] =>
  lines(prompt).filter(line => !line.startsWith('candidateGoals: '));

/** Words that would leak a future outcome or hidden state into the decision. */
const FORBIDDEN: readonly { token: string; why: string }[] = [
  { token: 'fulfilled', why: 'a future settlement outcome' },
  { token: 'expired', why: 'a future settlement outcome' },
  { token: 'goal_reached', why: 'an internal cycle turn status' },
  { token: 'waiting_time', why: 'an internal cycle turn status' },
  { token: 'outcome', why: 'settlement bookkeeping' },
  { token: 'npc_b', why: 'another actor' },
  { token: 'player:', why: 'the other actor command id' },
  { token: 'cancel', why: 'session lifecycle internals' },
  { token: 'attemptId', why: 'budget bookkeeping' },
];

function main(): number {
  let passes = 0;
  const failures: string[] = [];
  const check = (name: string, body: () => void): void => {
    try {
      body();
      passes += 1;
      console.log(`PASS ${name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push(`${name}: ${message}`);
      console.log(`FAIL ${name}: ${message}`);
    }
  };

  for (const context of CONTEXTS) {
    const forward = renderDecidePrompt(inputFor(context, FORWARD));
    const reverse = renderDecidePrompt(inputFor(context, REVERSE));

    check(`${context.id}: a1 the ID -> target mapping survives the swap`, () => {
      const map = (prompt: string): string[][] => candidateIds(prompt).map(id => {
        const value = CANONICAL[id as GoalChoiceId];
        if (value === undefined) throw new Error(`unknown candidate id ${id}`);
        return [id, value];
      });
      const left = JSON.stringify([...map(forward)].sort());
      const right = JSON.stringify([...map(reverse)].sort());
      if (left !== right) throw new Error(`mapping changed:\n forward=${left}\n reverse=${right}`);
    });

    check(`${context.id}: a2 the prompt leaks nothing about the future or other actors`, () => {
      for (const { token, why } of FORBIDDEN) {
        for (const prompt of [forward, reverse]) {
          if (prompt.includes(token)) throw new Error(`leaked ${JSON.stringify(token)} (${why})`);
        }
      }
      if (!forward.includes(G09_REQUEST_TEXT)) throw new Error('the frozen request text is missing');
    });

    check(`${context.id}: a3 the render is byte-reproducible`, () => {
      if (renderDecidePrompt(inputFor(context, FORWARD)) !== forward) throw new Error('forward render drifted');
      if (renderDecidePrompt(inputFor(context, REVERSE)) !== reverse) throw new Error('reverse render drifted');
    });

    check(`${context.id}: a4 the swap is an exact reversal of ONE line`, () => {
      if (JSON.stringify(candidateIds(forward)) !== JSON.stringify([...FORWARD])) throw new Error('forward order is not the frozen set order');
      if (JSON.stringify(candidateIds(reverse)) !== JSON.stringify([...REVERSE])) throw new Error('reverse order is the exact reversal');
      if (forward === reverse) throw new Error('the two prompts are identical, the swap did nothing');
      const left = withoutCandidateLine(forward);
      const right = withoutCandidateLine(reverse);
      if (JSON.stringify(left) !== JSON.stringify(right)) throw new Error('a non-candidate line changed with the order');
    });

    check(`${context.id}: a5 the PRODUCTION parser binds the raw answer to the goal id`, () => {
      // The mapping that matters is the one production uses, not a local table.
      for (const candidate of FORWARD) {
        const parsed = strictGoalChoice(JSON.stringify({ goal: candidate }), FORWARD as readonly GoalChoiceId[]);
        if (!parsed.ok) throw new Error(`production parser rejected a legal answer ${candidate}: ${parsed.error}`);
        if (parsed.goal !== candidate) throw new Error(`production parser mapped ${candidate} to ${String(parsed.goal)}`);
      }
      const rejected = [
        '{"goal":"feed_self","goal":"feed_self"}',
        '{"goal":"feed_self","note":"x"}',
        '{"goal":"not_a_goal"}',
        '{"goal":1}',
        'yield_once',
        '{"target":"feed_self"}',
      ];
      for (const raw of rejected) {
        if (strictGoalChoice(raw, FORWARD as readonly GoalChoiceId[]).ok) throw new Error(`production parser accepted ${raw}`);
      }
    });

    console.log(`     forward sha256 ${sha256(forward).slice(0, 16)}  reverse sha256 ${sha256(reverse).slice(0, 16)}`);
    console.log(`     why this context is legal: ${context.why}`);
  }

  const forwardFirst = CONTEXTS.filter(context => context.firstPresentation === 'forward').length;
  const reverseFirst = CONTEXTS.length - forwardFirst;
  console.log('');
  console.log('proposed 8-call plan (authorizedCalls=0, nothing is sent by this script):');
  for (const context of CONTEXTS) {
    const first = context.firstPresentation === 'forward' ? 'forward' : 'reverse';
    const second = first === 'forward' ? 'reverse' : 'forward';
    console.log(`  ${context.id}  call1=${first} call2=${second}`);
  }
  console.log(`  counterbalance: forward-first=${forwardFirst}, reverse-first=${reverseFirst}, reps=1, total=8`);
  console.log('');
  console.log('NOTE the candidate IDs are semantic labels, so a pure position effect cannot be');
  console.log('     fully separated from a label effect in this contract; report it as a limitation.');
  console.log('');
  console.log(`summary: ${passes} check(s) passed, ${failures.length} failed`);
  for (const failure of failures) console.log(`  FAILED ${failure}`);
  console.log('authorizedCalls=0 proposedCalls=8 — no POST, no provider, no socket');
  return failures.length === 0 ? 0 : 1;
}

let code = 1;
try {
  code = main();
} catch (error) {
  console.error(`unexpected error: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  code = 1;
}
process.exitCode = code;
