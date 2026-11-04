/**
 * G09-R1 worker D — the ORIGINAL experiment matrix, the shared runtime
 * factory, full HTTP evidence and the read-only verifier.
 *
 * The expectations come from the frozen contract (spec-lock), never from the
 * batch's own plan.json: a corrupted plan or summary must be REJECTED, not
 * echoed. Campaign chat budget is task-scoped and persistent across batches and
 * processes; a batch is only a subdirectory.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { buildNeedsWorld } from '../src/needs/game';
import { parseAction } from '../src/agent/parser';
import type { WorldState } from '../src/types';
import type { GoalProtocolOptions } from '../src/agent/contracts';
import {
  G09_ALLOWED_GOALS, G09_EPISODE_SCHEMA, G09_HARD_CHAT_LIMIT, G09_PLAN_SCHEMA,
  G09_REQUEST_TEXT, G09_TIMEOUT_MS, G09_GOAL_MODE, G09_SATIETY_LEVELS,
  fulfilmentVerdict, strictGoalChoice,
  type FulfillmentEvidence, type GoalArm, type GoalBinding, type GoalRequestSnapshot,
  type GoalChoiceId, type SatietyLevel,
} from '../src/negotiation/contracts';
import { bindingIssues, replayRequestOutcome } from '../src/negotiation/goal-check';
import { validateGoalRequestSnapshot } from '../src/negotiation/requests';
import { reexecuteCommands } from './g07-eval-lib';

export const G09_NPC = 'npc_a';
export const G09_PLAYER = 'npc_b';
export const G09_OTHER = 'npc_c';
export const G09_REPS = 2;

/* ------------------------------------------------------------------ */
/* Frozen matrix (rep 2 is the exact reverse)                          */
/* ------------------------------------------------------------------ */

export interface G09Cell { cell: string; satiety: SatietyLevel; arm: GoalArm }

/** Order: r1 40/self, 40/choice, 60/self, 60/choice; r2 reversed. */
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
  /** BOTH arms carry the SAME host request id — only candidates differ. */
  requestId: string;
}

export interface G09Plan {
  schema: typeof G09_PLAN_SCHEMA;
  batch: string;
  plan: G09PlanEntry[];
  hardChatLimit: number;
  repCount: number;
  runtime: ReturnType<typeof g09RuntimeConfig>;
}

const REP_ORDER: readonly number[] = [0, 1, 2, 3];

export function g09Plan(batch: string): G09Plan {
  const plan: G09PlanEntry[] = [];
  let index = 0;
  for (let rep = 1; rep <= G09_REPS; rep += 1) {
    const order = rep === 1 ? REP_ORDER : [...REP_ORDER].reverse();
    for (const cellIndex of order) {
      const cell = G09_CELLS[cellIndex]!;
      index += 1;
      const episodeId = `g09-r${rep}-${cell.cell}`;
      plan.push({
        index, episodeId, rep, cell: cell.cell, satiety: cell.satiety, arm: cell.arm,
        requestId: `${episodeId}-req-1`,
      });
    }
  }
  return { schema: G09_PLAN_SCHEMA, batch, plan, hardChatLimit: G09_HARD_CHAT_LIMIT, repCount: G09_REPS, runtime: g09RuntimeConfig() };
}

/** The frozen world: player 40, companion 70, one kitchen food, NPC at the cell satiety. */
export function g09InitialState(satiety: SatietyLevel): WorldState {
  const state = buildNeedsWorld({
    actorIds: [G09_NPC, G09_OTHER],
    kitchenFood: 1,
    hunger: { [G09_NPC]: satiety, [G09_PLAYER]: 40, [G09_OTHER]: 70 },
  });
  return state;
}

export function g09Protocol(entry: Pick<G09PlanEntry, 'arm' | 'requestId'>): GoalProtocolOptions {
  return {
    arm: entry.arm,
    requestId: entry.requestId,
    text: G09_REQUEST_TEXT,
    options: G09_ALLOWED_GOALS[entry.arm],
    expiresAtSimTime: 1,
    playerId: G09_PLAYER,
  };
}

/**
 * The ONE shared runtime factory used by the eval and the CLI. The frozen
 * contract is recurring needs + event wake + timed_wait actions + negotiated
 * goals over [npc_a, npc_c].
 */
export function g09RuntimeConfig(): {
  actorIds: readonly string[];
  needPolicy: 'recurring';
  policy: 'event';
  actionSet: 'timed_wait';
  goalMode: typeof G09_GOAL_MODE;
} {
  return {
    actorIds: [G09_NPC, G09_OTHER],
    needPolicy: 'recurring',
    policy: 'event',
    actionSet: 'timed_wait',
    goalMode: G09_GOAL_MODE,
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

/**
 * The frozen plan derived from the CONTRACT (not from disk). Verification
 * compares the disk plan against this; a rewritten plan can never be its own
 * standard.
 */
export function frozenPlanEntries(): G09PlanEntry[] {
  return g09Plan('frozen').plan;
}

/* ------------------------------------------------------------------ */
/* Episode record (full HTTP evidence)                                 */
/* ------------------------------------------------------------------ */

export interface G09HttpExchange {
  phase: 'goal' | 'action';
  /** The immutable attempt this exchange belongs to (from the ledger). */
  attemptId: string;
  /** The exact outbound body (model, sampling, messages). */
  requestBody: unknown;
  /** The full response: status + body + usage. */
  response: { status: number | null; body: string; usage: { total_tokens: number | null; prompt_tokens: number | null; completion_tokens: number | null } | null };
  /** The prompt actually rendered for this call. */
  prompt: string;
  /** sha256 of the prompt, for the source/prompt fingerprint. */
  promptFingerprint: string;
  elapsedMs: number;
  error: string | null;
}

/** One real wire exchange captured at the fetch boundary. */
export interface G09WireCapture {
  requestBody: unknown;
  requestBodyText: string;
  status: number;
  responseBody: string;
}

/**
 * The ONE boundary collector shared by the fake and live branches: it wraps
 * the fetch actually used for the call, saves the exact serialized request
 * body and the real response status/text (via clone), then hands the original
 * Response to the HTTP provider for parsing. Evidence is never reconstructed.
 */
export function createWireCollector(inner: typeof fetch): {
  fetchImpl: typeof fetch;
  take(): G09WireCapture | null;
} {
  let slot: G09WireCapture | null = null;
  const fetchImpl: typeof fetch = async (input, init) => {
    const text = typeof init?.body === 'string' ? init.body : '';
    let requestBody: unknown = {};
    try {
      requestBody = text ? JSON.parse(text) : {};
    } catch {
      requestBody = { raw: text };
    }
    const response = await inner(input, init);
    let responseBody = '';
    try {
      responseBody = await response.clone().text();
    } catch {
      responseBody = '';
    }
    slot = { requestBody, requestBodyText: text, status: response.status, responseBody };
    return response;
  };
  return {
    fetchImpl,
    take: () => {
      const current = slot;
      slot = null;
      return current;
    },
  };
}

/** Usage parsed from the REAL body; null when absent/unparseable (never invented). */
export function wireUsage(body: string): { total_tokens: number | null; prompt_tokens: number | null; completion_tokens: number | null } | null {
  try {
    const parsed = JSON.parse(body) as { usage?: Record<string, unknown> };
    const usage = parsed.usage;
    if (usage === null || typeof usage !== 'object' || Array.isArray(usage)) return null;
    const num = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);
    const stats = {
      total_tokens: num(usage.total_tokens),
      prompt_tokens: num(usage.prompt_tokens),
      completion_tokens: num(usage.completion_tokens),
    };
    if (stats.total_tokens === null && stats.prompt_tokens === null && stats.completion_tokens === null) return null;
    return stats;
  } catch {
    return null;
  }
}

export interface G09EpisodeRecord {
  schema: typeof G09_EPISODE_SCHEMA;
  episodeId: string;
  cell: string;
  satiety: SatietyLevel;
  arm: GoalArm;
  outcome: 'completed' | 'invalid_run' | 'insufficient_budget' | 'timeout' | 'provider_error' | 'request_expired' | 'not_run';
  request: GoalRequestSnapshot | null;
  binding: GoalBinding | null;
  goal: { round: number; raw: string | null; parseOk: boolean; error: string | null };
  action: { round: number | null; raw: string | null; parseOk: boolean; type: string | null; error: string | null };
  fulfilment: { verdict: string; evidence: FulfillmentEvidence; outcome: string; reason: string | null } | null;
  playerEat: { ok: boolean; detail: string | null } | null;
  http: G09HttpExchange[];
  attempts: { attemptId: string; outcome: string }[];
  tokens: { goal: number | null; action: number | null; total: number | null };
  snapshot: { initialState: WorldState; commands: unknown[]; events: unknown[]; finalState: WorldState };
  runtime: ReturnType<typeof g09RuntimeConfig>;
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
  goals: { feed_self: number; yield_once: number; byCell: Record<string, Record<string, number>> };
  fulfilment: { byCell: Record<string, Record<string, number>> };
  costs: {
    chatRequests: number; spent: number; blocked: number; unresolved: number; usageUnknown: boolean;
    goalTokens: number | null; actionTokens: number | null; totalTokens: number | null;
    campaignLimit: number; campaignSpent: number;
    byCell: Record<string, { goalTokens: number | null; actionTokens: number | null; requests: number }>;
  };
  episodes: {
    episodeId: string; cell: string; arm: string; satiety: number; outcome: string;
    goal: string | null; request: string | null; verdict: string | null;
    goalTokens: number | null; actionTokens: number | null;
  }[];
}

/* ------------------------------------------------------------------ */
/* Reading                                                            */
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
      if (record === null) { problems.push(`episodes/${name}: unreadable`); continue; }
      episodes.push(record);
    }
  }
  const summary = readJson<G09Summary>(join(batchDir, 'summary.json'));
  return { dir: batchDir, plan, episodes, summary, problems };
}

/* ------------------------------------------------------------------ */
/* Ledger                                                             */
/* ------------------------------------------------------------------ */

export interface G09Ledger {
  issues: string[];
  begins: number;
  finishes: number;
  blocked: number;
  unresolved: number;
  usageUnknown: boolean;
  knownTokenSum: number | null;
  beginsById: Map<string, { attemptId: string; episodeId: string; requestConfig: Record<string, unknown> | null }>;
  finishesById: Map<string, { outcome: string; totalTokens: number | null; status: number | null }>;
  blockedIds: string[];
}

interface RawBegin { attemptId: string; episodeId: string; actorId: string; round: number; requestConfig?: Record<string, unknown> | null }
interface RawFinish { attemptId: string; outcome: string; status: number | null; usage: { total_tokens: number | null } | null }

export function deriveG09Ledger(batchDir: string, episodes: G09EpisodeRecord[]): G09Ledger {
  const issues: string[] = [];
  const beginsById = new Map<string, RawBegin>();
  const finishesById = new Map<string, RawFinish>();
  const blockedIds: string[] = [];
  const attemptsDir = join(batchDir, 'attempts');
  if (existsSync(attemptsDir)) {
    for (const name of readdirSync(attemptsDir).sort()) {
      if (name.endsWith('.begin.json')) {
        const value = readJson<RawBegin>(join(attemptsDir, name));
        if (value === null) { issues.push(`attempts/${name}: unreadable`); continue; }
        if (beginsById.has(value.attemptId)) issues.push(`attempt ${value.attemptId} began twice`);
        beginsById.set(value.attemptId, value);
      } else if (name.endsWith('.finish.json')) {
        const value = readJson<RawFinish>(join(attemptsDir, name));
        if (value === null) { issues.push(`attempts/${name}: unreadable`); continue; }
        if (finishesById.has(value.attemptId)) issues.push(`attempt ${value.attemptId} finished twice`);
        finishesById.set(value.attemptId, value);
      } else if (name.startsWith('blocked-')) {
        blockedIds.push(name);
      } else {
        issues.push(`attempts/${name}: unexpected ledger file`);
      }
    }
  }
  for (const [attemptId, begin] of beginsById) {
    if (!finishesById.has(attemptId)) issues.push(`${begin.episodeId}: attempt ${attemptId} began but never finished (spent, outcome unknown)`);
  }
  for (const attemptId of finishesById.keys()) {
    if (!beginsById.has(attemptId)) issues.push(`attempt ${attemptId} finished without a begin`);
  }
  const claimed = new Map<string, string>();
  for (const record of episodes) {
    for (const attempt of record.attempts ?? []) {
      if (claimed.has(attempt.attemptId)) issues.push(`attempt ${attempt.attemptId} is claimed by two episodes`);
      claimed.set(attempt.attemptId, record.episodeId);
    }
    // Every recorded exchange must point at its OWN immutable attempt.
    const ids = new Set((record.attempts ?? []).map(attempt => attempt.attemptId));
    for (const exchange of record.http ?? []) {
      if (typeof exchange.attemptId !== 'string' || exchange.attemptId.length === 0) {
        issues.push(`${record.episodeId}: ${exchange.phase} exchange carries no attemptId`);
      } else if (!ids.has(exchange.attemptId)) {
        issues.push(`${record.episodeId}: ${exchange.phase} exchange points at attempt ${exchange.attemptId} which this episode does not own`);
      } else {
        const begin = beginsById.get(exchange.attemptId);
        if (begin === undefined) issues.push(`${record.episodeId}: ${exchange.phase} exchange attempt ${exchange.attemptId} has no begin entry`);
        else if (begin.episodeId !== record.episodeId) issues.push(`${begin.attemptId}: begin belongs to ${begin.episodeId} but ${record.episodeId} claims it`);
        else {
          const beginModel = (begin.requestConfig ?? {}).model;
          const bodyModel = (exchange.requestBody as { model?: unknown } | null)?.model;
          if (beginModel !== bodyModel) {
            issues.push(`${record.episodeId}: ${exchange.phase} exchange model ${JSON.stringify(bodyModel)} disagrees with the begin requestConfig ${JSON.stringify(beginModel)}`);
          }
        }
      }
      const body = exchange.requestBody as { model?: string | null } | null;
      if (body === null || typeof body !== 'object' || typeof body.model !== 'string') {
        issues.push(`${record.episodeId}: ${exchange.phase} exchange carries no outbound request body/model`);
      }
      if (typeof exchange.prompt !== 'string' || exchange.prompt.length === 0) {
        issues.push(`${record.episodeId}: ${exchange.phase} exchange carries no prompt`);
      }
    }
  }
  for (const [attemptId, begin] of beginsById) {
    const owner = claimed.get(attemptId);
    if (owner === undefined) issues.push(`${begin.episodeId}: attempt ${attemptId} is not claimed by any episode record`);
    else if (owner !== begin.episodeId) issues.push(`attempt ${attemptId} belongs to ${begin.episodeId} but ${owner} claims it`);
  }
  const unresolved = [...beginsById.keys()].filter(id => !finishesById.has(id)).length;
  const tokenValues = [...finishesById.values()].map(finish => finish.usage?.total_tokens ?? null);
  const usageUnknown = unresolved > 0 || tokenValues.some(value => value === null);
  const knownTokenSum: number | null = usageUnknown ? null : tokenValues.reduce<number>((sum, value) => sum + (value ?? 0), 0);
  return {
    issues, begins: beginsById.size, finishes: finishesById.size, blocked: blockedIds.length,
    unresolved, usageUnknown, knownTokenSum,
    beginsById: new Map([...beginsById].map(([id, begin]) => [id, { attemptId: id, episodeId: begin.episodeId, requestConfig: begin.requestConfig ?? null }])),
    finishesById: new Map([...finishesById].map(([id, finish]) => [id, { outcome: finish.outcome, totalTokens: finish.usage?.total_tokens ?? null, status: finish.status }])),
    blockedIds,
  };
}

/* ------------------------------------------------------------------ */
/* Derivation                                                         */
/* ------------------------------------------------------------------ */

export interface G09Derivation {
  issues: string[];
  protocol: G09Summary['protocol'];
  goals: G09Summary['goals'];
  fulfilment: G09Summary['fulfilment'];
  costs: G09Summary['costs'];
  episodes: G09Summary['episodes'];
}

function tokensOf(exchange: G09HttpExchange | undefined): number | null {
  if (exchange === undefined || exchange.response.usage === null) return null;
  return exchange.response.usage.total_tokens;
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

export function deriveG09(
  batch: G09Batch,
  frozen: readonly G09PlanEntry[],
  campaign: { limit: number; spent: number },
  scope: 'complete' | 'prefix' = 'complete',
): G09Derivation {
  const issues: string[] = [...batch.problems];
  const protocol = { planned: frozen.length, completed: 0, failed: 0, notRun: 0, goalPhases: 0, actionPhases: 0 };
  const goals = { feed_self: 0, yield_once: 0, byCell: {} as Record<string, Record<string, number>> };
  const fulfilment: G09Summary['fulfilment'] = { byCell: {} };
  const byCell: G09Summary['costs']['byCell'] = {};
  for (const cell of G09_CELLS) {
    goals.byCell[cell.cell] = { feed_self: 0, yield_once: 0 };
    fulfilment.byCell[cell.cell] = { fulfilled: 0, violated: 0, not_applicable: 0, undetermined: 0 };
    byCell[cell.cell] = { goalTokens: 0, actionTokens: 0, requests: 0 };
  }
  const episodes: G09Summary['episodes'] = [];
  const seen = new Set<string>();

  for (const record of batch.episodes) {
    const id = record.episodeId;
    if (seen.has(id)) issues.push(`${id}: duplicated episode record`);
    seen.add(id);
    const entry = frozen.find(candidate => candidate.episodeId === id);
    if (entry === undefined) { issues.push(`${id}: not part of the frozen plan`); continue; }
    if (record.cell !== entry.cell || record.satiety !== entry.satiety || record.arm !== entry.arm) {
      issues.push(`${id}: the record axes ${record.cell}/${record.satiety}/${record.arm} disagree with the frozen plan`);
    }
    if (record.outcome === 'not_run') {
      protocol.notRun += 1;
      episodes.push({ episodeId: id, cell: record.cell, arm: record.arm, satiety: record.satiety, outcome: 'not_run', goal: null, request: null, verdict: null, goalTokens: null, actionTokens: null });
      continue;
    }
    // The frozen world must be exactly the cell's world (compared to the contract).
    if (canonical(record.snapshot?.initialState) !== canonical(g09InitialState(entry.satiety))) {
      issues.push(`${id}: the initial state is not the frozen ${entry.cell} world`);
    }
    if (canonical(record.runtime) !== canonical(g09RuntimeConfig())) {
      issues.push(`${id}: the runtime is not the frozen recurring/event/timed_wait [A,C] configuration`);
    }
    const goalExchange = record.http?.find(exchange => exchange.phase === 'goal');
    const actionExchange = record.http?.find(exchange => exchange.phase === 'action');
    if (record.outcome === 'completed') {
      protocol.completed += 1;
      protocol.goalPhases += 1;
      protocol.actionPhases += 1;
      if (goalExchange === undefined || actionExchange === undefined) issues.push(`${id}: a completed episode must hold both a goal and an action exchange`);
      if ((record.http?.length ?? 0) !== 2) issues.push(`${id}: a completed episode must hold exactly 2 exchanges, found ${record.http?.length ?? 0}`);
    } else {
      protocol.failed += 1;
      if (goalExchange !== undefined) protocol.goalPhases += 1;
      if (actionExchange !== undefined) protocol.actionPhases += 1;
    }
    // The prompt must be byte-identical across arms except the candidate line.
    if (goalExchange !== undefined) {
      const normalised = goalExchange.prompt.replace(/^candidateGoals: .*$/m, 'candidateGoals: <DATA>');
      const expected = renderFrozenGoalPrompt(record.arm, record.satiety);
      if (normalised !== expected) issues.push(`${id}: the goal prompt is not the frozen template`);
      if (goalExchange.prompt.includes(record.episodeId ?? id)) issues.push(`${id}: the episode id leaked into the prompt`);
      if (goalExchange.prompt.includes(entry.requestId)) issues.push(`${id}: the host request id leaked into the prompt`);
    }
    // Request shape and binding.
    if (record.request !== null) {
      const validated = validateGoalRequestSnapshot(record.request);
      if (!validated.ok) issues.push(`${id}: request invalid: ${validated.issues.join('; ')}`);
      if (record.request.text !== G09_REQUEST_TEXT) issues.push(`${id}: the request text is not the frozen S1`);
      if (canonical(record.request.options) !== canonical(G09_ALLOWED_GOALS[entry.arm])) issues.push(`${id}: the request candidates are not the ${entry.arm} set`);
      if (record.request.expiresAtSimTime !== record.request.createdAtSimTime + 1) issues.push(`${id}: the request expiry is not createdAt+1`);
    }
    if (record.binding !== null && record.request !== null) {
      issues.push(...bindingIssues(record.binding, record.request));
      const parsed = strictGoalChoice(record.binding.raw, record.request.options);
      if (!parsed.ok) issues.push(`${id}: binding raw does not parse: ${parsed.error}`);
      if (goalExchange !== undefined && goalExchange.response.body !== undefined) {
        const content = responseContent(goalExchange);
        if (content !== record.binding.raw) issues.push(`${id}: the goal response content differs from the binding raw`);
      }
      goals[record.binding.goal] += 1;
      goals.byCell[entry.cell]![record.binding.goal] = (goals.byCell[entry.cell]![record.binding.goal] ?? 0) + 1;
    } else if (record.outcome === 'completed') {
      // A declined feed_self is a legal completed control episode.
      if (record.request === null || record.request.status !== 'declined') {
        issues.push(`${id}: a completed episode must carry an accepted binding or a declined request`);
      } else {
        goals.feed_self += 1;
        goals.byCell[entry.cell]!.feed_self = (goals.byCell[entry.cell]!.feed_self ?? 0) + 1;
      }
    }
    // Action phase: legal legacy/timed_wait action that produced the ledger.
    if (actionExchange !== undefined) {
      const parsed = parseAction(responseContent(actionExchange), 'timed_wait');
      if (!parsed.ok) issues.push(`${id}: the action answer is not a legal timed_wait action: ${parsed.error}`);
      else if (record.action?.parseOk !== true || record.action.type !== parsed.action.type) issues.push(`${id}: the recorded action does not match the parsed answer`);
    }
    // Re-execute the ledger on a fresh Engine.
    if (record.snapshot !== undefined) {
      issues.push(...reexecuteCommands({ plan: { episodeId: id }, snapshot: record.snapshot as never }));
    } else {
      issues.push(`${id}: no snapshot to re-execute`);
    }
    // Fulfilment: replay the request through the authoritative commands.
    if (record.outcome === 'completed' && record.binding !== null && record.request !== null) {
      const replayed = replayRequestOutcome(record.request, record.binding, {
        commands: record.snapshot.commands as never,
        finalSimTime: record.snapshot.finalState?.simTime,
      });
      if (record.fulfilment === null) issues.push(`${id}: a completed episode must record its fulfilment`);
      else {
        if (record.fulfilment.outcome !== replayed.outcome) {
          issues.push(`${id}: the recorded request outcome ${record.fulfilment.outcome} disagrees with the replayed ${replayed.outcome}`);
        }
        const expectedVerdict = record.binding.goal !== 'yield_once'
          ? 'not_applicable'
          : fulfilmentVerdict({ goal: 'yield_once', npcAteBeforePlayer: replayed.outcome === 'violated', playerAte: replayed.outcome === 'fulfilled' });
        if (record.fulfilment.verdict !== expectedVerdict) {
          issues.push(`${id}: the recorded verdict ${record.fulfilment.verdict} disagrees with ${expectedVerdict}`);
        }
        if (record.binding.goal === 'yield_once') {
          const bucket = fulfilment.byCell[entry.cell]!;
          bucket[expectedVerdict] = (bucket[expectedVerdict] ?? 0) + 1;
        }
      }
    }
    const goalTokens = tokensOf(goalExchange);
    const actionTokens = tokensOf(actionExchange);
    if (goalExchange !== undefined) byCell[entry.cell]!.goalTokens = addMaybe(byCell[entry.cell]!.goalTokens, goalTokens);
    if (actionExchange !== undefined) byCell[entry.cell]!.actionTokens = addMaybe(byCell[entry.cell]!.actionTokens, actionTokens);
    byCell[entry.cell]!.requests += record.http?.length ?? 0;
    episodes.push({
      episodeId: id, cell: record.cell, arm: record.arm, satiety: record.satiety, outcome: record.outcome,
      goal: record.binding === null ? null : record.binding.goal,
      request: record.request === null ? null : record.request.status,
      verdict: record.fulfilment === null ? null : record.fulfilment.verdict,
      goalTokens, actionTokens,
    });
  }

  if (scope === 'complete') {
    for (const entry of frozen) {
      if (!seen.has(entry.episodeId) && !batch.episodes.some(record => record.outcome === 'not_run' && record.episodeId === entry.episodeId)) {
        issues.push(`${entry.episodeId}: the plan slot has no record at all`);
      }
    }
  }

  // The on-disk plan must equal the frozen contract (never its own standard).
  if (batch.plan !== null) {
    const disk = batch.plan.plan.map(entry => [entry.rep, entry.satiety, entry.arm]);
    const frozenMatrix = frozen.map(entry => [entry.rep, entry.satiety, entry.arm]);
    if (canonical(disk) !== canonical(frozenMatrix)) issues.push('plan.json does not match the frozen matrix');
    if (batch.plan.hardChatLimit !== G09_HARD_CHAT_LIMIT) issues.push(`plan.json hardChatLimit ${String(batch.plan.hardChatLimit)} is not the frozen ${G09_HARD_CHAT_LIMIT}`);
    if (batch.plan.runtime === undefined || canonical(batch.plan.runtime) !== canonical(g09RuntimeConfig())) issues.push('plan.json runtime is not the frozen runtime');
  }

  const ledger = deriveG09Ledger(batch.dir, batch.episodes);
  issues.push(...ledger.issues);
  if (ledger.begins > G09_HARD_CHAT_LIMIT) issues.push(`the batch spent ${ledger.begins} chat requests, more than the frozen ${G09_HARD_CHAT_LIMIT}`);
  if (campaign.spent > campaign.limit) issues.push(`the campaign spent ${campaign.spent} chat requests, more than its limit ${campaign.limit}`);

  const goalTokenValues = batch.episodes.map(record => tokensOf(record.http?.find(e => e.phase === 'goal')));
  const actionTokenValues = batch.episodes.map(record => tokensOf(record.http?.find(e => e.phase === 'action')));
  const costs: G09Summary['costs'] = {
    chatRequests: ledger.begins,
    spent: ledger.begins,
    blocked: ledger.blocked,
    unresolved: ledger.unresolved,
    usageUnknown: ledger.usageUnknown,
    goalTokens: sumOrNull(goalTokenValues),
    actionTokens: sumOrNull(actionTokenValues),
    totalTokens: ledger.knownTokenSum,
    campaignLimit: campaign.limit,
    campaignSpent: campaign.spent,
    byCell,
  };
  for (const cell of G09_CELLS) {
    const inCell = batch.episodes.filter(record => record.cell === cell.cell);
    if (inCell.some(record => tokensOf(record.http?.find(e => e.phase === 'goal')) === null)) byCell[cell.cell]!.goalTokens = null;
    if (inCell.some(record => tokensOf(record.http?.find(e => e.phase === 'action')) === null)) byCell[cell.cell]!.actionTokens = null;
  }
  return { issues, protocol, goals, fulfilment, costs, episodes };
}

function addMaybe(total: number | null, value: number | null): number | null {
  if (total === null || value === null) return null;
  return total + value;
}

function responseContent(exchange: G09HttpExchange): string {
  try {
    const body = JSON.parse(exchange.response.body) as { choices?: { message?: { content?: unknown } }[] };
    const content = body.choices?.[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  } catch {
    return '';
  }
}

/** The frozen goal prompt for an arm (candidate line normalised to <DATA>). */
export function renderFrozenGoalPrompt(arm: GoalArm, satiety: number = 40): string {
  const lines = [
    '你是 npc_a，位于kitchen。当前逻辑时间 0。',
    `你的饱食度：${satiety}。你所在位置的剩余食物：1。`,
    `玩家说：“${G09_REQUEST_TEXT}”`,
    '请从候选目标中选择一个，只回复一个 JSON 对象，不要输出任何其他内容。',
    'candidateGoals: <DATA>',
  ];
  void arm;
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* Verification                                                       */
/* ------------------------------------------------------------------ */

export interface G09VerifyResult {
  ok: boolean;
  evidenceOk: boolean;
  complete: boolean;
  runSucceeded: boolean;
  issues: string[];
  derivation: G09Derivation;
}

export function verifyG09Batch(
  batchDir: string,
  campaign: { limit: number; spent: number } = { limit: G09_HARD_CHAT_LIMIT, spent: 0 },
): G09VerifyResult {
  return verify(batchDir, campaign, 'complete');
}

export function verifyG09Prefix(
  batchDir: string,
  campaign: { limit: number; spent: number } = { limit: G09_HARD_CHAT_LIMIT, spent: 0 },
): G09VerifyResult {
  return verify(batchDir, campaign, 'prefix');
}

function verify(batchDir: string, campaign: { limit: number; spent: number }, scope: 'complete' | 'prefix'): G09VerifyResult {
  const batch = readG09Batch(batchDir);
  const frozen = frozenPlanEntries();
  const derivation = deriveG09(batch, frozen, campaign, scope);
  const issues = [...derivation.issues];
  const recorded = batch.episodes.filter(record => record.outcome !== 'not_run').length;
  const complete = recorded === frozen.length && batch.episodes.every(record => record.outcome === 'completed');
  if (scope === 'complete') {
    if (batch.summary === null) {
      issues.push('summary.json is missing: a complete batch must publish its own derivation');
    } else {
      issues.push(...compareG09Summary(batch.summary, derivation, batch.plan));
    }
    if (!complete) issues.push(`the batch is not complete: ${recorded}/${frozen.length} episodes ran`);
  } else {
    const pair = frozen.slice(0, 2).map(entry => entry.episodeId);
    const pairRecords = batch.episodes.filter(record => pair.includes(record.episodeId));
    if (pairRecords.length !== 2) issues.push(`the structural gate needs both first-pair episodes (${pair.join(', ')})`);
    for (const record of pairRecords) {
      if (record.outcome !== 'completed') issues.push(`${record.episodeId}: the structural gate requires a completed episode`);
      if ((record.http?.length ?? 0) !== 2) issues.push(`${record.episodeId}: the structural gate requires exactly two exchanges`);
      if (record.request === null || record.request.status === 'pending') {
        issues.push(`${record.episodeId}: the structural gate requires a decided request`);
      }
    }
  }
  const structural = issues.filter(issue => !issue.startsWith('summary.'));
  const evidenceOk = structural.length === 0;
  const ok = scope === 'complete' ? issues.length === 0 && complete : evidenceOk;
  return { ok, evidenceOk, complete, runSucceeded: ok, issues, derivation };
}

/** The summary must equal the projection; a self-declared summary never wins. */
export function compareG09Summary(summary: G09Summary, derivation: G09Derivation, plan: G09Plan | null): string[] {
  const issues: string[] = [];
  const check = (label: string, actual: unknown, derived: unknown): void => {
    if (canonical(actual) !== canonical(derived)) {
      issues.push(`summary.${label}: recorded ${JSON.stringify(actual)} but the contract derives ${JSON.stringify(derived)}`);
    }
  };
  check('hardChatLimit', summary.hardChatLimit, G09_HARD_CHAT_LIMIT);
  check('protocol', summary.protocol, derivation.protocol);
  check('goals', summary.goals, derivation.goals);
  check('fulfilment', summary.fulfilment, derivation.fulfilment);
  check('costs', summary.costs, derivation.costs);
  check('episodes', summary.episodes, derivation.episodes);
  if (plan !== null && summary.batch !== plan.batch) issues.push('summary.batch disagrees with the plan batch');
  return issues;
}

export function projectG09Summary(
  batch: string, mode: 'live' | 'fake', model: string | null, derivation: G09Derivation,
): G09Summary {
  return {
    schema: 'frostecho.g09.summary/2',
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

export { G09_SATIETY_LEVELS, G09_TIMEOUT_MS, G09_ALLOWED_GOALS };
export type { GoalChoiceId };
