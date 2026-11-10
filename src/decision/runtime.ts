/**
 * Choice runtime (C): binds a request to its cache, memory snapshot and
 * calibration identity, runs a scorer, and records the outcome. Research
 * scorers first run in shadow and never submit an action.
 *
 * Failure semantics that matter:
 *  - retrieval error is NOT an empty history;
 *  - at most one extra retrieval per decision;
 *  - a fallback result is labelled as fallback, never counted as a JEV accept;
 *  - a result produced against another state/memory snapshot is refused.
 */
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  ContractError,
  makeChoiceResult,
  type ChoiceRequest,
  type ChoiceResult,
  type ChoiceTask,
} from './contracts';
import type { ScorerPort } from '../planning/candidates';

export interface ScorerBinding {
  model: string;
  head: string;
  tokenizer: string;
  renderer: string;
  calibrationId?: string;
  task: ChoiceTask;
  k: number;
  memoryPolicyVersion: string;
  supportedK?: number[];
}

export type RetrievalStatus = 'ok' | 'empty' | 'error' | 'incomplete';

export interface AuditRecord {
  schema: 'frostecho.choice-audit/1';
  requestId: string;
  stateVersion: number;
  memorySnapshotHash: string | null;
  memoryPolicyVersion: string | null;
  candidateSetHash: string;
  scorerId: string;
  scorerMode: string;
  calibrationId: string | null;
  retrieval: RetrievalStatus;
  extraRetrievalUsed: boolean;
  fallbackUsed: boolean;
  fallbackFrom: string | null;
  shadow: boolean;
  executed: boolean;
  cacheHit: boolean;
  disposition: string;
  reason: string;
}

export interface RunOptions {
  currentStateVersion?: number;
  retrieval?: () => 'ok' | 'empty' | 'incomplete' | Promise<'ok' | 'empty' | 'incomplete'>;
  extraRetrieval?: (request: ChoiceRequest) => Promise<ChoiceRequest | null>;
  fallback?: ScorerPort;
  journalPath?: string;
  execute?: (result: ChoiceResult) => void;
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

function cacheKey(request: ChoiceRequest, binding: ScorerBinding, scorer: ScorerPort): string {
  return createHash('sha256').update(JSON.stringify({
    candidateSetHash: request.candidateSetHash,
    stateVersion: request.stateVersion,
    memorySnapshotHash: request.memorySnapshotHash ?? null,
    memoryPolicyVersion: request.memoryPolicyVersion ?? null,
    scorer: scorer.id,
    calibrationId: binding.calibrationId ?? null,
    task: binding.task,
    k: binding.k,
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
    throw new RuntimeError('stale_state', `request stateVersion ${request.stateVersion} != current ${options.currentStateVersion}`);
  }
}

export class ChoiceJournal {
  readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private ensure(): void {
    mkdirSync(dirname(this.path), { recursive: true });
  }

  append(record: { request: ChoiceRequest; result: ChoiceResult; audit: AuditRecord }): void {
    this.ensure();
    appendFileSync(this.path, `${JSON.stringify(record)}\n`, 'utf8');
  }

  find(requestId: string): { result: ChoiceResult; audit: AuditRecord } | null {
    if (!existsSync(this.path)) return null;
    const lines = readFileSync(this.path, 'utf8').split('\n').filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const parsed = JSON.parse(lines[index]) as { request?: { requestId?: string }; result?: ChoiceResult; audit?: AuditRecord };
      if (parsed.request?.requestId === requestId && parsed.result && parsed.audit) {
        return { result: parsed.result, audit: parsed.audit };
      }
    }
    return null;
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
  const journal = options.journalPath ? new ChoiceJournal(options.journalPath) : null;
  const key = cacheKey(request, binding, scorer);

  if (journal) {
    const recovered = journal.find(request.requestId);
    if (recovered && recovered.audit.candidateSetHash === request.candidateSetHash) {
      return { result: recovered.result,
        audit: { ...recovered.audit, cacheHit: true, executed: false, reason: `${recovered.audit.reason} (recovered)` } };
    }
  }

  let retrieval: RetrievalStatus = 'ok';
  if (options.retrieval) {
    try {
      retrieval = await options.retrieval();
    } catch {
      retrieval = 'error';
    }
  }

  const shadow = scorer.mode === 'jev';
  let fallbackUsed = false;
  let fallbackFrom: string | null = null;
  let extraUsed = false;

  const invoke = (current: ChoiceRequest): ChoiceResult => {
    try {
      return scorer.score(current);
    } catch (error) {
      return makeChoiceResult({ request: current, scorerId: scorer.id, scores: [], selectedId: null,
        disposition: 'unavailable', reason: `scorer_error: ${(error as Error).message}` });
    }
  };

  let activeRequest = request;
  let result = invoke(activeRequest);

  // Retrieval error or an unusable result: at most one bounded re-query.
  const needsEvidence = retrieval === 'error' || result.disposition !== 'accept';
  if (needsEvidence && options.extraRetrieval) {
    extraUsed = true;
    const refreshed = await options.extraRetrieval(activeRequest).catch(() => null);
    if (refreshed) {
      activeRequest = refreshed;
      assertBinding(activeRequest, binding, options);
      result = invoke(activeRequest);
    }
  }

  // Explicit fallback. Never used to claim a research-model success.
  if ((result.disposition !== 'accept' || retrieval === 'error') && options.fallback) {
    fallbackUsed = true;
    fallbackFrom = scorer.id;
    const fallback = options.fallback;
    const fallbackResult = fallback.score(activeRequest);
    if (fallbackResult.disposition === 'accept') {
      result = makeChoiceResult({
        request: activeRequest,
        scorerId: fallbackResult.scorerId,
        scores: fallbackResult.scores,
        selectedId: fallbackResult.selectedId,
        disposition: 'accept',
        reason: `${fallbackResult.reason}; fallback from ${scorer.id}`,
      });
    } else {
      result = fallbackResult;
    }
  }

  const executed = result.disposition === 'accept' && !shadow;
  const audit: AuditRecord = {
    schema: 'frostecho.choice-audit/1',
    requestId: activeRequest.requestId,
    stateVersion: activeRequest.stateVersion,
    memorySnapshotHash: activeRequest.memorySnapshotHash ?? null,
    memoryPolicyVersion: activeRequest.memoryPolicyVersion ?? null,
    candidateSetHash: activeRequest.candidateSetHash,
    scorerId: result.scorerId,
    scorerMode: scorer.mode,
    calibrationId: result.calibrationId ?? binding.calibrationId ?? null,
    retrieval,
    extraRetrievalUsed: extraUsed,
    fallbackUsed,
    fallbackFrom,
    shadow,
    executed,
    cacheHit: false,
    disposition: result.disposition,
    reason: result.reason,
  };

  if (journal) journal.append({ request: activeRequest, result, audit });
  if (executed && options.execute) options.execute(result);
  return { result, audit };
}

/** Cache entry validity: a changed candidate set, state or memory hash is a miss. */
export class ScoreCache {
  private readonly entries = new Map<string, { result: ChoiceResult; key: string }>();

  lookup(request: ChoiceRequest, binding: ScorerBinding, scorer: ScorerPort): ChoiceResult | null {
    const key = cacheKey(request, binding, scorer);
    const entry = this.entries.get(key);
    return entry ? entry.result : null;
  }

  store(request: ChoiceRequest, binding: ScorerBinding, scorer: ScorerPort, result: ChoiceResult): void {
    this.entries.set(cacheKey(request, binding, scorer), { result, key: request.candidateSetHash });
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
