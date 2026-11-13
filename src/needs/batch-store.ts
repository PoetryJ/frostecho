/**
 * G05-live workstream B — the exclusive, incrementally persisted batch.
 *
 * Directory creation is atomic (mkdir without parents on a fresh name): a
 * second open of the same batch name fails before touching a single old byte.
 * The full 12-trajectory plan, the effective request defaults and the source
 * version are durable before anything runs; every request attempt is ledgered
 * (begin before send, finish after), every finished episode is saved the
 * moment it ends, and the summary is rebuilt from these files — never from
 * in-memory success counters. No credential or auth header is ever stored.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BatchStoreError, createBatchStore, collectVersion, type BatchStore, type VersionInfo } from '../eval/store';
import { writeReactiveBatchFile, writeReactiveEpisode } from '../reactive/record';
import { G05_BATCH_SCHEMA } from '../reactive/contracts';
import { G05_SCENARIOS, type G05Scenario } from './scenarios';
import type { LiveAttemptBegin, LiveAttemptFinish, LiveAttemptHooks, LiveBlockedRecord } from './live-contracts';

export type ScenarioRunStatus =
  | 'not_run'
  | 'preflight_failed'
  | 'running'
  | 'passed'
  | 'behaviour_failed'
  | 'interrupted'
  | 'budget_blocked';

export interface BatchPlanEntry {
  scenarioId: string;
  episodeId: string;
  chain: string;
  kind: string;
  needPolicy: string;
  kitchenFood: number;
  /** Reference decision count; live trajectories may legally spend fewer/more. */
  referenceDecisions: number;
  zeroCall: boolean;
}

export interface BatchPlanFile {
  schema: 'frostecho.g05.liveplan/1';
  batchId: string;
  mode: 'fixture' | 'live';
  matrixVersion: string;
  chatBudget: { limit: number };
  requestDefaults: {
    model: string | null;
    temperature: number;
    max_tokens: number;
    stream: boolean;
    enableThinking: boolean;
    timeoutMs: number;
    urlPresent: boolean;
  };
  plannedScenarios: BatchPlanEntry[];
  version: VersionInfo;
  createdAt: string;
}

export interface PreflightFile {
  ok: boolean;
  kind: string | null;
  error: string | null;
  status: number | null;
  models: string[];
  expectedModel: string;
  checkedAt: string;
  latencyMs: number;
  /** Preflight GET /models is separate from the 60-chat budget. */
  preflightRequests: number;
}

const scenarioFileKey = (scenarioId: string): string => scenarioId.replace(/\//g, '__');

function planEntry(scenario: G05Scenario): BatchPlanEntry {
  const modelBased = scenario.needPolicy === 'recurring' && scenario.kind !== 't2';
  return {
    scenarioId: scenario.id,
    episodeId: `g05-${scenario.id.replace(/\//g, '-')}`,
    chain: scenario.chain,
    kind: scenario.kind,
    needPolicy: scenario.needPolicy,
    kitchenFood: scenario.kitchenFood,
    referenceDecisions: modelBased ? (scenario.kind === 't1' ? 4 : 6) : 0,
    zeroCall: !modelBased,
  };
}

export class NeedsBatchStore implements LiveAttemptHooks {
  readonly store: BatchStore;
  readonly batchId: string;
  private blockedSeq = 0;

  private constructor(store: BatchStore, batchId: string) {
    this.store = store;
    this.batchId = batchId;
  }

  /** Exclusive create. Throws BatchStoreError('exists') if the name is taken. */
  static open(
    root: string,
    batchId: string,
    init: Omit<BatchPlanFile, 'schema' | 'batchId' | 'version' | 'createdAt' | 'plannedScenarios'> & { scenarios: readonly G05Scenario[] },
  ): NeedsBatchStore {
    const store = createBatchStore(root, batchId); // atomic; throws before any write on EEXIST
    const outer = new NeedsBatchStore(store, batchId);
    const plan: BatchPlanFile = {
      schema: 'frostecho.g05.liveplan/1',
      batchId,
      mode: init.mode,
      matrixVersion: init.matrixVersion,
      chatBudget: init.chatBudget,
      requestDefaults: init.requestDefaults,
      plannedScenarios: init.scenarios.map(planEntry),
      version: collectVersion(process.cwd()),
      createdAt: new Date().toISOString(),
    };
    store.writeJson('plan.json', plan);
    // Initial batch.json: the full plan is on disk, everything explicitly not_run.
    writeReactiveBatchFile(store.dir, {
      schema: G05_BATCH_SCHEMA,
      batchId,
      matrixVersion: init.matrixVersion,
      mode: init.mode,
      episodes: [],
      notRun: init.scenarios.map(s => s.id),
      createdAt: plan.createdAt,
    });
    for (const scenario of init.scenarios) {
      outer.markScenarioStatus(scenario.id, init.mode === 'live' ? 'not_run' : 'not_run');
    }
    return outer;
  }

  get dir(): string {
    return this.store.dir;
  }

  savePreflight(preflight: Omit<PreflightFile, 'preflightRequests'>): void {
    this.store.writeJson('preflight.json', { ...preflight, preflightRequests: 1 });
  }

  /* ---------------- attempt ledger (LiveAttemptHooks) ---------------- */

  beginAttempt(begin: LiveAttemptBegin): void {
    // Write failure propagates: the caller must not send the request.
    this.store.writeJson(`attempts/${begin.attemptId}.begin.json`, begin);
  }

  finishAttempt(finish: LiveAttemptFinish): void {
    this.store.writeJson(`attempts/${finish.attemptId}.finish.json`, finish);
  }

  recordBlocked(blocked: LiveBlockedRecord): void {
    this.blockedSeq += 1;
    this.store.writeJson(`attempts/blocked-${String(this.blockedSeq).padStart(4, '0')}.json`, {
      ...blocked,
      seq: this.blockedSeq,
    });
  }

  /* ---------------- scenario status ---------------- */

  private statusSeq: Record<string, number> = {};

  /**
   * Append-only status trail: not_run → running → passed/…, one numbered file
   * per transition. A state update can never overwrite (and thereby lose) the
   * previous evidence.
   */
  markScenarioStatus(scenarioId: string, status: ScenarioRunStatus, detail?: string): void {
    const key = `plan-status/${scenarioFileKey(scenarioId)}`;
    const seq = (this.statusSeq[scenarioId] ?? 0) + 1;
    this.statusSeq[scenarioId] = seq;
    this.store.writeJson(`${key}/${String(seq).padStart(4, '0')}.json`, {
      scenarioId,
      status,
      ...(detail !== undefined ? { detail } : {}),
      at: new Date().toISOString(),
    });
  }

  /* ---------------- episodes ---------------- */

  /** Persist a finished episode immediately (pass or fail). Write-once. */
  saveEpisode(record: { episodeId: string }): string {
    const dir = join(this.store.dir, 'episodes', record.episodeId);
    if (existsSync(join(dir, 'game.json'))) {
      throw new BatchStoreError('evidence_exists', `episode ${record.episodeId} already saved; refusing to overwrite`);
    }
    return writeReactiveEpisode(this.store.root, this.batchId, record as Parameters<typeof writeReactiveEpisode>[2]);
  }

  /* ---------------- finalize ---------------- */

  /** Rewrite the derived batch.json (completed episodes vs not_run) once at the end. */
  finalizeBatchFile(episodes: string[], notRun: string[]): void {
    writeReactiveBatchFile(this.store.dir, {
      schema: G05_BATCH_SCHEMA,
      batchId: this.batchId,
      matrixVersion: 'g05-r1-t123',
      mode: this.readPlan().mode,
      episodes,
      notRun,
      createdAt: this.readPlan().createdAt,
      finalizedAt: new Date().toISOString(),
    });
  }

  writeSummary(summary: unknown): void {
    this.store.writeJson('summary.json', summary);
  }

  writeDone(payload: { batchId: string; stoppedReason: string | null; at: string }): void {
    this.store.writeJson('done.json', payload);
  }

  readPlan(): BatchPlanFile {
    return JSON.parse(readFileSync(join(this.store.dir, 'plan.json'), 'utf8')) as BatchPlanFile;
  }
}

/* ------------------------------------------------------------------ */
/* ledger reading — the summary is rebuilt from these files            */
/* ------------------------------------------------------------------ */

export interface AttemptLedger {
  begins: LiveAttemptBegin[];
  finishes: LiveAttemptFinish[];
  blocked: (LiveBlockedRecord & { seq: number })[];
}

export function readAttemptLedger(batchDir: string): AttemptLedger {
  const dir = join(batchDir, 'attempts');
  const ledger: AttemptLedger = { begins: [], finishes: [], blocked: [] };
  if (!existsSync(dir)) return ledger;
  for (const name of readdirSync(dir).sort()) {
    if (!name.endsWith('.json')) continue;
    const value = JSON.parse(readFileSync(join(dir, name), 'utf8'));
    if (name.endsWith('.begin.json')) ledger.begins.push(value as LiveAttemptBegin);
    else if (name.endsWith('.finish.json')) ledger.finishes.push(value as LiveAttemptFinish);
    else if (name.startsWith('blocked-')) ledger.blocked.push(value as LiveBlockedRecord & { seq: number });
  }
  return ledger;
}

export function plannedScenariosOf(batchDir: string): BatchPlanEntry[] {
  const plan = JSON.parse(readFileSync(join(batchDir, 'plan.json'), 'utf8')) as BatchPlanFile;
  return plan.plannedScenarios;
}

export { BatchStoreError };
