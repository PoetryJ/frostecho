/**
 * G05-live shared interfaces, frozen by the main agent before A/B/C start.
 *
 * Order of operations for every chat request (EXECUTION §共享接口):
 *   1. gate.reserve()            — synchronous, no refunds, counts even on failure
 *   2. store.beginAttempt(...)   — durable; if this write fails, no HTTP is sent
 *   3. the actual HTTP request
 *   4. store.finishAttempt(...)  — durable response/error + usage
 * A begin with no finish (crash) stays unresolved: the slot is conservatively
 * spent and must never be reported as a confirmed response.
 */

export interface BudgetReserveOk {
  ok: true;
  attemptId: string;
}

export interface BudgetReserveDenied {
  ok: false;
  code: 'CHAT_BUDGET_EXHAUSTED';
}

export type BudgetReservation = BudgetReserveOk | BudgetReserveDenied;

/** Sampling/config snapshot recorded with every attempt; secrets are never included. */
export interface AttemptRequestConfig {
  model: string | null;
  temperature: number;
  max_tokens: number;
  stream: boolean;
  enableThinking: boolean[];
  timeoutMs: number;
}

export interface LiveAttemptBegin {
  attemptId: string;
  /** Monotonic sequence within the batch; also the attempt file stem. */
  seq: number;
  episodeId: string;
  actorId: string;
  cycle: number;
  round: number;
  at: string;
  requestConfig: AttemptRequestConfig;
}

export type LiveAttemptOutcome = 'success' | 'http_error' | 'network_error' | 'timeout' | 'parse_error' | 'aborted';

export interface LiveAttemptFinish {
  attemptId: string;
  at: string;
  outcome: LiveAttemptOutcome;
  /** HTTP status when one arrived; null when the request never completed. */
  status: number | null;
  error: string | null;
  usage: { prompt_tokens: number | null; completion_tokens: number | null; total_tokens: number | null } | null;
  elapsedMs: number;
}

export interface LiveBlockedRecord {
  seq: number;
  at: string;
  episodeId: string;
  actorId: string;
  cycle: number;
  round: number;
  code: 'CHAT_BUDGET_EXHAUSTED';
}

/** Hooks the budgeted provider calls; the batch store implements them durably. */
export interface LiveAttemptHooks {
  beginAttempt(begin: LiveAttemptBegin): void;
  finishAttempt(finish: LiveAttemptFinish): void;
  recordBlocked(blocked: LiveBlockedRecord): void;
}
