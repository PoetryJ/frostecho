/**
 * G05-R1 workstream C — batch drivers for the restored matrix.
 *
 * Batches own an exclusive directory; the summary is a pure function of the
 * runs being persisted. Live runs gate on a health precheck, run the ac chain
 * first and stop on the first behavioural or transport failure, keeping every
 * remaining trajectory as not_run. HTTP counts come from actual transport
 * records; missing usage stays unknown.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE_DECISION_TIMEOUT_MS, type Provider } from '../agent/contracts';
import { liveTimeoutMs } from '../agent/live-record';
import { createReferenceProvider } from '../agent/providers/reference';
import { createHttpProvider, loadHttpConfigFromEnv } from '../agent/providers/http';
import { checkLlmHealth, type HealthResult } from '../eval/health';
import { canonical } from '../util';
import { G05_BATCH_SCHEMA } from '../reactive/contracts';
import { G05_SCENARIOS, runScenario, type G05Chain, type G05ScenarioRun } from './scenarios';
import { saveNeedsEpisode } from './record';
import { writeReactiveBatchFile, writeReactiveSummary } from '../reactive/record';

export interface RunBatchOptions {
  artifactsRoot: string;
  batchId: string;
  timeoutMs?: number;
  /** Chain filter; the official run is ac first, then ca. */
  chains?: G05Chain[];
  /** Live only: stop before spending past this total (bounded rework guard). */
  maxTotalCalls?: number;
}

export interface BatchResult {
  runs: G05ScenarioRun[];
  summary: NeedsSummary;
  totalCalls: number;
  scenarioPass: number;
  aborted?: string;
  health?: HealthResult;
}

export interface NeedsSummary {
  schema: 'frostecho.g05.summary/2';
  batchId: string;
  matrixVersion: string;
  mode: string;
  totals: {
    episodes: number;
    scenarioPass: number;
    behaviourFailed: number;
    notRun: number;
    httpCalls: number;
    referenceDecisions: number;
  };
  sourceFingerprint: string;
  promptFingerprint: string | 'unknown';
  perEpisode: {
    id: string;
    episodeId: string;
    scenarioPass: boolean;
    calls: number;
    transports: number;
    usage: unknown;
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

function transportsOf(run: G05ScenarioRun): number {
  return Object.values(run.record.cycles).flatMap(list => list.flatMap(c => c.turns))
    .filter(t => t.step?.transport !== undefined && t.step?.transport !== null).length;
}

function usageOf(run: G05ScenarioRun): unknown {
  for (const list of Object.values(run.record.cycles)) {
    for (const cycle of list) {
      for (const turn of cycle.turns) {
        const usage = (turn.step?.transport as { usage?: unknown } | undefined)?.usage;
        if (usage !== undefined && usage !== null) return usage;
      }
    }
  }
  return 'unknown';
}

function promptFingerprintOf(runs: G05ScenarioRun[]): string | 'unknown' {
  for (const run of runs) {
    for (const list of Object.values(run.record.cycles)) {
      for (const cycle of list) {
        for (const turn of cycle.turns) {
          const body = turn.step?.transport?.requestBody as { messages?: unknown } | undefined;
          if (body?.messages !== undefined) {
            return createHash('sha256').update(canonical(body.messages)).digest('hex');
          }
        }
      }
    }
  }
  return 'unknown';
}

function summarize(batchId: string, mode: string, runs: G05ScenarioRun[], notRun: string[]): NeedsSummary {
  const perEpisode = runs.map(run => ({
    id: run.scenario.id,
    episodeId: run.record.episodeId,
    scenarioPass: run.scenarioPass,
    calls: Object.values(run.record.actors).reduce((s, a) => s + a.providerCalls, 0),
    transports: transportsOf(run),
    usage: usageOf(run),
    simTime: run.record.finalState.simTime ?? 0,
    stopReason: run.record.stopReason,
  }));
  return {
    schema: 'frostecho.g05.summary/2',
    batchId,
    matrixVersion: 'g05-r1-t123',
    mode,
    totals: {
      episodes: runs.length,
      scenarioPass: runs.filter(r => r.scenarioPass).length,
      behaviourFailed: runs.filter(r => !r.scenarioPass).length,
      notRun: notRun.length,
      httpCalls: perEpisode.reduce((s, e) => s + e.transports, 0),
      referenceDecisions: perEpisode.reduce((s, e) => s + e.calls, 0),
    },
    sourceFingerprint: sourceFingerprint(),
    promptFingerprint: promptFingerprintOf(runs),
    perEpisode,
  };
}

function persist(options: RunBatchOptions, mode: string, runs: G05ScenarioRun[], summary: NeedsSummary, notRun: string[]): void {
  for (const run of runs) saveNeedsEpisode(options.artifactsRoot, options.batchId, run.record);
  writeReactiveBatchFile(join(options.artifactsRoot, options.batchId), {
    schema: G05_BATCH_SCHEMA,
    batchId: options.batchId,
    matrixVersion: 'g05-r1-t123',
    mode,
    episodes: runs.map(r => r.record.episodeId),
    notRun,
    createdAt: new Date().toISOString(),
  });
  writeReactiveSummary(join(options.artifactsRoot, options.batchId), summary as never);
}

export async function runFixtureBatch(options: RunBatchOptions): Promise<BatchResult> {
  const runs: G05ScenarioRun[] = [];
  for (const scenario of G05_SCENARIOS) {
    if (options.chains !== undefined && !options.chains.includes(scenario.chain)) continue;
    runs.push(await runScenario(scenario, {
      providerFor: () => createReferenceProvider(),
      mode: 'reference',
      thinking: true,
      timeoutMs: options.timeoutMs,
    }));
  }
  const summary = summarize(options.batchId, 'fixture', runs, []);
  persist(options, 'fixture', runs, summary, []);
  return { runs, summary, totalCalls: summary.totals.referenceDecisions, scenarioPass: summary.totals.scenarioPass };
}

export async function runLiveBatch(options: RunBatchOptions): Promise<BatchResult> {
  const config = loadHttpConfigFromEnv();
  if (config === null) {
    return { runs: [], summary: summarize(options.batchId, 'live', [], []), totalCalls: 0, scenarioPass: 0, aborted: 'live mode requires FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL' };
  }
  const health = await checkLlmHealth(config);
  if (!health.ok) {
    return { runs: [], summary: summarize(options.batchId, 'live', [], []), totalCalls: 0, scenarioPass: 0, aborted: `health check failed: ${health.error ?? health.kind ?? 'unknown'}`, health };
  }
  const timeoutMs = options.timeoutMs ?? liveTimeoutMs(process.env, LIVE_DECISION_TIMEOUT_MS);
  const cap = options.maxTotalCalls ?? 60;
  const runs: G05ScenarioRun[] = [];
  const notRun: string[] = [];
  let spent = 0;
  let gateFailed: string | null = null;
  for (const scenario of G05_SCENARIOS) {
    if (options.chains !== undefined && !options.chains.includes(scenario.chain)) continue;
    if (gateFailed !== null) { notRun.push(scenario.id); continue; }
    // Chain gate: the ca chain only starts after every ac trajectory passed.
    if (scenario.chain === 'ca' && runs.some(r => r.scenario.chain === 'ac' && !r.scenarioPass)) {
      gateFailed = 'ac gate failed';
      notRun.push(scenario.id);
      continue;
    }
    if (spent >= cap) { gateFailed = `chat budget ${cap} exhausted`; notRun.push(scenario.id); continue; }
    const run = await runScenario(scenario, {
      providerFor: (): Provider => createHttpProvider({ ...config, enableThinking: true }),
      mode: 'live',
      thinking: true,
      timeoutMs,
      requestModel: config.model,
    });
    runs.push(run);
    spent += Object.values(run.record.actors).reduce((s, a) => s + a.providerCalls, 0);
    if (run.record.stopReason === 'interrupted') gateFailed = `transport failure in ${scenario.id}`;
    else if (!run.scenarioPass) gateFailed = `behaviour failure in ${scenario.id}`;
  }
  const summary = summarize(options.batchId, 'live', runs, notRun);
  persist(options, 'live', runs, summary, notRun);
  return {
    runs, summary, totalCalls: summary.totals.httpCalls, scenarioPass: summary.totals.scenarioPass,
    ...(gateFailed !== null ? { aborted: gateFailed } : {}), health,
  };
}
