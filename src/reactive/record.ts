/**
 * G04 workstream C — evidence persistence and independent verification.
 *
 * Layout: artifacts/g04/<batch>/episodes/<episodeId>/{meta.json,game.json}.
 * game.json carries the single world history (commands + events) plus one turn
 * per decision and one transition per lifecycle change. meta.json is a small
 * sidecar used to detect partial writes.
 *
 * Verification never trusts a saved pass flag: it replays the command ledger,
 * re-derives the events, re-parses every stored raw output, re-checks the
 * cycle/actor budget ledgers, re-judges the scenario from the final state, and
 * cross-checks every request body against the recorded configuration.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { HTTP_SAMPLING } from '../agent/providers/http';
import { GOAL_HUNGER_AT_LEAST } from '../agent/contracts';
import { G05_SCHEMA } from './contracts';
import { parseAction } from '../agent/parser';
import { Engine, replay } from '../engine';
import type { WorldState } from '../types';
import { canonical } from '../util';
import {
  EPISODE_CALL_LIMIT, G04_BATCH_SCHEMA, G04_SCHEMA, SESSION_CALL_LIMIT,
  type ReactiveRecord, type ReactiveTransition,
} from './contracts';
import { loadScenario, type ScenarioJudgement } from './scenarios';
import type { ScenarioId } from './contracts';

type JsonObject = Record<string, unknown>;

const isPlainObject = (value: unknown): value is JsonObject => typeof value === 'object' && value !== null && !Array.isArray(value);

function readJson(path: string): { value: unknown; error: string | null } {
  try {
    return { value: JSON.parse(readFileSync(path, 'utf8')), error: null };
  } catch (err) {
    return { value: undefined, error: err instanceof Error ? err.message : String(err) };
  }
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
}

/* ------------------------------------------------------------------ */
/* persistence                                                         */
/* ------------------------------------------------------------------ */

export function writeReactiveEpisode(artifactsRoot: string, batch: string, record: ReactiveRecord): string {
  const dir = join(artifactsRoot, batch, 'episodes', record.episodeId);
  mkdirSync(dir, { recursive: true });
  const meta: Record<string, unknown> = {
    schema: record.schema,
    episodeId: record.episodeId,
    scenarioId: record.scenarioId,
    wakePolicy: record.wakePolicy,
    mode: record.mode,
    thinking: record.thinking,
    actorOrder: record.actorOrder,
    stopReason: record.stopReason,
    commands: record.commands.length,
    events: record.events.length,
    actors: record.actors,
    scenarioPass: record.scenarioPass,
    idlePumps: record.idlePumps,
  };
  if (record.schema === G05_SCHEMA) {
    meta.needPolicy = record.needPolicy ?? 'never';
    meta.needs = (record.needs ?? []).length;
  }
  writeJson(join(dir, 'meta.json'), meta);
  writeJson(join(dir, 'game.json'), record);
  return dir;
}

export function writeReactiveBatchFile(batchDir: string, value: unknown): void {
  mkdirSync(batchDir, { recursive: true });
  writeJson(join(batchDir, 'batch.json'), value);
}

/* ------------------------------------------------------------------ */
/* verification                                                        */
/* ------------------------------------------------------------------ */

export interface ReactiveVerification {
  ok: boolean;
  issues: string[];
  record: ReactiveRecord | null;
  judgement: ScenarioJudgement | null;
  sourceBound: boolean;
}

const emptyVerification = (issues: string[]): ReactiveVerification => ({ ok: false, issues, record: null, judgement: null, sourceBound: false });

/**
 * Deterministic re-derivation of one episode. Order of checks:
 * roots → schema → sidecar → command replay → event replay → turn ledger →
 * parse re-check → cycle/budget ledger → transitions → request bodies →
 * scenario judgement.
 */
export function verifyReactiveEpisode(episodeDir: string): ReactiveVerification {
  const issues: string[] = [];
  const metaPath = join(episodeDir, 'meta.json');
  const gamePath = join(episodeDir, 'game.json');
  for (const path of [metaPath, gamePath]) {
    if (!existsSync(path)) return emptyVerification([`${path} is missing`]);
  }
  const metaRead = readJson(metaPath);
  if (metaRead.error !== null) return emptyVerification([`meta.json unreadable: ${metaRead.error}`]);
  const gameRead = readJson(gamePath);
  if (gameRead.error !== null) return emptyVerification([`game.json unreadable: ${gameRead.error}`]);
  const meta = metaRead.value;
  const record = gameRead.value;
  if (!isPlainObject(meta)) return emptyVerification(['meta.json root is not a non-null object']);
  if (!isPlainObject(record)) return emptyVerification(['game.json root is not a non-null object']);
  if (record.schema !== G04_SCHEMA && record.schema !== G05_SCHEMA) {
    return emptyVerification([`game.json schema is ${String(record.schema)}, expected ${G04_SCHEMA} or ${G05_SCHEMA}`]);
  }

  // sidecar must match the record it describes
  const fields: [string, unknown, unknown][] = [
    ['episodeId', meta.episodeId, record.episodeId],
    ['scenarioId', meta.scenarioId, record.scenarioId],
    ['wakePolicy', meta.wakePolicy, record.wakePolicy],
    ['mode', meta.mode, record.mode],
    ['thinking', meta.thinking, record.thinking],
    ['stopReason', meta.stopReason, record.stopReason],
    ['commands', meta.commands, (record.commands as unknown[]).length],
    ['events', meta.events, (record.events as unknown[]).length],
  ];
  if (record.schema === G05_SCHEMA) {
    fields.push(
      ['needPolicy', meta.needPolicy, (record as unknown as ReactiveRecord).needPolicy ?? 'never'],
      ['needs', meta.needs, ((record as unknown as ReactiveRecord).needs ?? []).length],
    );
  }
  for (const [name, left, right] of fields) {
    if (canonical(left) !== canonical(right)) issues.push(`meta.json ${name} does not match game.json`);
  }

  const typed = record as unknown as ReactiveRecord;
  const initialState = typed.initialState as WorldState;

  // command ledger replay in a fresh Engine
  const engine = new Engine(structuredClone(initialState));
  for (const entry of Array.isArray(typed.commands) ? typed.commands : []) {
    if (!isPlainObject(entry) || !isPlainObject(entry.command)) {
      issues.push('command ledger entry is malformed');
      continue;
    }
    const result = engine.submit(structuredClone(entry.command as never));
    // LogEntry stores the execution outcome nested under `result`.
    const saved: JsonObject = isPlainObject(entry.result) ? entry.result : {};
    const savedStatus = typeof saved.status === 'string' ? saved.status : '';
    const savedReason = typeof saved.reason === 'string' ? saved.reason : undefined;
    if (savedStatus === 'accepted') {
      if (result.status !== 'accepted') issues.push(`command ${String((entry.command as JsonObject).commandId)} no longer executes (${result.status})`);
    } else if (savedStatus === 'duplicate') {
      if (result.status !== 'duplicate') issues.push(`command ${String((entry.command as JsonObject).commandId)} is no longer a duplicate`);
    } else if (savedStatus === 'rejected') {
      if (result.status !== 'rejected' || result.reason !== savedReason) {
        issues.push(`command ${String((entry.command as JsonObject).commandId)} rejection no longer reproduces`);
      }
    }
  }
  if (canonical(engine.getEvents()) !== canonical(typed.events)) issues.push('event ledger does not match the replayed ledger');
  if (canonical(engine.getState()) !== canonical(typed.finalState)) issues.push('final state does not match the replayed state');
  if (canonical(replay(initialState, typed.events)) !== canonical(typed.finalState)) issues.push('replay diverges from the final state');

  // turn ledger: global order, rounds, command ids and budgets
  const cyclesAny = isPlainObject(typed.cycles) ? typed.cycles : {};
  const turns: JsonObject[] = [];
  for (const actorId of typed.actorOrder) {
    const list = Array.isArray(cyclesAny[actorId]) ? (cyclesAny[actorId] as unknown as JsonObject[]) : [];
    for (const cycle of list) {
      if (Array.isArray(cycle.turns)) turns.push(...(cycle.turns as JsonObject[]));
    }
  }
  turns.sort((a, b) => Number(a.globalTurn) - Number(b.globalTurn));
  const committedCommandIds = new Set((Array.isArray(typed.commands) ? typed.commands : []).map(entry => String((entry.command as JsonObject)?.commandId ?? '')));
  const seenIds = new Set<string>();
  let lastGlobal = 0;
  for (const turn of turns) {
    if (!isPlainObject(turn)) { issues.push('turn entry is malformed'); continue; }
    const globalTurn = Number(turn.globalTurn);
    if (!Number.isInteger(globalTurn) || globalTurn <= lastGlobal) issues.push(`turn ${String(turn.globalTurn)} is out of order`);
    lastGlobal = Number.isFinite(globalTurn) ? globalTurn : lastGlobal;
    const step = turn.step as JsonObject | undefined;
    const actorId = String(turn.actorId);
    const cycle = Number(turn.cycle);
    const round = Number(turn.actorRound);
    if (!Number.isInteger(cycle) || cycle < 1) issues.push(`turn ${String(turn.globalTurn)}: bad cycle ${String(turn.cycle)}`);
    if (!Number.isInteger(round) || round < 1) issues.push(`turn ${String(turn.globalTurn)}: bad actor round ${String(turn.actorRound)}`);
    if (step && isPlainObject(step.command)) {
      const commandId = String((step.command as JsonObject).commandId);
      const expected = `${typed.episodeId}:npc:${actorId}:${String(cycle)}:${String(round)}`;
      if (commandId !== expected) issues.push(`turn ${String(turn.globalTurn)}: commandId ${commandId} != ${expected}`);
      if (seenIds.has(commandId)) issues.push(`turn ${String(turn.globalTurn)}: duplicate commandId ${commandId}`);
      seenIds.add(commandId);
      if (!committedCommandIds.has(commandId)) issues.push(`turn ${String(turn.globalTurn)}: command ${commandId} is missing from the world ledger`);
      if (step.exec === undefined || step.exec === null) issues.push(`turn ${String(turn.globalTurn)}: command without an exec record`);
    }
    if (step && typeof step.raw === 'string' && step.raw.length > 0) {
      const reparsed = parseAction(step.raw);
      const saved = step.parse as JsonObject | undefined;
      if (!saved || saved.ok !== reparsed.ok) issues.push(`turn ${String(turn.globalTurn)}: stored parse verdict no longer reproduces`);
      else if (reparsed.ok && canonical((saved as JsonObject).action) !== canonical(reparsed.action)) {
        issues.push(`turn ${String(turn.globalTurn)}: stored parse action no longer reproduces`);
      }
    }
  }

  // cycle ledger and the two budgets
  const cycles = isPlainObject(typed.cycles) ? typed.cycles : {};
  const isG05 = typed.schema === G05_SCHEMA;
  for (const actorId of typed.actorOrder) {
    const list = Array.isArray(cycles[actorId]) ? (cycles[actorId] as unknown as JsonObject[]) : [];
    if (list.length === 0) issues.push(`actor ${actorId} has no cycle record`);
    let previousCycle = 0;
    let actorCalls = 0;
    let autoCalls = 0;
    for (const cycle of list) {
      const number = Number(cycle.cycle);
      if (number !== previousCycle + 1) issues.push(`actor ${actorId}: cycle ${String(cycle.cycle)} is not consecutive`);
      previousCycle = number;
      const cycleTurns = Array.isArray(cycle.turns) ? (cycle.turns as JsonObject[]) : [];
      const rounds = cycleTurns.map(turn => Number(turn.actorRound)).sort((a, b) => a - b);
      for (let i = 0; i < rounds.length; i++) {
        if (rounds[i] !== i + 1) { issues.push(`actor ${actorId} cycle ${String(number)}: rounds are not 1..n`); break; }
      }
      const providerCalls = Number(cycle.providerCalls);
      if (!Number.isInteger(providerCalls) || providerCalls < 0 || providerCalls > SESSION_CALL_LIMIT) {
        issues.push(`actor ${actorId} cycle ${String(number)}: ${String(cycle.providerCalls)} calls exceeds the ${SESSION_CALL_LIMIT}-call session budget`);
      }
      const counted = cycleTurns.filter(turn => turn.providerCalled === true).length;
      if (counted !== providerCalls) issues.push(`actor ${actorId} cycle ${String(number)}: providerCalls ${providerCalls} != ${counted} flagged turns`);
      actorCalls += providerCalls;
      // G05: need cycles run on the need decision budget and are exempt here.
      const reason = typeof cycle.reason === 'string' ? cycle.reason : '';
      if (!(isG05 && reason.startsWith('need cycle'))) autoCalls += providerCalls;
    }
    const summary = isPlainObject(typed.actors) ? (typed.actors[actorId] as unknown as JsonObject | undefined) : undefined;
    const declared = summary ? Number(summary.providerCalls) : NaN;
    if (declared !== actorCalls) issues.push(`actor ${actorId}: summary calls ${String(declared)} != cycle total ${actorCalls}`);
    if (autoCalls > EPISODE_CALL_LIMIT) issues.push(`actor ${actorId}: ${autoCalls} autonomous calls exceeds the ${EPISODE_CALL_LIMIT}-call episode budget`);
    const hunger = (typed.finalState as WorldState).npcs[actorId]?.hunger;
    const goal = summary?.goalReached;
    if (typeof hunger === 'number' && goal !== (hunger >= GOAL_HUNGER_AT_LEAST)) issues.push(`actor ${actorId}: goalReached flag contradicts the authoritative hunger ${hunger}`);
  }

  // transition ledger
  const transitions = Array.isArray(typed.transitions) ? (typed.transitions as ReactiveTransition[]) : [];
  let lastCursor = 0;
  transitions.forEach((transition, index) => {
    if (transition.seq !== index + 1) issues.push(`transition ${String(transition.seq)} is out of order`);
    if (transition.logCursor < lastCursor) issues.push(`transition ${String(transition.seq)} has a non-monotonic world cursor`);
    lastCursor = transition.logCursor;
    if (transition.logCursor > (typed.commands as unknown[]).length) issues.push(`transition ${String(transition.seq)} points past the world ledger`);
  });
  for (const actorId of typed.actorOrder) {
    const first = transitions.find(transition => transition.actorId === actorId);
    if (!first) issues.push(`actor ${actorId} has no lifecycle transition`);
    else if (first.from !== null) issues.push(`actor ${actorId}: first transition must start from null`);
  }

  // request bodies vs recorded configuration
  const bodies: JsonObject[] = [];
  for (const turn of turns) {
    const step = isPlainObject(turn) ? (turn.step as JsonObject | undefined) : undefined;
    const transport = step && isPlainObject(step.transport) ? (step.transport as JsonObject) : null;
    if (transport === null) {
      if (typed.mode === 'live' && turn.providerCalled !== false) issues.push(`turn ${String(turn.globalTurn)}: live decision without a transport record`);
      continue;
    }
    const body = transport.requestBody;
    if (!isPlainObject(body)) { issues.push(`turn ${String(turn.globalTurn)}: transport.requestBody is not an object`); continue; }
    bodies.push(body);
    const kwargs = body.chat_template_kwargs;
    const thinking = isPlainObject(kwargs) ? kwargs.enable_thinking : undefined;
    if (thinking !== typed.thinking) {
      issues.push(`turn ${String(turn.globalTurn)}: request enable_thinking=${String(thinking)} contradicts recorded thinking=${String(typed.thinking)}`);
    }
    if (body.temperature !== HTTP_SAMPLING.temperature || body.max_tokens !== HTTP_SAMPLING.max_tokens || body.stream !== HTTP_SAMPLING.stream) {
      issues.push(`turn ${String(turn.globalTurn)}: request sampling differs from the declared HTTP profile`);
    }
  }
  const config = typed.requestConfig as unknown as JsonObject | undefined;
  if (config && bodies.length > 0) {
    const models = new Set(bodies.map(body => String(body.model ?? '')));
    if (models.size !== 1) issues.push('request bodies name more than one model');
    else if (String(config.model) !== [...models][0]) issues.push('requestConfig.model does not match the request bodies');
  }

  // scenario judgement, recomputed
  let judgement: ScenarioJudgement | null = null;
  if (typeof typed.scenarioId === 'string') {
    const scenario = loadScenario(typed.scenarioId as ScenarioId);
    judgement = scenario.judge(typed);
    if (typed.scenarioPass !== judgement.pass) issues.push(`stored scenarioPass=${String(typed.scenarioPass)} contradicts the recomputed ${String(judgement.pass)}`);
  }

  return {
    ok: issues.length === 0,
    issues,
    record: typed,
    judgement,
    sourceBound: typed.mode !== 'reference',
  };
}

/* ------------------------------------------------------------------ */
/* batch summary                                                       */
/* ------------------------------------------------------------------ */

export interface ReactiveSummaryRow {
  episodeId: string;
  scenarioId: string | null;
  wakePolicy: string;
  verdict: 'pass' | 'behavior_fail' | 'configuration_fail' | 'source_unbound' | 'invalid' | 'interrupted' | 'not_run';
  valid: boolean;
  issues: string[];
  calls: number;
  detail: string | null;
}

export interface ReactiveBatchSummary {
  schema: typeof G04_BATCH_SCHEMA;
  batchId: string;
  rows: ReactiveSummaryRow[];
  totals: {
    episodes: number;
    pass: number;
    behavior_fail: number;
    configuration_fail: number;
    invalid: number;
    interrupted: number;
    notRun: number;
    providerCalls: number;
    replayMismatches: number;
  };
  byPolicy: Record<string, { episodes: number; pass: number; calls: number }>;
  issues: string[];
}

export function summarizeReactiveBatchDir(batchDir: string): ReactiveBatchSummary {
  const issues: string[] = [];
  const rows: ReactiveSummaryRow[] = [];
  const episodesDir = join(batchDir, 'episodes');
  const ids = existsSync(episodesDir) ? readdirSync(episodesDir).sort() : [];
  for (const episodeId of ids) {
    const dir = join(episodesDir, episodeId);
    const verification = verifyReactiveEpisode(dir);
    const record = verification.record;
    if (record === null) {
      rows.push({ episodeId, scenarioId: null, wakePolicy: '', verdict: 'invalid', valid: false, issues: verification.issues, calls: 0, detail: null });
      continue;
    }
    const calls = Object.values(record.actors).reduce((sum, actor) => sum + actor.providerCalls, 0);
    const detail = verification.judgement?.detail ?? null;
    let verdict: ReactiveSummaryRow['verdict'];
    if (record.stopReason === 'interrupted') verdict = 'interrupted';
    else if (!verification.ok) verdict = record.scenarioPass === false ? 'behavior_fail' : 'configuration_fail';
    else verdict = record.scenarioPass === true ? 'pass' : 'behavior_fail';
    rows.push({
      episodeId,
      scenarioId: record.scenarioId,
      wakePolicy: record.wakePolicy,
      verdict,
      valid: verification.ok,
      issues: verification.issues,
      calls,
      detail,
    });
    if (!record.replayMatches) issues.push(`${episodeId}: replay mismatch`);
  }
  const count = (verdict: ReactiveSummaryRow['verdict']): number => rows.filter(row => row.verdict === verdict).length;
  const byPolicy: ReactiveBatchSummary['byPolicy'] = {};
  for (const row of rows) {
    const bucket = (byPolicy[row.wakePolicy] ??= { episodes: 0, pass: 0, calls: 0 });
    bucket.episodes += 1;
    bucket.calls += row.calls;
    if (row.verdict === 'pass') bucket.pass += 1;
  }
  return {
    schema: G04_BATCH_SCHEMA,
    batchId: batchDir.split('/').pop() ?? '',
    rows,
    totals: {
      episodes: rows.length,
      pass: count('pass'),
      behavior_fail: count('behavior_fail'),
      configuration_fail: count('configuration_fail'),
      invalid: count('invalid'),
      interrupted: count('interrupted'),
      notRun: 0,
      providerCalls: rows.reduce((sum, row) => sum + row.calls, 0),
      replayMismatches: rows.filter(row => row.verdict === 'configuration_fail' && row.issues.some(issue => issue.includes('replay'))).length,
    },
    byPolicy,
    issues,
  };
}

export function writeReactiveSummary(batchDir: string, summary: ReactiveBatchSummary): void {
  writeJson(join(batchDir, 'summary.json'), summary);
}
