/**
 * G05 workstream C — batch drivers for the 12-trajectory matrix.
 *
 * fixture: reference provider, zero HTTP, every trajectory.
 * live: the HTTP provider behind the shared G03/G04 live env contract; chains
 * run ac first then ca (the bounded comparison), one health probe each.
 */
import { LIVE_DECISION_TIMEOUT_MS, type Provider } from '../agent/contracts';
import { liveTimeoutMs } from '../agent/live-record';
import { createReferenceProvider } from '../agent/providers/reference';
import { createHttpProvider, loadHttpConfigFromEnv } from '../agent/providers/http';
import { checkLlmHealth, type HealthResult } from '../eval/health';
import { G05_SCENARIOS, runScenario, type ScenarioRun } from './scenarios';
import { saveNeedsBatch, saveNeedsEpisode, type NeedsBatchFile, type NeedsSummaryFile } from './record';
import type { ReactiveRecord } from '../reactive/contracts';

export interface RunBatchOptions {
  artifactsRoot: string;
  batchId: string;
  timeoutMs?: number;
  /** Live only: chain filter, defaults to both in the official order. */
  chains?: ('ac' | 'ca')[];
  /** Live only: stop after this many total provider calls (bounded rework guard). */
  maxTotalCalls?: number;
}

export interface BatchResult {
  runs: ScenarioRun[];
  summary: NeedsSummaryFile;
  totalCalls: number;
  scenarioPass: number;
  aborted?: string;
  health?: HealthResult;
}

function summarize(batchId: string, mode: 'fixture' | 'live', runs: ScenarioRun[]): NeedsSummaryFile {
  const perEpisode = runs.map(run => {
    const needs = run.record.needs ?? [];
    return {
      id: run.scenario.id,
      totalCalls: Object.values(run.record.actors).reduce((s, a) => s + a.providerCalls, 0),
      httpCalls: mode === 'live' ? Object.values(run.record.actors).reduce((s, a) => s + a.providerCalls, 0) : 0,
      interrupted: run.record.stopReason === 'interrupted',
      scenarioPass: run.scenarioPass,
      simTime: run.record.finalState.simTime ?? 0,
      needs: {
        granted: needs.length,
        satisfied: needs.filter(n => n.outcome === 'satisfied').length,
        expired: needs.filter(n => n.outcome === 'expired').length,
        stopped: needs.filter(n => n.outcome === 'stopped').length,
        pending: needs.filter(n => n.outcome === 'pending').length,
      },
    };
  });
  const httpCalls = mode === 'live' ? perEpisode.reduce((s, e) => s + e.httpCalls, 0) : 0;
  const needsAll = runs.flatMap(run => run.record.needs ?? []);
  return {
    schema: 'frostecho.g05.summary/1',
    batchId,
    mode,
    totals: {
      episodes: runs.length,
      scenarioPass: perEpisode.filter(e => e.scenarioPass).length,
      httpCalls,
      referenceDecisions: mode === 'fixture' ? perEpisode.reduce((s, e) => s + e.totalCalls, 0) : 0,
      interrupted: perEpisode.filter(e => e.interrupted).length,
      needsGranted: needsAll.length,
      needsSatisfied: needsAll.filter(n => n.outcome === 'satisfied').length,
      needsExpired: needsAll.filter(n => n.outcome === 'expired').length,
      simMinutes: perEpisode.reduce((s, e) => s + e.simTime, 0),
    },
    perEpisode,
  };
}

export async function runFixtureBatch(options: RunBatchOptions): Promise<BatchResult> {
  const runs: ScenarioRun[] = [];
  for (const scenario of G05_SCENARIOS) {
    if (options.chains !== undefined && !options.chains.includes(scenario.chain)) continue;
    runs.push(await runScenario(scenario, {
      providerFor: () => createReferenceProvider(),
      mode: 'fixture',
      thinking: false,
      timeoutMs: options.timeoutMs,
    }));
  }
  const summary = summarize(options.batchId, 'fixture', runs);
  persist(options.artifactsRoot, options.batchId, 'fixture', runs, summary);
  return { runs, summary, totalCalls: summary.totals.referenceDecisions, scenarioPass: summary.totals.scenarioPass };
}

export async function runLiveBatch(options: RunBatchOptions): Promise<BatchResult> {
  const config = loadHttpConfigFromEnv();
  if (config === null) return { runs: [], summary: summarize(options.batchId, 'live', []), totalCalls: 0, scenarioPass: 0, aborted: 'live mode requires FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL' };
  const health = await checkLlmHealth(config);
  if (!health.ok) {
    return { runs: [], summary: summarize(options.batchId, 'live', []), totalCalls: 0, scenarioPass: 0, aborted: `health check failed: ${health.error ?? health.kind ?? 'unknown'}`, health };
  }
  const timeoutMs = options.timeoutMs ?? liveTimeoutMs(process.env, LIVE_DECISION_TIMEOUT_MS);
  let spent = 0;
  const runs: ScenarioRun[] = [];
  for (const scenario of G05_SCENARIOS) {
    if (options.chains !== undefined && !options.chains.includes(scenario.chain)) continue;
    if (options.maxTotalCalls !== undefined) {
      const expected = scenario.expected.totalCalls;
      if (spent + expected > options.maxTotalCalls) {
        return { runs, summary: summarize(options.batchId, 'live', runs), totalCalls: spent, scenarioPass: 0, aborted: `budget guard: spent ${spent}, next ${scenario.id} wants ${expected}, cap ${options.maxTotalCalls}`, health };
      }
    }
    const providerFor = (): Provider => createHttpProvider({ ...config, enableThinking: true });
    const run = await runScenario(scenario, {
      providerFor,
      mode: 'live',
      thinking: true,
      timeoutMs,
    });
    spent += Object.values(run.record.actors).reduce((s, a) => s + a.providerCalls, 0);
    runs.push(run);
  }
  const summary = summarize(options.batchId, 'live', runs);
  persist(options.artifactsRoot, options.batchId, 'live', runs, summary);
  return { runs, summary, totalCalls: summary.totals.httpCalls, scenarioPass: summary.totals.scenarioPass, health };
}

function persist(artifactsRoot: string, batchId: string, mode: 'fixture' | 'live', runs: ScenarioRun[], summary: NeedsSummaryFile): void {
  for (const run of runs) {
    const record: ReactiveRecord = { ...run.record, scenarioPass: run.scenarioPass };
    saveNeedsEpisode(artifactsRoot, batchId, record);
  }
  const batch: NeedsBatchFile = {
    schema: 'frostecho.g05.batch/1',
    batchId,
    createdAt: new Date().toISOString(),
    mode,
    episodes: runs.map(run => run.record.episodeId),
  };
  const batchDir = `${artifactsRoot}/${batchId}`;
  saveNeedsBatch(batchDir, batch, summary);
}
