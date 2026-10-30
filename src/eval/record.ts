/**
 * Interface (locked) — task/result recording, shared by B (writer/summary) and D (tests).
 * TaskRecord is written once per planned task (including not_run). summarizeBatchDir rebuilds the summary from disk only.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { GameRecord, ScenarioId } from '../play';
import { TransportKind, classifyTransport, isInfrastructure } from './health';
import { verifyGameEvidence } from './verify-game';

export const TASK_SCHEMA = 'frostecho.g02.task/1';
export const SUMMARY_SCHEMA = 'frostecho.g02.summary/2';

export type TaskStatus = 'pass' | 'behavior_fail' | 'interrupted' | 'not_run';
export type TaskPhase = 'gate' | 'main';

export interface ErrorCounts {
  transport: number;
  parse: number;
  decide: number;
  /** Engine rejections other than the expected S3 NO_FOOD. */
  execute: number;
  /** Expected S3 stale-observe NO_FOOD rejections. Not a system fault. */
  s3ExpectedNoFood: number;
}

export interface UsageTotals {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  /** HTTP requests whose response carried usage. */
  knownRequests: number;
  /** HTTP requests without usage (timeout, connect failure, server omitted it). Never counted as 0 tokens. */
  unknownRequests: number;
}

export interface Counters {
  /** Times the runner asked the provider for a decision (forwarded + intercepted). */
  decisionCalls: number;
  /** Calls forwarded past the local budget; this is what the 90 cap counts. */
  forwardedCalls: number;
  /** HTTP chat-completion requests actually sent (have a transport record). */
  httpRequests: number;
  /** Calls refused locally by the budget; never reached the network. */
  budgetIntercepts: number;
  latencyMs: number;
  usage: UsageTotals;
  errors: ErrorCounts;
}

export interface TaskRecord {
  schema: typeof TASK_SCHEMA;
  batchId: string;
  index: number;
  taskId: string;
  phase: TaskPhase;
  scenarioId: ScenarioId;
  thinking: boolean;
  rep: number;
  status: TaskStatus;
  notRunReason: 'gate_failed' | 'interrupted_earlier' | 'health_failed' | null;
  interruptKind: TransportKind | 'harness_error' | null;
  interruptError: string | null;
  scenarioPass: boolean | null;
  goalReached: boolean | null;
  outcome: string | null;
  replayMatches: boolean | null;
  counters: Counters;
  /** request→output→command→event→terminal trace, relative to the batch dir. */
  trace: { gameDir: string | null; requests: number; outputs: number; commands: number; events: number; terminal: string | null } ;
  startedAt: string | null;
  endedAt: string | null;
}

export function emptyErrors(): ErrorCounts {
  return { transport: 0, parse: 0, decide: 0, execute: 0, s3ExpectedNoFood: 0 };
}

export function emptyCounters(): Counters {
  return {
    decisionCalls: 0, forwardedCalls: 0, httpRequests: 0, budgetIntercepts: 0, latencyMs: 0,
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, knownRequests: 0, unknownRequests: 0 },
    errors: emptyErrors(),
  };
}

export function addCounters(into: Counters, from: Counters): void {
  into.decisionCalls += from.decisionCalls;
  into.forwardedCalls += from.forwardedCalls;
  into.httpRequests += from.httpRequests;
  into.budgetIntercepts += from.budgetIntercepts;
  into.latencyMs += from.latencyMs;
  for (const key of Object.keys(into.usage) as (keyof UsageTotals)[]) into.usage[key] += from.usage[key];
  for (const key of Object.keys(into.errors) as (keyof ErrorCounts)[]) into.errors[key] += from.errors[key];
}

/** First infrastructure failure in a game, if any. Budget intercepts are reported separately. */
export function firstInterrupt(record: GameRecord): { kind: TransportKind; error: string } | null {
  for (const step of record.steps) {
    const error = step.transport?.error ?? step.error ?? null;
    const kind = classifyTransport(error);
    if (kind && isInfrastructure(kind)) return { kind, error: error as string };
  }
  return null;
}

/** Counters for one game from its record alone (plus the local budget intercepts the harness saw). */
export function countGame(record: GameRecord, scenarioId: ScenarioId, budgetIntercepts: number): Counters {
  const c = emptyCounters();
  c.decisionCalls = record.providerCalls;
  c.budgetIntercepts = budgetIntercepts;
  c.forwardedCalls = record.providerCalls - budgetIntercepts;
  let transportLatency = 0;
  for (const step of record.steps) {
    const t = step.transport;
    if (t) {
      c.httpRequests += 1;
      transportLatency += t.latencyMs;
      if (t.usage) {
        c.usage.knownRequests += 1;
        c.usage.promptTokens += t.usage.prompt_tokens ?? 0;
        c.usage.completionTokens += t.usage.completion_tokens ?? 0;
        c.usage.totalTokens += t.usage.total_tokens ?? 0;
      } else c.usage.unknownRequests += 1;
    }
    const kind = classifyTransport(step.transport?.error ?? step.error);
    const parseError = step.parse.ok ? undefined : step.parse.error;
    if ((kind && kind !== 'budget') || parseError === 'timeout' || parseError === 'provider_error') c.errors.transport += 1;
    else if (kind === 'budget') { /* local intercept: counted in budgetIntercepts only */ }
    else if (!step.parse.ok) c.errors.parse += 1;
    if (step.exec?.status === 'rejected') {
      if (scenarioId === 's3' && step.exec.reason === 'NO_FOOD') c.errors.s3ExpectedNoFood += 1;
      else c.errors.execute += 1;
    }
  }
  if (record.outcome === 'budget_exhausted') c.errors.decide += 1;
  c.latencyMs = c.httpRequests > 0 ? transportLatency : record.timing.calls.reduce((sum, call) => sum + call.ms, 0);
  return c;
}

export interface CombinationRow {
  scenarioId: ScenarioId;
  thinking: boolean;
  planned: number;
  /** Completed without infrastructure interrupt (pass + behavior_fail). */
  valid: number;
  pass: number;
  behaviorFail: number;
  interrupted: number;
  notRun: number;
  goalReached: number;
  counters: Counters;
}

export interface RebuiltSummary {
  schema: typeof SUMMARY_SCHEMA;
  batchId: string;
  planned: number;
  byStatus: Record<TaskStatus, number>;
  combinations: CombinationRow[];
  byThinking: { true: Counters & { games: number; pass: number }; false: Counters & { games: number; pass: number } };
  global: Counters;
  notRun: string[];
  interrupted: { taskId: string; kind: string | null; error: string | null }[];
  issues: string[];
  complete: boolean;
  success: boolean;
}

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

export function readTasks(batchDir: string): TaskRecord[] {
  const dir = join(batchDir, 'tasks');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(name => name.endsWith('.json')).map(name => readJson<TaskRecord>(join(dir, name)))
    .sort((a, b) => a.index - b.index);
}

/**
 * Rebuild the summary from tasks/*.json and games/*, and cross-check status, replay and metadata.
 * Any mismatch lands in issues and makes success false.
 */
export function summarizeBatchDir(batchDir: string, batchId: string, expectedPlanned?: number): RebuiltSummary {
  const tasks = readTasks(batchDir);
  const issues: string[] = [];
  const byStatus: Record<TaskStatus, number> = { pass: 0, behavior_fail: 0, interrupted: 0, not_run: 0 };
  const combos = new Map<string, CombinationRow>();
  const global = emptyCounters();
  const think = { true: { ...emptyCounters(), games: 0, pass: 0 }, false: { ...emptyCounters(), games: 0, pass: 0 } };
  const notRun: string[] = [];
  const interrupted: RebuiltSummary['interrupted'] = [];
  const seen = new Set<string>();
  tasks.forEach((task, i) => {
    if (task.schema !== TASK_SCHEMA) issues.push(`${task.taskId}: unknown schema`);
    if (task.batchId !== batchId) issues.push(`${task.taskId}: batchId ${task.batchId} != ${batchId}`);
    if (task.index !== i) issues.push(`${task.taskId}: index ${task.index} out of order`);
    if (seen.has(task.taskId)) issues.push(`${task.taskId}: duplicate task`);
    seen.add(task.taskId);
    byStatus[task.status] += 1;
    const key = `${task.scenarioId}|${task.thinking}`;
    if (!combos.has(key)) {
      combos.set(key, { scenarioId: task.scenarioId, thinking: task.thinking, planned: 0, valid: 0, pass: 0, behaviorFail: 0, interrupted: 0, notRun: 0, goalReached: 0, counters: emptyCounters() });
    }
    const row = combos.get(key)!;
    row.planned += 1;
    if (task.status === 'pass') { row.pass += 1; row.valid += 1; }
    if (task.status === 'behavior_fail') { row.behaviorFail += 1; row.valid += 1; }
    if (task.status === 'interrupted') { row.interrupted += 1; interrupted.push({ taskId: task.taskId, kind: task.interruptKind, error: task.interruptError }); }
    if (task.status === 'not_run') {
      row.notRun += 1;
      notRun.push(task.taskId);
      if (task.counters.decisionCalls !== 0 || task.trace.gameDir) issues.push(`${task.taskId}: not_run but has calls or a game dir`);
      return;
    }
    if (task.goalReached) row.goalReached += 1;
    addCounters(row.counters, task.counters);
    addCounters(global, task.counters);
    const t = think[task.thinking ? 'true' : 'false'];
    addCounters(t, task.counters);
    t.games += 1;
    if (task.status === 'pass') t.pass += 1;
    // Cross-check against the per-game evidence on disk.
    if (!task.trace.gameDir) { issues.push(`${task.taskId}: ran but has no game dir`); return; }
    const gameDir = join(batchDir, task.trace.gameDir);
    if (!existsSync(join(gameDir, 'game.json'))) { issues.push(`${task.taskId}: game.json missing`); return; }
    // H01: full deterministic re-verification (never throws on corrupt JSON).
    const verification = verifyGameEvidence(gameDir);
    for (const issue of verification.issues) issues.push(`${task.taskId}: ${issue}`);
    const game = verification.game;
    if (!game) return; // game.json unreadable/corrupt: issues already recorded
    let meta: { batchId: string; thinking: boolean | null; scenarioPass: boolean | null; replayMatches: boolean; scenarioId: string | null } | null = null;
    let replay: { matches: boolean } | null = null;
    try { meta = readJson<{ batchId: string; thinking: boolean | null; scenarioPass: boolean | null; replayMatches: boolean; scenarioId: string | null }>(join(gameDir, 'meta.json')); } catch { issues.push(`${task.taskId}: meta.json unreadable`); }
    try { replay = readJson<{ matches: boolean }>(join(gameDir, 'replay.json')); } catch { issues.push(`${task.taskId}: replay.json unreadable`); }
    if (meta && (meta.batchId !== task.taskId || game.batchId !== task.taskId)) issues.push(`${task.taskId}: game batchId mismatch`);
    if (meta && meta.scenarioId !== task.scenarioId) issues.push(`${task.taskId}: scenario mismatch`);
    if (meta && game.mode === 'live' && meta.thinking !== task.thinking) issues.push(`${task.taskId}: thinking mismatch`);
    if (replay && meta && (replay.matches !== game.replayMatches || meta.replayMatches !== game.replayMatches)) issues.push(`${task.taskId}: replay evidence mismatch`);
    if (task.status === 'pass' && (game.scenarioPass !== true || !game.replayMatches)) issues.push(`${task.taskId}: status pass contradicts game.json`);
    if (task.status === 'behavior_fail' && game.scenarioPass !== false) issues.push(`${task.taskId}: status behavior_fail contradicts game.json`);
    try {
      const recount = countGame(game, task.scenarioId, task.counters.budgetIntercepts);
      if (JSON.stringify(recount) !== JSON.stringify(task.counters)) issues.push(`${task.taskId}: counters do not match game.json`);
    } catch { issues.push(`${task.taskId}: counters cannot be recomputed from game.json`); }
    if (task.trace.requests !== game.steps.filter(s => s.transport).length || task.trace.commands !== game.commands.length || task.trace.events !== game.events.length) {
      issues.push(`${task.taskId}: trace counts do not match game.json`);
    }
  });
  const rows = [...combos.values()];
  // Reconcile global vs group vs step.
  const sumRows = emptyCounters();
  rows.forEach(row => addCounters(sumRows, row.counters));
  const sumThink = emptyCounters();
  addCounters(sumThink, think.true);
  addCounters(sumThink, think.false);
  if (JSON.stringify(sumRows) !== JSON.stringify(global)) issues.push('combination counters do not reconcile with global');
  if (JSON.stringify(sumThink) !== JSON.stringify(global)) issues.push('thinking-group counters do not reconcile with global');
  if (global.decisionCalls !== global.forwardedCalls + global.budgetIntercepts) issues.push('decisionCalls != forwarded + intercepts');
  const planned = tasks.length;
  if (expectedPlanned !== undefined && planned !== expectedPlanned) issues.push(`planned ${planned} tasks but expected ${expectedPlanned}`);
  const complete = byStatus.not_run === 0 && byStatus.interrupted === 0 && planned > 0;
  return {
    schema: SUMMARY_SCHEMA,
    batchId,
    planned,
    byStatus,
    combinations: rows,
    byThinking: think,
    global,
    notRun,
    interrupted,
    issues,
    complete,
    success: complete && byStatus.behavior_fail === 0 && issues.length === 0,
  };
}
