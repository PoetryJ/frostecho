/**
 * G09 worker D — the frozen goal-choice evaluation and its read-only verifier.
 *
 * Plan: 8 episodes = {satiety 40|60} x {self_only|choice} x 2 reps, every
 * episode exactly two phases (goal, action) inside ONE session, hard cap 16
 * chat requests for the whole batch.
 *
 * Verification re-derives EVERYTHING from the raw material: the goal answer is
 * re-parsed with the frozen strict parser, the action command is re-executed on
 * a fresh Engine from the frozen initial state, and the fulfilment verdict is
 * recomputed from the re-executed ledger — no recorded flag is trusted.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Engine } from '../src/engine';
import type { WorldState } from '../src/types';
import { buildNeedsWorld } from '../src/needs/game';
import { parseAction } from '../src/agent/parser';
import type { GoalProtocolOptions } from '../src/agent/contracts';
import {
  G09_EPISODE_SCHEMA, G09_GOAL_DEADLINE_ROUND, G09_HARD_CHAT_LIMIT, G09_PLAN_SCHEMA,
  G09_REQUEST_TEXT, G09_SELF_TEXT, GOAL_ARMS, G09_SATIETY_LEVELS, fulfilmentVerdict,
  strictGoalChoice,
  type FulfillmentEvidence, type GoalArm, type GoalBinding, type GoalRequestSnapshot,
  type GoalChoiceId, type SatietyLevel,
} from '../src/negotiation/contracts';
import { bindingIssues, deriveFulfilmentEvidence } from '../src/negotiation/goal-check';
import { validateGoalRequestSnapshot } from '../src/negotiation/requests';
import { reexecuteCommands } from './g07-eval-lib';

export const G09_NPC = 'npc_a';
export const G09_PLAYER = 'npc_b';
export const G09_REPS = 2;

export interface G09Cell {
  cell: string;
  satiety: SatietyLevel;
  arm: GoalArm;
}

export const G09_CELLS: readonly G09Cell[] = [
  { cell: 's40-self_only', satiety: 40, arm: 'self_only' },
  { cell: 's40-choice', satiety: 40, arm: 'choice' },
  { cell: 's60-self_only', satiety: 60, arm: 'self_only' },
  { cell: 's60-choice', satiety: 60, arm: 'choice' },
];

export interface G09PlanEntry {
  index: number;
  episodeId: string;
  rep: number;
  cell: string;
  satiety: SatietyLevel;
  arm: GoalArm;
  requestId: string | null;
}

export interface G09Plan {
  schema: typeof G09_PLAN_SCHEMA;
  batch: string;
  plan: G09PlanEntry[];
  hardChatLimit: number;
  repCount: number;
}

export function g09Plan(batch: string): G09Plan {
  const plan: G09PlanEntry[] = [];
  let index = 0;
  for (let rep = 1; rep <= G09_REPS; rep += 1) {
    for (const cell of G09_CELLS) {
      index += 1;
      const episodeId = `g09-r${rep}-${cell.cell}`;
      plan.push({
        index, episodeId, rep, cell: cell.cell, satiety: cell.satiety, arm: cell.arm,
        requestId: cell.arm === 'choice' ? `${episodeId}-req-1` : null,
      });
    }
  }
  return { schema: G09_PLAN_SCHEMA, batch, plan, hardChatLimit: G09_HARD_CHAT_LIMIT, repCount: G09_REPS };
}

/** The G09 world: one food in the kitchen, the NPC at the cell's satiety, the player passive. */
export function g09InitialState(satiety: SatietyLevel): WorldState {
  return buildNeedsWorld({
    actorIds: [G09_NPC],
    kitchenFood: 1,
    hunger: { [G09_NPC]: satiety, [G09_PLAYER]: 20, npc_c: 40 },
  });
}

export function g09Protocol(entry: Pick<G09PlanEntry, 'arm' | 'requestId'>): GoalProtocolOptions {
  return {
    arm: entry.arm,
    requestId: entry.requestId,
    text: entry.arm === 'choice' ? G09_REQUEST_TEXT : G09_SELF_TEXT,
    options: entry.arm === 'choice' ? (['feed_self', 'yield_once'] as const) : (['feed_self'] as const),
    deadlineAfterRound: G09_GOAL_DEADLINE_ROUND,
    playerId: G09_PLAYER,
  };
}

export function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, val) => {
    if (val !== null && typeof val === 'object' && !Array.isArray(val)) {
      return Object.fromEntries(Object.keys(val as Record<string, unknown>).sort().map(k => [k, (val as Record<string, unknown>)[k]]));
    }
    return val;
  });
}

/* ------------------------------------------------------------------ */
/* Episode record (what the runner writes)                             */
/* ------------------------------------------------------------------ */

export interface G09Exchange {
  stage: 'goal' | 'action';
  attemptId: string | null;
  status: number | null;
  raw: string;
  usage: { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null } | null;
  error: string | null;
}

export interface G09EpisodeRecord {
  schema: typeof G09_EPISODE_SCHEMA;
  episodeId: string;
  cell: string;
  satiety: SatietyLevel;
  arm: GoalArm;
  outcome: 'completed' | 'invalid_run' | 'budget_exhausted' | 'timeout' | 'provider_error' | 'not_run';
  request: GoalRequestSnapshot | null;
  binding: GoalBinding | null;
  goal: { round: number; raw: string | null; parseOk: boolean; error: string | null };
  action: { round: number | null; raw: string | null; parseOk: boolean; type: string | null; error: string | null };
  fulfilment: { verdict: string; evidence: FulfillmentEvidence } | null;
  playerEat: { ok: boolean; detail: string | null } | null;
  http: G09Exchange[];
  attempts: { attemptId: string; outcome: string }[];
  tokens: { goal: number | null; action: number | null; total: number | null };
  snapshot: { initialState: WorldState; commands: unknown[]; events: unknown[]; finalState: WorldState };
  failure: string | null;
}

export interface G09Summary {
  schema: string;
  batch: string;
  createdAt: string;
  mode: 'live' | 'fake';
  model: string | null;
  hardChatLimit: number;
  protocol: { planned: number; completed: number; failed: number; notRun: number; goalPhases: number; actionPhases: number };
  goals: { feed_self: number; yield_once: number; expired: number; byCell: Record<string, Record<string, number>> };
  fulfilment: { byCell: Record<string, Record<string, number>> };
  costs: {
    chatRequests: number; spent: number; blocked: number; unresolved: number; usageUnknown: boolean;
    goalTokens: number | null; actionTokens: number | null; totalTokens: number | null;
    byCell: Record<string, { goalTokens: number | null; actionTokens: number | null; requests: number }>;
  };
  episodes: {
    episodeId: string; cell: string; arm: string; satiety: number; outcome: string;
    goal: string | null; request: string | null; verdict: string | null;
    goalTokens: number | null; actionTokens: number | null;
  }[];
}

/* ------------------------------------------------------------------ */
/* Reading the batch                                                   */
/* ------------------------------------------------------------------ */

export interface G09Batch {
  dir: string;
  plan: G09Plan | null;
  episodes: G09EpisodeRecord[];
  summary: G09Summary | null;
  problems: string[];
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

export function readG09Batch(batchDir: string): G09Batch {
  const problems: string[] = [];
  const plan = readJson<G09Plan>(join(batchDir, 'plan.json'));
  if (plan === null) problems.push('plan.json is missing or unreadable');
  const episodes: G09EpisodeRecord[] = [];
  const episodesDir = join(batchDir, 'episodes');
  if (existsSync(episodesDir)) {
    for (const name of readdirSync(episodesDir).sort()) {
      if (!name.endsWith('.json')) continue;
      const record = readJson<G09EpisodeRecord>(join(episodesDir, name));
      if (record === null) {
        problems.push(`episodes/${name}: unreadable`);
        continue;
      }
      episodes.push(record);
    }
  }
  const summary = readJson<G09Summary>(join(batchDir, 'summary.json'));
  return { dir: batchDir, plan, episodes, summary, problems };
}


/* ------------------------------------------------------------------ */
/* Ledger (attempts/) — begins are spent, finishes only mean completion */
/* ------------------------------------------------------------------ */

export interface G09Ledger {
  issues: string[];
  begins: number;
  finishes: number;
  blocked: number;
  unresolved: number;
  usageUnknown: boolean;
  knownTokenSum: number | null;
  byAttempt: Map<string, { episodeId: string; outcome: string; totalTokens: number | null }>;
}

interface RawBegin { attemptId: string; episodeId: string; actorId: string; round: number }
interface RawFinish { attemptId: string; outcome: string; usage: { total_tokens: number | null } | null }

export function deriveG09Ledger(batchDir: string, episodes: G09EpisodeRecord[]): G09Ledger {
  const issues: string[] = [];
  const begins = new Map<string, RawBegin>();
  const finishes = new Map<string, RawFinish>();
  let blocked = 0;
  const attemptsDir = join(batchDir, 'attempts');
  if (existsSync(attemptsDir)) {
    for (const name of readdirSync(attemptsDir).sort()) {
      if (name.endsWith('.begin.json')) {
        const value = readJson<RawBegin>(join(attemptsDir, name));
        if (value === null) { issues.push(`attempts/${name}: unreadable`); continue; }
        if (begins.has(value.attemptId)) issues.push(`attempt ${value.attemptId} began twice`);
        begins.set(value.attemptId, value);
      } else if (name.endsWith('.finish.json')) {
        const value = readJson<RawFinish>(join(attemptsDir, name));
        if (value === null) { issues.push(`attempts/${name}: unreadable`); continue; }
        if (finishes.has(value.attemptId)) issues.push(`attempt ${value.attemptId} finished twice`);
        finishes.set(value.attemptId, value);
      } else if (name.startsWith('blocked-')) {
        blocked += 1;
      } else {
        issues.push(`attempts/${name}: unexpected ledger file`);
      }
    }
  }
  for (const [attemptId, begin] of begins) {
    if (!finishes.has(attemptId)) issues.push(`${begin.episodeId}: attempt ${attemptId} began but never finished (spent, outcome unknown)`);
  }
  for (const attemptId of finishes.keys()) {
    if (!begins.has(attemptId)) issues.push(`attempt ${attemptId} finished without a begin`);
  }
  // Every begin must be claimed by exactly one episode record.
  const claimed = new Map<string, string>();
  for (const record of episodes) {
    for (const attempt of record.attempts ?? []) {
      if (claimed.has(attempt.attemptId)) issues.push(`attempt ${attempt.attemptId} is claimed by two episodes`);
      claimed.set(attempt.attemptId, record.episodeId);
    }
  }
  for (const [attemptId, begin] of begins) {
    const owner = claimed.get(attemptId);
    if (owner === undefined) issues.push(`${begin.episodeId}: attempt ${attemptId} is not claimed by any episode record`);
    else if (owner !== begin.episodeId) issues.push(`attempt ${attemptId} belongs to ${begin.episodeId} but ${owner} claims it`);
  }
  // The two-phase protocol spends at most two calls per episode.
  for (const record of episodes) {
    if (record.outcome === 'completed' && (record.attempts?.length ?? 0) !== 2) {
      issues.push(`${record.episodeId}: a completed two-phase episode must hold exactly 2 attempts, found ${record.attempts?.length ?? 0}`);
    }
    if (record.outcome === 'completed' && (record.http?.length ?? 0) !== 2) {
      issues.push(`${record.episodeId}: a completed episode must hold exactly 2 exchanges, found ${record.http?.length ?? 0}`);
    }
  }
  const unresolved = [...begins.keys()].filter(id => !finishes.has(id)).length;
  const tokenValues = [...finishes.values()].map(finish => finish.usage?.total_tokens ?? null);
  const usageUnknown = unresolved > 0 || tokenValues.some(value => value === null);
  const knownTokenSum: number | null = usageUnknown ? null : tokenValues.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  const byAttempt = new Map<string, { episodeId: string; outcome: string; totalTokens: number | null }>();
  for (const [attemptId, begin] of begins) {
    const finish = finishes.get(attemptId);
    byAttempt.set(attemptId, {
      episodeId: begin.episodeId,
      outcome: finish?.outcome ?? 'unresolved',
      totalTokens: finish?.usage?.total_tokens ?? null,
    });
  }
  return { issues, begins: begins.size, finishes: finishes.size, blocked, unresolved, usageUnknown, knownTokenSum, byAttempt };
}

/* ------------------------------------------------------------------ */
/* Derivation (summary projection + verification)                      */
/* ------------------------------------------------------------------ */

export interface G09Derivation {
  issues: string[];
  protocol: G09Summary['protocol'];
  goals: G09Summary['goals'];
  fulfilment: G09Summary['fulfilment'];
  costs: G09Summary['costs'];
  episodes: G09Summary['episodes'];
}

function sumOrNull(values: (number | null)[]): number | null {
  if (values.length === 0) return null;
  let sum = 0;
  for (const value of values) {
    if (value === null) return null;
    sum += value;
  }
  return sum;
}

function tokensOf(exchange: G09Exchange | undefined): number | null {
  if (exchange === undefined || exchange.usage === null) return null;
  return exchange.usage.total_tokens;
}

/**
 * Recompute the whole batch from raw material. Every recorded aggregate is
 * compared against this projection by `compareG09Summary`.
 */
export function deriveG09(batch: G09Batch, expected: G09Plan, scope: 'complete' | 'prefix' = 'complete'): G09Derivation {
  const issues: string[] = [...batch.problems];
  const protocol = { planned: expected.plan.length, completed: 0, failed: 0, notRun: 0, goalPhases: 0, actionPhases: 0 };
  const goals = { feed_self: 0, yield_once: 0, expired: 0, byCell: {} as Record<string, Record<string, number>> };
  const fulfilment: G09Summary['fulfilment'] = { byCell: {} };
  const byCell: G09Summary['costs']['byCell'] = {};
  for (const cell of G09_CELLS) {
    goals.byCell[cell.cell] = { feed_self: 0, yield_once: 0, expired: 0 };
    fulfilment.byCell[cell.cell] = { fulfilled: 0, violated: 0, not_applicable: 0, undetermined: 0 };
    byCell[cell.cell] = { goalTokens: 0, actionTokens: 0, requests: 0 };
  }
  const episodes: G09Summary['episodes'] = [];
  const seen = new Set<string>();

  for (const record of batch.episodes) {
    const id = record.episodeId;
    if (seen.has(id)) issues.push(`${id}: duplicated episode record`);
    seen.add(id);
    const entry = expected.plan.find(candidate => candidate.episodeId === id);
    if (entry === undefined) {
      issues.push(`${id}: not part of the frozen plan`);
      continue;
    }
    if (record.cell !== entry.cell || record.satiety !== entry.satiety || record.arm !== entry.arm) {
      issues.push(`${id}: the record axes ${record.cell}/${record.satiety}/${record.arm} disagree with the plan`);
    }
    if (record.outcome === 'not_run') {
      // A slot that never ran proves nothing beyond its place in the plan.
      protocol.notRun += 1;
      episodes.push({
        episodeId: id, cell: record.cell, arm: record.arm, satiety: record.satiety,
        outcome: 'not_run', goal: null, request: null, verdict: null,
        goalTokens: null, actionTokens: null,
      });
      continue;
    }
    // The frozen world must be exactly the cell's world.
    if (canonical(record.snapshot?.initialState) !== canonical(g09InitialState(entry.satiety))) {
      issues.push(`${id}: the initial state is not the frozen ${entry.cell} world`);
    }

    const goalExchange = record.http?.find(exchange => exchange.stage === 'goal');
    const actionExchange = record.http?.find(exchange => exchange.stage === 'action');
    if (record.outcome === 'completed') {
      protocol.completed += 1;
      protocol.goalPhases += 1;
      protocol.actionPhases += 1;
      if (goalExchange === undefined || actionExchange === undefined) {
        issues.push(`${id}: a completed episode must hold both a goal and an action exchange`);
      }
      if (record.http.length !== 2) issues.push(`${id}: a completed episode must hold exactly 2 exchanges, found ${record.http.length}`);
    } else {
      protocol.failed += 1;
      if (goalExchange !== undefined) protocol.goalPhases += 1;
      if (actionExchange !== undefined) protocol.actionPhases += 1;
    }

    // Request state machine + binding consistency.
    const request = record.request;
    if (entry.arm === 'choice') {
      if (request === null) issues.push(`${id}: the choice arm must record its request`);
      else {
        const validated = validateGoalRequestSnapshot(request);
        if (!validated.ok) issues.push(`${id}: request invalid: ${validated.issues.join('; ')}`);
        if (request.requestId !== entry.requestId) issues.push(`${id}: request id ${JSON.stringify(request.requestId)} is not ${JSON.stringify(entry.requestId)}`);
        if (canonical(request.options) !== canonical(['feed_self', 'yield_once'])) issues.push(`${id}: the choice offer must be both goals`);
        if (request.text !== G09_REQUEST_TEXT) issues.push(`${id}: the request text is not the frozen text`);
      }
    } else {
      if (request !== null) issues.push(`${id}: the self_only arm must not record a request`);
    }
    if (record.binding !== null) {
      const parsed = strictGoalChoice(record.binding.raw, entry.arm === 'choice' ? ['feed_self', 'yield_once'] : ['feed_self']);
      if (!parsed.ok) issues.push(`${id}: binding raw does not parse: ${parsed.error}`);
      else if (parsed.goal !== record.binding.goal) issues.push(`${id}: binding raw parses to ${parsed.goal}, recorded ${record.binding.goal}`);
      if (record.binding.decidedRound !== G09_GOAL_DEADLINE_ROUND) {
        issues.push(`${id}: the goal must be decided on round ${G09_GOAL_DEADLINE_ROUND}, found ${record.binding.decidedRound}`);
      }
      if (record.binding.decidedAtSimTime !== (record.snapshot?.initialState?.simTime ?? 0)) {
        issues.push(`${id}: the goal decision must happen at the frozen simTime`);
      }
      issues.push(...bindingIssues(record.binding, request));
      // The recorded goal phase must BE the first exchange.
      if (goalExchange !== undefined && goalExchange.raw !== record.binding.raw) {
        issues.push(`${id}: the goal exchange raw differs from the binding raw`);
      }
      // Goal accounting.
      if (entry.arm === 'choice') {
        if (record.binding.goal === 'yield_once') {
          goals.yield_once += 1;
          goals.byCell[entry.cell]!.yield_once = (goals.byCell[entry.cell]!.yield_once ?? 0) + 1;
        } else {
          goals.feed_self += 1;
          goals.byCell[entry.cell]!.feed_self = (goals.byCell[entry.cell]!.feed_self ?? 0) + 1;
        }
      } else {
        goals.feed_self += 1;
        goals.byCell[entry.cell]!.feed_self = (goals.byCell[entry.cell]!.feed_self ?? 0) + 1;
      }
    } else if (request !== null && request.status === 'expired') {
      goals.expired += 1;
      goals.byCell[entry.cell]!.expired = (goals.byCell[entry.cell]!.expired ?? 0) + 1;
    } else if (record.outcome === 'completed') {
      issues.push(`${id}: a completed episode must carry a binding`);
    }

    // The action phase must be a legal legacy action that produced the ledger.
    if (actionExchange !== undefined) {
      if (actionExchange.raw !== record.action?.raw) issues.push(`${id}: the action exchange raw differs from the recorded action raw`);
      const parsed = parseAction(actionExchange.raw, 'legacy');
      if (!parsed.ok) issues.push(`${id}: the action raw is not a legal legacy action: ${parsed.error}`);
      else if (record.action?.parseOk !== true || record.action.type !== parsed.action.type) {
        issues.push(`${id}: the recorded action does not match the parsed action`);
      }
      const npcCommand = (record.snapshot.commands as { command?: { actorId?: string; type?: string } }[])
        .find(candidate => candidate.command?.actorId === G09_NPC);
      if (parsed.ok && parsed.action.type !== 'stop') {
        if (npcCommand === undefined || npcCommand.command?.type !== parsed.action.type) {
          issues.push(`${id}: the ledger holds no ${parsed.action.type} command matching the action answer`);
        }
      }
    }

    // Re-execute the whole ledger on a fresh Engine.
    const reexecIssues: string[] = [];
    if (record.snapshot !== undefined) {
      reexecIssues.push(...reexecuteCommands({ plan: { episodeId: id }, snapshot: record.snapshot as never }));
    } else {
      issues.push(`${id}: no snapshot to re-execute`);
    }
    issues.push(...reexecIssues);

    // Fulfilment re-derived from the re-executed ledger.
    if (record.outcome === 'completed' && record.binding !== null) {
      const evidence = deriveFulfilmentEvidence(
        { goal: record.binding.goal },
        { commands: record.snapshot.commands as never },
        G09_NPC, G09_PLAYER,
      );
      const verdict = fulfilmentVerdict(evidence);
      if (record.fulfilment === null) issues.push(`${id}: a completed episode must record its fulfilment`);
      else {
        if (canonical(record.fulfilment.evidence) !== canonical(evidence)) {
          issues.push(`${id}: the recorded fulfilment evidence disagrees with the ledger (${canonical(record.fulfilment.evidence)} vs ${canonical(evidence)})`);
        }
        if (record.fulfilment.verdict !== verdict) {
          issues.push(`${id}: the recorded verdict ${record.fulfilment.verdict} disagrees with the derived ${verdict}`);
        }
      }
      const bucket = fulfilment.byCell[entry.cell]!;
      bucket[verdict] = (bucket[verdict] ?? 0) + 1;
    }

    // Per-episode two-phase cost.
    const goalTokens = tokensOf(goalExchange);
    const actionTokens = tokensOf(actionExchange);
    if (goalExchange !== undefined) byCell[entry.cell]!.goalTokens = addMaybe(byCell[entry.cell]!.goalTokens, goalTokens);
    if (actionExchange !== undefined) byCell[entry.cell]!.actionTokens = addMaybe(byCell[entry.cell]!.actionTokens, actionTokens);
    byCell[entry.cell]!.requests += record.http?.length ?? 0;

    episodes.push({
      episodeId: id, cell: record.cell, arm: record.arm, satiety: record.satiety,
      outcome: record.outcome,
      goal: record.binding === null ? null : record.binding.goal,
      request: request === null ? null : request.status,
      verdict: record.fulfilment === null ? null : record.fulfilment.verdict,
      goalTokens, actionTokens,
    });
  }

  // The frozen matrix must be fully present (or explicitly not_run by the
  // runner). A prefix gate intentionally proves only its first pair.
  if (scope === 'complete') {
    for (const entry of expected.plan) {
      if (!seen.has(entry.episodeId) && !batch.episodes.some(record => record.outcome === 'not_run' && record.episodeId === entry.episodeId)) {
        issues.push(`${entry.episodeId}: the plan slot has no record at all`);
      }
    }
  }

  // Ledger-level costs (begins = spent, duplicate linkage, hard cap).
  const ledger = deriveG09Ledger(batch.dir, batch.episodes);
  issues.push(...ledger.issues);
  if (ledger.begins > expected.hardChatLimit) {
    issues.push(`the batch spent ${ledger.begins} chat requests, more than the frozen ${expected.hardChatLimit}`);
  }

  const goalTokenValues = batch.episodes.map(record => tokensOf(record.http?.find(e => e.stage === 'goal')));
  const actionTokenValues = batch.episodes.map(record => tokensOf(record.http?.find(e => e.stage === 'action')));
  const costs: G09Summary['costs'] = {
    chatRequests: ledger.begins,
    spent: ledger.begins,
    blocked: ledger.blocked,
    unresolved: ledger.unresolved,
    usageUnknown: ledger.usageUnknown,
    goalTokens: sumOrNull(goalTokenValues),
    actionTokens: sumOrNull(actionTokenValues),
    totalTokens: ledger.knownTokenSum,
    byCell,
  };
  // Unknown usage must stay unknown in the phase totals too.
  if (goalTokenValues.some(v => v === null)) costs.goalTokens = null;
  if (actionTokenValues.some(v => v === null)) costs.actionTokens = null;
  if (byCell !== undefined) {
    for (const cell of G09_CELLS) {
      const none = batch.episodes.filter(record => record.cell === cell.cell);
      if (none.some(record => tokensOf(record.http?.find(e => e.stage === 'goal')) === null)) byCell[cell.cell]!.goalTokens = null;
      if (none.some(record => tokensOf(record.http?.find(e => e.stage === 'action')) === null)) byCell[cell.cell]!.actionTokens = null;
    }
  }

  return { issues, protocol, goals, fulfilment, costs, episodes };
}

function addMaybe(total: number | null, value: number | null): number | null {
  if (total === null || value === null) return null;
  return total + value;
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */

export interface G09VerifyResult {
  ok: boolean;
  evidenceOk: boolean;
  complete: boolean;
  runSucceeded: boolean;
  issues: string[];
  derivation: G09Derivation;
}

function verify(batchDir: string, scope: 'complete' | 'prefix'): G09VerifyResult {
  const batch = readG09Batch(batchDir);
  const expected = batch.plan ?? g09Plan(batchDir.split('/').pop() ?? 'batch');
  const derivation = deriveG09(batch, expected, scope);
  const issues = [...derivation.issues];
  const planned = expected.plan.length;
  const recorded = batch.episodes.filter(record => record.outcome !== 'not_run').length;
  const complete = recorded === planned && batch.episodes.every(record => record.outcome === 'completed');
  const evidenceOk = issues.length === 0;

  if (scope === 'complete') {
    if (batch.summary === null) {
      issues.push('summary.json is missing: a complete batch must publish its own derivation');
    } else {
      issues.push(...compareG09Summary(batch.summary, derivation, expected));
    }
    if (!complete) issues.push(`the batch is not complete: ${recorded}/${planned} episodes ran, ${batch.episodes.filter(r => r.outcome === 'not_run').length} not_run`);
  } else {
    // The prefix proves the first pair only (structure gate after episode 2).
    const pair = expected.plan.slice(0, 2).map(entry => entry.episodeId);
    const pairRecords = batch.episodes.filter(record => pair.includes(record.episodeId));
    if (pairRecords.length !== 2) issues.push(`the structural gate needs both first-pair episodes (${pair.join(', ')})`);
    for (const record of pairRecords) {
      if (record.outcome !== 'completed') issues.push(`${record.episodeId}: the structural gate requires a completed episode`);
      if ((record.http?.length ?? 0) !== 2) issues.push(`${record.episodeId}: the structural gate requires exactly two exchanges`);
      if (record.binding === null) issues.push(`${record.episodeId}: the structural gate requires a decided goal`);
    }
  }

  const structuralIssues = issues.filter(issue => !issue.startsWith('summary.'));
  const evidenceOkFinal = structuralIssues.length === 0;
  // A complete verification must also accept the published summary; a prefix
  // gate proves only the structure of its first pair.
  const ok = scope === 'complete' ? issues.length === 0 && complete : evidenceOkFinal;
  return {
    ok,
    evidenceOk: evidenceOkFinal,
    complete,
    runSucceeded: ok,
    issues,
    derivation,
  };
}

export function verifyG09Batch(batchDir: string): G09VerifyResult {
  return verify(batchDir, 'complete');
}

export function verifyG09Prefix(batchDir: string): G09VerifyResult {
  return verify(batchDir, 'prefix');
}

/** The summary must equal the projection, field by field. */
export function compareG09Summary(summary: G09Summary, derivation: G09Derivation, expected: G09Plan): string[] {
  const issues: string[] = [];
  const check = (label: string, actual: unknown, derived: unknown): void => {
    if (canonical(actual) !== canonical(derived)) {
      issues.push(`summary.${label}: recorded ${JSON.stringify(actual)} but the raw material derives ${JSON.stringify(derived)}`);
    }
  };
  check('batch', summary.batch, expected.batch);
  check('hardChatLimit', summary.hardChatLimit, expected.hardChatLimit);
  check('protocol', summary.protocol, derivation.protocol);
  check('goals', summary.goals, derivation.goals);
  check('fulfilment', summary.fulfilment, derivation.fulfilment);
  check('costs', summary.costs, derivation.costs);
  check('episodes', summary.episodes, derivation.episodes);
  return issues;
}

/** The summary the runner writes (a pure projection of the records). */
export function projectG09Summary(
  batch: string, mode: 'live' | 'fake', model: string | null, derivation: G09Derivation,
): G09Summary {
  return {
    schema: 'frostecho.g09.summary/1',
    batch,
    createdAt: new Date().toISOString(),
    mode,
    model,
    hardChatLimit: G09_HARD_CHAT_LIMIT,
    protocol: derivation.protocol,
    goals: derivation.goals,
    fulfilment: derivation.fulfilment,
    costs: derivation.costs,
    episodes: derivation.episodes,
  };
}

export { G09_SATIETY_LEVELS, GOAL_ARMS };
export type { GoalChoiceId };
