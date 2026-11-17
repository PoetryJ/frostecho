/**
 * G05-live integration (main agent). A/B/C modules wired together:
 *   ChatBudgetGate (A) → NeedsBatchStore (B) → live judges + disk-rebuilt
 *   summaries (C). One batch = one exclusive directory created before anything
 *   runs; every request is reserve → durable begin → HTTP → durable finish;
 *   every finished episode is saved immediately; the summary and the cost
 *   totals are rebuilt from the files on disk, never from memory.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE_DECISION_TIMEOUT_MS, type Provider } from '../agent/contracts';
import { liveTimeoutMs } from '../agent/live-record';
import { createReferenceProvider } from '../agent/providers/reference';
import { createHttpProvider, loadHttpConfigFromEnv, HTTP_SAMPLING } from '../agent/providers/http';
import { checkLlmHealth, type HealthResult } from '../eval/health';
import { canonical } from '../util';
import { G05_SCENARIOS, runScenario, type G05Chain, type G05Scenario, type G05ScenarioRun } from './scenarios';
import { NeedsBatchStore, readAttemptLedger, BatchStoreError } from './batch-store';
import { ChatBudgetGate, createBudgetedProvider } from './live-budget';
import { costTotalsOf, httpCallsOfRecords, decisionAttemptsOfRecords, type CostTotals } from './metrics';
import type { AttemptRequestConfig } from './live-contracts';

export interface RunBatchOptions {
  artifactsRoot: string;
  batchId: string;
  timeoutMs?: number;
  /** Chain filter; the official run is ac first, then ca (never ca-only live). */
  chains?: G05Chain[];
  /** Live only: total chat-request hard limit, enforced per request. */
  maxTotalCalls?: number;
}

export interface BatchResult {
  runs: G05ScenarioRun[];
  summary: NeedsSummary;
  totalCalls: number;
  scenarioPass: number;
  aborted?: string;
  health?: HealthResult;
  budget?: { limit: number; spent: number; blocked: number };
}

export interface NeedsSummary {
  schema: 'frostecho.g05.summary/3';
  batchId: string;
  matrixVersion: string;
  mode: string;
  chatBudget: { limit: number; spent: number; blocked: number };
  totals: {
    episodes: number;
    scenarioPass: number;
    behaviourFailed: number;
    notRun: number;
    httpCalls: number;
    referenceDecisions: number;
    decisionAttempts: number;
    httpAttempts: number;
    unresolvedAttempts: number;
    budgetBlocked: number;
    knownTokenSum: number;
    usageUnknownCount: number;
    totalTokens: number | null;
    preflightRequests: number;
  };
  costs: { latencyMsSum: number; byOutcome: CostTotals['byOutcome'] };
  sourceFingerprint: string;
  promptFingerprint: string | 'unknown';
  perEpisode: {
    id: string;
    episodeId: string;
    scenarioPass: boolean;
    calls: number;
    transports: number;
    simTime: number;
    stopReason: string;
  }[];
}

function sourceFingerprint(): string {
  const hash = createHash('sha256');
  for (const rel of ['dist/src/rules.js', 'dist/src/reactive/game.js', 'dist/src/needs/scenarios.js', 'dist/src/agent/runner.js']) {
    try {
      hash.update(rel);
      hash.update(readFileSync(join(process.cwd(), rel)));
    } catch {
      hash.update(`${rel}:missing`);
    }
  }
  return hash.digest('hex');
}

interface EpisodeFile {
  episodeId: string;
  scenarioId: string | null;
  stopReason: string;
  scenarioPass: boolean | null;
  actors: Record<string, { providerCalls: number }>;
  cycles: Record<string, { turns: { providerCalled?: boolean; step?: { transport?: unknown } }[] }[]>;
  finalState: { simTime?: number };
}

function readEpisodes(batchDir: string): EpisodeFile[] {
  const dir = join(batchDir, 'episodes');
  if (!existsSync(dir)) return [];
  const out: EpisodeFile[] = [];
  for (const name of readdirSync(dir).sort()) {
    const file = join(dir, name, 'game.json');
    if (!existsSync(file)) continue;
    out.push(JSON.parse(readFileSync(file, 'utf8')) as EpisodeFile);
  }
  return out;
}

function promptFingerprintOfEpisodes(episodes: EpisodeFile[]): string | 'unknown' {
  for (const record of episodes) {
    for (const list of Object.values(record.cycles ?? {})) {
      for (const cycle of list ?? []) {
        for (const turn of cycle.turns ?? []) {
          const body = (turn.step?.transport as { requestBody?: { messages?: unknown } } | undefined)?.requestBody;
          if (body?.messages !== undefined) {
            return createHash('sha256').update(canonical(body.messages)).digest('hex');
          }
        }
      }
    }
  }
  return 'unknown';
}

/**
 * Rebuild the whole summary from the durable files: episodes saved so far, the
 * attempt ledger and the plan. Nothing here trusts an in-memory run result.
 */
export function rebuildSummary(
  batchDir: string,
  batchId: string,
  mode: string,
  budget: { limit: number; spent: number; blocked: number },
  notRun: string[],
  preflightRequests: number,
): NeedsSummary {
  const episodes = readEpisodes(batchDir);
  const ledger = readAttemptLedger(batchDir);
  const costs = costTotalsOf(batchDir, ledger);
  const httpCalls = httpCallsOfRecords(batchDir);
  const perEpisode = episodes.map(record => ({
    id: record.scenarioId ?? record.episodeId,
    episodeId: record.episodeId,
    scenarioPass: record.scenarioPass === true,
    calls: Object.values(record.actors ?? {}).reduce((s, a) => s + (a?.providerCalls ?? 0), 0),
    transports: Object.values(record.cycles ?? {}).flatMap(list => (list ?? []).flatMap(c => c.turns ?? []))
      .filter(t => t.step?.transport !== undefined && t.step?.transport !== null).length,
    simTime: record.finalState?.simTime ?? 0,
    stopReason: record.stopReason,
  }));
  return {
    schema: 'frostecho.g05.summary/3',
    batchId,
    matrixVersion: 'g05-r1-t123',
    mode,
    chatBudget: budget,
    totals: {
      episodes: episodes.length,
      scenarioPass: perEpisode.filter(e => e.scenarioPass).length,
      behaviourFailed: perEpisode.filter(e => !e.scenarioPass).length,
      notRun: notRun.length,
      httpCalls,
      referenceDecisions: 0,
      decisionAttempts: decisionAttemptsOfRecords(batchDir),
      httpAttempts: costs.httpAttempts,
      unresolvedAttempts: costs.unresolvedAttempts,
      budgetBlocked: costs.budgetBlocked,
      knownTokenSum: costs.knownTokenSum,
      usageUnknownCount: costs.usageUnknownCount,
      totalTokens: costs.totalTokens,
      preflightRequests,
    },
    costs: { latencyMsSum: costs.latencyMsSum, byOutcome: costs.byOutcome },
    sourceFingerprint: sourceFingerprint(),
    promptFingerprint: promptFingerprintOfEpisodes(episodes),
    perEpisode,
  };
}

function scenariosOf(options: RunBatchOptions): G05Scenario[] {
  return G05_SCENARIOS.filter(s => options.chains === undefined || options.chains.includes(s.chain));
}

function attemptRequestConfig(model: string | null, timeoutMs: number, enableThinking: boolean): AttemptRequestConfig {
  return {
    model,
    temperature: HTTP_SAMPLING.temperature,
    max_tokens: HTTP_SAMPLING.max_tokens,
    stream: HTTP_SAMPLING.stream,
    enableThinking: [enableThinking],
    timeoutMs,
  };
}

export async function runFixtureBatch(options: RunBatchOptions): Promise<BatchResult> {
  const scenarios = scenariosOf(options);
  const store = NeedsBatchStore.open(options.artifactsRoot, options.batchId, {
    mode: 'fixture',
    matrixVersion: 'g05-r1-t123',
    chatBudget: { limit: 0 },
    requestDefaults: {
      model: null,
      temperature: HTTP_SAMPLING.temperature,
      max_tokens: HTTP_SAMPLING.max_tokens,
      stream: HTTP_SAMPLING.stream,
      enableThinking: true,
      timeoutMs: options.timeoutMs ?? LIVE_DECISION_TIMEOUT_MS,
      urlPresent: false,
    },
    scenarios,
  });
  const runs: G05ScenarioRun[] = [];
  const notRun: string[] = [];
  let failed: string | null = null;
  for (const scenario of scenarios) {
    if (failed !== null) { notRun.push(scenario.id); continue; }
    store.markScenarioStatus(scenario.id, 'running');
    const run = await runScenario(scenario, {
      providerFor: () => createReferenceProvider(),
      mode: 'reference',
      thinking: true,
      timeoutMs: options.timeoutMs,
    });
    runs.push(run);
    store.saveEpisode(run.record);
    store.markScenarioStatus(scenario.id, run.scenarioPass ? 'passed' : 'behaviour_failed', run.issues.join('; ') || undefined);
    if (!run.scenarioPass) failed = `behaviour failure in ${scenario.id}`;
  }
  const referenceDecisions = runs.reduce((s, r) => s + Object.values(r.record.actors).reduce((t, a) => t + a.providerCalls, 0), 0);
  const summary = rebuildSummary(store.dir, options.batchId, 'fixture', { limit: 0, spent: 0, blocked: 0 }, notRun, 0);
  summary.totals.referenceDecisions = referenceDecisions;
  store.finalizeBatchFile(runs.map(r => r.record.episodeId), notRun);
  store.writeSummary(summary);
  store.writeDone({ batchId: options.batchId, stoppedReason: failed, at: new Date().toISOString() });
  return {
    runs, summary, totalCalls: referenceDecisions, scenarioPass: summary.totals.scenarioPass,
    ...(failed !== null ? { aborted: failed } : {}),
  };
}

export async function runLiveBatch(options: RunBatchOptions): Promise<BatchResult> {
  const config = loadHttpConfigFromEnv();
  if (config === null) {
    throw new Error('live mode requires FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL');
  }
  const limit = options.maxTotalCalls ?? 60;
  const timeoutMs = options.timeoutMs ?? liveTimeoutMs(process.env, LIVE_DECISION_TIMEOUT_MS);
  const scenarios = scenariosOf(options);
  const store = NeedsBatchStore.open(options.artifactsRoot, options.batchId, {
    mode: 'live',
    matrixVersion: 'g05-r1-t123',
    chatBudget: { limit },
    requestDefaults: {
      model: config.model,
      temperature: HTTP_SAMPLING.temperature,
      max_tokens: HTTP_SAMPLING.max_tokens,
      stream: HTTP_SAMPLING.stream,
      enableThinking: true,
      timeoutMs,
      urlPresent: true,
    },
    scenarios,
  });
  const gate = new ChatBudgetGate(limit);
  const requestConfig = attemptRequestConfig(config.model, timeoutMs, true);
  const abortWithPreflight = async (reason: string, health: HealthResult): Promise<BatchResult> => {
    store.savePreflight({
      ok: health.ok, kind: health.kind ?? null, error: health.error, status: health.status,
      models: health.models, expectedModel: health.expectedModel, checkedAt: health.checkedAt, latencyMs: health.latencyMs,
    });
    for (const scenario of scenarios) store.markScenarioStatus(scenario.id, 'preflight_failed', reason);
    const summary = rebuildSummary(store.dir, options.batchId, 'live', { limit, spent: gate.spent, blocked: gate.blocked }, scenarios.map(s => s.id), 1);
    store.finalizeBatchFile([], scenarios.map(s => s.id));
    store.writeSummary(summary);
    store.writeDone({ batchId: options.batchId, stoppedReason: reason, at: new Date().toISOString() });
    return { runs: [], summary, totalCalls: 0, scenarioPass: 0, aborted: reason, health };
  };

  const health = await checkLlmHealth(config);
  if (!health.ok) {
    return abortWithPreflight(`health check failed: ${health.error ?? health.kind ?? 'unknown'}`, health);
  }
  store.savePreflight({
    ok: health.ok, kind: health.kind ?? null, error: health.error, status: health.status,
    models: health.models, expectedModel: health.expectedModel, checkedAt: health.checkedAt, latencyMs: health.latencyMs,
  });

  const runs: G05ScenarioRun[] = [];
  const notRun: string[] = [];
  let stopped: string | null = null;
  for (const scenario of scenarios) {
    if (stopped !== null) {
      notRun.push(scenario.id);
      store.markScenarioStatus(scenario.id, 'not_run', stopped);
      continue;
    }
    if (scenario.chain === 'ca' && runs.some(r => r.scenario.chain === 'ac' && !r.scenarioPass)) {
      stopped = 'ac gate failed';
      notRun.push(scenario.id);
      store.markScenarioStatus(scenario.id, 'not_run', stopped);
      continue;
    }
    store.markScenarioStatus(scenario.id, 'running');
    // One budgeted provider per cycle: the factory ordinal is the cycle number.
    const cycleCount: Record<string, number> = {};
    const run = await runScenario(scenario, {
      providerFor: (actorId): Provider => {
        cycleCount[actorId] = (cycleCount[actorId] ?? 0) + 1;
        return createBudgetedProvider({
          gate,
          hooks: store,
          requestConfig,
          episodeId: `g05-${scenario.id.replace(/\//g, '-')}`,
          actorId,
          cycle: cycleCount[actorId],
          inner: createHttpProvider({ ...config, enableThinking: true }),
        });
      },
      mode: 'live',
      thinking: true,
      timeoutMs,
      requestModel: config.model,
    });
    runs.push(run);
    store.saveEpisode(run.record); // immediately, pass or fail
    if (run.record.stopReason === 'interrupted') {
      stopped = gate.blocked > 0 ? `chat budget ${limit} exhausted in ${scenario.id}` : `transport failure in ${scenario.id}`;
      store.markScenarioStatus(scenario.id, gate.blocked > 0 ? 'budget_blocked' : 'interrupted', stopped);
    } else if (!run.scenarioPass) {
      stopped = `behaviour failure in ${scenario.id}: ${run.issues.slice(0, 3).join('; ')}`;
      store.markScenarioStatus(scenario.id, 'behaviour_failed', run.issues.join('; ') || undefined);
    } else {
      store.markScenarioStatus(scenario.id, 'passed');
    }
  }
  const summary = rebuildSummary(store.dir, options.batchId, 'live', { limit, spent: gate.spent, blocked: gate.blocked }, notRun, 1);
  store.finalizeBatchFile(runs.map(r => r.record.episodeId), notRun);
  store.writeSummary(summary);
  store.writeDone({ batchId: options.batchId, stoppedReason: stopped, at: new Date().toISOString() });
  return {
    runs, summary, totalCalls: summary.totals.httpCalls, scenarioPass: summary.totals.scenarioPass,
    budget: { limit, spent: gate.spent, blocked: gate.blocked },
    ...(stopped !== null ? { aborted: stopped } : {}),
    health,
  };
}

export { BatchStoreError };
