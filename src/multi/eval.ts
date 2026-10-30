/**
 * G03 workstream C — batch runner and gate. 12 episodes:
 * M1/M2/M3 × order [a,c]/[c,a] × thinking on/off; on/off adjacent within each
 * scenario; all provider requests serial. Fixture mode runs all 12 offline;
 * live mode requires health check + env config, runs the [a,c] 6 first and
 * only continues to [c,a] when the gate passes (all 6 valid, no interrupts).
 * Every attempt is persisted — gate failures and infra stops included.
 */
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Provider } from '../agent/contracts';
import { createHttpProvider, loadHttpConfigFromEnv } from '../agent/providers/http';
import { createReferenceProvider } from '../agent/providers/reference';
import { checkLlmHealth, type HealthResult } from '../eval/health';
import { collectVersion, validateBatchName, type VersionInfo } from '../eval/store';
import type { MultiGame } from './contracts';
import { createMultiGame } from './game';
import type { MultiRecord } from './contracts';
import { MULTI_BATCH_SCHEMA, MULTI_SUMMARY_SCHEMA, summarizeMultiBatchDir, writeMultiBatchFile, writeMultiEpisode, writeMultiSummary } from './record';
import { MULTI_SCENARIO_IDS, judgeMultiScenario, loadMultiScenario, type MultiScenarioId } from './scenarios';

export type G03Order = 'ac' | 'ca';
export type G03Mode = 'fixture' | 'live';

export interface G03BatchOptions {
  artifactsRoot: string;
  batch: string;
  mode: G03Mode;
  /** Restrict to one order (gating). Default: both orders (fixture) / gate flow (live). */
  order?: G03Order;
  now?: () => number;
}

export interface G03BatchResult {
  exitCode: 0 | 1 | 2;
  batchDir: string | null;
  message: string;
  health?: HealthResult;
}

export function episodeIdFor(scenario: MultiScenarioId, order: G03Order, thinking: boolean): string {
  return `${scenario}-${order}-${thinking ? 'on' : 'off'}`;
}

function actorIdsFor(order: G03Order): string[] {
  return order === 'ac' ? ['npc_a', 'npc_c'] : ['npc_c', 'npc_a'];
}

interface EpisodeAttempt {
  episodeId: string;
  record: MultiRecord | null;
  note: string;
}

/** Drive one episode: run to terminal/user close/infra stop; inject the scripted player line. */
async function runEpisode(scenarioId: MultiScenarioId, order: G03Order, thinking: boolean, mode: G03Mode, batch: string, makeProvider: (actorId: string, thinking: boolean) => Provider, now: () => number): Promise<EpisodeAttempt> {
  const scenario = loadMultiScenario(scenarioId);
  const episodeId = episodeIdFor(scenarioId, order, thinking);
  const game: MultiGame = createMultiGame({
    episodeId,
    initialState: structuredClone(scenario.initialState),
    actorIds: actorIdsFor(order),
    providerFor: (actorId: string) => makeProvider(actorId, thinking),
    mode,
    thinking,
    now,
  });
  let intervened = false;
  const interventionLog: string[] = [];
  if (scenario.playerIntervention !== null) {
    const line = scenario.playerIntervention.line;
    const original = game; // keep reference for the hook closure
    void original;
    // The hook is attached via onDeciding through the game's sessions.
    for (const actorId of actorIdsFor(order)) {
      const session = game.sessions[actorId];
      const prev = session.onDeciding;
      session.onDeciding = async phase => {
        if (!intervened) {
          intervened = true;
          const result = game.playerLine(line);
          interventionLog.push(`${line} -> ${result.ok ? 'accepted' : `rejected (${String(result.error)})`}`);
        }
        if (prev !== undefined) await prev(phase);
      };
    }
  }
  const outcome = await game.run();
  const record = game.snapshot();
  record.scenarioId = scenarioId;
  const verdict = judgeMultiScenario(scenarioId, record);
  record.scenarioPass = verdict.pass;
  const note = interventionLog.length > 0
    ? `run=${outcome}; intervention: ${interventionLog.join('; ')}; verdict: ${verdict.pass ? 'pass' : verdict.reasons.join(', ')}`
    : `run=${outcome}; verdict: ${verdict.pass ? 'pass' : verdict.reasons.join(', ')}`;
  void batch;
  return { episodeId, record, note };
}

export async function runG03Batch(options: G03BatchOptions): Promise<G03BatchResult> {
  const now = options.now ?? Date.now;
  let batchDir: string | null = null;
  try {
    const root = options.artifactsRoot;
    batchDir = join(root, options.batch);
    if (existsSync(batchDir)) {
      return { exitCode: 2, batchDir, message: `batch directory already exists: ${batchDir}` };
    }
    mkdirSync(batchDir, { recursive: true });
    const episodesRoot = join(batchDir, 'episodes');
    mkdirSync(episodesRoot, { recursive: true });

    // provider factory: thinking is bound per episode, never to the process env
    let makeProvider: (actorId: string, thinking: boolean) => Provider;
    let health: HealthResult | undefined;
    const thinkingPlans: boolean[] = [false, true];
    if (options.mode === 'live') {
      const config = loadHttpConfigFromEnv();
      if (config === null) {
        return { exitCode: 2, batchDir, message: 'live mode requires FROSTECHO_LLM_URL and FROSTECHO_LLM_MODEL' };
      }
      health = await checkLlmHealth(config);
      if (!health.ok) {
        return { exitCode: 2, batchDir, message: `health check failed: ${health.error ?? health.kind ?? 'unknown'}`, health };
      }
      // One provider per actor per episode, with that episode's enable_thinking.
      makeProvider = (_actorId: string, thinking: boolean) => createHttpProvider({ ...config, enableThinking: thinking });
    } else {
      makeProvider = () => createReferenceProvider();
    }

    const orders: G03Order[] = options.order !== undefined ? [options.order] : ['ac', 'ca'];
    const plannedEpisodes: string[] = [];
    for (const order of orders) {
      for (const scenarioId of MULTI_SCENARIO_IDS) {
        for (const thinking of thinkingPlans) {
          plannedEpisodes.push(episodeIdFor(scenarioId, order, thinking));
        }
      }
    }
    // Recorded once and preserved by every later write (status flips used to drop it).
    const createdAt = new Date(now()).toISOString();
    const version: VersionInfo = collectVersion(process.cwd());
    const meta: Record<string, unknown> = {
      schema: MULTI_BATCH_SCHEMA,
      batchId: options.batch,
      mode: options.mode,
      orders,
      plannedEpisodes,
      thinkingPlan: thinkingPlans,
      createdAt,
      version,
      ...(health !== undefined ? { health: { ok: health.ok, status: health.status, modelsUrlPath: health.modelsUrlPath, expectedModel: health.expectedModel, models: health.models, modelMatch: health.modelMatch, latencyMs: health.latencyMs } } : {}),
    };
    writeMultiBatchFile(batchDir, { ...meta, status: 'running' });

    let interruptedBatch = false;
    const gateResults: boolean[] = [];
    for (const order of orders) {
      const orderEpisodes: boolean[] = [];
      for (const scenarioId of MULTI_SCENARIO_IDS) {
        for (const thinking of thinkingPlans) {
          if (interruptedBatch) {
            // infra already stopped this batch: mark the rest not_run by leaving the episode dir absent
            orderEpisodes.push(false);
            continue;
          }
          const attempt = await runEpisode(scenarioId, order, thinking, options.mode, options.batch, makeProvider, now);
          if (attempt.record === null) {
            orderEpisodes.push(false);
            continue;
          }
          writeMultiEpisode(batchDir, attempt.record);
          console.log(`[${attempt.episodeId}] ${attempt.note}`);
          if (attempt.record.stopReason === 'interrupted') {
            interruptedBatch = true;
            orderEpisodes.push(false);
            continue;
          }
          // fixture determinism: exact reference step count (live is model-driven; budget ceiling only)
          if (options.mode === 'fixture') {
            const scenario = loadMultiScenario(scenarioId);
            const steps = attempt.record.turns.length;
            if (steps !== scenario.expectedReferenceSteps) {
              console.error(`[${attempt.episodeId}] fixture step count ${steps} != expected ${scenario.expectedReferenceSteps}`);
              orderEpisodes.push(false);
              continue;
            }
          }
          orderEpisodes.push(attempt.record.scenarioPass === true);
        }
      }
      gateResults.push(...orderEpisodes);
      // live gating: [a,c] six must all pass before [c,a] starts
      if (options.mode === 'live' && orders.length === 2 && order === 'ac') {
        const gateOk = orderEpisodes.length === 6 && orderEpisodes.every(v => v);
        writeMultiBatchFile(batchDir, {
          ...meta,
          status: interruptedBatch ? 'interrupted' : gateOk ? 'gate-passed' : 'gate-failed',
          gate: { order: 'ac', pass: gateOk },
        });
        if (!gateOk) {
          const summary = summarizeMultiBatchDir(batchDir);
          writeMultiSummary(batchDir, { schema: MULTI_SUMMARY_SCHEMA, ...summary });
          return {
            exitCode: 1,
            batchDir,
            message: `gate failed for [a,c] six; [c,a] not run (records preserved)`,
            health,
          };
        }
      }
    }

    const summary = summarizeMultiBatchDir(batchDir);
    writeMultiSummary(batchDir, { schema: MULTI_SUMMARY_SCHEMA, ...summary });
    writeMultiBatchFile(batchDir, {
      ...meta,
      status: summary.totals.notRun > 0 || summary.totals.interrupted > 0 ? 'incomplete' : 'finished',
    });
    const allOk = summary.ok
      && summary.totals.notRun === 0
      && summary.totals.interrupted === 0
      && summary.totals.behaviorFailed === 0
      && summary.rows.every(r => r.pass);
    return {
      exitCode: allOk ? 0 : 1,
      batchDir,
      message: allOk
        ? `all ${summary.rows.length} episodes passed; chat requests=${summary.totals.totalChatRequests}`
        : `batch finished with failures: pass=${summary.totals.passed} behavior_fail=${summary.totals.behaviorFailed} interrupted=${summary.totals.interrupted} not_run=${summary.totals.notRun} issues=${summary.issues.length}`,
      health,
    };
  } catch (err) {
    return {
      exitCode: 1,
      batchDir,
      message: `batch threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** CLI entry reuse: verify an existing batch directory only. */
export function verifyG03Batch(batchDir: string): G03BatchResult {
  if (!existsSync(batchDir)) {
    return { exitCode: 2, batchDir, message: `batch directory not found: ${batchDir}` };
  }
  const summary = summarizeMultiBatchDir(batchDir);
  const allOk = summary.ok
    && summary.totals.notRun === 0
    && summary.totals.interrupted === 0
    && summary.rows.every(r => r.pass);
  return {
    exitCode: allOk ? 0 : 1,
    batchDir,
    message: allOk
      ? `verify ok: ${summary.rows.length} episodes, chat requests=${summary.totals.totalChatRequests}`
      : `verify failed: pass=${summary.totals.passed} behavior_fail=${summary.totals.behaviorFailed} interrupted=${summary.totals.interrupted} not_run=${summary.totals.notRun} issues=${summary.issues.length}`,
  };
}

export { validateBatchName };
