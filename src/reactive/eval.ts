/**
 * G04 workstream C — the 12-episode comparison batch.
 *
 * 3 scenarios × 2 actor orders × 2 wake policies = 12 episodes, serial, no
 * retries. Fixture mode is the offline reference policy (zero HTTP); live mode
 * uses the HTTP provider with thinking fixed on. Every attempt is persisted,
 * including interrupted ones, and the batch stops as soon as a transport
 * interruption latches.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LIVE_DECISION_TIMEOUT_MS, type Provider } from '../agent/contracts';
import { liveTimeoutMs } from '../agent/live-record';
import { createHttpProvider, loadHttpConfigFromEnv } from '../agent/providers/http';
import { createReferenceProvider } from '../agent/providers/reference';
import { checkLlmHealth, type HealthResult } from '../eval/health';
import { collectVersion, sourceFingerprint, validateBatchName, type VersionInfo } from '../eval/store';
import {
  G04_BATCH_SCHEMA, G04_THINKING, SCENARIO_IDS, WAKE_POLICIES,
  type GameMode, type ReactiveGame, type ReactiveRecord, type WakePolicy,
} from './contracts';
import { createReactiveGame } from './game';
import {
  summarizeReactiveBatchDir, verifyReactiveEpisode, writeReactiveBatchFile, writeReactiveEpisode, writeReactiveSummary,
} from './record';
import { ORDER_CODES, actorIdsFor, initialState, loadScenario, scenarioIdFor, type OrderCode } from './scenarios';

export interface G04BatchOptions {
  artifactsRoot: string;
  batch: string;
  mode: 'fixture' | 'live';
  scenarios?: readonly string[];
  orders?: readonly string[];
  policies?: readonly string[];
}

export interface G04BatchResult {
  exitCode: 0 | 1 | 2;
  batchDir: string;
  message: string;
  health?: HealthResult;
}

type EpisodeAttempt = { episodeId: string; pass: boolean | null; interrupted: boolean; invalid: boolean; issues: string[] };

async function runEpisode(
  scenarioId: string,
  order: OrderCode,
  policy: WakePolicy,
  mode: GameMode,
  makeProvider: (actorId: string) => Provider,
  artifactsRoot: string,
  batch: string,
  timeoutMs: number,
): Promise<EpisodeAttempt> {
  const scenario = loadScenario(scenarioId as never);
  const episodeId = scenarioIdFor(scenarioId as never, order, policy);
  let restocked = false;
  const game: ReactiveGame = createReactiveGame({
    episodeId,
    initialState: initialState(),
    actorIds: actorIdsFor(order),
    providerFor: makeProvider,
    mode,
    thinking: G04_THINKING,
    wakePolicy: policy,
    timeoutMs,
    onDeciding: () => {
      // N3: the restock must land while the first empty-kitchen stop is in
      // flight, i.e. after the request started and before its text is consumed.
      if (scenario.restockDuringFirstDecision && !restocked) {
        restocked = true;
        game.worldRestock('kitchen', 2);
      }
    },
  });
  let interrupted = false;
  try {
    await scenario.drive(game);
    interrupted = game.isInterrupted();
  } finally {
    await game.close();
  }
  const record = game.snapshot();
  record.scenarioId = scenarioId;
  const judgement = scenario.judge(record);
  record.scenarioPass = judgement.pass;
  writeReactiveEpisode(artifactsRoot, batch, record);
  const verification = verifyReactiveEpisode(join(artifactsRoot, batch, 'episodes', episodeId));
  return {
    episodeId,
    pass: record.scenarioPass,
    interrupted: record.stopReason === 'interrupted' || interrupted,
    invalid: !verification.ok,
    issues: verification.issues,
  };
}

export async function runG04Batch(options: G04BatchOptions): Promise<G04BatchResult> {
  const artifactsRoot = options.artifactsRoot;
  let batchDir: string;
  try {
    batchDir = validateBatchName(artifactsRoot, options.batch);
  } catch (err) {
    return { exitCode: 2, batchDir: join(artifactsRoot, options.batch), message: err instanceof Error ? err.message : String(err) };
  }
  const now = () => Date.now();
  const timeoutMs = liveTimeoutMs(process.env, LIVE_DECISION_TIMEOUT_MS);

  const scenarios = (options.scenarios ?? SCENARIO_IDS) as readonly string[];
  const orders = (options.orders ?? ORDER_CODES) as readonly string[];
  const policies = (options.policies ?? WAKE_POLICIES) as readonly WakePolicy[];
  const planned: string[] = [];
  for (const order of orders) for (const scenarioId of scenarios) for (const policy of policies) planned.push(scenarioIdFor(scenarioId as never, order as OrderCode, policy));

  mkdirSync(batchDir, { recursive: true });
  const version: VersionInfo = collectVersion(process.cwd());
  let health: HealthResult | undefined;
  let makeProvider: (actorId: string) => Provider;
  if (options.mode === 'live') {
    const config = loadHttpConfigFromEnv();
    if (config === null) return { exitCode: 2, batchDir, message: 'live mode requires FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL' };
    health = await checkLlmHealth(config);
    if (!health.ok) return { exitCode: 2, batchDir, message: `health check failed: ${health.error ?? health.kind ?? 'unknown'}`, health };
    // Live G04 is fixed thinking=true (CONTRACTS §2/§3); the contract forbids mixing arms.
    makeProvider = () => createHttpProvider({ ...config, enableThinking: G04_THINKING });
  } else {
    makeProvider = () => createReferenceProvider();
  }

  const meta: Record<string, unknown> = {
    schema: G04_BATCH_SCHEMA,
    batchId: options.batch,
    mode: options.mode,
    scenarios,
    orders,
    policies,
    plannedEpisodes: planned,
    thinking: G04_THINKING,
    timeoutMs,
    createdAt: new Date(now()).toISOString(),
    version,
    sourceFingerprint: sourceFingerprint(process.cwd()),
    ...(health !== undefined ? { health: { ok: health.ok, status: health.status, modelsUrlPath: health.modelsUrlPath, expectedModel: health.expectedModel, models: health.models, modelMatch: health.modelMatch, latencyMs: health.latencyMs } } : {}),
  };
  writeReactiveBatchFile(batchDir, { ...meta, status: 'running' });

  const results: EpisodeAttempt[] = [];
  let interrupted = false;
  for (const order of orders) {
    for (const scenarioId of scenarios) {
      for (const policy of policies) {
        if (interrupted) {
          results.push({ episodeId: scenarioIdFor(scenarioId as never, order as OrderCode, policy), pass: null, interrupted: false, invalid: false, issues: ['not run: batch stopped after an interrupted episode'] });
          continue;
        }
        const attempt = await runEpisode(scenarioId, order as OrderCode, policy, options.mode, makeProvider, artifactsRoot, options.batch, timeoutMs);
        results.push(attempt);
        if (attempt.interrupted) interrupted = true;
      }
    }
  }

  const summary = summarizeReactiveBatchDir(batchDir);
  writeReactiveSummary(batchDir, summary);
  writeReactiveBatchFile(batchDir, {
    ...meta,
    status: interrupted ? 'interrupted' : 'finished',
    completedEpisodes: results.filter(r => r.pass !== null).length,
  });

  const notRun = results.filter(r => r.pass === null).length;
  const failed = results.filter(r => r.pass === false || r.invalid).length;
  const message = `${summary.totals.episodes - notRun}/${planned.length} episodes; pass=${summary.totals.pass}, behavior_fail=${summary.totals.behavior_fail}, configuration_fail=${summary.totals.configuration_fail}, interrupted=${summary.totals.interrupted}, calls=${summary.totals.providerCalls}`;
  if (interrupted || notRun > 0) return { exitCode: 1, batchDir, message, health };
  if (failed > 0) return { exitCode: 1, batchDir, message, health };
  return { exitCode: 0, batchDir, message, health };
}

/**
 * Read-only settlement of an existing batch.
 * A missing/empty batch directory must never settle as "ok": an evidence
 * verifier that passes on nothing is indistinguishable from a broken one.
 */
export function verifyG04Batch(batchDir: string): { exitCode: 0 | 1; summary: ReturnType<typeof summarizeReactiveBatchDir> } {
  const summary = summarizeReactiveBatchDir(batchDir);
  const issues: string[] = [];
  if (summary.rows.length === 0) issues.push(`no episodes found under ${join(batchDir, 'episodes')}`);
  const batchFile = join(batchDir, 'batch.json');
  if (!existsSync(batchFile)) {
    issues.push('batch.json is missing');
  } else {
    try {
      const batch = JSON.parse(readFileSync(batchFile, 'utf8')) as { plannedEpisodes?: unknown };
      const planned = Array.isArray(batch.plannedEpisodes) ? batch.plannedEpisodes.filter((id): id is string => typeof id === 'string') : [];
      const present = new Set(summary.rows.map(row => row.episodeId));
      const missing = planned.filter(id => !present.has(id));
      if (planned.length === 0) issues.push('batch.json has no plannedEpisodes');
      for (const id of missing) issues.push(`${id}: planned but not persisted`);
    } catch (err) {
      issues.push(`batch.json is unreadable: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const bad = summary.rows.filter(row => row.verdict !== 'pass').length;
  return { exitCode: bad === 0 && issues.length === 0 ? 0 : 1, summary: { ...summary, issues: [...summary.issues, ...issues] } };
}
