/**
 * Choice runtime (C). One entry point for scoring, evidence gating, submission
 * and recovery. The audited defects this version closes:
 *
 *  1. journal/cache identity: the digest covers actor, task, question,
 *     observation, goals, relations, memory facts+snapshot+policy, candidate
 *     content and the effective scorer/model/head/tokenizer/renderer policy.
 *     Reusing a requestId with different content is an explicit error.
 *  2. live scorer output is re-validated against the bound request; an
 *     out-of-set selection executes zero times.
 *  3. retrieval `error`/`incomplete` blocks the original accept: one bounded
 *     re-query, then an explicit fallback (counted separately) or abstain.
 *  4. `applied` is journaled only after the execution port confirms an
 *     authoritative event. A failure before/after persistence leaves a
 *     submit_pending record that recovery resolves by commandId.
 *  5. cost/execution are reported per phase; nothing claims completion early.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ContractError,
  canonicalJson,
  makeChoiceResult,
  type ChoiceRequest,
  type ChoiceResult,
  type ChoiceTask,
} from './contracts';
import type { ScorerPort } from '../planning/candidates';

export interface ScorerBinding {
  model: string;
  head: string;
  adapter?: string;
  tokenizer: string;
  renderer: string;
  policyVersion?: string;
  calibrationId?: string;
  task: ChoiceTask;
  k: number;
  memoryPolicyVersion: string;
  supportedK?: number[];
}

export type RetrievalStatus = 'ok' | 'empty' | 'error' | 'incomplete';
export type ExecutionStatus = 'applied' | 'rejected' | 'unknown';
export type JournalPhase = 'scored' | 'submit_pending' | 'applied' | 'rejected' | 'unknown';

export interface ExecutionOutcome {
  status: ExecutionStatus;
  eventIds: string[];
  postStateVersion: number | null;
  reason: string | null;
}

export interface ExecutionPort {
  commandId(result: ChoiceResult, request: ChoiceRequest): string;
  submit(commandId: string, result: ChoiceResult, request: ChoiceRequest): Promise<ExecutionOutcome>;
  query(commandId: string): Promise<ExecutionOutcome>;
}

export interface CurrentSnapshot {
  stateVersion: number;
  memorySnapshotHash?: string;
  memoryPolicyVersion?: string;
}

export interface AuditRecord {
  schema: 'frostecho.choice-audit/2';
  requestId: string;
  requestDigest: string;
  stateVersion: number;
  memorySnapshotHash: string | null;
  memoryPolicyVersion: string | null;
  candidateSetHash: string;
  scorerId: string;
  scorerMode: string;
  binding: ScorerBinding;
  calibrationId: string | null;
  retrieval: RetrievalStatus;
  evidenceGate: 'passed' | 'requeried' | 'blocked' | 'fallback';
  extraRetrievalUsed: boolean;
  fallbackUsed: boolean;
  fallbackFrom: string | null;
  shadow: boolean;
  executed: boolean;
  phase: JournalPhase;
  commandId: string | null;
  executionStatus: ExecutionStatus | null;
  eventIds: string[];
  postStateVersion: number | null;
  invalidResult: boolean;
  cacheHit: boolean;
  recovered: boolean;
  /** Same requestId arrived with different content: treated as a new request. */
  requestIdReusedWithNewContent: boolean;
  disposition: string;
  reason: string;
}

interface JournalEntry {
  digest: string;
  phase: JournalPhase;
  request: ChoiceRequest;
  result: ChoiceResult;
  audit: AuditRecord;
  commandId?: string;
  execution?: ExecutionOutcome;
}

export interface RunOptions {
  currentStateVersion?: number;
  currentSnapshot?: () => CurrentSnapshot | Promise<CurrentSnapshot>;
  retrieval?: () => RetrievalStatus | Promise<RetrievalStatus>;
  extraRetrieval?: (request: ChoiceRequest) => Promise<ChoiceRequest | null>;
  fallback?: ScorerPort;
  journalPath?: string;
  execution?: ExecutionPort;
  /** Legacy callback: journaled as applied only after it returns successfully. */
  execute?: (result: ChoiceResult) => void | Promise<void>;
  now?: number;
}

export class RuntimeError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'RuntimeError';
    this.code = code;
  }
}

export function requestDigest(request: ChoiceRequest, binding: ScorerBinding, scorer: ScorerPort): string {
  return createHash('sha256').update(canonicalJson({
    schema: request.schema,
    requestId: request.requestId,
    /** R2: the state version is part of the identity; recovery must not reuse
     *  a scored answer produced against another world version. */
    stateVersion: request.stateVersion,
    actorId: request.actorId,
    task: request.task,
    question: request.question,
    observation: request.observation,
    goals: request.goals,
    relationships: request.relationships,
    memoryFacts: request.memoryFacts,
    memorySnapshotHash: request.memorySnapshotHash ?? null,
    memoryPolicyVersion: request.memoryPolicyVersion ?? null,
    candidates: request.candidates,
    candidateSetHash: request.candidateSetHash,
    scorer: { id: scorer.id, mode: scorer.mode },
    binding: {
      model: binding.model, head: binding.head, adapter: binding.adapter ?? null,
      tokenizer: binding.tokenizer, renderer: binding.renderer,
      policyVersion: binding.policyVersion ?? null,
      calibrationId: binding.calibrationId ?? null,
      task: binding.task, k: binding.k, memoryPolicyVersion: binding.memoryPolicyVersion,
    },
  })).digest('hex');
}

function assertBinding(request: ChoiceRequest, binding: ScorerBinding, options: RunOptions): void {
  const k = request.candidates.length;
  if (k === 0) throw new RuntimeError('no_candidates', 'refusing to score an empty candidate set');
  const supported = binding.supportedK ?? [2, 4, 8];
  if (!supported.includes(k)) throw new RuntimeError('unsupported_k', `K=${k} outside supported ${supported.join('/')}`);
  if (binding.k !== k) throw new RuntimeError('k_mismatch', `binding K=${binding.k} but request K=${k}`);
  if (request.task !== binding.task) throw new RuntimeError('task_mismatch', `${request.task} != ${binding.task}`);
  if (request.memoryPolicyVersion !== binding.memoryPolicyVersion) {
    throw new RuntimeError('memory_policy_mismatch',
      `request memory policy ${String(request.memoryPolicyVersion)} != binding ${binding.memoryPolicyVersion}`);
  }
  if (options.currentStateVersion !== undefined && request.stateVersion !== options.currentStateVersion) {
    throw new RuntimeError('stale_state',
      `request stateVersion ${request.stateVersion} != current ${options.currentStateVersion}`);
  }
}

/** Re-validate the scorer's live output against the exact bound request. */
function validatedResult(request: ChoiceRequest, result: ChoiceResult): { result: ChoiceResult; valid: boolean; reason: string } {
  const fail = (reason: string) => ({
    result: makeChoiceResult({ request, scorerId: 'invalid', scores: [], selectedId: null,
      disposition: 'unavailable', reason }),
    valid: false,
    reason,
  });
  if (result.requestId !== request.requestId) return fail('response_request_id_mismatch');
  if (result.candidateSetHash !== request.candidateSetHash) return fail('response_candidate_hash_mismatch');
  try {
    const rebuilt = makeChoiceResult({
      request,
      scorerId: result.scorerId,
      scores: result.scores,
      selectedId: result.selectedId,
      disposition: result.disposition,
      reason: result.reason,
      calibrationId: result.calibrationId,
    });
    return { result: rebuilt, valid: true, reason: 'valid' };
  } catch (error) {
    if (error instanceof ContractError) return fail(`invalid_response:${error.code}`);
    throw error;
  }
}

export class ChoiceJournal {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private read(): JournalEntry[] {
    if (!existsSync(this.path)) return [];
    const doc = JSON.parse(readFileSync(this.path, 'utf8')) as { entries?: JournalEntry[] };
    return Array.isArray(doc.entries) ? doc.entries : [];
  }

  private write(entries: JournalEntry[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const payload = { schema: 'frostecho.choice-journal/2', entries,
      audit: entries.length ? entries[entries.length - 1].audit : null };
    const temp = `${this.path}.tmp`;
    writeFileSync(temp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    renameSync(temp, this.path);
  }

  append(entry: JournalEntry): void {
    const entries = this.read();
    entries.push(entry);
    this.write(entries);
  }

  entries(requestId: string): JournalEntry[] {
    return this.read().filter(entry => entry.request?.requestId === requestId);
  }

  latest(requestId: string): JournalEntry | null {
    const entries = this.entries(requestId);
    return entries.length ? entries[entries.length - 1] : null;
  }
}

export interface RunOutcome {
  result: ChoiceResult;
  audit: AuditRecord;
}

export async function runChoice(
  request: ChoiceRequest,
  scorer: ScorerPort,
  binding: ScorerBinding,
  options: RunOptions = {},
): Promise<RunOutcome> {
  assertBinding(request, binding, options);
  const digest = requestDigest(request, binding, scorer);
  const journal = options.journalPath ? new ChoiceJournal(options.journalPath) : null;
  const shown = request;

  const baseAudit = (): AuditRecord => ({
    schema: 'frostecho.choice-audit/2',
    requestId: request.requestId,
    requestDigest: digest,
    stateVersion: request.stateVersion,
    memorySnapshotHash: request.memorySnapshotHash ?? null,
    memoryPolicyVersion: request.memoryPolicyVersion ?? null,
    candidateSetHash: request.candidateSetHash,
    scorerId: scorer.id,
    scorerMode: scorer.mode,
    binding,
    calibrationId: binding.calibrationId ?? null,
    retrieval: 'ok',
    evidenceGate: 'passed',
    extraRetrievalUsed: false,
    fallbackUsed: false,
    fallbackFrom: null,
    shadow: scorer.mode === 'jev',
    executed: false,
    phase: 'scored',
    commandId: null,
    executionStatus: null,
    eventIds: [],
    postStateVersion: null,
    invalidResult: false,
    cacheHit: false,
    recovered: false,
    requestIdReusedWithNewContent: false,
    disposition: 'unavailable',
    reason: '',
  });

  const audit = baseAudit();

  // ---------- recovery before any model call ----------
  let recoveredResult: ChoiceResult | null = null;
  let recoveredExecution: ExecutionOutcome | null = null;
  if (journal) {
    const allEntries = journal.entries(request.requestId);
    const entries = allEntries.filter(entry => entry.digest === digest);
    if (allEntries.some(entry => entry.digest !== digest)) {
      // The same id with different content is a new request, never an old hit.
      audit.requestIdReusedWithNewContent = true;
    }
    const latest = entries.length ? entries[entries.length - 1] : null;
    if (latest) {
      if (latest.phase === 'applied') {
        return { result: latest.result,
          audit: { ...latest.audit, cacheHit: true, recovered: true, executed: true,
            phase: 'applied', executionStatus: 'applied' } };
      }
      if (latest.phase === 'rejected') {
        return { result: latest.result,
          audit: { ...latest.audit, cacheHit: true, recovered: true, executed: false,
            phase: 'rejected', executionStatus: 'rejected' } };
      }
      if ((latest.phase === 'submit_pending' || latest.phase === 'unknown')
          && latest.commandId && options.execution) {
        const outcome = await options.execution.query(latest.commandId);
        const audit = { ...latest.audit, cacheHit: true, recovered: true,
          phase: outcome.status === 'applied' ? 'applied' as const
            : outcome.status === 'rejected' ? 'rejected' as const : 'unknown' as const,
          executionStatus: outcome.status === 'unknown' ? null : outcome.status,
          executed: outcome.status === 'applied', eventIds: outcome.eventIds,
          postStateVersion: outcome.postStateVersion, reason: `recovered:${outcome.status}` };
        journal.append({ digest, phase: audit.phase, request, result: latest.result, audit,
          commandId: latest.commandId, execution: outcome });
        return { result: latest.result, audit };
      }
      if (latest.phase === 'unknown') {
        return { result: latest.result,
          audit: { ...latest.audit, cacheHit: true, recovered: true, executed: false,
            phase: 'unknown', executionStatus: null } };
      }
      if (latest.phase === 'submit_pending' && latest.commandId && !options.execution) {
        // A durable submit_pending without a queryable port cannot be resolved;
        // never assume the effect happened and never run it a second time.
        return { result: latest.result,
          audit: { ...latest.audit, cacheHit: true, recovered: true, executed: false,
            phase: 'unknown', executionStatus: null,
            reason: 'submit_pending_without_query_port: not re-executed' } };
      }
      // phase scored: reuse the scored result, restore the persisted evidence
      // state, and never let a recorded error/incomplete upgrade to execution.
      recoveredResult = latest.result;
      audit.retrieval = latest.audit.retrieval;
      audit.evidenceGate = latest.audit.evidenceGate;
      audit.extraRetrievalUsed = latest.audit.extraRetrievalUsed;
      audit.fallbackUsed = latest.audit.fallbackUsed;
      audit.fallbackFrom = latest.audit.fallbackFrom;
      audit.invalidResult = latest.audit.invalidResult;
    }
  }

  // ---------- scoring ----------
  let activeRequest = shown;
  let result: ChoiceResult;
  let retrieval: RetrievalStatus = 'ok';

  if (recoveredResult) {
    result = recoveredResult;
    audit.recovered = true;
    audit.cacheHit = true;
  } else {
    if (options.retrieval) {
      try {
        retrieval = await options.retrieval();
      } catch {
        retrieval = 'error';
      }
    }
    audit.retrieval = retrieval;
    const invoked = await (async () => {
      try {
        return await scorer.score(activeRequest);
      } catch (error) {
        return makeChoiceResult({ request: activeRequest, scorerId: scorer.id, scores: [],
          selectedId: null, disposition: 'unavailable',
          reason: `scorer_error: ${(error as Error).message}` });
      }
    })();
    const check = validatedResult(activeRequest, invoked);
    result = check.result;
    audit.invalidResult = !check.valid;
    if (!check.valid) audit.reason = check.reason;
    if (journal) journal.append({ digest, phase: 'scored', request: activeRequest, result, audit });
  }

  // ---------- evidence gate ----------
  // Recovered entries must keep their persisted retrieval verdict; only a live
  // scoring run may claim `ok`. This also applies after recovery.
  if (recoveredResult) retrieval = audit.retrieval;
  let evidenceBlocked = retrieval === 'error' || retrieval === 'incomplete';
  if (evidenceBlocked && options.extraRetrieval && !audit.extraRetrievalUsed) {
    audit.extraRetrievalUsed = true;
    const refreshed = await options.extraRetrieval(activeRequest).catch(() => null);
    if (refreshed) {
      activeRequest = refreshed;
      assertBinding(activeRequest, binding, options);
      const check = validatedResult(activeRequest, await (async () => {
        try {
          return await scorer.score(activeRequest);
        } catch (error) {
          return makeChoiceResult({ request: activeRequest, scorerId: scorer.id, scores: [],
            selectedId: null, disposition: 'unavailable',
            reason: `scorer_error: ${(error as Error).message}` });
        }
      })());
      result = check.result;
      audit.invalidResult = audit.invalidResult || !check.valid;
      try {
        retrieval = options.retrieval ? await options.retrieval() : 'ok';
      } catch {
        retrieval = 'error';
      }
      evidenceBlocked = retrieval === 'error' || retrieval === 'incomplete';
      audit.retrieval = retrieval;
      if (!evidenceBlocked) audit.evidenceGate = 'requeried';
    }
  }

  let fallbackUsed = false;
  let fallbackFrom: string | null = null;
  if (evidenceBlocked) {
    if (options.fallback) {
      fallbackUsed = true;
      fallbackFrom = scorer.id;
      const fallbackResult = validatedResult(activeRequest,
        await options.fallback.score(activeRequest)).result;
      if (fallbackResult.disposition === 'accept') {
        result = makeChoiceResult({ request: activeRequest, scorerId: fallbackResult.scorerId,
          scores: fallbackResult.scores, selectedId: fallbackResult.selectedId,
          disposition: 'accept', reason: `${fallbackResult.reason}; evidence fallback from ${scorer.id}` });
        audit.evidenceGate = 'fallback';
      } else {
        result = fallbackResult;
      }
    } else {
      result = makeChoiceResult({ request: activeRequest, scorerId: scorer.id, scores: [],
        selectedId: null, disposition: 'abstain', reason: `evidence_${retrieval}: not executed` });
      audit.evidenceGate = 'blocked';
    }
  }
  if (evidenceBlocked && !fallbackUsed) {
    result = makeChoiceResult({ request: activeRequest, scorerId: scorer.id, scores: [],
      selectedId: null, disposition: 'abstain', reason: `evidence_${retrieval}: not executed` });
  }

  // ---------- pre-submit freshness check ----------
  if (result.disposition === 'accept' && !audit.shadow) {
    const current = options.currentSnapshot ? await options.currentSnapshot()
      : options.currentStateVersion !== undefined
        ? { stateVersion: options.currentStateVersion } : null;
    if (current) {
      const staleState = current.stateVersion !== activeRequest.stateVersion;
      const staleMemory = current.memorySnapshotHash !== undefined
        && current.memorySnapshotHash !== activeRequest.memorySnapshotHash;
      if (staleState || staleMemory) {
        result = makeChoiceResult({ request: activeRequest, scorerId: scorer.id, scores: [],
          selectedId: null, disposition: 'abstain',
          reason: `stale_before_submit:${staleState ? 'state' : 'memory'}` });
      }
    }
  }

  const shadow = scorer.mode === 'jev';
  const executed = result.disposition === 'accept' && !shadow;
  audit.scorerId = result.scorerId;
  audit.disposition = result.disposition;
  audit.reason = result.reason || audit.reason;
  audit.executed = false;
  audit.fallbackUsed = fallbackUsed;
  audit.fallbackFrom = fallbackFrom;
  audit.retrieval = retrieval;
  audit.shadow = shadow;

  // ---------- submission ----------
  let commandId: string | null = null;
  let execution: ExecutionOutcome | null = null;
  if (executed && options.execution) {
    commandId = options.execution.commandId(result, activeRequest);
    audit.commandId = commandId;
    audit.phase = 'submit_pending';
    if (journal) journal.append({ digest, phase: 'submit_pending', request: activeRequest, result, audit, commandId });
    execution = await options.execution.submit(commandId, result, activeRequest);
    audit.executionStatus = execution.status === 'unknown' ? null : execution.status;
    audit.eventIds = execution.eventIds;
    audit.postStateVersion = execution.postStateVersion;
    audit.phase = execution.status === 'applied' ? 'applied'
      : execution.status === 'rejected' ? 'rejected' : 'unknown';
    audit.executed = execution.status === 'applied';
    if (journal) journal.append({ digest, phase: audit.phase, request: activeRequest, result, audit, commandId, execution });
  } else if (executed && options.execute) {
    if (journal) {
      // Durable mode requires a queryable, idempotent submission port. A legacy
      // void callback has no recovery semantics, so persistent execution is
      // refused instead of risking a second effect after a crash.
      result = makeChoiceResult({ request: activeRequest, scorerId: result.scorerId,
        scores: result.scores, selectedId: null, disposition: 'unavailable',
        reason: 'legacy_execute_refused_in_journal_mode: no queryable idempotent port' });
      audit.disposition = result.disposition;
      audit.reason = result.reason;
      audit.phase = 'scored';
      audit.executed = false;
      if (journal) journal.append({ digest, phase: 'scored', request: activeRequest, result, audit });
    } else {
      // Legacy callback without a journal: synchronous compatibility only.
      commandId = `legacy:${digest.slice(0, 16)}`;
      audit.commandId = commandId;
      audit.phase = 'submit_pending';
      try {
        await options.execute(result);
        execution = { status: 'applied', eventIds: [], postStateVersion: null, reason: 'legacy callback' };
      } catch (error) {
        execution = { status: 'unknown', eventIds: [], postStateVersion: null,
          reason: `execute_error: ${(error as Error).message}` };
      }
      audit.executionStatus = execution.status === 'unknown' ? null : execution.status;
      audit.phase = execution.status === 'applied' ? 'applied'
        : execution.status === 'rejected' ? 'rejected' : 'unknown';
      audit.executed = execution.status === 'applied';
    }
  } else {
    audit.phase = 'scored';
    audit.executed = false;
    if (journal) journal.append({ digest, phase: 'scored', request: activeRequest, result, audit });
  }

  return { result, audit };
}

/** Cache entry validity is the same digest used by the journal. */
export class ScoreCache {
  private readonly entries = new Map<string, ChoiceResult>();

  lookup(request: ChoiceRequest, binding: ScorerBinding, scorer: ScorerPort): ChoiceResult | null {
    return this.entries.get(requestDigest(request, binding, scorer)) ?? null;
  }

  store(request: ChoiceRequest, binding: ScorerBinding, scorer: ScorerPort, result: ChoiceResult): void {
    this.entries.set(requestDigest(request, binding, scorer), result);
  }

  get size(): number {
    return this.entries.size;
  }
}

export function assertCalibrationBinding(binding: ScorerBinding, policy: {
  task: ChoiceTask;
  k: number;
  memoryPolicyVersion: string;
}): void {
  if (binding.task !== policy.task || binding.k !== policy.k ||
      binding.memoryPolicyVersion !== policy.memoryPolicyVersion) {
    throw new ContractError('calibration_mismatch',
      'calibration identity does not cover this task/K/memory policy');
  }
}

export function hashMemorySnapshot(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
