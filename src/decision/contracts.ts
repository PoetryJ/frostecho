/**
 * Frozen choice contract shared by the TS game/runtime and the Python research
 * stack. Owner: sprint integrator. Change only through the owner, then notify
 * every dependent worker.
 *
 * Rules this file enforces (see handoff/02-CONTRACTS.md):
 *  - candidate ids are opaque and stable only for mapping, never a training cue;
 *  - the candidate set hash binds the exact content of the set, so a changed
 *    candidate invalidates any cached legality or calibration;
 *  - a scorer may not invent actor/command ids, and an empty set is never
 *    scored with a softmax;
 *  - duplicate ids, NaN/Infinity, unknown candidate ids and out-of-range
 *    probabilities are rejected immediately.
 */
import { createHash } from 'node:crypto';

export type ChoiceTask = 'interpret_request' | 'choose_goal' | 'choose_action';

export type Disposition = 'accept' | 'abstain' | 'unavailable';

export interface ObservedFact {
  eventId: string;
  observerId: string;
  simTime: number;
  subjectIds: string[];
  kind: string;
  payload: unknown;
  source: 'engine' | 'player_statement' | 'inference';
}

export interface Candidate {
  id: string;
  kind: string;
  description: string;
  parameters: Record<string, unknown>;
  preconditions: string[];
  expectedEffects: Record<string, number>;
  utilityComponents: Record<string, number>;
}

export interface ChoiceRequest {
  schema: string;
  requestId: string;
  task: ChoiceTask;
  actorId: string;
  stateVersion: number;
  observation: unknown;
  question: string;
  memoryFacts: ObservedFact[];
  relationships: unknown;
  goals: unknown;
  candidates: Candidate[];
  candidateSetHash: string;
  /** Binds this request, its cache entry and its calibration to one memory state. */
  memorySnapshotHash?: string;
  memoryPolicyVersion?: string;
}

export interface CandidateScore {
  candidateId: string;
  logit: number;
  probability?: number;
}

export interface ChoiceResult {
  requestId: string;
  candidateSetHash: string;
  scorerId: string;
  scores: CandidateScore[];
  calibrationId?: string;
  selectedId: string | null;
  disposition: Disposition;
  reason: string;
}

export const CHOICE_REQUEST_SCHEMA = 'frostecho.choice-request/1';
export const CHOICE_RESULT_SCHEMA = 'frostecho.choice-result/1';
export const CHOICE_TASKS: readonly ChoiceTask[] = ['interpret_request', 'choose_goal', 'choose_action'];

export class ContractError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'ContractError';
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new ContractError(code, message);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function assertFiniteRecord(value: unknown, where: string): void {
  if (!isPlainObject(value)) fail('not_an_object', `${where} must be an object`);
  for (const [key, entry] of Object.entries(value)) {
    if (!isFiniteNumber(entry)) fail('not_finite', `${where}.${key} must be a finite number`);
  }
}

/** Deterministic canonical JSON: sorted keys, no whitespace. */
export function canonicalJson(value: unknown): string {
  const seen = new WeakSet<object>();
  const encode = (input: unknown): string => {
    if (input === null) return 'null';
    if (typeof input === 'number') {
      if (!Number.isFinite(input)) fail('not_finite', 'canonicalJson refuses NaN/Infinity');
      return JSON.stringify(input);
    }
    if (typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
    if (Array.isArray(input)) return `[${input.map(encode).join(',')}]`;
    if (isPlainObject(input)) {
      if (seen.has(input)) fail('cycle', 'canonicalJson refuses cyclic objects');
      seen.add(input);
      const keys = Object.keys(input).sort();
      const body = keys.map(key => `${JSON.stringify(key)}:${encode(input[key])}`).join(',');
      seen.delete(input);
      return `{${body}}`;
    }
    return fail('not_serialisable', `unsupported value type ${typeof input}`);
  };
  return encode(value);
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * Hash of the candidate set. Order-independent (ids are sorted) but content
 * sensitive: changing an id, description, parameter, precondition or utility
 * changes the hash, which invalidates cached legality and calibration.
 */
export function candidateSetHash(candidates: readonly Candidate[]): string {
  const canonical = candidates
    .map(candidate => ({
      id: candidate.id,
      kind: candidate.kind,
      description: candidate.description,
      parameters: candidate.parameters,
      preconditions: candidate.preconditions,
      expectedEffects: candidate.expectedEffects,
      utilityComponents: candidate.utilityComponents,
    }))
    .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  return sha256Hex(canonicalJson(canonical));
}

export function validateCandidate(candidate: Candidate, index: number): void {
  const where = `candidates[${index}]`;
  if (!isPlainObject(candidate)) fail('candidate_not_object', `${where} must be an object`);
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
    fail('candidate_id', `${where}.id must be a non-empty string`);
  }
  if (typeof candidate.kind !== 'string' || candidate.kind.length === 0) {
    fail('candidate_kind', `${where}.kind must be a non-empty string`);
  }
  if (typeof candidate.description !== 'string' || candidate.description.length === 0) {
    fail('candidate_description', `${where}.description must be a non-empty string`);
  }
  if (!Array.isArray(candidate.preconditions) ||
      candidate.preconditions.some(item => typeof item !== 'string')) {
    fail('candidate_preconditions', `${where}.preconditions must be strings`);
  }
  assertFiniteRecord(candidate.expectedEffects, `${where}.expectedEffects`);
  assertFiniteRecord(candidate.utilityComponents, `${where}.utilityComponents`);
  if (!isPlainObject(candidate.parameters)) fail('candidate_parameters', `${where}.parameters must be an object`);
}

export function validateFact(fact: ObservedFact, index: number): void {
  const where = `memoryFacts[${index}]`;
  if (!isPlainObject(fact)) fail('fact_not_object', `${where} must be an object`);
  if (typeof fact.eventId !== 'string' || fact.eventId.length === 0) fail('fact_event', `${where}.eventId`);
  if (typeof fact.observerId !== 'string' || fact.observerId.length === 0) fail('fact_observer', `${where}.observerId`);
  if (!isFiniteNumber(fact.simTime)) fail('fact_time', `${where}.simTime`);
  if (!Array.isArray(fact.subjectIds) || fact.subjectIds.some(id => typeof id !== 'string')) {
    fail('fact_subjects', `${where}.subjectIds must be strings`);
  }
  if (!['engine', 'player_statement', 'inference'].includes(fact.source)) {
    fail('fact_source', `${where}.source must be engine|player_statement|inference`);
  }
}

export interface RequestInput {
  requestId: string;
  task: ChoiceTask;
  actorId: string;
  stateVersion: number;
  observation: unknown;
  question: string;
  memoryFacts?: ObservedFact[];
  relationships?: unknown;
  goals?: unknown;
  candidates: Candidate[];
  memorySnapshotHash?: string;
  memoryPolicyVersion?: string;
}

/** Build a request and compute its hash from the exact candidate content. */
export function makeChoiceRequest(input: RequestInput): ChoiceRequest {
  if (typeof input.requestId !== 'string' || input.requestId.length === 0) fail('request_id', 'requestId required');
  if (!CHOICE_TASKS.includes(input.task)) fail('unknown_task', `unknown task ${String(input.task)}`);
  if (typeof input.actorId !== 'string' || input.actorId.length === 0) fail('actor_id', 'actorId required');
  if (!Number.isInteger(input.stateVersion) || input.stateVersion < 0) {
    fail('state_version', 'stateVersion must be a non-negative integer');
  }
  if (typeof input.question !== 'string') fail('question', 'question must be a string');
  const candidates = input.candidates ?? [];
  candidates.forEach(validateCandidate);
  const ids = candidates.map(candidate => candidate.id);
  if (new Set(ids).size !== ids.length) fail('duplicate_candidate_id', 'candidate ids must be unique');
  const memoryFacts = input.memoryFacts ?? [];
  memoryFacts.forEach(validateFact);
  return {
    schema: CHOICE_REQUEST_SCHEMA,
    requestId: input.requestId,
    task: input.task,
    actorId: input.actorId,
    stateVersion: input.stateVersion,
    observation: input.observation,
    question: input.question,
    memoryFacts,
    relationships: input.relationships ?? {},
    goals: input.goals ?? [],
    candidates,
    candidateSetHash: candidateSetHash(candidates),
    ...(input.memorySnapshotHash === undefined ? {} : { memorySnapshotHash: input.memorySnapshotHash }),
    ...(input.memoryPolicyVersion === undefined ? {} : { memoryPolicyVersion: input.memoryPolicyVersion }),
  };
}

export interface ResultInput {
  request: ChoiceRequest;
  scorerId: string;
  scores: CandidateScore[];
  selectedId: string | null;
  disposition: Disposition;
  reason: string;
  calibrationId?: string;
}

/**
 * Build a result and verify it against the request it answers. This is the
 * engine-side guard: a scorer cannot select an id it was not given, cannot
 * score a different set, and cannot claim `accept` without a bound candidate.
 */
export function makeChoiceResult(input: ResultInput): ChoiceResult {
  const { request } = input;
  if (typeof input.scorerId !== 'string' || input.scorerId.length === 0) fail('scorer_id', 'scorerId required');
  if (!['accept', 'abstain', 'unavailable'].includes(input.disposition)) {
    fail('disposition', `unknown disposition ${String(input.disposition)}`);
  }
  if (typeof input.reason !== 'string' || input.reason.length === 0) fail('reason', 'reason required');

  const candidates = new Map(request.candidates.map(candidate => [candidate.id, candidate]));
  const scores: CandidateScore[] = [];
  const seen = new Set<string>();
  for (const score of input.scores) {
    if (!isPlainObject(score)) fail('score_not_object', 'score entry must be an object');
    if (typeof score.candidateId !== 'string' || !candidates.has(score.candidateId)) {
      fail('unknown_candidate', `score for unknown candidate ${String(score.candidateId)}`);
    }
    if (!isFiniteNumber(score.logit)) fail('logit', `logit for ${score.candidateId} must be finite`);
    if (score.probability !== undefined && !isFiniteNumber(score.probability)) {
      fail('probability', `probability for ${score.candidateId} must be finite`);
    }
    if (seen.has(score.candidateId)) fail('duplicate_score', `duplicate score for ${score.candidateId}`);
    seen.add(score.candidateId);
    if (input.disposition === 'accept' && score.probability !== undefined &&
        (score.probability < 0 || score.probability > 1)) {
      fail('probability_range', `probability for ${score.candidateId} outside [0,1]`);
    }
    scores.push({ candidateId: score.candidateId,
      logit: score.logit,
      ...(score.probability === undefined ? {} : { probability: score.probability }) });
  }
  if (input.disposition === 'accept') {
    if (request.candidates.length === 0) fail('empty_candidate_set', 'an empty candidate set cannot be accepted');
    if (scores.length !== request.candidates.length) fail('incomplete_scores', 'accept needs a score for every candidate');
    if (!input.selectedId || !candidates.has(input.selectedId)) {
      fail('unbound_selection', 'accept requires selectedId from the request candidate set');
    }
  } else if (input.selectedId !== null) {
    fail('selection_on_abstain', 'abstain/unavailable must not select a candidate');
  }
  const probabilities = scores.map(score => score.probability);
  if (probabilities.length > 0 && probabilities.every(value => value !== undefined)) {
    const sum = (probabilities as number[]).reduce((total, value) => total + value, 0);
    if (Math.abs(sum - 1) > 1e-6) fail('probability_sum', `probabilities sum to ${sum}, not 1`);
  }
  return {
    requestId: request.requestId,
    candidateSetHash: request.candidateSetHash,
    scorerId: input.scorerId,
    scores,
    ...(input.calibrationId === undefined ? {} : { calibrationId: input.calibrationId }),
    selectedId: input.selectedId,
    disposition: input.disposition,
    reason: input.reason,
  };
}

/** Structural check for a request coming from another process (JSON). */
export function validateChoiceRequest(value: unknown): ChoiceRequest {
  if (!isPlainObject(value)) fail('request_not_object', 'request must be an object');
  if (value.schema !== CHOICE_REQUEST_SCHEMA) fail('schema', `unexpected schema ${String(value.schema)}`);
  const rebuilt = makeChoiceRequest({
    requestId: value.requestId as string,
    task: value.task as ChoiceTask,
    actorId: value.actorId as string,
    stateVersion: value.stateVersion as number,
    observation: value.observation,
    question: value.question as string,
    memoryFacts: (value.memoryFacts ?? []) as ObservedFact[],
    relationships: value.relationships,
    goals: value.goals,
    candidates: value.candidates as Candidate[],
    memorySnapshotHash: value.memorySnapshotHash as string | undefined,
    memoryPolicyVersion: value.memoryPolicyVersion as string | undefined,
  });
  if (value.candidateSetHash !== rebuilt.candidateSetHash) {
    fail('candidate_hash', 'candidateSetHash does not match the candidate content');
  }
  return rebuilt;
}
