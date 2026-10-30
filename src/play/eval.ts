/**
 * Workstream B — experiment scheduling and summary.
 * Uses the locked interfaces: health (../eval/health), batch store (../eval/store), task records (../eval/record).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  HTTP_SAMPLING, LIVE_DECISION_TIMEOUT_MS, Provider, ProviderTransportError, createHttpProvider, createReferenceProvider,
  enableThinkingFromEnv, liveTimeoutMs, loadHttpConfigFromEnv,
} from '../agent';
import { HEALTH_TIMEOUT_MS, HealthCheck, HealthResult, checkLlmHealth } from '../eval/health';
import {
  Counters, ErrorCounts, RebuiltSummary, SUMMARY_SCHEMA, TASK_SCHEMA, TaskPhase, TaskRecord,
  countGame, emptyCounters, emptyErrors, firstInterrupt, summarizeBatchDir,
} from '../eval/record';
import { BatchStore, BatchStoreError, VersionInfo, collectVersion, createBatchStore, sourceFingerprint } from '../eval/store';
import { saveGameRecord } from './game';
import { SCENARIO_IDS, ScenarioId, runScenario } from './scenarios';

export const G02_MAX_CALLS = 90;
export const G02_REPS = 3;
export const G02_BATCH_SCHEMA = 'frostecho.g02.batch/2';

export type { ErrorCounts };

export interface G02GroupSummary {
  games: number;
  scenarioPass: number;
  passRate: number;
  goalReached: number;
  /** Calls forwarded past the local budget (what the cap counts). */
  requestCount: number;
  httpRequests: number;
  decisionCalls: number;
  budgetIntercepts: number;
  latencyMs: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  usageKnownRequests: number;
  /** Requests without usage. Token totals are a lower bound when this is > 0. */
  usageUnknownRequests: number;
  errors: ErrorCounts;
}

export interface G02Summary {
  schema: typeof SUMMARY_SCHEMA;
  mode: 'fixture' | 'live';
  /** True only for a live run that uses the process HTTP stack. Injected fetch and fixture mode are false. */
  realModel: boolean;
  model: string | null;
  thinkingDefault: true;
  batchId: string;
  gamesPlanned: number;
  /** Games that completed without an interrupt (pass + behavior_fail). */
  gamesRun: number;
  maxProviderCalls: number;
  requestCount: number;
  httpRequests: number;
  decisionCalls: number;
  budgetIntercepts: number;
  callCapExceeded: boolean;
  serial: true;
  retries: 0;
  gate: { size: number; passed: boolean | null };
  stopReason: 'completed' | 'gate_failed' | 'infrastructure_interrupt' | 'budget' | 'health_failed' | 'harness_error';
  health: HealthResult | null;
  byScenario: Record<ScenarioId, { games: number; scenarioPass: number; passRate: number; goalReached: number }>;
  byThinking: { true: G02GroupSummary; false: G02GroupSummary };
  errors: ErrorCounts;
  rebuilt: RebuiltSummary;
  notes: string[];
}

export interface G02EvalOptions {
  mode: 'fixture' | 'live';
  root: string;
  batchId?: string;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  providerFactory?: (ctx: { thinking: boolean; scenarioId: ScenarioId; rep: number }) => Provider;
  /** Injectable health check. Defaults to one GET /models in live mode; skipped in fixture mode. */
  health?: HealthCheck;
  scenarios?: readonly ScenarioId[];
  reps?: number;
  thinkingValues?: readonly boolean[];
  maxCalls?: number;
  /** Run rep 1 of every combination first and continue only if all pass. Default true. */
  gate?: boolean;
  now?: () => number;
  timeoutMs?: number;
  repoRoot?: string;
}

export interface G02EvalOutput {
  summary: G02Summary;
  exitCode: 0 | 1 | 2;
  batchDir: string | null;
}

interface PlannedTask {
  index: number;
  taskId: string;
  phase: TaskPhase;
  scenarioId: ScenarioId;
  thinking: boolean;
  rep: number;
}

/** Paired order: rep → scenario → thinking alternating on/off. Rep 1 is the gate. */
export function planG02(scenarios: readonly ScenarioId[], reps: number, thinkingValues: readonly boolean[], gate = true): PlannedTask[] {
  const out: PlannedTask[] = [];
  for (let rep = 1; rep <= reps; rep++) {
    for (const scenarioId of scenarios) {
      for (const thinking of thinkingValues) {
        out.push({
          index: out.length,
          taskId: `${scenarioId}-thinking-${thinking ? 'on' : 'off'}-rep-${rep}`,
          phase: gate && rep === 1 ? 'gate' : 'main',
          scenarioId, thinking, rep,
        });
      }
    }
  }
  return out;
}

export function allocateG02BatchId(mode: 'fixture' | 'live', now: () => number = Date.now): string {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
  const suffix = Math.random().toString(16).slice(2, 8);
  return `${mode}-${stamp}-${suffix}`;
}

interface Budget { calls: number; max: number; exceeded: boolean }

function capProvider(inner: Provider, budget: Budget, local: { intercepts: number }): Provider {
  return {
    decide(input, signal) {
      if (budget.calls >= budget.max) {
        budget.exceeded = true;
        local.intercepts += 1;
        return Promise.reject(new ProviderTransportError('provider call cap'));
      }
      budget.calls += 1;
      return Promise.resolve(inner.decide(input, signal));
    },
    consumeTransport() {
      return inner.consumeTransport?.() ?? null;
    },
  };
}

function groupFrom(c: Counters & { games: number; pass: number }, goalReached: number): G02GroupSummary {
  return {
    games: c.games,
    scenarioPass: c.pass,
    passRate: c.games === 0 ? 0 : c.pass / c.games,
    goalReached,
    requestCount: c.forwardedCalls,
    httpRequests: c.httpRequests,
    decisionCalls: c.decisionCalls,
    budgetIntercepts: c.budgetIntercepts,
    latencyMs: c.latencyMs,
    promptTokens: c.usage.promptTokens,
    completionTokens: c.usage.completionTokens,
    totalTokens: c.usage.totalTokens,
    usageKnownRequests: c.usage.knownRequests,
    usageUnknownRequests: c.usage.unknownRequests,
    errors: c.errors,
  };
}

function emptyRebuilt(batchId: string): RebuiltSummary {
  const z = () => ({ ...emptyCounters(), games: 0, pass: 0 });
  return {
    schema: SUMMARY_SCHEMA, batchId, planned: 0, byStatus: { pass: 0, behavior_fail: 0, interrupted: 0, not_run: 0 },
    combinations: [], byThinking: { true: z(), false: z() }, global: emptyCounters(), notRun: [], interrupted: [],
    issues: [], complete: false, success: false,
  };
}

function notRunTask(batchId: string, task: PlannedTask, reason: TaskRecord['notRunReason']): TaskRecord {
  return {
    schema: TASK_SCHEMA, batchId, index: task.index, taskId: task.taskId, phase: task.phase,
    scenarioId: task.scenarioId, thinking: task.thinking, rep: task.rep, status: 'not_run', notRunReason: reason,
    interruptKind: null, interruptError: null, scenarioPass: null, goalReached: null, outcome: null, replayMatches: null,
    counters: emptyCounters(), trace: { gameDir: null, requests: 0, outputs: 0, commands: 0, events: 0, terminal: null },
    startedAt: null, endedAt: null,
  };
}

function taskFile(task: { index: number; taskId: string }): string {
  return `tasks/${String(task.index).padStart(3, '0')}-${task.taskId}.json`;
}

/**
 * Gate (rep 1, 6 games) then the remaining reps up to 18. Requests are serial, capped (default 90), never retried.
 * An infrastructure failure or budget intercept ends the batch at once; finished games stay, the rest are not_run.
 */
export async function runG02Eval(options: G02EvalOptions): Promise<G02EvalOutput> {
  const env = options.env ?? process.env;
  const scenarios = options.scenarios ?? SCENARIO_IDS;
  const reps = options.reps ?? G02_REPS;
  const thinkingValues = options.thinkingValues ?? [true, false];
  const maxCalls = options.maxCalls ?? G02_MAX_CALLS;
  const now = options.now ?? Date.now;
  const iso = () => new Date(now()).toISOString();
  const config = options.mode === 'live' ? loadHttpConfigFromEnv(env) : null;
  const plan = planG02(scenarios, reps, thinkingValues, options.gate ?? true);
  const realModel = options.mode === 'live' && !!config && !options.fetchImpl && !options.providerFactory;

  const baseSummary = (batchId: string, extra: Partial<G02Summary>): G02Summary => ({
    schema: SUMMARY_SCHEMA, mode: options.mode, realModel: false, model: config?.model ?? null, thinkingDefault: true,
    batchId, gamesPlanned: plan.length, gamesRun: 0, maxProviderCalls: maxCalls, requestCount: 0, httpRequests: 0,
    decisionCalls: 0, budgetIntercepts: 0, callCapExceeded: false, serial: true, retries: 0,
    gate: { size: plan.filter(t => t.phase === 'gate').length, passed: null }, stopReason: 'health_failed', health: null,
    byScenario: {
      s1: { games: 0, scenarioPass: 0, passRate: 0, goalReached: 0 },
      s2: { games: 0, scenarioPass: 0, passRate: 0, goalReached: 0 },
      s3: { games: 0, scenarioPass: 0, passRate: 0, goalReached: 0 },
    },
    byThinking: { true: groupFrom({ ...emptyCounters(), games: 0, pass: 0 }, 0), false: groupFrom({ ...emptyCounters(), games: 0, pass: 0 }, 0) },
    errors: emptyErrors(), rebuilt: emptyRebuilt(batchId), notes: [], ...extra,
  });

  if (options.mode === 'live' && !config && !options.providerFactory) {
    const missing = ['FROSTECHO_LLM_URL', 'FROSTECHO_LLM_MODEL'].filter(name => !env[name]?.trim());
    return { summary: baseSummary('', { notes: [`missing required live config: ${missing.join(', ')}`] }), exitCode: 2, batchDir: null };
  }

  const batchId = options.batchId ?? allocateG02BatchId(options.mode, now);
  // C: exclusive create before any request. Duplicate / out-of-bounds names never touch the network.
  let store: BatchStore;
  try {
    store = createBatchStore(options.root, batchId);
  } catch (err) {
    if (err instanceof BatchStoreError) {
      return { summary: baseSummary(batchId, { notes: [`batch store refused: ${err.code}: ${err.message}`] }), exitCode: 2, batchDir: null };
    }
    throw err;
  }

  const timeoutMs = options.timeoutMs ?? liveTimeoutMs(env, LIVE_DECISION_TIMEOUT_MS);
  const version: VersionInfo = collectVersion(options.repoRoot ?? process.cwd());
  const startedAt = iso();

  // A: health before the batch (live HTTP only).
  let health: HealthResult | null = null;
  if (options.mode === 'live' && config && !options.providerFactory) {
    const check = options.health ?? checkLlmHealth;
    health = await check({ url: config.url, model: config.model, apiKey: config.apiKey }, { fetchImpl: options.fetchImpl, timeoutMs: HEALTH_TIMEOUT_MS, now });
    store.writeJson('health.json', health);
  }

  store.writeJson('batch.json', {
    schema: G02_BATCH_SCHEMA,
    batchId,
    mode: options.mode,
    realModel,
    requestedModel: config?.model ?? null,
    actualModel: health?.ok ? config?.model ?? null : null,
    servedModels: health?.models ?? null,
    sampling: { temperature: HTTP_SAMPLING.temperature, max_tokens: HTTP_SAMPLING.max_tokens, stream: HTTP_SAMPLING.stream, productionEnableThinking: HTTP_SAMPLING.chat_template_kwargs.enable_thinking, thinkingValues },
    timeouts: { decisionMs: timeoutMs, healthMs: HEALTH_TIMEOUT_MS },
    maxProviderCalls: maxCalls,
    retries: 0,
    serial: true,
    autoRestartService: false,
    plan: plan.map(t => ({ index: t.index, taskId: t.taskId, phase: t.phase })),
    version,
    startedAt,
  });

  const budget: Budget = { calls: 0, max: maxCalls, exceeded: false };
  const factory = options.providerFactory ?? ((ctx: { thinking: boolean }) => {
    if (options.mode === 'fixture' || !config) return createReferenceProvider();
    return createHttpProvider({ ...config, enableThinking: ctx.thinking, fetchImpl: options.fetchImpl });
  });

  let stopReason: G02Summary['stopReason'] = 'completed';
  let gatePassed: boolean | null = null;
  let cursor = 0;
  if (health && !health.ok) {
    stopReason = 'health_failed';
    for (const task of plan) store.writeJson(taskFile(task), notRunTask(batchId, task, 'health_failed'));
    cursor = plan.length;
  }

  for (; cursor < plan.length; cursor++) {
    const task = plan[cursor];
    if (task.phase === 'main' && gatePassed === null && plan.some(t => t.phase === 'gate')) {
      gatePassed = plan.filter(t => t.phase === 'gate').every(t => {
        const rec = JSON.parse(readFileSync(store.path(taskFile(t)), 'utf8')) as TaskRecord;
        return rec.status === 'pass';
      });
      if (!gatePassed) { stopReason = 'gate_failed'; break; }
    }
    const local = { intercepts: 0 };
    const taskStarted = iso();
    let record: TaskRecord;
    try {
      const judgement = await runScenario({
        scenarioId: task.scenarioId,
        provider: capProvider(factory({ thinking: task.thinking, scenarioId: task.scenarioId, rep: task.rep }), budget, local),
        batchId: task.taskId,
        thinking: task.thinking,
        mode: options.mode === 'live' && config ? 'live' : 'fixture',
        timeoutMs,
        now: options.now,
      });
      const game = judgement.record;
      store.freshDir(`games/${task.taskId}`);
      saveGameRecord(store.path('games'), game);
      const counters = countGame(game, task.scenarioId, local.intercepts);
      const infra = firstInterrupt(game);
      const status: TaskRecord['status'] = infra || local.intercepts > 0 ? 'interrupted' : judgement.scenarioPass ? 'pass' : 'behavior_fail';
      record = {
        schema: TASK_SCHEMA, batchId, index: task.index, taskId: task.taskId, phase: task.phase,
        scenarioId: task.scenarioId, thinking: task.thinking, rep: task.rep, status, notRunReason: null,
        interruptKind: infra?.kind ?? (local.intercepts > 0 ? 'budget' : null),
        interruptError: infra?.error ?? (local.intercepts > 0 ? 'provider call cap' : null),
        scenarioPass: judgement.scenarioPass, goalReached: game.goalReached, outcome: game.outcome, replayMatches: game.replayMatches,
        counters,
        trace: {
          gameDir: `games/${task.taskId}`,
          requests: game.steps.filter(s => s.transport).length,
          outputs: game.steps.length,
          commands: game.commands.length,
          events: game.events.length,
          terminal: game.outcome,
        },
        startedAt: taskStarted, endedAt: iso(),
      };
    } catch (err) {
      record = {
        ...notRunTask(batchId, task, null), status: 'interrupted', interruptKind: 'harness_error',
        interruptError: err instanceof Error ? err.message : String(err), startedAt: taskStarted, endedAt: iso(),
      };
    }
    store.writeJson(taskFile(task), record);
    if (record.status === 'interrupted') {
      stopReason = record.interruptKind === 'budget' ? 'budget' : record.interruptKind === 'harness_error' ? 'harness_error' : 'infrastructure_interrupt';
      cursor += 1;
      break;
    }
  }
  if (gatePassed === null && plan.some(t => t.phase === 'gate') && stopReason === 'completed') gatePassed = true;
  const reason: TaskRecord['notRunReason'] = stopReason === 'gate_failed' ? 'gate_failed' : 'interrupted_earlier';
  for (; cursor < plan.length; cursor++) store.writeJson(taskFile(plan[cursor]), notRunTask(batchId, plan[cursor], reason));

  // Summary is rebuilt from disk, never from in-memory state.
  const rebuilt = summarizeBatchDir(store.dir, batchId, plan.length);
  const byScenario = baseSummary(batchId, {}).byScenario;
  const goalByThinking = { true: 0, false: 0 };
  for (const row of rebuilt.combinations) {
    const s = byScenario[row.scenarioId];
    s.games += row.valid;
    s.scenarioPass += row.pass;
    s.goalReached += row.goalReached;
    goalByThinking[row.thinking ? 'true' : 'false'] += row.goalReached;
  }
  for (const s of Object.values(byScenario)) s.passRate = s.games === 0 ? 0 : s.scenarioPass / s.games;
  const validGames = rebuilt.byStatus.pass + rebuilt.byStatus.behavior_fail;
  const byThinking = {
    true: groupFrom(rebuilt.byThinking.true, goalByThinking.true),
    false: groupFrom(rebuilt.byThinking.false, goalByThinking.false),
  };
  // Counters include interrupted games (so they reconcile with global); games/pass count completed games only.
  for (const key of ['true', 'false'] as const) {
    const rows = rebuilt.combinations.filter(r => String(r.thinking) === key);
    byThinking[key].games = rows.reduce((n, r) => n + r.valid, 0);
    byThinking[key].scenarioPass = rows.reduce((n, r) => n + r.pass, 0);
    byThinking[key].passRate = byThinking[key].games === 0 ? 0 : byThinking[key].scenarioPass / byThinking[key].games;
  }
  const summary: G02Summary = baseSummary(batchId, {
    realModel,
    gamesRun: validGames,
    requestCount: rebuilt.global.forwardedCalls,
    httpRequests: rebuilt.global.httpRequests,
    decisionCalls: rebuilt.global.decisionCalls,
    budgetIntercepts: rebuilt.global.budgetIntercepts,
    callCapExceeded: budget.exceeded,
    gate: { size: plan.filter(t => t.phase === 'gate').length, passed: gatePassed },
    stopReason,
    health,
    byScenario,
    byThinking,
    errors: rebuilt.global.errors,
    rebuilt,
    notes: [
      'Production default enable_thinking remains true. This batch compares true and false and does not switch the default.',
      `Decision timeout defaults to ${LIVE_DECISION_TIMEOUT_MS}ms so a thinking completion near 15s is not a false timeout. Override with FROSTECHO_LIVE_TIMEOUT_MS. No implicit retries.`,
      options.mode === 'fixture'
        ? 'mode=fixture uses the reference policy in process. It is not a real-model result.'
        : 'mode=live sends one HTTP chat completion at a time. Failures are not retried. The harness never restarts the model service.',
      'Order is paired: rep → scenario → thinking on/off. Rep 1 (one game per combination) is the gate; reps 2..3 run only if the gate passes.',
      'scenarioPass is separate from goalReached. S2 and S3 pass when A stops with hunger still 40. stop is never goalReached.',
      'S3 stale-observe NO_FOOD is counted in errors.s3ExpectedNoFood, not in errors.execute.',
      'requestCount = calls forwarded past the local budget; httpRequests = chat completions actually sent; budgetIntercepts = local refusals.',
      'Token totals cover only requests whose response had usage; usageUnknownRequests counts the rest (never assumed 0).',
      `Evidence is tied to commit ${version.commit ?? 'unknown'} (dirty=${version.dirty}) and source ${version.sourceFingerprint.slice(0, 12)}; older artifacts do not prove this source.`,
      `thinking env default at process start: ${enableThinkingFromEnv(env)}`,
    ],
  });
  store.writeJson('summary.json', summary);
  store.writeJson('end.json', { batchId, startedAt, endedAt: iso(), stopReason, success: rebuilt.success });
  const exitCode: 0 | 1 | 2 = stopReason === 'health_failed' ? 2 : rebuilt.success && stopReason === 'completed' ? 0 : 1;
  return { summary, exitCode, batchDir: store.dir };
}

export interface G02Verification {
  ok: boolean;
  issues: string[];
  provesCurrentSource: boolean;
}

/** Re-derive the summary from disk and compare with summary.json; flag artifacts from a different source. */
export function verifyG02Batch(batchDir: string, repoRoot: string = process.cwd()): G02Verification {
  const batch = JSON.parse(readFileSync(join(batchDir, 'batch.json'), 'utf8')) as { batchId: string; plan: unknown[]; version: VersionInfo };
  const stored = JSON.parse(readFileSync(join(batchDir, 'summary.json'), 'utf8')) as G02Summary;
  const rebuilt = summarizeBatchDir(batchDir, batch.batchId, batch.plan.length);
  const issues = [...rebuilt.issues];
  if (JSON.stringify(stored.rebuilt) !== JSON.stringify(rebuilt)) issues.push('summary.json does not match a rebuild from disk');
  if (stored.requestCount !== rebuilt.global.forwardedCalls || stored.httpRequests !== rebuilt.global.httpRequests) issues.push('summary.json request counts tampered');
  if (stored.gamesRun !== rebuilt.byStatus.pass + rebuilt.byStatus.behavior_fail) issues.push('summary.json gamesRun tampered');
  const provesCurrentSource = batch.version.sourceFingerprint === sourceFingerprint(repoRoot) && batch.version.dirty === false;
  return { ok: issues.length === 0, issues, provesCurrentSource };
}
